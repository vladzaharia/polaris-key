// Resolve the design source (OKLCH + kit hex) into concrete sRGB hex tokens. The generator
// (scripts/gen.ts) calls this once and writes the result in every output format; the tests call
// it too, so they check the same numbers the outputs carry.

import { mixOver, normalizeHex, oklchToHex } from "../color.js";
import {
  ACCENTS,
  ACTION,
  ACTION_STEPS,
  HOVER_ALPHA,
  SERVICE_FAMILY,
  SERVICE_IDS,
  type ServiceId,
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

/**
 * The interactive and context colours of one accent family in one theme (B17). Everything a
 * control paints when it references a service comes from here; status colours are never in it.
 *   ring          the focus ring (the family's `fg`): >= 3:1 on every surface and on the fills below.
 *   selectedFill  the tint behind a selected row or item (`subtle`); text on it >= 4.5:1.
 *   hoverTint     a lighter step than selectedFill; the same text pair.
 *   checkedFill   checkbox, radio, switch, segmented, chip when checked (`solid`): >= 3:1 on the ground.
 *   checkedOn     the glyph or label on checkedFill: >= 4.5:1.
 *   checkedEdge   the outline of a checked control (`fg`): >= 3:1.
 *   contextEdge   a border that marks context (`fg`): >= 3:1.
 */
export interface ResolvedState {
  ring: string;
  selectedFill: string;
  hoverTint: string;
  checkedFill: string;
  checkedOn: string;
  checkedEdge: string;
  contextEdge: string;
}

export interface ResolvedAction {
  fill: string;
  on: string;
  hover: string;
  pressed: string;
  disabledFill: string;
  disabledOn: string;
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
  action: ResolvedAction;
  accent: Record<AccentFamily, ResolvedAccent>;
  /** B17 state tokens per section; commerce aliases distribution. */
  state: Record<ServiceId, ResolvedState>;
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
  const state = Object.fromEntries(
    SERVICE_IDS.map((id) => {
      const fam = SERVICE_FAMILY[id];
      const a = accent[fam];
      return [
        id,
        {
          ring: a.fg,
          selectedFill: a.subtle,
          hoverTint: mixOver(a.solid, HOVER_ALPHA[theme], page),
          checkedFill: a.solid,
          checkedOn: a.on,
          checkedEdge: a.fg,
          contextEdge: a.fg,
        },
      ];
    }),
  ) as Record<ServiceId, ResolvedState>;
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
    action: (() => {
      const fill = resolveColor(ACTION[theme].fill);
      const steps = ACTION_STEPS[theme];
      return {
        fill,
        on: resolveColor(ACTION[theme].on),
        hover: mixOver(fill, steps.hover, page),
        pressed: mixOver(fill, steps.pressed, page),
        disabledFill: mixOver(fill, steps.disabled, page),
        disabledOn: resolveColor(n.text.subtle),
      };
    })(),
    accent,
    state,
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
