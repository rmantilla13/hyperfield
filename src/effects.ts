/**
 * Effects: one-click LTX-2.5 LoRA effects, a grid of named looks on open
 * weights. Shared by the page, the server (which takes the LoRA file and
 * strength from here, never from the request) and the MCP server.
 *
 * Two kinds:
 *   clip  — an in-context (IC) LoRA re-renders a source clip frame-locked
 *           (matte, water, night, clean plate). Single stage at full res.
 *   still — a plain LoRA on image-to-video: a still is the first frame and the
 *           LoRA carries the motion (pop, inflate, cake...).
 *
 * Prompt templates follow each LoRA's model card; `{text}` is what the user
 * types. Read by three tsconfigs, so its one import (the render tiers, which
 * import nothing) carries a .js extension.
 */
import { appTier, tierSizeOf, type RenderTier } from './renderTier.js';

export type EffectInput = 'clip' | 'still';

export interface EffectDef {
  id: string;
  name: string;
  blurb: string;
  input: EffectInput;
  /** LoRA filename ComfyUI sees in models/loras. */
  lora: string;
  strength: number;
  /** IC-LoRA (needs LTXICLoRALoaderModelOnly + a reference clip). */
  ic: boolean;
  /** Literal trigger the LoRA was trained on. The template already contains it. */
  trigger?: string;
  /** Full prompt, `{text}` = the user's words. Empty string = no prompt (Cutout). */
  template: string;
  /** What the text box asks for, its default and placeholder. Absent = no text box. */
  field?: { label: string; default: string; placeholder: string };
  negative?: string;
  /** Model manifest bundle in server/models.ts. */
  bundle: 'effects' | 'effects-community';
  /** Longest clip this LoRA handles (Cutout leaks colour into the matte past 145 frames). */
  maxSeconds: number;
  /** Offer "loop" (start frame = end frame). */
  loopable?: boolean;
  credit: { author: string; repo: string; license: string };
}

const LTX = 'LTX-2.x Community License';
const LTX2 = 'LTX-2 Community License';
const CLEAN_NEG = 'person, people, human, figure, limb, arm, hand, leg, body part, backpack, shadow of a person, leftover people, leftover figures, ghosting, semi-transparent remnants, blurry, soft, distorted, inconsistent motion, jitter, worst quality, cartoon, video game, ugly';

