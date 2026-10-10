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
import { resolveKitColors } from "@polaris-key/ui-core/theme";

/** The persisted theme choice (BRAND.md §3). "system" follows `prefers-color-scheme`. */
export type PolarisColorScheme = "system" | "dark" | "light";

/** Which look the built-in screens wear: neutral (default) or the Polaris Key brand. */
export type PolarisBranding = "neutral" | "polaris-key";

/** The scheme a theme resolved to. */
export type PolarisResolvedScheme = "dark" | "light";

/** The visual tokens. Each maps to a `--pk-<token>` CSS custom property. */
export interface PolarisThemeTokens {
  /**
   * The product's accent: the primary button's fill. A `#rrggbb` (or `#rgb`) an integrator sets
   * runs through the accent resolver (`@polaris-key/brand`'s `resolveAccent`, via ui-core) against
   * the theme's own grounds, so the fill, `accentText` on it and the focus `ring` keep their
   * contrast in both schemes (UI-KITS.md §3.3, DL13). A `var(…)` is the host's to keep readable.
   */
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

/**
 * Copy overrides for the built-in screens (everything user-visible is overridable). Every default
 * is a verbatim value from the kit copy catalog (packages/brand/kit-copy/en.json) or the core copy
 * catalog (conformance/parity/copy.en.json), in the catalogs' ICU subset: `{name}` arguments and
 * `{n, plural, one {…} other {…}}`. UK-05 reads the catalogs directly; until then a string an
 * integrator overrides here wins.
 */
export interface PolarisThemeCopy {
  /** The product's name, in copy that names it ("Welcome to Tidewater"). The base themes carry
   *  a placeholder ("This app"), which no screen treats as a name: the title, the identity tile
   *  and the product lines appear only once it is set. */
  productName: string;
  /** The sign-in title when the product's name is not known (signin.methods.titleApp). */
  signInTitle: string;
  /** The sign-in title once `productName` is set (welcome.title). */
  welcomeTitle: string;
  /** A line under the sign-in title. None by default; rendered when an integrator sets it. */
  signInSubtitle: string;
  /** The sign-in button (welcome.signIn). */
  oidcButtonLabel: string;
  /** The button that reveals the key form when sign-in is offered too (welcome.useKey). */
  useKeyLabel: string;
  /** The key field's label (activate.title). */
  keyEntryLabel: string;
  keyEntryPlaceholder: string;
  /** The key form's submit (activate.submit). */
  keySubmitLabel: string;
  /** @deprecated No longer rendered: "Use a license key" reveals the key form instead. */
  orDivider: string;
  /** The device-limit callout's first line, when the counts are known (deviceLimit.heading). */
  deviceLimitHeading: string;
  /** The device-limit callout's second line (deviceLimit.browser). */
  deviceLimitBrowser: string;
  /** The sign-in card when the product offers neither a sign-in nor a key (signin.off.any). */
  noMethodsLabel: string;
  /** The key button on the revoked and expired screens, where the old key is not the one to
   *  type (signin.key.differentKey). */
  differentKeyLabel: string;
  // ── The browser hand-off of a device-code sign-in (signin.handoff.*) ──────
  /** The hand-off's title (signin.handoff.title). */
  handoffTitle: string;
  /** The line asking the person to compare codes (signin.handoff.check). */
  handoffCheck: string;
  /** The code's name for a screen reader and the group's label (part.code.label). */
  handoffCodeLabel: string;
  /** The page to type the code into, `{url}` (signin.handoff.url). */
  handoffUrl: string;
  /** The countdown, `{time}` as m:ss (signin.handoff.expires). */
  handoffExpires: string;
  /** Opens the sign-in page (signin.handoff.openBrowser). */
  handoffOpenLabel: string;
  /** Copies the code, the icon button's name (a11y.copyCode). */
  handoffCopyLabel: string;
  /** Said after the copy worked (common.copied). */
  handoffCopiedLabel: string;
  /** Stops the sign-in (common.cancel). */
  handoffCancelLabel: string;
  /** The title once the code has run out (core copy `sign-in-expired`). */
  handoffExpiredTitle: string;
  /** The line under it (core copy `sign-in-expired`). */
  handoffExpiredBody: string;
  /** Starts a new code (signin.again). */
  handoffAgainLabel: string;
  /** The error screen's title when no catalog title fits the failure (gate.error.title). */
  errorTitle: string;
  graceTitle: string;
  graceBody: string;
  /** The grace banner while days remain (grace.daysLeft). */
  graceDaysLeft: string;
  /** The grace banner on the last day (grace.lastDay). */
  graceLastDay: string;
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
  /** The button that drops a device-local override (`config.clear`). */
  configResetLabel: string;
  configDisabledTitle: string;
  configDisabledBody: string;
  // ── UpdatePrompt (./update) ──────────────────────────────────────────────
  /** The update title when the product's name is not known (update.availableTitle). */
  updateTitle: string;
  /** The update title once `productName` is set (update.title). */
  updateProductTitle: string;
  /** A line under the update title. None by default (update.current needs the download size,
   *  which the version check does not carry); rendered when an integrator sets it. */
  updateBody: string;
  updateActionLabel: string;
  updateDismissLabel: string;
  updateUpToDateLabel: string;
  /** The line a failed update check leaves. No catalog key yet (proposed `update.checkFailed`). */
  updateCheckFailed: string;
  /** Its cause when the connection failed, or the server did. */
  updateCheckOffline: string;
  /** Its cause when the product publishes no updates (a 404): nothing a retry can fix. */
  updateCheckUnavailable: string;
  /** wire v4 decisions (`<UpdatePrompt source="decision">`). */
  updateReadyTitle: string;
  /** The ready title once `productName` is set (update.readyTitle). */
  updateReadyProductTitle: string;
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
  /** @deprecated Replaced by `deviceLimitHeading` (the limit known) or `devicesCount`. */
  devicesSubtitle: string;
  /** The list's subtitle when the device limit is not known (devices.count). */
  devicesCount: string;
  devicesEmpty: string;
  /** The first load (common.loading). */
  devicesLoadingLabel: string;
  deviceCurrentBadge: string;
  /** A device with no name (devices.unnamed). */
  deviceUnnamed: string;
  /** A row's meta line when the last-seen time is known (devices.meta). */
  deviceMeta: string;
  /** The row action that opens the inline rename field (devices.rename). */
  deviceRenameActionLabel: string;
  /** The rename action's accessible name (a11y.renameDevice). */
  deviceRenameA11yLabel: string;
  deviceRenameLabel: string;
  deviceRenameSubmitLabel: string;
  /** Closes an inline editor without saving (common.cancel). */
  deviceRenameCancelLabel: string;
  /** The row action that removes another device (devices.remove). */
  deviceRemoveLabel: string;
  /** The remove action's accessible name (a11y.removeDevice). */
  deviceRemoveA11yLabel: string;
  /** The inline confirm before a removal (devices.removeConfirm). */
  deviceRemoveConfirm: string;
  /** @deprecated Replaced by `deviceRemoveLabel`, and `signOutLabel` on this device's row. */
  deviceDisconnectLabel: string;
  /** @deprecated No longer rendered: the unsupported state is the `devicesUnsupportedBody`
   *  line inside the panel. */
  devicesUnsupportedTitle: string;
  /** The unsupported state's line (devices.browser). */
  devicesUnsupportedBody: string;
  /** The link to the portal's device page in the unsupported state (devices.manage). */
  devicesManageLabel: string;
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
  /**
   * The product's verified icon from discovery (`core.presentation`, HA-13), as a `blob:` URL,
   * when the integrator set no `logo`. The Provider fills it; `screenLogo` draws it, and falls
   * back to the monogram when it does not load (an integrator CSP without `img-src blob:`).
   */
  productIcon?: string;
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

/** The kit's primary when the product has no accent: ink, the strongest neutral of the scheme
 *  with the contrasting neutral on top. The brand's violet is Polaris Key's own, never a
 *  product's (B2, DL13); a product's accent is set through `theme.tokens.accent`. */
const INK = {
  dark: { fill: "#f4f4f5", on: "#18181b" },
  light: { fill: "#18181b", on: "#ffffff" },
} as const;

/** The SDK's tokens for one brand scheme, read from the generated brand tokens. */
function brandTokens(
  t: BrandTheme,
  scheme: keyof typeof INK,
): PolarisThemeTokens {
  const ink = INK[scheme];
  return {
    accent: ink.fill,
    // The brand defines no hover colour; a fill keeps its accent and the focus ring carries
    // the interaction state.
    accentHover: ink.fill,
    accentText: ink.on,
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
  "dark",
);

/** The Polaris Key brand's light tokens (full light parity, BRAND.md §3). */
export const polarisKeyLightTokens: PolarisThemeTokens = brandTokens(
  THEME_TOKENS.light,
  "light",
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
    welcomeTitle: "Welcome to {product}",
    signInSubtitle: "",
    // Neutral: the host's sign-in, not ours (no Polaris Key name on a neutral screen).
    oidcButtonLabel: "Sign in",
    useKeyLabel: "Use a license key",
    keyEntryLabel: "Enter your license key",
    keyEntryPlaceholder: "Paste your key",
    keySubmitLabel: "Activate license",
    orDivider: "or",
    deviceLimitHeading:
      "Your license is on {used} of {limit, plural, one {# device} other {# devices}}",
    deviceLimitBrowser:
      "Replace a device in your browser. {product} continues when you're done.",
    noMethodsLabel: "Sign-in is unavailable. Try again later.",
    differentKeyLabel: "Use a different key",
    handoffTitle: "Finish in your browser",
    handoffCheck: "Check the code there matches this one.",
    handoffCodeLabel: "Sign-in code",
    handoffUrl: "Or go to {url}",
    handoffExpires: "Code expires in {time}",
    handoffOpenLabel: "Open browser",
    handoffCopyLabel: "Copy code",
    handoffCopiedLabel: "Copied",
    handoffCancelLabel: "Cancel",
    handoffExpiredTitle: "Code expired",
    handoffExpiredBody:
      "The code expired before sign-in finished. Start again.",
    handoffAgainLabel: "Sign in again",
    errorTitle: "{product} couldn't start",
    graceTitle: "Offline grace",
    graceBody:
      "The licensing service can't be reached. You can keep using the app until the grace period ends.",
    graceDaysLeft:
      "Offline · {days, plural, one {# day} other {# days}} left to reconnect",
    graceLastDay: "Offline · reconnect today to keep using {product}",
    expiredTitle: "License expired",
    // The sign-in methods under the title are the action; no line repeats them.
    expiredBody: "",
    revokedTitle: "Signed out",
    revokedBody: "",
    versionTooOldTitle: "Update required",
    versionTooOldBody:
      "This version is no longer supported. Update the app to continue.",
    versionTooNewTitle: "Not available on this license",
    versionTooNewBody: "This build is newer than your license allows.",
    channelNotEntitledTitle: "Channel not included",
    channelNotEntitledBody:
      "Your license doesn't include this release channel.",
    loadingLabel: "Checking your license…",
    retryLabel: "Try again",
    freeDeviceLabel: "Replace a device",
    signOutLabel: "Sign out",
    notApplicableLabel: "This product is not licensed separately.",
    configTitle: "Settings",
    // "Managed" is the one term for a locked row.
    configSubtitle: "Values your administrator manages.",
    configEmpty: "No settings have been delivered for this product.",
    configEnforcedBadge: "Managed",
    configLocalBadge: "Overridden",
    configRemoteBadge: "Default",
    configOverrideLabel: "Override",
    configResetLabel: "Reset",
    configDisabledTitle: "Settings are not managed",
    configDisabledBody:
      "This product does not distribute managed settings, so there is nothing to show here.",
    updateTitle: "An update is available",
    updateProductTitle: "{product} {version}",
    updateBody: "",
    updateActionLabel: "Get the update",
    updateDismissLabel: "Later",
    updateUpToDateLabel: "You're up to date.",
    updateCheckFailed: "Couldn't check for updates.",
    updateCheckOffline: "Check your connection.",
    updateCheckUnavailable: "Updates aren't available for this app.",
    updateReadyTitle: "An update is ready",
    updateReadyProductTitle: "{product} {version} is ready",
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
    devicesCount: "{count, plural, one {# device} other {# devices}}",
    devicesEmpty: "No devices are using this license yet.",
    devicesLoadingLabel: "Loading…",
    deviceCurrentBadge: "This device",
    deviceUnnamed: "Unnamed device",
    deviceMeta: "{platform} · last seen {when}",
    deviceRenameActionLabel: "Rename",
    deviceRenameA11yLabel: "Rename {device}",
    deviceRenameLabel: "Device name",
    deviceRenameSubmitLabel: "Save",
    deviceRenameCancelLabel: "Cancel",
    deviceRemoveLabel: "Remove",
    deviceRemoveA11yLabel: "Remove {device}",
    deviceRemoveConfirm: "Remove {device}? It signs out of {product}.",
    deviceDisconnectLabel: "Disconnect",
    devicesUnsupportedTitle: "Device management is unavailable",
    devicesUnsupportedBody: "Manage your devices in your browser.",
    devicesManageLabel: "Manage devices",
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
  // The name is a placeholder no screen prints as the product's (`knownProductName`), and the
  // sign-in button stays "Sign in" (welcome.signIn): Polaris Key is named only in the opt-in
  // Powered-by line and the hand-off's address.
  productName: "Polaris Key",
};

/** The product's name when the integrator gave one (`copy.productName`), or `null` while it is
 *  a base theme's placeholder: "This app", or "Polaris Key", which names the platform rather
 *  than the product behind the gate. */
export function knownProductName(theme: PolarisTheme): string | null {
  const name = theme.copy.productName.trim();
  if (
    name === "" ||
    name === defaultTheme.copy.productName ||
    name === POLARIS_KEY_COPY.productName
  )
    return null;
  return name;
}

/** The product's name for copy that says what continues ("{product} continues when you're
 *  done"): the integrator's, else the neutral placeholder. Never the brand's own "Polaris Key",
 *  which names the platform and not the app behind the gate (B2). */
export function productLabel(theme: PolarisTheme): string {
  return knownProductName(theme) ?? defaultTheme.copy.productName;
}

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
    tokens: resolveProductAccent(
      { ...base.tokens, ...partial.tokens, ...perScheme },
      { ...partial.tokens, ...perScheme },
      scheme,
    ),
    copy: { ...base.copy, ...partial.copy },
    logo: partial.logo,
    poweredBy: partial.poweredBy ?? base.poweredBy,
  };
}

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Run an integrator's product accent through the accent resolver (UI-KITS.md §3.3, DL13): the
 * fill becomes the accent's `solid` for this scheme, its label `on`, and the focus ring the
 * accent's `focus`, each resolved against the grounds the kit draws on (the theme's background,
 * surface and sunken surface). A pink, a navy or a yellow can no longer give an unreadable
 * primary, and the ring follows the product's accent instead of a fixed violet or grey. A value
 * the integrator set beside the accent wins: an explicit `accentText` keeps the accent as given
 * (the integrator owns that pair), an explicit `ring` or `accentHover` stays. Tokens that are not
 * hex colours (`var(--app-accent)`) are the host's to keep readable and pass through.
 */
