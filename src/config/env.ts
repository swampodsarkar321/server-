import 'dotenv/config';
import crypto from 'crypto';

function req(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function reqInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  port: reqInt('PORT', 4000),
  frontendUrl: req('FRONTEND_URL', 'http://localhost:5173'),
  backendPublicUrl: req('BACKEND_PUBLIC_URL', 'http://localhost:4000'),
  nodeEnv: req('NODE_ENV', 'development'),
  firebase: {
    projectId: req('FIREBASE_PROJECT_ID'),
    clientEmail: req('FIREBASE_CLIENT_EMAIL'),
    privateKey: (req('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n')),
    databaseURL: req('FIREBASE_DATABASE_URL'),
  },
  ai: {
    provider: req('AI_PROVIDER', 'gemini'),
    model: req('AI_MODEL', 'gemini-2.0-flash'),
    geminiKey: req('GEMINI_API_KEY'),
    groqKey: req('GROQ_API_KEY'),
    temperature: Number(process.env.AI_TEMPERATURE ?? 0.4),
    maxOutputTokens: reqInt('AI_MAX_OUTPUT_TOKENS', 500),
    timeoutMs: reqInt('AI_REQUEST_TIMEOUT_MS', 20000),
    maxContext: reqInt('AI_MAX_CONTEXT_MESSAGES', 12),
  },
  meta: {
    appId: req('META_APP_ID'),
    appSecret: req('META_APP_SECRET'),
    redirectUri: req('META_REDIRECT_URI'),
    verifyToken: req('META_WEBHOOK_VERIFY_TOKEN'),
  },
  encryptionKey: req('ENCRYPTION_KEY'),
  devAllowlist: req('DEV_ALLOWLIST_UIDS').split(',').map((s) => s.trim()).filter(Boolean),
};

export function hasFirebase(): boolean {
  return Boolean(config.firebase.projectId && config.firebase.clientEmail && config.firebase.privateKey && config.firebase.databaseURL);
}

export function hasMeta(): boolean {
  return Boolean(config.meta.appId && config.meta.appSecret && config.meta.verifyToken);
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