export const EFFECTS: EffectDef[] = [
  // ---- clip in, clip out (IC-LoRA, frame-locked to the source) ----
  {
    id: 'cutout', name: 'Cutout', input: 'clip', ic: true,
    blurb: 'Pull a clean alpha matte from any clip. Hair, smoke and glass included, no green screen.',
    lora: 'ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors', strength: 1.0,
    template: '', bundle: 'effects', maxSeconds: 6,
    credit: { author: 'Lightricks', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Alpha-Gen', license: LTX },
  },
  {
    id: 'flood', name: 'Flood', input: 'clip', ic: true, trigger: 'ADD WATER',
    blurb: 'Add water to a shot: rivers, surf, rain, floods. The people and the camera move stay as filmed.',
    lora: 'ltx-2.5-22b-ic-lora-water-simulation-0.9.safetensors', strength: 1.0,
    template: 'Reference shows the scene from the source clip. Edited shows the same scene with water added. ADD WATER {text}. Subject identity, clothing, framing, and background geometry are identical to the reference; only water-related elements differ between reference and edited.',
    field: { label: 'The water', default: 'knee-deep murky flood water covering the whole ground, surging around everything that moves and splashing white spray', placeholder: 'a fast clear river with white foam rushing around their legs and over the rocks' },
    bundle: 'effects', maxSeconds: 7,
    credit: { author: 'Lightricks', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Water-Simulation', license: LTX },
  },
  {
    id: 'nightfall', name: 'Nightfall', input: 'clip', ic: true,
    blurb: 'Turn a day shot into night. Same framing, same motion, new light.',
    lora: 'ltx-2.5-22b-ic-lora-day-to-night-0.9.safetensors', strength: 1.0,
    template: 'A realistic nighttime scene. {text} Only the lighting changes from day to night; identical composition, framing, camera movement and motion.',
    field: { label: 'The night', default: 'Photorealistic moonlight, deep natural shadows, warm practical lights glowing in the windows.', placeholder: 'Cold blue moonlight, streetlamps pooling on wet asphalt.' },
    negative: 'daytime, bright sunlight, blue sky, overexposed, worst quality, inconsistent motion, blurry, jittery, distorted',
    bundle: 'effects', maxSeconds: 6,
    credit: { author: 'Lightricks', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Day-To-Night', license: LTX },
  },
  {
    id: 'empty', name: 'Empty the scene', input: 'clip', ic: true,
    blurb: 'Remove the people and cars from a clip and keep the place.',
    lora: 'ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors', strength: 1.0,
    template: 'An empty clean plate of the exact same location: {text} Identical background, environment, structures and lighting as the source video, with no people, no humans, no figures, and no body parts such as arms, hands or legs anywhere in the frame. Static photorealistic footage, natural light, high detail.',
    field: { label: 'The empty place', default: '', placeholder: 'a quiet street with parked bicycles and shop fronts.' },
    negative: CLEAN_NEG,
    bundle: 'effects', maxSeconds: 6,
    credit: { author: 'Lightricks', repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Clean-Plate', license: LTX },
  },

  // ---- still in, clip out (plain LoRA on image-to-video) ----
  {
    id: 'living-photo', name: 'Living photo', input: 'still', ic: false, trigger: 'CINEMAGRAPH_MOTION', loopable: true,
    blurb: 'A cinemagraph: the frame holds still and one thing moves. Loops by default.',
    lora: 'ltx-2.5-22b-lora-cinemagraph-0.9.safetensors', strength: 1.1,
    template: 'CINEMAGRAPH_MOTION, tripod locked-off static camera, zero camera movement, everything in the frame stays completely frozen, only {text}, everything else stays perfectly still, seamless natural loop.',
    field: { label: 'What moves', default: 'the clouds drift slowly across the sky', placeholder: 'the steam rises from the coffee cup' },
    negative: 'camera movement, pan, tilt, zoom, parallax, whole image moving, background sliding, person moving, flicker on entire image, noisy texture, crawling texture, distorted, blurry, low quality',
    bundle: 'effects', maxSeconds: 8,
    credit: { author: 'Lightricks', repo: 'Lightricks/LTX-2.5-22b-LoRA-Cinemagraph', license: LTX },
  },
  {
    id: 'pop', name: 'Pop', input: 'still', ic: false, trigger: 'POP!',
    blurb: 'The subject swells up and bursts into confetti.',
    lora: 'ltx23-pop.safetensors', strength: 1.0,
    template: 'POP! {text} inflates and explodes into a shower of confetti-like scraps, leaving the surroundings covered in colorful remnants. There is nothing left of the popped body, the camera shows now empty background.',
    field: { label: 'Who pops', default: 'The person in the photo', placeholder: 'The man in the yellow raincoat' },
    bundle: 'effects-community', maxSeconds: 5,
    credit: { author: 'kabachuha', repo: 'kabachuha/ltx23-pop', license: LTX2 },
  },
  {
    id: 'inflate', name: 'Inflate', input: 'still', ic: false, trigger: 'infl4t3',
    blurb: 'Blow the subject up into a giant balloon.',
    lora: 'ltx2-inflate.safetensors', strength: 1.0,
    template: 'The video shows {text}. Then infl4t3 inflates it, {text} expanding into a giant, inflated balloon against the landscape.',
    field: { label: 'What inflates', default: 'the main subject', placeholder: 'a red vintage car' },
    bundle: 'effects-community', maxSeconds: 5,
    credit: { author: 'kabachuha', repo: 'kabachuha/ltx2-inflate-it', license: LTX2 },
  },
  {
    id: 'cake', name: 'Cake', input: 'still', ic: false, trigger: 'c4k3 cakeify',
    blurb: 'A knife slices in and it was cake all along.',
    lora: 'ltx2-cakeify-v2.safetensors', strength: 1.0,
    template: 'The video opens on {text}. A knife, held by a hand, is coming into frame and hovering over it. The knife then begins cutting into it to c4k3 cakeify it. As the knife slices it open, the inside is revealed to be cake with chocolate layers. The knife cuts through and the contents of the cake are revealed.',
    field: { label: 'What gets cut', default: 'the main object', placeholder: 'a leather handbag on a table' },
    bundle: 'effects-community', maxSeconds: 5,
    credit: { author: 'kabachuha', repo: 'kabachuha/ltx2-cakeify', license: LTX2 },
  },
  {
    id: 'squish', name: 'Squish', input: 'still', ic: false, trigger: 'handsquish',
    blurb: 'A giant hand reaches in and squeezes it like a stress toy.',
    lora: 'ltx2-handsquish.safetensors', strength: 1.0,
    template: 'In the video, {text} is presented. A person\'s gigantic long right arm appears from the right, stretches all the way and grabs it. It is held in the person\'s gigantic right hand. The person then presses on it, causing a handsquish effect, squeezing it between the fingers.',
    field: { label: 'What gets squished', default: 'the main subject', placeholder: 'a miniature toy house' },
    bundle: 'effects-community', maxSeconds: 5,
    credit: { author: 'kabachuha', repo: 'kabachuha/ltx2-squish-one-hand', license: LTX2 },
  },
  {
    id: 'unzip', name: 'Unzip', input: 'still', ic: false, trigger: 'Disguise drop.',
    blurb: 'The subject unzips like a costume and someone else steps out.',
    lora: 'ltx2-disguise-drop.safetensors', strength: 1.0,
    template: 'Disguise drop. The subject touches the top of their head with their hand and then fully unzips their outer skin in two halves, slowly pulling the zip down from the top of the head to the waist, to reveal {text} inside. The empty costume falls away.',
    field: { label: 'Who is inside', default: 'a different person in a blue sweater', placeholder: 'an old woman in a red coat' },
    bundle: 'effects-community', maxSeconds: 5,
    credit: { author: 'kabachuha', repo: 'kabachuha/ltx2-disguise-drop', license: LTX2 },
  },
  {
    id: 'gulp', name: 'Gulp', input: 'still', ic: false,
    blurb: 'A giant cartoon hand scoops it up and something swallows it whole.',
    lora: 'ltx2-eat-v2.safetensors', strength: 1.0,
    template: 'Vivid colors. The video begins with {text}. Then a gigantic cartoon hand seizes it from below and tosses it into a gigantic mouth, which appears to the right. The camera zooms out, showing the giant chewing and fully swallowing it.',
    field: { label: 'What gets eaten', default: 'the main subject', placeholder: 'a realistic elephant in a room' },
    bundle: 'effects-community', maxSeconds: 5,
    credit: { author: 'kabachuha', repo: 'kabachuha/ltx2-eat', license: LTX2 },
  },
];

export const effectById = (id: string | null | undefined): EffectDef | undefined => EFFECTS.find((e) => e.id === id);

/** The prompt an effect sends, from the user's words (empty words fall back to the default). */
export function effectPrompt(e: EffectDef, text: string): string {
  if (!e.template) return '';
  const t = (text.trim() || e.field?.default || '').replace(/[.\s]+$/, '');
  return e.template.split('{text}').join(t).replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').trim();
}

/** Output size for an effect at a render tier (Effects stops at 720p): the input's aspect, 64-aligned
 *  (clip effects are IC-LoRA guides, still effects render in two stages). */
export function effectSize(_e: EffectDef, dims: { w: number; h: number } | undefined, tier: RenderTier): { w: number; h: number } {
  return tierSizeOf(appTier('effects', tier), dims?.w, dims?.h, 64);
}

/**
 * The MCP tool's older quality names, kept as aliases for the tiers:
 * draft = 480p (near the 768x448 the IC-LoRAs were trained at), high = 720p.
 */
export const EFFECT_QUALITY = [
  { id: 'draft', tier: '480p', label: 'Draft', note: 'Same as 480p. Fast.' },
  { id: 'high', tier: '720p', label: 'High', note: 'Same as 720p.' },
] as const satisfies readonly { id: string; tier: RenderTier; label: string; note: string }[];
export type EffectQuality = (typeof EFFECT_QUALITY)[number]['id'];
