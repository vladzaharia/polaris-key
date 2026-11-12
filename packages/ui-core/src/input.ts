// What a view model reads (ui-matrix.json `vocabulary.inputs`). Every member is a value an SDK
// already returns, a shape an approved plan fixes (plans/I-04.md's LicenseChoiceView and
// ReplaceView) or a kit-side value (the integrator's identity, the platform, the kit's events). A
// kit adapter maps its client's state onto this one shape, and every model reads only it.
//
// Display facts: a few strings name a value no SDK result carries as text (a tier, a download
// size, the date grace ends). Each is a member of the input holding display-ready text, formatted
// for the kit's locale by whoever supplies it ("52 MB", "Dec 4, 2026"), and a model passes it into
// its strings as it is: ui-core never guesses one, so a screen drawn without it shows the string's
// `{name}` (copy.ts) and nothing that reads like a fact. The numbers the contract does carry (the
// boot stage's byte counts) are formatted by the model, in `locale`.

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
  /** The app's own version as the person reads it ("2.4.1"): About and the account pane show it,
   *  and the update prompt's "You have …" names it. */
  version?: string;
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
  /** The date offline grace ends as the person reads it ("Dec 4, 2026"): `graceDaysLeft` says how
   *  long, this says until when (the SDK's `graceUntil`, formatted for the kit's locale). */
  graceDate?: string;
  /** The license's allowed versions. */
  allowed?: { min?: string; max?: string };
}

export interface ActivationInput {
  /** `enums.json` activationResult. */
  result: string;
  code?: string;
  limit?: number;
  deviceCount?: number;
  /** An `ok` result's license: its tier's name ("Pro") and its term as the person reads it
   *  ("Lifetime", "Until Dec 4, 2026"). The key field's verdict line names both. */
  tier?: string;
  term?: string;
  /** PX-W8's refusal link: the page that frees a seat. For `key-entry-limit`, the page that adds
   *  the key to the person's account. */
  manageUrl?: string;
  /** `license_owned`'s sign-in page (`<origin>/signin?product=<slug>`): the kit's fallback when
   *  it cannot start its own sign-in. It carries no key and names no account. */
  signInUrl?: string;
  /** The license's key entries after a key activation, or on the `key-entry-limit` refusal. */
  keyEntries?: { used: number; limit: number };
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
  /**
   * The form's step after a license key with no account (UK-42): `key-done` draws ActivateDone's
   * body, `attach` AddToAccount's (its `addToAccount.step`), `added` its added state. It wins over
   * every step except an error and an automatic sign-in step.
   */
  step?: HolderFormStep;
}

/** The sign-in form's steps that belong to activation without an account. */
export type HolderFormStep = "key-done" | "attach" | "added";

/** Who holds the license that just activated (`profile.email` of its document). */
export interface LicenseHolderInput {
  /** The address the license was sent to. Empty or absent: floating, held by the key alone; set:
   *  waiting for that email to sign in. The models mask it themselves (`maskEmail`). */
  email?: string;
  /** Where Add your name and email goes for this license (UK-43.2). `portal`: the kit has no in-app
   *  channel, so every Add control says it opens Polaris Locker (an external link) and the action
   *  opens the manage URL. Absent or `app`: the in-app form. `activateDone.addIn` says the same
   *  for ActivateDone alone and wins there. */
  addIn?: "portal" | "app";
}

/** ActivateDone's display facts (strings its supplier formatted, like `ActivationInput`). */
export interface ActivateDoneInput {
  /** The tier's name ("Pro"); absent, `activation.tier`. */
  tier?: string;
  /** The term as the person reads it ("Lifetime", "Renews 3 Mar"); absent, `activation.term`. */
  term?: string;
  /** The device kind already worded ("computer", "phone"). */
  deviceKind?: string;
  /** This device's place among the license's devices, and the limit. */
  position?: number;
  limit?: number;
  /** The person came back from AddToAccount (Cancel): focus returns to the control that opened it
   *  (DL9), not to the primary. */
  returned?: boolean;
  /** Where Add your name and email goes. `portal` (Polaris Locker's page, an external link) says so
   *  in the action's label even with Identity on; absent or `app`, the in-page form. */
  addIn?: "portal" | "app";
  /** The channel is still being read: the action shows busy until it is known. */
  addBusy?: boolean;
}

/** AddToAccount's steps (SIGN-IN.md §3.9, frames 43 to 46). */
export type AddToAccountStep =
  | "form"
  | "invalid"
  | "busy"
  | "added"
  | "owned"
  | "email-bound"
  | "other-account"
  | "failed";

