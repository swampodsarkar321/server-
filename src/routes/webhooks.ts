import { Router } from 'express';
import { verifyWebhookHandshake, verifySignature, parseMessengerEvents, sendMessengerText } from '../services/meta.js';
import { dbGet, dbSet, dbUpdate, dbPush } from '../services/firebase.js';
import { decryptSecret } from '../services/crypto.js';
import { DEFAULT_BOT_SETTINGS, buildSystemPrompt, searchKnowledge, shouldHandover, type KnowledgeEntry } from '../services/knowledge.js';
import { generateReply } from '../services/ai.js';
import { getPlan, monthKey } from '../services/plans.js';

const router = Router();

// GET /webhooks/messenger — Meta verification handshake
router.get('/messenger', (req, res) => {
  const challenge = verifyWebhookHandshake(req.query as any);
  if (challenge) {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).send('Verification failed: invalid verify token');
});

// POST /webhooks/messenger — incoming events (raw body needed for signature check)
router.post('/messenger', async (req, res) => {
  const raw = (req as any).rawBody as Buffer | undefined;
  const sig = req.headers['x-hub-signature-256'] as string | undefined;
  if (!raw || !verifySignature(raw, sig)) {
    res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid webhook signature' } });
    return;
  }
  // Acknowledge fast; process async (Meta requires <20s response)
  res.status(200).json({ received: true });
  void processEvents(req.body).catch((e) => console.error('[webhook] processing failed', e));
});

async function bumpUsage(workspaceId: string, field: string, by = 1): Promise<void> {
  const path = `usage/${workspaceId}/${monthKey()}`;
  const cur = (await dbGet(path)) ?? { incoming: 0, aiReplies: 0, aiErrors: 0, humanReplies: 0 };
  cur[field] = (cur[field] ?? 0) + by;
  cur.updatedAt = Date.now();
  await dbSet(path, cur);
}

async function processEvents(body: any): Promise<void> {
  const events = parseMessengerEvents(body);
  for (const ev of events) {
    try {
      await handleOne(ev);
    } catch (e) {
      console.error('[webhook] event failed', (e as Error)?.message);
    }
  }
}

