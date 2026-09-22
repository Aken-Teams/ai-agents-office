/**
 * What to ask the image model for — which is most of what decides whether the
 * result is any good.
 *
 * ── Why the caller does not write the prompt ──
 * 「我自己下 prompt 都產生醜醜的東西，AI 下 prompt 產生的圖都蠻美的」. That is not a
 * coincidence and it is not about wording skill. A usable slide background needs
 * four things a person asking for 「一張工廠的圖」 will never think to say:
 *
 *   1. A composition with somewhere for the title to go. A beautifully centred
 *      subject is useless as a hero, because the words land on its face.
 *   2. The deck's own palette. A lovely image in the wrong colours makes the
 *      slide look like a template with a stock photo dropped in.
 *   3. A style scaffold. Without one the model picks, and it picks differently
 *      every page — which is exactly the 「固定醜醜的」 problem, arriving as
 *      inconsistency rather than as ugliness.
 *   4. An instruction to put NO TEXT in the picture. This model renders Chinese
 *      unusually well, which makes it more tempting, not less — and a title
 *      baked into a raster is a title nobody can fix.
 *
 * So the tool takes a SUBJECT and this composes the rest. The caller says what
 * the picture is of; the deck decides what it looks like.
 */

/**
 * Palettes as words, because that is what the model answers to.
 *
 * Hex codes mean nothing to a diffusion model. These phrases are the same
 * families the add-in's THEMES define, written the way the model understands —
 * and they are what makes a generated background belong to ITS deck rather than
 * being a nice picture that happens to be nearby.
 *
 * ── Two things learned from a bad result, both worth keeping ──
 *
 * 1. THE ACCENT COLOUR IS NOT GIVEN TO THE IMAGE MODEL.
 *    「deep navy and slate blue with a single warm red accent」 produced a dark
 *    factory lit by red lamps — which reads as an emergency, or a crime scene.
 *    The mistake was category, not wording: to a diffusion model an accent
 *    colour is not a small graphic detail, it is a LIGHT SOURCE, and a red light
 *    source in a dark scene means something has gone wrong.
 *    The accent belongs to the shapes drawn ON TOP of the picture — the rule
 *    under the title, the KPI bars, the callout spine. The slide already has its
 *    accent. The background does not need one.
 *
 * 2. BACKGROUNDS ARE GENERATED LIGHT ON PURPOSE.
 *    A hero image gets a 45% dark scrim over it before the title goes on. Start
 *    from a dark picture and the result is nearly black. So these describe the
 *    airy end of each family and let the scrim do the darkening — which is also
 *    the only version that still works when somebody uses the same image as a
 *    side panel with no scrim at all.
 */
const PALETTE: Record<string, string> = {
  corporate: 'muted blue-grey and steel blue, natural daylight',
  slate: 'cool grey and soft blue-grey, natural even light',
  fresh: 'soft sage and pale mint with warm cream light',
  warm: 'warm sand, soft clay and pale peach, sunlit',
  // Even the dark family stays calm: deep and quiet, not moody and lit from
  // below. 「dark」 without 「calm」 is where the horror lighting comes from.
  night: 'deep charcoal and midnight blue, soft even cool light, calm and quiet',
  linen: 'warm paper cream, muted sage green and soft terracotta, gentle daylight',
  muted: 'desaturated Morandi tones, dusty blue-grey and warm taupe, soft light',
  mono: 'soft greys and off-white, gentle daylight, uncluttered',
  // These three arrived with the add-in's palettes and were missing here, so a
  // deck in 黃橘 was quietly getting corporate-blue artwork. A lookup that falls
  // back silently is the kind of bug nobody reports; they just think the tool
  // ignores them.
  teal: 'soft teal and pale aqua with a warm sand accent, bright and even',
  sky: 'light sky blue and pale cornflower, airy and clean',
  amber: 'warm amber, soft ochre and cream, sunlit',
};

/**
 * The look's visual register.
 *
 * Kept separate from the palette because they are independent: 手作 in navy and
 * 手作 in linen are both coherent, and folding them together would need a row
 * per combination.
 */
