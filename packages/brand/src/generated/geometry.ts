// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

import type { KitPalette } from "../marks/types.js";

/** kit/source/geometry.json: per mark and optical cut, [grid, [role, path][]]. */
export const GEOMETRY = {
  key: {
    display: [
      96,
      [
        [
          "body",
          "M14 15.6 L35.6 5 Q37 4.3 37 6 L37 76 L14 87 Q13 87.5 13 86 L13 18 Q13 16.3 14 15.6 Z",
        ],
        [
          "body",
          "M41 44 L57 44 Q58 44 59 45 L81 67 Q82 68 81 69 L68 82 Q67 83 66 82 L41 57 Q40 56 40 55 L40 45 Q40 44 41 44 Z",
        ],
        ["star", "M64 6 L70 18 L82 24 L70 30 L64 42 L58 30 L46 24 L58 18 Z"],
        ["gold", "M70 85 L84 71 L90 77 L76 91 Z"],
      ],
    ],
    service: [
      24,
      [
        ["body", "M3 4 L9 1 L9 19 L3 22 Z"],
        ["body", "M11 12 L15 12 L21 18 L18 21 L11 14 Z"],
        ["star", "M17 1 L19 4 L23 6 L19 8 L17 11 L15 8 L11 6 L15 4 Z"],
      ],
    ],
    favicon: [
      16,
      [
        ["body", "M2 3 L6 1 L6 13 L2 15 Z"],
        ["body", "M8 9 L10 9 L14 13 L11 15 L8 12 Z"],
        [
          "star",
          "M11.5 1 L13 3 L15.5 4.5 L13 6 L11.5 8 L10 6 L7.5 4.5 L10 3 Z",
        ],
      ],
    ],
  },
  update: {
    display: [
      96,
      [
        [
          "body",
          "M49 8 Q51 7 53 10 L59 20 Q60 21 58 22 L32 38 Q31 38.6 31 40 L31 57 L39 65 L27 76 L16 69 Q12 66 12 61 L12 37 Q12 32 16 29 Z",
        ],
        [
          "body",
          "M65 23 L80 32 Q84 34 84 39 L84 62 Q84 67 80 70 L47 89 Q44 91 42 87 L36 77 Q35 76 37 75 L64 59 Q65 58.4 65 57 L65 41 L56 33 Z",
        ],
        ["star", "M48 35 L53 44 L62 49 L53 54 L48 63 L43 54 L34 49 L43 44 Z"],
      ],
    ],
    service: [
      24,
      [
        ["body", "M12 2 L15 5 L7 10 L7 14 L10 16 L7 19 L3 16 L3 9 Z"],
        ["body", "M17 5 L21 8 L21 16 L12 22 L9 19 L17 14 L17 10 L14 8 Z"],
        [
          "star",
          "M12 8 L13.5 10.5 L16 12 L13.5 13.5 L12 16 L10.5 13.5 L8 12 L10.5 10.5 Z",
        ],
      ],
    ],
    favicon: [
      16,
      [
        ["body", "M7 1 L9 3 L4 6 L4 10 L6 11 L4 13 L1 11 L1 5 Z"],
        ["body", "M12 3 L15 5 L15 11 L9 15 L7 13 L12 10 L12 6 L10 5 Z"],
        ["star", "M8 5 L9 7 L11 8 L9 9 L8 11 L7 9 L5 8 L7 7 Z"],
      ],
    ],
  },
} as const;

