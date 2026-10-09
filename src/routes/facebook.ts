import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbSet } from '../services/firebase.js';
import { requireAuth, requireApproved, requireWorkspace, type AuthedRequest } from '../middleware/auth.js';
import { config, hasMeta } from '../config/env.js';
import { oauthConnectUrl, exchangeCodeForToken, listPages, subscribePage } from '../services/meta.js';
import { encryptSecret } from '../services/crypto.js';
import { getPlan } from '../services/plans.js';

const router = Router();

router.get('/facebook/connect', requireAuth, requireApproved, requireWorkspace, async (req: AuthedRequest, res) => {
  if (!hasMeta()) {
    res.status(503).json({
      error: {
        code: 'META_NOT_CONFIGURED',
        message: 'Meta App is not configured. Set META_APP_ID, META_APP_SECRET, META_REDIRECT_URI and META_WEBHOOK_VERIFY_TOKEN. See docs/META_SETUP.md.',
      },
    });
    return;
  }
  // state binds the OAuth flow to this workspace + user (CSRF protection)
  const state = Buffer.from(JSON.stringify({ workspaceId: req.workspaceId, uid: req.uid, nonce: Date.now() })).toString('base64url');
  await dbSet(`oauthStates/${state}`, { workspaceId: req.workspaceId, uid: req.uid, createdAt: Date.now() });
  res.json({ url: oauthConnectUrl(state), configured: true });
});

// Meta redirects here with ?code=&state=
router.get('/facebook/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;
  if (error || !code || !state) {
    res.status(400).send(`<h3>Facebook connection failed</h3><p>${String(error ?? 'Missing code/state')}</p>`);
    return;
  }
  const saved = await dbGet(`oauthStates/${state}`);
  if (!saved?.workspaceId) {
    res.status(400).send('<h3>Invalid or expired OAuth state</h3>');
    return;
  }
  try {
    const tok = await exchangeCodeForToken(code);
    const pages = await listPages(tok.access_token);
    await dbSet(`oauthStates/${state}`, null);
    // Store candidate pages (without tokens yet) for the workspace to pick from
    await dbSet(`oauthCandidates/${saved.workspaceId}`, {
      pages: pages.map((p) => ({ id: p.id, name: p.name })),
      retrievedAt: Date.now(),
    });
    // Temporarily stash user token server-side only (never to browser)
    await dbSet(`oauthUserTokens/${saved.workspaceId}`, { token: encryptSecret(tok.access_token), createdAt: Date.now() });
    // FRONTEND_URL may be a comma list ("https://prod,http://localhost:5173").
    // Prefer the first https origin so OAuth never bounces back to localhost in prod.
    const origins = config.frontendUrl
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean);
    const frontendBase =
      origins.find((o) => o.startsWith('https://')) ?? origins[0] ?? 'http://localhost:5173';
    res.redirect(`${frontendBase}/pages?connected=candidates&workspaceId=${encodeURIComponent(saved.workspaceId)}`);
  } catch (e: any) {
    res.status(502).send(`<h3>Facebook connection failed</h3><p>${(e?.message ?? 'Token exchange failed').slice(0, 300)}</p>`);
  }
});

router.get('/facebook/pages', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const ws = req.workspaceId!;
  const connected = (await dbGet(`facebookPagesByWorkspace/${ws}`)) ?? {};
  const candidates = (await dbGet(`oauthCandidates/${ws}`)) ?? null;
  const list = await Promise.all(
    Object.keys(connected).map(async (pageId) => {
      const p = await dbGet(`facebookPages/${pageId}`);
      return p ? { pageId, ...p, encryptedToken: undefined, hasToken: Boolean(p.encryptedToken) } : null;
    }),
  );
  res.json({
    connected: list.filter(Boolean),
    candidates: candidates?.pages ?? [],
    // Never claim connected until verified subscription exists:
    liveMessaging: list.some((p: any) => p?.subscribed),
  });
});

const confirmSchema = z.object({ workspaceId: z.string().min(1), pageId: z.string().min(1), pageName: z.string().max(160).optional() });

/**
 * Confirm a candidate Page: fetch its Page token server-side, subscribe webhooks,
 * then persist. The browser never handles tokens.
 */
router.post('/facebook/pages/confirm', requireAuth, requireApproved, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid page selection' } });
    return;
  }
  const ws = req.workspaceId!;
  const wsData = (await dbGet(`workspaces/${ws}`)) ?? { planId: 'free' };
  const plan = getPlan(wsData.planId);
  const existing = (await dbGet(`facebookPagesByWorkspace/${ws}`)) ?? {};
  if (Object.keys(existing).length >= plan.limits.pages) {
    res.status(402).json({ error: { code: 'PLAN_LIMIT', message: `Page limit reached (${plan.limits.pages} on ${plan.id} plan)` } });
    return;
  }
  const stash = await dbGet(`oauthUserTokens/${ws}`);
  if (!stash?.token) {
    res.status(400).json({ error: { code: 'NO_OAUTH_TOKEN', message: 'No pending Facebook authorization. Click Connect first.' } });
    return;
  }
  const { decryptSecret: dec } = await import('../services/crypto.js');
  const userToken: string = dec(stash.token);
  const pages = await listPages(userToken);
  const match = pages.find((p) => p.id === parsed.data.pageId);
  if (!match) {
    res.status(400).json({ error: { code: 'PAGE_NOT_AUTHORIZED', message: 'That Page was not in the authorized list. Re-connect and grant access.' } });
    return;
  }
  // Verify subscription with Meta before claiming "connected"
  await subscribePage(match.id, match.access_token);
  await dbSet(`facebookPages/${match.id}`, {
    workspaceId: ws,
    pageId: match.id,
    pageName: parsed.data.pageName ?? match.name,
    encryptedToken: encryptSecret(match.access_token),
    subscribed: true,
    connectedAt: Date.now(),
    connectedBy: req.uid,
  });
  await dbSet(`facebookPagesByWorkspace/${ws}/${match.id}`, { connectedAt: Date.now() });
  await dbSet(`pageIndex/${match.id}`, { workspaceId: ws });
  res.status(201).json({ page: { pageId: match.id, pageName: match.name, subscribed: true } });
});

router.post('/facebook/pages/:pageId/disconnect', requireAuth, requireApproved, requireWorkspace, async (req: AuthedRequest, res) => {
  const page = await dbGet(`facebookPages/${req.params.pageId}`);
  if (!page || page.workspaceId !== req.workspaceId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Page not found in this workspace' } });
    return;
  }
  await dbSet(`facebookPages/${req.params.pageId}`, null);
  await dbSet(`facebookPagesByWorkspace/${req.workspaceId}/${req.params.pageId}`, null);
  await dbSet(`pageIndex/${req.params.pageId}`, null);
  res.json({ disconnected: req.params.pageId });
});

export default router;
