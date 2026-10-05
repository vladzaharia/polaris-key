/**
 * Derive, compose and fit (A-18d; notes/S-15 §7.4, §5.6): every listing output as pixels, from the
 * masters, with no I/O. `listingAssets.ts` decodes the inputs, calls these, and encodes, writes,
 * packs and uploads the results.
 *
 *   - **Derive**: every store icon is the icon master resampled. Android's adaptive layers are
 *     derived only when the master's mark sits inside the central 66 of 108 dp (~61 %), over a
 *     transparent or one-colour background; otherwise they are the operator's to draw (`human`).
 *   - **Compose**: crop the key art to the slot's ratio around the operator's focal point, scale,
 *     and on a `title` slot place the wordmark in the slot's box. A `none` slot never gets text.
 *     No key art: an icon-only fallback, marked red. A `title` slot without a wordmark: key art
 *     only, marked red.
 *   - **Fit**: each screenshot against each store's rule; one that does not fit gets a crop or pad
 *     proposal, applied only when the operator accepts that image. Never silent.
 */

import {
  blur,
  boundingBox,
  colorDistance,
  composite,
  containSize,
  coverRect,
  crop,
  fill,
  flatten,
  hasTransparency,
  makeRaster,
  pixelAt,
  resize,
  type Raster,
  type Rect,
  type Rgb,
  type Rgba,
} from "./raster.js";
import {
  ADAPTIVE_CANVAS_DP,
  ADAPTIVE_MARGIN_DP,
  ADAPTIVE_SIZE,
  MAX_STORE_SCREENSHOTS,
  SCREENSHOT_RULES,
  SLOT_SPECS,
  type ComposeSpec,
  type FitProposal,
  type MasterSlot,
  type ScreenshotClass,
  type ScreenshotStore,
  type SlotSpec,
} from "./specs.js";

/**
 * `ok` (green), `warn` (amber: usable, look at the note), `red` (a fallback or a missing layer:
 * the store needs better input), `human` (the operator makes it), `missing` (nothing to make it
 * from).
 */
export type SlotStatus = "ok" | "warn" | "red" | "human" | "missing";

export interface Masters {
  "icon-master"?: Raster;
  "key-art"?: Raster;
  "key-art-portrait"?: Raster;
  wordmark?: Raster;
}

export interface Focal {
  x: number;
  y: number;
}

export interface DeriveOptions {
  /** Where the key art's subject is (fractions, 0..1): crops centre on it. */
  focal: Focal;
  /** The same for the portrait key art. */
  focalPortrait: Focal;
  /** The colour behind transparent art, fallbacks and the adaptive background layer. */
  background: Rgb;
}

export interface SlotOutput {
  spec: SlotSpec;
  status: SlotStatus;
  /** The pixels to encode (opaque when the spec has no alpha). Absent for `human`/`missing`. */
  raster?: Raster;
  derivedFrom: MasterSlot | null;
  notes: string[];
}

/** The default background: an opaque master's corner colour, else black. */
export function defaultBackground(icon: Raster | undefined): Rgb {
  if (icon) {
    const c = pixelAt(icon, 0, 0);
    if (c[3] === 255) return [c[0], c[1], c[2]];
  }
  return [0, 0, 0];
}

/** Parse `#rrggbb`. */
export function parseColor(value: string): Rgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) throw new Error(`${value} is not a colour like #1a2b3c.`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Parse a focal point `x,y` (fractions 0..1, e.g. `0.5,0.35`). */
export function parseFocal(value: string): Focal {
  const m = /^\s*([01](?:\.\d+)?|\.\d+)\s*,\s*([01](?:\.\d+)?|\.\d+)\s*$/.exec(
    value,
  );
  const x = m ? Number(m[1]) : NaN;
  const y = m ? Number(m[2]) : NaN;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1))
    throw new Error(
      `${value} is not a focal point: give x,y as fractions from 0 to 1, e.g. 0.5,0.4.`,
    );
  return { x, y };
}

// ── Icons ──────────────────────────────────────────────────────────────────────────────────────

/** The icon master's adaptive-icon analysis. */
export interface AdaptiveAnalysis {
  derivable: boolean;
  reason?: string;
  /** Transparent background, or the one opaque colour around the mark. */
  background: { transparent: true } | { transparent: false; color: Rgba };
  mark: Rect | null;
}

