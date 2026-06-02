/**
 * Per-user HNSW vector index for personal RAG.
 *
 * Storage layout:
 *   workspace/_rag/<userId>/
 *     index.bin   — hnswlib serialized index (cosine space)
 *     idmap.json  — labelId -> { chunkId, dim } so we can resolve search hits
 *                   and detect dim drift between sessions
 *
 * In-memory LRU caches loaded handles. Eviction persists state to disk so a
 * cold user pays only one rebuild (and only if their index file is missing).
 *
 * Lazy build path: when a user has chunks in MySQL but no index.bin yet
 * (embedding_format === 'json'), the first `searchTopK` triggers a rebuild
 * from the existing JSON embeddings — no admin migration required.
 *
 * Concurrency: a per-user mutex serializes add/build/persist so concurrent
 * upload + query don't race on the same handle.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
// hnswlib-node ships as CommonJS — import the default and destructure the
// class out of it so this file stays ESM-correct under Node 18+ / 20+.
import hnswlib from 'hnswlib-node';
const { HierarchicalNSW } = hnswlib;
type HierarchicalNSW = InstanceType<typeof hnswlib.HierarchicalNSW>;
import { config } from '../../config.js';
import { dbAll, dbRun } from '../../db.js';
import { unpackVectors } from './fp16.js';

const RAG_ROOT = path.join(config.workspaceRoot, '_rag');
const INDEX_FILE = 'index.bin';
const IDMAP_FILE = 'idmap.json';
const FP16_FILE = 'embeddings.f16';
const LRU_CAPACITY = parseInt(process.env.RAG_LRU_CAPACITY || '50', 10);
const HNSW_MAX_ELEMENTS = parseInt(process.env.RAG_HNSW_MAX_ELEMENTS || '50000', 10);
const HNSW_M = 16;             // graph connectivity — defaults match LEANN
const HNSW_EF_CONSTRUCTION = 200;
const HNSW_EF_SEARCH = 64;

interface IdMap {
  /** hnswlib label -> our `user_doc_chunks.id` */
  labelToChunkId: number[];
  dim: number;
  /** monotonic counter for the next add (also = current point count) */
  nextLabel: number;
}

export interface HnswHandle {
  index: HierarchicalNSW;
  idmap: IdMap;
  userId: string;
  dirty: boolean;
}

const cache = new Map<string, HnswHandle>();
const mutexes = new Map<string, Promise<unknown>>();

/* ============================================================
   Per-user mutex (cooperative, in-process)
   ============================================================ */

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

/* ============================================================
   Filesystem helpers
   ============================================================ */

function userDir(userId: string): string {
  return path.join(RAG_ROOT, userId);
}

