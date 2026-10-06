// Brandable theming via CSS custom properties — no CSS-in-JS dependency. A `PolarisTheme`
// is a small token bag + copy overrides; the Provider serializes the tokens to `--pk-*`
// custom properties on a wrapper element, and the drop-in components read them. Consumers
// can theme entirely from JS (tokens) OR by setting `--pk-*` vars in their own stylesheet.
//
// TWO BRANDINGS (owner decision 2026-10-04). Polaris Key branding is OPTIONAL:
//
//   "neutral" (default)  a quiet, host-friendly greyscale theme that inherits the app's font
//                        (`font-family: inherit`) and shows no Polaris Key mark or badge. An
//                        integrator points any token at their own colours (`var(--app-x)`).
//   "polaris-key"        the Polaris Key design system (docs/design/BRAND.md): every colour read
//                        from `@polaris-key/brand`'s generated `THEME_TOKENS`, Rubik when the
//                        page loads it, the violet accent and focus ring, and the Pinned K / Star
//                        Cut marks on the screens BRAND.md §7.1 assigns them. The SDK never
//                        requires the host to load `tokens.css` (BRAND.md §2).
//
// Choose with one option: `theme={{ branding: "polaris-key" }}` (or the `polarisKeyTheme`
// preset, or `<PolarisKeyProvider branding="polaris-key">`). The "Powered by Polaris Key" badge
// is a separate opt-in (`poweredBy`), off by default under both brandings.
//
// Both brandings are dark and light, following the system (BRAND.md §3):
// `<PolarisKeyProvider colorScheme>` takes "system" (the default), "dark" or "light"; the
// integrator's partial theme merges over the resolved base, and `darkTokens` / `lightTokens`
// override one scheme only.

import { FONT, RADIUS, THEME_TOKENS } from "@polaris-key/brand";

/** The persisted theme choice (BRAND.md §3). "system" follows `prefers-color-scheme`. */
export type PolarisColorScheme = "system" | "dark" | "light";

/** Which look the built-in screens wear: neutral (default) or the Polaris Key brand. */
export type PolarisBranding = "neutral" | "polaris-key";

/** The scheme a theme resolved to. */
export type PolarisResolvedScheme = "dark" | "light";

/** The visual tokens. Each maps to a `--pk-<token>` CSS custom property. */
export interface PolarisThemeTokens {
  /** Brand accent (primary button bg). */
  accent: string;
  /** Brand accent, hover/active state. */
  accentHover: string;
  /** Text colour on the accent. */
  accentText: string;
  /** Focus-ring colour (keyboard focus visibility — WCAG 2.4.7). Violet in the brand. */
  ring: string;
  /** Page/gate background. */
  background: string;
  /** Card/surface background. */
  surface: string;
  /** Wells and inputs on a card. */
  surfaceSunken: string;
  /** Headings and key figures. */
  textStrong: string;
  /** Primary (body) text colour. */
  text: string;
  /** Muted/secondary text. */
  textMuted: string;
  /** Decorative borders: card edges, row dividers. No contrast requirement. */
  border: string;
  /** Borders that bound a control (inputs, secondary buttons): >= 3:1 on every surface. */
  borderStrong: string;
  /** Danger/error text. */
  danger: string;
  /** Warning text and the warning callout's border. */
  warning: string;
  /** The warning callout's background. */
  warningSubtle: string;
  /** Success text. */
  success: string;
  /** Informational text. */
  info: string;
  /** Corner radius for cards. */
  radius: string;
  /** Corner radius for controls (buttons, inputs). */
  controlRadius: string;
  /** Base font stack. */
  fontFamily: string;
}