/** The colour each role takes in each kit variant. */
export const KIT_PALETTES = {
  dark: {
    body: "#9a5cff",
    star: "#ffffff",
    gold: "#ffc24d",
    text: "#ffffff",
    muted: "#dbe4ff",
    bg: "#060912",
    stroke: "#9a5cff",
  },
  light: {
    body: "#7a2fff",
    star: "#7a2fff",
    gold: "#d07a00",
    text: "#060912",
    muted: "#48536b",
    bg: "#f6f8ff",
    stroke: "#7a2fff",
  },
  "mono-black": {
    body: "#060912",
    star: "#060912",
    gold: "#060912",
    text: "#060912",
    muted: "#060912",
    bg: "#f6f8ff",
    stroke: "#060912",
  },
  "mono-white": {
    body: "#ffffff",
    star: "#ffffff",
    gold: "#ffffff",
    text: "#ffffff",
    muted: "#ffffff",
    bg: "#060912",
    stroke: "#ffffff",
  },
  currentColor: {
    body: "currentColor",
    star: "currentColor",
    gold: "currentColor",
    text: "currentColor",
    muted: "currentColor",
    bg: "currentColor",
    stroke: "currentColor",
  },
} as const satisfies Record<string, KitPalette>;

/** kit/08-developer/polaris-sprite.svg, verbatim: currentColor symbols for both marks. */
export const SPRITE =
  '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="polaris-key-display" viewBox="0 0 96 96"><path fill="currentColor" d="M14 15.6 L35.6 5 Q37 4.3 37 6 L37 76 L14 87 Q13 87.5 13 86 L13 18 Q13 16.3 14 15.6 Z"/><path fill="currentColor" d="M41 44 L57 44 Q58 44 59 45 L81 67 Q82 68 81 69 L68 82 Q67 83 66 82 L41 57 Q40 56 40 55 L40 45 Q40 44 41 44 Z"/><path fill="currentColor" d="M64 6 L70 18 L82 24 L70 30 L64 42 L58 30 L46 24 L58 18 Z"/></symbol><symbol id="polaris-key-service" viewBox="0 0 24 24"><path fill="currentColor" d="M3 4 L9 1 L9 19 L3 22 Z"/><path fill="currentColor" d="M11 12 L15 12 L21 18 L18 21 L11 14 Z"/><path fill="currentColor" d="M17 1 L19 4 L23 6 L19 8 L17 11 L15 8 L11 6 L15 4 Z"/></symbol><symbol id="polaris-key-favicon" viewBox="0 0 16 16"><path fill="currentColor" d="M2 3 L6 1 L6 13 L2 15 Z"/><path fill="currentColor" d="M8 9 L10 9 L14 13 L11 15 L8 12 Z"/><path fill="currentColor" d="M11.5 1 L13 3 L15.5 4.5 L13 6 L11.5 8 L10 6 L7.5 4.5 L10 3 Z"/></symbol><symbol id="polaris-update-display" viewBox="0 0 96 96"><path fill="currentColor" d="M49 8 Q51 7 53 10 L59 20 Q60 21 58 22 L32 38 Q31 38.6 31 40 L31 57 L39 65 L27 76 L16 69 Q12 66 12 61 L12 37 Q12 32 16 29 Z"/><path fill="currentColor" d="M65 23 L80 32 Q84 34 84 39 L84 62 Q84 67 80 70 L47 89 Q44 91 42 87 L36 77 Q35 76 37 75 L64 59 Q65 58.4 65 57 L65 41 L56 33 Z"/><path fill="currentColor" d="M48 35 L53 44 L62 49 L53 54 L48 63 L43 54 L34 49 L43 44 Z"/></symbol><symbol id="polaris-update-service" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2 L15 5 L7 10 L7 14 L10 16 L7 19 L3 16 L3 9 Z"/><path fill="currentColor" d="M17 5 L21 8 L21 16 L12 22 L9 19 L17 14 L17 10 L14 8 Z"/><path fill="currentColor" d="M12 8 L13.5 10.5 L16 12 L13.5 13.5 L12 16 L10.5 13.5 L8 12 L10.5 10.5 Z"/></symbol><symbol id="polaris-update-favicon" viewBox="0 0 16 16"><path fill="currentColor" d="M7 1 L9 3 L4 6 L4 10 L6 11 L4 13 L1 11 L1 5 Z"/><path fill="currentColor" d="M12 3 L15 5 L15 11 L9 15 L7 13 L12 10 L12 6 L10 5 Z"/><path fill="currentColor" d="M8 5 L9 7 L11 8 L9 9 L8 11 L7 9 L5 8 L7 7 Z"/></symbol></svg>';