const REGISTER: Record<string, string> = {
  business: 'clean corporate abstract, geometric, soft even daylight',
  editorial: 'editorial photography, natural window light, refined and understated',
  literary: 'soft layered paper shapes, matte finish, quiet and warm',
  minimal: 'extremely minimal, one simple form, vast empty space',
  soft: 'soft rounded organic shapes, gentle gradients, friendly',
  tech: 'clean abstract technology, fine lines, cool and calm, evenly lit',
  academic: 'restrained abstract, precise geometry, neutral, evenly lit',
  dashboard: 'abstract data-like forms, fine grid, cool and analytical, bright',
  courseware: 'light and approachable, simple rounded forms',
  handmade: 'textured paper collage, torn edges, handmade feel',
  whiteboard: 'clean white surface, faint pencil texture, very light',
  eink: 'matte paper texture, ink wash, monochrome and quiet',
  bold: 'bold graphic shapes, strong forms, poster-like, brightly lit',
};

/**
 * How the picture is MADE, as opposed to what it is of.
 *
 * ── The gap this closes ──
 * Everything generated so far came back as a photograph, because the register
 * strings said things like 「editorial photography, natural light」 and nothing
 * offered an alternative. So a deck that wanted a flat illustration on a content
 * slide got a stock photo of an office, every time, and 「產圖都是寫實風」 was the
 * accurate description of a choice nobody had made deliberately.
 *
 * These are media, not moods. They compose with the look's register and the
 * palette rather than replacing them: `flat` in 亞麻 and `flat` in 企業藍 are the
 * same drawing technique in two colour families.
 *
 * ── Why the default is not `photo` ──
 * A photograph has to be ABOUT something to earn its place, and most slides do
 * not have a photographable subject. An abstract composition never makes that
 * claim, so it is the safe default — and it is what the tool produced on the one
 * occasion the output was unambiguously good.
 */
const STYLE: Record<string, string> = {
  abstract: 'abstract composition, layered paper shapes, soft studio light, minimal',
  flat: 'flat vector illustration, simple geometric shapes, bold clean outlines, '
    + 'no gradients, no photographic detail',
  handdrawn: 'hand-drawn illustration, loose ink linework, light watercolour wash, '
    + 'visible paper texture',
  isometric: 'isometric illustration, clean geometric blocks, soft long shadows, '
    + 'technical but friendly',
  photo: 'photographic, natural light, shallow depth of field, editorial',
  gradient: 'smooth colour field, soft gradient, extremely minimal, no objects',
  texture: 'close-up material texture, matte surface, subtle grain, no objects',
};

export const STYLE_NAMES = Object.keys(STYLE);

/**
 * The floor every image sits on.
 *
 * Appended to every prompt regardless of subject or palette. An image model
 * given an industrial subject and no instruction about mood will reach for
 * drama, because drama is what most of its training data calls a good
 * photograph — and drama on a factory floor is indistinguishable from an
 * incident. A slide background has the opposite job: it must be pleasant enough
 * to look at for ninety seconds and forgettable enough to read over.
 */
const MOOD_FLOOR = 'soft even lighting, calm and welcoming, pleasant, clean, '
  + 'nothing ominous';

/**
 * Where the words are going to sit.
 *
 * This is the instruction nobody writes by hand and the one that decides whether
 * a background is usable at all. A hero image gets a deliberately empty half; a
 * side panel gets a vertical composition that survives being cropped to 40% of
 * the slide.
 */
const COMPOSITION: Record<string, string> = {
  hero: 'wide cinematic composition, the subject pushed to one side, '
    + 'a large calm empty area on the left for text to sit over',
  side: 'vertical composition, subject centred, calm and uncluttered',
  block: 'balanced horizontal composition, clear focal point',
};

/** Sizes the endpoint actually honours. 16:9 is undocumented but real — tested. */
export const IMAGE_SIZE: Record<string, string> = {
  hero: '1024x576',
  side: '768x1024',
  block: '1024x576',
};

/**
 * What must never appear.
 *
 * Lettering is first and is repeated in the positive prompt too, because it is
 * the one failure that cannot be worked around afterwards: everything else is a
 * picture somebody dislikes, but text in a raster is a mistake that cannot be
 * corrected without regenerating the page.
 */