export interface AddToAccountInput {
  step: AddToAccountStep;
  /** `invalid`: which field the person must fix. */
  field?: "name" | "email" | "both";
  /** The device kind already worded, for the lines that name this device. */
  deviceKind?: string;
  /** `other-account`: the email the person typed and the one of the account that signed in,
   *  both already masked (`a•••@example.com`). A sentence that names one leaves out an empty one. */
  typedEmail?: string;
  signedEmail?: string;
  /** Opened from the app's Settings, not from the Done step: `added` closes ("Done") instead of
   *  saying Start using, because the app is already running. */
  fromSettings?: boolean;
}

/** Automatic sign-in's own steps (plans/auto-sign-in.md §3), drawn in the sign-in form's body. */
export type AutoSignInStep =
  | "confirm"
  | "link-offer"
  | "link-done"
  | "link-conflict"
  | "nearby-prompt"
  | "nearby-wait"
  | "nearby-done"
  /** Several devices answered: the person chooses which to ask (UXR-47b B2). */
  | "nearby-choose"
  /** Nobody answered in a while (UXR-47b M4). */
  | "nearby-none-found"
  /** How a nearby request ended (UXR-47b B1): each draws its own screen. */
  | "nearby-denied"
  | "nearby-expired"
  | "nearby-not-nearby"
  | "nearby-failed"
  | "nearby-cancelled"
  | "nearby-signed-out"
  | "nearby-rate-limited"
  | "nearby-unavailable"
  | "device-limit";

export interface AutoSignInInput {
  step: AutoSignInStep;
  /** The account's email; absent when the provider shared none (Sign in with Apple, private). */
  email?: string;
  /** The exchange that produced the grant; the confirm line names the provider by it when there
   *  is no email. Absent after a Polaris Locker sign-in (no account line, never "your Apple
   *  Account" by default). */
  kind?: "apple" | "google" | "gamecenter" | "pgs";
  /** Whom the provider's identity is shared with: `global` across apps, `developer` per
   *  developer. Apple is always per developer; absent is treated as `unknown` (per developer). */
  reach?: "global" | "developer" | "unknown";
  /** The confirm step's license line: one created when the person continues, or one they hold. */
  license?: "new" | "existing";
  /** True on a first sign-in or when the consent changed: the confirm lists what the app also gets. */
  alsoGets?: boolean;
  /** The code the waiting device shows, which the person taps on the approving device. */
  code?: string;
  /** The `device-limit` step: the refusal's `manageUrl`, where a device is replaced. Absent or
   *  invalid: the step names the fix in words and offers no Replace. */
  manageUrl?: string;
  /** The license an existing-license confirm names: the arguments of its license line
   *  (`signin.consent.licenseLine`). `term` is `perpetual` or the end as epoch seconds. */
  anchor?: {
    name: string;
    term: "perpetual" | number;
    position?: number;
    limit?: number;
  };
  /** The name this device goes by in the license line. */
  device?: string;
  /** The tier a new license is created at (the confirm's "New: {tier} license" line), read from
   *  the license list when no account is signed in yet. */
  tier?: string;
}

/** The approving device's side of nearby sign-in. Absent: the account-menu entry. */
export interface NearbyApprovalInput {
  step:
    | "entry"
    | "ask"
    | "approved"
    | "not-nearby"
    | "mismatch"
    | "denied"
    | "expired"
    | "device-limit"
    | "choose"
    | "account-required"
    | "rate-limited"
    /** The screen is open and nothing has asked yet (UXR-47b B3). */
    | "listening"
    /** The advert stopped after declined requests (UXR-47b B4). */
    | "stopped"
    /** The Worker or the network failed; nothing was approved (UXR-47b M2). */
    | "failed";
  /** The new device's friendly name. */
  device?: string;
}

/**
 * Pairing with someone nearby (CC-19.9, `cloudConnect.links.pair`). `device` is the label the other
 * device reported: nothing authenticates it, so the screen words it as reported. `code` is the
 * pairing code both people compare, drawn as served. `categories` are the data categories this app
 * asks both people to approve (ids, at most 8); the screen lists them before the confirm button.
 * `reason` is how a session that reached the code ended without a link. `unavailable`: links are off
 * for this product (the typed `connect_links_disabled`).
 */
export interface LinkPairingInput {
  step: "open" | "code" | "confirm" | "linked" | "failed" | "unavailable";
  device?: string;
  code?: string;
  categories?: readonly string[];
  reason?: "declined" | "timeout" | "full" | "closed";
}

