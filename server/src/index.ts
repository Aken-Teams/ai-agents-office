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

// Initialize database
initializeDatabase();
console.log('Database initialized');

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:3001', 'http://localhost:3000'],
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

// Start server
app.listen(config.port, () => {
  console.log(`AI Agents Office server running on http://localhost:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Workspace: ${config.workspaceRoot}`);
});
