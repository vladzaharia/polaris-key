// What a view model reads (ui-matrix.json `vocabulary.inputs`). Every member is a value an SDK
// already returns, a shape an approved plan fixes (plans/I-04.md's LicenseChoiceView and
// ReplaceView) or a kit-side value (the integrator's identity, the platform, the kit's events). A
// kit adapter maps its client's state onto this one shape, and every model reads only it.

import type {
  DeviceCodePhase,
  FormFactor,
  Os,
  Pending,
  ProgressPhase,
  Registration,
  ReplaceMode,
  SignInChannel,
  SignInEvent,
  SignInOutcome,
  SignInPresentation,
  ToastKind,
} from "./vocabulary.js";
import { SERVICES } from "./vocabulary.js";

/** The integrator's theme identity (UI-KITS.md §1.2): it wins over every other source. */
export interface IntegratorIdentity {
  name?: string;
  shortName?: string;
  developer?: string;
  /** A colour (`#rrggbb`), or `"core"` for Polaris violet. */
  accent?: string;
  accentDark?: string;
  /** True when the integrator supplies the product's icon. */
  icon?: boolean;
  /** The address a person types to sign in with a code (`driftkart.gg/tv`). */
  deviceCodeUrl?: string;
  poweredBy?: "line" | "badge";
}

/** Discovery's `core.presentation`, as the kit sees it through `PresentationSource` (HA-12). */
export interface PresentationMember {
  name: string;
  developerName?: string;
  accent?: string;
  accentDark?: string;
  /** True once `PresentationSource.icon()` returned verified bytes. */
  icon: boolean;
}

export interface BundleIdentity {
  slug: string;
  name?: string;
}

export interface Platform {
  os: Os;
  formFactor: FormFactor;
}

/** What the build offers; a member left out takes the default (`DEFAULT_CAPABILITIES`). */
export interface Capabilities {
  signIn: boolean;
  keyEntry: boolean;
  deviceCode: boolean;
  offlineActivation: boolean;
  trial: boolean;
  restore: boolean;
  purchase: boolean;
  enroll: boolean;
}

export const DEFAULT_CAPABILITIES: Readonly<Capabilities> = {
  signIn: true,
  keyEntry: true,
  deviceCode: true,
  offlineActivation: false,
  trial: false,
  restore: false,
  purchase: false,
  enroll: false,
};

/** client-core's boot stage machine (stage-matrix.json): the stage, its outcome and the emit. */
export interface StageInput {
  stage: string;
  outcome: string;
  emit?: { type: string; [k: string]: unknown };
}

export interface GateInput {
  /** The license status (`enums.json` licenseStatus). */
  status?: string;
  /** True while the license check runs and there is no status yet. */
  checking?: boolean;
  /** True when a cached license is being re-checked. */
  cached?: boolean;
  graceDaysLeft?: number;
  /** The license's allowed versions. */
  allowed?: { min?: string; max?: string };
}

export interface ActivationInput {
  /** `enums.json` activationResult. */
  result: string;
  code?: string;
  limit?: number;
  deviceCount?: number;
  /** PX-W8's refusal link: the page that frees a seat. */
  manageUrl?: string;
}

export interface SignInSession {
  presentation: SignInPresentation;
  replace: ReplaceMode;
  channel: SignInChannel;
  outcome?: SignInOutcome;
  /** False when opening the browser failed (DL14: the screen stays with Copy link). */
  browserOpened?: boolean;
  /** True while the browser's code is redeemed. */
  redeeming?: boolean;
  event?: SignInEvent;
  /** True when this sign-in added (a key) or issued (`new`, `create`, I-27 D4) the license. */
  issuedNow?: boolean;
  /** True when the seat was taken since the view loaded. */
  raced?: boolean;
  /** True when the pending sign-in grant lapsed (300 s). */
  grantExpired?: boolean;
}

