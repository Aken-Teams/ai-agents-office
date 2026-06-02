import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initializeDatabase } from './db.js';
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
import localChatRoutes from './routes/localChat.js';
import personalRagRoutes from './routes/personalRag.js';
import lineRoutes from './routes/line.js';
import { rawBodyMiddleware } from './middleware/rawBody.js';
import { loadLlmSettings } from './services/llmSettings.js';
import { loadLineSettings } from './services/lineSettings.js';
import { pruneExpiredBuckets } from './services/line/rateLimit.js';
import { startLineWorker, startEmbedWorker, stopQueueSystem } from './services/queue.js';
import { runLineJob } from './workers/lineMessageWorker.js';
import { runEmbedJob } from './workers/embeddingWorker.js';

async function main() {
  // Initialize database
  await initializeDatabase();
  console.log('Database initialized');

  // Load runtime LLM toggles from system_settings into in-process cache.
  await loadLlmSettings();
  // Load runtime LINE bot settings (rate limit, idle, file TTL, default quota).
  await loadLineSettings();

  const app = express();

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
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Friendly root — this is an API-only host. If someone visits it in a browser
  // by mistake, point them to the frontend rather than showing "Cannot GET /".
  app.get('/', (_req, res) => {
    res.status(200).json({
      service: 'ai-agents-office-api',
      message: 'This host serves API endpoints only. For the web app, open https://agents-dev.theaken.com',
      endpoints: ['/api/health', '/api/auth/*', '/api/conversations', '/api/generate/*', '/api/local-chat/*', '/api/usage', '/api/files/*'],
      docs: 'https://agents-dev.theaken.com',
    });
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
  app.use('/api/local-chat', localChatRoutes);
  app.use('/api/local-rag', personalRagRoutes);

  // Start the LINE BullMQ worker only when the bot is enabled, so disabling
  // LINE_BOT_ENABLED in .env produces no Redis traffic and no idle worker.
  if (config.line.enabled) {
    startLineWorker(runLineJob);
    startEmbedWorker(runEmbedJob);
    console.log(`LINE workers started (chat concurrency=6, embed concurrency=3, redis=${config.redisUrl})`);
  }

  // Start server
  const server = app.listen(config.port, () => {
    console.log(`AI Agents Office server running on http://localhost:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Workspace: ${config.workspaceRoot}`);
  });

  // Graceful shutdown — drain in-flight jobs before closing the HTTP server
  // so the systemd restart cycle doesn't leave orphan Claude CLI processes.
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
