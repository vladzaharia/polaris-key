// The closed vocabularies the view models speak (conformance/corpus/v2/ui-matrix.json
// `vocabulary`, plans/UK-02b.md §4). The matrix pins them for every language; a kit reads them
// from here instead of spelling a string.

/** The UI matrix version these models implement (`uiMatrixVersion`, the generated
 *  `UI_MATRIX_VERSION` of every SDK's constants). The runner refuses a file of another version. */
export const UI_MATRIX_VERSION = 3;

/** UI-KITS.md §4.1: every component, must and should. */
export const COMPONENTS = [
  "PolarisKeyGate",
  "Boot",
  "Welcome",
  "SignIn",
  "SignInHandoff",
  "Activate",
  "OfflineActivation",
  "DeviceLimit",
  "LicenseChoice",
  "Devices",
  "UpdatePrompt",
  "UpdateProgress",
  "ReleaseNotes",
  "StatusScreen",
  "GraceBanner",
  "AccountAndLicense",
  "Settings",
  "Paywall",
  "EntitlementGate",
  "CloudSyncStatus",
  "About",
  "ChannelPicker",
  "Toast",
] as const;
export type ComponentName = (typeof COMPONENTS)[number];

/** The reserved state of a component its service turns off: the drop-in renders nothing and a
 *  styled part renders empty (plans/UK-02b.md §4.3). */
export const HIDDEN = "hidden";

/** The actions a view offers, named by what they do (ui-matrix.json `vocabulary.actions`). */
export const ACTIONS = [
  "open-card",
  "open-browser",
  "replace-in-browser",
  "open-manage-url",
  "copy-link",
  "retry",
  "cancel",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Which controls perform each action, by their label's copy key (`vocabulary.actionKeys`). A
 *  view's actions are derived from the controls its copy shows, so the two never disagree. */
export const ACTION_KEYS: Readonly<Record<Action, readonly string[]>> = {
  "open-card": ["signin.desktop.continue", "signin.email.continue"],
  "open-browser": ["signin.handoff.again", "signin.handoff.openBrowser"],
  "replace-in-browser": [],
  "open-manage-url": ["deviceLimit.openBrowser", "devices.manage"],
  "copy-link": ["signin.handoff.copyLink", "a11y.copyAddress"],
  retry: [
    "common.tryAgain",
    "common.reconnect",
    "signin.again",
    "signInHandoff.newCode",
  ],
  cancel: ["common.cancel"],
};

/** The opt-in services (tools/services.json), and what each requires (ST-38's closure rule). */
export const SERVICES: readonly {
  slug: string;
  requires: readonly string[];
}[] = [
  { slug: "license", requires: [] },
  { slug: "config", requires: [] },
  { slug: "release", requires: [] },
  { slug: "distribution", requires: ["release"] },
  { slug: "update", requires: ["distribution"] },
  { slug: "identity", requires: [] },
  { slug: "sync", requires: ["config", "identity"] },
];

export const OS = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
  "tvos",
  "visionos",
  "watchos",
] as const;
export type Os = (typeof OS)[number];

export const FORM_FACTORS = [
  "iphone",
  "ipad",
  "mac",
  "phone",
  "tablet",
  "computer",
  "tv",
  "other",
] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];

export const PRESENTATIONS = ["inline", "sheet", "browser"] as const;
export type SignInPresentation = (typeof PRESENTATIONS)[number];
export const REPLACE_MODES = ["inline", "browser"] as const;
export type ReplaceMode = (typeof REPLACE_MODES)[number];
export const CHANNELS = ["browser", "device-code"] as const;
export type SignInChannel = (typeof CHANNELS)[number];
/** `session.wait()`'s outcomes (plans/I-04.md §G.9). */
export const OUTCOMES = [
  "pending",
  "choose",
  "signedIn",
  "cancelled",
  "expired",
] as const;
export type SignInOutcome = (typeof OUTCOMES)[number];
/** The kit events the form reacts to. */
export const EVENTS = [
  "use-code",
  "copy-link",
  "have-key",
  "open-replace",
  "confirm-replace",
  "reopen",
] as const;
export type SignInEvent = (typeof EVENTS)[number];
export const DEVICE_CODE_PHASES = [
  "starting",
  "waiting",
  "slow-down",
  "ok",
  "denied",
  "expired",
  "cancelled",
] as const;
export type DeviceCodePhase = (typeof DEVICE_CODE_PHASES)[number];
export const REGISTRATION = [
  "open",
  "requires-identity",
  "requires-license",
] as const;
export type Registration = (typeof REGISTRATION)[number];
export const PENDING = [
  "sign-in",
  "activate",
  "replace",
  "save",
  "purchase",
  "restore",
] as const;
export type Pending = (typeof PENDING)[number];
export const TOASTS = [
  "update",
  "copied",
  "warning",
  "error",
  "progress",
] as const;
export type ToastKind = (typeof TOASTS)[number];
export const PROGRESS_PHASES = [
  "queued",
  "download",
  "verify",
  "paused",
  "install",
  "failed",
  "done",
] as const;
export type ProgressPhase = (typeof PROGRESS_PHASES)[number];

/** Where a theme's accent came from (UI-KITS.md §1.2, §3.4). */
export const ACCENT_SOURCES = [
  "integrator",
  "product",
  "icon",
  "core",
  "ink",
  "host",
] as const;
export type AccentSource = (typeof ACCENT_SOURCES)[number];
export const COLOR_SCHEMES = ["system", "dark", "light"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export const PRESETS = ["polaris-key", "native"] as const;
export type Preset = (typeof PRESETS)[number];
export const KITS = [
  "elements",
  "react",
  "swiftui",
  "compose",
  "godot",
  "qt",
  "terminal",
] as const;
export type Kit = (typeof KITS)[number];
