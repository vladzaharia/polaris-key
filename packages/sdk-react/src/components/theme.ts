// Brandable theming via CSS custom properties — no CSS-in-JS dependency. A `PolarisTheme`
// is a small token bag + copy overrides; the Provider serializes the tokens to `--pk-*`
// custom properties on a wrapper element, and the drop-in components read them. Consumers
// can theme entirely from JS (tokens) OR by setting `--pk-*` vars in their own stylesheet.

/** The visual tokens. Each maps to a `--pk-<token>` CSS custom property. */
export interface PolarisThemeTokens {
  /** Brand accent (primary button bg, focus ring). */
  accent: string;
  /** Text colour on the accent. */
  accentText: string;
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
}

export interface PolarisTheme {
  tokens: PolarisThemeTokens;
  copy: PolarisThemeCopy;
  /** Optional brand logo node rendered atop the login/gate screens. */
  logo?: import("react").ReactNode;
}

/** A neutral default theme — overridden shallowly by what the Provider receives. */
export const defaultTheme: PolarisTheme = {
  tokens: {
    accent: "#4f46e5",
    accentText: "#ffffff",
    background: "#0b0d12",
    surface: "#151821",
    text: "#f3f4f6",
    textMuted: "#9ca3af",
    border: "#2a2f3a",
    danger: "#ef4444",
    radius: "12px",
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  copy: {
    productName: "Polaris Key",
    signInTitle: "Sign in",
    signInSubtitle: "Authenticate to unlock this app.",
    oidcButtonLabel: "Continue with Polaris",
    keyEntryLabel: "Have a license key?",
    keyEntryPlaceholder: "Paste your key",
    keySubmitLabel: "Activate",
    graceTitle: "Offline grace",
    graceBody: "Reconnect soon to keep your license valid.",
    expiredTitle: "License expired",
    expiredBody: "Your offline grace period has ended. Sign in again to continue.",
    revokedTitle: "License revoked",
    revokedBody: "This license is no longer active. Contact your administrator.",
    versionTooOldTitle: "Update required",
    versionTooOldBody: "This version is no longer supported. Please update the app.",
    versionTooNewTitle: "Version not allowed",
    versionTooNewBody: "This version is newer than your license permits.",
    channelNotEntitledTitle: "Channel not entitled",
    channelNotEntitledBody: "Your license doesn't include this release channel.",
    loadingLabel: "Checking your license…",
    retryLabel: "Try again",
    signOutLabel: "Sign out",
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
    "--pk-accent-text": t.accentText,
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
