// Brandable theming via CSS custom properties — no CSS-in-JS dependency. A `PolarisTheme`
// is a small token bag + copy overrides; the Provider serializes the tokens to `--pk-*`
// custom properties on a wrapper element, and the drop-in components read them. Consumers
// can theme entirely from JS (tokens) OR by setting `--pk-*` vars in their own stylesheet.

/** The visual tokens. Each maps to a `--pk-<token>` CSS custom property. */
export interface PolarisThemeTokens {
  /** Brand accent (primary button bg). */
  accent: string;
  /** Brand accent, hover/active state (deeper indigo). */
  accentHover: string;
  /** Text colour on the accent. */
  accentText: string;
  /** Focus-ring colour (keyboard focus visibility — WCAG 2.4.7). */
  ring: string;
  /** Page/gate background. */
  background: string;
  /** Card/surface background. */
  surface: string;
  /** Primary text colour. */
  text: string;
  /** Muted/secondary text. */
  textMuted: string;
  /** Border colour for cards/inputs. */
  border: string;
  /** Danger/error accent. */
  danger: string;
  /** Corner radius for cards/buttons. */
  radius: string;
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

export interface PolarisTheme {
  tokens: PolarisThemeTokens;
  copy: PolarisThemeCopy;
  /** Optional brand logo node rendered atop the login/gate screens. */
  logo?: import("react").ReactNode;
}

/** A neutral default theme — overridden shallowly by what the Provider receives.
 *  Aligned with the Polaris Key admin palette: deep-slate surfaces + an indigo accent.
 *  Contrast (sRGB, WCAG 2.x) on this dark theme:
 *    text `#e6e9f2` on bg `#0c0f17`   → ~14.6:1 (AA & AAA body)
 *    textMuted `#9aa3bd` on bg        → ~7.0:1  (AA & AAA body)
 *    accentText `#0b1020` on accent `#7d97ff` → ~7.9:1 (AA & AAA)
 *    danger text `#fca5a5` on surface `#11141d` → ~7.3:1 (AA) */
export const defaultTheme: PolarisTheme = {
  tokens: {
    accent: "#5b7cfa", // indigo — matches admin --pk-primary
    accentHover: "#7d97ff", // lighter indigo for hover/active
    accentText: "#0b1020", // near-black on the light accent → AA
    ring: "#93a8ff", // bright indigo focus ring → visible on dark surfaces
    background: "#0c0f17", // deep slate page (admin --pk-background)
    surface: "#11141d", // raised card panel
    text: "#e6e9f2", // near-white body text
    textMuted: "#9aa3bd", // AA muted text
    border: "#262c3b", // hairline card/input border
    danger: "#fca5a5", // soft red — AA on the dark surface
    radius: "12px",
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  copy: {
    productName: "Polaris Key",
    signInTitle: "Sign in",
    signInSubtitle: "Authenticate to unlock this app.",
    oidcButtonLabel: "Continue with Polaris Key",
    keyEntryLabel: "Have a license key?",
    keyEntryPlaceholder: "Paste your key",
    keySubmitLabel: "Activate",
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

/** Shallow-merge a partial theme over the default (tokens + copy merged per-field). */
export function mergeTheme(partial?: PartialTheme): PolarisTheme {
  if (!partial) return defaultTheme;
  return {
    tokens: { ...defaultTheme.tokens, ...partial.tokens },
    copy: { ...defaultTheme.copy, ...partial.copy },
    logo: partial.logo ?? defaultTheme.logo,
  };
}

export interface PartialTheme {
  tokens?: Partial<PolarisThemeTokens>;
  copy?: Partial<PolarisThemeCopy>;
  logo?: import("react").ReactNode;
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
    "--pk-text": t.text,
    "--pk-text-muted": t.textMuted,
    "--pk-border": t.border,
    "--pk-danger": t.danger,
    "--pk-radius": t.radius,
    "--pk-font-family": t.fontFamily,
  };
}

/** A maximum-contrast variant for users who need it (WCAG 1.4.6 AAA / `prefers-contrast`).
 *  Pure-white text and a vivid accent on true-black surfaces; every pairing clears AAA.
 *  Consumers opt in via `<PolarisKeyProvider theme={highContrastTheme}>` or by merging
 *  `highContrastTheme.tokens`. */
export const highContrastTheme: PartialTheme = {
  tokens: {
    accent: "#aebfff", // light indigo
    accentHover: "#c7d2ff",
    accentText: "#000000", // ~10.9:1 on the light accent → AAA
    ring: "#ffffff", // maximum-visibility focus ring
    background: "#000000",
    surface: "#0a0a0a",
    text: "#ffffff", // 21:1 on black → AAA
    textMuted: "#e0e0e0", // ~16:1 on black → AAA
    border: "#5a5a5a",
    danger: "#ff8a8a", // ~9.4:1 on black → AAA
  },
};
