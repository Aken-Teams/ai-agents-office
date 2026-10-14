/**
 * Geocoding — turn a place NAME into real coordinates, so the model never has
 * to invent them.
 *
 * ── Why this exists ──
 * Map output used to be produced entirely from the model's memory: it wrote
 * {"lat":22.79,"lng":120.29,"label":"岡山車站"} straight into a map block or a
 * MapLibre HTML page, and the research skill's only defence was a line in the
 * prompt telling it to "use WebSearch to look up accurate coordinates". That
 * does not work. WebSearch returns prose; the model still has to pick the
 * numbers out of it, and when it can't it falls back to a plausible-looking
 * guess. A real map of 岡山 shipped to the user with five of six landmarks
 * carrying the disclaimer「概略估算位置」— which is the honest version of the
 * same failure.
 *
 * So the lookup moves out of the model. This module does it against a real
 * gazetteer and reports NOT FOUND as a first-class answer, because the only
 * thing worse than a missing pin is a confident wrong one.
 *
 * ── Provider ──
 * Nominatim (OpenStreetMap) by default: no key, no account, and — the reason it
 * beats Google here — it is the SAME dataset behind the OSM raster tiles that
 * Leaflet and MapLibre already render in this app. A Nominatim hit lands on the
 * building the user can see under the pin; a Google hit can sit tens of metres
 * off the OSM geometry and read as a bug. Google is used instead when
 * GOOGLE_MAPS_API_KEY is set, for deployments that have one and want its
 * stronger coverage of businesses and informal names.
 *
 * ── Nominatim's terms, which are not optional ──
 * Max 1 request/second, and a User-Agent that identifies the application. Both
 * are enforced here rather than hoped for: every call funnels through one
 * serialized queue with a minimum gap, and results are cached across runs so a
 * second deck about the same place costs nothing.
 *
 * Deliberately dependency-free (node built-ins only) — geoMcp.ts imports it
 * from a separate spawned process that must finish booting inside the MCP
 * handshake window, so it cannot afford to pull in config/db/etc.
 */
import fs from 'fs';
import path from 'path';

export interface GeoHit {
  /** Echoed back so a batch result can be matched to its request. */
  query: string;
  found: boolean;
  lat?: number;
  lng?: number;
  /** The provider's canonical name for the place — show this, don't re-guess it. */
  address?: string;
  /** e.g. 'railway station', 'school', 'administrative'. Useful for picking an icon. */
  kind?: string;
  /** [south, north, west, east] — lets a caller fit the viewport to a real extent. */
  bbox?: [number, number, number, number];
  source?: 'nominatim' | 'google' | 'cache';
  /**
   * Whether the returned place is actually the one that was asked for.
   *
   * A gazetteer answers every query with its nearest thing, and that is the
   * dangerous case: 「岡山之眼」 (a skywalk, absent from OSM) comes back as
   * 「岡山」 railway station — right region, wrong landmark, full confidence.
   * A pin like that is worse than no pin, because nothing downstream can tell
   * it apart from a correct one. When this is false the coordinates are a
   * near-miss to be labelled or re-queried, never shown as the place itself.
   */
  verified?: boolean;
  /** Present when found=false, or when verified=false — says what was found instead. */
  note?: string;
}

// ── Match quality ──────────────────────────────────────────────────────────
// Does the place the provider returned actually answer the query?
//
// The test is containment of the query's most distinctive term, with one
// exception for administrative prefixes: a search for 「高雄市岡山區公所」
// legitimately resolves to a place NAMED 「岡山區公所」, and the leftover
// 「高雄市」 is scope, not a different place. 「之眼」 is not.
const ADMIN_LEFTOVER = /^(?:台灣|臺灣|taiwan)?(?:[一-鿿]{1,3}[縣市])?(?:[一-鿿]{1,3}[區鄉鎮])?$/i;

function matchesQuery(query: string, name: string): boolean {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  const terms = query.trim().toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  if (!terms.length) return false;

  // The longest term carries the identity: in 「空軍軍官學校 岡山」 the school
  // is the subject and 岡山 is the region narrowing it.
  const longest = terms.reduce((a, b) => (b.length > a.length ? b : a));
  if (n.includes(longest)) return true;

  // Provider name is shorter than the query — fine only if what it dropped was
  // administrative scope.
  const joined = terms.join('');
  if (joined.includes(n)) return ADMIN_LEFTOVER.test(joined.replace(n, '').trim());
  return false;
}

