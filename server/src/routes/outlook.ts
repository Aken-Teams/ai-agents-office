/**
 * Outlook email proxy routes — pro-panjit only.
 * All routes require authentication and a valid Outlook mail_token.
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { getMailToken, fetchFolders, fetchMessages, fetchMessageDetail } from '../services/outlookApi.js';

const router = Router();
router.use(authMiddleware);

// Gate: only available in pro-panjit mode
router.use((_req: Request, res: Response, next) => {
  if (config.deployMode !== 'pro-panjit') {
    res.status(403).json({ error: 'Not available in this deployment mode' });
    return;
  }
  next();
});

// GET /api/outlook/status — check if user has a valid Outlook connection
router.get('/status', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const token = await getMailToken(userId);
  res.json({ connected: !!token });
});

// GET /api/outlook/folders — list email folders
router.get('/folders', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const token = await getMailToken(userId);
  if (!token) {
    res.status(401).json({ error: 'Outlook 連線已過期，請重新登入' });
    return;
  }
  const folders = await fetchFolders(token);
  res.json({ folders });
});

// GET /api/outlook/messages — list messages in a folder
router.get('/messages', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const token = await getMailToken(userId);
  if (!token) {
    res.status(401).json({ error: 'Outlook 連線已過期，請重新登入' });
    return;
  }
  const folder = (req.query.folder as string) || 'Inbox';
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const messages = await fetchMessages(token, folder, limit);
  res.json({ messages, folder, limit });
});

// GET /api/outlook/messages/:id — get a single message with full body
router.get('/messages/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const token = await getMailToken(userId);
  if (!token) {
    res.status(401).json({ error: 'Outlook 連線已過期，請重新登入' });
    return;
  }
  const message = await fetchMessageDetail(token, req.params.id as string);
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  res.json({ message });
});

export default router;