/** Copy overrides for the built-in screens (everything user-visible is overridable). */
export interface PolarisThemeCopy {
  productName: string;
  signInTitle: string;
  signInSubtitle: string;
  oidcButtonLabel: string;
  keyEntryLabel: string;
  keyEntryPlaceholder: string;
  keySubmitLabel: string;
  /** The divider between the sign-in button and the key form when both appear. */
  orDivider: string;
  graceTitle: string;
  graceBody: string;
  expiredTitle: string;
  expiredBody: string;
  revokedTitle: string;
  revokedBody: string;
  versionTooOldTitle: string;
  versionTooOldBody: string;
  versionTooNewTitle: string;
  versionTooNewBody: string;
  channelNotEntitledTitle: string;
  channelNotEntitledBody: string;
  loadingLabel: string;
  retryLabel: string;
  /** The device-limit action (PX-W8): opens the customer portal to free a seat. */
  freeDeviceLabel: string;
  signOutLabel: string;
  /** `not-applicable` never reaches a gate screen — a product without the license service
   *  renders children straight through — but the string exists for a host that wants to
   *  explain the state in its own settings UI. */
  notApplicableLabel: string;
  // ── ConfigPanel (./config) ───────────────────────────────────────────────
  configTitle: string;
  configSubtitle: string;
  configEmpty: string;
  configEnforcedBadge: string;
  configLocalBadge: string;
  configRemoteBadge: string;
  configOverrideLabel: string;
  configDisabledTitle: string;
  configDisabledBody: string;
  // ── UpdatePrompt (./update) ──────────────────────────────────────────────
  updateTitle: string;
  updateBody: string;
  updateActionLabel: string;
  updateDismissLabel: string;
  updateUpToDateLabel: string;
  /** wire v4 decisions (`<UpdatePrompt source="decision">`). */
  updateReadyTitle: string;
  updateReadyBody: string;
  updateRestartLabel: string;
  updateStoreLabel: string;
  updatePlatformBody: string;
  updateMandatoryBody: string;
  updateBlockedTitle: string;
  updateBlockedBody: string;
  /** A content floor (plans/P4-13.md §2.6): play continues, like the app floor. */
  updateContentFloorBody: string;
  /** Revoked required content (plans/P4-13.md §2.6, decision 4): the boot stops. */
  updateRevokedContentTitle: string;
  updateRevokedContentBody: string;
  // ── DeviceManager (./license) ────────────────────────────────────────────
  devicesTitle: string;
  devicesSubtitle: string;
  devicesEmpty: string;
  deviceCurrentBadge: string;
  deviceRenameLabel: string;
  deviceRenameSubmitLabel: string;
  deviceDisconnectLabel: string;
  devicesUnsupportedTitle: string;
  devicesUnsupportedBody: string;
}

/** Which "Powered by Polaris Key" badge layout a licence/account screen shows (BRAND.md §7.2):
 *  compact for app UI (the default when `true`), horizontal for footers and credits, stacked
 *  for square placements. */
export type PoweredByLayout = "compact" | "horizontal" | "stacked";

export interface PolarisTheme {
  tokens: PolarisThemeTokens;
  copy: PolarisThemeCopy;
  /**
   * The brand node rendered atop the login/gate screens. `null` renders none. `undefined`
   * renders nothing under the neutral branding and, under "polaris-key", the mark the design
   * system assigns to the screen (BRAND.md §7.1: the Pinned K on the gate and sign-in, the
   * Star Cut on update screens).
   */
  logo?: import("react").ReactNode;
  /** Which look these tokens are. Absent means "neutral". */
  branding?: PolarisBranding;
  /** The scheme these tokens are for. Set by `mergeTheme`; absent on a hand-built theme. */
  scheme?: PolarisResolvedScheme;
  /**
   * Show the "Powered by Polaris Key" badge on the licence and account screens (the sign-in
   * card and the device list). Off by default: it is the integrator's choice (BRAND.md §7.2).
   */
  poweredBy?: boolean | PoweredByLayout;
}

type BrandTheme = (typeof THEME_TOKENS)["dark" | "light"];