export const NEGATIVE = 'text, words, letters, numbers, captions, watermark, logo, '
  + 'signature, ui, interface, chart, graph, diagram, infographic, '
  // The second group is the 「有點可怕，很像命案現場」 group, and it is not
  // optional. Red rim light on dark machinery, smoke, harsh shadows and an empty
  // derelict hall are each individually a normal photographic choice and
  // together they are a horror film. A person has to look at this for a minute
  // and a half; it needs to be pleasant, not striking.
  // NOT a bare 「dark」. That was the first attempt and it broke the two palettes
  // that are supposed to be dark — night and tech came back as pale grey, which
  // is a different way of being wrong. What makes a picture frightening is the
  // LIGHTING, not the luminance: low key, one hard source, coloured rim light.
  // Naming those leaves a deep, calm, evenly lit dark image perfectly available.
  + 'gloomy, moody, dramatic lighting, low key, chiaroscuro, ominous, eerie, sinister, '
  + 'horror, crime scene, emergency lighting, red glow, neon rim light, '
  + 'harsh shadows, night, smoke, fog, dystopian, abandoned, derelict, rust, '
  + 'blurry, low quality, jpeg artifacts, oversaturated, cluttered, busy';

export interface ImageRequest {
  subject: string;
  mode?: string;
  style?: string;
  look?: string;
  theme?: string;
  mood?: string;
}

/**
 * A seed derived from the request.
 *
 * The endpoint is fully deterministic — same seed and parameters give a
 * byte-identical PNG, which I verified rather than assumed. Deriving the seed
 * from the prompt rather than randomising it means rebuilding slide 4 gives back
 * the same background. Somebody who regenerates a page and finds the artwork has
 * changed does not read that as variety; they read it as a tool that cannot be
 * relied on.
 */
export function seedFor(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Positive, and inside the range a 32-bit seed field will accept.
  return Math.abs(h) % 2147483647;
}

export interface ComposedPrompt {
  prompt: string;
  negative: string;
  size: string;
  seed: number;
}

export function composeImagePrompt(req: ImageRequest): ComposedPrompt {
  const mode = COMPOSITION[String(req.mode || '').toLowerCase()] ? String(req.mode).toLowerCase() : 'hero';
  const subject = String(req.subject || '').trim().slice(0, 300);

  // The medium is named before the look's register, because when the two
  // disagree — 「flat vector」 against 「editorial photography」 — the model follows
  // whichever came first, and the caller asking for a flat illustration meant it.
  const style = STYLE[String(req.style || '').toLowerCase()] || STYLE.abstract;
  const register = REGISTER[String(req.look || '').toLowerCase()] || REGISTER.business;
  const parts = [
    subject,
    style,
    // The register carries the look's mood, but not its medium: saying
    // 「editorial photography」 after 「flat vector illustration」 puts the two in a
    // fight the caller did not ask for.
    register.replace(/(editorial )?photograph(y|ic),?\s*/gi, ''),
    PALETTE[String(req.theme || '').toLowerCase()] || PALETTE.corporate,
    COMPOSITION[mode],
  ];
  parts.push(MOOD_FLOOR);
  if (req.mood) parts.push(String(req.mood).trim().slice(0, 120));
  // Said last as well as excluded in the negative. Belt and braces, because this
  // is the one failure with no cure downstream.
  parts.push('no text, no letters, no words anywhere in the image');

  const prompt = parts.filter(Boolean).join(', ');
  const size = IMAGE_SIZE[mode];
  // A flat illustration must not drift back into a photograph, and a photograph
  // must not come back as a drawing. The exclusion is per-style rather than
  // global for exactly that reason.
  const negative = String(req.style || '').toLowerCase() === 'photo'
    ? NEGATIVE
    : `${NEGATIVE}, photograph, photorealistic, 3d render, depth of field`;
  return { prompt, negative, size, seed: seedFor(`${prompt}|${size}`) };
}

export const PALETTE_NAMES = Object.keys(PALETTE);
export const REGISTER_NAMES = Object.keys(REGISTER);