export interface DeviceCodeInput {
  phase: DeviceCodePhase;
  secondsLeft?: number;
  /** The RFC 8628 user code, shown and copied exactly as served. */
  userCode?: string;
  /** The server's verification address. */
  verificationUri?: string;
}

/** plans/I-04.md §G: one license row of `LicenseChoiceView`. */
export interface LicenseChoiceRow {
  id: string;
  tierName: string;
  name: string | null;
  origin: string;
  access: "seats" | "account";
  seats: { used: number; limit: number | null };
  current: boolean;
  expiresAt: number | null;
  state: "free" | "full" | "blocked";
  blockedReason?: string;
  replace: { allowed: boolean; retryAfter: number | null } | null;
  freeDeviceUrl: string | null;
}

/** plans/I-04.md §G: `LicenseChoiceView`, field for field. */
export interface LicenseChoiceView {
  state: "choose" | "autoIssue" | "none";
  choices: LicenseChoiceRow[];
  keep: boolean;
  preselected: string | null;
  create: { tierName: string; access: string } | null;
  getLicense: {
    activateUrl: string;
    purchaseUrl: string | null;
    keyEntry: boolean;
  } | null;
}

/** plans/I-04.md §G: `ReplaceView`, field for field. */
export interface ReplaceView {
  licenseId: string;
  seats: { used: number; limit: number | null };
  devices: {
    id: string;
    label: string | null;
    platform: string | null;
    deviceType: string | null;
    lastSeen: number;
    leastRecent: boolean;
    activeNow: boolean;
    thisBrowser: boolean;
  }[];
  replace: { allowed: boolean; retryAfter: number | null };
}

export interface DeviceInput {
  name: string | null;
  platform: string | null;
  formFactor: string | null;
  lastSeenDays: number | null;
  /** True only when the runtime knows this row is the device it runs on. */
  current: boolean;
}

export interface UpdateInput {
  /** `enums.json` updateAction. */
  action: string;
  /** `enums.json` outletKind. */
  outlet?: string;
  reason?: string;
  version?: string;
  mandatory?: boolean;
  critical?: boolean;
  progress?: { phase: ProgressPhase; fraction?: number };
}

export interface ReleaseNoteInput {
  version: string;
  date: string;
  /** Plain text: release notes never execute markup. */
  notes: string;
}

export interface ConfigRowInput {
  key: string;
  type: string;
  source: string;
  locked: boolean;
  org?: string;
  value?: unknown;
  min?: number;
  max?: number;
  advanced?: boolean;
}

/** Everything a view model reads. Every member is optional; see `vocabulary.inputs`. */
export interface UiInput {
  integrator?: IntegratorIdentity;
  /** `null`: discovery carries no presentation. */
  presentation?: PresentationMember | null;
  bundle?: BundleIdentity;
  platform?: Platform;
  /** The enabled opt-in services, closed under `requires`. Absent: all on. */
  services?: readonly string[];
  registration?: Registration;
  capabilities?: Partial<Capabilities>;
  stage?: StageInput;
  gate?: GateInput;
  pending?: Pending;
  /** True while the component's data loads. */
  loading?: boolean;
  /**
   * Milliseconds since the request a loading state waits on started. A loading state shows
   * nothing until `LOADING_DELAY_MS` (DL7), then the identity, a muted label and the shimmer.
   * Absent: the delay has passed.
   */
  elapsedMs?: number;
  keyField?: { text: string; submitted?: boolean };
  activation?: ActivationInput;
  offline?: {
    copied?: boolean;
    file?: boolean;
    submitted?: boolean;
    verified?: boolean;
  };
  signIn?: SignInSession;
  deviceCode?: DeviceCodeInput;
  choices?: LicenseChoiceView;
  replaceView?: ReplaceView;
  /** The row the person picked in LicenseChoice (a license id, `keep` or `create`). */
  selected?: string;
  devices?: DeviceInput[];
  browserMode?: boolean;
  edit?: { kind: "rename" | "remove" | "value"; device?: string };
  saved?: boolean;
  replacement?: { device: string; outcome: "done" | "failed" };
  update?: UpdateInput;
  releaseNotes?: ReleaseNoteInput[];
  config?: ConfigRowInput[];
  account?: { signedIn: boolean; holder?: string };
  entitlement?: { name: string; entitled: boolean };
  offers?: { available: boolean; purchased?: boolean };
  toast?: { kind: ToastKind };
  error?: { code: string };
  /** The should tier: Cloud Sync's state, and whether the release channel is locked. */
  cloudSync?: {
    state: "synced" | "syncing" | "offline" | "conflict" | "error";
    signedIn?: boolean;
  };
  channel?: { locked: boolean };
}