/** The SDK's tokens for one brand scheme, read from the generated brand tokens. */
function brandTokens(t: BrandTheme): PolarisThemeTokens {
  const violet = t.accent.violet;
  return {
    accent: violet.solid,
    // The brand defines no hover colour; a fill keeps its accent and the focus ring carries
    // the interaction state.
    accentHover: violet.solid,
    accentText: violet.on,
    ring: t.focus,
    background: t.surface.page,
    surface: t.surface.raised,
    surfaceSunken: t.surface.sunken,
    textStrong: t.text.strong,
    text: t.text.default,
    textMuted: t.text.muted,
    border: t.border.subtle,
    borderStrong: t.border.strong,
    danger: t.status.danger.fg,
    warning: t.status.warning.fg,
    warningSubtle: t.status.warning.subtle,
    success: t.status.success.fg,
    info: t.status.info.fg,
    radius: RADIUS.lg,
    controlRadius: RADIUS.md,
    fontFamily: FONT.sans,
  };
}

/** The Polaris Key brand's dark tokens (BRAND.md §3 is dark first). */
export const polarisKeyDarkTokens: PolarisThemeTokens = brandTokens(
  THEME_TOKENS.dark,
);

/** The Polaris Key brand's light tokens (full light parity, BRAND.md §3). */
export const polarisKeyLightTokens: PolarisThemeTokens = brandTokens(
  THEME_TOKENS.light,
);

/** The neutral dark tokens: greyscale, the host's font. Contrast is pinned by
 *  `test/theme.test.tsx` (text >= 4.5:1, control borders and ring >= 3:1 on every surface). */
export const neutralDarkTokens: PolarisThemeTokens = {
  accent: "#f4f4f5",
  accentHover: "#f4f4f5",
  accentText: "#18181b",
  ring: "#d4d4d8",
  background: "#18181b",
  surface: "#202024",
  surfaceSunken: "#141416",
  textStrong: "#fafafa",
  text: "#e4e4e7",
  textMuted: "#a1a1aa",
  border: "#2e2e33",
  borderStrong: "#71717a",
  danger: "#f87171",
  warning: "#fbbf24",
  warningSubtle: "#29230f",
  success: "#4ade80",
  info: "#d4d4d8",
  radius: "0.75rem",
  controlRadius: "0.5rem",
  fontFamily: "inherit",
};

/** The neutral light tokens. */
export const neutralLightTokens: PolarisThemeTokens = {
  accent: "#18181b",
  accentHover: "#18181b",
  accentText: "#ffffff",
  ring: "#3f3f46",
  background: "#f4f4f5",
  surface: "#ffffff",
  surfaceSunken: "#f4f4f5",
  textStrong: "#09090b",
  text: "#27272a",
  textMuted: "#52525b",
  border: "#e4e4e7",
  borderStrong: "#71717a",
  danger: "#b91c1c",
  warning: "#92400e",
  warningSubtle: "#fef3c7",
  success: "#15803d",
  info: "#3f3f46",
  radius: "0.75rem",
  controlRadius: "0.5rem",
  fontFamily: "inherit",
};

/** The base tokens for a branding and scheme. */
export function baseTokens(
  branding: PolarisBranding,
  scheme: PolarisResolvedScheme,
): PolarisThemeTokens {
  if (branding === "polaris-key")
    return scheme === "light" ? polarisKeyLightTokens : polarisKeyDarkTokens;
  return scheme === "light" ? neutralLightTokens : neutralDarkTokens;
}

