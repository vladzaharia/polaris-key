/**
 * Every listing asset `pkey listing assets` makes, with the store's specification (A-18d;
 * notes/S-15 §7.4, §5.6). The slot names and text rules are the listing model's
 * (`packages/worker/src/core/storefront/listingModel.ts` `LISTING_ASSET_SLOTS`); a CLI test
 * keeps the two in step.
 */

export type TextAllowed = "none" | "title" | "free";
export type Format = "png" | "jpeg";
export type MasterSlot =
  | "icon-master"
  | "key-art"
  | "key-art-portrait"
  | "wordmark";

/** The stores that get a downloadable pack of their outputs (`pack:<store>`). */
export const PACK_STORES = [
  "play",
  "ms-store",
  "steam",
  "itch",
  "snap",
  "flathub",
  "winget",
  "fdroid",
] as const;
export type PackStore = (typeof PACK_STORES)[number];

/** The masters a person makes, with their text rules. */
export const MASTER_RULES: Readonly<Record<MasterSlot, TextAllowed>> = {
  "icon-master": "free",
  "key-art": "none",
  "key-art-portrait": "none",
  wordmark: "title",
};

/** Where the wordmark goes on a `title` slot: a box (fractions of the canvas) and its centre. */
export interface WordmarkLayout {
  boxW: number;
  boxH: number;
  cx: number;
  cy: number;
}

interface BaseSpec {
  slot: string;
  /** The pack it belongs to. */
  store: PackStore;
  /** Its file under `--out` (and inside the pack), without the extension. */
  name: string;
  format: Format;
  alpha: boolean;
  textAllowed: TextAllowed;
  /** The store's file-size cap, when it has one. */
  maxBytes?: number;
}

/** A square icon derived from the icon master. */
export interface IconSpec extends BaseSpec {
  kind: "icon";
  size: number;
}

/** One layer of Android's adaptive icon (432x432, the mark inside the central 66 of 108 dp). */
export interface AdaptiveSpec extends BaseSpec {
  kind: "adaptive";
  layer: "fg" | "bg" | "mono";
}

/** Store art composed from key art (plus the wordmark on a `title` slot). */
export interface ComposeSpec extends BaseSpec {
  kind: "compose";
  /** Allowed output sizes, largest first: the largest the source covers without upscaling wins. */
  sizes: ReadonlyArray<readonly [number, number]>;
  /** Portrait art prefers `key-art-portrait`, falling back to `key-art`. */
  portrait?: boolean;
  /** Steam's page background: blurred key art. */
  blur?: boolean;
  /** Required on a `title` slot. */
  layout?: WordmarkLayout;
}

/** The wordmark exported alone on transparency (Steam's library logo). */
export interface LogoSpec extends BaseSpec {
  kind: "logo";
  /** Fit inside this box: "1280 wide or 720 tall". */
  box: readonly [number, number];
}

export type SlotSpec = IconSpec | AdaptiveSpec | ComposeSpec | LogoSpec;

const MB = 1024 * 1024;

const icon = (
  slot: string,
  store: PackStore,
  name: string,
  size: number,
  format: Format = "png",
  extra: Partial<IconSpec> = {},
): IconSpec => ({
  kind: "icon",
  slot,
  store,
  name,
  size,
  format,
  alpha: format === "png",
  textAllowed: "free",
  ...extra,
});

const art = (
  slot: string,
  store: PackStore,
  name: string,
  sizes: ReadonlyArray<readonly [number, number]>,
  layout: WordmarkLayout | null,
  extra: Partial<ComposeSpec> = {},
): ComposeSpec => ({
  kind: "compose",
  slot,
  store,
  name,
  sizes,
  format: "png",
  alpha: false,
  textAllowed: layout ? "title" : "none",
  ...(layout ? { layout } : {}),
  ...extra,
});