async function ensureUserDir(userId: string): Promise<string> {
  const dir = userDir(userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeIdMap(userId: string, idmap: IdMap): Promise<void> {
  const dir = await ensureUserDir(userId);
  const target = path.join(dir, IDMAP_FILE);
  const tmp = target + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(idmap), 'utf-8');
  await fs.rename(tmp, target);
}

async function readIdMap(userId: string): Promise<IdMap | null> {
  try {
    const buf = await fs.readFile(path.join(userDir(userId), IDMAP_FILE), 'utf-8');
    const parsed = JSON.parse(buf) as IdMap;
    if (!Array.isArray(parsed.labelToChunkId) || typeof parsed.dim !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function persist(handle: HnswHandle): Promise<void> {
  if (!handle.dirty) return;
  const dir = await ensureUserDir(handle.userId);
  const target = path.join(dir, INDEX_FILE);
  const tmp = target + '.tmp';
  handle.index.writeIndexSync(tmp);
  await fs.rename(tmp, target);
  await writeIdMap(handle.userId, handle.idmap);
  handle.dirty = false;
}

/* ============================================================
   LRU
   ============================================================ */

function touch(userId: string, handle: HnswHandle): void {
  cache.delete(userId);
  cache.set(userId, handle);
}

async function evictIfFull(): Promise<void> {
  while (cache.size > LRU_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    const h = cache.get(oldest);
    cache.delete(oldest);
    if (h && h.dirty) {
      // Best-effort persist on eviction — log but don't crash on disk error.
      try { await persist(h); }
      catch (err) { console.error('[hnswStore] evict-persist failed for', oldest, err); }
    }
  }
}

/* ============================================================
   Index build / load
   ============================================================ */

function newIndex(dim: number, capacity = HNSW_MAX_ELEMENTS): HierarchicalNSW {
  const idx = new HierarchicalNSW('cosine', dim);
  idx.initIndex(capacity, HNSW_M, HNSW_EF_CONSTRUCTION);
  idx.setEf(HNSW_EF_SEARCH);
  return idx;
}

interface RawChunkRow {
  id: number;
  embedding: unknown;
}

function coerceVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

/**
 * Build a fresh HNSW index from the user's MySQL JSON embeddings.
 * Used both for first-time lazy build and for recovery when index.bin
 * is missing/corrupt.
 */
async function rebuildFromDb(userId: string): Promise<HnswHandle> {
  const rows = await dbAll<RawChunkRow>(
    `SELECT c.id, c.embedding
     FROM user_doc_chunks c
     JOIN user_documents d ON d.id = c.doc_id
     WHERE c.user_id = ? AND d.status = 'indexed'
     ORDER BY c.id ASC`,
    userId,
  );

  if (rows.length === 0) {
    // Empty user — still create an empty handle so callers can short-circuit
    // without a second DB round-trip. Use a placeholder dim (will be replaced
    // by first add).
    const idmap: IdMap = { labelToChunkId: [], dim: 0, nextLabel: 0 };
    const index = newIndex(1);
    return { index, idmap, userId, dirty: false };
  }

  // Determine dim from the first usable vector.
  let dim = 0;
  for (const r of rows) {
    const v = coerceVector(r.embedding);
    if (v && v.length > 0) { dim = v.length; break; }
  }
  if (dim === 0) {
    throw new Error(`[hnswStore] no valid embeddings found for user ${userId}`);
  }

  const index = newIndex(dim, Math.max(HNSW_MAX_ELEMENTS, rows.length * 2));
  const idmap: IdMap = { labelToChunkId: [], dim, nextLabel: 0 };

  for (const r of rows) {
    const vec = coerceVector(r.embedding);
    if (!vec || vec.length !== dim) continue;
    index.addPoint(vec, idmap.nextLabel);
    idmap.labelToChunkId.push(r.id);
    idmap.nextLabel++;
  }

  const handle: HnswHandle = { index, idmap, userId, dirty: true };
  await persist(handle);

  // Promote rows to 'both' format so we don't rebuild every restart.
  await dbRun(
    "UPDATE user_documents SET embedding_format = 'both' WHERE user_id = ? AND status = 'indexed'",
    userId,
  );

  return handle;
}

/**
 * Phase 4 compacted users: read fp16 embeddings + per-chunk ids from disk
 * instead of MySQL JSON. The ids file mirrors the order of vectors in the
 * fp16 file so we can rebuild the idmap deterministically. Falls back to
 * MySQL JSON if the fp16 file is missing/corrupt.
 */
async function rebuildFromFp16(userId: string): Promise<HnswHandle> {
  const dir = userDir(userId);
  const fp16Path = path.join(dir, FP16_FILE);

  if (!fsSync.existsSync(fp16Path)) {
    console.warn(`[hnswStore] fp16 mode set but file missing for ${userId}; falling back to DB rebuild`);
    return rebuildFromDb(userId);
  }

  let unpacked;
  try {
    const buf = await fs.readFile(fp16Path);
    unpacked = unpackVectors(buf);
  } catch (err) {
    console.warn(`[hnswStore] fp16 unpack failed for ${userId} — falling back to DB:`, (err as Error).message);
    return rebuildFromDb(userId);
  }

  // Prefer idmap.json (no DB hop), but reconstruct from MySQL chunk IDs when
  // it's missing or out-of-sync. Recovery path: compactRag persists vectors
  // in user_doc_chunks.id ASC order, so we can reproduce labelToChunkId from
  // a single SELECT even after idmap.json is wiped.
  let idmap = await readIdMap(userId);
  if (!idmap || idmap.labelToChunkId.length !== unpacked.count) {
    const idRows = await dbAll<{ id: number }>(
      `SELECT c.id FROM user_doc_chunks c
       JOIN user_documents d ON d.id = c.doc_id
       WHERE c.user_id = ? AND d.status = 'indexed'
       ORDER BY c.id ASC`,
      userId,
    );
    if (idRows.length !== unpacked.count) {
      console.warn(`[hnswStore] MySQL chunk count ${idRows.length} != fp16 count ${unpacked.count} for ${userId}; falling back to DB`);
      return rebuildFromDb(userId);
    }
    idmap = {
      labelToChunkId: idRows.map(r => r.id),
      dim: unpacked.dim,
      nextLabel: unpacked.count,
    };
    console.log(`[hnswStore] reconstructed idmap from MySQL for ${userId} (${idmap.labelToChunkId.length} ids)`);
    await writeIdMap(userId, idmap);
  }

  const { dim, count, vectors } = unpacked;
  const totalCapacity = Math.max(HNSW_MAX_ELEMENTS, count * 2);
  const index = newIndex(dim, totalCapacity);
  for (let i = 0; i < count; i++) {
    index.addPoint(vectors[i], i);
  }

  // Phase 4 mixed-state recovery: after compaction, new documents are still
  // indexed into MySQL JSON (with embedding_format='both'). Their chunkIds
  // come AFTER the fp16-covered range. Fold them in here so a disaster
  // rebuild from disk preserves all of the user's chunks.
  const knownChunkIds = new Set(idmap.labelToChunkId);
  const newRows = await dbAll<RawChunkRow>(
    `SELECT c.id, c.embedding
     FROM user_doc_chunks c
     JOIN user_documents d ON d.id = c.doc_id
     WHERE c.user_id = ? AND d.status = 'indexed'
           AND JSON_LENGTH(c.embedding) > 0
     ORDER BY c.id ASC`,
    userId,
  );
  let nextLabel = count;
  for (const r of newRows) {
    if (knownChunkIds.has(r.id)) continue;
    const vec = coerceVector(r.embedding);
    if (!vec || vec.length !== dim) continue;
    if (nextLabel + 1 > index.getMaxElements()) {
      index.resizeIndex(Math.max(HNSW_MAX_ELEMENTS, (nextLabel + 1) * 2));
    }
    index.addPoint(vec, nextLabel);
    idmap.labelToChunkId.push(r.id);
    nextLabel++;
  }
  if (nextLabel !== count) {
    console.log(`[hnswStore] merged ${nextLabel - count} post-compaction chunks for ${userId}`);
  }

  const handle: HnswHandle = {
    index,
    idmap: { ...idmap, dim, nextLabel },
    userId,
    dirty: true,
  };
  await persist(handle);
  return handle;
}

/**
 * Load index.bin + idmap.json from disk. Returns null if either is missing
 * or fails to parse (caller will rebuild).
 */
async function loadFromDisk(userId: string): Promise<HnswHandle | null> {
  const indexPath = path.join(userDir(userId), INDEX_FILE);
  if (!fsSync.existsSync(indexPath)) return null;
  const idmap = await readIdMap(userId);
  if (!idmap) return null;
  try {
    const dim = idmap.dim || 1;
    const index = newIndex(dim, Math.max(HNSW_MAX_ELEMENTS, idmap.labelToChunkId.length * 2));
    index.readIndexSync(indexPath, true);
    return { index, idmap, userId, dirty: false };
  } catch (err) {
    console.warn('[hnswStore] index.bin unreadable for', userId, '— rebuilding', err);
    return null;
  }
}

/* ============================================================
   Public API
   ============================================================ */

export async function loadOrBuild(userId: string): Promise<HnswHandle> {
  const cached = cache.get(userId);
  if (cached) { touch(userId, cached); return cached; }

  return withUserLock(userId, async () => {
    // Double-check inside lock — another caller may have populated it.
    const again = cache.get(userId);
    if (again) { touch(userId, again); return again; }

    let handle = await loadFromDisk(userId);
    if (!handle) {
      // Pick the right rebuild source based on the user's compaction state.
      // If ANY of the user's indexed docs is in 'hnsw' format, the MySQL
      // JSON column is no longer trustworthy — go through fp16 instead.
      const row = await dbAll<{ format: string }>(
        `SELECT DISTINCT embedding_format AS format
         FROM user_documents
         WHERE user_id = ? AND status = 'indexed'`,
        userId,
      );
      const isCompacted = row.some(r => r.format === 'hnsw');
      if (isCompacted) {
        console.log(`[hnswStore] Building HNSW for user ${userId} (from fp16 embeddings)`);
        handle = await rebuildFromFp16(userId);
      } else {
        console.log(`[hnswStore] Building HNSW for user ${userId} (from JSON embeddings)`);
        handle = await rebuildFromDb(userId);
      }
    }
    cache.set(userId, handle);
    await evictIfFull();
    return handle;
  });
}

export interface AddChunkInput {
  chunkId: number;
  vector: number[];
}

export async function addChunks(userId: string, chunks: AddChunkInput[]): Promise<void> {
  if (chunks.length === 0) return;
  await withUserLock(userId, async () => {
    let handle = cache.get(userId) ?? await loadFromDisk(userId);
    if (!handle) {
      // First write for this user — initialize directly from the incoming dim.
      const dim = chunks[0].vector.length;
      const index = newIndex(dim);
      handle = { index, idmap: { labelToChunkId: [], dim, nextLabel: 0 }, userId, dirty: false };
    }

    // Re-init if dim drift (e.g. embedding model switched). Rare.
    if (handle.idmap.dim && chunks[0].vector.length !== handle.idmap.dim) {
      throw new Error(`[hnswStore] dim mismatch for user ${userId}: index=${handle.idmap.dim} incoming=${chunks[0].vector.length}`);
    }
    if (!handle.idmap.dim) {
      handle.idmap.dim = chunks[0].vector.length;
    }

    // Grow if needed.
    if (handle.idmap.nextLabel + chunks.length > handle.index.getMaxElements()) {
      handle.index.resizeIndex(Math.max(HNSW_MAX_ELEMENTS, (handle.idmap.nextLabel + chunks.length) * 2));
    }

    for (const c of chunks) {
      if (c.vector.length !== handle.idmap.dim) continue;
      handle.index.addPoint(c.vector, handle.idmap.nextLabel);
      handle.idmap.labelToChunkId.push(c.chunkId);
      handle.idmap.nextLabel++;
    }
    handle.dirty = true;
    cache.set(userId, handle);
    await evictIfFull();
    await persist(handle);
  });
}

export interface SearchHit {
  chunkId: number;
  score: number; // cosine-like in [0, 1], higher = better
}

/**
 * k-NN search. Distance from hnswlib in 'cosine' space is `1 - cosineSim`,
 * so we map back: score = max(0, 1 - distance).
 */
export async function search(userId: string, queryVec: number[], k: number): Promise<SearchHit[]> {
  const handle = await loadOrBuild(userId);
  touch(userId, handle);
  if (handle.idmap.nextLabel === 0) return [];
  if (queryVec.length !== handle.idmap.dim) {
    console.warn(`[hnswStore] query dim ${queryVec.length} != index dim ${handle.idmap.dim} for ${userId}`);
    return [];
  }
  const want = Math.min(k, handle.idmap.nextLabel);
  const { neighbors, distances } = handle.index.searchKnn(queryVec, want);
  const out: SearchHit[] = [];
  for (let i = 0; i < neighbors.length; i++) {
    const label = neighbors[i];
    const chunkId = handle.idmap.labelToChunkId[label];
    if (chunkId === undefined) continue;
    const score = Math.max(0, 1 - distances[i]);
    out.push({ chunkId, score });
  }
  return out;
}

/**
 * Mark all of a doc's chunks as deleted in the index. Soft delete — hnswlib
 * keeps the labels around but excludes them from search. Caller is
 * responsible for DELETE FROM user_doc_chunks.
 */
export async function removeDoc(userId: string, docId: string): Promise<void> {
  const rows = await dbAll<{ id: number }>(
    'SELECT id FROM user_doc_chunks WHERE user_id = ? AND doc_id = ?',
    userId, docId,
  );
  if (rows.length === 0) return;

  await withUserLock(userId, async () => {
    const handle = cache.get(userId) ?? await loadFromDisk(userId);
    if (!handle) return; // nothing built yet — nothing to remove
    const targetIds = new Set(rows.map(r => r.id));
    for (let label = 0; label < handle.idmap.labelToChunkId.length; label++) {
      if (targetIds.has(handle.idmap.labelToChunkId[label])) {
        try { handle.index.markDelete(label); } catch { /* already deleted */ }
      }
    }
    handle.dirty = true;
    await persist(handle);
  });
}

/** For graceful shutdown — persist any dirty cached handles. */
export async function persistAll(): Promise<void> {
  for (const h of cache.values()) {
    try { await persist(h); }
    catch (err) { console.error('[hnswStore] persistAll failed for', h.userId, err); }
  }
}
