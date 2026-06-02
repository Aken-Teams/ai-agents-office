/**
 * Hybrid vector + BM25 search — the LEANN-inspired fusion that fixes the
 * pure-semantic "missed the proper noun" miss-case.
 *
 * Pipeline:
 *   1. Embed the query (Ollama bge-m3) — once.
 *   2. In parallel:
 *        a) HNSW top-(k*4) vector hits
 *        b) BM25 top-(k*4) keyword hits
 *   3. Min-max normalize each list to [0, 1].
 *   4. Fuse:  final = w · vec + (1 - w) · bm25
 *      (chunks present in only one list are scored as 0 on the missing side)
 *   5. Drop hits below `minScore`, sort, slice to k.
 *   6. Hydrate content + filename via a single `WHERE id IN (...)` round-trip.
 *
 * Same `RagHit` shape as `searchTopK` so the LINE handler swap is one line.
 */

import { dbAll } from '../../db.js';
import { embed } from '../localLlm.js';
import * as hnswStore from './hnswStore.js';
import * as bm25Store from './bm25Store.js';
import { config } from '../../config.js';
import type { RagHit } from '../personalRag.js';
import { type Filter, toSqlWhere, evaluate } from './filterDsl.js';

interface ChunkRow {
  id: number;
  doc_id: string;
  content: string;
  filename: string;
  metadata: unknown;
}

function normalize(scores: Map<number, number>): Map<number, number> {
  if (scores.size === 0) return scores;
  let min = Infinity, max = -Infinity;
  for (const s of scores.values()) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;
  if (range === 0) {
    // All equal — flatten to 1.0 (still informative as a presence signal).
    const out = new Map<number, number>();
    for (const k of scores.keys()) out.set(k, 1);
    return out;
  }
  const out = new Map<number, number>();
  for (const [k, v] of scores) out.set(k, (v - min) / range);
  return out;
}

export interface HybridOptions {
  userId: string;
  query: string;
  k?: number;
  /** [0,1]. Higher = more weight to semantic (HNSW). Defaults from env. */
  vectorWeight?: number;
  /** Post-fusion threshold. Defaults from env. */
  minScore?: number;
  /**
   * Optional metadata filter — LEANN-style DSL. When the filter is fully
   * SQL-expressible we pre-narrow candidates via a single MySQL query and
   * pass the surviving chunk IDs as the candidate set to HNSW/BM25. When
   * partially expressible we fall back to TS post-evaluation on hydrated
   * rows.
   */
  filter?: Filter;
}

export async function hybridSearch(opts: HybridOptions): Promise<RagHit[]> {
  const k = opts.k ?? 5;
  const w = opts.vectorWeight ?? config.rag.vectorWeight;
  const minScore = opts.minScore ?? config.rag.hybridMinScore;

  const overFetch = Math.max(k * 4, 16);

  // Step 0: build candidate allowlist from filter (when SQL-expressible).
  // Empty allowlist → no candidates, short-circuit.
  let allowedIds: Set<number> | null = null;
  let sqlFiltered = false;
  if (opts.filter) {
    const sqlPart = toSqlWhere(opts.filter);
    if (sqlPart) {
      sqlFiltered = true;
      const filteredRows = await dbAll<{ id: number }>(
        `SELECT c.id
         FROM user_doc_chunks c
         JOIN user_documents d ON d.id = c.doc_id
         WHERE c.user_id = ? AND d.status = 'indexed' AND ${sqlPart.sql}`,
        opts.userId, ...sqlPart.params,
      );
      allowedIds = new Set(filteredRows.map(r => r.id));
      if (allowedIds.size === 0) return [];
    }
  }

  // Step 1+2: embed query + parallel retrieval
  const embedded = await embed({ input: opts.query });
  const queryVec = embedded.vectors[0];
  if (!queryVec) return [];

  const [vecHits, kwHits] = await Promise.all([
    hnswStore.search(opts.userId, queryVec, overFetch),
    bm25Store.search(opts.userId, opts.query, overFetch),
  ]);

  if (vecHits.length === 0 && kwHits.length === 0) return [];

  // Apply SQL allowlist (if any) to both candidate lists before fusion.
  const survivedVec = allowedIds ? vecHits.filter(h => allowedIds!.has(h.chunkId)) : vecHits;
  const survivedKw = allowedIds ? kwHits.filter(h => allowedIds!.has(h.chunkId)) : kwHits;

  // Step 3: normalize each side independently
  const vecMap = normalize(new Map(survivedVec.map(h => [h.chunkId, h.score])));
  const bm25Map = normalize(new Map(survivedKw.map(h => [h.chunkId, h.score])));

  // Step 4: fuse (union of chunkIds)
  const candidates = new Set<number>([...vecMap.keys(), ...bm25Map.keys()]);
  if (candidates.size === 0) return [];
  const fused: Array<{ chunkId: number; score: number; vec: number; bm25: number }> = [];
  for (const cid of candidates) {
    const v = vecMap.get(cid) ?? 0;
    const b = bm25Map.get(cid) ?? 0;
    fused.push({ chunkId: cid, score: w * v + (1 - w) * b, vec: v, bm25: b });
  }
  fused.sort((a, b) => b.score - a.score);

  // Step 5: filter + slice. When the filter wasn't SQL-expressible we still
  // need to honor it — we over-fetch here so the TS post-evaluator has room.
  const sliceCount = opts.filter && !sqlFiltered ? k * 3 : k;
  const top = fused.filter(f => f.score >= minScore).slice(0, sliceCount);
  if (top.length === 0) return [];

  // Step 6: hydrate
  const ids = top.map(t => t.chunkId);
  const rows = await dbAll<ChunkRow>(
    `SELECT c.id, c.doc_id, c.content, c.metadata, d.filename
     FROM user_doc_chunks c
     JOIN user_documents d ON d.id = c.doc_id
     WHERE c.user_id = ? AND c.id IN (${ids.map(() => '?').join(',')})`,
    opts.userId, ...ids,
  );

  const byId = new Map(rows.map(r => [r.id, r]));
  const out: RagHit[] = [];
  for (const t of top) {
    const r = byId.get(t.chunkId);
    if (!r) continue;
    // TS post-filter when the SQL prefilter wasn't usable. We rely on the
    // `metadata` column being non-null for chunks indexed after Phase 3;
    // older rows fail the predicate naturally.
    if (opts.filter && !sqlFiltered) {
      const meta = typeof r.metadata === 'string'
        ? safeJson(r.metadata)
        : r.metadata;
      if (!evaluate(opts.filter, meta)) continue;
    }
    out.push({
      chunkId: r.id,
      docId: r.doc_id,
      filename: r.filename,
      content: r.content,
      score: t.score,
    });
    if (out.length >= k) break;
  }
  return out;
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}