const UA = process.env.GEOCODE_USER_AGENT
  || 'AI-Agents-Office/1.0 (document generation; geocoding for generated maps)';
const NOMINATIM_BASE = (process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const REQUEST_TIMEOUT_MS = 8000;
/** Nominatim's published ceiling is 1 req/s. 1100ms leaves room for clock jitter. */
const MIN_GAP_MS = Number(process.env.GEOCODE_MIN_GAP_MS || 1100);
/** A batch is capped so one prompt can't turn into a two-minute rate-limited crawl. */
export const MAX_BATCH = 25;

export function activeProvider(): 'google' | 'nominatim' {
  return GOOGLE_KEY ? 'google' : 'nominatim';
}

// ── Cross-run cache ────────────────────────────────────────────────────────
// Append-only JSONL. Appends from concurrent agent runs interleave safely at
// the line level (each write is one small appendFileSync), and on read the LAST
// entry for a key wins, so a re-lookup naturally supersedes an older one. A
// corrupt line is skipped rather than fatal — a cache that refuses to load is
// worse than a cache that lost one entry.
const CACHE_FILE = process.env.GEOCODE_CACHE_FILE || '';
let cache: Map<string, GeoHit> | null = null;

function cacheKey(query: string, countryHint?: string): string {
  return `${activeProvider()}|${(countryHint || '').toLowerCase()}|${query.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function loadCache(): Map<string, GeoHit> {
  if (cache) return cache;
  cache = new Map();
  if (!CACHE_FILE || !fs.existsSync(CACHE_FILE)) return cache;
  try {
    for (const line of fs.readFileSync(CACHE_FILE, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.k && entry?.v) cache.set(entry.k, entry.v);
      } catch { /* skip a torn line */ }
    }
  } catch { /* unreadable cache == no cache */ }
  return cache;
}

function remember(key: string, hit: GeoHit): void {
  loadCache().set(key, hit);
  if (!CACHE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.appendFileSync(CACHE_FILE, JSON.stringify({ k: key, v: hit }) + '\n', 'utf-8');
  } catch { /* a cache miss next time is not worth failing the lookup over */ }
}

// ── Rate limiting ──────────────────────────────────────────────────────────
// One promise chain, so parallel callers queue instead of bursting. Each link
// waits out whatever remains of the minimum gap since the previous request.
let gate: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this link rejects, or one failure stalls
  // every lookup queued behind it.
  gate = run.then(() => undefined, () => undefined);
  return run;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'zh-TW,zh,en' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Providers ──────────────────────────────────────────────────────────────

async function nominatimSearch(query: string, countryHint?: string): Promise<GeoHit> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    // Several candidates, not one: the top hit for 「岡山火車站」 is a parcel
    // locker in the station forecourt, while the station itself is further
    // down. Ranking by name match beats trusting the provider's rank.
    limit: '5',
    addressdetails: '0',
    'accept-language': 'zh-TW,zh,en',
  });
  if (countryHint) params.set('countrycodes', countryHint.toLowerCase());
  const rows = await getJson(`${NOMINATIM_BASE}/search?${params}`);
  if (!Array.isArray(rows) || !rows.length) {
    return { query, found: false, note: 'no match in OpenStreetMap' };
  }

  const named = (r: any) => String(r.name || String(r.display_name || '').split(',')[0] || '');
  // First candidate whose name answers the query; otherwise the most prominent
  // one, flagged as unverified.
  const matched = rows.find((r: any) => matchesQuery(query, named(r)));
  const r = matched || rows.reduce((a: any, b: any) => (Number(b.importance) > Number(a.importance) ? b : a));

  const bb = Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : undefined;
  return {
    query,
    found: true,
    verified: !!matched,
    lat: Number(r.lat),
    lng: Number(r.lon),
    address: r.display_name,
    kind: r.type,
    bbox: bb && bb.length === 4 && bb.every((n: number) => Number.isFinite(n))
      ? [bb[0], bb[1], bb[2], bb[3]]
      : undefined,
    source: 'nominatim',
    note: matched
      ? undefined
      : `OpenStreetMap has no place named "${query}". Closest entry is "${named(r)}" (${r.type}) — a different place, not a spelling of the one asked for.`,
  };
}

async function googleSearch(query: string, countryHint?: string): Promise<GeoHit> {
  const params = new URLSearchParams({ address: query, key: GOOGLE_KEY, language: 'zh-TW' });
  if (countryHint) params.set('components', `country:${countryHint.toUpperCase()}`);
  const data = await getJson(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  if (data.status === 'ZERO_RESULTS' || !data.results?.length) {
    return { query, found: false, note: 'no match in Google Geocoding' };
  }
  // A bad key or an exhausted quota must not be reported as "this place does
  // not exist" — the caller would believe it.
  if (data.status !== 'OK') {
    return {
      query,
      found: false,
      note: `Google Geocoding error: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`,
    };
  }
  // Google flags its own fuzzy matches, which is a better signal than any
  // name comparison we could run against a formatted address.
  const r = data.results.find((x: any) => !x.partial_match) || data.results[0];
  const vp = r.geometry?.viewport;
  return {
    query,
    found: true,
    verified: !r.partial_match,
    lat: r.geometry?.location?.lat,
    lng: r.geometry?.location?.lng,
    address: r.formatted_address,
    kind: Array.isArray(r.types) ? r.types[0] : undefined,
    bbox: vp ? [vp.southwest.lat, vp.northeast.lat, vp.southwest.lng, vp.northeast.lng] : undefined,
    source: 'google',
    note: r.partial_match
      ? `Google reports only a partial match — the nearest entry is "${r.formatted_address}", which may be a different place.`
      : undefined,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Look up one place. Never throws: a provider outage comes back as found=false
 * with the reason, because the caller's job is then to report "couldn't verify"
 * rather than to fall back on a guess.
 */
export async function geocodeOne(query: string, countryHint?: string): Promise<GeoHit> {
  const q = String(query || '').trim();
  if (!q) return { query: q, found: false, note: 'empty query' };

  const key = cacheKey(q, countryHint);
  const cached = loadCache().get(key);
  if (cached) return { ...cached, query: q, source: 'cache' };

  try {
    const hit = await throttled(() => (GOOGLE_KEY ? googleSearch(q, countryHint) : nominatimSearch(q, countryHint)));
    // Negative results are cached too: a misspelt place name asked three times
    // in one deck should cost one request, not three.
    remember(key, hit);
    return hit;
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError'
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : String(err?.message || err);
    // NOT cached — an outage is temporary and must not poison later runs.
    return { query: q, found: false, note: `lookup failed (${reason})` };
  }
}

/** Look up several places. Serialized by the rate limiter; order is preserved. */
export async function geocodePlaces(queries: string[], countryHint?: string): Promise<GeoHit[]> {
  const out: GeoHit[] = [];
  for (const q of queries.slice(0, MAX_BATCH)) out.push(await geocodeOne(q, countryHint));
  return out;
}

/** Coordinates → the place that is actually there. */
export async function reverseGeocode(lat: number, lng: number): Promise<GeoHit> {
  const query = `${lat},${lng}`;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { query, found: false, note: 'coordinates out of range' };
  }
  const key = cacheKey(`reverse:${lat.toFixed(5)},${lng.toFixed(5)}`);
  const cached = loadCache().get(key);
  if (cached) return { ...cached, query, source: 'cache' };

  try {
    const hit = await throttled<GeoHit>(async () => {
      if (GOOGLE_KEY) {
        const params = new URLSearchParams({ latlng: `${lat},${lng}`, key: GOOGLE_KEY, language: 'zh-TW' });
        const data = await getJson(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
        const r = data.results?.[0];
        return r
          ? { query, found: true, verified: true, lat, lng, address: r.formatted_address, kind: r.types?.[0], source: 'google' }
          : { query, found: false, note: 'nothing mapped at those coordinates' };
      }
      const params = new URLSearchParams({
        lat: String(lat), lon: String(lng), format: 'jsonv2', 'accept-language': 'zh-TW,zh,en',
      });
      const r = await getJson(`${NOMINATIM_BASE}/reverse?${params}`);
      return r?.display_name
        ? { query, found: true, verified: true, lat, lng, address: r.display_name, kind: r.type, source: 'nominatim' }
        : { query, found: false, note: 'nothing mapped at those coordinates' };
    });
    remember(key, hit);
    return hit;
  } catch (err: any) {
    return { query, found: false, note: `lookup failed (${String(err?.message || err)})` };
  }
}
