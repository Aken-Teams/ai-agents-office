/**
 * Personal RAG metadata filter DSL — LEANN-inspired.
 *
 * A filter is either a leaf comparison or a compound boolean. Compiles to
 * either:
 *   (a) a parameterised MySQL WHERE fragment over the chunk's `metadata`
 *       JSON column (preferred — pre-narrows candidates before HNSW/BM25
 *       scoring), or
 *   (b) a pure-TS predicate against an in-memory metadata object (fallback
 *       when a clause is not SQL-expressible, or when filtering post-vector
 *       hits).
 *
 * The DSL is intentionally tiny — match LEANN's surface so users can paste
 * the same filter JSON they would use against LEANN's Python API.
 */

export type FilterLeafOp =
  | 'eq' | 'ne'
  | 'lt' | 'lte' | 'gt' | 'gte'
  | 'in' | 'nin'
  | 'contains' | 'starts_with';

export interface FilterLeaf {
  op: FilterLeafOp;
  field: string;
  value: unknown;
}

export interface FilterAnd { op: 'and'; children: Filter[] }
export interface FilterOr  { op: 'or';  children: Filter[] }

export type Filter = FilterLeaf | FilterAnd | FilterOr;

/* ============================================================
   Validation
   ============================================================ */

function isLeaf(f: Filter): f is FilterLeaf {
  return f.op !== 'and' && f.op !== 'or';
}

export function isFilter(value: unknown): value is Filter {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.op !== 'string') return false;
  if (v.op === 'and' || v.op === 'or') {
    return Array.isArray(v.children) && v.children.every(c => isFilter(c));
  }
  return typeof v.field === 'string';
}

/* ============================================================
   SQL compilation
   ============================================================ */

interface SqlPart { sql: string; params: unknown[] }

function jsonPath(field: string): string {
  // We treat field as a top-level JSON key. The caller's responsibility to
  // sanitize the field name; we also defensively allow only word + dot chars.
  if (!/^[a-zA-Z0-9_.]+$/.test(field)) {
    throw new Error(`unsafe field name in filter: ${field}`);
  }
  return `$.${field}`;
}

function leafToSql(leaf: FilterLeaf, column = 'c.metadata'): SqlPart | null {
  const path = jsonPath(leaf.field);
  // Cast JSON value to CHAR for string comparison, or DECIMAL for numeric.
  // We use JSON_VALUE (returns NULL when path absent, ideal for eq/ne logic).
  const v = leaf.value;
  switch (leaf.op) {
    case 'eq':
      return { sql: `JSON_VALUE(${column}, '${path}') = ?`, params: [String(v)] };
    case 'ne':
      return { sql: `(JSON_VALUE(${column}, '${path}') IS NULL OR JSON_VALUE(${column}, '${path}') <> ?)`, params: [String(v)] };
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (typeof v !== 'number' && typeof v !== 'string') return null;
      const opSql = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[leaf.op];
      // If value looks numeric, compare as decimal; else as string.
      if (typeof v === 'number') {
        return { sql: `CAST(JSON_VALUE(${column}, '${path}') AS DECIMAL(20,6)) ${opSql} ?`, params: [v] };
      }
      return { sql: `JSON_VALUE(${column}, '${path}') ${opSql} ?`, params: [v] };
    }
    case 'in':
    case 'nin': {
      if (!Array.isArray(v) || v.length === 0) return null;
      const placeholders = v.map(() => '?').join(', ');
      const cmp = leaf.op === 'in' ? 'IN' : 'NOT IN';
      const nullGuard = leaf.op === 'nin' ? `JSON_VALUE(${column}, '${path}') IS NULL OR ` : '';
      return {
        sql: `(${nullGuard}JSON_VALUE(${column}, '${path}') ${cmp} (${placeholders}))`,
        params: v.map(x => String(x)),
      };
    }
    case 'contains':
      if (typeof v !== 'string') return null;
      return { sql: `JSON_VALUE(${column}, '${path}') LIKE ?`, params: [`%${v}%`] };
    case 'starts_with':
      if (typeof v !== 'string') return null;
      return { sql: `JSON_VALUE(${column}, '${path}') LIKE ?`, params: [`${v}%`] };
    default:
      return null;
  }
}

/**
 * Convert a filter to a MySQL WHERE clause fragment + params. Returns null if
 * ANY node is not SQL-expressible — callers must then fall back to TS post-
 * filter (over a smaller candidate set fetched by HNSW/BM25 first).
 */
export function toSqlWhere(filter: Filter, column = 'c.metadata'): SqlPart | null {
  if (isLeaf(filter)) return leafToSql(filter, column);

  const parts: SqlPart[] = [];
  for (const child of filter.children) {
    const part = toSqlWhere(child, column);
    if (!part) return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  const joiner = filter.op === 'and' ? ' AND ' : ' OR ';
  return {
    sql: `(${parts.map(p => p.sql).join(joiner)})`,
    params: parts.flatMap(p => p.params),
  };
}

/* ============================================================
   TS evaluation (fallback)
   ============================================================ */

function getField(metadata: unknown, field: string): unknown {
  if (!metadata || typeof metadata !== 'object') return undefined;
  // Support dotted paths e.g. `author.name`.
  let cur: unknown = metadata;
  for (const segment of field.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function leafEvaluate(leaf: FilterLeaf, metadata: unknown): boolean {
  const lhs = getField(metadata, leaf.field);
  const v = leaf.value;
  switch (leaf.op) {
    case 'eq': return String(lhs) === String(v);
    case 'ne': return lhs == null || String(lhs) !== String(v);
    case 'lt': case 'lte': case 'gt': case 'gte': {
      if (lhs == null) return false;
      const a = typeof lhs === 'number' ? lhs : parseFloat(String(lhs));
      const b = typeof v === 'number' ? v : parseFloat(String(v));
      if (Number.isNaN(a) || Number.isNaN(b)) {
        // String comparison fallback.
        return ({
          lt: String(lhs) < String(v),
          lte: String(lhs) <= String(v),
          gt: String(lhs) > String(v),
          gte: String(lhs) >= String(v),
        })[leaf.op];
      }
      return ({ lt: a < b, lte: a <= b, gt: a > b, gte: a >= b })[leaf.op];
    }
    case 'in':
      return Array.isArray(v) && v.map(String).includes(String(lhs));
    case 'nin':
      return Array.isArray(v) && (lhs == null || !v.map(String).includes(String(lhs)));
    case 'contains':
      return typeof v === 'string' && typeof lhs === 'string' && lhs.includes(v);
    case 'starts_with':
      return typeof v === 'string' && typeof lhs === 'string' && lhs.startsWith(v);
    default:
      return false;
  }
}

/** Pure TS predicate evaluator — used as fallback when SQL compile fails,
 *  or to post-filter candidates already retrieved by HNSW/BM25. */
export function evaluate(filter: Filter, metadata: unknown): boolean {
  if (isLeaf(filter)) return leafEvaluate(filter, metadata);
  if (filter.op === 'and') return filter.children.every(c => evaluate(c, metadata));
  return filter.children.some(c => evaluate(c, metadata));
}
