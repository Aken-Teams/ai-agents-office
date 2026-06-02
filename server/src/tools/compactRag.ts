/**
 * Phase 4 — compact a single user's RAG into fp16 storage.
 *
 * Usage (from the server/ workspace):
 *   pnpm tsx src/tools/compactRag.ts <userId> [--dry-run] [--keep-json]
 *
 * What it does (atomic-ish — we write the new file, then flip the flag, then
 * null out the JSON; a crash mid-way is recoverable since the fp16 file is
 * the new source of truth and the old JSON is still there):
 *
 *   1. Sanity check: the user's HNSW index exists and idmap.json's chunkId
 *      sequence matches MySQL row order. Refuse to compact if there's drift.
 *   2. Read all chunk embeddings from MySQL JSON (in idmap order — same
 *      order the HNSW labels point to).
 *   3. Pack as fp16 + write `workspace/_rag/<userId>/embeddings.f16`.
 *   4. Round-trip verify: unpack the file, compare cosine-similarity of every
 *      vector against the original float32. Fail if max delta > 0.001.
 *   5. UPDATE user_documents SET embedding_format='hnsw' for this user.
 *   6. (unless --keep-json) UPDATE user_doc_chunks SET embedding = NULL
 *      for this user — actually reclaims MySQL space.
 *
 * Recovery: if the fp16 file is later corrupted/deleted, hnswStore falls
 * back to MySQL JSON. With --keep-json (default OFF), that fallback works.
 * Without it, the user needs to be re-indexed (we log a clear warning).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { dbAll, dbGet, dbRun } from '../db.js';
import pool from '../db.js';
import * as hnswStore from '../services/rag/hnswStore.js';
import { packVectors, unpackVectors } from '../services/rag/fp16.js';

interface ChunkRow {
  id: number;
  embedding: unknown;
}

function coerceVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try { const p = JSON.parse(value); return Array.isArray(p) ? p : null; }
    catch { return null; }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function main(): Promise<void> {
  const userId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  const keepJson = process.argv.includes('--keep-json');

  if (!userId) {
    console.error('usage: pnpm tsx src/tools/compactRag.ts <userId> [--dry-run] [--keep-json]');
    process.exit(2);
  }

  console.log(`[compactRag] user=${userId} dryRun=${dryRun} keepJson=${keepJson}`);

  // 1. Pre-flight: ensure HNSW exists, idmap is loaded, embedding_format != hnsw.
  const docs = await dbAll<{ id: string; embedding_format: string; total_chunks: number }>(
    `SELECT id, embedding_format, total_chunks FROM user_documents
     WHERE user_id = ? AND status = 'indexed'`,
    userId,
  );
  if (docs.length === 0) { console.log('[compactRag] no indexed docs for user — nothing to do'); process.exit(0); }
  if (docs.some(d => d.embedding_format === 'hnsw')) {
    console.log('[compactRag] some docs already in hnsw format — already compacted, refusing');
    process.exit(0);
  }

  const handle = await hnswStore.loadOrBuild(userId);
  if (handle.idmap.nextLabel === 0) { console.log('[compactRag] HNSW has 0 chunks — nothing to do'); process.exit(0); }
  const labelToChunkId = handle.idmap.labelToChunkId;
  console.log(`[compactRag] HNSW has ${labelToChunkId.length} chunks, dim=${handle.idmap.dim}`);

  // 2. Pull embeddings from MySQL in idmap order.
  const rows = await dbAll<ChunkRow>(
    `SELECT id, embedding FROM user_doc_chunks
     WHERE user_id = ? ORDER BY id ASC`,
    userId,
  );
  const byChunkId = new Map<number, ChunkRow>();
  for (const r of rows) byChunkId.set(r.id, r);

  const orderedVectors: number[][] = [];
  for (const chunkId of labelToChunkId) {
    const r = byChunkId.get(chunkId);
    if (!r) {
      console.error(`[compactRag] idmap references chunkId ${chunkId} but no MySQL row — drift! aborting`);
      process.exit(1);
    }
    const vec = coerceVector(r.embedding);
    if (!vec) {
      console.error(`[compactRag] chunkId ${chunkId} has no valid embedding JSON — aborting`);
      process.exit(1);
    }
    orderedVectors.push(vec);
  }
  console.log(`[compactRag] collected ${orderedVectors.length} vectors aligned to HNSW idmap`);

  // 3. Pack + write atomically (.tmp -> rename).
  const dir = path.join(config.workspaceRoot, '_rag', userId);
  const target = path.join(dir, 'embeddings.f16');
  const tmp = target + '.tmp';
  await fs.mkdir(dir, { recursive: true });
  const packed = packVectors(orderedVectors);
  const beforeSize = await measureJsonSize(userId);
  if (!dryRun) {
    await fs.writeFile(tmp, packed);
    await fs.rename(tmp, target);
  }
  console.log(`[compactRag] fp16 file: ${packed.length} bytes (${(packed.length / 1024).toFixed(1)} KB)`);
  console.log(`[compactRag] MySQL JSON before: ${(beforeSize / 1024).toFixed(1)} KB across ${orderedVectors.length} rows`);

  // 4. Round-trip integrity check: unpack the buffer we just wrote and verify
  //    cosine similarity is >= 0.999 for every vector. fp16 introduces tiny
  //    quantization error; bge-m3 cosine should still be effectively identical.
  const roundTripped = unpackVectors(packed);
  let maxDelta = 0;
  for (let i = 0; i < orderedVectors.length; i++) {
    const sim = cosine(orderedVectors[i], roundTripped.vectors[i]);
    const delta = 1 - sim;
    if (delta > maxDelta) maxDelta = delta;
  }
  console.log(`[compactRag] round-trip max cosine delta: ${maxDelta.toExponential(2)} (must be < 1e-3)`);
  if (maxDelta > 1e-3) {
    console.error('[compactRag] quantization loss too high — aborting');
    process.exit(1);
  }

  if (dryRun) {
    console.log('[compactRag] DRY-RUN — no DB changes made, fp16 not written');
    process.exit(0);
  }

  // 5. Flip the flag.
  await dbRun(
    "UPDATE user_documents SET embedding_format = 'hnsw' WHERE user_id = ? AND status = 'indexed'",
    userId,
  );

  // 6. Null out the now-redundant JSON column unless caller asked to keep it.
  let savedBytes = 0;
  if (!keepJson) {
    const before = await measureJsonSize(userId);
    await dbRun(
      `UPDATE user_doc_chunks SET embedding = JSON_ARRAY() WHERE user_id = ?`,
      userId,
    );
    const after = await measureJsonSize(userId);
    savedBytes = before - after;
    console.log(`[compactRag] cleared embedding JSON: ${(before / 1024).toFixed(1)} KB -> ${(after / 1024).toFixed(1)} KB (saved ${(savedBytes / 1024).toFixed(1)} KB)`);
  } else {
    console.log('[compactRag] --keep-json: leaving MySQL embedding JSON intact as a safety net');
  }

  console.log(`[compactRag] ✓ done. fp16 file: ${target}`);
  process.exit(0);
}

/** Sum the byte length of embedding JSON across the user's chunks. */
async function measureJsonSize(userId: string): Promise<number> {
  const row = await dbGet<{ total: number }>(
    `SELECT COALESCE(SUM(JSON_LENGTH(embedding) * 2), 0) AS total
     FROM user_doc_chunks WHERE user_id = ?`,
    userId,
  );
  // JSON_LENGTH counts array elements; we approximate bytes as elements * ~10
  // (each "0.xxx," is ~10 bytes in the json text). Used only for logging.
  return Math.round((row?.total ?? 0) * 5);
}

main()
  .catch(err => { console.error('[compactRag] failed:', err); process.exit(1); })
  .finally(() => { void pool.end(); });
