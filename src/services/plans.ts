// Subscription-ready plan catalogue. Stored on the server and enforced on the backend.
// No payments are implemented; billing page is informational until a provider is integrated.
export interface PlanLimits {
  pages: number;
  knowledgeEntries: number;
  aiRepliesPerMonth: number;
  agents: number;
  advancedAnalytics: boolean;
}

export interface Plan {
  id: string;
  name: string;
  priceNote: string;
  limits: PlanLimits;
}

export const PLANS: Record<string, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceNote: 'Free — upgrade later via a payment provider (not integrated yet)',
    limits: { pages: 1, knowledgeEntries: 50, aiRepliesPerMonth: 200, agents: 1, advancedAnalytics: false },
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceNote: 'Planned paid tier — payments not integrated yet',
    limits: { pages: 2, knowledgeEntries: 500, aiRepliesPerMonth: 2000, agents: 3, advancedAnalytics: true },
  },
  business: {
    id: 'business',
    name: 'Business',
    priceNote: 'Planned paid tier — payments not integrated yet',
    limits: { pages: 10, knowledgeEntries: 5000, aiRepliesPerMonth: 20000, agents: 20, advancedAnalytics: true },
  },
};

export function getPlan(planId?: string): Plan {
  return PLANS[planId ?? 'free'] ?? PLANS.free;
}

export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