/** The default theme: neutral, dark, no Polaris Key branding. */
export const defaultTheme: PolarisTheme = {
  branding: "neutral",
  scheme: "dark",
  tokens: neutralDarkTokens,
  copy: {
    productName: "This app",
    signInTitle: "Sign in",
    signInSubtitle: "Authenticate to unlock this app.",
    // Neutral: the host's sign-in, not ours (no Polaris Key name on a neutral screen).
    oidcButtonLabel: "Continue to sign in",
    keyEntryLabel: "Have a license key?",
    keyEntryPlaceholder: "Paste your key",
    keySubmitLabel: "Activate",
    orDivider: "or",
    graceTitle: "Offline grace",
    graceBody:
      "The licensing service is offline. You can keep working until grace ends.",
    expiredTitle: "License expired",
    expiredBody:
      "Your license or offline grace period has ended. Sign in or activate a key to continue.",
    revokedTitle: "License revoked",
    revokedBody:
      "This license is no longer active on this device. Contact your administrator.",
    versionTooOldTitle: "Update required",
    versionTooOldBody:
      "This version is no longer supported. Please update the app.",
    versionTooNewTitle: "Version not allowed",
    versionTooNewBody: "This app version is newer than your license permits.",
    channelNotEntitledTitle: "Channel not entitled",
    channelNotEntitledBody:
      "Your license doesn't include this release channel. Switch channels or contact your administrator.",
    loadingLabel: "Checking your license…",
    retryLabel: "Try again",
    freeDeviceLabel: "Replace a device",
    signOutLabel: "Sign out",
    notApplicableLabel: "This product is not licensed separately.",
    configTitle: "Settings",
    configSubtitle:
      "Values your administrator manages. Locked rows are set for you.",
    configEmpty: "No settings have been delivered for this product.",
    configEnforcedBadge: "Managed",
    configLocalBadge: "Overridden",
    configRemoteBadge: "Default",
    configOverrideLabel: "Override",
    configDisabledTitle: "Settings are not managed",
    configDisabledBody:
      "This product does not distribute managed settings, so there is nothing to show here.",
    updateTitle: "An update is available",
    updateBody: "A newer version of this app has been released.",
    updateActionLabel: "Get the update",
    updateDismissLabel: "Not now",
    updateUpToDateLabel: "You're up to date.",
    updateReadyTitle: "An update is ready",
    updateReadyBody: "Restart the app to finish updating.",
    updateRestartLabel: "Restart now",
    updateStoreLabel: "Open the store",
    updatePlatformBody:
      "A newer version is available. It installs through the store or platform you got this app from.",
    updateMandatoryBody:
      "This version is below the minimum supported version. Please update; you can keep using the app until you do.",
    updateBlockedTitle: "This version is no longer supported",
    updateBlockedBody:
      "This version is below the minimum supported version, and no update is available here yet. You can keep using the app.",
    updateContentFloorBody:
      "Some of this app's content needs a newer version. Please update; you can keep using the app until you do.",
    updateRevokedContentTitle: "Content withdrawn",
    updateRevokedContentBody:
      "Some of this game's content was withdrawn by its developer and can't be used. Update the app to keep playing.",
    devicesTitle: "Your devices",
    devicesSubtitle: "Devices signed in with this license.",
    devicesEmpty: "No devices are registered to this license yet.",
    deviceCurrentBadge: "This device",
    deviceRenameLabel: "Device name",
    deviceRenameSubmitLabel: "Save",
    deviceDisconnectLabel: "Disconnect",
    devicesUnsupportedTitle: "Device management is unavailable",
    devicesUnsupportedBody:
      "This app can't manage the device list from here. Sign in to the portal to review your devices.",
  },
};

/** The neutral light theme. */
export const lightTheme: PolarisTheme = {
  ...defaultTheme,
  scheme: "light",
  tokens: neutralLightTokens,
};

export interface PartialTheme {
  /** "neutral" (default) or "polaris-key": the one switch for the Polaris Key brand. */
  branding?: PolarisBranding;
  /** Overrides for both schemes. */
  tokens?: Partial<PolarisThemeTokens>;
  /** Overrides for the dark scheme only, applied after `tokens`. */
  darkTokens?: Partial<PolarisThemeTokens>;
  /** Overrides for the light scheme only, applied after `tokens`. */
  lightTokens?: Partial<PolarisThemeTokens>;
  copy?: Partial<PolarisThemeCopy>;
  /** See `PolarisTheme.logo`: `null` hides the default mark. */
  logo?: import("react").ReactNode;
  poweredBy?: boolean | PoweredByLayout;
}