/** The input with its context resolved once: every model reads these, never the raw members. */
export interface Context {
  readonly input: UiInput;
  readonly caps: Readonly<Capabilities>;
  readonly platform: Platform | null;
  readonly registration: Registration;
  /** True when `slug` is enabled. */
  on(slug: string): boolean;
}

export function contextOf(input: UiInput): Context {
  const enabled = new Set(input.services ?? SERVICES.map((s) => s.slug));
  return {
    input,
    caps: { ...DEFAULT_CAPABILITIES, ...(input.capabilities ?? {}) },
    platform: input.platform ?? null,
    registration: input.registration ?? "requires-license",
    on: (slug) => enabled.has(slug),
  };
}

/** The enabled services left when `off` are turned off, closed under `requires` (ST-38). */
export function servicesWithout(...off: string[]): string[] {
  const down = new Set(off);
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of SERVICES)
      if (!down.has(s.slug) && s.requires.some((r) => down.has(r))) {
        down.add(s.slug);
        changed = true;
      }
  }
  return SERVICES.map((s) => s.slug).filter((s) => !down.has(s));
}

// ── Platform ──────────────────────────────────────────────────────────────────────────────────

/**
 * How a platform is laid out:
 *
 *   desktop   a Mac, Windows or Linux computer: the browser is one click away, no QR
 *   web       a page in a browser
 *   handheld  a phone or tablet: browses, coarse pointer, no QR (DL14)
 *   tv        a TV that cannot browse: a QR beside the code, the address on its own line
 *   console   a pad-only screen (Godot on a TV, a handheld in game mode): a QR the person can
 *             enlarge, the address inside the sentence
 */
export type PlatformClass = "desktop" | "web" | "handheld" | "tv" | "console";

export function platformClass(p: Platform | null): PlatformClass {
  if (!p) return "desktop";
  if (p.formFactor === "tv")
    return p.os === "android" || p.os === "tvos" ? "tv" : "console";
  if (p.os === "web") return "web";
  if (
    p.formFactor === "iphone" ||
    p.formFactor === "ipad" ||
    p.formFactor === "phone" ||
    p.formFactor === "tablet" ||
    p.os === "ios" ||
    p.os === "android" ||
    p.os === "watchos" ||
    p.os === "visionos"
  )
    return "handheld";
  return "desktop";
}

/** True where the device can open a browser itself (never a TV or a pad-only screen). */
export function canBrowse(p: Platform | null): boolean {
  const c = platformClass(p);
  return c !== "tv" && c !== "console";
}

/** True where a pointer is coarse: a text field is never focused on appear (DL9). */
export function coarsePointer(p: Platform | null): boolean {
  const c = platformClass(p);
  return c === "handheld" || c === "tv" || c === "console";
}

/**
 * True where a destructive Replace opens the platform's own confirmation (SIGN-IN.md §3.6 step
 * 3b, D-80): macOS, iOS, iPadOS, Android and GNOME; on Windows only inline (a ContentDialog), and
 * never on the web, on a TV or in a Windows sheet, where a dialog cannot stack on a dialog.
 */
export function systemConfirm(
  p: Platform | null,
  presentation: SignInPresentation,
): boolean {
  const c = platformClass(p);
  if (c === "web" || c === "tv" || c === "console") return false;
  if (p?.os === "windows") return presentation === "inline";
  return true;
}
