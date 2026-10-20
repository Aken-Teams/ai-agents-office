/**
 * AD username → organisational unit, for showing WHO a record belongs to.
 *
 * The users table stores an `ad_username` and nothing about where that person
 * sits — the org structure lives in AD and is fetched per request by the org
 * chart page. That is fine for one page that renders a tree, and wrong for any
 * list that wants to label each row with a department: seven domain trees per
 * request, for a value that changes when someone transfers teams, which is to
 * say almost never.
 *
 * So the tree is walked once and flattened into a username → path map, cached
 * for an hour. A miss is not an error: contractors, service accounts, and
 * people who left between the last sync and now simply have no OU, and the
 * caller shows them as 其他 rather than inventing a department for them.
 */
import { config } from '../config.js';

const AD_DOMAINS = ['PANJIT', 'PYNMAX', 'WXPJ', 'PJWS', 'GDPJ', 'PJXZ', 'PJSD'];
const TTL_MS = 60 * 60 * 1000;

interface AdNode {
  name?: string;
  type?: string;
  members?: Array<{ username?: string; displayName?: string }>;
  children?: AdNode[];
}

export interface AdPerson {
  /**
   * The deepest OU — the actual team, e.g. 「測試區」. This is what a list
   * column shows: PANJIT's tree runs six levels deep, and a full path is
   * unreadable at a glance even though it is the more complete answer.
   */
  org: string;
  /** The whole path, for a tooltip where the full placement matters. */
  orgPath: string;
  /** AD's own display name, which is usually better than ours. */
  displayName: string;
  domain: string;
}

let cache: { at: number; map: Map<string, AdPerson> } | null = null;
let inflight: Promise<Map<string, AdPerson>> | null = null;

/**
 * Flatten one domain's tree. The root node is the domain itself and carries no
 * information worth showing, so it is dropped — a person in 「PANJIT / 資訊處」
 * reads better as 「資訊處」.
 *
 * `isRoot` rather than a depth check on `path`: an empty path means both "this
 * is the root" and "this is a first-level OU under it", so testing the path
 * silently swallowed every top-level department name too.
 */
function walk(node: AdNode | undefined, path: string[], out: Map<string, AdPerson>, domain: string, isRoot = false): void {
  if (!node) return;
  // The domain appears twice: an `organization` root wrapping an OU of the same
  // name. Both are the company, and neither tells a reader which team someone
  // is on, so the second is dropped alongside the root.
  const redundant = node.name?.toUpperCase() === domain.toUpperCase();
  const here = isRoot || redundant ? path : (node.name ? [...path, node.name] : path);
  for (const m of node.members || []) {
    const u = (m.username || '').trim().toLowerCase();
    if (!u) continue;
    // First writer wins: a person listed in two OUs is shown under the first,
    // which is the shallower one given depth-first order from the root.
    if (!out.has(u)) {
      // Empty path left empty rather than filled with a placeholder — the
      // caller decides what an unknown department is called.
      out.set(u, {
        org: here[here.length - 1] || '',
        orgPath: here.join(' / '),
        displayName: m.displayName || '',
        domain,
      });
    }
  }
  for (const c of node.children || []) walk(c, here, out, domain);
}

async function build(): Promise<Map<string, AdPerson>> {
  const out = new Map<string, AdPerson>();
  const adUrl = process.env.AD_URL;
  const adApi = process.env.AD_API;
  if (!adUrl || !adApi || config.deployMode !== 'pro-panjit') return out;

  // Domains are fetched together; one slow or broken domain must not cost the
  // others their data, so each settles on its own.
  await Promise.all(AD_DOMAINS.map(async (domain) => {
    try {
      const res = await fetch(`${adUrl}/ldap/api/v1/organizations/tree?domain=${domain}`, {
        headers: { 'X-API-Key': adApi },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return;
      // The response wraps the tree: { success, domain, tree: {...} }. Walking
      // the envelope finds no children and silently yields nobody, which is
      // indistinguishable from "AD has no one" — so unwrap explicitly.
      const body = await res.json() as { tree?: AdNode } & AdNode;
      walk(body.tree ?? body, [], out, domain, true);
    } catch {
      /* one domain unreachable — the rest still populate */
    }
  }));
  return out;
}

/** username → org, cached. Concurrent callers share one fetch. */
export async function adOrgMap(): Promise<Map<string, AdPerson>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  if (inflight) return inflight;
  inflight = build()
    .then(map => {
      // An empty result is not cached: it almost always means AD was
      // unreachable, and caching that would hide the department column for an
      // hour after a blip.
      if (map.size) cache = { at: Date.now(), map };
      return map;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