/** One paired device of Pair with a Code (`LocalLinkInfo` of `cloudConnect.localLinks.list`). */
export interface PairedDeviceInput {
  id: string;
  /** The name this device holds for it (the label it sent, or the person's rename). */
  label: string | null;
  /** Unix seconds, or null when it has never been seen. */
  lastSeen: number | null;
  /** True when the other device may find and connect to this one. */
  reachable: boolean;
  /** The other device's platform as it reported it (a `Platform` os value), or null. Display only. */
  platform?: string | null;
}

/**
 * Pair with a Code (CC-29K, `cloudConnect.localLinks`): two devices of one app on one network pair
 * by an 8-digit code or a QR, with no account. `choose` is the entry; one device `show`s the code
 * (`closed` once its window ended), the other `enter`s it (`joining` while it looks) and the
 * shower is asked to `confirm`; the entering device `waiting`s for that. `paired` and `failed` end
 * it, `network-blocked` and `off` answer instead of it. Every member is data a model computed;
 * nothing here is a secret beyond the code the screen shows.
 */
export interface LocalPairingInput {
  step:
    | "choose"
    | "opening"
    | "show"
    | "closed"
    | "enter"
    | "joining"
    | "confirm"
    | "waiting"
    | "paired"
    | "failed"
    | "network-blocked"
    | "off"
    | "scan-prompt"
    | "scan"
    | "camera-off";
  /** choose, enter and the scan steps: this device can scan a code (a phone with a camera, or the
   *  Play build's scanner). Scan a code leads on choose and replaces the showing link on enter. */
  canScan?: boolean;
  /** choose: the scanner is the host's own sheet (Google's on Android), with no scan screens of ours:
   *  typing is a link on choose, and `scanShares` draws what each shares before the sheet opens. */
  sheetScan?: boolean;
  /** choose, with `sheetScan`: the categories come before Scan a code (the person's consent). */
  scanShares?: boolean;
  /** scan, and choose with `sheetScan`: why the last scan did not pair; the scan entry stays. */
  scanNotice?: "other-app" | "not-found" | "stale" | "not-ready" | "preparing";
  /** scan: the camera is in use elsewhere or interrupted; typing stays one link away. */
  cameraBusy?: boolean;
  /** choose: the system has not asked about the local network yet. */
  prePrompt?: boolean;
  /** choose: this device holds the most pairings, so neither button works. */
  full?: boolean;
  /** show: the code as two groups of four (`4812 3456`). */
  code?: string;
  /** show: the text the QR encodes. */
  qr?: string;
  /** show: seconds left of the window's 5 minutes. */
  secondsLeft?: number;
  /** show: which of the window's two views is open; absent is the code. The QR view is the state
   *  `show-qr`. Switching never renews the window. */
  view?: "qr";
  /** show: the window ran out and nothing renewed it. The open view stays, dimmed, says the code
   *  expired and offers Show a new code in place. */
  expired?: true;
  /** show: the notice under the time row. */
  notice?: "rotated" | "declined" | "blocked" | "guessing";
  /** show and confirm: a press is being answered; its control keeps its label and is unavailable. */
  busy?: "pair" | "not-now" | "new-code";
  /** closed: why the window ended. */
  closedBy?: "too-many-tries" | "expired";
  /** closed: seconds left of the 30-second wait after Too many tries; 0 or absent when none. */
  cooldownLeft?: number;
  /** closed: the second Too many tries in a row. */
  warn?: boolean;
  /** enter: what the person typed (digits, grouped as typed). */
  entry?: string;
  /** enter: the answer to the last try, shown under the field or as a notice. */
  error?: "wrong" | "spent" | "too-many" | "not-found" | "not-a-code";
  /** enter: dials left for the typed first two digits (0, 1, 2), or null until two are typed. */
  triesLeft?: number | null;
  /** enter, joining: Pair answers its reason instead of sending. */
  pairDisabled?: boolean;
  /** The data categories this app asks both people to approve (ids). */
  categories?: readonly string[];
  /** The other device's label as it reported it (unauthenticated). */
  device?: string;
  /** failed: how a session that reached the other device ended without a pairing. */
  reason?: "declined" | "timeout" | "full" | "closed";
  /** network-blocked: the platform can open its settings. */
  canOpenSettings?: boolean;
  /** paired: the new pairing was kept with Can connect off because 8 already are. */
  cantConnect?: boolean;
  /** paired: the name could not be saved on this device; the screen stays. */
  nameError?: "failed";
  /** The most paired devices that can connect at once. */
  max?: number;
}

/** The list of paired devices (CC-29K). `devices` is `localLinks.list()`; the rest is what the
 *  person is doing to one row, and the answers the app's own connections gave. */
