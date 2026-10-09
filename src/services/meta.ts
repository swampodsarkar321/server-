import crypto from 'crypto';
import { config } from '../config/env.js';

/** Verify Meta webhook GET handshake. Returns hub.challenge or null. */
export function verifyWebhookHandshake(query: { [k: string]: any }): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === config.meta.verifyToken && typeof challenge === 'string') {
    return challenge;
  }
  return null;
}

/** Verify X-Hub-Signature-256 over the raw request body using the app secret. */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!config.meta.appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface IncomingMsg {
  pageId: string;
  senderPsid: string;
  text: string;
  mid?: string;
  timestamp: number;
}

export function parseMessengerEvents(body: any): IncomingMsg[] {
  const out: IncomingMsg[] = [];
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    const pageId = String(entry.id ?? '');
    for (const ev of entry.messaging ?? []) {
      // Ignore echoes (our own sent messages) and non-text events for v1
      if (ev.message?.is_echo) continue;
      const text: string | undefined = ev.message?.text;
      if (!text || !ev.sender?.id) continue;
      out.push({
        pageId,
        senderPsid: String(ev.sender.id),
        text: String(text).slice(0, 2000),
        mid: ev.message?.mid ? String(ev.message.mid) : undefined,
        timestamp: Number(ev.timestamp ?? Date.now()),
      });
    }
  }
  return out;
}

export function oauthConnectUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.meta.appId,
    redirect_uri: config.meta.redirectUri,
    state,
    scope: 'pages_messaging,pages_manage_metadata,pages_show_list',
    response_type: 'code',
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<{ access_token: string; expires_in?: number }> {
  const params = new URLSearchParams({
    client_id: config.meta.appId,
    client_secret: config.meta.appSecret,
    redirect_uri: config.meta.redirectUri,
    code,
  });
  const res = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`Meta token exchange failed: ${res.status}`);
  return (await res.json()) as any;
}

export async function listPages(userToken: string): Promise<Array<{ id: string; name: string; access_token: string }>> {
  const params = new URLSearchParams({ access_token: userToken, fields: 'id,name,access_token' });
  const res = await fetch(`https://graph.facebook.com/v21.0/me/accounts?${params.toString()}`);
  if (!res.ok) throw new Error(`Meta accounts fetch failed: ${res.status}`);
  const data: any = await res.json();
  return data.data ?? [];
}

export async function subscribePage(pageId: string, pageToken: string): Promise<void> {
  const params = new URLSearchParams({ access_token: pageToken, subscribed_fields: 'messages,messaging_postbacks,messaging_optins' });
  const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/subscribed_apps`, { method: 'POST', body: params as any });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Page subscription failed: ${res.status} ${t.slice(0, 200)}`);
  }
}

export async function sendMessengerText(pageToken: string, psid: string, text: string): Promise<{ message_id?: string }> {
  const res = await fetch('https://graph.facebook.com/v21.0/me/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pageToken}` },
    body: JSON.stringify({ recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text: text.slice(0, 2000) } }),
  });
  if (res.status === 429) throw Object.assign(new Error('Meta send rate limited (429)'), { retryable: true });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err: any = new Error(`Meta send failed ${res.status}: ${t.slice(0, 300)}`);
    err.retryable = res.status >= 500;
    throw err;
  }
  return (await res.json()) as any;
}

/**
 * Fetch the customer's public messaging profile (name + picture) via the
 * official Graph API using the Page token. Returns null when unavailable —
 * callers must fall back to a generic label and never fabricate data.
 */
export async function getMessengerProfile(pageToken: string, psid: string): Promise<{ name?: string; profilePic?: string } | null> {
  try {
    const params = new URLSearchParams({ fields: 'name,profile_pic', access_token: pageToken });
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(psid)}?${params.toString()}`);
    if (!res.ok) return null;
    const data: any = await res.json();
    return {
      name: typeof data?.name === 'string' ? data.name.slice(0, 80) : undefined,
      profilePic: typeof data?.profile_pic === 'string' ? data.profile_pic : undefined,
    };
  } catch {
    return null;
  }
}