async function handleOne(ev: { pageId: string; senderPsid: string; text: string; mid?: string; timestamp: number }): Promise<void> {
  // 1. Identify workspace via verified Page mapping (never trust client input here)
  const pageIdx = await dbGet(`pageIndex/${ev.pageId}`);
  if (!pageIdx?.workspaceId) return; // unknown/unconnected page — ignore
  const workspaceId: string = pageIdx.workspaceId;
  const page = await dbGet(`facebookPages/${ev.pageId}`);
  if (!page?.encryptedToken || page.workspaceId !== workspaceId) return;

  // 2. Idempotency: skip duplicate delivery (Meta may retry)
  const dedupeKey = ev.mid ?? `${ev.pageId}:${ev.senderPsid}:${ev.timestamp}:${ev.text.length}`;
  const seenPath = `processedMids/${workspaceId}/${Buffer.from(dedupeKey).toString('base64url').slice(0, 120)}`;
  if (await dbGet(seenPath)) return;
  await dbSet(seenPath, { at: Date.now() });

  await bumpUsage(workspaceId, 'incoming');

  // 3. Load/create conversation
  const convId = `${ev.pageId}_${ev.senderPsid}`;
  let conv = await dbGet(`conversations/${workspaceId}/${convId}`);
  if (!conv) {
    conv = {
      pageId: ev.pageId,
      psid: ev.senderPsid,
      customerName: null, // only set from legit Meta profile data if available
      status: 'open',
      aiPaused: false,
      failureCount: 0,
      lastMessage: '',
      lastMessageAt: 0,
      unread: 0,
      createdAt: Date.now(),
    };
  }
  conv.lastMessage = ev.text;
  conv.lastMessageAt = Date.now();
  conv.lastSender = 'customer';
  conv.unread = (conv.unread ?? 0) + 1;
  await dbSet(`conversations/${workspaceId}/${convId}`, conv);
  await dbPush(`messages/${workspaceId}/${convId}`, {
    sender: 'customer',
    text: ev.text,
    mid: ev.mid ?? null,
    createdAt: Date.now(),
  });

  const settings = { ...DEFAULT_BOT_SETTINGS, ...((await dbGet(`botSettings/${workspaceId}`)) ?? {}) };

  // 4. Respect pauses: bot disabled, handover active, agent took over
  if (!settings.enabled || conv.aiPaused || conv.status === 'waiting_human') return;

  // 5. Handover rules
  const { handover, reason } = shouldHandover(ev.text, settings, conv.failureCount ?? 0);
  if (handover) {
    await dbUpdate(`conversations/${workspaceId}/${convId}`, { status: 'waiting_human', aiPaused: true });
    await dbPush(`handovers/${workspaceId}/${convId}`, { reason, createdAt: Date.now(), type: 'auto', trigger: ev.text.slice(0, 200) });
    // Notify via in-app queue (no fake WhatsApp/SMS/email claims)
    await dbPush(`notifications/${workspaceId}`, {
      kind: 'handover',
      conversationId: convId,
      reason,
      createdAt: Date.now(),
      read: false,
    });
    // Send a brief acknowledgement within policy window (RESPONSE to inbound)
    try {
      await sendMessengerText(decryptSecret(page.encryptedToken), ev.senderPsid, 'Thanks — I’ve flagged this for our team and a human agent will take over shortly.');
      await dbPush(`messages/${workspaceId}/${convId}`, { sender: 'bot', text: 'Handover acknowledgement sent.', createdAt: Date.now(), system: true });
    } catch {
      /* acknowledgement is best-effort */
    }
    return;
  }

  // 6. Usage limits enforced on the backend
  const wsData = (await dbGet(`workspaces/${workspaceId}`)) ?? { planId: 'free' };
  const plan = getPlan(wsData.planId);
  const usage = (await dbGet(`usage/${workspaceId}/${monthKey()}`)) ?? { aiReplies: 0 };
  if ((usage.aiReplies ?? 0) >= plan.limits.aiRepliesPerMonth) {
    await dbPush(`messages/${workspaceId}/${convId}`, {
      sender: 'bot',
      text: settings.fallbackMessage,
      createdAt: Date.now(),
      fallback: true,
      reason: 'quota_reached',
    });
    return;
  }

  // 7. Knowledge retrieval (workspace-scoped only) + history
  const kbRaw = (await dbGet(`knowledgeBase/${workspaceId}`)) ?? {};
  const entries: KnowledgeEntry[] = Object.entries<any>(kbRaw).map(([id, v]) => ({ id, ...v }));
  const matched = searchKnowledge(ev.text, entries, 4);
  const msgsRaw = (await dbGet(`messages/${workspaceId}/${convId}`)) ?? {};
  const history = Object.values<any>(msgsRaw)
    .filter((m) => !m.internal && (m.sender === 'customer' || m.sender === 'bot'))
    .slice(-12)
    .map((m) => ({ role: (m.sender === 'bot' ? 'model' : 'user') as 'model' | 'user', text: String(m.text ?? '').slice(0, 500) }));

  const result = await generateReply({
    systemPrompt: buildSystemPrompt(settings, matched),
    userText: ev.text,
    history,
    fallbackMessage: settings.fallbackMessage,
    providerName: settings.aiProvider,
    model: settings.aiModel,
  });

  const replyText = result.ok ? result.text.slice(0, settings.maxReplyChars) : result.text;

  // 8. Send via official Send API with one retry on transient errors
  try {
    await sendMessengerText(decryptSecret(page.encryptedToken), ev.senderPsid, replyText);
    await dbPush(`messages/${workspaceId}/${convId}`, {
      sender: 'bot',
      text: replyText,
      createdAt: Date.now(),
      aiOk: result.ok,
      provider: result.provider,
      model: result.model,
    });
    await dbUpdate(`conversations/${workspaceId}/${convId}`, { lastMessage: replyText, lastMessageAt: Date.now(), lastSender: 'bot', failureCount: 0 });
    if (result.ok) await bumpUsage(workspaceId, 'aiReplies');
    else await bumpUsage(workspaceId, 'aiErrors');
  } catch (e: any) {
    if (e?.retryable) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await sendMessengerText(decryptSecret(page.encryptedToken), ev.senderPsid, replyText);
        await bumpUsage(workspaceId, result.ok ? 'aiReplies' : 'aiErrors');
        return;
      } catch {
        /* fall through */
      }
    }
    await bumpUsage(workspaceId, 'aiErrors');
    await dbUpdate(`conversations/${workspaceId}/${convId}`, { failureCount: (conv.failureCount ?? 0) + 1 });
    await dbPush(`messages/${workspaceId}/${convId}`, { sender: 'system', text: `Send failed: ${(e?.message ?? 'unknown').slice(0, 200)}`, createdAt: Date.now() });
  }
}

export default router;
