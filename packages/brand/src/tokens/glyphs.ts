// The kit glyphs (docs/design/UI-KITS.md §1.5 rule 11, DL6): the line icons every UI kit draws the
// same way, on a 24 x 24 grid with a 2 px round-capped, round-joined stroke. One source: the
// elements and React kits read it directly; `pnpm gen brand` writes it into the Godot icon set
// (kit_icons_generated.gd), the Swift, Compose and Python kits' token files and the Qt theme.
// The terminal kits keep the "↗" text glyph (TERMINAL_SYMBOLS.newWindow, with an ASCII fallback).

/** The glyph grid; every icon's viewBox. */
export const KIT_GLYPH_GRID = 24;

/** Stroke width on the glyph grid. */
export const KIT_GLYPH_STROKE = 2;

/**
 * An action that leaves the app (rule 11): "Replace a device", "Manage", "Open in browser". Drawn
 * beside the label, never instead of it; the control's accessible description is the copy key
 * `copyKey` ("Opens in your browser"), so the glyph itself is decorative.
 */
export const KIT_GLYPHS = {
  newWindow: {
    /** SVG path data, in drawing order. */
    paths: [
      "M15 3h6v6",
      "M10 14 21 3",
      "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
    ],
    /** The platform symbol the Apple kits use where one exists (SF Symbols). */
    sfSymbol: "arrow.up.right.square",
    /** The kit-copy key that says where it goes. */
    copyKey: "a11y.externalLink",
  },
} as const;

export type KitGlyphName = keyof typeof KIT_GLYPHS;