export function analyseAdaptive(icon: Raster): AdaptiveAnalysis {
  const n = icon.width;
  const corners = [
    pixelAt(icon, 0, 0),
    pixelAt(icon, n - 1, 0),
    pixelAt(icon, 0, n - 1),
    pixelAt(icon, n - 1, n - 1),
  ];
  let background: AdaptiveAnalysis["background"];
  let mark: Rect | null;
  if (corners.every((c) => c[3] === 0)) {
    background = { transparent: true };
    mark = boundingBox(icon, (d, i) => d[i + 3]! > 16);
  } else if (
    corners.every(
      (c) =>
        c[3] === 255 && colorDistance(Uint8Array.from(c), 0, corners[0]!) <= 8,
    )
  ) {
    const color = corners[0]!;
    background = { transparent: false, color };
    mark = boundingBox(icon, (d, i) => colorDistance(d, i, color) > 24);
  } else {
    return {
      derivable: false,
      reason: "the master's background is neither transparent nor one colour",
      background: { transparent: true },
      mark: null,
    };
  }
  if (!mark)
    return {
      derivable: false,
      reason: "the master has no visible mark",
      background,
      mark,
    };
  const margin = Math.ceil((n * ADAPTIVE_MARGIN_DP) / ADAPTIVE_CANVAS_DP);
  const inside =
    mark.x >= margin &&
    mark.y >= margin &&
    mark.x + mark.width <= n - margin &&
    mark.y + mark.height <= n - margin;
  return inside
    ? { derivable: true, background, mark }
    : {
        derivable: false,
        reason: `the mark (${mark.width}x${mark.height} at ${mark.x},${mark.y}) reaches outside the central 66 of 108 dp (~61 %); draw the adaptive layers by hand`,
        background,
        mark,
      };
}

/** The mark alone on transparency: an opaque master keyed against its background colour. */
function keyed(icon: Raster, a: AdaptiveAnalysis): Raster {
  if (a.background.transparent) return icon;
  const color = a.background.color;
  const out = makeRaster(icon.width, icon.height);
  const s = icon.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const dist = Math.max(
      Math.abs(s[i]! - color[0]),
      Math.abs(s[i + 1]! - color[1]),
      Math.abs(s[i + 2]! - color[2]),
    );
    d[i] = s[i]!;
    d[i + 1] = s[i + 1]!;
    d[i + 2] = s[i + 2]!;
    d[i + 3] = Math.min(255, Math.max(0, Math.floor(((dist - 8) * 255) / 40)));
  }
  return out;
}

function adaptiveLayers(
  icon: Raster,
  a: AdaptiveAnalysis,
  background: Rgb,
): Record<"fg" | "bg" | "mono", Raster> {
  const fg = resize(keyed(icon, a), ADAPTIVE_SIZE, ADAPTIVE_SIZE);
  const bgColor: Rgb = a.background.transparent
    ? background
    : [a.background.color[0], a.background.color[1], a.background.color[2]];
  const bg = fill(ADAPTIVE_SIZE, ADAPTIVE_SIZE, [...bgColor, 255]);
  const mono = makeRaster(ADAPTIVE_SIZE, ADAPTIVE_SIZE);
  for (let i = 0; i < mono.data.length; i += 4) {
    mono.data[i] = mono.data[i + 1] = mono.data[i + 2] = 255;
    mono.data[i + 3] = fg.data[i + 3]!;
  }
  return { fg, bg, mono };
}

// ── Composition ────────────────────────────────────────────────────────────────────────────────

/** The wordmark trimmed to its visible pixels. */
function trimmed(wordmark: Raster): Raster {
  const box = boundingBox(wordmark, (d, i) => d[i + 3]! > 0);
  return box ? crop(wordmark, box) : wordmark;
}

/** Place the wordmark in the slot's box: fit inside it, centred on (cx, cy), kept on the canvas. */
function placeWordmark(
  canvas: Raster,
  wordmark: Raster,
  spec: ComposeSpec,
): string[] {
  const layout = spec.layout!;
  const mark = trimmed(wordmark);
  const boxW = Math.max(1, Math.round(canvas.width * layout.boxW));
  const boxH = Math.max(1, Math.round(canvas.height * layout.boxH));
  const size = containSize(mark.width, mark.height, boxW, boxH);
  const notes: string[] = [];
  if (size.width > mark.width)
    notes.push(
      `the wordmark is upscaled from ${mark.width}x${mark.height} to ${size.width}x${size.height}`,
    );
  const scaled = resize(mark, size.width, size.height);
  const x = Math.min(
    canvas.width - size.width,
    Math.max(0, Math.round(canvas.width * layout.cx - size.width / 2)),
  );
  const y = Math.min(
    canvas.height - size.height,
    Math.max(0, Math.round(canvas.height * layout.cy - size.height / 2)),
  );
  composite(canvas, scaled, x, y);
  return notes;
}

