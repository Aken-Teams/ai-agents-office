/**
 * Mounts on `/webhook/line` only so the rest of the API keeps using express.json().
 * Captures the request body as a UTF-8 Buffer on `req.rawBody` so the LINE
 * signature verifier can HMAC over the exact bytes Line sent. Caps payload at
 * 256 KB — LINE webhook events are tiny, anything larger is hostile.
 */

import type { Request, Response, NextFunction } from 'express';

const MAX_BYTES = 256 * 1024;

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export function rawBodyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const chunks: Buffer[] = [];
  let total = 0;

  req.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > MAX_BYTES) {
      res.status(413).json({ error: 'Payload too large' });
      req.unpipe();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });

  req.on('error', (err) => {
    next(err);
  });
}
