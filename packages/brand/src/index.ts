// @polaris-key/brand — the Polaris Key design system's contract.
//
//   @polaris-key/brand            tokens (typed constants), kit primitives, mark rules
//   @polaris-key/brand/react      <PolarisMark>, <PolarisLockup>, <PoweredByBadge>
//   @polaris-key/brand/svg        the same artwork as SVG strings (no React)
//   @polaris-key/brand/color      OKLab/OKLCH, WCAG contrast and ΔE helpers
//   @polaris-key/brand/accent     the product accent resolver (UI-KITS.md §3.3)
//   @polaris-key/brand/tokens.css, /theme.css (Tailwind v4), /kit.css, /fonts.css, /tokens.json
//   @polaris-key/brand/web/{key,update}/…, /games/…, /social/…, /kit/… (the launch kit files)
//
// The written spec is docs/design/BRAND.md; the UI kits' is docs/design/UI-KITS.md.

export * from "./tokens/primitives.js";
export * from "./tokens/scales.js";
export {
  ACCENT_FAMILIES,
  SERVICE_FAMILY,
  SERVICE_IDS,
  SERVICE_LABEL,
  SERVICE_MARK,
  STATUS_IDS,
  THEMES,
  type AccentFamily,
  type ServiceId,
  type StatusId,
  type Theme,
} from "./tokens/source.js";
export type {
  ResolvedAccent,
  ResolvedSigned,
  ResolvedStatus,
  ResolvedTheme,
} from "./tokens/resolve.js";
export { SERVICE_ACCENTS, THEME_TOKENS } from "./generated/tokens.js";
export {
  badgeSize,
  bitVisible,
  clearSpace,
  isNoBit,
  isServiceId,
  opticalCut,
  resolveBitFill,
  type BitColor,
  type MarkTheme,
} from "./marks/core.js";
export * from "./tokens/icons.js";
export { serviceAccent, sectionBit } from "./tokens/services.js";
export {
  COLOR_RULES,
  colorViolations,
  meets,
  type Violation,
} from "./tokens/rules.js";
export { KIT_TOKENS, type KitTokens } from "./generated/kit.js";
export * from "./tokens/kit.js";
export * from "./tokens/terminal.js";
export {
  ACCENT_INK,
  ACCENT_RULES,
  ACCENT_WHITE,
  accentFg,
  accentLabel,
  accentSolid,
  accentSurfaces,
  deriveAccent,
  resolveAccent,
  type AccentLabel,
  type ResolvedProductAccent,
} from "./accent.js";
