import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, validateConfig } from './config.js';
import { initializeDatabase } from './db.js';
import { initOpsDb } from './opsDb.js';
import { reportsRouter, adminReportsRouter } from './routes/reports.js';
import authRoutes from './routes/auth.js';
import conversationRoutes from './routes/conversations.js';
import generateRoutes from './routes/generate.js';
import fileRoutes from './routes/files.js';
import usageRoutes from './routes/usage.js';
import skillRoutes from './routes/skills.js';
import adminRoutes from './routes/admin.js';
import uploadRoutes from './routes/uploads.js';
import shareRoutes from './routes/share.js';
import greetingRoutes from './routes/greeting.js';
import quotaRequestRoutes from './routes/quota-request.js';
import outlookRoutes from './routes/outlook.js';
import emailAgentRoutes from './routes/emailAgent.js';
import blockRoutes from './routes/blocks.js';
import teamRoutes from './routes/teams.js';
import publicShareRoutes from './routes/publicShare.js';
import lineRoutes from './routes/line.js';
import { rawBodyMiddleware } from './middleware/rawBody.js';
import { loadLineSettings } from './services/lineSettings.js';
import { pruneExpiredBuckets } from './services/line/rateLimit.js';
import { startLineWorker, stopQueueSystem } from './services/queue.js';
import { runLineJob } from './workers/lineMessageWorker.js';

async function main() {
  // Fail-fast on insecure security config (default JWT secret in production, etc.)
  validateConfig();

  // Initialize database
  await initializeDatabase();
  console.log('Database initialized');

  // Initialize the independent ops DB (report / ticket system). Non-fatal.
  if (config.reportSystemEnabled) await initOpsDb();

  // Load runtime LINE bot settings (rate limit, idle, file TTL, default quota).
  await loadLineSettings();

  // Start the team-run scheduler (emails scheduled collaboration reports).
  const { startTeamScheduler } = await import('./services/teamScheduler.js');
  startTeamScheduler();

  const app = express();

  // Only trust X-Forwarded-* when explicitly behind a trusted proxy (otherwise
  // req.ip would be client-spoofable). Default off → no change to existing setups.
  if (config.trustProxy) app.set('trust proxy', 1);

  // Security headers (nosniff, HSTS, referrer-policy, hide x-powered-by). CSP and
  // frame/cross-origin policies are intentionally relaxed here because this API
  // serves files/JSON that the separate-origin frontend must fetch and iframe
  // (e.g. document previews) — a strict policy would break those existing flows.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    frameguard: false,
  }));

  // Middleware
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : [`http://localhost:${config.port - 1}`, `http://localhost:${config.port}`];
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
  }));
  // /webhook/* paths need the raw request body for HMAC signature verification.
  // Mount BEFORE express.json() so the JSON parser doesn't consume the stream.
  app.use('/webhook', rawBodyMiddleware);

  app.use(express.json({ limit: '1mb' }));

  // LINE webhook (and other webhook integrations later) live under /webhook/*.
  app.use('/webhook', lineRoutes);

  // Periodically clean up the in-memory LINE rate-limit map.
  setInterval(pruneExpiredBuckets, 5 * 60 * 1000).unref();

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), isBeta: config.isBeta, deployMode: config.deployMode });
  });

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/conversations', conversationRoutes);
  app.use('/api/generate', generateRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/usage', usageRoutes);
  app.use('/api/skills', skillRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/share', shareRoutes);
  app.use('/api/greeting', greetingRoutes);
  app.use('/api/quota-request', quotaRequestRoutes);
  app.use('/api/outlook', outlookRoutes);
  app.use('/api/email-agent', emailAgentRoutes);
  app.use('/api/blocks', blockRoutes);
  app.use('/api/teams', teamRoutes);
  app.use('/api/public', publicShareRoutes);
  app.use('/api/reports', reportsRouter);
  app.use('/api/admin/reports', adminReportsRouter);

  // Global error handler — keeps internal error detail (stack traces, paths, SQL)
  // out of client responses. Logs full detail server-side; returns a generic
  // message unless running in development. Placed AFTER all routes.
  app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`[Unhandled] ${req.method} ${req.path}:`, err);
    if (res.headersSent) { next(err); return; }
    res.status(500).json({
      error: '伺服器發生錯誤，請稍後再試。',
      ...(config.nodeEnv !== 'production' ? { detail: err.message } : {}),
    });
  });

  // Start the LINE BullMQ worker only when the bot is enabled AND Redis is on,
  // so disabling LINE_BOT_ENABLED or REDIS_ENABLED in .env produces no Redis
  // traffic, no idle worker, and no reconnect error spam.
  if (config.line.enabled && config.redisEnabled) {
    startLineWorker(runLineJob);
    console.log(`LINE worker started (chat concurrency=6, redis=${config.redisUrl})`);
  } else if (config.line.enabled && !config.redisEnabled) {
    console.warn('LINE is enabled but REDIS_ENABLED=false → queue not started; LINE webhooks will return 503 until Redis is enabled.');
  }

  // Start server
  const server = app.listen(config.port, () => {
    console.log(`AI Agents Office server running on http://localhost:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Workspace: ${config.workspaceRoot}`);
  });

  // Graceful shutdown — drain in-flight LINE jobs before closing so a restart
  // doesn't leave orphan Claude CLI processes.
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, draining workers...`);
    server.close();
    try { await stopQueueSystem(); } catch (e) { console.error('Queue shutdown error:', e); }
    process.exit(0);
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