/** The copy that names Polaris Key, used only under the Polaris Key branding. */
const POLARIS_KEY_COPY: Partial<PolarisThemeCopy> = {
  productName: "Polaris Key",
  oidcButtonLabel: "Continue with Polaris Key",
};

/** The one-option preset for the Polaris Key brand: `theme={polarisKeyTheme}`. */
export const polarisKeyTheme: PartialTheme = { branding: "polaris-key" };

/**
 * Merge a partial theme over the base theme for its branding and `scheme` (tokens + copy merged
 * per-field). `scheme` defaults to "dark", so `mergeTheme(partial)` keeps its old meaning.
 */
export function mergeTheme(
  partial?: PartialTheme,
  scheme: PolarisResolvedScheme = "dark",
): PolarisTheme {
  const branding = partial?.branding ?? "neutral";
  const base: PolarisTheme = {
    ...defaultTheme,
    branding,
    scheme,
    tokens: baseTokens(branding, scheme),
    copy:
      branding === "polaris-key"
        ? { ...defaultTheme.copy, ...POLARIS_KEY_COPY }
        : defaultTheme.copy,
  };
  if (!partial) return base;
  const perScheme =
    scheme === "light" ? partial.lightTokens : partial.darkTokens;
  return {
    branding,
    scheme,
    tokens: { ...base.tokens, ...partial.tokens, ...perScheme },
    copy: { ...base.copy, ...partial.copy },
    logo: partial.logo,
    poweredBy: partial.poweredBy ?? base.poweredBy,
  };
}

/** Serialize tokens to a `--pk-*` CSS custom-property style object. */
export function themeVars(theme: PolarisTheme): Record<string, string> {
  const t = theme.tokens;
  return {
    "--pk-accent": t.accent,
    "--pk-accent-hover": t.accentHover,
    "--pk-accent-text": t.accentText,
    "--pk-ring": t.ring,
    "--pk-background": t.background,
    "--pk-surface": t.surface,
    "--pk-surface-sunken": t.surfaceSunken,
    "--pk-text-strong": t.textStrong,
    "--pk-text": t.text,
    "--pk-text-muted": t.textMuted,
    "--pk-border": t.border,
    "--pk-border-strong": t.borderStrong,
    "--pk-danger": t.danger,
    "--pk-warning": t.warning,
    "--pk-warning-subtle": t.warningSubtle,
    "--pk-success": t.success,
    "--pk-info": t.info,
    "--pk-radius": t.radius,
    "--pk-control-radius": t.controlRadius,
    "--pk-font-family": t.fontFamily,
  };
}

/** A maximum-contrast variant for users who need it (WCAG 1.4.6 AAA / `prefers-contrast`).
 *  Pure-white text and a light violet accent (never blue or indigo) on
 *  true-black surfaces; every text pairing clears AAA (`test/theme.test.tsx`). Consumers opt
 *  in via `<PolarisKeyProvider theme={highContrastTheme} colorScheme="dark">` or by merging
 *  `highContrastTheme.tokens`. */
export const highContrastTheme: PartialTheme = {
  tokens: {
    fontFamily: "inherit",
    accent: "#ffffff",
    accentHover: "#e0e0e0",
    accentText: "#000000",
    ring: "#ffffff",
    background: "#000000",
    surface: "#0a0a0a",
    surfaceSunken: "#000000",
    textStrong: "#ffffff",
    text: "#ffffff",
    textMuted: "#e0e0e0",
    border: "#5a5a5a",
    borderStrong: "#a0a0a0",
    danger: "#ff8a8a",
    warning: "#ffbe5c",
    warningSubtle: "#1a1206",
    success: "#7ee69a",
    info: "#e0e0e0",
  },
};
