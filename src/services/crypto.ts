import crypto from 'crypto';
import { config } from '../config/env.js';

function key(): Buffer {
  const hex = (config.encryptionKey || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  // Derive a stable 32-byte key from any string (dev fallback; use real hex in prod)
  return crypto.createHash('sha256').update(hex || 'chatpilot-dev-key').digest();
}

export function encryptSecret(plain: string): string {
  const k = key();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const k = key();
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function redact<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  const clone: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) };
  for (const k of Object.keys(clone)) {
    if (/token|secret|key|password/i.test(k)) clone[k] = '[redacted]';
    else if (typeof clone[k] === 'object') clone[k] = redact(clone[k]);
  }
  return clone;
}
