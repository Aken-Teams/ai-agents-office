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

async function main() {
  // Initialize database
  await initializeDatabase();
  console.log('Database initialized');

  const app = express();

  // Middleware
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : [`http://localhost:${config.port - 1}`, `http://localhost:${config.port}`];
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

  // Start server
  app.listen(config.port, () => {
    console.log(`AI Agents Office server running on http://localhost:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Workspace: ${config.workspaceRoot}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
