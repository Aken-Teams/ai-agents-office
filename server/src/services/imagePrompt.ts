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
 * The same families, said for a subject rather than a ground.
 *
 * No 「airy」, no 「plenty of light」, no 「gentle daylight」 — those are the words
 * that turned a factory illustration into a pale wash. A drawing gets its hues
 * named and its saturation left alone.
 */
const SUBJECT_PALETTE: Record<string, string> = {
  corporate: 'deep blue, steel blue and warm grey',
  slate: 'slate grey, blue-grey and muted amber',
  fresh: 'forest green, sage and cream',
  warm: 'burnt orange, clay and deep teal',
  night: 'deep navy, electric blue and cyan on a light ground',
  linen: 'sage green, terracotta and warm cream',
  muted: 'dusty blue, warm taupe and soft rose',
  mono: 'charcoal, mid grey and one warm brown',
  teal: 'teal, aqua and warm sand',
  sky: 'cornflower blue, sky blue and soft coral',
  amber: 'amber, ochre and deep brown',
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
 * Two jobs a generated image can have, and they want opposite things.
 *
 * ── The mistake this separates out ──
 * Everything here was written for BACKGROUNDS: airy, low contrast, soft even
 * light, because a hero image has a dark scrim and a headline going on top of
 * it. Then the same instructions were handed to a flat illustration of an
 * assembly line, and produced a drawing so pale it disappeared at thumbnail
 * size. Both complaints — 「有點可怕」 and 「這 2 張圖我認為不行」 — came from the
 * same place: one set of lighting rules applied to two different jobs.
 *
 * A SUBJECT is a picture of something, looked at directly, often small. It needs
 * solid fills and a clear silhouette. A GROUND sits under type and needs to get
 * out of the way. The style names which one it is, because a flat vector
 * illustration is never a background and a colour field is never a subject.
 */
const SUBJECT_STYLES = new Set(['flat', 'handdrawn', 'isometric']);

/**
 * What a subject illustration needs that a background must not have.
 *
 * Saturated, solid, high contrast — the qualities that make the bundled
 * Storyset illustrations readable at 150 points wide. 「白底」 is stated
 * explicitly so the drawing has an edge: an illustration that fades into its
 * own background has no silhouette, and silhouette is the whole of what a small
 * picture communicates.
 */
const SUBJECT_TONE = 'solid saturated fills, clear bold shapes, strong silhouette, '
  + 'high contrast, clean white background, centred subject';

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
  const subjectText = String(req.subject || '').trim().slice(0, 300);

  // The medium is named before the look's register, because when the two
  // disagree — 「flat vector」 against 「editorial photography」 — the model follows
  // whichever came first, and the caller asking for a flat illustration meant it.
  const styleName = String(req.style || '').toLowerCase();
  const style = STYLE[styleName] || STYLE.abstract;

  /**
   * Ground or subject — decided by the style AND the slot.
   *
   * ── The gap this closes ──
   * The first split looked only at the style, so a PHOTOGRAPH dropped into a
   * `feature` panel still got the background treatment: airy palette, soft even
   * light, and a composition told to leave a corner empty for a headline that
   * was never going to be there. It came back pale for the same reason the
   * illustrations did — the rules written for something sitting under type were
   * applied to something meant to be looked at.
   *
   * A drawing is always a subject: nobody puts a flat vector illustration behind
   * a headline. Everything else is a subject unless it is filling a hero, which
   * is the one slot that genuinely is the ground.
   */
  const drawing = SUBJECT_STYLES.has(styleName);
  const ground = !drawing && mode === 'hero';
  const subject = !ground;
  const register = REGISTER[String(req.look || '').toLowerCase()] || REGISTER.business;
  const parts = [
    subjectText,
    style,
    // The register carries the look's mood, but not its medium: saying
    // 「editorial photography」 after 「flat vector illustration」 puts the two in a
    // fight the caller did not ask for.
    register.replace(/(editorial )?photograph(y|ic),?\s*/gi, ''),
    // The airy palette wording is background guidance too. A subject gets the
    // hues without the brightness push, or it comes back as a pastel ghost.
    subject
      ? (SUBJECT_PALETTE[String(req.theme || '').toLowerCase()] || SUBJECT_PALETTE.corporate)
      : (PALETTE[String(req.theme || '').toLowerCase()] || PALETTE.corporate),
    // A subject does not need a hole left in it for a headline; that instruction
    // pushes the drawing into one corner of its own frame.
    subject ? 'the subject fills the frame' : COMPOSITION[mode],
  ];
  /**
   * A drawing has no lighting, so lighting guidance bleaches it out. A
   * photograph does have lighting — it just needs the calm version without the
   * instruction to stay out of the way, because in a panel it IS the way.
   */
  parts.push(drawing ? SUBJECT_TONE : MOOD_FLOOR);
  if (subject && !drawing) parts.push('the subject clearly readable, good contrast');
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

/**
 * How many denoising steps this picture needs.
 *
 * ── Why one number was wrong ──
 * 10 steps was chosen against an abstract background and it is right for one:
 * a soft colour field is most of the way there after a few steps, and the rest
 * is detail nobody looks at. A flat illustration is the opposite — its whole
 * content is clean edges and closed shapes, and at 10 steps those are still
 * forming. 「太模糊和生成蠻不完整」 is what an under-stepped drawing looks like.
 *
 * The cost is real and worth stating: 22 steps is roughly 45 seconds against
 * 20 for a background. That is the price of a drawing that is finished.
 */
export function stepsFor(style: string, quality?: boolean, mode?: string): number {
  if (quality === true) return 28;
  if (SUBJECT_STYLES.has(String(style || '').toLowerCase())) return 22;
  // A photograph in a panel is looked at closely too — 10 steps is soft there
  // in a way it never is behind a scrim.
  return String(mode || '').toLowerCase() === 'hero' ? 10 : 16;
}

export const PALETTE_NAMES = Object.keys(PALETTE);
export const REGISTER_NAMES = Object.keys(REGISTER);