export interface PairedDevicesInput {
  step: "loading" | "list" | "renaming" | "forgetting" | "load-failed" | "off";
  devices?: readonly PairedDeviceInput[];
  /** renaming and forgetting: the row. */
  target?: string;
  /** renaming: why the name was refused (`failed`: the store could not keep it). */
  renameError?: "long" | "empty" | "failed";
  /** forgetting: the store could not forget it; the question stays. */
  forgetError?: boolean;
  /** What the app's own connection to a device answered; `id` is the device, for Try again. */
  notice?: {
    device: string;
    kind: "not-found" | "busy" | "unknown";
    id?: string;
  };
}

/** A contact's offer to send something (D-8): consent per transfer. `device` is the contact's
 *  label, `name` what it offers, both text the other side chose. */
export interface TransferOfferInput {
  step: "ask" | "receiving" | "done" | "failed";
  device?: string;
  name: string;
  /** The size in bytes, when the contact said. */
  size?: number;
  /** The media type, when the contact said (text the contact chose). */
  type?: string;
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
  /** The store's name ("Steam", "App Store") on a store-origin license; fills `{store}`. */
  store?: string;
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
  /** The device's id, which a host needs to rename or remove it (the kit's events carry it). */
  id?: string;
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
  /** The new version. */
  version?: string;
  mandatory?: boolean;
  critical?: boolean;
  /** The download's size as the person reads it ("52 MB"). */
  size?: string;
  /** The store's name ("Microsoft Store"), for "Open …" when the outlet is a store the models
   *  hold no name for; a name given here wins over the outlet's own. */
  store?: string;
  /** The terminal command that installs it ("winget upgrade Harbor.Tidewater"), where a package
   *  manager does. */
  command?: string;
  progress?: {
    phase: ProgressPhase;
    fraction?: number;
    /** What has downloaded and the whole, as the person reads them ("38 MB", "61 MB"). */
    size?: string;
    total?: string;
    /** The time left as the person reads it ("20 seconds", "4:12"). */
    timeLeft?: string;
  };
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
  /** The catalog entry's name for the setting; absent, the key read as words. */
  label?: string;
  /** The value as the person reads it ("48,000 Hz", "WAV"): drawn for a locked row. */
  display?: string;
  /** The choices of an enum setting, in the catalog's order: a select. */
  options?: readonly { value: string; label: string }[];
  /** The slider's step for a bounded number; absent, a whole number when both bounds are. */
  step?: number;
  /** The longest a text value may be. */
  maxLength?: number;
}

