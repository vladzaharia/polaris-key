// The §7.3 rule set, one entry per check, with the hard rule (§1.5) each one enforces. The ids
// are what `data-ui-allow` names and what the report groups by.
export interface RuleInfo {
  id: string;
  group: "borders" | "type" | "shape" | "behaviour" | "copy";
  spec: string;
  says: string;
}

export const RULES: RuleInfo[] = [
  {
    id: "border-width",
    group: "borders",
    spec: "§1.5 rule 2",
    says: "No border wider than 1 px; depth comes from surface steps and elevation.",
  },
  {
    id: "focus-visible-only",
    group: "borders",
    spec: "§1.5 rules 1 and 7",
    says: "The focus ring appears on :focus-visible only, never on plain :focus.",
  },
  {
    id: "focus-ring-spread",
    group: "borders",
    spec: "§1.5 rule 1",
    says: "Focus is one 2 px outline: no box-shadow halo, spread or glow.",
  },
  {
    id: "button-glow",
    group: "borders",
    spec: "§1.5 rule 6",
    says: "No coloured box-shadow under buttons.",
  },
  {
    id: "font-family",
    group: "type",
    spec: "§1.5 rule 6, §2.1",
    says: "Text uses the theme's families only (Rubik and the kit mono by default).",
  },
  {
    id: "font-weight-700",
    group: "type",
    spec: "§1.5 rule 6",
    says: "Weights are 400, 500 and 600; 700 only on the game wordmark fallback.",
  },
  {
    id: "text-size-floor",
    group: "type",
    spec: "§7.3",
    says: "No text below 12 px.",
  },
  {
    id: "fractional-font-size",
    group: "type",
    spec: "§7.3",
    says: "No fractional px font sizes.",
  },
  {
    id: "button-uppercase",
    group: "type",
    spec: "§1.5 rule 6",
    says: "No all-caps buttons.",
  },
  {
    id: "no-vw",
    group: "type",
    spec: "§7.3, §1.4",
    says: "No viewport units in kit CSS; the kit sizes to its container (cqi).",
  },
  {
    id: "orphan",
    group: "type",
    spec: "§1.5 rule 11",
    says: "No heading, lede or row meta ends on a single orphan word.",
  },
  {
    id: "tier-separator",
    group: "type",
    spec: "§7.3",
    says: "The tier is one text run with the product name; a separator is never its own flex item.",
  },
  {
    id: "key-nowrap",
    group: "type",
    spec: "§1.5 rule 12",
    says: "License keys never wrap inside a field (nowrap plus the middle ellipsis).",
  },
  {
    id: "rtl-physical",
    group: "type",
    spec: "§4.7, §7.3",
    says: "RTL-safe layout: logical properties only, no physical left/right in kit CSS.",
  },
  {
    id: "square-in-rounded",
    group: "shape",
    spec: "§7.3",
    says: "No square-cornered row or band inside a rounded container.",
  },
  {
    id: "glass-on-glass",
    group: "shape",
    spec: "§7.3",
    says: "A control on a blurred sheet is a flat fill, never a second backdrop-filter.",
  },
  {
    id: "scrim-coverage",
    group: "shape",
    spec: "§7.3",
    says: "A modal scrim dims the whole window evenly.",
  },
  {
    id: "empty-placeholder",
    group: "shape",
    spec: "§7.3",
    says: "No empty placeholder box where an image or logo belongs.",
  },
  {
    id: "touch-target",
    group: "behaviour",
    spec: "§1.5 rule 5",
    says: "Touch targets are at least 44 px on touch variants.",
  },
  {
    id: "no-alert",
    group: "behaviour",
    spec: "§1.5 rule 3",
    says: "No alert(), confirm() or prompt().",
  },
  {
    id: "interactive-states",
    group: "behaviour",
    spec: "§1.5 rule 7",
    says: "Every interactive element has hover, active, disabled and focus-visible styles.",
  },
  {
    id: "colour-literal",
    group: "behaviour",
    spec: "§2.1, §7.3",
    says: "No colour literal outside the generated tokens and the kit theme variables.",
  },
  {
    id: "one-primary",
    group: "behaviour",
    spec: "§1.5 rule 10",
    says: "One primary button per region.",
  },
  {
    id: "x-beside-cancel",
    group: "behaviour",
    spec: "§1.5 rule 10",
    says: "One dismissal per surface: no close X beside a Cancel or Later.",
  },
  {
    id: "catalog-string",
    group: "copy",
    spec: "§4.7, §1.5 rule 11",
    says: "Every visible string is a catalog key; boards and kits show the same copy per state, allowing only documented platform variants.",
  },
  {
    id: "kit-source",
    group: "behaviour",
    spec: "§7.3 per-kit equivalents",
    says: "The native kits' source rules (SwiftUI, Compose, Godot, Qt): see rules/kit-rules.json.",
  },
];

export const RULE_IDS = new Set(RULES.map((r) => r.id));