/** Centred, `w` x `h` of the canvas. */
const centre = (boxW: number, boxH: number): WordmarkLayout => ({
  boxW,
  boxH,
  cx: 0.5,
  cy: 0.5,
});
/** In the top third: Microsoft's "title in the top two thirds", and portrait capsules. */
const upper = (boxW: number, boxH: number, cy: number): WordmarkLayout => ({
  boxW,
  boxH,
  cx: 0.5,
  cy,
});

/** Every derived and composed slot, in report order. */
export const SLOT_SPECS: readonly SlotSpec[] = [
  // ── Derived from the icon master ──
  icon("play:icon", "play", "icon", 512, "png", { maxBytes: 1 * MB }),
  icon("ms-store:tile", "ms-store", "tile", 300),
  icon("steam:community-icon", "steam", "community-icon", 184, "jpeg"),
  icon("steam:shortcut-icon", "steam", "shortcut-icon", 256),
  icon("flathub:icon", "flathub", "icon", 512),
  icon("snap:icon", "snap", "icon", 512),
  icon("winget:icon", "winget", "icon", 256),
  icon("fdroid:icon", "fdroid", "icon", 512),
  {
    kind: "adaptive",
    slot: "icon-adaptive-fg",
    store: "play",
    name: "adaptive-foreground",
    layer: "fg",
    format: "png",
    alpha: true,
    textAllowed: "free",
  },
  {
    kind: "adaptive",
    slot: "icon-adaptive-bg",
    store: "play",
    name: "adaptive-background",
    layer: "bg",
    format: "png",
    alpha: false,
    textAllowed: "none",
  },
  {
    kind: "adaptive",
    slot: "icon-adaptive-mono",
    store: "play",
    name: "adaptive-monochrome",
    layer: "mono",
    format: "png",
    alpha: true,
    textAllowed: "free",
  },
  // ── Composed from key art and the wordmark ──
  art(
    "play:feature-graphic",
    "play",
    "feature-graphic",
    [[1024, 500]],
    centre(0.7, 0.5),
    {
      maxBytes: 15 * MB,
    },
  ),
  art(
    "fdroid:feature-graphic",
    "fdroid",
    "feature-graphic",
    [[1024, 500]],
    centre(0.7, 0.5),
  ),
  art(
    "steam:header-capsule",
    "steam",
    "header-capsule",
    [[920, 430]],
    centre(0.75, 0.55),
  ),
  art(
    "steam:main-capsule",
    "steam",
    "main-capsule",
    [[1232, 706]],
    centre(0.6, 0.5),
  ),
  art(
    "steam:vertical-capsule",
    "steam",
    "vertical-capsule",
    [[748, 896]],
    upper(0.85, 0.3, 0.22),
    {
      portrait: true,
    },
  ),
  // "The logo should nearly fill the small capsule."
  art(
    "steam:small-capsule",
    "steam",
    "small-capsule",
    [[462, 174]],
    centre(0.92, 0.82),
  ),
  art(
    "steam:library-capsule",
    "steam",
    "library-capsule",
    [[600, 900]],
    upper(0.85, 0.3, 0.22),
    {
      portrait: true,
    },
  ),
  art(
    "steam:library-header",
    "steam",
    "library-header",
    [[920, 430]],
    centre(0.75, 0.55),
  ),
  // "No text": key art only. Steam overlays the logo inside the central 860x380 safe area.
  art("steam:library-hero", "steam", "library-hero", [[3840, 1240]], null),
  {
    kind: "logo",
    slot: "steam:library-logo",
    store: "steam",
    name: "library-logo",
    box: [1280, 720],
    format: "png",
    alpha: true,
    textAllowed: "title",
  },
  art(
    "steam:page-background",
    "steam",
    "page-background",
    [[1438, 810]],
    null,
    { blur: true },
  ),
  // "Must not include the product's title or other text."
  art(
    "ms-store:super-hero",
    "ms-store",
    "super-hero",
    [
      [3840, 2160],
      [1920, 1080],
    ],
    null,
  ),
  // Title required, in the top two thirds.
  art(
    "ms-store:poster",
    "ms-store",
    "poster",
    [
      [1440, 2160],
      [720, 1080],
    ],
    upper(0.85, 0.25, 0.25),
    { portrait: true },
  ),
  art(
    "ms-store:box-art",
    "ms-store",
    "box-art",
    [
      [2160, 2160],
      [1080, 1080],
    ],
    upper(0.8, 0.3, 0.3),
  ),
  art("itch:cover", "itch", "cover", [[630, 500]], centre(0.8, 0.4)),
  art("snap:banner", "snap", "banner", [[1920, 640]], centre(0.6, 0.6)),
];

