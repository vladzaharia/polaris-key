// Per-board markings for the mockups (docs/design/ui-kits/*.html), kept here so the boards stay
// clean markup. Every selector carries its reason.
//
//   chrome: drawn around the kit, not by it (status bars, keyboards, window frames, the host app
//           the kit drops into, board captions). Not linted; its strings are not kit strings.
//   touch:  touch variants, where targets must be ≥ 44 px.
//   allow:  rule → selectors where that rule does not apply, each with its reason.
export interface BoardMarks {
  chrome?: string[];
  touch?: string[];
  allow?: Record<string, string[]>;
}

/** Board captions inside a shot (state labels under a row of mini shots). */
const CAPTIONS = ["span.lbl", ".fc-note"];
/** Phone and tablet chrome: status bar, camera, home indicator, OS keyboards. */
const PHONE = [
  ".status",
  ".island",
  ".home",
  ".cam",
  ".navh",
  ".kb",
  ".ime",
  ".scrollbar",
  ".vscroll",
];

export const CHROME: Record<string, BoardMarks> = {
  web: {
    chrome: [
      ...CAPTIONS,
      // The host app the kit is embedded in, with its own look (system font, flat neutrals).
      ".host > .bar",
      ".host > .side",
      ".host > .tracks",
      ".hostbar",
      ".hostcard",
      // The page footer belongs to the integrator's page, not the kit.
      ".pagefoot",
      // Annotation on the state, component, layers, theming and motion sheets: headings, state
      // labels, code samples, timing labels.
      "pre.src",
      ".sheetgrid h3",
      ".states > div > small",
      ".comps > section > h3",
      ".layers > div > h3",
      ".layers > div > p",
      ".themes > div > .cap",
      ".mrow > b",
      ".motion .frame > .t",
    ],
    touch: [".w390"],
    allow: {
      // The state sheet shows one control in every state side by side.
      "one-primary": [".sheetgrid"],
      // Embedded settings inherit the host's font (typography.family "inherit", §3.1): the host's
      // family is the theme's there.
      // Layer (b) composes the host's own elements (its account header) with kit primitives.
      "font-family": [".settings-main", ".p-native", ".nf", ".layers"],
      // Layer (b) composes the host's own elements (its account header) with kit primitives.

      // The native preset shows the host's own accent on native controls (§3.4).
      "colour-literal": [".p-native"],
    },
  },
  ios: {
    chrome: [
      ...CAPTIONS,
      ...PHONE,
      // The host app behind the kit's sheet or banner (its large title and list are the host's).
      ".hosttitle",
      ".sessions",
      ".lock",
      ".lock-date",
      ".lock-time",
    ],
    touch: [".shot", ".row-shot"],
    allow: {
      // System-drawn controls keep the system font: the paste control (UIPasteControl) and Sign in
      // with Apple (Apple's button guidelines).
      "font-family": [".paste", ".apple"],
    },
  },
  apple: {
    chrome: [
      ...CAPTIONS,
      ".ipad > .screen > .bar",
      ".room > .window-light",
      ".grabber",
      ".wscreen > .time",
    ],
    touch: [".ipad"],
  },
  android: {
    chrome: [
      ...CAPTIONS,
      ...PHONE,
      // The host app behind the update sheet: its title and list.
      "[data-shot=update] .screen > h1",
      ".hostlist",
      ".pb-under",
    ],
    touch: [".shot", ".tab", ".row-shot"],
    allow: {
      // The native preset: the platform's dynamic colour and Roboto (§3.4).
      "font-family": [".dyn"],
    },
  },
  desktop: {
    chrome: [...CAPTIONS, ".titlebar", ".lights"],
  },
  windows: {
    chrome: [...CAPTIONS, ".tb"],
  },
  linux: {
    chrome: [...CAPTIONS, ".hb"],
  },
  qt: {
    chrome: [
      ...CAPTIONS,
      ".tb-win",
      ".tb-kde",
      ".tb-mac",
      // The widget board labels each part with its object name.
      ".parts h3",
      ".parts .qt-mute",
    ],
  },
  godot: {
    chrome: [
      ...CAPTIONS,
      // The host game's HUD (lap counter, results) sits behind the kit.
      ".hud",
    ],
    allow: {
      // Controller glyphs are drawn as letters in the mockup; the kit draws them as icon
      // textures from the brand theme, so their weight is not type.
      "font-weight-700": [".pad"],
    },
  },
  terminal: {
    chrome: [...CAPTIONS, ".tbar", ".strip > div > .lbl"],
  },
};