/** Everything a view model reads. Every member is optional; see `vocabulary.inputs`. */
export interface UiInput {
  integrator?: IntegratorIdentity;
  /** `null`: discovery carries no presentation. */
  presentation?: PresentationMember | null;
  bundle?: BundleIdentity;
  platform?: Platform;
  /** The BCP 47 locale the kit shows its strings in: the models format the numbers the contract
   *  carries (the boot stage's byte counts) in it. Absent: English. */
  locale?: string;
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
    /** The request code the person sends to whoever issued the license (shown, copied, a QR). */
    requestCode?: string;
    /** The activation response the person pasted or loaded. */
    response?: string;
  };
  signIn?: SignInSession;
  /** The license's holder (UK-42): drives ActivateDone and the AccountAndLicense row. Absent: the
   *  models do not know, and draw what they drew before. */
  licenseHolder?: LicenseHolderInput;
  /** ActivateDone's display facts; absent, ActivateDone is hidden. */
  activateDone?: ActivateDoneInput;
  /** AddToAccount's step; absent, AddToAccount is hidden. */
  addToAccount?: AddToAccountInput;
  /** The sign-in provider the methods step's row names ("Apple", "Google", "Steam"), and the one a
   *  failed sign-in names. Absent: "Polaris Locker", the sign-in the generic row opens. */
  provider?: string;
  deviceCode?: DeviceCodeInput;
  /** Automatic sign-in's step, shown in the sign-in form (needs `signIn`). */
  autoSignIn?: AutoSignInInput;
  /** Nearby approval on the device that is already signed in. */
  nearbyApproval?: NearbyApprovalInput;
  /** Pairing with someone nearby; absent, LinkPairing is hidden. */
  linkPairing?: LinkPairingInput;
  /** A contact's offer to send something; absent, TransferOffer is hidden. */
  transferOffer?: TransferOfferInput;
  /** Pair with a Code; absent, LocalPairing is hidden. */
  localPairing?: LocalPairingInput;
  /** The paired devices; absent, PairedDevices is hidden. */
  pairedDevices?: PairedDevicesInput;
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
  /** `holder` is the person's display name, `tier` the license's tier name ("Pro"). */
  account?: {
    signedIn: boolean;
    holder?: string;
    tier?: string;
    /** Seats in use and the limit (`null`: no limit), for "2 of 3". */
    devices?: { used: number; limit: number | null };
    /** True when the app updates itself. */
    autoUpdate?: boolean;
    /** False when the host has no page to open for "Manage": the button is left out. Absent
     *  means it can (the web kits' page link). */
    canManage?: boolean;
  };
  /**
   * The host can renew an expired license. `url` is the https page Renew opens; left out, the
   * host handles the press itself (`pk-action` / `onAction`). Without it, StatusScreen draws
   * Use another license alone.
   */
  renew?: { url?: string };
  /** `tier` is the tier that unlocks it ("Pro"), which the paywall and the lock name. */
  entitlement?: { name: string; entitled: boolean; tier?: string };
  offers?: {
    available: boolean;
    purchased?: boolean;
    /** What can be bought, price and term display-ready ("$29", "per year"). */
    items?: { id: string; name: string; price: string; term?: string }[];
    /** The https store or portal page that opens when purchases happen outside the app. */
    url?: string;
  };
  /** `closesIn` is how long an auto-closing toast stays ("8 seconds"), for the screen reader. `left` (key-entries) is the key entries the license has left. */
  toast?: { kind: ToastKind; closesIn?: string; left?: number };
  error?: { code: string };
  /** The should tier: Cloud Sync's state, and whether the release channel is locked. */
  cloudSync?: {
    state:
      | "synced"
      | "syncing"
      | "offline"
      | "conflict"
      | "error"
      | "locked"
      | "ring-changed"
      | "transferring"
      | "waiting"
      | "transfer-failed";
    signedIn?: boolean;
    /** The host handles Review for a conflict; without it the line stands alone. */
    canReview?: boolean;
    /** When it last synced, relative ("2 min ago"). */
    lastSynced?: string;
    /** While `transferring`: display-ready sizes, both or neither ("38 MB", "61 MB"), and the
     *  counted fraction (0 to 1) that fills the bar; without it the bar is indeterminate. */
    transfer?: { size?: string; total?: string; fraction?: number };
    /** While `waiting`: what the transfer waits for (default network). */
    reason?: "network" | "battery" | "background";
  };
  /** SaveConflict (U-22.K): the same save changed on two devices. `remote: null` means the other
   *  copy was deleted. `bothAvailable` is true only with a free slot of the 16. `keep` is the
   *  choice being applied (keeping), applied (kept) or that failed. `when` and `device` are
   *  display-ready. */
  saveConflict?: {
    step: "choose" | "keeping" | "kept" | "failed";
    local?: { when?: string };
    remote?: { when?: string; device?: string } | null;
    bothAvailable?: boolean;
    keep?: "local" | "remote" | "both";
    /** The version the app knows was saved later, from its own metadata and never from the
     *  `when` strings. It tags that card and chooses, fills, focuses and reorders nothing; it is
     *  ignored when the other copy was deleted. */
    newer?: "local" | "remote";
    /** On the choose step: a choice was being applied and the other copy changed again, so
     *  nothing was applied and the versions shown are the new ones. Adds one line saying so. */
    reopened?: boolean;
  };
  /** UnlockSync's step (U-42). `nearby` says the host could unlock from a nearby device:
   *  v0.10.0 never offers it, because NearbyApproval does not ship. */
  unlockSync?: {
    step:
      | "code"
      | "invalid"
      | "working"
      | "failed"
      | "start-over-failed"
      | "no-code"
      | "start-over";
    nearby?: boolean;
    /** While `working`: which control carries the progress (default Unlock). Draw-only: the
     *  model's view does not read it. */
    busy?: "unlock" | "start-over";
  };
  /** RecoveryCode (U-42). The code is never an input: the kit draws it from the host, once. */
  recoveryCode?: { saved?: boolean };
  /** RingChange (U-42). `by` is the device that wrapped (`changed.by`); `served` is the ring the
   *  person was shown (`changed.served`), the one value `acceptRingChange` takes. */
  ringChange?: {
    by?: string;
    served?: { ringId: string; epoch: number; rootKid: string };
    /** Accepting did not open a root: the screen says so; Accept stays available. */
    failed?: boolean;
    /** Accept is running: its control shows progress and ignores presses. Draw-only. */
    busy?: boolean;
  };
  /** `store` is the store that fixes the channel ("App Store", "Google Play", "Steam"). */
  channel?: {
    locked: boolean;
    store?: string;
    /** The channel in use ("stable", "beta") and the ones on offer. */
    current?: string;
    options?: string[];
  };
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
