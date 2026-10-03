// Resolve the design source (OKLCH + kit hex) into concrete sRGB hex tokens. The generator
// (scripts/gen.ts) calls this once and writes the result in every output format; the tests call
// it too, so they check the same numbers the outputs carry.

import { mixOver, normalizeHex, oklchToHex } from "../color.js";
import {
  ACCENTS,
  ACCENT_FAMILIES,
  NEUTRALS,
  SIGNED,
  STATUS,
  STATUS_IDS,
  SUBTLE_ALPHA,
  THEMES,
  type AccentFamily,
  type ColorSpec,
  type StatusId,
  type Theme,
} from "./source.js";

export function resolveColor(spec: ColorSpec): string {
  return typeof spec === "string"
    ? normalizeHex(spec)
    : oklchToHex({ l: spec.oklch[0], c: spec.oklch[1], h: spec.oklch[2] });
}

export interface ResolvedAccent {
  solid: string;
  fg: string;
  on: string;
  subtle: string;
}

export interface ResolvedStatus {
  fg: string;
  on: string;
  border: string;
  subtle: string;
}

export interface ResolvedSigned {
  mark: string;
  solid: string;
  on: string;
  border: string;
  subtle: string;
}

export interface ResolvedTheme {
  surface: { page: string; raised: string; overlay: string; sunken: string };
  text: {
    strong: string;
    default: string;
    muted: string;
    subtle: string;
    onAccent: string;
  };
  border: { subtle: string; strong: string };
  focus: string;
  accent: Record<AccentFamily, ResolvedAccent>;
  status: Record<StatusId, ResolvedStatus>;
  signed: ResolvedSigned;
}

function resolveTheme(theme: Theme): ResolvedTheme {
  const n = NEUTRALS[theme];
  const page = resolveColor(n.surface.page);
  const subtle = (hex: string) => mixOver(hex, SUBTLE_ALPHA[theme], page);
  const accent = Object.fromEntries(
    ACCENT_FAMILIES.map((f) => {
      const a = ACCENTS[f][theme];
      const solid = resolveColor(a.solid);
      return [
        f,
        {
          solid,
          fg: resolveColor(a.fg),
          on: resolveColor(a.on),
          subtle: subtle(solid),
        },
      ];
    }),
  ) as Record<AccentFamily, ResolvedAccent>;
  const status = Object.fromEntries(
    STATUS_IDS.map((s) => {
      const st = STATUS[s][theme];
      const fg = resolveColor(st.fg);
      return [
        s,
        {
          fg,
          on: resolveColor(st.on),
          border: resolveColor(st.border),
          subtle: subtle(fg),
        },
      ];
    }),
  ) as Record<StatusId, ResolvedStatus>;
  const sg = SIGNED[theme];
  const signedSolid = resolveColor(sg.solid);
  return {
    surface: {
      page,
      raised: resolveColor(n.surface.raised),
      overlay: resolveColor(n.surface.overlay),
      sunken: resolveColor(n.surface.sunken),
    },
    text: {
      strong: resolveColor(n.text.strong),
      default: resolveColor(n.text.default),
      muted: resolveColor(n.text.muted),
      subtle: resolveColor(n.text.subtle),
      onAccent: resolveColor(n.text.onAccent),
    },
    border: {
      subtle: resolveColor(n.border.subtle),
      strong: resolveColor(n.border.strong),
    },
    focus: resolveColor(n.focus),
    accent,
    status,
    signed: {
      mark: resolveColor(sg.mark),
      solid: signedSolid,
      on: resolveColor(sg.on),
      border: resolveColor(sg.border),
      subtle: subtle(signedSolid),
    },
  };
}

/** Every semantic colour, resolved, per theme. */
export function resolveTokens(): Record<Theme, ResolvedTheme> {
  return Object.fromEntries(THEMES.map((t) => [t, resolveTheme(t)])) as Record<
    Theme,
    ResolvedTheme
  >;
}