/** Android's adaptive canvas: 108 dp at 4x. */
export const ADAPTIVE_SIZE = 432;
/** The mark must sit inside the central 66 of 108 dp (~61 %): a margin of 21 dp on each side. */
export const ADAPTIVE_MARGIN_DP = 21;
export const ADAPTIVE_CANVAS_DP = 108;

// ── Screenshots (S-15 §5.6, §7.4) ──────────────────────────────────────────────────────────────

export const SCREENSHOT_CLASSES = [
  "phone-portrait",
  "tablet",
  "desktop-16x9",
  "desktop-16x10",
  "tv",
  "wear",
  "xr",
] as const;
export type ScreenshotClass = (typeof SCREENSHOT_CLASSES)[number];

export const SCREENSHOT_STORES = [
  "app-store",
  "play",
  "ms-store",
  "steam",
] as const;
export type ScreenshotStore = (typeof SCREENSHOT_STORES)[number];

/** The most screenshots one store slot holds per class (the model's numbered slots). */
export const MAX_STORE_SCREENSHOTS = 16;

/** What a store does with a screenshot that does not fit: crop it, or pad it, to `width` x `height`. */
export interface FitProposal {
  /** The centred crop that fits (`--accept`), when one does. A crop can cut UI: never silent. */
  crop?: { x: number; y: number; width: number; height: number };
  /** The canvas a pad (`--pad`, or `--accept` when no crop fits) letterboxes the image into. */
  pad?: { width: number; height: number };
}

export interface FitResult {
  fits: boolean;
  /** Why it does not fit, or what to watch (an amber note never blocks). */
  problems: string[];
  notes: string[];
  /** Absent when no crop or pad can make it fit (it is then red). */
  proposal?: FitProposal;
}

export interface ScreenshotRule {
  store: ScreenshotStore;
  classes: readonly ScreenshotClass[];
  check(cls: ScreenshotClass, width: number, height: number): FitResult;
}

const APPLE_SIZES: Readonly<
  Partial<Record<ScreenshotClass, ReadonlyArray<readonly [number, number]>>>
> = {
  // iPhone 6.9", 6.7" and 6.5"-class display sizes, portrait.
  "phone-portrait": [
    [1320, 2868],
    [1290, 2796],
    [1260, 2736],
    [1284, 2778],
    [1242, 2688],
  ],
  // iPad 13" and 12.9".
  tablet: [
    [2064, 2752],
    [2048, 2732],
  ],
  // Mac, 16:10.
  "desktop-16x10": [
    [2880, 1800],
    [2560, 1600],
    [1440, 900],
    [1280, 800],
  ],
};

/** A centred crop of `w` x `h` to the ratio `rw:rh`. */
function centreCrop(w: number, h: number, rw: number, rh: number) {
  if (w * rh > h * rw) {
    const cw = Math.floor((h * rw) / rh);
    return { x: Math.floor((w - cw) / 2), y: 0, width: cw, height: h };
  }
  const ch = Math.floor((w * rh) / rw);
  return { x: 0, y: Math.floor((h - ch) / 2), width: w, height: ch };
}

/** The canvas that letterboxes `w` x `h` to the ratio `rw:rh`. */
function padTo(w: number, h: number, rw: number, rh: number) {
  if (w * rh > h * rw) return { width: w, height: Math.ceil((w * rh) / rw) };
  return { width: Math.ceil((h * rw) / rh), height: h };
}

