/**
 * Outlook email proxy routes — pro-panjit only.
 * All routes require authentication and a valid Outlook mail_token.
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { getMailToken, fetchFolders, fetchMessages, fetchMessageDetail, resolveCidImages, fetchAttachment } from '../services/outlookApi.js';

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
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  const { messages, total } = await fetchMessages(token, folder, limit, offset);
  res.json({ messages, folder, limit, offset, total });
});

// In-memory cache for CID-resolved bodies: messageId → resolved HTML
const cidCache = new Map<string, { body: string; ts: number }>();
const CID_CACHE_TTL = 10 * 60_000; // 10 minutes

// GET /api/outlook/messages/:id — get a single message with full body
// ?cid=true (default) resolves inline images; ?cid=false skips for fast initial load
router.get('/messages/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const msgId = req.params.id as string;
  const token = await getMailToken(userId);
  if (!token) {
    res.status(401).json({ error: 'Outlook 連線已過期，請重新登入' });
    return;
  }
  const message = await fetchMessageDetail(token, msgId);
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  const wantCid = req.query.cid !== 'false';
  const hasCidImages = !!(message.body && message.body_type === 'html' && message.attachments?.length && /cid:/i.test(message.body));

  if (wantCid && hasCidImages) {
    // Check cache first
    const cached = cidCache.get(msgId);
    if (cached && Date.now() - cached.ts < CID_CACHE_TTL) {
      message.body = cached.body;
    } else {
      message.body = await resolveCidImages(token, msgId, message.body!, message.attachments!);
      cidCache.set(msgId, { body: message.body, ts: Date.now() });
    }
  }

  res.json({ message, has_cid_images: hasCidImages });
});

// GET /api/outlook/messages/:msgId/attachments/:attId — download an attachment
router.get('/messages/:msgId/attachments/:attId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const token = await getMailToken(userId);
  if (!token) {
    res.status(401).json({ error: 'Outlook 連線已過期，請重新登入' });
    return;
  }
  const { msgId, attId } = req.params as { msgId: string; attId: string };
  const filename = (req.query.filename as string) || 'attachment';
  const contentType = (req.query.type as string) || 'application/octet-stream';

  const buf = await fetchAttachment(token, msgId, attId);
  if (!buf) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});

export default router;
