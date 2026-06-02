/**
 * Per-user BM25 keyword index — pairs with HNSW for hybrid search.
 *
 * Storage:
 *   - In-memory only (small enough at 50K-chunk scale)
 *   - LRU keyed by userId (separate from HNSW's LRU so we can evict independently)
 *   - On miss, rebuilds from `user_doc_chunks.content` via the tokenizer
 *
 * Math: standard BM25 (Robertson) with k1=1.5, b=0.75 — matches the defaults
 * LEANN ships with. Scores are not normalized here; hybridSearch does the
 * min-max normalization across the candidate set.
 */

import { dbAll } from '../../db.js';
import { tokenize } from './tokenize.js';

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const LRU_CAPACITY = parseInt(process.env.RAG_LRU_CAPACITY || '50', 10);

interface PostingEntry {
  /** which chunkIds contain this term, and how many times */
  byChunk: Map<number, number>;
}

interface Bm25Index {
  /** chunkId -> token count (for length normalization) */
  docLen: Map<number, number>;
  /** total tokens across the corpus / number of docs */
  avgDocLen: number;
  /** token -> postings */
  postings: Map<string, PostingEntry>;
  /** N = number of docs (chunks) */
  docCount: number;
}

interface Bm25Handle {
  userId: string;
  index: Bm25Index;
}

const cache = new Map<string, Bm25Handle>();
const mutexes = new Map<string, Promise<unknown>>();

async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  mutexes.set(userId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (mutexes.get(userId) === prev.then(() => next)) mutexes.delete(userId);
  }
}

function touch(userId: string, h: Bm25Handle): void {
  cache.delete(userId);
  cache.set(userId, h);
}

function evictIfFull(): void {
  while (cache.size > LRU_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/* ============================================================
   Index construction
   ============================================================ */

function emptyIndex(): Bm25Index {
  return { docLen: new Map(), avgDocLen: 0, postings: new Map(), docCount: 0 };
}

function indexAddChunk(idx: Bm25Index, chunkId: number, tokens: string[]): void {
  if (idx.docLen.has(chunkId)) return; // dedup safety
  idx.docLen.set(chunkId, tokens.length);
  idx.docCount = idx.docLen.size;

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

  for (const [term, tf] of counts) {
    let entry = idx.postings.get(term);
    if (!entry) { entry = { byChunk: new Map() }; idx.postings.set(term, entry); }
    entry.byChunk.set(chunkId, tf);
  }
}

function recomputeAvg(idx: Bm25Index): void {
  if (idx.docCount === 0) { idx.avgDocLen = 0; return; }
  let total = 0;
  for (const len of idx.docLen.values()) total += len;
  idx.avgDocLen = total / idx.docCount;
}

async function buildFromDb(userId: string): Promise<Bm25Handle> {
  const rows = await dbAll<{ id: number; content: string }>(
    `SELECT c.id, c.content
     FROM user_doc_chunks c
     JOIN user_documents d ON d.id = c.doc_id
     WHERE c.user_id = ? AND d.status = 'indexed'
     ORDER BY c.id ASC`,
    userId,
  );

  const idx = emptyIndex();
  for (const r of rows) {
    indexAddChunk(idx, r.id, tokenize(r.content));
  }
  recomputeAvg(idx);
  return { userId, index: idx };
}

/* ============================================================
   Public API
   ============================================================ */

export async function loadOrBuild(userId: string): Promise<Bm25Handle> {
  const cached = cache.get(userId);
  if (cached) { touch(userId, cached); return cached; }
  return withUserLock(userId, async () => {
    const again = cache.get(userId);
    if (again) { touch(userId, again); return again; }
    console.log(`[bm25Store] Building BM25 for user ${userId}`);
    const h = await buildFromDb(userId);
    cache.set(userId, h);
    evictIfFull();
    return h;
  });
}

export interface AddChunkInput {
  chunkId: number;
  content: string;
}

export async function addChunks(userId: string, chunks: AddChunkInput[]): Promise<void> {
  if (chunks.length === 0) return;
  await withUserLock(userId, async () => {
    let handle = cache.get(userId);
    if (!handle) {
      // First touch — build full from DB so we don't miss the chunks already
      // present. The new ones will be deduped by `indexAddChunk`.
      handle = await buildFromDb(userId);
    }
    for (const c of chunks) {
      indexAddChunk(handle.index, c.chunkId, tokenize(c.content));
    }
    recomputeAvg(handle.index);
    cache.set(userId, handle);
    evictIfFull();
  });
}

export interface Bm25Hit {
  chunkId: number;
  score: number;
}

/**
 * BM25 query — returns chunkIds with raw BM25 scores. Caller normalizes /
 * fuses with vector scores. We compute over the union of postings for the
 * query terms (sparse — typical zh query has 1-5 terms).
 */
export async function search(userId: string, query: string, k: number): Promise<Bm25Hit[]> {
  const handle = await loadOrBuild(userId);
  const { index } = handle;
  if (index.docCount === 0) return [];

  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) return [];

  // Accumulate BM25 score per candidate chunk.
  const scoreByChunk = new Map<number, number>();
  for (const term of terms) {
    const entry = index.postings.get(term);
    if (!entry) continue;
    const df = entry.byChunk.size;
    if (df === 0) continue;
    // Standard Robertson-Spärck Jones IDF (with the +1 smoothing inside log).
    const idf = Math.log(1 + (index.docCount - df + 0.5) / (df + 0.5));

    for (const [chunkId, tf] of entry.byChunk) {
      const dl = index.docLen.get(chunkId) ?? 0;
      if (dl === 0) continue;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / (index.avgDocLen || 1)));
      const term_score = idf * ((tf * (BM25_K1 + 1)) / denom);
      scoreByChunk.set(chunkId, (scoreByChunk.get(chunkId) ?? 0) + term_score);
    }
  }

  const out: Bm25Hit[] = [];
  for (const [chunkId, score] of scoreByChunk) {
    if (score > 0) out.push({ chunkId, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

/** For graceful shutdown — no-op since BM25 is in-memory only, but keeps the
 *  shape consistent with hnswStore. */
export async function persistAll(): Promise<void> { /* in-memory only */ }
