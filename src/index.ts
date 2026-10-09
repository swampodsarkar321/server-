import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config/env.js';
import { initFirebase } from './services/firebase.js';
import workspaceRoutes from './routes/workspace.js';
import knowledgeRoutes from './routes/knowledge.js';
import botRoutes from './routes/bot.js';
import inboxRoutes from './routes/inbox.js';
import analyticsRoutes from './routes/analytics.js';
import facebookRoutes from './routes/facebook.js';
import devRoutes from './routes/dev.js';
import webhookRoutes from './routes/webhooks.js';
import broadcastRoutes from './routes/broadcast.js';
import billingRoutes from './routes/billing.js';
import adminRoutes from './admin/admin.routes.js';

initFirebase();

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
const configuredOrigins = config.frontendUrl.split(',').map((s) => s.trim()).filter(Boolean);
// Always allow the production Vercel frontend + any Vercel preview for this project,
// even if FRONTEND_URL env on Render is stale (localhost only).
const fallbackOrigins = ['https://pika-pika-client-gblu-beta.vercel.app'];
const allowedOrigins = [...new Set([...configuredOrigins, ...fallbackOrigins])];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (/^https:\/\/.*\.vercel\.app$/.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(morgan('tiny'));

// Capture raw body for Meta signature verification BEFORE json parsing
app.use(
  express.json({
    limit: '512kb',
    verify: (req: any, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }),
);

const apiLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);
const webhookLimiter = rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false });
app.use('/webhooks/', webhookLimiter);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'chatpilot-server', time: new Date().toISOString() }));

app.use('/api', workspaceRoutes);
app.use('/api', knowledgeRoutes);
app.use('/api', botRoutes);
app.use('/api', inboxRoutes);
app.use('/api', analyticsRoutes);
app.use('/api', facebookRoutes);
app.use('/api', devRoutes);
app.use('/api', broadcastRoutes);
app.use('/api', billingRoutes);
app.use('/api', adminRoutes);
app.use('/webhooks', webhookRoutes);

// Consistent error shape; never leak secrets
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] error:', err?.message ?? err);
  res.status(err?.status ?? 500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Try again.' } });
});

app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

app.listen(config.port, () => {
  console.log(`[chatpilot] server on :${config.port} (env=${config.nodeEnv})`);
});

export default app;
