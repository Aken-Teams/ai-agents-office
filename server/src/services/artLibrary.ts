/**
 * The illustration catalogue — 417 Storyset SVGs in 46 topic categories.
 *
 * ── Why illustrations and not more photographs ──
 * A stock photograph has to be ABOUT something. Put a warehouse photo on a slide
 * about warehouse throughput and it works; put one on a slide about 「流程優化」
 * and it is a picture of a warehouse pretending to be an argument. That is how
 * decks end up looking like templates: not because the photos are bad, but
 * because they are decorative and everyone can tell.
 *
 * A flat illustration does not make that claim. It reads as a diagram's
 * friendlier cousin — it fills space, carries a mood, and nobody mistakes it for
 * evidence. Which makes it the right thing for exactly the slides where a photo
 * would be filler, and it is why the web deck generator was given this library
 * in the first place.
 *
 * ── Why the server answers this and the pane does not ──
 * The catalogue is a file on this machine. Sending the model a tool call that
 * the pane would have to relay back here to read would be a round trip to ask
 * ourselves a question. It is also not an act on anybody's deck — nothing to
 * confirm, nothing to undo — so it is answered inline, like reading an uploaded
 * file.
 *
 * ── Why not paste the catalogue into the prompt ──
 * 417 URLs is roughly 20k tokens on every single turn, to be used on maybe one
 * slide in five. A search tool costs one call when it is wanted and nothing when
 * it is not.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface ArtItem {
  url: string;
  label: string;
  category: string;
}

interface Catalogue {
  categories?: Record<string, Array<{ url?: string; label?: string }>>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the JSON lives, tried in order.
 *
 * It sits in the client's public folder — it is a static asset that happens to
 * be data — and this file runs from both `src` (tsx, dev) and `dist` (built).
 * Rather than encode which, try the handful of places it can be relative to
 * either. A miss is not fatal: the tool reports an empty library and the model
 * falls back to photographs.
 */
const CANDIDATES = [
  '../../../client/public/storyset-library.json',
  '../../../../client/public/storyset-library.json',
  '../../client/public/storyset-library.json',
];

let cache: ArtItem[] | null = null;

/** Read once. The file is 53KB and never changes at runtime. */
function load(): ArtItem[] {
  if (cache) return cache;
  for (const rel of CANDIDATES) {
    const p = path.resolve(HERE, rel);
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Catalogue;
      const out: ArtItem[] = [];
      for (const [category, items] of Object.entries(raw.categories || {})) {
        for (const it of items || []) {
          if (it?.url) out.push({ url: it.url, label: String(it.label || ''), category });
        }
      }
      if (out.length) { cache = out; return cache; }
    } catch { /* try the next path */ }
  }
  cache = [];
  return cache;
}

export function artCategories(): string[] {
  return [...new Set(load().map((a) => a.category))].sort();
}

/**
 * Find illustrations for a phrase.
 *
 * ── The matching, and why it is this crude on purpose ──
 * The model asks in whatever words the slide is about — 「倉儲」, 「data
 * analytics」, 「團隊」 — and the catalogue's keys are English kebab-case topics.
 * Nothing here will bridge 「倉儲」 to `cloud-server-infrastructure`, and nothing
 * should pretend to: a fuzzy matcher that returns SOMETHING for every query is
 * worse than one that returns nothing, because the model cannot tell a real hit
 * from a shrug, and it will put the shrug on the slide.
 *
 * So: substring match on the category and the label, each term scored, and an
 * empty result when nothing matches. The tool's own output then tells the model
 * what the 46 categories actually are, which is the information it needed.
 */
export function searchArt(query: string, limit = 12): ArtItem[] {
  const all = load();
  const q = String(query || '').toLowerCase().trim();
  if (!q) return all.slice(0, limit);

  const terms = q.split(/[\s,、/]+/).filter(Boolean);
  const scored = all.map((a) => {
    const cat = a.category.toLowerCase();
    const lab = a.label.toLowerCase();
    let score = 0;
    for (const term of terms) {
      // A category hit is the stronger signal: the label carries the Storyset
      // style variant (Pana / Rafiki / Bro), so matching on it alone finds
      // everything drawn in one style rather than everything about one subject.
      if (cat === term) score += 10;
      else if (cat.includes(term)) score += 6;
      if (lab.includes(term)) score += 3;
    }
    return { a, score };
  }).filter((x) => x.score > 0);

  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit).map((x) => x.a);
}

/**
 * The tool's answer, as the text the model reads.
 *
 * Written as prose rather than JSON because that is what a tool result is for
 * here: the model needs to pick one and know why, and a bare array invites it to
 * take the first element every time.
 */
export function describeArtSearch(query: string, limit: number): { ok: true; content: string } {
  const hits = searchArt(query, limit);
  const cats = artCategories();

  if (!cats.length) {
    return {
      ok: true,
      content: '插畫庫目前讀不到（找不到 storyset-library.json）。'
        + '這一頁請改用 ppt_add_photo 放照片，或用 ppt_add_diagram 畫圖解。',
    };
  }
  if (!hits.length) {
    return {
      ok: true,
      content: `插畫庫裡沒有「${query}」。分類是英文的，用這些字去找：\n`
        + cats.join('、')
        + '\n\n找不到合適的就不要硬放——一張不相干的插畫比留白更糟。'
        + '改用 ppt_add_chart／ppt_add_diagram，或直接讓這一頁只有字。',
    };
  }
  const lines = hits.map((h, i) => `${i + 1}. ${h.label}（${h.category}）\n   ${h.url}`);
  return {
    ok: true,
    content: `找到 ${hits.length} 張插畫：\n${lines.join('\n')}\n\n`
      + '用 ppt_add_photo 把網址放上去（mode 用 side 或 block；'
      + '插畫是透明背景的扁平向量，不適合當 hero 滿版底圖）。\n'
      + '同一個主題的不同編號是不同畫風（Pana / Rafiki / Bro / Amico / Cuate），'
      + '**整份簡報請固定用同一種畫風**，混用會很明顯。',
  };
}
