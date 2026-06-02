/**
 * Personal RAG REST endpoints (auth-required, per-user).
 *
 * Used by:
 *  - LINE bot's upload pipeline (Phase C-2: file → text → index)
 *  - Web UI test surface (admins can paste text to verify indexing/retrieval)
 *  - Tests / smoke scripts
 *
 * All endpoints are scoped to req.user.userId — admins do NOT index across
 * users from here. To inspect another user's docs, use the admin route in
 * routes/admin.ts (TODO when needed).
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  indexDocument,
  searchTopK,
  formatHitsForPrompt,
  listUserDocs,
  countIndexedChunks,
} from '../services/personalRag.js';
import { hybridSearch } from '../services/rag/hybridSearch.js';
import { isFilter } from '../services/rag/filterDsl.js';

const router = Router();
router.use(authMiddleware);

const MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB plain text per request

/**
 * POST /api/local-rag/index
 * Body: { filename: string, fileType?: string, text: string }
 */
router.post('/index', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const filename = String(req.body?.filename ?? '').slice(0, 255).trim();
  const fileType = String(req.body?.fileType ?? 'txt').slice(0, 20).trim() || 'txt';
  const text = typeof req.body?.text === 'string' ? req.body.text : '';

  if (!filename) { res.status(400).json({ error: 'filename required' }); return; }
  if (!text)     { res.status(400).json({ error: 'text required' }); return; }
  if (Buffer.byteLength(text, 'utf-8') > MAX_TEXT_BYTES) {
    res.status(413).json({ error: `text exceeds ${MAX_TEXT_BYTES} bytes` });
    return;
  }

  try {
    const result = await indexDocument({ userId, filename, fileType, text });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/local-rag/docs
 * Returns up to 20 recent docs for the user.
 */
router.get('/docs', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  res.json({
    docs: await listUserDocs(userId, 50),
    chunks: await countIndexedChunks(userId),
  });
});

/**
 * POST /api/local-rag/search
 * Body: { query: string, k?: number, minScore?: number, format?: 'hits'|'prompt',
 *         mode?: 'hybrid'|'vector', vectorWeight?: number,
 *         filter?: Filter }
 *
 * `filter` follows the LEANN-style DSL — leaves use op + field + value, e.g.
 *   { "op": "eq", "field": "source", "value": "line" }
 *   { "op": "and", "children": [
 *       { "op": "starts_with", "field": "filename", "value": "policy-" },
 *       { "op": "gte", "field": "uploadedAt", "value": "2026-05-01" }
 *   ]}
 *
 * Defaults to hybrid (LEANN-inspired vector+BM25 fusion). Pass mode='vector'
 * for the legacy semantic-only path — useful for A/B debugging. Filter is
 * ignored in vector mode (searchTopK doesn't take it).
 */
router.post('/search', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const query = typeof req.body?.query === 'string' ? req.body.query : '';
  if (!query) { res.status(400).json({ error: 'query required' }); return; }

  const k = typeof req.body?.k === 'number' ? Math.min(20, Math.max(1, Math.round(req.body.k))) : 5;
  const minScore = typeof req.body?.minScore === 'number' ? req.body.minScore : undefined;
  const format = req.body?.format === 'prompt' ? 'prompt' : 'hits';
  const mode = req.body?.mode === 'vector' ? 'vector' : 'hybrid';
  const vectorWeight = typeof req.body?.vectorWeight === 'number' ? req.body.vectorWeight : undefined;

  // Validate the optional filter against the DSL shape before we run it
  // through the SQL compiler — protects against injection attempts in the
  // `field` slot (filterDsl also defensively validates field names).
  let filter: ReturnType<typeof normalizeFilter>;
  try {
    filter = normalizeFilter(req.body?.filter);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  try {
    const hits = mode === 'vector'
      ? await searchTopK({ userId, query, k, minScore })
      : await hybridSearch({ userId, query, k, minScore, vectorWeight, filter });
    if (format === 'prompt') {
      res.json({ prompt: formatHitsForPrompt(hits), count: hits.length });
      return;
    }
    res.json({
      hits: hits.map(h => ({
        chunkId: h.chunkId,
        docId: h.docId,
        filename: h.filename,
        score: h.score,
        // Trim to 800 chars to keep responses small in admin UI.
        snippet: h.content.length > 800 ? h.content.slice(0, 800) + '…' : h.content,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Validate filter shape. Returns undefined for empty filter, the typed
 *  filter for valid input, or throws for malformed input. */
function normalizeFilter(raw: unknown) {
  if (raw == null) return undefined;
  if (!isFilter(raw)) {
    throw new Error('invalid filter shape: expected { op, field, value } or { op: "and"|"or", children: [...] }');
  }
  return raw;
}

export default router;