function composeSlot(
  spec: ComposeSpec,
  masters: Masters,
  opts: DeriveOptions,
): SlotOutput {
  const portraitArt = spec.portrait ? masters["key-art-portrait"] : undefined;
  const source = portraitArt ?? masters["key-art"];
  const sourceSlot: MasterSlot = portraitArt ? "key-art-portrait" : "key-art";
  const notes: string[] = [];
  const bg: Rgba = [...opts.background, 255];

  if (!source) {
    const icon = masters["icon-master"];
    const [w, h] = spec.sizes[spec.sizes.length - 1]!;
    if (!icon)
      return {
        spec,
        status: "missing",
        derivedFrom: null,
        notes: ["no key art and no icon master to make it from"],
      };
    const canvas = fill(w, h, bg);
    const side = Math.max(1, Math.round(Math.min(w, h) * 0.6));
    const scaled = resize(icon, side, side);
    composite(
      canvas,
      scaled,
      Math.round((w - side) / 2),
      Math.round((h - side) / 2),
    );
    return {
      spec,
      status: "red",
      raster: canvas,
      derivedFrom: "icon-master",
      notes: ["no key art: an icon-only fallback; this store needs key art"],
    };
  }

  if (spec.portrait && !portraitArt)
    notes.push("no portrait key art: cropped from the landscape key art");
  const focal = portraitArt ? opts.focalPortrait : opts.focal;
  let chosen = spec.sizes[spec.sizes.length - 1]!;
  let rect = coverRect(
    source.width,
    source.height,
    chosen[0],
    chosen[1],
    focal,
  );
  for (const size of spec.sizes) {
    const r = coverRect(source.width, source.height, size[0], size[1], focal);
    if (r.width >= size[0] && r.height >= size[1]) {
      chosen = size;
      rect = r;
      break;
    }
  }
  const [w, h] = chosen;
  let status: SlotStatus = "ok";
  if (rect.width < w || rect.height < h) {
    status = "warn";
    notes.push(
      `the key art covers only ${rect.width}x${rect.height} at this ratio: upscaled to ${w}x${h}; supply larger key art`,
    );
  }
  let canvas = resize(crop(source, rect), w, h);
  if (spec.blur) canvas = blur(canvas, Math.max(2, Math.round(w / 96)));
  if (hasTransparency(canvas)) canvas = flatten(canvas, opts.background);
  if (spec.layout) {
    if (masters.wordmark)
      notes.push(...placeWordmark(canvas, masters.wordmark, spec));
    else {
      status = "red";
      notes.push(
        "a title slot without a wordmark: key art only; add the wordmark",
      );
    }
  }
  return { spec, status, raster: canvas, derivedFrom: sourceSlot, notes };
}

/** Every derived and composed slot, in `SLOT_SPECS` order. */
export function deriveAll(masters: Masters, opts: DeriveOptions): SlotOutput[] {
  const icon = masters["icon-master"];
  const adaptive = icon ? analyseAdaptive(icon) : null;
  const layers =
    icon && adaptive?.derivable
      ? adaptiveLayers(icon, adaptive, opts.background)
      : null;
  const out: SlotOutput[] = [];
  for (const spec of SLOT_SPECS) {
    switch (spec.kind) {
      case "icon": {
        if (!icon) {
          out.push({
            spec,
            status: "missing",
            derivedFrom: null,
            notes: ["no icon master"],
          });
          break;
        }
        const notes: string[] = [];
        let status: SlotStatus = "ok";
        if (icon.width < spec.size) {
          status = "warn";
          notes.push(
            `upscaled from the ${icon.width}x${icon.height} master; supply a 1024x1024 master`,
          );
        }
        let raster = resize(icon, spec.size, spec.size);
        if (!spec.alpha) raster = flatten(raster, opts.background);
        out.push({ spec, status, raster, derivedFrom: "icon-master", notes });
        break;
      }
      case "adaptive": {
        if (!icon) {
          out.push({
            spec,
            status: "missing",
            derivedFrom: null,
            notes: ["no icon master"],
          });
          break;
        }
        if (!layers) {
          out.push({
            spec,
            status: "human",
            derivedFrom: null,
            notes: [adaptive?.reason ?? "not derivable"],
          });
          break;
        }
        out.push({
          spec,
          status: "ok",
          raster: layers[spec.layer],
          derivedFrom: "icon-master",
          notes: [],
        });
        break;
      }
      case "compose":
        out.push(composeSlot(spec, masters, opts));
        break;
      case "logo": {
        const wordmark = masters.wordmark;
        if (!wordmark) {
          out.push({
            spec,
            status: "missing",
            derivedFrom: null,
            notes: ["no wordmark: Steam's library logo is the wordmark export"],
          });
          break;
        }
        const mark = trimmed(wordmark);
        const size = containSize(
          mark.width,
          mark.height,
          spec.box[0],
          spec.box[1],
        );
        const notes: string[] = [];
        let status: SlotStatus = "ok";
        if (size.width > mark.width) {
          status = "warn";
          notes.push(
            `upscaled from ${mark.width}x${mark.height}; supply a larger wordmark`,
          );
        }
        out.push({
          spec,
          status,
          raster: resize(mark, size.width, size.height),
          derivedFrom: "wordmark",
          notes,
        });
        break;
      }
    }
  }
  return out;
}

