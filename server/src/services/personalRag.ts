/**
 * Personal RAG — per-user document indexing + cosine retrieval.
 *
 * Storage model (DB schema in db.ts):
 *   user_documents      one row per indexed file
 *   user_doc_chunks     one row per chunk, embedding stored as JSON array
 *
 * Cosine search is computed in application code over the user's own chunks
 * only — fine for the 50-1000 user scale we're targeting (avg 50 chunks/user
 * → 50K rows; each query reads at most one user's slice). Migrate to
 * pgvector / qdrant once any single user's corpus crosses ~10K chunks.
 */

import { v4 as uuidv4 } from 'uuid';
import { dbAll, dbGet, dbRun } from '../db.js';
import { embed } from './localLlm.js';
import * as hnswStore from './rag/hnswStore.js';
import * as bm25Store from './rag/bm25Store.js';

/* ============================================================
   Chunking
   ============================================================ */

const CHUNK_TARGET_CHARS = 1200;      // ~300-400 tokens for CJK
const CHUNK_OVERLAP_CHARS = 200;
const MIN_CHUNK_CHARS = 60;

/**
 * Greedy paragraph-aware splitter:
 *   1. break on \n\n boundaries
 *   2. pack paragraphs until target reached
 *   3. carry forward an overlap window to preserve cross-chunk context
 */
