import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchKnowledge, buildSystemPrompt, shouldHandover, DEFAULT_BOT_SETTINGS } from '../src/services/knowledge.ts';
import { verifySignature, verifyWebhookHandshake, parseMessengerEvents } from '../src/services/meta.ts';
import { getPlan } from '../src/services/plans.ts';
import { config } from '../src/config/env.ts';
import { encryptSecret, decryptSecret } from '../src/services/crypto.ts';

describe('knowledge search', () => {
  const kb = [
    { id: '1', type: 'faq', question: 'What are delivery charges?', answer: 'Delivery is 60 BDT inside Dhaka.', enabled: true, updatedAt: 1 },
    { id: '2', type: 'policy', question: 'Refund policy', answer: 'Refunds within 7 days.', enabled: true, updatedAt: 2 },
    { id: '3', type: 'faq', question: 'Disabled entry', answer: 'Should never appear.', enabled: false, updatedAt: 3 },
  ] as any;
  it('finds relevant entry and skips disabled', () => {
    const r = searchKnowledge('delivery charge koto?', kb);
    assert.ok(r.length >= 1 && r[0].id === '1');
  });
  it('returns empty for unrelated query', () => {
    assert.equal(searchKnowledge('quantum astrophysics dissertation', kb).length, 0);
  });
  it('prompt contains business info and guardrails', () => {
    const p = buildSystemPrompt({ ...DEFAULT_BOT_SETTINGS, businessName: 'TestShop' }, kb.slice(0, 2));
    assert.ok(p.includes('TestShop') && p.includes('Never invent'));
  });
});

describe('handover rules', () => {
  it('detects human request', () => {
    assert.equal(shouldHandover('I want to talk to a human please', DEFAULT_BOT_SETTINGS).handover, true);
  });
  it('detects Bangla complaint', () => {
    assert.equal(shouldHandover('আমার অভিযোগ আছে, রিফান্ড চাই', DEFAULT_BOT_SETTINGS).handover, true);
  });
  it('escalates after repeated failures', () => {
    assert.equal(shouldHandover('hello there', DEFAULT_BOT_SETTINGS, 3).handover, true);
  });
  it('normal greeting does not handover', () => {
    assert.equal(shouldHandover('Hi, what are your hours?', DEFAULT_BOT_SETTINGS).handover, false);
  });
});

describe('webhook helpers', () => {
  it('handshake accepts matching token', () => {
    config.meta.verifyToken = 'tok123';
    const c = verifyWebhookHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok123', 'hub.challenge': 'CHAL' });
    assert.equal(c, 'CHAL');
  });
  it('handshake rejects wrong token', () => {
    assert.equal(verifyWebhookHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'CHAL' }), null);
  });
  it('parses text events, ignores echoes', () => {
    const evs = parseMessengerEvents({
      object: 'page',
      entry: [{ id: 'P1', messaging: [
        { sender: { id: 'U1' }, message: { text: 'hello', mid: 'm1' }, timestamp: 1 },
        { sender: { id: 'U1' }, message: { text: 'echo', is_echo: true }, timestamp: 2 },
      ] }],
    });
    assert.equal(evs.length, 1);
    assert.equal(evs[0].text, 'hello');
  });
  it('rejects bad signature', () => {
    assert.equal(verifySignature(Buffer.from('x'), undefined), false);
  });
});

describe('plans + crypto', () => {
  it('free plan limits', () => {
    assert.equal(getPlan('free').limits.pages, 1);
    assert.equal(getPlan('nope').id, 'free');
  });
  it('encrypt/decrypt round-trips when key set', () => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const enc = encryptSecret('secret-token');
    assert.notEqual(enc, 'secret-token');
    assert.equal(decryptSecret(enc), 'secret-token');
  });
});
