/**
 * LINE webhook signature verification.
 *
 * LINE signs the raw request body with HMAC-SHA256 using the channel secret
 * and sends the result base64-encoded in the `X-Line-Signature` header.
 *
 * Reference: https://developers.line.biz/en/reference/messaging-api/#signature-validation
 */

import crypto from 'crypto';
import { config } from '../../config.js';

/**
 * @param rawBody — exact bytes from the request. Use `req.rawBody` (see
 *                  middleware/rawBody.ts), NOT a re-serialised JSON object.
 * @param signature — the X-Line-Signature header value, may be undefined.
 * @returns true when the signature matches and a channel secret is configured.
 */
export function verifyLineSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!rawBody || !signature) return false;
  const secret = config.line.channelSecret;
  if (!secret) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  // timingSafeEqual requires equal lengths; signatures should both be base64 of 32-byte SHA-256.
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const signatureBuf = Buffer.from(signature, 'utf-8');
  if (expectedBuf.length !== signatureBuf.length) return false;

  try {
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}