function resolveProductAccent(
  merged: PolarisThemeTokens,
  explicit: Partial<PolarisThemeTokens>,
  scheme: PolarisResolvedScheme,
): PolarisThemeTokens {
  const accent = explicit.accent;
  if (accent === undefined || !HEX_COLOUR.test(accent)) return merged;
  const grounds = [
    merged.background,
    merged.surface,
    merged.surfaceSunken,
  ].filter((g) => HEX_COLOUR.test(g));
  const c = resolveKitColors(
    accent,
    scheme,
    grounds.length > 0 ? grounds : undefined,
  );
  const ownsPair = explicit.accentText !== undefined;
  return {
    ...merged,
    accent: ownsPair ? merged.accent : c.primary,
    accentHover: explicit.accentHover ?? (ownsPair ? merged.accent : c.primary),
    accentText: ownsPair ? merged.accentText : c.onPrimary,
    ring: explicit.ring ?? c.focus,
  };
}

/**
 * The font the kit falls back to when its font token is `inherit` and the host page sets no font
 * of its own: the platform's UI face, never the browser's default serif.
 */
export const SYSTEM_FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** The computed `font-family` a page gets when it sets none: Times or plain `serif` in every
 *  engine (WebKit names it `-webkit-standard`). */
const BROWSER_DEFAULT_FONT =
  /^\s*(?:"?times new roman"?|"?times"?|serif|-webkit-standard)\s*$/i;

/** Whether a computed `font-family` is the browser's default rather than one the host set. */
export function isBrowserDefaultFont(fontFamily: string): boolean {
  return BROWSER_DEFAULT_FONT.test(fontFamily);
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