// ── Screenshots ────────────────────────────────────────────────────────────────────────────────

export interface ScreenshotInput {
  cls: ScreenshotClass;
  /** The file name without its extension: the image's id part. */
  name: string;
  raster: Raster;
}

/** How the operator accepted one image's proposal. */
export type Acceptance = "accept" | "pad";

export type ScreenshotStatus = "fits" | "accepted" | "pending" | "red";

export interface ScreenshotOutput {
  /** `<store>/<class>/<name>`: what `--accept` and `--pad` name. */
  id: string;
  store: ScreenshotStore;
  cls: ScreenshotClass;
  name: string;
  /** The position in the store's set for the class, from 1 (the slot's number). */
  index: number;
  slot: string;
  status: ScreenshotStatus;
  method: "as-is" | "crop" | "pad" | null;
  source: { width: number; height: number };
  proposal?: FitProposal;
  problems: string[];
  notes: string[];
  /** The output (`fits`, `accepted`), or the preview of the default proposal (`pending`). */
  raster?: Raster;
}

function applyPad(
  src: Raster,
  size: { width: number; height: number },
  bg: Rgb,
): Raster {
  const canvas = fill(size.width, size.height, [...bg, 255]);
  return composite(
    canvas,
    src,
    Math.floor((size.width - src.width) / 2),
    Math.floor((size.height - src.height) / 2),
  );
}

/**
 * Every screenshot fitted for every store whose rule covers its class. `accepted` maps an id to
 * the operator's choice; an id it names that no proposal has is reported in `unused`.
 */
export function fitScreenshots(
  inputs: readonly ScreenshotInput[],
  accepted: ReadonlyMap<string, Acceptance>,
  background: Rgb,
): { outputs: ScreenshotOutput[]; unused: string[] } {
  const used = new Set<string>();
  const outputs: ScreenshotOutput[] = [];
  for (const rule of SCREENSHOT_RULES) {
    for (const cls of rule.classes) {
      const shots = inputs
        .filter((s) => s.cls === cls)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (shots.length > MAX_STORE_SCREENSHOTS)
        throw new Error(
          `${shots.length} ${cls} screenshots: a store slot holds at most ${MAX_STORE_SCREENSHOTS}.`,
        );
      shots.forEach((shot, i) => {
        const id = `${rule.store}/${cls}/${shot.name}`;
        const index = i + 1;
        const base = {
          id,
          store: rule.store,
          cls,
          name: shot.name,
          index,
          slot: `${rule.store}:screenshot:${cls}:${index}`,
          source: { width: shot.raster.width, height: shot.raster.height },
        };
        const fit = rule.check(cls, shot.raster.width, shot.raster.height);
        const notes = [...fit.notes];
        const opaque = (r: Raster) => {
          if (!hasTransparency(r)) return r;
          notes.push(
            "transparent pixels flattened: stores take opaque screenshots",
          );
          return flatten(r, background);
        };
        if (fit.fits) {
          outputs.push({
            ...base,
            status: "fits",
            method: "as-is",
            problems: [],
            notes,
            raster: opaque(shot.raster),
          });
          return;
        }
        if (!fit.proposal) {
          outputs.push({
            ...base,
            status: "red",
            method: null,
            problems: fit.problems,
            notes,
          });
          return;
        }
        const proposal = fit.proposal;
        const choice = accepted.get(id);
        if (choice) used.add(id);
        const method: "crop" | "pad" =
          choice === "pad" ? "pad" : proposal.crop ? "crop" : "pad";
        if (choice === "pad" && !proposal.pad)
          throw new Error(
            `--pad ${id}: no pad fits ${rule.store}; accept the crop instead.`,
          );
        const raster = opaque(
          method === "crop"
            ? crop(shot.raster, proposal.crop!)
            : applyPad(shot.raster, proposal.pad!, background),
        );
        // The applied proposal must pass the rule: a proposal that does not is a bug.
        const after = rule.check(cls, raster.width, raster.height);
        if (!after.fits)
          throw new Error(
            `internal: the ${method} proposed for ${id} does not fit ${rule.store}`,
          );
        outputs.push({
          ...base,
          status: choice ? "accepted" : "pending",
          method,
          proposal,
          problems: fit.problems,
          notes,
          raster,
        });
      });
    }
  }
  return {
    outputs,
    unused: [...accepted.keys()].filter((id) => !used.has(id)),
  };
}