export const SCREENSHOT_RULES: readonly ScreenshotRule[] = [
  {
    // Apple's own size classes, no alpha: the masters usually come from here, so a mismatch is
    // red, never cropped (a crop would not make another device size).
    store: "app-store",
    classes: ["phone-portrait", "tablet", "desktop-16x10"],
    check: (cls, width, height) => appleSizeCheck(cls, width, height),
  },
  {
    // Each side 320 to 3840 px, the long side at most twice the short one; at least 1080 px to
    // be eligible for featuring.
    store: "play",
    classes: ["phone-portrait", "tablet", "tv", "wear"],
    check(_cls, width, height) {
      const long = Math.max(width, height);
      const short = Math.min(width, height);
      const problems: string[] = [];
      const notes: string[] = [];
      if (short < 320) {
        problems.push(`a side of ${short} px is under Play's 320 px minimum`);
        return { fits: false, problems, notes };
      }
      if (long > 3840)
        problems.push(`a side of ${long} px is over Play's 3840 px maximum`);
      if (long > 2 * short)
        problems.push(
          `${width}x${height} is ${(long / short).toFixed(2)}:1, over Play's 2:1 ("can't be more than twice")`,
        );
      if (short < 1080)
        notes.push("under 1080 px: not eligible for Play's featuring");
      if (problems.length === 0) return { fits: true, problems, notes };
      if (long > 3840) return { fits: false, problems, notes };
      const portrait = height >= width;
      const crop = portrait
        ? centreCrop(width, height, 1, 2)
        : centreCrop(width, height, 2, 1);
      const pad = portrait
        ? padTo(width, height, 1, 2)
        : padTo(width, height, 2, 1);
      return { fits: false, problems, notes, proposal: { crop, pad } };
    },
  },
  {
    // At least 1366x768 (or 768x1366 portrait).
    store: "ms-store",
    classes: ["desktop-16x9", "desktop-16x10", "tablet", "tv"],
    check(_cls, width, height) {
      const ok =
        (width >= 1366 && height >= 768) || (width >= 768 && height >= 1366);
      return ok
        ? { fits: true, problems: [], notes: [] }
        : {
            fits: false,
            problems: [
              `${width}x${height} is under the Microsoft Store's 1366x768`,
            ],
            notes: [],
          };
    },
  },
  {
    // 16:9 at 1920x1080 or more; gameplay only (the operator's call).
    store: "steam",
    classes: ["desktop-16x9", "desktop-16x10", "tv"],
    check(_cls, width, height) {
      const problems: string[] = [];
      const notes = [
        "Steam wants gameplay: no menus, logos or text-only screens",
      ];
      const exact = width * 9 === height * 16;
      if (exact && width >= 1920) return { fits: true, problems, notes };
      problems.push(
        exact
          ? `${width}x${height} is under Steam's 1920x1080`
          : `${width}x${height} is not 16:9`,
      );
      if (exact) return { fits: false, problems, notes };
      const crop = centreCrop(width, height, 16, 9);
      const pad = padTo(width, height, 16, 9);
      const proposal: FitProposal = {
        ...(crop.width >= 1920 ? { crop } : {}),
        ...(pad.width >= 1920 ? { pad } : {}),
      };
      if (!proposal.crop && !proposal.pad) {
        problems.push(
          `${width}x${height} is under Steam's 1920x1080 even padded`,
        );
        return { fits: false, problems, notes };
      }
      return { fits: false, problems, notes, proposal };
    },
  },
];

/** Apple's size check, separate so its rule above stays a plain fits/does-not-fit. */
export function appleSizeCheck(
  cls: ScreenshotClass,
  width: number,
  height: number,
): FitResult {
  const sizes = APPLE_SIZES[cls] ?? [];
  const ok = sizes.some(
    ([w, h]) => (w === width && h === height) || (w === height && h === width),
  );
  return ok
    ? { fits: true, problems: [], notes: [] }
    : {
        fits: false,
        problems: [
          `${width}x${height} is not an App Store ${cls} size (${sizes.map(([w, h]) => `${w}x${h}`).join(", ")})`,
        ],
        notes: [],
      };
}
