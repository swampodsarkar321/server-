import { Router } from 'express';
import { dbGet } from '../services/firebase.js';
import { requireAuth, requireWorkspace, type AuthedRequest } from '../middleware/auth.js';
import { getPlan, monthKey } from '../services/plans.js';

const router = Router();

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

router.get('/analytics/overview', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const ws = req.workspaceId!;
  const [convs, usage, handovers] = await Promise.all([
    dbGet(`conversations/${ws}`),
    dbGet(`usage/${ws}/${monthKey()}`),
    dbGet(`handovers/${ws}`),
  ]);
  const convList: any[] = convs ? Object.values(convs) : [];
  let handoverCount = 0;
  if (handovers) {
    for (const perConv of Object.values<any>(handovers)) {
      handoverCount += Object.values(perConv).filter((h: any) => h.type !== 'resume').length;
    }
  }
  const u = usage ?? { incoming: 0, aiReplies: 0, aiErrors: 0, humanReplies: 0 };
  const totalReplies = (u.aiReplies ?? 0) + (u.humanReplies ?? 0);
  res.json({
    month: monthKey(),
    messagesReceived: u.incoming ?? 0,
    aiRepliesSent: u.aiReplies ?? 0,
    humanRepliesSent: u.humanReplies ?? 0,
    conversationsHandled: convList.length,
    unanswered: convList.filter((c) => c.status === 'open').length,
    waitingHuman: convList.filter((c) => c.status === 'waiting_human').length,
    resolved: convList.filter((c) => c.status === 'resolved').length,
    humanHandovers: handoverCount,
    aiErrors: u.aiErrors ?? 0,
    aiSuccessRate: u.incoming ? Number((((u.aiReplies ?? 0) / Math.max(1, u.incoming)) * 100).toFixed(1)) : 0,
    totalReplies,
  });
});

router.get('/analytics/usage', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const ws = req.workspaceId!;
  const wsData = (await dbGet(`workspaces/${ws}`)) ?? { planId: 'free' };
  const plan = getPlan(wsData.planId);
  const usage = (await dbGet(`usage/${ws}/${monthKey()}`)) ?? { incoming: 0, aiReplies: 0, aiErrors: 0, humanReplies: 0 };
  const used = usage.aiReplies ?? 0;
  const limit = plan.limits.aiRepliesPerMonth;
  const convs = (await dbGet(`conversations/${ws}`)) ?? {};
  const byDay: Record<string, number> = {};
  for (const c of Object.values<any>(convs)) {
    if (c.lastMessageAt) {
      const k = dayKey(c.lastMessageAt);
      byDay[k] = (byDay[k] ?? 0) + 1;
    }
  }
  const days = Object.entries(byDay).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-14);
  res.json({
    month: monthKey(),
    plan: plan.id,
    aiRepliesUsed: used,
    aiRepliesLimit: limit,
    remaining: Math.max(0, limit - used),
    nearQuota: used / Math.max(1, limit) >= 0.8,
    overQuota: used >= limit,
    dailyConversations: days.map(([date, count]) => ({ date, count })),
    raw: usage,
  });
});

export default router;
