import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbPush, dbUpdate } from '../services/firebase.js';
import { requireAuth, requireWorkspace, requireRole, type AuthedRequest } from '../middleware/auth.js';

const router = Router();

// Seller's receiving number (manual bKash). Displayed in UI; never a secret.
export const SELLER_BKASH = '01410882562';

const claimSchema = z.object({
  workspaceId: z.string().min(1),
  package: z.enum(['trial', 'business', 'premium']),
  trxId: z.string().min(4).max(40),
  senderNumber: z.string().min(6).max(20),
  months: z.number().int().min(1).max(12).default(1),
});

/** Customer paid via bKash to SELLER_BKASH and submits TrxID for manual verification. */
router.post('/billing/claim', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Package, TrxID ebong sender number lagbe', details: parsed.error.flatten() } });
    return;
  }
  const key = await dbPush(`billingClaims/${req.workspaceId}`, {
    ...parsed.data,
    status: 'pending',
    by: req.uid,
    createdAt: Date.now(),
  });
  // In-app notification so the seller sees it in the dashboard queue
  await dbPush(`notifications/${req.workspaceId}`, {
    kind: 'payment_claim',
    claimKey: key,
    package: parsed.data.package,
    trxId: parsed.data.trxId,
    createdAt: Date.now(),
    read: false,
  });
  res.status(201).json({ claimKey: key, status: 'pending', message: 'Payment claim received. Verification-er por package active hobe.' });
});

router.get('/billing/claims', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const all = (await dbGet(`billingClaims/${req.workspaceId}`)) ?? {};
  const list = Object.entries<any>(all).map(([key, v]) => ({ key, ...v }));
  list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json({ sellerBkash: SELLER_BKASH, claims: list.slice(0, 100) });
});

const verifySchema = z.object({ workspaceId: z.string().min(1), status: z.enum(['verified', 'rejected']) });

router.patch('/billing/claims/:claimKey/verify', requireAuth, requireWorkspace, requireRole('owner', 'admin'), async (req: AuthedRequest, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid status' } });
    return;
  }
  const existing = await dbGet(`billingClaims/${req.workspaceId}/${req.params.claimKey}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Claim not found' } });
    return;
  }
  await dbUpdate(`billingClaims/${req.workspaceId}/${req.params.claimKey}`, {
    status: parsed.data.status,
    verifiedBy: req.uid,
    verifiedAt: Date.now(),
  });
  res.json({ status: parsed.data.status });
});

export default router;