export function chunkText(text: string): string[] {
  const clean = (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let buf = '';

  for (const p of paragraphs) {
    if (!p.trim()) continue;

    // If a single paragraph already exceeds the target, slide a window.
    if (p.length > CHUNK_TARGET_CHARS) {
      if (buf.length >= MIN_CHUNK_CHARS) { chunks.push(buf); buf = ''; }
      let i = 0;
      while (i < p.length) {
        const end = Math.min(p.length, i + CHUNK_TARGET_CHARS);
        chunks.push(p.slice(i, end));
        if (end >= p.length) break;
        i = end - CHUNK_OVERLAP_CHARS;
      }
      continue;
    }

    if (buf.length + 2 + p.length > CHUNK_TARGET_CHARS && buf.length >= MIN_CHUNK_CHARS) {
      chunks.push(buf);
      // Carry the tail of the previous chunk as overlap.
      const tail = buf.slice(-CHUNK_OVERLAP_CHARS);
      buf = tail + '\n\n' + p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }

  if (buf.length >= MIN_CHUNK_CHARS) chunks.push(buf);
  return chunks;
}

/* ============================================================
   Indexing
   ============================================================ */

export interface IndexInput {
  userId: string;
  filename: string;
  fileType: string;
  text: string;
  sourceUploadId?: string;
  /**
   * Channel this doc was ingested from (e.g. 'line', 'web', 'admin'). Stored
   * in the per-chunk metadata so callers can filter by source later. Falls
   * back to 'unknown' when omitted.
   */
  source?: string;
  /**
   * Doc-level metadata propagated to every chunk's JSON column. Useful for
   * tag-based filtering ({ tags: ['policy','hr'] }, { project: 'Q3' }, etc).
   * Merged with the per-doc defaults (filename/fileType/source/uploadedAt).
   */
  metadata?: Record<string, unknown>;
}

export interface IndexResult {
  docId: string;
  chunkCount: number;
  totalTokens: number;
}

const EMBED_BATCH_SIZE = 64;

/**
 * Persist a document, chunk it, embed all chunks via bge-m3, write rows.
 * Throws on hard failures; partial success is captured by updating
 * `user_documents.status` to 'failed' with the error message.
 */
export async function indexDocument(input: IndexInput): Promise<IndexResult> {
  const docId = uuidv4();
  await dbRun(
    `INSERT INTO user_documents
       (id, user_id, source_upload_id, filename, file_type, status)
     VALUES (?, ?, ?, ?, ?, 'indexing')`,
    docId, input.userId, input.sourceUploadId ?? null, input.filename, input.fileType,
  );

  try {
    const chunks = chunkText(input.text);
    if (chunks.length === 0) {
      await dbRun(
        "UPDATE user_documents SET status = 'failed', error = ? WHERE id = ?",
        'no extractable text', docId,
      );
      return { docId, chunkCount: 0, totalTokens: 0 };
    }

    // Doc-level metadata defaults — propagated to every chunk row so the
    // filter DSL can prune candidates server-side via JSON_VALUE.
    const docMetadata: Record<string, unknown> = {
      filename: input.filename,
      fileType: input.fileType,
      source: input.source ?? 'unknown',
      uploadedAt: new Date().toISOString(),
      docId,
      ...(input.metadata ?? {}),
    };

    let totalTokens = 0;
    for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
      const embedded = await embed({ input: batch });
      totalTokens += embedded.usage?.total_tokens ?? 0;

      // Bulk-insert with one multi-row INSERT for speed.
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params: unknown[] = [];
      batch.forEach((content, i) => {
        const chunkMetadata = { ...docMetadata, chunkIndex: start + i };
        params.push(
          input.userId,
          docId,
          start + i,
          content,
          JSON.stringify(embedded.vectors[i]),
          // Approximate per-chunk tokens by sharing the batch usage.
          Math.round((embedded.usage?.total_tokens ?? 0) / batch.length),
          JSON.stringify(chunkMetadata),
        );
      });
      const insertResult = await dbRun(
        `INSERT INTO user_doc_chunks (user_id, doc_id, chunk_index, content, embedding, tokens, metadata)
         VALUES ${placeholders}`,
        ...params,
      );

      // Mirror into the per-user HNSW + BM25 indexes. A single multi-row
      // INSERT yields contiguous auto-increment IDs starting at insertId, so
      // we can derive chunkIds without an extra SELECT. Failures here are
      // non-fatal — the JSON column stays the source of truth and lazy-build
      // can rebuild both indexes from MySQL on next query.
      try {
        const firstChunkId = insertResult.insertId;
        await hnswStore.addChunks(
          input.userId,
          batch.map((_, i) => ({
            chunkId: firstChunkId + i,
            vector: embedded.vectors[i],
          })),
        );
        await bm25Store.addChunks(
          input.userId,
          batch.map((content, i) => ({
            chunkId: firstChunkId + i,
            content,
          })),
        );
      } catch (hybridErr) {
        console.warn(`[personalRag] HNSW/BM25 dual-write failed for user ${input.userId} doc ${docId}:`, (hybridErr as Error).message);
      }
    }

    await dbRun(
      `UPDATE user_documents
         SET status = 'indexed', total_chunks = ?, indexed_at = NOW(),
             embedding_format = 'both'
       WHERE id = ?`,
      chunks.length, docId,
    );

    return { docId, chunkCount: chunks.length, totalTokens };
  } catch (err) {
    await dbRun(
      "UPDATE user_documents SET status = 'failed', error = ? WHERE id = ?",
      (err as Error).message.slice(0, 500), docId,
    );
    throw err;
  }
}

/* ============================================================
   Retrieval
   ============================================================ */

export interface RagHit {
  chunkId: number;
  docId: string;
  filename: string;
  content: string;
  score: number;
}

interface ChunkRow {
  id: number;
  doc_id: string;
  content: string;
  /**
   * mysql2 auto-parses JSON columns to arrays/objects — but the type here
   * stays `unknown` because older snapshots (or migrated rows) may still
   * be raw strings. `coerceVector` handles both paths.
   */
  embedding: unknown;
  filename: string;
}

function coerceVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Return the top-K chunks for a query across all of the user's indexed docs.
 * Scores below `minScore` are filtered — a useful guard against forced
 * irrelevant retrieval when the user has nothing related to the question.
 */
export async function searchTopK(opts: {
  userId: string;
  query: string;
  k?: number;
  minScore?: number;
}): Promise<RagHit[]> {
  const k = opts.k ?? 5;
  // bge-m3 cosine scores on Chinese policy text: relevant ~0.6+, noise ~0.35-0.4.
  // 0.45 keeps the obvious matches and trims the long tail.
  const minScore = opts.minScore ?? 0.45;

  const queryResult = await embed({ input: opts.query });
  const queryVec = queryResult.vectors[0];
  if (!queryVec) return [];

  // ANN via per-user HNSW (lazy-built from JSON on first query if needed).
  // Over-fetch (k*3) so post-minScore filtering still has candidates.
  const hits = await hnswStore.search(opts.userId, queryVec, k * 3);
  if (hits.length === 0) return [];

  const candidates = hits.filter(h => h.score >= minScore).slice(0, k);
  if (candidates.length === 0) return [];

  // Hydrate content + filename for the surviving chunkIds.
  const ids = candidates.map(c => c.chunkId);
  const rows = await dbAll<ChunkRow>(
    `SELECT c.id, c.doc_id, c.content, c.embedding, d.filename
     FROM user_doc_chunks c
     JOIN user_documents d ON d.id = c.doc_id
     WHERE c.user_id = ? AND c.id IN (${ids.map(() => '?').join(',')})`,
    opts.userId, ...ids,
  );

  const byId = new Map(rows.map(r => [r.id, r]));
  const out: RagHit[] = [];
  for (const c of candidates) {
    const r = byId.get(c.chunkId);
    if (!r) continue;
    out.push({
      chunkId: r.id,
      docId: r.doc_id,
      filename: r.filename,
      content: r.content,
      score: c.score,
    });
  }
  return out;
}

/**
 * Format hits as a system-prompt addendum the orchestrator can inject. Keeps
 * sources visible to the model so it can cite filenames in its replies.
 */
export function formatHitsForPrompt(hits: RagHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = ['# 個人知識庫檢索結果', '', '以下片段來自使用者已索引的私人文件，請優先以這些內容回答；引用時請標明來源檔名。', ''];
  hits.forEach((h, i) => {
    lines.push(`## 來源 ${i + 1}：${h.filename} (similarity ${h.score.toFixed(3)})`);
    lines.push('');
    lines.push(h.content);
    lines.push('');
  });
  return lines.join('\n');
}

/* ============================================================
   Convenience: count + list user docs
   ============================================================ */

export interface UserDocSummary {
  id: string;
  filename: string;
  file_type: string;
  status: string;
  total_chunks: number;
  created_at: string;
  indexed_at: string | null;
}

export async function listUserDocs(userId: string, limit = 20): Promise<UserDocSummary[]> {
  return dbAll<UserDocSummary>(
    `SELECT id, filename, file_type, status, total_chunks, created_at, indexed_at
     FROM user_documents
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    userId, limit,
  );
}

export async function countIndexedChunks(userId: string): Promise<number> {
  const row = await dbGet<{ n: number }>(
    "SELECT COUNT(*) AS n FROM user_doc_chunks c JOIN user_documents d ON d.id = c.doc_id WHERE c.user_id = ? AND d.status = 'indexed'",
    userId,
  );
  return row?.n ?? 0;
}
