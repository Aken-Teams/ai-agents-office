/**
 * Client-facing deployment configuration.
 *
 * Settings the UI needs in order to draw itself correctly, for a signed-in
 * user rather than an admin. Distinct from /api/admin/settings, which carries
 * quotas, limits and other operational values no ordinary user should read:
 * this endpoint deliberately exposes only what the page is about to render,
 * so adding an admin setting never leaks one by accident.
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { getPublicAddinInstaller, getAddinInstaller, INSTALLER_PATH, logInstallerEvent } from '../services/addinInstaller.js';

const router = Router();

/** Purpose claim, so a session JWT cannot be replayed here and vice versa. */
const TICKET_PURPOSE = 'addin-installer';

// ---------------------------------------------------------------------------
// GET /api/app-config/installer — download the uploaded installer.
// ---------------------------------------------------------------------------
// Declared BEFORE authMiddleware, and authenticated by its own short-lived
// ticket instead of the Authorization header.
//
// The reason is the shape of the request: this is a plain browser navigation,
// started by clicking a link, and a navigation cannot carry a header. The
// alternative — fetch with the header, buffer to a Blob, click a synthetic
// anchor, which is what the document downloads here do — pulls the whole file
// into the tab's memory first. That is fine for a 2MB report and wrong for a
// 200MB installer: no progress, no resume, and a tab that may simply die.
//
// The ticket is minted for an already-authenticated user, expires in minutes,
// and carries a purpose claim so a stolen session token cannot be swapped in.
router.get('/installer', async (req: Request, res: Response) => {
  const ticket = String(req.query.t || '');
  try {
    const payload = jwt.verify(ticket, config.jwtSecret) as { p?: string };
    if (payload.p !== TICKET_PURPOSE) throw new Error('wrong purpose');
  } catch {
    res.status(401).json({ error: '下載連結已失效，請重新整理頁面再試一次。' });
    return;
  }

  const settings = await getAddinInstaller();
  if (!settings.enabled || settings.mode !== 'file' || !settings.file || !fs.existsSync(INSTALLER_PATH)) {
    res.status(404).json({ error: '目前沒有可下載的安裝檔' });
    return;
  }

  // Quote the filename and strip the characters that would end the quoted
  // string early; the name came from an admin's disk, not from a validator.
  const safeName = settings.file.name.replace(/["\\\r\n]/g, '_');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(settings.file.size));
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  fs.createReadStream(INSTALLER_PATH).pipe(res);
});

// Everything below needs a signed-in user.
router.use(authMiddleware);

// GET /api/app-config
router.get('/', async (_req: Request, res: Response) => {
  res.json({
    // null when no installer is configured — the UI hides the entry entirely
    // rather than showing a download that cannot work.
    addinInstaller: await getPublicAddinInstaller(),
  });
});

/**
 * POST /api/app-config/installer-click — record the download and say where to go.
 *
 * One endpoint for both modes, so the trail is complete. An externally hosted
 * installer never touches this server when it downloads, so the click is the
 * only moment it can be recorded at all; routing the hosted case through the
 * same call keeps the two kinds of row directly comparable instead of one
 * meaning "asked for it" and the other "received it".
 *
 * For a hosted file it also mints the download ticket — on click rather than
 * with the page config, because a ticket issued at page load would be stale by
 * the time anyone clicked, and widening its lifetime to cover that is the wrong
 * direction for a URL that grants a download.
 */
router.post('/installer-click', async (req: Request, res: Response) => {
  const installer = await getPublicAddinInstaller();
  if (!installer) {
    res.status(404).json({ error: '目前沒有可下載的安裝檔' });
    return;
  }

  await logInstallerEvent({
    type: 'download',
    userId: req.user!.userId,
    source: installer.fileName ? 'file' : 'url',
    version: installer.version,
    fileName: installer.fileName || installer.url,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });

  if (!installer.fileName) {
    res.json({ url: installer.url });   // external — the browser goes there directly
    return;
  }
  const ticket = jwt.sign(
    { userId: req.user!.userId, p: TICKET_PURPOSE },
    config.jwtSecret,
    { expiresIn: '5m' },
  );
  res.json({ url: `/api/app-config/installer?t=${encodeURIComponent(ticket)}` });
});

export default router;
