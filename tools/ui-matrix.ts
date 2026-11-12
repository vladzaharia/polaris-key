// `conformance/corpus/v2/ui-matrix.json`: the UI state matrix (plans/UK-02.md §3.5 and §4,
// executed by plans/UK-02b.md).
//
// Layer (c) of every UI kit (docs/design/UI-KITS.md §1.3) is one state machine per component,
// ported to ui-core, the Swift presentation core, Kotlin `commonMain`, the Godot controllers and
// `polaris_key.ui.core`. This file pins it once for all of them: each component row gives an input
// (values an SDK already returns, shapes an approved plan fixes, or kit-side values) and the
// component, state, copy keys and actions a model must answer. The `theme` family pins theme
// resolution and the `i18n` family the catalog lookup and the ICU-subset formatter.
//
//   gate · activate · signIn · deviceLimit · devices · update · settings · paywall
//                {name, input, expect: {component, state, copy, actions?}, mustNot?}
//   theme        {name, input, expect: {name, accentSource, colorScheme, icon, preset}}
//   i18n         {name, locale, key, args, overrides?, expect}
//   cli          {verbs, mount, help, gate, outcomes, stdin, capabilities, exit}: the terminal
//                drop-in contract (plans/UK-51.md), one object with typed sections
//
// THE RUNNER CONTRACT (plans/UK-02b.md §5). A runner reads the file from the checkout (Godot from
// its `res://` mirror), checks `uiMatrixVersion` against its generated `UI_MATRIX_VERSION`, runs
// every row of every family without skipping one, drives the headless model `expect.component`
// names with the row's input (a member the input omits takes `vocabulary.defaults`), and compares
// `state`, the sorted `copy` and the sorted `actions` (absent means none). It tags its tests
// `@pkey-feature ui.<x>` and names "ui-matrix.json" in a string literal with the family.
//
// NO REFERENCE STATE MACHINE (plans/UK-02b.md §10). Component rows are authored and checked for
// structure; the five runners are the independent implementations. Theme rows are checked against
// the resolution order of UI-KITS §1.2 and §3.4, and i18n expectations are computed by the
// generator-local formatter below. Like `tools/presentation-matrix.ts`, this file reads its
// sources as data and imports nothing it checks: not `packages/brand/src` (or its scripts),
// `sdk-node` or ui-core.
//
// The file is ASCII only (sign-corpus writes it through `asciiJson`) and append-only within
// `uiMatrixVersion` 6: a new row keeps the version; a changed row, input member or rule bumps it
// (plans/UK-02b.md §4.8). Version 2 (UK-03): the `elapsedMs` input member and DL7's
// delayed-response rows (the `dl7-delayed-response` gap of version 1), and the fixture key's
// secret corrected to the 22 characters every license key has. Version 3 (UK-51): the `cli`
// family, a new top-level section every runner learns. Version 4 (H1b): StatusScreen/revoked
// offers Sign in and Use a different key, never Sign out; Activate's typing, parsed, cut-short,
// rejected and busy states carry the base copy; the fixture URLs name https://polaris.locker.
// Version 4 also carries H1a's `cli` gate rules (rows and rules changed before the first release
// of version 4): a refusal leads with the product page, a failed check is a cross, and the
// `status` outcomes for a version or channel refusal stop looping. Version 5 (DENY-01): a
// device-code poll's `error` is a refusal only with `reason: access_denied`; a bare `error` is a
// failure. SignInHandoff gains the `failed` state (phase `failed`), and the `cli` family the
// `login` outcomes `sign-in-denied` and `sign-in-failed`. Version 5 also carries UIM-05 (UK-64,
// before the first release of version 5): StatusScreen/version-too-new keeps Try again;
// StatusScreen/expired never offers Try again or Reconnect; Paywall/not-available hands off to a
// valid https `offers.url`; OfflineActivation carries its two-step form in every state but done,
// with the request QR's own label and no product line; DeviceLimit's TV QR is labelled
// `a11y.qrManage`. Version 6 (DISC-01, WIRE-CONTRACT-V4 §5.7): the product page link comes from
// discovery's `core.portal`; the `cli` outcomes `status-version-too-new-no-page` and
// `status-channel-not-entitled-no-page` set up a stub whose discovery says the portal is off and
// expect `link: "contact"`, and the vocabulary's `contact` is where the kit resolves no page.
// The `cloudSync` family (U-42.0, additive within version 7): the Cloud Sync screens, named by
// `SYNC_SCREENS` in ui-core. CloudSyncStatus's `locked` and `ring-changed` states, UnlockSync (the
// recovery code, start over; no nearby option in v0.10.0), RecoveryCode (shown once) and RingChange
// (names `changed.by`, hands `changed.served` to `acceptRingChange`). Only ui-core runs it; Swift,
// Kotlin, Godot and Python read the families they name and learn this one with U-42.3 to U-42.5.
// The `holders` family (UK-42.2, additive within version 7): activation without an account. The
// Done step after a key (ActivateDone, with the SignIn form's `key-done`), Add your name and email
// (AddToAccount, with the form's `attach` and `added`) and AccountAndLicense's `floating` row. A
// license is floating until it is added to an account; the kit tells by the holder's email
// (`licenseHolder`). Like `cloudSync` it sits outside COMPONENT_FAMILIES, so only ui-core runs it
// until UK-43; its rows also count toward the state coverage of the must components they name.
// The `saveConflict` family (U-22.K0, additive within version 7): the save screens. SaveConflict
// (choose, keeping, kept, failed: the same save changed on two devices and the person picks one;
// Keep both is disabled with its reason while every save slot is in use) and CloudSyncStatus's
// transfer states (transferring, waiting, transfer-failed: never Synced while a transfer is
// pending). Like `holders` it sits outside COMPONENT_FAMILIES, so only ui-core runs it until the
// native kits learn it with U-23 K.3 to K.5.
// The `connect` family (CC-19.9, additive within version 7): the inter-account screens, named by
// `CONNECT_MODELS` in ui-core. LinkPairing (the window two people pair in: the code both compare,
// the categories listed before the confirm button, the other device's label worded as reported,
// the four ways a session ends without a link, links off for the product) and TransferOffer (D-8:
// consent per transfer). Like `cloudSync` it sits outside COMPONENT_FAMILIES, so only ui-core runs
// it; the native kits learn it with their own packages.
// The `nearby` family (UXR-47b, additive within version 8): the nearby sign-in screens the desktop kit
// adds from its built UX review. SignIn's nearby-choose, nearby-none-found and one ending per way a
// request ends (denied, expired, not-nearby, failed, cancelled, signed-out), and NearbyApproval's
// listening, stopped and failed. Like `holders` it sits outside COMPONENT_FAMILIES, so only ui-core
// runs it; its rows count toward the state coverage of the must components they name.
// Version 8 (U-22.UX2): the saveConflict family from the built UX reviews. The `newer` input
// member and the Newer tag; the `choose-again` action (a failed choice returns to its choices,
// nothing applied); keeping is busy (`a11y.busy`) and keeps the deleted variant's title; kept
// names the choice as its title (`keptLocalTitle`, `keptRemoteTitle`, `keptBothTitle`,
// `keptDeletedTitle`, with `keptCopy` under Keep both), replacing the four `kept*` lines; failed
// offers Try again, Choose again and Cancel with none filled, and says `failedDeleted` after a
// deletion elsewhere. 17 rows become 23. Version 8 also carries the NearbyApproval row
// change (I-47.U); version 7 is the release v0.10.0 carries.
// Version 7 (I-46.1, automatic sign-in): the `autoSignIn` and `nearbyApproval` input members; the
// SignIn states confirm, link-offer, link-done, link-conflict, nearby-prompt, nearby-wait and
// nearby-done (and, from KFA-0, device-limit: a device limit with no license rows, a row that keeps
// the version); the NearbyApproval component; the `start-sign-in` action; the focused refusal step
// for the key-entry limit and a license another account holds (Activate states `key-entry-limit`
// and `license-owned`, SignIn `key-refused`, which replace the stacked `rejected` rows: no field,
// lede or paste; Sign in, then the add-key page); and the done step's `signin.return.signedInTier`.
// The `cli` family gains `devices approve` (I-47.1, additive within version 7: Swift, Kotlin and
// Godot do not run the family): an end-user verb, so the default mount and help rows list it, and
// the `login` outcomes `sign-in-nearby` and `sign-in-nearby-handoff` and the `approve-*` outcomes.
// The `cli` outcomes `activate-floating`, `activate-floating-no-page`, `activate-waiting`, `activate-identity-off` and
// `status-floating` (UK-43.19, additive, no new member): a license held by the key alone is offered the account in one line.
// `uiMatrixVersion` 8 (integration CP2, D-1): NearbyApproval's `choose` state (I-47.U, UXR-47) has one control per license and Deny, as `ask`
// has one per code and Deny: no "Use this license" step, and no primary.
// `uiMatrixVersion` 9 (UCP.1, UI-CONFIRM-PROVIDER): the `autoSignIn.kind` input member (the exchange that made
// the grant); the confirm step's no-email line follows it (asApple, asGameCenter, asPlayGames) and
// is absent when no kind is known; the email row drops all four no-email keys.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UI_MATRIX_VERSION = 9;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Types ───────────────────────────────────────────────────────────────────────────────────

type J = null | boolean | number | string | J[] | { [k: string]: J };
type Obj = { [k: string]: J };

export interface Expect {
  component: string;
  state: string;
  copy: string[];
  actions?: string[];
  /** The copy keys of controls the state draws but does not offer (aria-disabled), sorted. */
  disabled?: string[];
}
/** A window rule row of the `localLayout` family (UI-KITS 4.3, LocalPairing). */
export interface LayoutRow {
  name: string;
  window: { width: number; height: number; textScale?: number; tv?: boolean };
  expect: {
    panes: 1 | 2;
    logo: boolean;
    scrolls: boolean;
    noticeBeforeQr: boolean;
  };
}
/** A negative case (UI-KITS §4.1 "Must not"): the protected behaviour and what must not show. */
export interface MustNot {
  invariant: string;
  states?: string[];
  copy?: string[];
  actions?: string[];
}
export interface Row {
  name: string;
  input: Obj;
  expect: Expect;
  mustNot?: MustNot;
  /** The SDKs and kits that cannot do what the row shows. They check the view the shared rules
   *  give and draw nothing for it (CC-29K.3: a camera scan has no web, desktop or game surface). */
  notApplicable?: { sdks: string[]; reason: string };
}
export interface ThemeRow {
  name: string;
  input: Obj;
  expect: {
    name: string;
    accentSource: string;
    colorScheme: string;
    icon: string;
    preset: string;
  };
}
export interface I18nRow {
  name: string;
  locale: string;
  key: string;
  args: Record<string, string | number>;
  overrides?: Record<string, Record<string, string>>;
  expect: string;
}

export const COMPONENT_FAMILIES = [
  "gate",
  "activate",
  "signIn",
  "deviceLimit",
  "devices",
  "update",
  "settings",
  "paywall",
] as const;
export type ComponentFamily = (typeof COMPONENT_FAMILIES)[number];

export interface UiMatrix {
  uiMatrixVersion: number;
  description: string;
  vocabulary: Obj;
  gate: Row[];
  activate: Row[];
  signIn: Row[];
  deviceLimit: Row[];
  devices: Row[];
  update: Row[];
  settings: Row[];
  paywall: Row[];
  cloudSync: Row[];
  saveConflict: Row[];
  holders: Row[];
  holdersFlow: HoldersFlow;
  connect: Row[];
  local: Row[];
  localLayout: LayoutRow[];
  nearby: Row[];
  theme: ThemeRow[];
  i18n: I18nRow[];
  cli: CliFamily;
}

// ── Sources (read as data, never imported) ──────────────────────────────────────────────────

interface ComponentDoc {
  priority: "must" | "should" | "could";
  family: string | null;
  states: Record<string, { copy: string[] }>;
}

export interface UiMatrixSources {
  /** packages/brand/kit-copy/components.json `components`. */
  components: Record<string, ComponentDoc>;
  /** Kit messages per locale: en.json's values and each pack's (ICU subset). */
  kit: Record<string, Record<string, string>>;
  /** core.* strings per locale, from conformance/parity/copy.<locale>.json (absent: falls back to English). */
  core: Record<string, Record<string, string>>;
  /** conformance/parity/enums.json, by name. */
  enums: Record<string, string[]>;
  /** tools/services.json rows. */
  services: { slug: string; requires: string[] }[];
  /** conformance/corpus/v2/stage-matrix.json `vocabulary`. */
  stage: { stages: string[]; outcomes: string[]; emits: string[] };
}

/** The launch locales (UI-KITS owner decisions, 2026-10-05), English first. */
export const LOCALES = [
  "en",
  "de",
  "fr",
  "es",
  "pt-BR",
  "it",
  "ja",
  "ko",
  "zh-Hans",
] as const;

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

/** Flatten a core copy pack into `core.*` keys (the kit tables' naming, plans/UK-02.md D3). */
function coreKeys(doc: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  const fallback = doc.fallback as Obj;
  out["core.fallback.title"] = fallback.title as string;
  out["core.fallback.message"] = fallback.message as string;
  for (const section of ["codes", "gate", "activation"])
    for (const [k, e] of Object.entries(doc[section] as Obj)) {
      out[`core.${section}.${k}.title`] = (e as Obj).title as string;
      out[`core.${section}.${k}.message`] = (e as Obj).message as string;
    }
  return out;
}

export function loadUiMatrixSources(root = REPO_ROOT): UiMatrixSources {
  const kitDir = join(root, "packages", "brand", "kit-copy");
  const parity = join(root, "conformance", "parity");
  const components = (readJson(join(kitDir, "components.json")) as Obj)
    .components as unknown as Record<string, ComponentDoc>;
  const kit: Record<string, Record<string, string>> = {};
  const en = (readJson(join(kitDir, "en.json")) as Obj).messages as Obj;
  kit.en = Object.fromEntries(
    Object.entries(en).map(([k, m]) => [k, (m as Obj).value as string]),
  );
  for (const locale of LOCALES.slice(1))
    kit[locale] = (readJson(join(kitDir, `${locale}.json`)) as Obj)
      .messages as Record<string, string>;
  const core: Record<string, Record<string, string>> = {};
  for (const locale of LOCALES) {
    let doc: Obj;
    try {
      doc = readJson(join(parity, `copy.${locale}.json`)) as Obj;
    } catch {
      continue; // a pack that does not exist yet: the tables fall back to English
    }
    core[locale] = coreKeys(doc);
  }
  const enums = Object.fromEntries(
    (
      (readJson(join(parity, "enums.json")) as Obj).enums as {
        name: string;
        values: string[];
      }[]
    ).map((e) => [e.name, e.values]),
  );
  const services = (
    readJson(join(root, "tools", "services.json")) as {
      services: { slug: string; requires: string[] }[];
    }
  ).services.map(({ slug, requires }) => ({ slug, requires }));
  const stage = (
    readJson(
      join(root, "conformance", "corpus", "v2", "stage-matrix.json"),
    ) as {
      vocabulary: { stages: string[]; outcomes: string[]; emits: string[] };
    }
  ).vocabulary;
  return { components, kit, core, enums, services, stage };
}

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────

/** The closed action list (plans/UK-02b.md §4.3). A row's actions are derived from its copy
 *  (ACTION_KEYS) plus `replace-in-browser`, which has no copy key of its own. */
export const ACTIONS: Readonly<Record<string, string>> = {
  "open-card":
    "Start the sign-in on the hosted card in the browser (Continue in browser, Continue with email).",
  "open-browser":
    "Open the sign-in already in flight in the browser again; never a second request (Open browser again, the code view's Open browser).",
  "replace-in-browser":
    "Replace a device on the card, for a form set to `replace: browser`.",
  "open-manage-url":
    "Open the refusal's `manageUrl` or the account's device page in the browser.",
  "start-sign-in":
    "Start the kit's own sign-in, from a refusal that only a sign-in fixes (Sign in to that account).",
  "copy-link": "Copy the sign-in link or the address to the clipboard.",
  retry:
    "Repeat the step that failed or lapsed (Try again, Reconnect, Sign in again, Get a new code).",
  cancel: "Leave the step or the flow (Cancel).",
  unlock:
    "Unlock the synced data: submit the recovery code, or open its screen (Unlock, Unlock sync).",
  "start-over":
    "Open the confirmation that replaces the sync key (Start over).",
  "confirm-start-over":
    "Replace the sync key after the warning that synced data will be lost (T22).",
  "accept-ring-change":
    "Confirm the changed ring that was shown: hand `served` to `acceptRingChange`, never a fresh read.",
  "use-recovery-code":
    "Open the recovery code screen from the ring confirmation.",
  "copy-code": "Copy the recovery code to the clipboard.",
  "keep-local":
    "Resolve a save conflict by keeping the copy on this device (Keep this device's version).",
  "keep-remote":
    "Resolve a save conflict by keeping the other copy, or accepting its deletion (Keep the other version, Delete it here too).",
  "keep-both":
    "Resolve a save conflict by keeping both: the other copy is saved under a new name (Keep both).",
  "choose-again":
    "Return a failed save conflict to its choices; nothing is applied (Choose again).",
};

/** The copy keys whose control is each action (UI-KITS §4.1: copy matches controls). */
export const ACTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  "open-card": ["signin.desktop.continue", "signin.email.continue"],
  "open-browser": ["signin.handoff.again", "signin.handoff.openBrowser"],
  // The Cloud Sync screens' controls (U-42.0).
  unlock: ["unlockSync.unlock", "cloudSync.unlock"],
  "start-over": ["unlockSync.startOver"],
  "confirm-start-over": ["unlockSync.startOverConfirm"],
  "accept-ring-change": ["ringChange.accept"],
  "use-recovery-code": ["ringChange.useCode"],
  "copy-code": ["recoveryCode.copy"],
  // The save conflict's choices (U-22.K0).
  "keep-local": ["saveConflict.keepThis"],
  "keep-remote": ["saveConflict.keepOther", "saveConflict.acceptDelete"],
  "keep-both": ["saveConflict.keepBoth"],
  "choose-again": ["saveConflict.chooseAgain"],
  "start-sign-in": [
    "signin.key.signIn",
    "signin.key.ownedSignIn",
    "activate.waitingSignIn",
    "activate.recommend.action",
    "cloudSync.signIn",
  ],
  "open-manage-url": [
    "deviceLimit.openBrowser",
    "devices.manage",
    "signin.key.addInLocker",
    "signin.deviceLimit.replace",
    "activate.otherEmail.verify",
  ],
  "copy-link": ["signin.handoff.copyLink", "a11y.copyAddress"],
  retry: [
    "common.tryAgain",
    "common.reconnect",
    "signin.again",
    "signInHandoff.newCode",
  ],
  cancel: ["common.cancel"],
};

/** The must-tier kits a theme row names (plans/UK-02b.md D8). */
export const KITS = [
  "elements",
  "react",
  "swiftui",
  "compose",
  "godot",
  "qt",
  "terminal",
] as const;
/** `platform.os` values of the must tier (D8): `tvos`, `visionos` and `watchos` get no rows. */
export const MUST_OS = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
] as const;
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
export const PRESENTATIONS = ["inline", "sheet", "browser"] as const;
export const REPLACE_MODES = ["inline", "browser"] as const;
export const CHANNELS = ["browser", "device-code"] as const;
/** `session.wait()`'s outcomes (plans/I-04.md §G.9; D3). */
export const OUTCOMES = [
  "pending",
  "choose",
  "signedIn",
  "cancelled",
  "expired",
] as const;
export const EVENTS = [
  "use-code",
  "copy-link",
  "have-key",
  "open-replace",
  "confirm-replace",
  "reopen",
] as const;
export const DEVICE_CODE_PHASES = [
  "starting",
  "waiting",
  "slow-down",
  "ok",
  "denied",
  "failed",
  "expired",
  "cancelled",
] as const;
export const REGISTRATION = [
  "open",
  "requires-identity",
  "requires-license",
] as const;
export const PENDING = [
  "sign-in",
  "activate",
  "replace",
  "save",
  "purchase",
  "restore",
] as const;
export const EDITS = ["rename", "remove", "value"] as const;
export const TOASTS = [
  "update",
  "copied",
  "warning",
  "error",
  "progress",
  "key-entries",
] as const;
export const PROGRESS_PHASES = [
  "queued",
  "download",
  "verify",
  "paused",
  "install",
  "failed",
  "done",
] as const;
export const ACCENT_SOURCES = [
  "integrator",
  "product",
  "icon",
  "core",
  "ink",
  "host",
] as const;
export const COLOR_SCHEMES = ["system", "dark", "light"] as const;
export const ICONS = ["image", "monogram", "none"] as const;
export const PRESETS = ["polaris-key", "native"] as const;

/** UI-KITS §4.1 "Must not", for the must components (Welcome has none). Each becomes at least
 *  one negative row; tools/ui-matrix.test.ts holds this table equal to the spec's. */
export const MUST_NOT: Readonly<Record<string, string>> = {
  PolarisKeyGate: "flash activation during a cached-session check",
  Boot: "animate invented progress, or trap metered consent off-screen",
  SignIn: "restart the flow or erase account context on a step change",
  SignInHandoff: "use the public user code as the polling handle",
  NearbyApproval: "approve on any code but the one the other device shows",
  Activate: "require an account for a floating key",
  OfflineActivation: "treat a loaded file as a verified activation",
  DeviceLimit: "delete local files when access is removed",
  LicenseChoice: "blur keep, create and add-to-account into one outcome",
  Devices: 'say "This device" when the runtime does not know it',
  UpdatePrompt:
    "offer a restart the browser cannot perform on a desktop product",
  UpdateProgress: "say installed when only the download verified",
  ReleaseNotes: "execute remote markup",
  StatusScreen: "collapse the five refusals into one error",
  GraceBanner: "extend grace visually",
  AccountAndLicense: "silently attach a floating license",
  Settings: "expose hidden values through a theme",
  Paywall: "invent checkout",
  EntitlementGate: "treat a style override as authorization",
  Toast: "be the only record of an error",
};

/** What every field-state Activate screen carries: its heading, lede and the key field. */
const ACTIVATE_BASE = [
  "activate.title",
  "activate.lede",
  "part.keyField.label",
  "part.keyField.placeholder",
  "common.paste",
];

/** The focused refusal step (DL6): the key field, its lede and Paste are gone. */
const FOCUSED_REFUSAL = {
  invariant:
    "leave the key field, lede or paste over a refusal that only a sign-in fixes",
  states: ["rejected"],
  copy: [
    "activate.title",
    "activate.lede",
    "part.keyField.label",
    "part.keyField.placeholder",
    "common.paste",
  ],
};

const REVOKED_MUST_NOT = {
  invariant: "offer Sign out on a device already signed out",
  copy: ["common.signOut"],
};

/** Further invariants a component's rows may name besides its UI-KITS §4.1 one. */
export const EXTRA_MUST_NOT: Readonly<Record<string, readonly string[]>> = {
  Activate: [
    "leave the key field, lede or paste over a refusal that only a sign-in fixes",
  ],
  SignIn: [
    "leave the key field, lede or paste over a refusal that only a sign-in fixes",
    "say all apps for Apple",
  ],
  StatusScreen: [
    "offer Sign out on a device already signed out",
    "offer Try again or Reconnect on an expired license (Renew and Use another license are its controls)",
  ],
  Paywall: ["open a link that is not https (DL14)"],
};

/** D6: the identity-only keys. A presentation-absent row may drop these from its default row's
 *  copy, and nothing else. `common.byDeveloper` drops out (no developer name without an
 *  integrator or a presentation, UI-KITS §1.2); `a11y.productIcon` stays (the monogram tile is
 *  still the product's icon). */
export const IDENTITY_ONLY_KEYS = [
  "common.byDeveloper",
  "a11y.productIcon",
] as const;
const ABSENT_DROPS = ["common.byDeveloper"];

/** D5 and §4.4: every must component and the opt-in services its rows depend on. Each pair gets
 *  a row that turns the service off. CM-29 appends `commerce` to Paywall and EntitlementGate. */
export const SERVICE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> =
  {
    PolarisKeyGate: ["license"],
    Boot: [],
    Welcome: ["identity", "license"],
    SignIn: ["identity", "license"],
    SignInHandoff: ["identity"],
    NearbyApproval: ["identity"],
    LicenseChoice: ["identity", "license"],
    Activate: ["license"],
    OfflineActivation: ["license"],
    DeviceLimit: ["license"],
    Devices: ["license"],
    StatusScreen: ["license"],
    GraceBanner: ["license"],
    AccountAndLicense: ["identity", "license", "config", "update", "sync"],
    Settings: ["config"],
    UpdatePrompt: ["update"],
    UpdateProgress: ["update"],
    ReleaseNotes: ["release"],
    Paywall: ["license"],
    EntitlementGate: ["license"],
    Toast: ["update"],
  };

/**
 * components.json keys no kit row can show, by `<Component>.<state>`, each with its reason. D7
 * requires a state's rows to cover its list; these are the exceptions, kept closed: the build
 * fails if a row shows one, or if a reason is missing. Most are the hosted card's strings filed
 * under a kit state, or need an input member no SDK result or approved view carries yet (D2,
 * D12); the package that adds that input removes the entry and adds the row.
 */
export const UNREACHED: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "SignIn.code": Object.fromEntries(
    [
      "signin.code.title",
      "signin.code.sent",
      "signin.code.label",
      "signin.code.resend",
      "core.codes.invalid_code.message",
    ].map((k) => [
      k,
      "The card's email-code step (SIGN-IN.md §3.4, §4.16). Credentials are entered only on the card (S-16 D17); the kit form's `code` step is the device-code view, which SignInHandoff draws.",
    ]),
  ),
  "SignIn.choose": {
    "signin.consent.licenseInApp":
      "The card's ConsentStep in app mode (plans/I-04.md §G.3), not the kit form.",
    "signin.return.chooseInApp":
      "The card's ReturnStep in app mode (SIGN-IN.md §3.10), not the kit form.",
  },
  "SignInHandoff.waiting": {
    "signin.handoff.check":
      "The device-code match line. Device-code `waiting` selects `code` (plans/UK-02b.md §4.5), whose list lacks it; components.json is reconciled by the next catalog package.",
    "signin.handoff.expires":
      "The device-code countdown. Device-code `waiting` selects `code` (plans/UK-02b.md §4.5), whose list lacks it; components.json is reconciled by the next catalog package.",
  },
  "SignInHandoff.finishing": {
    "signInHandoff.confirm":
      "The card's Continue to <App> (S-16 D22) happens before the poll answers, so no `deviceCode.phase` reaches it.",
  },
  "SignInHandoff.code": {
    "part.qr.scanInstead":
      "A QR as the secondary path needs a pad-only screen that also browses; no must-tier platform value describes one (D8).",
  },
  "LicenseChoice.many": {
    "signin.choice.origin.key":
      "Needs the key's last six characters (SIGN-IN.md G7), which `LicenseChoice` does not carry (D2).",
    "signin.choice.origin.storeKey":
      "Needs a store key's last six characters, which `LicenseChoice` does not carry (D2).",
    "signin.choice.origin.storeKeyAdded":
      "Needs a store-key origin, which `LicenseChoice.origin` does not have (D2); LX-08's `source` adds it.",
    "signin.choice.origin.gift":
      "Needs a gift origin, which `LicenseChoice.origin` does not have (D2); LX-08's `source` adds it.",
    "signin.choice.origin.org":
      "Needs an organization origin, which `LicenseChoice.origin` does not have (D2); I-24a's seat holders add it.",
    "signin.term.yearlyUntil":
      "Needs a renewal period, which `LicenseChoice` does not carry (D2); LX-41's durations add it.",
  },
  "LicenseChoice.mixed": {
    "signin.choice.combined":
      "The `entitlementModel: combined` line; no SDK result carries the model yet (D12).",
  },
  "UpdatePrompt.store": {
    "update.reload":
      "The web outlet's decision is `platform` (update-matrix.json), drawn with update.platform.web.",
  },
};

/** A variant the matrix does not pin yet, declared rather than silently left out, with the work
 *  package that appends its rows. */
export interface Gap {
  id: string;
  what: string;
  why: string;
  owner: string;
  then: string;
}

/** The declared gaps. The build fails on a gap with no owner or no reason; the package that
 *  appends the rows removes its entry. */
export const GAPS: readonly Gap[] = [];

/**
 * DL7's delayed response (UI-KITS.md, design language v2): a loading state shows nothing for the
 * first 250-300 ms, then the identity, a muted label and the shimmer. `elapsedMs` (the time since
 * the request started) pins it: below `min` the state's copy is empty, from `max` it is the
 * state's usual copy, and no row falls inside the window, so a kit may wait anywhere in it. A
 * row without `elapsedMs` is past the delay. The states are the loading states of the must
 * components (and the gate's license check, which never flashes).
 */
export const LOADING_DELAY = {
  min: 250,
  max: 300,
  states: [
    "PolarisKeyGate.booting",
    "LicenseChoice.loading",
    "Devices.loading",
    "ReleaseNotes.loading",
    "AccountAndLicense.loading",
    "Settings.loading",
    "Paywall.loading",
    "EntitlementGate.loading",
  ],
} as const;

/** What a member an input omits stands for. */
export const DEFAULTS: Obj = {
  presentation: {
    name: "Tidewater Studio",
    developerName: "Harbor Audio",
    icon: true,
  },
  bundle: { slug: "tidewater", name: "Tidewater Studio" },
  platform: { os: "macos", formFactor: "mac" },
  registration: "requires-license",
  capabilities: {
    signIn: true,
    keyEntry: true,
    deviceCode: true,
    offlineActivation: false,
    trial: false,
    restore: false,
    purchase: false,
    enroll: false,
  },
};

/** Every input member, as runners read it. */
const INPUTS: Record<string, string> = {
  integrator:
    "The integrator's theme identity: {name?, shortName?, developer?, accent? (a colour or core), accentDark?, icon?: bool, deviceCodeUrl?, poweredBy?: line | badge}. Absent: none set.",
  presentation:
    "Discovery's core.presentation through PresentationSource (HA-12): {name, developerName?, accent?, accentDark?, icon: bool}, icon meaning verified bytes arrived; null when discovery carries none.",
  bundle:
    "The app bundle's identity: {slug, name?}. The kit's last identity source.",
  platform: "{os, formFactor}: the device the kit runs on.",
  services:
    "The enabled opt-in services (tools/services.json slugs), closed under `requires`. Absent: all on.",
  registration: "Discovery's core.registration.",
  capabilities:
    "What the build offers: {signIn, keyEntry, deviceCode, offlineActivation, trial, restore, purchase, enroll}; a member a row omits takes the default.",
  stage:
    "The boot stage machine (stage-matrix.json): {stage, outcome, emit?}, emit one of its emit objects.",
  gate: "The gate: {status?: licenseStatus, checking?: true (no status yet), cached?: true (a cached license is being re-checked), graceDaysLeft?, allowed?: {min?, max?} (the license's allowed versions)}.",
  pending: "The action in flight, which drives the busy states.",
  loading: "true while the component's data loads.",
  elapsedMs:
    "Milliseconds since the request a loading state waits on started (DL7, vocabulary.loadingDelay). Below min the state shows nothing; from max its usual copy. Absent: the delay has passed.",
  keyField:
    "The license key field: {text, submitted?}. A key is `pkey_<slug>_` and a 22-character secret.",
  activation:
    "An activation result: {result: activationResult, code?, limit?, deviceCount?, manageUrl?}.",
  offline:
    "Offline activation: {copied?, file?, submitted?, verified?} (the request code copied, a response loaded, submitted, its signature verified).",
  provider:
    "The sign-in provider's name (Apple, Google, Steam), for the strings that name it: the link offer, the failed sign-in. Absent: Polaris Locker, the sign-in the generic row opens.",
  autoSignIn:
    "Automatic sign-in's step in the sign-in form (needs signIn): {step: confirm | link-offer | link-done | link-conflict | nearby-prompt | nearby-wait | nearby-done | nearby-choose | nearby-none-found | nearby-denied | nearby-expired | nearby-not-nearby | nearby-failed | nearby-rate-limited | nearby-unavailable | nearby-cancelled | nearby-signed-out | device-limit, email?, kind? (the exchange that made the grant: apple | google | gamecenter | pgs; absent after a Polaris Locker sign-in), reach?: global | developer | unknown, manageUrl? (device-limit: where a device is replaced)}. No email: the provider shared none, and the confirm line follows `kind`. The provider is `provider`.",
  nearbyApproval:
    "The approving device's side of nearby sign-in: {step: entry | ask | approved | not-nearby | mismatch | denied | expired | device-limit | choose | account-required | rate-limited | listening | stopped | failed, device?}. Absent: the account-menu entry. `listening` is the screen open with nothing asking yet; `stopped` the advert stopped after declined requests; `failed` a server or network failure.",
  linkPairing:
    "Pairing with someone nearby: {step: open | code | confirm | linked | failed | unavailable, device?, code?, categories?, reason?: declined | timeout | full | closed}. `device` is the label the other device reported: nothing authenticates it, so the screen words it as reported and, without one, says the device gave no name. `code` is drawn as served and compared by both people. `categories` (ids, at most 8) are listed before the confirm button; none says nothing is shared yet. `unavailable`: links are off for the product (the typed connect_links_disabled). Absent: LinkPairing is hidden.",
  transferOffer:
    "A contact's offer to send something (D-8, consent per transfer): {step: ask | receiving | done | failed, device?, name}. `device` is the contact's label and `name` what it offers, both text the other side chose. Absent: TransferOffer is hidden.",
  signIn:
    "The sign-in session: {presentation, replace, channel, outcome?, browserOpened?, redeeming?, event?, issuedNow?, raced?, grantExpired?}. outcome is session.wait()'s; issuedNow is true when this sign-in added or issued the license.",
  deviceCode:
    "The device-code poll: {phase, secondsLeft?}. Present exactly on rows with signIn.channel device-code; it alone selects SignInHandoff's state.",
  choices: "plans/I-04.md's LicenseChoiceView, field for field.",
  replaceView: "plans/I-04.md's ReplaceView, field for field.",
  selected:
    "The row the person picked in LicenseChoice (a licence id, keep or create). Absent: the view's preselected.",
  devices:
    "The license's devices: [{name, platform, formFactor, lastSeenDays, current}].",
  browserMode: "true when device management is in the browser only.",
  edit: "An inline edit the person opened: {kind: rename | remove | value, device?}.",
  saved: "true just after a save succeeded.",
  replacement:
    "A Replace a device on the key path: {device, outcome: done | failed}.",
  update:
    "The update decision and its download: {action: updateAction, outlet?: outletKind, reason?, version?, mandatory?, critical?, progress?: {phase, fraction?}}.",
  releaseNotes: "The changelog: [{version, date, notes}].",
  config:
    "config.list rows: [{key, type, source, locked, org?, value?, min?, max?, advanced?}].",
  account:
    "{signedIn, holder?: account}: holder is the account signed in on this device (S-19), or absent.",
  entitlement: "{name, entitled}.",
  offers:
    "{available, purchased?, url?}: url is the https page that sells the offer outside the app (a store page or the product's Polaris Locker page), from the integrator or the server; the hand-off shows only when the opener accepts it (DL14).",
  toast:
    "{kind, closesIn?, left?}: the toast being shown. `left` (key-entries): the key entries the license has left.",
  error: "{code}: a core.codes code the step failed with.",
  cloudSync:
    "CloudSyncStatus's state: {state: synced | syncing | offline | conflict | error | locked | ring-changed | transferring | waiting | transfer-failed, signedIn?, canReview?, lastSynced?, transfer?: {size?, total?, fraction?}, reason?: network | battery | background}. `ring-changed` always offers Review: the kit owns the confirmation. `transferring` shows `transfer.size` of `transfer.total` (display-ready sizes) when both are given, and a bar that is determinate only with `transfer.fraction` (counted bytes, 0 to 1); `waiting` names its `reason` (default network); `transfer-failed` offers Try again. While a transfer is pending the status never says Synced, whatever `lastSynced` holds.",
  saveConflict:
    "SaveConflict: {step: choose | keeping | kept | failed, local?: {when?}, remote?: {when?, device?} | null, bothAvailable?, keep?: local | remote | both, newer?: local | remote}. `remote: null` means the other copy was deleted: Keep the other becomes Delete it here too and Keep both is not offered. `bothAvailable` is true only with a free slot of the 16; absent or false draws Keep both disabled, with its reason. `keep` is the choice being applied (keeping), applied (kept) or that failed; kept needs it. `reopened`: true on choose when a choice met a newer copy and nothing was applied; one line says the other version changed again. `newer`: `local | remote`, the version the app knows was saved later (its own metadata, never the display strings). It tags that card and chooses nothing; it is ignored when the other copy was deleted. `when` and `device` are display-ready.",
  licenseHolder:
    "Who holds the license a key just activated: {email?}. No email (or an empty one): floating, held by the key alone. An email: the license was sent to it and no account holds it yet (waiting); screens mask it. `addIn: portal` (UK-43.2): the kit has no in-app channel for Add your name and email, so the Add control of ActivateDone, SignIn `key-done` and AccountAndLicense's floating row says Add it in Polaris Locker (an external link) and opens the manage URL; absent or `app`: the in-app form. Absent: the holder is not known and AccountAndLicense draws what it drew before.",
  activateDone:
    "The Done step after a key activates: {tier?, term?, deviceKind?, position?, limit?}, the strings and numbers the license line shows. Absent: ActivateDone is hidden. The state is `waiting` with a `licenseHolder` email and Identity on, else `ready`; the reasons follow the services (Cloud Sync only with sync, Get your license back and Move it with Identity, else the portal line).",
  addToAccount:
    "Add your name and email: {step: form | invalid | busy | added | owned | email-bound | other-account | failed, field?: name | email | both, deviceKind?, typedEmail?, signedEmail?, fromSettings?}. `invalid` names the field to fix (absent: both). owned: someone attached the license meanwhile; email-bound: the license was sent to another email (with `licenseHolder`); other-account: a different account signed in than the email typed (`typedEmail` and `signedEmail`, both masked); `fromSettings` closes `added` with Done; failed: sign-in or attach did not finish. `added` names Cloud Sync only with sync on. Absent: AddToAccount is hidden.",
  unlockSync:
    "UnlockSync's step: {step: code | invalid | working | failed | start-over-failed | no-code | start-over, nearby?}. `no-code`: the account has no recovery code, so only Start over helps. `nearby` says the host could unlock from a nearby device; v0.10.0 never offers it (NearbyApproval does not ship).",
  recoveryCode:
    "RecoveryCode: {saved?}. The code itself is never an input of the view: the kit draws it from the host, once, and keeps nothing.",
  ringChange:
    "RingChange: {by?, served?: {ringId, epoch, rootKid}, failed?}. `failed`: accepting the ring did not open a root; the screen says so and Accept stays available. `by` is the name of the device that wrapped (`changed.by`); `served` is the ring the person was shown (`changed.served`), the one value `acceptRingChange` takes. No `served`: nothing to accept, only the recovery code.",
};

/** The precedence a model applies where several states could hold (authoring notes, pinned by
 *  the rows). */
const PRECEDENCE: Record<string, string> = {
  LicenseChoice:
    "loading, grant-expired, raced, replace-open (open-replace with replace inline), none-keys or none-no-keys (state none), new (state autoIssue), create (create selected), all-full (no free row), keep, current, mixed (account and seat licences together), one, many.",
  SignIn:
    "error, auto (autoSignIn), expired, done (signedIn), key-refused or key (have-key while choosing; the key-entry limit and an owned license are key-refused), replace (open-replace with replace inline), choose, finishing (redeeming, or device-code ok), code (device code, or use-code), handoff (pending), methods.",
  Settings:
    "loading, error, saving (pending save or saved), dirty, locked (a locked row), list.",
  Devices:
    "loading, error, browser-mode, renaming or confirming (edit), empty, list.",
  ActivateDone:
    "hidden (License off), waiting (a licenseHolder email, Identity on), ready (the reasons follow the services).",
  AddToAccount:
    "hidden (Identity off), then the step: form, invalid, busy, added, owned, email-bound, other-account, failed.",
  "SignIn (holders)":
    "`signIn.step` key-done (the ActivateDone body), attach (AddToAccount's, at its `addToAccount.step`) or added wins over every step except error and an automatic sign-in step.",
  "AccountAndLicense (holders)":
    "key-only with a `licenseHolder` that has no email (floating) draws Not in an account and Add your name and email instead of the key-only line; Identity off keeps it, Add opening the portal.",
  LinkPairing:
    "hidden (Connect off or no linkPairing), then the step: open, code (a device reached the code), confirm, linked, failed (its reason picks the line), unavailable.",
  TransferOffer:
    "hidden (Connect off or no transferOffer), then the step: ask, receiving, done, failed.",
  Paywall:
    "loading, purchasing (pending purchase), restore (pending restore), purchased, not-available, offers.",
};

// ── Services ────────────────────────────────────────────────────────────────────────────────

/** The services left on when `off` are turned off, closed under `requires` (ST-38's rule). */
export function servicesWithout(
  services: UiMatrixSources["services"],
  ...off: string[]
): string[] {
  const down = new Set(off);
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of services)
      if (!down.has(s.slug) && s.requires.some((r) => down.has(r))) {
        down.add(s.slug);
        changed = true;
      }
  }
  return services.map((s) => s.slug).filter((s) => !down.has(s));
}

// ── Authoring ───────────────────────────────────────────────────────────────────────────────

interface Draft extends Row {
  /** The component's default row: D6's presentation-absent twin copies it. */
  isDefault?: true;
  /** Actions with no copy key of their own (`replace-in-browser`). */
  extraActions?: string[];
  /** Actions of a control the row draws disabled: its label is copy, but it is not offered. */
  dropActions?: string[];
}

interface Opts {
  default?: true;
  actions?: string[];
  /** Actions of a control the row draws disabled (see Draft.dropActions). */
  dropActions?: string[];
  /** Copy keys of the controls the row draws disabled (`expect.disabled`). */
  disabled?: string[];
  mustNot?: Omit<MustNot, "invariant"> & { invariant?: string };
  /** SDKs that cannot draw this row (Row.notApplicable). */
  notApplicable?: Row["notApplicable"];
}

function authoring(S: UiMatrixSources) {
  const list = (c: string, s: string): string[] => {
    const st = S.components[c]?.states[s];
    if (!st)
      throw new Error(`ui-matrix: ${c}.${s} is not a components.json state`);
    return st.copy;
  };
  /** The state's whole list, less the keys no row can show. */
  const all = (c: string, s: string): string[] =>
    list(c, s).filter((k) => !UNREACHED[`${c}.${s}`]?.[k]);
  const but = (c: string, s: string, ...drop: string[]): string[] => {
    for (const d of drop)
      if (!list(c, s).includes(d))
        throw new Error(`ui-matrix: ${d} is not in ${c}.${s}'s list`);
    return all(c, s).filter((k) => !drop.includes(k));
  };
  const row = (
    name: string,
    input: Obj,
    component: string,
    state: string,
    copy: string[] | "all",
    o: Opts = {},
  ): Draft => {
    const d: Draft = {
      name,
      input,
      expect: {
        component,
        state,
        copy: copy === "all" ? all(component, state) : copy,
      },
    };
    if (o.default) d.isDefault = true;
    if (o.actions) d.extraActions = o.actions;
    if (o.dropActions) d.dropActions = o.dropActions;
    if (o.disabled) d.expect.disabled = [...o.disabled].sort();
    if (o.notApplicable) d.notApplicable = o.notApplicable;
    if (o.mustNot)
      d.mustNot = {
        ...o.mustNot,
        invariant: o.mustNot.invariant ?? MUST_NOT[component]!,
      };
    return d;
  };
  const hidden = (name: string, input: Obj, component: string): Draft =>
    row(name, input, component, "hidden", []);
  const off = (...slugs: string[]): string[] =>
    servicesWithout(S.services, ...slugs);
  return { list, all, but, row, hidden, off };
}
type A = ReturnType<typeof authoring>;

// ── Fixtures (synthetic, D10) ───────────────────────────────────────────────────────────────

const MAC = { os: "macos", formFactor: "mac" };
const WINDOWS = { os: "windows", formFactor: "computer" };
const IPHONE = { os: "ios", formFactor: "iphone" };
const ANDROID = { os: "android", formFactor: "phone" };
const ANDROID_TV = { os: "android", formFactor: "tv" };
const LINUX_TV = { os: "linux", formFactor: "tv" };
const WEB = { os: "web", formFactor: "computer" };

const KEY = "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpbG"; // a 22-character secret
const MANAGE_URL =
  "https://polaris.locker/#/p/tidewater/free-device?license=lic_pro&for=MacBook%20Pro";
const DEVICES = [
  {
    name: "Work laptop",
    platform: "windows",
    formFactor: "computer",
    lastSeenDays: 12,
    current: false,
  },
  {
    name: "Mara's iPad",
    platform: "ios",
    formFactor: "ipad",
    lastSeenDays: 3,
    current: false,
  },
  {
    name: "MacBook Pro",
    platform: "macos",
    formFactor: "mac",
    lastSeenDays: 0,
    current: true,
  },
];
const DEVICES_UNKNOWN_CURRENT = DEVICES.map((d) => ({ ...d, current: false }));

const FREE_DEVICE_URL =
  "https://polaris.locker/#/p/tidewater/free-device?license=lic_edu&for=MacBook%20Pro&return=/signin?request=req_tidewater";
const lic = (o: Obj): Obj => ({
  id: "lic_pro",
  tierName: "Pro",
  name: null,
  origin: "purchase",
  access: "seats",
  seats: { used: 1, limit: 3 },
  current: false,
  expiresAt: null,
  state: "free",
  replace: null,
  freeDeviceUrl: null,
  ...o,
});
const PRO = lic({});
const STORE_PRO = lic({
  id: "lic_store",
  origin: "store",
  expiresAt: 1798761600,
});
const KEY_STANDARD = lic({
  id: "lic_key",
  tierName: "Standard",
  origin: "key",
});
const FREE = lic({
  id: "lic_free",
  tierName: "Free",
  origin: "free",
  seats: { used: 0, limit: 1 },
});
const COMP = lic({
  id: "lic_comp",
  tierName: "Pro",
  origin: "developer",
  expiresAt: 1798761600,
});
const EDU_FULL = lic({
  id: "lic_edu",
  tierName: "Edu",
  name: "Fennick Studio Edu",
  origin: "developer",
  seats: { used: 3, limit: 3 },
  expiresAt: 1798761600,
  state: "full",
  replace: { allowed: true, retryAfter: null },
  freeDeviceUrl: FREE_DEVICE_URL,
});
const PRO_FULL = lic({
  seats: { used: 3, limit: 3 },
  state: "full",
  replace: { allowed: true, retryAfter: null },
  freeDeviceUrl: FREE_DEVICE_URL,
});
const SIGNIN_FREE = lic({
  id: "lic_signin",
  tierName: "Free",
  origin: "signin",
  access: "account",
  seats: { used: 1, limit: 5 },
});
const SIGNIN_PLUS = lic({
  id: "lic_signin_plus",
  tierName: "Plus",
  origin: "signin",
  access: "account",
  seats: { used: 2, limit: 5 },
});
const GET_LICENSE = {
  activateUrl: "https://polaris.locker/activate?product=tidewater",
  purchaseUrl: "https://tidewater.example/buy",
  keyEntry: true,
};
const view = (o: Obj): Obj => ({
  state: "choose",
  choices: [],
  keep: false,
  preselected: null,
  create: null,
  getLicense: GET_LICENSE,
  ...o,
});
const VIEW_MANY = view({
  choices: [PRO, STORE_PRO, KEY_STANDARD, FREE, COMP, EDU_FULL],
  preselected: "lic_pro",
});
const VIEW_ONE = view({ choices: [PRO], preselected: "lic_pro" });
const VIEW_SIGNIN = view({
  choices: [SIGNIN_FREE, SIGNIN_PLUS],
  preselected: "lic_signin",
});
const VIEW_CURRENT = view({
  choices: [lic({ current: true }), STORE_PRO],
  preselected: "lic_pro",
});
const VIEW_KEEP = view({
  choices: [STORE_PRO, FREE],
  keep: true,
  preselected: "keep",
});
const VIEW_MIXED = view({
  choices: [SIGNIN_FREE, KEY_STANDARD],
  preselected: "lic_signin",
});
const VIEW_ALL_FULL = view({ choices: [PRO_FULL, EDU_FULL] });
const VIEW_ALL_FULL_CREATE = view({
  choices: [PRO_FULL, EDU_FULL],
  create: { tierName: "Free", access: "account" },
});
const VIEW_NONE_REPLACEABLE = view({
  choices: [
    { ...PRO_FULL, replace: null, freeDeviceUrl: null },
    { ...EDU_FULL, replace: null, freeDeviceUrl: null },
  ],
});
const VIEW_NEW = view({
  state: "autoIssue",
  create: { tierName: "Free", access: "account" },
});
const VIEW_NONE_KEYS = view({ state: "none" });
const VIEW_NONE_NO_KEYS = view({
  state: "none",
  getLicense: { ...GET_LICENSE, keyEntry: false },
});
const VIEW_NONE_BARE = view({
  state: "none",
  getLicense: { ...GET_LICENSE, keyEntry: false, purchaseUrl: null },
});
const REPLACE_VIEW = {
  licenseId: "lic_pro",
  seats: { used: 3, limit: 3 },
  devices: [
    {
      id: "dev_work",
      label: "Work laptop",
      platform: "windows",
      deviceType: "computer",
      lastSeen: 1758240000,
      leastRecent: true,
      activeNow: false,
      thisBrowser: false,
    },
    {
      id: "dev_ipad",
      label: "Mara's iPad",
      platform: "ios",
      deviceType: "tablet",
      lastSeen: 1759190400,
      leastRecent: false,
      activeNow: false,
      thisBrowser: false,
    },
    {
      id: "dev_web",
      label: null,
      platform: "web",
      deviceType: "computer",
      lastSeen: 1759449000,
      leastRecent: false,
      activeNow: true,
      thisBrowser: true,
    },
  ],
  replace: { allowed: true, retryAfter: null },
};

const si = (o: Obj = {}): Obj => ({
  presentation: "inline",
  replace: "inline",
  channel: "browser",
  ...o,
});
const dc = (phase: string, o: Obj = {}): Obj => ({
  platform: ANDROID_TV,
  signIn: si({ channel: "device-code", ...o }),
  deviceCode: { phase, ...(phase === "waiting" ? { secondsLeft: 252 } : {}) },
});

// ── gate: PolarisKeyGate, Boot, StatusScreen, GraceBanner, Toast ───────────────────────────

function gateFamily(a: A): Draft[] {
  const { row, all, but, hidden, off } = a;
  const G = "PolarisKeyGate";
  const licenseOff = { services: off("license"), registration: "open" };
  const st = (stage: string, outcome: string, emit?: Obj): Obj => ({
    stage: { stage, outcome, ...(emit ? { emit } : {}) },
  });
  const blocked = [
    "revoked",
    "expired",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
  ];
  return [
    row(
      `${G}/booting: the license check runs`,
      { gate: { checking: true } },
      G,
      "booting",
      "all",
      { default: true },
    ),
    row(
      `${G}/booting: a cached license is re-checked`,
      { gate: { checking: true, cached: true } },
      G,
      "booting",
      "all",
      {
        mustNot: { states: ["needs-activation"] },
      },
    ),
    row(
      `${G}/needs-activation`,
      { gate: { status: "needs-activation" } },
      G,
      "needs-activation",
      "all",
    ),
    row(`${G}/licensed`, { gate: { status: "ok" } }, G, "licensed", "all"),
    row(
      `${G}/grace: the app renders, with Reconnect`,
      { gate: { status: "grace", graceDaysLeft: 5 } },
      G,
      "grace",
      "all",
    ),
    ...blocked.map((s) =>
      row(`${G}/blocked: ${s}`, { gate: { status: s } }, G, "blocked", "all"),
    ),
    row(
      `${G}/error: the boot ended in error`,
      st("error", "error", { type: "error", code: "sync-failed" }),
      G,
      "error",
      "all",
    ),
    row(
      `${G}/licensed: License off`,
      { ...licenseOff, gate: { status: "not-applicable" } },
      G,
      "licensed",
      "all",
    ),

    // Boot: one row per stage-matrix outcome it draws (Boot is exempt from service-off rows).
    row(
      "Boot/progress: shell",
      st("shell", "running"),
      "Boot",
      "progress",
      ["boot.starting", "a11y.busy"],
      { default: true },
    ),
    row("Boot/progress: guard", st("guard", "running"), "Boot", "progress", [
      "boot.starting",
      "a11y.busy",
    ]),
    row("Boot/progress: sync", st("sync", "running"), "Boot", "progress", [
      "boot.syncing",
      "a11y.busy",
    ]),
    row("Boot/progress: gate", st("gate", "running"), "Boot", "progress", [
      "gate.checking",
      "a11y.busy",
    ]),
    row("Boot/progress: decide", st("decide", "running"), "Boot", "progress", [
      "boot.deciding",
      "a11y.busy",
    ]),
    row("Boot/progress: mount", st("mount", "running"), "Boot", "progress", [
      "common.loading",
      "a11y.busy",
    ]),
    row("Boot/progress: ready", st("ready", "ready"), "Boot", "progress", [
      "boot.ready",
    ]),
    row(
      "Boot/consent",
      st("fetch", "waiting", {
        type: "consent_needed",
        bytes: 52428800,
        metered: false,
      }),
      "Boot",
      "consent",
      [
        "boot.consent.title",
        "boot.consent.body",
        "boot.consent.download",
        "common.notNow",
      ],
    ),
    row(
      "Boot/consent: metered, both choices on screen",
      st("fetch", "waiting", {
        type: "consent_needed",
        bytes: 52428800,
        metered: true,
      }),
      "Boot",
      "consent",
      [
        "boot.consent.title",
        "boot.consent.bodyMetered",
        "boot.consent.download",
        "common.notNow",
      ],
      { mustNot: { states: ["fetching"] } },
    ),
    row(
      "Boot/fetching: before the first progress report",
      st("fetch", "running"),
      "Boot",
      "fetching",
      ["boot.fetching"],
      {
        mustNot: { copy: ["boot.fetchingProgress", "a11y.progress"] },
      },
    ),
    row(
      "Boot/fetching: with progress",
      st("fetch", "running", {
        type: "fetch_progress",
        done: 20971520,
        total: 52428800,
      }),
      "Boot",
      "fetching",
      ["boot.fetchingProgress", "a11y.progress"],
    ),
    row(
      "Boot/offline",
      st("offline", "offline", { type: "offline", canPlayOffline: false }),
      "Boot",
      "offline",
      ["boot.offline.title", "boot.offline.body", "common.tryAgain"],
    ),
    row(
      "Boot/offline: playable",
      st("offline", "offline", { type: "offline", canPlayOffline: true }),
      "Boot",
      "offline",
      [
        "boot.offline.title",
        "boot.offline.playable",
        "boot.continueOffline",
        "common.tryAgain",
      ],
    ),
    row(
      "Boot/blocked: an update is required",
      st("blocked", "blocked", { type: "blocked", reason: "update-required" }),
      "Boot",
      "blocked",
      "all",
    ),
    row(
      "Boot/declined",
      st("blocked", "blocked", { type: "blocked", reason: "content-declined" }),
      "Boot",
      "declined",
      "all",
    ),
    row(
      "Boot/rolled-back",
      st("sync", "running", { type: "boot_rolled_back" }),
      "Boot",
      "rolled-back",
      "all",
    ),
    row(
      "Boot/error: sync failed",
      st("error", "error", { type: "error", code: "sync-failed" }),
      "Boot",
      "error",
      "all",
    ),
    row(
      "Boot/error: fetch failed",
      st("error", "error", { type: "error", code: "fetch-failed" }),
      "Boot",
      "error",
      "all",
    ),

    // StatusScreen: one state per refusal, each with its fix.
    row(
      "StatusScreen/revoked",
      { gate: { status: "revoked" } },
      "StatusScreen",
      "revoked",
      "all",
      { default: true, mustNot: REVOKED_MUST_NOT },
    ),
    row(
      "StatusScreen/revoked: no sign-in on this build",
      { gate: { status: "revoked" }, capabilities: { signIn: false } },
      "StatusScreen",
      "revoked",
      but("StatusScreen", "revoked", "welcome.signIn"),
      { mustNot: REVOKED_MUST_NOT },
    ),
    row(
      "StatusScreen/revoked: Identity off",
      {
        gate: { status: "revoked" },
        services: off("identity"),
        capabilities: { signIn: false },
      },
      "StatusScreen",
      "revoked",
      but("StatusScreen", "revoked", "welcome.signIn"),
      { mustNot: REVOKED_MUST_NOT },
    ),
    row(
      "StatusScreen/revoked: no key entry",
      { gate: { status: "revoked" }, capabilities: { keyEntry: false } },
      "StatusScreen",
      "revoked",
      but("StatusScreen", "revoked", "signin.key.differentKey"),
      { mustNot: REVOKED_MUST_NOT },
    ),
    row(
      "StatusScreen/expired",
      { gate: { status: "expired" } },
      "StatusScreen",
      "expired",
      "all",
      {
        mustNot: {
          invariant:
            "offer Try again or Reconnect on an expired license (Renew and Use another license are its controls)",
          copy: ["common.tryAgain", "common.reconnect"],
          actions: ["retry"],
        },
      },
    ),
    row(
      "StatusScreen/version-too-old: a minimum",
      { gate: { status: "version-too-old", allowed: { min: "2.0.0" } } },
      "StatusScreen",
      "version-too-old",
      [
        "core.gate.version-too-old.title",
        "core.gate.version-too-old.message",
        "status.update",
        "status.allowedMin",
      ],
    ),
    row(
      "StatusScreen/version-too-old: a range",
      {
        gate: {
          status: "version-too-old",
          allowed: { min: "2.0.0", max: "2.9.9" },
        },
      },
      "StatusScreen",
      "version-too-old",
      [
        "core.gate.version-too-old.title",
        "core.gate.version-too-old.message",
        "status.update",
        "status.allowedRange",
      ],
    ),
    row(
      "StatusScreen/version-too-old: the license caps the version",
      { gate: { status: "version-too-old", allowed: { max: "2.9.9" } } },
      "StatusScreen",
      "version-too-old",
      [
        "core.gate.version-too-old.title",
        "core.gate.version-too-old.message",
        "status.update",
        "status.allowedMax",
      ],
    ),
    row(
      "StatusScreen/version-too-old: no range known",
      { gate: { status: "version-too-old" } },
      "StatusScreen",
      "version-too-old",
      [
        "core.gate.version-too-old.title",
        "core.gate.version-too-old.message",
        "status.update",
      ],
    ),
    row(
      "StatusScreen/version-too-new: a maximum, never a generic error",
      { gate: { status: "version-too-new", allowed: { max: "2.9.9" } } },
      "StatusScreen",
      "version-too-new",
      [
        "core.gate.version-too-new.title",
        "core.gate.version-too-new.message",
        "status.allowedMax",
        "common.tryAgain",
      ],
      {
        mustNot: {
          states: [
            "revoked",
            "expired",
            "version-too-old",
            "channel-not-entitled",
          ],
          copy: ["core.fallback.title", "core.fallback.message"],
        },
      },
    ),
    row(
      "StatusScreen/version-too-new: a range",
      {
        gate: {
          status: "version-too-new",
          allowed: { min: "2.0.0", max: "2.9.9" },
        },
      },
      "StatusScreen",
      "version-too-new",
      [
        "core.gate.version-too-new.title",
        "core.gate.version-too-new.message",
        "status.allowedRange",
        "common.tryAgain",
      ],
    ),
    row(
      "StatusScreen/version-too-new: Try again stays when no range is known",
      { gate: { status: "version-too-new" } },
      "StatusScreen",
      "version-too-new",
      [
        "core.gate.version-too-new.title",
        "core.gate.version-too-new.message",
        "common.tryAgain",
      ],
    ),
    row(
      "StatusScreen/channel-not-entitled",
      { gate: { status: "channel-not-entitled" } },
      "StatusScreen",
      "channel-not-entitled",
      "all",
    ),
    hidden(
      "StatusScreen: License off",
      { ...licenseOff, gate: { status: "not-applicable" } },
      "StatusScreen",
    ),

    // GraceBanner.
    row(
      "GraceBanner/days-left",
      { gate: { status: "grace", graceDaysLeft: 5 } },
      "GraceBanner",
      "days-left",
      "all",
      { default: true },
    ),
    row(
      "GraceBanner/last-day",
      { gate: { status: "grace", graceDaysLeft: 1 } },
      "GraceBanner",
      "last-day",
      "all",
    ),
    row(
      "GraceBanner/last-day: no day left is never shown as days left",
      { gate: { status: "grace", graceDaysLeft: 0 } },
      "GraceBanner",
      "last-day",
      "all",
      {
        mustNot: { states: ["days-left"], copy: ["grace.daysLeft"] },
      },
    ),
    row(
      "GraceBanner/expired",
      { gate: { status: "expired" } },
      "GraceBanner",
      "expired",
      "all",
    ),
    hidden(
      "GraceBanner: License off",
      { ...licenseOff, gate: { status: "not-applicable" } },
      "GraceBanner",
    ),

    // Toast.
    row(
      "Toast/info: an update is available",
      {
        toast: { kind: "update" },
        update: { action: "binary", version: "2.5.0" },
      },
      "Toast",
      "info",
      but("Toast", "info", "signin.key.entriesLeftShort"),
      { default: true },
    ),
    row(
      "Toast/info: key entries left",
      { toast: { kind: "key-entries", left: 2 } },
      "Toast",
      "info",
      ["signin.key.entriesLeftShort"],
    ),
    hidden(
      "Toast/info: key entries, License off",
      {
        ...licenseOff,
        toast: { kind: "key-entries", left: 2 },
      },
      "Toast",
    ),
    hidden(
      "Toast/info: key entries, Identity off",
      {
        services: off("identity"),
        capabilities: { signIn: false },
        toast: { kind: "key-entries", left: 2 },
      },
      "Toast",
    ),
    row(
      "Toast/success: copied",
      { toast: { kind: "copied" } },
      "Toast",
      "success",
      "all",
    ),
    row(
      "Toast/warning",
      { toast: { kind: "warning" } },
      "Toast",
      "warning",
      "all",
    ),
    row(
      "Toast/error: stays until dismissed",
      { toast: { kind: "error" }, error: { code: "sync-failed" } },
      "Toast",
      "error",
      [
        "common.dismiss",
        "core.codes.sync-failed.title",
        "core.codes.sync-failed.message",
      ],
      { mustNot: { copy: ["a11y.toastTimer"] } },
    ),
    row(
      "Toast/with-progress",
      {
        toast: { kind: "progress" },
        update: {
          action: "packs",
          progress: { phase: "download", fraction: 0.4 },
        },
      },
      "Toast",
      "with-progress",
      "all",
    ),
    hidden(
      "Toast/info: Update off",
      { services: off("update"), toast: { kind: "update" } },
      "Toast",
    ),
  ];
}

// ── activate: Welcome, Activate, OfflineActivation ──────────────────────────────────────────

function activateFamily(a: A): Draft[] {
  const { row, all, but, hidden, off } = a;
  const base = all("OfflineActivation", "default");
  const licenseOff = { services: off("license"), registration: "open" };
  const everything = {
    capabilities: {
      offlineActivation: true,
      trial: true,
      restore: true,
      enroll: true,
    },
  };
  const basic = [
    "welcome.title",
    "common.byDeveloper",
    "welcome.lede",
    "welcome.signIn",
    "welcome.useKey",
    "a11y.productIcon",
  ];
  const LONG = "Tidewater Studio Professional Edition for Teams and Classrooms";
  const short = KEY.slice(0, -6);
  return [
    row(
      "Welcome/default: every path the product offers",
      everything,
      "Welcome",
      "default",
      "all",
      { default: true },
    ),
    row("Welcome/default: sign-in and a key", {}, "Welcome", "default", basic),
    row(
      "Welcome/default: a long product name",
      {
        presentation: { name: LONG, developerName: "Harbor Audio", icon: true },
      },
      "Welcome",
      "default",
      basic,
    ),
    row(
      "Welcome/busy: sign-in is starting",
      { pending: "sign-in" },
      "Welcome",
      "busy",
      "all",
    ),
    row(
      "Welcome/capability-limited: key entry only",
      { capabilities: { signIn: false } },
      "Welcome",
      "capability-limited",
      ["welcome.title", "welcome.ledeKeyOnly"],
    ),
    row(
      "Welcome/capability-limited: sign-in only",
      { capabilities: { keyEntry: false } },
      "Welcome",
      "capability-limited",
      ["welcome.title", "welcome.ledeSignInOnly"],
    ),
    row(
      "Welcome: Identity off",
      { services: off("identity"), capabilities: { signIn: false } },
      "Welcome",
      "capability-limited",
      ["welcome.title", "welcome.ledeKeyOnly"],
    ),
    row(
      "Welcome: License off, sign-in registers",
      { services: off("license"), registration: "requires-identity" },
      "Welcome",
      "capability-limited",
      ["welcome.title", "welcome.ledeSignInOnly"],
    ),
    hidden("Welcome: License off, open registration", licenseOff, "Welcome"),

    row(
      "Activate/empty",
      { keyField: { text: "" } },
      "Activate",
      "empty",
      "all",
      { default: true },
    ),
    row(
      "Activate/typing: the prefix so far",
      { keyField: { text: "pkey_tide" } },
      "Activate",
      "typing",
      "all",
    ),
    row(
      "Activate/typing: a secret not yet complete",
      { keyField: { text: short } },
      "Activate",
      "typing",
      "all",
    ),
    row(
      "Activate/parsed",
      { keyField: { text: KEY } },
      "Activate",
      "parsed",
      "all",
    ),
    row(
      "Activate/cut-short: submitted short",
      { keyField: { text: short, submitted: true } },
      "Activate",
      "cut-short",
      "all",
    ),
    row(
      "Activate/busy",
      { keyField: { text: KEY, submitted: true }, pending: "activate" },
      "Activate",
      "busy",
      "all",
    ),
    row(
      "Activate/rejected: not a key",
      { keyField: { text: "tidewater-2024-pro" } },
      "Activate",
      "rejected",
      [...ACTIVATE_BASE, "part.keyField.malformed"],
    ),
    row(
      "Activate/rejected: submitted empty",
      { keyField: { text: "", submitted: true } },
      "Activate",
      "rejected",
      [...ACTIVATE_BASE, "part.keyField.empty"],
    ),
    row(
      "Activate/rejected: the license is disabled",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "license-disabled" },
      },
      "Activate",
      "rejected",
      [...ACTIVATE_BASE, "core.activation.license-disabled.message"],
    ),
    // The refusals a different key cannot fix are a focused step (DL6): no field, lede or paste;
    // Sign in, then (for the limit) the add-key page, a QR on a TV.
    row(
      "Activate/license-owned: another account holds the license",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "refused", code: "license_owned" },
      },
      "Activate",
      "license-owned",
      "all",
      { mustNot: FOCUSED_REFUSAL },
    ),
    row(
      "Activate/key-entry-limit: a link to add the key in Polaris Locker",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "key-entry-limit", manageUrl: MANAGE_URL },
      },
      "Activate",
      "key-entry-limit",
      but("Activate", "key-entry-limit", "signin.key.scan", "a11y.qrAddKey"),
      { mustNot: FOCUSED_REFUSAL },
    ),
    row(
      "Activate/key-entry-limit: no link",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "key-entry-limit" },
      },
      "Activate",
      "key-entry-limit",
      but(
        "Activate",
        "key-entry-limit",
        "signin.key.addInLocker",
        "a11y.externalLink",
        "signin.key.scan",
        "a11y.qrAddKey",
      ),
      { mustNot: FOCUSED_REFUSAL },
    ),
    row(
      "Activate/key-entry-limit: Android TV shows a QR",
      {
        platform: ANDROID_TV,
        keyField: { text: KEY, submitted: true },
        activation: { result: "key-entry-limit", manageUrl: MANAGE_URL },
      },
      "Activate",
      "key-entry-limit",
      but(
        "Activate",
        "key-entry-limit",
        "signin.key.addInLocker",
        "a11y.externalLink",
      ),
      { mustNot: FOCUSED_REFUSAL },
    ),
    row(
      "Activate/device-limit: no link to replace a device",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "device-limit", limit: 3, deviceCount: 3 },
      },
      "Activate",
      "device-limit",
      "all",
    ),
    row(
      "Activate/device-limit: a link to replace a device",
      {
        keyField: { text: KEY, submitted: true },
        activation: {
          result: "device-limit",
          limit: 3,
          deviceCount: 3,
          manageUrl: MANAGE_URL,
        },
      },
      "Activate",
      "device-limit",
      but("Activate", "device-limit", "deviceLimit.noManage"),
    ),
    row(
      "Activate/done",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "ok" },
      },
      "Activate",
      "done",
      "all",
    ),
    row(
      "Activate/done: a floating key needs no account",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "ok" },
        account: { signedIn: false },
      },
      "Activate",
      "done",
      "all",
      {
        mustNot: { states: ["rejected"] },
      },
    ),
    hidden("Activate: License off", licenseOff, "Activate"),

    row(
      "OfflineActivation/default",
      { capabilities: { offlineActivation: true }, offline: {} },
      "OfflineActivation",
      "default",
      "all",
      { default: true },
    ),
    row(
      "OfflineActivation/default: the request QR on a phone too",
      {
        platform: IPHONE,
        capabilities: { offlineActivation: true },
        offline: {},
      },
      "OfflineActivation",
      "default",
      "all",
    ),
    row(
      "OfflineActivation/loaded: the request code was copied",
      { capabilities: { offlineActivation: true }, offline: { copied: true } },
      "OfflineActivation",
      "loaded",
      [...base, "offlineActivation.codeCopied"],
    ),
    row(
      "OfflineActivation/loaded: a loaded file is not yet an activation",
      { capabilities: { offlineActivation: true }, offline: { file: true } },
      "OfflineActivation",
      "loaded",
      base,
      { mustNot: { states: ["done"], copy: ["offlineActivation.done"] } },
    ),
    row(
      "OfflineActivation/loaded: submitted with nothing loaded",
      {
        capabilities: { offlineActivation: true },
        offline: { copied: true, submitted: true },
      },
      "OfflineActivation",
      "loaded",
      [...base, "offlineActivation.empty"],
    ),
    row(
      "OfflineActivation/rejected-signature",
      {
        capabilities: { offlineActivation: true },
        offline: { file: true, submitted: true, verified: false },
      },
      "OfflineActivation",
      "rejected-signature",
      [...base, "core.codes.bundle-jws-rejected.message"],
    ),
    row(
      "OfflineActivation/done",
      {
        capabilities: { offlineActivation: true },
        offline: { file: true, submitted: true, verified: true },
      },
      "OfflineActivation",
      "done",
      "all",
    ),
    hidden(
      "OfflineActivation: License off",
      { ...licenseOff, capabilities: { offlineActivation: true } },
      "OfflineActivation",
    ),
  ];
}

// ── signIn: SignIn, SignInHandoff, LicenseChoice (the one form, §4.5) ───────────────────────

function signInFamily(a: A): Draft[] {
  const { row, all, but, hidden, off } = a;
  const desktop = [
    "signIn.title",
    "signin.methods.ledeApp",
    "signin.provider.group",
    "signin.provider.continue",
    "signin.desktop.continue",
    "signin.choice.keyInstead",
    "signin.menu.signIn",
    "common.cancel",
  ];
  const phone = [
    "signIn.title",
    "signin.methods.ledeApp",
    "signin.provider.group",
    "signin.provider.continue",
    "signin.passkey",
    "signin.email.continue",
    "signin.link.deviceCode",
    "signin.choice.keyInstead",
    "common.cancel",
  ];
  const web = phone.filter((k) => k !== "signin.link.deviceCode");
  const without = (keys: string[], ...drop: string[]) =>
    keys.filter((k) => !drop.includes(k));
  const issued = ["signin.done.start", "signin.return.signedInShort"];
  const existing = ["signin.desktop.toast"];
  const identityOff = {
    services: off("identity"),
    capabilities: { signIn: false },
  };
  const licenseOff = {
    services: off("license"),
    registration: "requires-identity",
  };
  const choose = (o: Obj = {}) => si({ outcome: "choose", ...o });
  const lc = (choices: Obj, o: Obj = {}, s: Obj = {}): Obj => ({
    signIn: choose(s),
    choices,
    ...o,
  });
  /** The key-entry limit's keys: not the owned refusal's. */
  const OWNED_ONLY = [
    "core.codes.license_owned.title",
    "core.codes.license_owned.message",
    "signin.key.ownedSignIn",
  ];
  const manyCopy = [
    "signin.choice.title",
    "signin.choice.lede",
    "signin.choice.group",
    "signin.choice.meta",
    "signin.choice.devices",
    "signin.choice.continue",
  ];
  const codeDesktop = [
    "signin.handoff.codeTitle",
    "signin.handoff.codeBody",
    "part.code.label",
    "a11y.code",
    "a11y.copyCode",
    "signin.handoff.openBrowser",
  ];
  return [
    // SignIn, step 1.
    row(
      "SignIn/methods: desktop",
      { signIn: si() },
      "SignIn",
      "methods",
      desktop,
      { default: true },
    ),
    row(
      "SignIn/methods: Windows",
      { platform: WINDOWS, signIn: si() },
      "SignIn",
      "methods",
      desktop,
    ),
    row(
      "SignIn/methods: iPhone",
      { platform: IPHONE, signIn: si() },
      "SignIn",
      "methods",
      phone,
    ),
    row(
      "SignIn/methods: Android without device code",
      { platform: ANDROID, capabilities: { deviceCode: false }, signIn: si() },
      "SignIn",
      "methods",
      without(phone, "signin.link.deviceCode"),
    ),
    row(
      "SignIn/methods: web",
      { platform: WEB, signIn: si() },
      "SignIn",
      "methods",
      web,
    ),
    row(
      "SignIn/methods: no key entry",
      { capabilities: { keyEntry: false }, signIn: si() },
      "SignIn",
      "methods",
      without(desktop, "signin.choice.keyInstead"),
    ),
    row(
      "SignIn/methods: Cancel returns to step 1",
      { signIn: si({ outcome: "cancelled" }) },
      "SignIn",
      "methods",
      desktop,
    ),
    row(
      "SignIn/methods: browser presentation",
      { signIn: si({ presentation: "browser" }) },
      "SignIn",
      "methods",
      desktop,
    ),
    row(
      "SignIn/methods: License off has no key path",
      { ...licenseOff, signIn: si() },
      "SignIn",
      "methods",
      without(desktop, "signin.choice.keyInstead"),
    ),

    // Step 2.
    row(
      "SignIn/handoff: waiting for the browser",
      { signIn: si({ outcome: "pending" }) },
      "SignIn",
      "handoff",
      "all",
    ),
    row(
      "SignIn/handoff: Open browser again reuses the request",
      { signIn: si({ outcome: "pending", event: "reopen" }) },
      "SignIn",
      "handoff",
      "all",
    ),
    row(
      "SignIn/handoff: browser presentation",
      { signIn: si({ presentation: "browser", outcome: "pending" }) },
      "SignIn",
      "handoff",
      "all",
    ),
    row(
      "SignIn/code: Use a code instead",
      { signIn: si({ outcome: "pending", event: "use-code" }) },
      "SignIn",
      "code",
      "all",
    ),
    row(
      "SignIn/code: a device-code sign-in",
      dc("waiting"),
      "SignIn",
      "code",
      "all",
    ),
    row(
      "SignIn/finishing: redeeming the browser's code",
      { signIn: si({ outcome: "pending", redeeming: true }) },
      "SignIn",
      "finishing",
      "all",
    ),
    row(
      "SignIn/finishing: the device code was approved",
      dc("ok"),
      "SignIn",
      "finishing",
      "all",
    ),

    // Step 3.
    row("SignIn/choose: desktop", lc(VIEW_MANY), "SignIn", "choose", "all"),
    row(
      "SignIn/choose: iPhone",
      { platform: IPHONE, ...lc(VIEW_MANY) },
      "SignIn",
      "choose",
      ["signin.choice.title"],
    ),
    row(
      "SignIn/choose: Replace in the browser",
      lc(VIEW_ALL_FULL, {}, { replace: "browser", event: "open-replace" }),
      "SignIn",
      "choose",
      "all",
      {
        actions: ["replace-in-browser"],
      },
    ),
    row(
      "SignIn/replace: macOS confirms in the system dialog",
      lc(
        VIEW_ALL_FULL,
        { replaceView: REPLACE_VIEW },
        { event: "open-replace" },
      ),
      "SignIn",
      "replace",
      [
        "signin.replace.open",
        "signin.replace.lede",
        "signin.replace.openSystem",
      ],
    ),
    row(
      "SignIn/replace: the web confirms inline",
      {
        platform: WEB,
        ...lc(
          VIEW_ALL_FULL,
          { replaceView: REPLACE_VIEW },
          { event: "open-replace" },
        ),
      },
      "SignIn",
      "replace",
      ["signin.replace.open", "signin.replace.lede", "signin.replace.title"],
    ),
    row(
      "SignIn/key: Use a license key instead keeps the account",
      lc(VIEW_MANY, {}, { event: "have-key" }),
      "SignIn",
      "key",
      ["signin.key.addTitle", "part.keyField.label"],
      { mustNot: { states: ["methods"] } },
    ),
    row(
      "SignIn/key-refused: another account holds the key's license",
      lc(
        VIEW_MANY,
        { activation: { result: "refused", code: "license_owned" } },
        { event: "have-key" },
      ),
      "SignIn",
      "key-refused",
      [
        "core.codes.license_owned.title",
        "core.codes.license_owned.message",
        "signin.key.ownedSignIn",
        "signin.key.differentKey",
      ],
      {
        mustNot: {
          ...FOCUSED_REFUSAL,
          states: ["key"],
          copy: ["part.keyField.label", "signin.key.addTitle"],
        },
      },
    ),
    row(
      "SignIn/key-refused: the key-entry limit, with a link",
      lc(
        VIEW_MANY,
        {
          activation: { result: "key-entry-limit", manageUrl: MANAGE_URL },
        },
        { event: "have-key" },
      ),
      "SignIn",
      "key-refused",
      but(
        "SignIn",
        "key-refused",
        ...OWNED_ONLY,
        "signin.key.scan",
        "a11y.qrAddKey",
      ),
    ),
    row(
      "SignIn/key-refused: the key-entry limit, on Android TV",
      {
        platform: ANDROID_TV,
        ...lc(
          VIEW_MANY,
          {
            activation: { result: "key-entry-limit", manageUrl: MANAGE_URL },
          },
          { event: "have-key" },
        ),
      },
      "SignIn",
      "key-refused",
      but(
        "SignIn",
        "key-refused",
        ...OWNED_ONLY,
        "signin.key.addInLocker",
        "a11y.externalLink",
      ),
    ),

    // Automatic sign-in (I-46.1, plans/auto-sign-in.md §3). The provider is `provider`.
    row(
      "SignIn/confirm: the account's email, a new license",
      {
        provider: "Google",
        signIn: si(),
        account: { signedIn: true, tier: "Pro" },
        autoSignIn: {
          step: "confirm",
          email: "maya@example.com",
          license: "new",
          alsoGets: true,
        },
      },
      "SignIn",
      "confirm",
      but(
        "SignIn",
        "confirm",
        "signin.auto.confirm.asApple",
        "signin.auto.confirm.asGameCenter",
        "signin.auto.confirm.asPlayGames",
        "signin.consent.licenseLine",
      ),
    ),
    row(
      "SignIn/confirm: Apple shared no email, an existing license",
      {
        provider: "Apple",
        signIn: si(),
        autoSignIn: { step: "confirm", kind: "apple", license: "existing" },
      },
      "SignIn",
      "confirm",
      [
        "signin.auto.confirm.title",
        "signin.auto.confirm.asApple",
        "signin.consent.license",
        "signin.consent.licenseLine",
        "signin.auto.confirm.primary",
        "signin.auto.confirm.other",
      ],
    ),
    row(
      "SignIn/confirm: Game Center shared no email, an existing license",
      {
        provider: "Game Center",
        signIn: si(),
        autoSignIn: {
          step: "confirm",
          kind: "gamecenter",
          license: "existing",
        },
      },
      "SignIn",
      "confirm",
      [
        "signin.auto.confirm.title",
        "signin.auto.confirm.asGameCenter",
        "signin.consent.license",
        "signin.consent.licenseLine",
        "signin.auto.confirm.primary",
        "signin.auto.confirm.other",
      ],
    ),
    row(
      "SignIn/confirm: Play Games shared no email, an existing license",
      {
        provider: "Google Play Games",
        signIn: si(),
        autoSignIn: { step: "confirm", kind: "pgs", license: "existing" },
      },
      "SignIn",
      "confirm",
      [
        "signin.auto.confirm.title",
        "signin.auto.confirm.asPlayGames",
        "signin.consent.license",
        "signin.consent.licenseLine",
        "signin.auto.confirm.primary",
        "signin.auto.confirm.other",
      ],
    ),
    row(
      "SignIn/confirm: no email and no known exchange names no account",
      {
        signIn: si(),
        autoSignIn: { step: "confirm", license: "existing" },
      },
      "SignIn",
      "confirm",
      [
        "signin.auto.confirm.title",
        "signin.consent.license",
        "signin.consent.licenseLine",
        "signin.auto.confirm.primary",
        "signin.auto.confirm.other",
      ],
    ),
    row(
      "SignIn/link-offer: Google shared across apps",
      {
        provider: "Google",
        signIn: si(),
        autoSignIn: { step: "link-offer", reach: "global" },
      },
      "SignIn",
      "link-offer",
      but(
        "SignIn",
        "link-offer",
        "signin.linkOffer.bodyDeveloper",
        "signin.linkOffer.bodyApp",
      ),
    ),
    row(
      "SignIn/link-offer: Google per developer",
      {
        provider: "Google",
        signIn: si(),
        autoSignIn: { step: "link-offer", reach: "developer" },
      },
      "SignIn",
      "link-offer",
      but(
        "SignIn",
        "link-offer",
        "signin.linkOffer.bodyGlobal",
        "signin.linkOffer.bodyApp",
      ),
    ),
    row(
      "SignIn/link-offer: Google, reach unknown, is per developer",
      { provider: "Google", signIn: si(), autoSignIn: { step: "link-offer" } },
      "SignIn",
      "link-offer",
      but(
        "SignIn",
        "link-offer",
        "signin.linkOffer.bodyGlobal",
        "signin.linkOffer.bodyApp",
      ),
    ),
    row(
      "SignIn/link-offer: Apple is always per developer",
      {
        provider: "Apple",
        signIn: si(),
        autoSignIn: { step: "link-offer", reach: "global" },
      },
      "SignIn",
      "link-offer",
      but(
        "SignIn",
        "link-offer",
        "signin.linkOffer.bodyGlobal",
        "signin.linkOffer.bodyApp",
      ),
      {
        mustNot: {
          copy: ["signin.linkOffer.bodyGlobal"],
          invariant: "say all apps for Apple",
        },
      },
    ),
    row(
      "SignIn/link-offer: Google per developer, no developer name",
      {
        provider: "Google",
        presentation: { name: "Tidewater Studio", icon: true },
        signIn: si(),
        autoSignIn: { step: "link-offer", reach: "developer" },
      },
      "SignIn",
      "link-offer",
      but(
        "SignIn",
        "link-offer",
        "signin.linkOffer.bodyGlobal",
        "signin.linkOffer.bodyDeveloper",
      ),
    ),
    row(
      "SignIn/link-offer: Apple, no developer name",
      {
        provider: "Apple",
        presentation: { name: "Tidewater Studio", icon: true },
        signIn: si(),
        autoSignIn: { step: "link-offer" },
      },
      "SignIn",
      "link-offer",
      but(
        "SignIn",
        "link-offer",
        "signin.linkOffer.bodyGlobal",
        "signin.linkOffer.bodyDeveloper",
      ),
      {
        mustNot: {
          copy: ["signin.linkOffer.bodyGlobal"],
          invariant: "say all apps for Apple",
        },
      },
    ),
    row(
      "SignIn/link-done",
      {
        provider: "Google",
        signIn: si(),
        autoSignIn: { step: "link-done" },
      },
      "SignIn",
      "link-done",
      "all",
    ),
    row(
      "SignIn/link-conflict",
      {
        provider: "Google",
        signIn: si(),
        autoSignIn: { step: "link-conflict" },
      },
      "SignIn",
      "link-conflict",
      "all",
    ),
    // A device limit with no license rows (KFA-0, decision b): its own step, never the key screen.
    row(
      "SignIn/device-limit: no license rows, with a link to replace a device",
      {
        provider: "Google",
        signIn: si(),
        autoSignIn: { step: "device-limit", manageUrl: MANAGE_URL },
      },
      "SignIn",
      "device-limit",
      [
        "core.codes.device_limit.title",
        "core.codes.device_limit.message",
        "signin.deviceLimit.replace",
        "a11y.externalLink",
        "signin.auto.confirm.other",
        "common.cancel",
      ],
      {
        mustNot: {
          states: ["key", "confirm"],
          copy: ["part.keyField.label", "signin.key.differentKey"],
        },
      },
    ),
    row(
      "SignIn/device-limit: no license rows, no link",
      {
        provider: "Google",
        signIn: si(),
        autoSignIn: { step: "device-limit" },
      },
      "SignIn",
      "device-limit",
      [
        "core.codes.device_limit.title",
        "deviceLimit.noManage",
        "signin.auto.confirm.other",
        "common.cancel",
      ],
      {
        mustNot: { copy: ["signin.deviceLimit.replace", "a11y.externalLink"] },
      },
    ),
    row(
      "SignIn/nearby-prompt: before the system asks for the local network",
      { signIn: si(), autoSignIn: { step: "nearby-prompt" } },
      "SignIn",
      "nearby-prompt",
      "all",
    ),
    row(
      "SignIn/nearby-wait: approve on the other device",
      { signIn: si(), autoSignIn: { step: "nearby-wait", code: "482 913" } },
      "SignIn",
      "nearby-wait",
      "all",
    ),
    row(
      "SignIn/nearby-done",
      {
        signIn: si(),
        autoSignIn: { step: "nearby-done", email: "maya@example.com" },
      },
      "SignIn",
      "nearby-done",
      "all",
    ),
    row(
      "NearbyApproval/entry: the account menu",
      {},
      "NearbyApproval",
      "entry",
      "all",
      { default: true },
    ),
    row(
      "NearbyApproval/ask: choose the code the other device shows",
      { nearbyApproval: { step: "ask", device: "Kitchen iPad" } },
      "NearbyApproval",
      "ask",
      "all",
      { mustNot: { states: ["approved"] } },
    ),
    row(
      "NearbyApproval/approved",
      { nearbyApproval: { step: "approved", device: "Kitchen iPad" } },
      "NearbyApproval",
      "approved",
      "all",
    ),
    row(
      "NearbyApproval/not-nearby",
      { nearbyApproval: { step: "not-nearby", device: "Kitchen iPad" } },
      "NearbyApproval",
      "not-nearby",
      "all",
    ),
    row(
      "NearbyApproval/mismatch: a wrong code denies and says so",
      { nearbyApproval: { step: "mismatch", device: "Kitchen iPad" } },
      "NearbyApproval",
      "mismatch",
      "all",
    ),
    row(
      "NearbyApproval/denied: Deny",
      { nearbyApproval: { step: "denied", device: "Kitchen iPad" } },
      "NearbyApproval",
      "denied",
      "all",
    ),
    row(
      "NearbyApproval/expired: the request lapsed while the prompt was open",
      { nearbyApproval: { step: "expired", device: "Kitchen iPad" } },
      "NearbyApproval",
      "expired",
      "all",
    ),
    row(
      "NearbyApproval/device-limit: the license is full: Manage devices",
      { nearbyApproval: { step: "device-limit", device: "Kitchen iPad" } },
      "NearbyApproval",
      "device-limit",
      "all",
    ),
    row(
      "NearbyApproval/choose: one tap per license, Deny to leave; chosen here, never on the new device",
      { nearbyApproval: { step: "choose", device: "Kitchen iPad" } },
      "NearbyApproval",
      "choose",
      "all",
    ),
    row(
      "NearbyApproval/account-required: this device has no sign-in",
      { nearbyApproval: { step: "account-required", device: "Kitchen iPad" } },
      "NearbyApproval",
      "account-required",
      "all",
    ),
    row(
      "NearbyApproval/rate-limited: too many approvals",
      { nearbyApproval: { step: "rate-limited", device: "Kitchen iPad" } },
      "NearbyApproval",
      "rate-limited",
      "all",
    ),
    hidden("NearbyApproval: Identity off", identityOff, "NearbyApproval"),

    // Step 4 (§4.5: how the form ends; sheet rows are the inline rows' twins).
    row(
      "first-automatic-license",
      { signIn: si({ outcome: "signedIn", issuedNow: true }) },
      "SignIn",
      "done",
      issued,
    ),
    row(
      "SignIn/done: the tier is named in one string",
      {
        signIn: si({ outcome: "signedIn", issuedNow: true }),
        account: { signedIn: true, holder: "Maya", tier: "Pro" },
      },
      "SignIn",
      "done",
      ["signin.done.start", "signin.return.signedInTier"],
    ),
    row(
      "SignIn/done: inline, an existing license opens the app with the toast",
      { signIn: si({ outcome: "signedIn", issuedNow: false }) },
      "SignIn",
      "done",
      existing,
    ),
    row(
      "SignIn/done: browser, a license issued now",
      {
        signIn: si({
          presentation: "browser",
          outcome: "signedIn",
          issuedNow: true,
        }),
      },
      "SignIn",
      "done",
      issued,
    ),
    row(
      "SignIn/done: browser, an existing license",
      {
        signIn: si({
          presentation: "browser",
          outcome: "signedIn",
          issuedNow: false,
        }),
      },
      "SignIn",
      "done",
      existing,
    ),
    row(
      "SignIn/done: device code, a license issued on the card",
      dc("ok", { outcome: "signedIn", issuedNow: true }),
      "SignIn",
      "done",
      issued,
    ),
    row(
      "SignIn/done: device code, an existing license",
      dc("ok", { outcome: "signedIn", issuedNow: false }),
      "SignIn",
      "done",
      existing,
    ),
    row(
      "SignIn/done: License off",
      { ...licenseOff, signIn: si({ outcome: "signedIn" }) },
      "SignIn",
      "done",
      ["signin.return.signedInShort"],
    ),

    row(
      "SignIn/error: a sign-in method failed",
      { signIn: si(), error: { code: "sign-in-failed" } },
      "SignIn",
      "error",
      ["signIn.methodError"],
    ),
    row(
      "SignIn/error: no sign-in method",
      { signIn: si(), error: { code: "sign-in-unavailable" } },
      "SignIn",
      "error",
      ["signIn.noMethods"],
    ),
    row(
      "SignIn/expired: the browser took too long",
      { signIn: si({ outcome: "expired" }) },
      "SignIn",
      "expired",
      ["signin.handoff.tooLong", "signin.again"],
    ),
    row(
      "SignIn/expired: the code expired",
      dc("expired"),
      "SignIn",
      "expired",
      [
        "core.codes.sign-in-expired.title",
        "core.codes.sign-in-expired.message",
        "signin.again",
      ],
    ),
    hidden("SignIn: Identity off", identityOff, "SignIn"),

    // SignInHandoff, step 2's part. Device-code phases select its state (§4.5).
    row(
      "SignInHandoff/starting",
      dc("starting"),
      "SignInHandoff",
      "starting",
      "all",
      { default: true },
    ),
    row(
      "SignInHandoff/waiting: the browser opened",
      { signIn: si({ outcome: "pending" }) },
      "SignInHandoff",
      "waiting",
      "all",
    ),
    row(
      "SignInHandoff/no-browser",
      { signIn: si({ outcome: "pending", browserOpened: false }) },
      "SignInHandoff",
      "no-browser",
      "all",
    ),
    row(
      "SignInHandoff/link-copied",
      {
        signIn: si({
          outcome: "pending",
          browserOpened: false,
          event: "copy-link",
        }),
      },
      "SignInHandoff",
      "link-copied",
      "all",
    ),
    row(
      "SignInHandoff/code: desktop, no QR",
      { ...dc("waiting"), platform: MAC },
      "SignInHandoff",
      "code",
      codeDesktop,
    ),
    row(
      "SignInHandoff/code: the web, no QR",
      { ...dc("waiting"), platform: WEB },
      "SignInHandoff",
      "code",
      codeDesktop,
    ),
    row(
      "SignInHandoff/code: iPhone, the address with Copy",
      { ...dc("waiting"), platform: IPHONE },
      "SignInHandoff",
      "code",
      [
        "signin.handoff.codeTitle",
        "part.code.label",
        "a11y.code",
        "a11y.copyCode",
        "signin.handoff.url",
        "a11y.copyAddress",
        "signin.handoff.openBrowser",
      ],
    ),
    row(
      "SignInHandoff/code: Android TV, a QR beside the code",
      dc("waiting"),
      "SignInHandoff",
      "code",
      [
        "signin.handoff.codeTitle",
        "part.code.label",
        "a11y.code",
        "signInHandoff.scanTv",
        "a11y.qr",
        "signin.handoff.url",
      ],
    ),
    row(
      "SignInHandoff/code: Godot on a TV, a larger QR",
      { ...dc("waiting"), platform: LINUX_TV },
      "SignInHandoff",
      "code",
      [
        "signin.handoff.codeTitle",
        "part.code.label",
        "a11y.code",
        "signInHandoff.scan",
        "a11y.qr",
        "part.qr.enlarge",
      ],
    ),
    row(
      "SignInHandoff/code: slow down keeps the code",
      dc("slow-down"),
      "SignInHandoff",
      "code",
      [
        "signin.handoff.codeTitle",
        "part.code.label",
        "a11y.code",
        "signInHandoff.scanTv",
        "a11y.qr",
        "signin.handoff.url",
      ],
    ),
    row(
      "SignInHandoff/finishing",
      dc("ok"),
      "SignInHandoff",
      "finishing",
      "all",
    ),
    row("SignInHandoff/denied", dc("denied"), "SignInHandoff", "denied", "all"),
    row("SignInHandoff/failed", dc("failed"), "SignInHandoff", "failed", "all"),
    row(
      "SignInHandoff/expired: a lapsed code is never polled again",
      dc("expired"),
      "SignInHandoff",
      "expired",
      "all",
      {
        mustNot: { states: ["code"], copy: ["a11y.code", "part.code.label"] },
      },
    ),
    row(
      "SignInHandoff/cancelled",
      dc("cancelled"),
      "SignInHandoff",
      "cancelled",
      "all",
    ),
    hidden("SignInHandoff: Identity off", identityOff, "SignInHandoff"),

    // LicenseChoice, step 3's part (I-04's views, D2).
    row(
      "LicenseChoice/loading",
      { signIn: choose(), loading: true },
      "LicenseChoice",
      "loading",
      "all",
    ),
    row(
      "LicenseChoice/many",
      lc(VIEW_MANY),
      "LicenseChoice",
      "many",
      [
        ...manyCopy,
        "signin.choice.origin.developer",
        "signin.choice.origin.store",
        "signin.choice.origin.keyAdded",
        "signin.choice.origin.free",
        "signin.term.lifetime",
        "signin.term.until",
      ],
      { default: true },
    ),
    row("sign-in", lc(VIEW_SIGNIN), "LicenseChoice", "many", [
      ...manyCopy,
      "signin.choice.origin.signIn",
      "signin.term.lifetime",
    ]),
    row("LicenseChoice/one", lc(VIEW_ONE), "LicenseChoice", "one", "all"),
    row(
      "LicenseChoice/current",
      lc(VIEW_CURRENT),
      "LicenseChoice",
      "current",
      "all",
    ),
    row(
      "LicenseChoice/keep: never merged with create or a new license",
      lc(VIEW_KEEP),
      "LicenseChoice",
      "keep",
      "all",
      {
        mustNot: {
          states: ["create", "new"],
          copy: ["signin.choice.create", "signin.choice.tag.new"],
        },
      },
    ),
    row(
      "LicenseChoice/new: a first automatic license",
      lc(VIEW_NEW),
      "LicenseChoice",
      "new",
      "all",
    ),
    row(
      "LicenseChoice/create: picked on an all-full list",
      lc(VIEW_ALL_FULL_CREATE, { selected: "create" }),
      "LicenseChoice",
      "create",
      "all",
    ),
    row(
      "LicenseChoice/all-full",
      lc(VIEW_ALL_FULL),
      "LicenseChoice",
      "all-full",
      ["signin.choice.allFull", "signin.choice.tag.full"],
    ),
    row(
      "LicenseChoice/all-full: Create offered",
      lc(VIEW_ALL_FULL_CREATE),
      "LicenseChoice",
      "all-full",
      ["signin.choice.allFullCreate", "signin.choice.tag.full"],
    ),
    row(
      "none-replaceable",
      lc(VIEW_NONE_REPLACEABLE),
      "LicenseChoice",
      "all-full",
      ["signin.choice.noneReplaceable", "signin.choice.tag.full"],
    ),
    row(
      "LicenseChoice/all-full: Replace in the browser",
      lc(VIEW_ALL_FULL, {}, { replace: "browser", event: "open-replace" }),
      "LicenseChoice",
      "all-full",
      ["signin.choice.allFull", "signin.choice.tag.full"],
      { actions: ["replace-in-browser"] },
    ),
    row(
      "LicenseChoice/mixed: a sign-in license beside a key license",
      lc(VIEW_MIXED),
      "LicenseChoice",
      "mixed",
      "all",
    ),
    row(
      "LicenseChoice/replace-open",
      lc(
        VIEW_ALL_FULL,
        { replaceView: REPLACE_VIEW },
        { event: "open-replace" },
      ),
      "LicenseChoice",
      "replace-open",
      "all",
    ),
    row(
      "LicenseChoice/raced: the seat was taken since the view loaded",
      lc(VIEW_MANY, {}, { raced: true }),
      "LicenseChoice",
      "raced",
      ["signin.choice.raced"],
    ),
    row(
      "LicenseChoice/raced: someone took the replaced seat",
      lc(
        VIEW_ALL_FULL,
        { replaceView: REPLACE_VIEW },
        { event: "confirm-replace", raced: true },
      ),
      "LicenseChoice",
      "raced",
      ["signin.replace.raced"],
    ),
    row(
      "LicenseChoice/none-keys",
      lc(VIEW_NONE_KEYS),
      "LicenseChoice",
      "none-keys",
      "all",
    ),
    row(
      "LicenseChoice/none-no-keys",
      lc(VIEW_NONE_NO_KEYS),
      "LicenseChoice",
      "none-no-keys",
      "all",
    ),
    row(
      "LicenseChoice/none-no-keys: nothing to buy",
      lc(VIEW_NONE_BARE),
      "LicenseChoice",
      "none-no-keys",
      but("LicenseChoice", "none-no-keys", "signin.none.get"),
    ),
    row(
      "LicenseChoice/grant-expired",
      lc(VIEW_MANY, {}, { grantExpired: true }),
      "LicenseChoice",
      "grant-expired",
      "all",
    ),
    hidden("LicenseChoice: Identity off", identityOff, "LicenseChoice"),
    hidden(
      "LicenseChoice: License off",
      { ...licenseOff, signIn: si({ outcome: "pending" }) },
      "LicenseChoice",
    ),
  ];
}

// ── deviceLimit and devices ─────────────────────────────────────────────────────────────────

function deviceLimitFamily(a: A): Draft[] {
  const { row, hidden, off } = a;
  const DL = { result: "device-limit", limit: 3, deviceCount: 3 };
  return [
    row(
      "DeviceLimit/default: the devices listed in the app",
      { activation: DL, devices: DEVICES_UNKNOWN_CURRENT },
      "DeviceLimit",
      "default",
      "all",
      { default: true },
    ),
    row(
      "DeviceLimit/busy: replacing",
      { activation: DL, devices: DEVICES_UNKNOWN_CURRENT, pending: "replace" },
      "DeviceLimit",
      "busy",
      "all",
    ),
    row(
      "DeviceLimit/removed: the other device is replaced, nothing here is wiped",
      {
        activation: DL,
        devices: DEVICES_UNKNOWN_CURRENT,
        replacement: { device: "Work laptop", outcome: "done" },
      },
      "DeviceLimit",
      "removed",
      "all",
      { mustNot: {} },
    ),
    row(
      "DeviceLimit/failed",
      {
        activation: DL,
        devices: DEVICES_UNKNOWN_CURRENT,
        replacement: { device: "Work laptop", outcome: "failed" },
      },
      "DeviceLimit",
      "failed",
      "all",
    ),
    row(
      "DeviceLimit/browser-mode: desktop",
      { activation: { ...DL, manageUrl: MANAGE_URL } },
      "DeviceLimit",
      "browser-mode",
      [
        "deviceLimit.title",
        "deviceLimit.browser",
        "deviceLimit.openBrowser",
        "a11y.externalLink",
      ],
    ),
    row(
      "DeviceLimit/browser-mode: Android TV shows a QR",
      { platform: ANDROID_TV, activation: { ...DL, manageUrl: MANAGE_URL } },
      "DeviceLimit",
      "browser-mode",
      [
        "deviceLimit.title",
        "deviceLimit.browser",
        "deviceLimit.scan",
        "a11y.qrManage",
      ],
    ),
    hidden(
      "DeviceLimit: License off",
      { services: off("license"), registration: "open" },
      "DeviceLimit",
    ),
  ];
}

function devicesFamily(a: A): Draft[] {
  const { row, but, hidden, off } = a;
  const unnamed = [...DEVICES.slice(0, 2), { ...DEVICES[2]!, name: null }];
  return [
    row(
      "Devices/list",
      { devices: DEVICES },
      "Devices",
      "list",
      but("Devices", "list", "devices.unnamed"),
      { default: true },
    ),
    row(
      "Devices/list: an unnamed device",
      { devices: unnamed },
      "Devices",
      "list",
      "all",
    ),
    row(
      "Devices/list: the runtime does not know this device",
      { devices: DEVICES_UNKNOWN_CURRENT },
      "Devices",
      "list",
      but("Devices", "list", "devices.unnamed", "part.thisDeviceTitle"),
      { mustNot: { copy: ["part.thisDeviceTitle"] } },
    ),
    row("Devices/loading", { loading: true }, "Devices", "loading", "all"),
    row(
      "Devices/renaming",
      { devices: DEVICES, edit: { kind: "rename", device: "Work laptop" } },
      "Devices",
      "renaming",
      "all",
    ),
    row(
      "Devices/confirming",
      { devices: DEVICES, edit: { kind: "remove", device: "Work laptop" } },
      "Devices",
      "confirming",
      "all",
    ),
    row("Devices/empty", { devices: [] }, "Devices", "empty", "all"),
    row(
      "Devices/browser-mode",
      { browserMode: true },
      "Devices",
      "browser-mode",
      "all",
    ),
    row(
      "Devices/error: the list could not load",
      { error: { code: "device_list_failed" } },
      "Devices",
      "error",
      ["devices.loadFailed", "common.tryAgain"],
    ),
    row(
      "Devices/error: a rename was refused",
      {
        devices: DEVICES,
        edit: { kind: "rename", device: "Work laptop" },
        error: { code: "device_rename_failed" },
      },
      "Devices",
      "error",
      ["devices.renameFailed", "common.tryAgain"],
    ),
    row(
      "Devices/error: a removal was refused",
      {
        devices: DEVICES,
        edit: { kind: "remove", device: "Work laptop" },
        error: { code: "device_deauthorize_failed" },
      },
      "Devices",
      "error",
      ["devices.removeFailed", "common.tryAgain"],
    ),
    hidden(
      "Devices: License off",
      { services: off("license"), registration: "open" },
      "Devices",
    ),
  ];
}

// ── update: UpdatePrompt, UpdateProgress, ReleaseNotes ──────────────────────────────────────

function updateFamily(a: A): Draft[] {
  const { row, but, hidden, off } = a;
  const U = "UpdatePrompt";
  const P = "UpdateProgress";
  const bin = (o: Obj = {}): Obj => ({
    update: { action: "binary", version: "2.5.0", ...o },
  });
  const store = (
    platform: Obj,
    outlet: string,
    key: string,
    name: string,
  ): Draft =>
    row(
      `${U}/store: ${name}`,
      { platform, update: { action: "store", outlet, version: "2.5.0" } },
      U,
      "store",
      [key],
    );
  const plat = (
    platform: Obj,
    outlet: string,
    key: string,
    name: string,
  ): Draft =>
    row(
      `${U}/platform: ${name}`,
      { platform, update: { action: "platform", outlet } },
      U,
      "platform",
      ["update.availableTitle", key],
    );
  const prog = (phase: string, o: Obj = {}): Obj => ({
    update: { action: "binary", version: "2.5.0", progress: { phase, ...o } },
  });
  const NOTES = [
    {
      version: "2.5.0",
      date: "2026-09-30",
      notes: "Faster sync. Fixes a crash on launch.",
    },
    {
      version: "2.4.1",
      date: "2026-08-12",
      notes: "Fixes the mixer on Windows.",
    },
  ];
  return [
    row(
      `${U}/available`,
      bin(),
      U,
      "available",
      but(U, "available", "update.availableTitle", "update.critical"),
      { default: true },
    ),
    row(
      `${U}/available: a security fix`,
      bin({ critical: true }),
      U,
      "available",
      but(U, "available", "update.availableTitle"),
    ),
    row(
      `${U}/available: the new version is not known`,
      { update: { action: "binary" } },
      U,
      "available",
      [
        "update.availableTitle",
        "update.later",
        "update.restartWhenReady",
        "update.skipVersion",
        "update.install",
      ],
    ),
    row(
      `${U}/downloading`,
      prog("download", { fraction: 0.4 }),
      U,
      "downloading",
      "all",
    ),
    row(
      `${U}/ready`,
      { update: { action: "code-ready", version: "2.5.0" } },
      U,
      "ready",
      "all",
    ),
    row(`${U}/mandatory`, bin({ mandatory: true }), U, "mandatory", "all"),
    row(
      `${U}/blocked: no update yet`,
      { update: { action: "blocked", reason: "app-floor" } },
      U,
      "blocked",
      "all",
    ),
    store(IPHONE, "app-store", "update.appStore", "the App Store"),
    store(ANDROID, "play", "update.googlePlay", "Google Play"),
    store(IPHONE, "testflight", "update.testflight", "TestFlight"),
    store(IPHONE, "altstore", "update.altstore", "AltStore"),
    store(WINDOWS, "steam", "update.steam", "a Steam listing"),
    store(WINDOWS, "ms-store", "update.openStore", "the Microsoft Store"),
    plat(WINDOWS, "steam", "update.platform.steam", "Steam installs it"),
    plat(WINDOWS, "itch", "update.platform.itch", "the itch app installs it"),
    plat(
      { os: "linux", formFactor: "computer" },
      "flathub",
      "update.platform.store",
      "a software center installs it",
    ),
    plat(
      WINDOWS,
      "app-installer",
      "update.platform.appInstaller",
      "App Installer installs it",
    ),
    plat(WINDOWS, "winget", "update.platform.command", "a command installs it"),
    plat(
      ANDROID,
      "fdroid-repo",
      "update.platform.package",
      "a package manager installs it",
    ),
    plat(
      ANDROID,
      "obtainium",
      "update.platform.generic",
      "the outlet installs it",
    ),
    row(
      `${U}/platform: the web never offers a restart`,
      { platform: WEB, update: { action: "platform", outlet: "web" } },
      U,
      "platform",
      ["update.availableTitle", "update.platform.web"],
      {
        mustNot: {
          states: ["ready"],
          copy: ["update.restartNow", "update.restartWhenReady"],
        },
      },
    ),
    row(
      `${U}/revoked-required-content`,
      { update: { action: "blocked", reason: "revoked-content" } },
      U,
      "revoked-required-content",
      "all",
    ),
    row(
      `${U}/up-to-date`,
      { update: { action: "none", reason: "up-to-date" } },
      U,
      "up-to-date",
      "all",
    ),
    hidden(`${U}: Update off`, { services: off("update") }, U),

    row(
      `${P}/queued: content`,
      { update: { action: "packs", progress: { phase: "queued" } } },
      P,
      "queued",
      "all",
    ),
    row(`${P}/queued: an app update`, prog("queued"), P, "queued", [
      "updateProgress.queued",
    ]),
    row(
      `${P}/downloading`,
      prog("download", { fraction: 0.4 }),
      P,
      "downloading",
      "all",
      { default: true },
    ),
    row(
      `${P}/downloading: verified, not yet installed`,
      prog("verify", { fraction: 1 }),
      P,
      "downloading",
      "all",
      {
        mustNot: {
          states: ["installing", "done"],
          copy: ["updateProgress.installing", "updateProgress.done"],
        },
      },
    ),
    row(`${P}/installing`, prog("install"), P, "installing", "all"),
    row(
      `${P}/paused: a metered connection`,
      prog("paused", { fraction: 0.4 }),
      P,
      "paused",
      "all",
    ),
    row(`${P}/failed`, prog("failed", { fraction: 0.4 }), P, "failed", "all"),
    row(`${P}/done`, prog("done", { fraction: 1 }), P, "done", "all"),
    hidden(`${P}: Update off`, { services: off("update") }, P),

    row(
      "ReleaseNotes/list",
      { releaseNotes: NOTES },
      "ReleaseNotes",
      "list",
      "all",
      { default: true },
    ),
    row(
      "ReleaseNotes/list: notes that hold markup are text",
      {
        releaseNotes: [
          {
            version: "2.5.0",
            date: "2026-09-30",
            notes: "<script>alert(1)</script> Fixes <b>sync</b>.",
          },
        ],
      },
      "ReleaseNotes",
      "list",
      "all",
      { mustNot: { states: ["error"] } },
    ),
    row(
      "ReleaseNotes/loading",
      { loading: true },
      "ReleaseNotes",
      "loading",
      "all",
    ),
    row(
      "ReleaseNotes/empty",
      { releaseNotes: [] },
      "ReleaseNotes",
      "empty",
      "all",
    ),
    row(
      "ReleaseNotes/error",
      { error: { code: "network" } },
      "ReleaseNotes",
      "error",
      "all",
    ),
    hidden(
      "ReleaseNotes: Release off",
      { services: off("release") },
      "ReleaseNotes",
    ),
  ];
}

// ── settings: AccountAndLicense, Settings ───────────────────────────────────────────────────

/** AccountAndLicense's floating-license lines (UK-42.2): only the holders family's rows show them. */
const FLOATING_KEYS = [
  "account.notInAccount",
  "activate.recommend.action",
  "signin.key.addInLocker",
  "a11y.externalLink",
  "account.removeKey",
];

function settingsFamily(a: A): Draft[] {
  const { row, but, hidden, off } = a;
  const AL = "AccountAndLicense";
  const ACC = { signedIn: true, holder: "account" };
  const signedIn = (...drop: string[]) =>
    but(AL, "signed-in", "part.poweredBy", ...drop);
  const CFG: Obj[] = [
    { key: "render.quality", type: "select", source: "default", locked: false },
    {
      key: "audio.volume",
      type: "number",
      source: "local",
      locked: false,
      min: 0,
      max: 100,
      value: 80,
    },
    { key: "net.proxy", type: "string", source: "env", locked: false },
    {
      key: "ui.compact",
      type: "boolean",
      source: "default",
      locked: false,
      value: true,
    },
    {
      key: "ui.sounds",
      type: "boolean",
      source: "default",
      locked: false,
      value: false,
    },
    {
      key: "debug.logging",
      type: "boolean",
      source: "default",
      locked: false,
      value: false,
      advanced: true,
    },
  ];
  const CFG_LONG: Obj[] = [
    ...CFG,
    ...["a", "b", "c", "d", "e", "f", "g"].map((s) => ({
      key: `extra.${s}`,
      type: "string",
      source: "default",
      locked: false,
    })),
  ];
  const listCopy = but("Settings", "list", "settings.search", "settings.empty");
  return [
    row(`${AL}/signed-in`, { account: ACC }, AL, "signed-in", signedIn(), {
      default: true,
    }),
    row(
      `${AL}/signed-in: Powered by`,
      { account: ACC, integrator: { poweredBy: "line" } },
      AL,
      "signed-in",
      "all",
    ),
    row(
      `${AL}/key-only: never another account's holder`,
      { account: { signedIn: false } },
      AL,
      "key-only",
      but(AL, "key-only", ...FLOATING_KEYS),
      {
        mustNot: { copy: ["account.holder"] },
      },
    ),
    row(`${AL}/loading`, { loading: true }, AL, "loading", "all"),
    row(
      `${AL}/offline`,
      { account: ACC, gate: { status: "grace", graceDaysLeft: 5 } },
      AL,
      "offline",
      "all",
    ),
    row(
      `${AL}: Identity off`,
      {
        services: off("identity"),
        capabilities: { signIn: false },
        account: { signedIn: false },
      },
      AL,
      "key-only",
      but(AL, "key-only", ...FLOATING_KEYS),
    ),
    row(
      `${AL}: License off`,
      {
        services: off("license"),
        registration: "requires-identity",
        account: ACC,
      },
      AL,
      "signed-in",
      signedIn("account.tier", "account.devices"),
    ),
    row(
      `${AL}: Config off`,
      { services: off("config"), account: ACC },
      AL,
      "signed-in",
      signedIn("account.managedSettings", "account.cloudSync"),
    ),
    row(
      `${AL}: Update off`,
      { services: off("update"), account: ACC },
      AL,
      "signed-in",
      signedIn(
        "account.updates",
        "account.autoUpdate",
        "account.channel",
        "update.checkNow",
      ),
    ),
    row(
      `${AL}: Cloud Sync off`,
      { services: off("sync"), account: ACC },
      AL,
      "signed-in",
      signedIn("account.cloudSync"),
    ),

    row("Settings/list", { config: CFG }, "Settings", "list", listCopy, {
      default: true,
    }),
    row(
      "Settings/list: more than twelve settings",
      { config: CFG_LONG },
      "Settings",
      "list",
      but("Settings", "list", "settings.empty"),
    ),
    row("Settings/list: none to show", { config: [] }, "Settings", "list", [
      "settings.title",
      "settings.empty",
    ]),
    row(
      "Settings/list: a theme reveals nothing",
      { config: CFG, integrator: { accent: "#ff6a3d" } },
      "Settings",
      "list",
      listCopy,
      { mustNot: {} },
    ),
    row("Settings/loading", { loading: true }, "Settings", "loading", "all"),
    row(
      "Settings/dirty",
      { config: CFG, edit: { kind: "value" } },
      "Settings",
      "dirty",
      "all",
    ),
    row(
      "Settings/saving",
      { config: CFG, edit: { kind: "value" }, pending: "save" },
      "Settings",
      "saving",
      ["settings.saving"],
    ),
    row(
      "Settings/saving: saved",
      { config: CFG, saved: true },
      "Settings",
      "saving",
      ["settings.saved"],
    ),
    row(
      "Settings/locked: set by an organization",
      {
        config: [
          ...CFG,
          {
            key: "net.lockdown",
            type: "boolean",
            source: "enforced",
            locked: true,
            org: "Fennick Studio",
            value: true,
          },
        ],
      },
      "Settings",
      "locked",
      ["settings.setBy", "a11y.locked"],
    ),
    row(
      "Settings/locked: set by a parent or guardian",
      {
        platform: LINUX_TV,
        config: [
          ...CFG,
          {
            key: "net.lockdown",
            type: "boolean",
            source: "enforced",
            locked: true,
            value: true,
          },
        ],
      },
      "Settings",
      "locked",
      ["settings.setByGuardian", "a11y.locked"],
    ),
    row(
      "Settings/error: could not load",
      { error: { code: "catalog_unavailable" } },
      "Settings",
      "error",
      ["settings.loadFailed", "common.tryAgain"],
    ),
    row(
      "Settings/error: could not save",
      { config: CFG, edit: { kind: "value" }, error: { code: "network" } },
      "Settings",
      "error",
      ["settings.error", "common.tryAgain"],
    ),
    hidden("Settings: Config off", { services: off("config") }, "Settings"),
  ];
}

// ── paywall: Paywall, EntitlementGate ───────────────────────────────────────────────────────

function paywallFamily(a: A): Draft[] {
  const { row, hidden, off } = a;
  const ENT = { name: "pro.export", entitled: false };
  const apple = {
    platform: IPHONE,
    capabilities: { purchase: true },
    entitlement: ENT,
  };
  const licenseOff = { services: off("license"), registration: "open" };
  return [
    row(
      "Paywall/offers: the App Store",
      { ...apple, offers: { available: true } },
      "Paywall",
      "offers",
      [
        "paywall.title",
        "paywall.includes",
        "paywall.upgrade",
        "paywall.redeem",
      ],
      { default: true },
    ),
    row(
      "Paywall/offers: desktop buys in the browser",
      { entitlement: ENT, offers: { available: true } },
      "Paywall",
      "offers",
      ["paywall.title", "paywall.includes", "paywall.portal", "paywall.redeem"],
    ),
    row(
      "Paywall/loading",
      { entitlement: ENT, loading: true },
      "Paywall",
      "loading",
      "all",
    ),
    row(
      "Paywall/purchasing",
      { ...apple, offers: { available: true }, pending: "purchase" },
      "Paywall",
      "purchasing",
      "all",
    ),
    row(
      "Paywall/purchased",
      { ...apple, offers: { available: true, purchased: true } },
      "Paywall",
      "purchased",
      "all",
    ),
    row(
      "Paywall/restore",
      {
        ...apple,
        capabilities: { purchase: true, restore: true },
        offers: { available: true },
        pending: "restore",
      },
      "Paywall",
      "restore",
      "all",
    ),
    row(
      "Paywall/not-available: the web waits for checkout",
      { platform: WEB, entitlement: ENT, offers: { available: false } },
      "Paywall",
      "not-available",
      ["paywall.title", "paywall.notAvailable"],
      {
        mustNot: {
          states: ["offers", "purchasing"],
          copy: ["paywall.portal"],
        },
      },
    ),
    row(
      "Paywall/not-available: hands off to the portal",
      {
        platform: WEB,
        entitlement: ENT,
        offers: { available: false, url: GET_LICENSE.activateUrl },
      },
      "Paywall",
      "not-available",
      "all",
    ),
    row(
      "Paywall/not-available: a link that is not https is never offered",
      {
        platform: WEB,
        entitlement: ENT,
        offers: { available: false, url: "http://tidewater.example/buy" },
      },
      "Paywall",
      "not-available",
      ["paywall.title", "paywall.notAvailable"],
      {
        mustNot: {
          invariant: "open a link that is not https (DL14)",
          copy: ["paywall.portal"],
        },
      },
    ),
    hidden(
      "Paywall: License off",
      { ...licenseOff, entitlement: ENT },
      "Paywall",
    ),

    row(
      "EntitlementGate/entitled",
      { entitlement: { ...ENT, entitled: true } },
      "EntitlementGate",
      "entitled",
      "all",
      { default: true },
    ),
    row(
      "EntitlementGate/not-entitled",
      { entitlement: ENT },
      "EntitlementGate",
      "not-entitled",
      "all",
    ),
    row(
      "EntitlementGate/not-entitled: a style override is not authorization",
      { entitlement: ENT, integrator: { accent: "#ff6a3d" } },
      "EntitlementGate",
      "not-entitled",
      "all",
      {
        mustNot: { states: ["entitled"] },
      },
    ),
    row(
      "EntitlementGate/loading",
      { entitlement: ENT, loading: true },
      "EntitlementGate",
      "loading",
      "all",
    ),
    row(
      "EntitlementGate: License off",
      { ...licenseOff, entitlement: ENT },
      "EntitlementGate",
      "not-entitled",
      ["entitlement.locked"],
    ),
  ];
}

// ── Twins (D4, D6) and actions ──────────────────────────────────────────────────────────────

/** D6: the presentation-absent twin of each must component's default row. */
function absentTwin(d: Draft): Draft {
  const input: Obj = {
    ...d.input,
    presentation: null,
    bundle: { slug: "tidewater", name: "Tidewater Studio" },
  };
  delete input.integrator;
  return {
    name: `${d.expect.component}: presentation absent`,
    input,
    expect: {
      ...d.expect,
      copy: d.expect.copy.filter((k) => !ABSENT_DROPS.includes(k)),
    },
    ...(d.extraActions ? { extraActions: d.extraActions } : {}),
  };
}

/** DL7: the delayed-response twins of a loading state's first row: nothing shown before the
 *  delay, the usual copy past it, and for Devices the last millisecond under the window. */
function delayTwins(d: Draft): Draft[] {
  const at = (elapsedMs: number, label: string, copy: string[]): Draft => ({
    name: `${d.name}: ${label}`,
    input: { ...d.input, elapsedMs },
    expect: { ...d.expect, copy },
  });
  const out = [
    at(0, "before the DL7 delay", []),
    at(LOADING_DELAY.max, "past the DL7 delay", d.expect.copy),
  ];
  if (d.expect.component === "Devices")
    out.splice(1, 0, at(LOADING_DELAY.min - 1, "just under the DL7 delay", []));
  return out;
}

/** D4: the sheet twin of an inline sign-in row. */
function sheetTwin(d: Draft): Draft {
  const signIn = d.input.signIn as Obj;
  return {
    ...d,
    name: `${d.name} (sheet)`,
    input: { ...d.input, signIn: { ...signIn, presentation: "sheet" } },
  };
}

/** A row's actions: those its copy's controls perform, plus any with no copy key. */
export function actionsFor(
  copy: readonly string[],
  extra: readonly string[] = [],
): string[] {
  const out = new Set(extra);
  for (const [action, keys] of Object.entries(ACTION_KEYS))
    if (keys.some((k) => copy.includes(k))) out.add(action);
  return [...out].sort();
}

function finish(d: Draft): Row {
  const copy = [...d.expect.copy].sort();
  const actions = actionsFor(copy, d.extraActions).filter(
    (x) => !d.dropActions?.includes(x),
  );
  const out: Row = {
    name: d.name,
    input: d.input,
    expect: {
      component: d.expect.component,
      state: d.expect.state,
      copy,
      ...(actions.length > 0 ? { actions } : {}),
      ...(d.expect.disabled?.length ? { disabled: d.expect.disabled } : {}),
    },
  };
  if (d.mustNot) {
    const m: MustNot = { invariant: d.mustNot.invariant };
    for (const k of ["states", "copy", "actions"] as const)
      if (d.mustNot[k]?.length) m[k] = [...d.mustNot[k]!].sort();
    out.mustNot = m;
  }
  if (d.notApplicable) out.notApplicable = d.notApplicable;
  return out;
}

// ── nearby (UXR-47b) ────────────────────────────────────────────────────────────────────────

function nearbyFamily(a: A): Draft[] {
  const { row } = a;
  const SI = "SignIn";
  const NA = "NearbyApproval";
  const auto = (step: string): Obj => ({
    signIn: si(),
    autoSignIn: { step },
  });
  const ask = (step: string): Obj => ({
    nearbyApproval: { step, device: "Kitchen iPad" },
  });
  return [
    ...[
      ["nearby-choose", "several devices answered: choose which to ask"],
      [
        "nearby-none-found",
        "nobody answered: open the app on the other device",
      ],
      ["nearby-denied", "the other device denied it"],
      ["nearby-expired", "the request expired"],
      ["nearby-not-nearby", "the other device is not on this network"],
      ["nearby-failed", "the network failed"],
      ["nearby-rate-limited", "too many attempts"],
      ["nearby-unavailable", "this computer cannot look for nearby devices"],
      ["nearby-cancelled", "cancelled, or another account chosen"],
      ["nearby-signed-out", "Not you? signed this device out"],
    ].map(([state, what]) =>
      row(`${SI}/${state}: ${what}`, auto(state!), SI, state!, "all"),
    ),
    ...[
      ["listening", "open, nothing has asked yet"],
      ["stopped", "the advert stopped after declined requests"],
      ["failed", "a server or network failure; nothing approved"],
    ].map(([state, what]) =>
      row(`${NA}/${state}: ${what}`, ask(state!), NA, state!, "all"),
    ),
  ];
}

// ── holders (UK-42.2) ───────────────────────────────────────────────────────────────────────

function holdersFamily(a: A): Draft[] {
  const { row, but, off } = a;
  const AD = "ActivateDone";
  const AT = "AddToAccount";
  const SI = "SignIn";
  const AL = "AccountAndLicense";
  const DONE: Obj = {
    tier: "Pro",
    term: "Lifetime",
    deviceKind: "computer",
    position: 1,
    limit: 3,
  };
  const WAITING = { email: "maya@example.com" };
  const FLOATING = { email: "" };
  const NO_SYNC = off("sync");
  const NO_IDENTITY = {
    services: off("identity"),
    capabilities: { signIn: false },
  };
  const PORTAL = "activate.recommend.portal";
  const SYNC = "activate.recommend.sync";
  const OTHERS = ["activate.recommend.recover", "activate.recommend.devices"];
  // With Identity off the action opens polaris.locker: its own label and the external-link glyph.
  const LOCKER = ["signin.key.addInLocker", "a11y.externalLink"];
  const hidden = (name: string, input: Obj, component: string): Draft =>
    row(name, input, component, "hidden", []);
  const add = (step: string, extra: Obj = {}): Obj => ({
    addToAccount: { step, deviceKind: "computer", ...extra },
  });
  const IN = (step: string, o: Obj = {}): Obj => ({
    signIn: si({ step }),
    ...o,
  });
  const WAITING_COPY = [
    "activate.done.device",
    "activate.done.title",
    "activate.waiting",
    "activate.waitingSignIn",
    "signin.done.start",
  ];
  return [
    // ActivateDone: the step after a key.
    row(
      `${AD}/ready: Cloud Sync, get it back and move it`,
      { activateDone: DONE },
      AD,
      "ready",
      but(AD, "ready", PORTAL, ...LOCKER),
    ),
    row(
      `${AD}/ready: no Cloud Sync line without Cloud Sync`,
      { activateDone: DONE, services: NO_SYNC },
      AD,
      "ready",
      but(AD, "ready", SYNC, PORTAL, ...LOCKER),
    ),
    row(
      `${AD}/ready: Identity off, one reason that opens the portal`,
      { activateDone: DONE, ...NO_IDENTITY },
      AD,
      "ready",
      but(AD, "ready", SYNC, ...OTHERS, "activate.recommend.action"),
    ),
    // No in-app channel (UK-43.2, `licenseHolder.addIn`): Add opens the manage URL, and says so.
    row(
      `${AD}/ready: no in-app channel, Add opens Polaris Locker`,
      { activateDone: DONE, licenseHolder: { ...FLOATING, addIn: "portal" } },
      AD,
      "ready",
      but(AD, "ready", PORTAL, "activate.recommend.action"),
    ),
    row(
      `${AD}/waiting: the license was sent to an email`,
      { activateDone: DONE, licenseHolder: WAITING },
      AD,
      "waiting",
      "all",
    ),
    row(
      `${AD}/ready: sent to an email with Identity off, the portal line`,
      { activateDone: DONE, licenseHolder: WAITING, ...NO_IDENTITY },
      AD,
      "ready",
      but(AD, "ready", SYNC, ...OTHERS, "activate.recommend.action"),
    ),
    hidden(
      `${AD}/hidden: License off`,
      { activateDone: DONE, services: off("license"), registration: "open" },
      AD,
    ),

    // AddToAccount: Add your name and email.
    row(`${AT}/form`, add("form"), AT, "form", but(AT, "form")),
    ...["name", "email", "both"].map((field) =>
      row(
        `${AT}/invalid: ${field}`,
        add("invalid", { field }),
        AT,
        "invalid",
        but(
          AT,
          "invalid",
          ...(field === "name" ? ["signin.email.invalid"] : []),
          ...(field === "email" ? ["activate.attach.nameRequired"] : []),
        ),
      ),
    ),
    row(`${AT}/busy`, add("busy"), AT, "busy", "all"),
    row(
      `${AT}/added: Cloud Sync is on`,
      add("added"),
      AT,
      "added",
      but(AT, "added", "common.done"),
    ),
    row(
      `${AT}/added: no Cloud Sync line without Cloud Sync`,
      { ...add("added"), services: NO_SYNC },
      AT,
      "added",
      but(AT, "added", "activate.attach.syncOn", "common.done"),
    ),
    row(
      `${AT}/added: from Settings it closes with Done`,
      add("added", { fromSettings: true }),
      AT,
      "added",
      but(AT, "added", "signin.done.start"),
    ),
    row(
      `${AT}/owned: someone attached it meanwhile`,
      add("owned"),
      AT,
      "owned",
      "all",
    ),
    row(
      `${AT}/email-bound: the license was sent to another email`,
      { ...add("email-bound"), licenseHolder: WAITING },
      AT,
      "email-bound",
      "all",
    ),
    row(
      `${AT}/other-account: signed in as another account than the email typed`,
      {
        ...add("other-account", {
          typedEmail: "m•••@example.com",
          signedEmail: "j•••@example.com",
        }),
      },
      AT,
      "other-account",
      "all",
    ),
    row(`${AT}/failed: Try again`, add("failed"), AT, "failed", "all"),
    hidden(
      `${AT}/hidden: Identity off`,
      { ...add("form"), ...NO_IDENTITY },
      AT,
    ),

    // SignIn: the form's steps after a key, and its attach.
    row(
      `${SI}/key-done: the recommendation`,
      IN("key-done", { activateDone: DONE }),
      SI,
      "key-done",
      but(
        SI,
        "key-done",
        "activate.waiting",
        "activate.waitingSignIn",
        ...LOCKER,
      ),
    ),
    row(
      `${SI}/key-done: no Cloud Sync line without Cloud Sync`,
      IN("key-done", { activateDone: DONE, services: NO_SYNC }),
      SI,
      "key-done",
      but(
        SI,
        "key-done",
        SYNC,
        "activate.waiting",
        "activate.waitingSignIn",
        ...LOCKER,
      ),
    ),
    row(
      `${SI}/key-done: no in-app channel, Add opens Polaris Locker`,
      IN("key-done", {
        activateDone: DONE,
        licenseHolder: { ...FLOATING, addIn: "portal" },
      }),
      SI,
      "key-done",
      but(
        SI,
        "key-done",
        "activate.waiting",
        "activate.waitingSignIn",
        "activate.recommend.action",
      ),
    ),
    row(
      `${SI}/key-done: waiting for the email's account`,
      IN("key-done", { activateDone: DONE, licenseHolder: WAITING }),
      SI,
      "key-done",
      WAITING_COPY,
    ),
    row(
      `${SI}/attach: name and email`,
      IN("attach", add("form")),
      SI,
      "attach",
      but(SI, "attach", "activate.attach.nameRequired", "signin.email.invalid"),
    ),
    row(
      `${SI}/attach: both fields need fixing`,
      IN("attach", add("invalid", { field: "both" })),
      SI,
      "attach",
      "all",
    ),
    row(
      `${SI}/added: Cloud Sync is on`,
      IN("added", add("added")),
      SI,
      "added",
      but(SI, "added", "common.done"),
    ),
    row(
      `${SI}/added: from Settings it closes with Done`,
      IN("added", add("added", { fromSettings: true })),
      SI,
      "added",
      but(SI, "added", "signin.done.start"),
    ),
    row(
      `${SI}/added: no Cloud Sync line without Cloud Sync`,
      IN("added", { ...add("added"), services: NO_SYNC }),
      SI,
      "added",
      but(SI, "added", "activate.attach.syncOn", "common.done"),
    ),

    // AccountAndLicense: a license held by a key only says so and offers to add it.
    row(
      `${AL}/key-only: floating, Add your name and email`,
      { licenseHolder: FLOATING, account: { signedIn: false } },
      AL,
      "key-only",
      but(
        AL,
        "key-only",
        "account.keyOnly",
        "signin.key.addInLocker",
        "a11y.externalLink",
        "common.signOut",
      ),
    ),
    row(
      `${AL}/key-only: floating with no in-app channel, Add opens Polaris Locker`,
      {
        licenseHolder: { ...FLOATING, addIn: "portal" },
        account: { signedIn: false },
      },
      AL,
      "key-only",
      but(
        AL,
        "key-only",
        "account.keyOnly",
        "activate.recommend.action",
        "common.signOut",
      ),
    ),
    row(
      `${AL}/key-only: floating with Identity off, Add opens the portal`,
      { licenseHolder: FLOATING, account: { signedIn: false }, ...NO_IDENTITY },
      AL,
      "key-only",
      but(
        AL,
        "key-only",
        "account.keyOnly",
        "activate.recommend.action",
        "common.signOut",
      ),
    ),
    row(
      `${AL}/key-only: waiting for the email's account keeps the key line`,
      { licenseHolder: WAITING, account: { signedIn: false } },
      AL,
      "key-only",
      but(
        AL,
        "key-only",
        ...FLOATING_KEYS.filter((k) => k !== "account.removeKey"),
        "common.signOut",
      ),
    ),
  ];
}

// ── holdersFlow (UK-43.2) ───────────────────────────────────────────────────────────────────

/** One step the scripted sign-in answers (`SignInWait`): the others of ui-core carry no data here. */
type FlowWait = {
  outcome: "pending" | "signedIn" | "choose" | "cancelled" | "expired";
  /** `signedIn`: the account's email, when the sign-in names it. */
  email?: string;
  /** `choose`: the grant the choice completes. */
  grant?: string;
};
/** What attach answers: ok, a refusal by code, or `network` (the call throws). */
type FlowAttach =
  | { kind: "ok" }
  | { kind: "refused"; code: string }
  | "network";
type FlowAction =
  | "submit"
  | "tryAgain"
  | "cancel"
  /** Continue is pressed, the sign-in is still open, then Cancel: whatever the sign-in answers
   *  next is dropped (the epoch). */
  | "submit-then-cancel";

export interface FlowScenario {
  name: string;
  /** The typed values; absent members are Ada Lovelace / ada@example.com. */
  fields?: { name?: string; email?: string };
  driver: {
    /** The sign-in's answers in order; once spent, `cancelled`. */
    waits?: FlowWait[];
    /** `choose`: what keeping this device's license answers. */
    complete?: { outcome: "signedIn" | "raced"; issuedNow?: boolean };
    /** The preview (`attach(false)`), in order; once spent, ok. */
    preview?: FlowAttach[];
    /** The write (`attach(true)`), in order; once spent, ok. */
    attach?: FlowAttach[];
    /** Starting the sign-in throws. */
    signInError?: boolean;
  };
  actions: FlowAction[];
  expect: {
    /** The model's step after each action. */
    steps: string[];
    /** The driver's calls in order: signIn, complete:<grant>:keep, preview, attach, cancel. */
    calls: string[];
    /** The sign-in's hints, one per start. */
    hints: { loginHint: string; nameHint: string; purpose: "attach" }[];
    /** After the last action: the AddToAccount view's state and the input the model hands it. */
    viewState: string;
    field?: "name" | "email" | "both";
    /** `other-account`: both masked, never full. */
    typedEmail?: string;
    signedEmail?: string;
  };
}

export interface HoldersFlow {
  description: string;
  /** The context every scenario runs in: the holder AddToAccount reads, and the device kind. */
  base: { licenseHolder: { email: string }; deviceKind: string };
  maskEmail: { email: string | null; masked: string }[];
  scenarios: FlowScenario[];
}

const FLOW_HINTS = [
  {
    loginHint: "ada@example.com",
    nameHint: "Ada Lovelace",
    purpose: "attach" as const,
  },
];

function holdersFlow(): HoldersFlow {
  const OK = { kind: "ok" } as const;
  const refused = (code: string): FlowAttach => ({ kind: "refused", code });
  const signedIn: FlowWait = { outcome: "signedIn" };
  const S = (
    name: string,
    driver: FlowScenario["driver"],
    actions: FlowAction[],
    expect: FlowScenario["expect"],
    fields?: FlowScenario["fields"],
  ): FlowScenario => ({
    name,
    ...(fields ? { fields } : {}),
    driver,
    actions,
    expect,
  });
  const WRITE = ["signIn", "preview", "attach"];
  const scenarios: FlowScenario[] = [
    S(
      "form: nothing typed, Continue names both fields",
      {},
      ["submit"],
      {
        steps: ["invalid"],
        calls: [],
        hints: [],
        viewState: "invalid",
        field: "both",
      },
      { name: "", email: "" },
    ),
    S(
      "form: no email names the email",
      {},
      ["submit"],
      {
        steps: ["invalid"],
        calls: [],
        hints: [],
        viewState: "invalid",
        field: "email",
      },
      { email: "" },
    ),
    S(
      "form: a blank name names the name",
      {},
      ["submit"],
      {
        steps: ["invalid"],
        calls: [],
        hints: [],
        viewState: "invalid",
        field: "name",
      },
      { name: "  " },
    ),
    S(
      "signed in with no choice goes to the preview, then attach",
      {},
      ["submit"],
      {
        steps: ["added"],
        calls: WRITE,
        hints: FLOW_HINTS,
        viewState: "added",
      },
    ),
    S(
      "a choice keeps this device's license, then attaches",
      {
        waits: [{ outcome: "pending" }, { outcome: "choose", grant: "g1" }],
      },
      ["submit"],
      {
        steps: ["added"],
        calls: ["signIn", "complete:g1:keep", "preview", "attach"],
        hints: FLOW_HINTS,
        viewState: "added",
      },
    ),
    S(
      "a choice that does not complete fails before any attach",
      {
        waits: [{ outcome: "choose", grant: "g" }],
        complete: { outcome: "raced" },
      },
      ["submit"],
      {
        steps: ["failed"],
        calls: ["signIn", "complete:g:keep"],
        hints: FLOW_HINTS,
        viewState: "failed",
      },
    ),
    S(
      "attach refused: license_owned",
      { attach: [refused("license_owned")] },
      ["submit"],
      {
        steps: ["owned"],
        calls: WRITE,
        hints: FLOW_HINTS,
        viewState: "owned",
      },
    ),
    S(
      "attach refused: license_email_bound",
      { attach: [refused("license_email_bound")] },
      ["submit"],
      {
        steps: ["email-bound"],
        calls: WRITE,
        hints: FLOW_HINTS,
        viewState: "email-bound",
      },
    ),
    S(
      "attach refused: account_required is a failure",
      { attach: [refused("account_required")] },
      ["submit"],
      {
        steps: ["failed"],
        calls: WRITE,
        hints: FLOW_HINTS,
        viewState: "failed",
      },
    ),
    S(
      "attach refused: any other code is a failure",
      { attach: [refused("unauthorized")] },
      ["submit"],
      {
        steps: ["failed"],
        calls: WRITE,
        hints: FLOW_HINTS,
        viewState: "failed",
      },
    ),
    S(
      "the preview refused: nothing is written",
      { preview: [refused("license_owned")] },
      ["submit"],
      {
        steps: ["owned"],
        calls: ["signIn", "preview"],
        hints: FLOW_HINTS,
        viewState: "owned",
      },
    ),
    S(
      "another account signed in: nothing is written and both emails are masked",
      { waits: [{ outcome: "signedIn", email: "jo@other.com" }] },
      ["submit"],
      {
        steps: ["other-account"],
        calls: ["signIn", "preview"],
        hints: FLOW_HINTS,
        viewState: "other-account",
        typedEmail: "a•••@example.com",
        signedEmail: "j•••@other.com",
      },
    ),
    S(
      "another account signed in: Try again returns to the form, the fields kept",
      { waits: [{ outcome: "signedIn", email: "jo@other.com" }] },
      ["submit", "tryAgain"],
      {
        steps: ["other-account", "form"],
        calls: ["signIn", "preview"],
        hints: FLOW_HINTS,
        viewState: "form",
      },
    ),
    S("the sign-in throws: failed", { signInError: true }, ["submit"], {
      steps: ["failed"],
      calls: ["signIn"],
      hints: FLOW_HINTS,
      viewState: "failed",
    }),
    S("attach throws: failed", { attach: ["network"] }, ["submit"], {
      steps: ["failed"],
      calls: WRITE,
      hints: FLOW_HINTS,
      viewState: "failed",
    }),
    S(
      "Try again after a failed attach attaches again with no second sign-in",
      { attach: ["network", OK] },
      ["submit", "tryAgain"],
      {
        steps: ["failed", "added"],
        calls: ["signIn", "preview", "attach", "preview", "attach"],
        hints: FLOW_HINTS,
        viewState: "added",
      },
    ),
    S(
      "Try again after account_required signs in again",
      {
        waits: [signedIn, signedIn],
        attach: [refused("account_required"), OK],
      },
      ["submit", "tryAgain"],
      {
        steps: ["failed", "added"],
        calls: [...WRITE, ...WRITE],
        hints: [...FLOW_HINTS, ...FLOW_HINTS],
        viewState: "added",
      },
    ),
    S(
      "Try again after an expired sign-in signs in again, the fields kept",
      { waits: [{ outcome: "expired" }, signedIn] },
      ["submit", "tryAgain"],
      {
        steps: ["failed", "added"],
        // Try again lets the failed attempt's sign-in go before it starts another.
        calls: ["signIn", "cancel", ...WRITE],
        hints: [...FLOW_HINTS, ...FLOW_HINTS],
        viewState: "added",
      },
    ),
    S(
      "a cancelled browser returns to the form",
      { waits: [{ outcome: "cancelled" }] },
      ["submit"],
      {
        steps: ["form"],
        calls: ["signIn"],
        hints: FLOW_HINTS,
        viewState: "form",
      },
    ),
    S(
      "Cancel while the sign-in is open drops its late answer (the epoch)",
      { waits: [{ outcome: "pending" }, signedIn] },
      ["submit-then-cancel"],
      {
        steps: ["form"],
        calls: ["signIn", "cancel"],
        hints: FLOW_HINTS,
        viewState: "form",
      },
    ),
  ];
  return {
    description:
      "AddToAccountModel's flow (UK-43.2), mirrored from ui-core's test/addToAccountModel.test.ts: a scripted driver answers (waits, complete, preview, attach), the actions are pressed in order, and the model's step after each, the driver's calls and hints, and the final view's state are pinned. Typed values are fields.name and fields.email (default Ada Lovelace, ada@example.com); they never appear in a view's input. calls: signIn (the start), complete:<grant>:keep, preview (attach with confirm false), attach (confirm true, no address), cancel (the sign-in is let go). A driver call past its script answers ok (preview, attach) or cancelled (waits). maskEmail pins the masking every screen uses: the first character, three dots, the domain; an address it cannot mask is the empty string.",
    base: { licenseHolder: { email: "ada@example.com" }, deviceKind: "Mac" },
    maskEmail: [
      { email: "alex@example.com", masked: "a•••@example.com" },
      { email: "éva@example.co.uk", masked: "é•••@example.co.uk" },
      { email: "ada@example.com", masked: "a•••@example.com" },
      { email: "jo@other.com", masked: "j•••@other.com" },
      { email: "a@b.co", masked: "a•••@b.co" },
      { email: "", masked: "" },
      { email: "@example.com", masked: "" },
      { email: "alex@", masked: "" },
      { email: "alex", masked: "" },
      { email: null, masked: "" },
    ],
    scenarios,
  };
}

/** The flow section's structure: unique names, known steps and calls, sorted nothing. */
function checkHoldersFlow(doc: UiMatrix): string[] {
  const f = doc.holdersFlow;
  if (!f || !Array.isArray(f.scenarios) || f.scenarios.length === 0)
    return ["holdersFlow: no scenarios"];
  const errors: string[] = [];
  const steps = new Set([
    "form",
    "invalid",
    "busy",
    "added",
    "owned",
    "email-bound",
    "other-account",
    "failed",
  ]);
  const names = new Set<string>();
  for (const sc of f.scenarios) {
    const where = `holdersFlow "${sc.name}"`;
    if (names.has(sc.name)) errors.push(`${where}: duplicate name`);
    names.add(sc.name);
    if (sc.expect.steps.length !== sc.actions.length)
      errors.push(`${where}: one step per action`);
    for (const st of [...sc.expect.steps, sc.expect.viewState])
      if (!steps.has(st)) errors.push(`${where}: unknown step ${st}`);
    for (const c of sc.expect.calls)
      if (!/^(signIn|preview|attach|cancel|complete:[^:]+:keep)$/.test(c))
        errors.push(`${where}: unknown call ${c}`);
    if (sc.expect.steps[sc.expect.steps.length - 1] !== sc.expect.viewState)
      errors.push(`${where}: the view state is the last step`);
  }
  for (const m of f.maskEmail)
    if (m.masked.includes(m.email ?? "\u0000") && m.email)
      errors.push(`holdersFlow: ${m.email} is masked to itself`);
  return errors;
}

// ── cloudSync (U-42.0) ──────────────────────────────────────────────────────────────────────

function cloudSyncFamily(a: A): Draft[] {
  const { row, off } = a;
  const SYNC_OFF = off("sync");
  const SERVED = { ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c" };
  const inv = (invariant: string, m: Omit<MustNot, "invariant">) => ({
    mustNot: { invariant, ...m },
  });
  const US = (step: string, extra: Obj = {}): Obj => ({
    unlockSync: { step, ...extra },
  });
  const hidden = (name: string, input: Obj, component: string): Draft =>
    row(name, { services: SYNC_OFF, ...input }, component, "hidden", []);
  return [
    row(
      "CloudSyncStatus/locked: this device has no key",
      { cloudSync: { state: "locked" } },
      "CloudSyncStatus",
      "locked",
      "all",
    ),
    row(
      "CloudSyncStatus/locked: never pulls or says synced",
      { cloudSync: { state: "locked", lastSynced: "2 min ago" } },
      "CloudSyncStatus",
      "locked",
      "all",
      inv("A locked device never shows a sync time or an error.", {
        copy: ["cloudSync.synced", "cloudSync.error"],
      }),
    ),
    row(
      "CloudSyncStatus/signed-out: Sign in to sync, never an error or a sync time",
      {
        cloudSync: { state: "error", signedIn: false, lastSynced: "2 min ago" },
      },
      "CloudSyncStatus",
      "error",
      ["cloudSync.syncStopped", "cloudSync.signIn"],
      inv(
        "A device whose account is gone says so and offers Sign in to sync; it is never an error or a sync time.",
        { copy: ["cloudSync.error", "cloudSync.synced"] },
      ),
    ),
    row(
      "CloudSyncStatus/ring-changed: Review without the host's handler",
      { cloudSync: { state: "ring-changed" } },
      "CloudSyncStatus",
      "ring-changed",
      "all",
    ),
    row(
      "CloudSyncStatus/ring-changed: never offers Unlock sync in its place",
      { cloudSync: { state: "ring-changed", canReview: true } },
      "CloudSyncStatus",
      "ring-changed",
      "all",
      inv("A changed ring is confirmed first; it is never unlocked past.", {
        copy: ["cloudSync.unlock"],
        actions: ["unlock"],
      }),
    ),
    hidden(
      "CloudSyncStatus/hidden: Cloud Sync off",
      { cloudSync: { state: "locked" } },
      "CloudSyncStatus",
    ),

    row(
      "UnlockSync/code: the recovery code and start over",
      US("code"),
      "UnlockSync",
      "code",
      "all",
    ),
    row(
      "UnlockSync/code: the nearby option stays hidden in v0.10.0",
      US("code", { nearby: true }),
      "UnlockSync",
      "code",
      "all",
      inv("v0.10.0 offers the recovery code and start over only.", {
        copy: ["unlockSync.nearby"],
        actions: ["use-nearby"],
      }),
    ),
    row(
      "UnlockSync/invalid: the code failed its check",
      US("invalid"),
      "UnlockSync",
      "invalid",
      "all",
    ),
    row(
      "UnlockSync/working: the code is being checked",
      US("working"),
      "UnlockSync",
      "working",
      "all",
    ),
    row(
      "UnlockSync/failed: the request failed",
      US("failed"),
      "UnlockSync",
      "failed",
      "all",
    ),
    row(
      "UnlockSync/start-over-failed: Start over did not run",
      US("start-over-failed"),
      "UnlockSync",
      "start-over-failed",
      "all",
    ),
    row(
      "UnlockSync/no-code: the account has no recovery code",
      US("no-code"),
      "UnlockSync",
      "no-code",
      "all",
      inv("With no recovery code there is nothing to enter.", {
        copy: ["unlockSync.field", "unlockSync.unlock"],
        actions: ["unlock"],
      }),
    ),
    row(
      "UnlockSync/start-over: warns that synced data will be lost",
      US("start-over"),
      "UnlockSync",
      "start-over",
      "all",
      inv(
        "Start over never runs without the warning that synced data will be lost (T22).",
        {
          actions: ["unlock"],
        },
      ),
    ),
    hidden("UnlockSync/hidden: Cloud Sync off", US("code"), "UnlockSync"),

    row(
      "RecoveryCode/show: shown once, saved before Done",
      { recoveryCode: {} },
      "RecoveryCode",
      "show",
      "all",
      inv("Done waits for the person to confirm they saved the code.", {
        copy: ["common.done"],
      }),
    ),
    row(
      "RecoveryCode/saved: Done",
      { recoveryCode: { saved: true } },
      "RecoveryCode",
      "saved",
      "all",
    ),
    hidden(
      "RecoveryCode/hidden: Cloud Sync off",
      { recoveryCode: {} },
      "RecoveryCode",
    ),

    row(
      "RingChange/confirm: names the device and accepts the ring shown",
      { ringChange: { by: "Maya's MacBook", served: SERVED } },
      "RingChange",
      "confirm",
      a.but(
        "RingChange",
        "confirm",
        "ringChange.bodyUnknown",
        "ringChange.warningNoServed",
      ),
    ),
    row(
      "RingChange/confirm: no device named",
      { ringChange: { served: SERVED } },
      "RingChange",
      "confirm",
      a.but(
        "RingChange",
        "confirm",
        "ringChange.body",
        "ringChange.warningNoServed",
      ),
    ),
    row(
      "RingChange/failed: accepting did not open a root",
      {
        ringChange: { by: "Maya's MacBook", served: SERVED, failed: true },
      },
      "RingChange",
      "failed",
      a.but("RingChange", "failed", "ringChange.bodyUnknown"),
    ),
    row(
      "RingChange/confirm: nothing served, nothing to accept",
      { ringChange: { by: "Maya's MacBook" } },
      "RingChange",
      "confirm",
      a.but(
        "RingChange",
        "confirm",
        "ringChange.bodyUnknown",
        "ringChange.accept",
        "ringChange.warning",
      ),
      inv(
        "Accept hands over the ring that was shown; without one it is not offered.",
        {
          copy: ["ringChange.accept"],
          actions: ["accept-ring-change"],
        },
      ),
    ),
    hidden(
      "RingChange/hidden: Cloud Sync off",
      { ringChange: { served: SERVED } },
      "RingChange",
    ),
  ];
}

// ── saveConflict (U-22.K0) ──────────────────────────────────────────────────────────────────

function saveConflictFamily(a: A): Draft[] {
  const { row, but, off } = a;
  const SYNC_OFF = off("sync");
  const inv = (invariant: string, m: Omit<MustNot, "invariant">) => ({
    mustNot: { invariant, ...m },
  });
  const KEPT_TITLES = [
    "saveConflict.keptLocalTitle",
    "saveConflict.keptRemoteTitle",
    "saveConflict.keptBothTitle",
    "saveConflict.keptDeletedTitle",
  ];
  const KEPT = [...KEPT_TITLES, "saveConflict.keptCopy"];
  const NEWER = ["saveConflict.newerThis", "saveConflict.newerOther"];
  const THIS = { when: "today, 14:02" };
  const OTHER = { when: "yesterday, 21:40", device: "Maya's Steam Deck" };
  const SC = (step: string, extra: Obj = {}): Obj => ({
    saveConflict: { step, local: THIS, remote: OTHER, ...extra },
  });
  const CS = (state: string, extra: Obj = {}): Obj => ({
    cloudSync: { state, ...extra },
  });
  const KEPT_ONLY =
    "Kept names the choice that was made, and no other, as its title.";
  const TD = ["saveConflict.title", "saveConflict.deletedTitle"];
  const keptOthers = (own: string[]) =>
    [...KEPT, ...TD].filter((k) => !own.includes(k));
  const choose = (name: string, input: Obj, drop: string[], o: Opts = {}) =>
    row(
      name,
      input,
      "SaveConflict",
      "choose",
      but("SaveConflict", "choose", ...drop, "saveConflict.reopened"),
      o,
    );
  const NEVER_PENDING =
    "A pending transfer is never reported as synced, whatever the last sync time was.";
  const d = (
    name: string,
    input: Obj,
    state: string,
    copy: string[] | "all",
    o: Opts = {},
  ): Draft => row(name, input, "CloudSyncStatus", state, copy, o);
  return [
    d(
      "CloudSyncStatus/transferring: saves are syncing",
      CS("transferring"),
      "transferring",
      ["cloudSync.transferring"],
    ),
    d(
      "CloudSyncStatus/transferring: how much is done, and never Synced",
      CS("transferring", {
        lastSynced: "2 min ago",
        transfer: { size: "38 MB", total: "61 MB", fraction: 0.62 },
      }),
      "transferring",
      "all",
      inv(NEVER_PENDING, { copy: ["cloudSync.synced"] }),
    ),
    d(
      "CloudSyncStatus/waiting: for a connection, and never Synced",
      CS("waiting", { lastSynced: "2 min ago" }),
      "waiting",
      ["cloudSync.waitingNetwork"],
      inv(NEVER_PENDING, { copy: ["cloudSync.synced"] }),
    ),
    d(
      "CloudSyncStatus/waiting: for power",
      CS("waiting", { reason: "battery" }),
      "waiting",
      ["cloudSync.waitingBattery"],
    ),
    d(
      "CloudSyncStatus/waiting: until the app opens",
      CS("waiting", { reason: "background" }),
      "waiting",
      ["cloudSync.waitingBackground"],
    ),
    d(
      "CloudSyncStatus/transfer-failed: Try again, and never Synced",
      CS("transfer-failed", { lastSynced: "2 min ago" }),
      "transfer-failed",
      "all",
      inv(NEVER_PENDING, { copy: ["cloudSync.synced"] }),
    ),

    choose(
      "SaveConflict/choose: the two copies and the three choices",
      SC("choose", { bothAvailable: true }),
      [
        "saveConflict.deletedTitle",
        "saveConflict.deletedLede",
        "saveConflict.otherUnknown",
        "saveConflict.deletedElsewhere",
        "saveConflict.acceptDelete",
        "saveConflict.bothFull",
        ...NEWER,
      ],
      inv("A save is never discarded without a choice.", {
        states: ["keeping", "kept"],
      }),
    ),
    choose(
      "SaveConflict/choose: the other device is not known",
      SC("choose", { remote: { when: OTHER.when }, bothAvailable: true }),
      [
        "saveConflict.deletedTitle",
        "saveConflict.deletedLede",
        "saveConflict.otherDevice",
        "saveConflict.deletedElsewhere",
        "saveConflict.acceptDelete",
        "saveConflict.bothFull",
        ...NEWER,
      ],
    ),
    choose(
      "SaveConflict/choose: Keep both is disabled while every slot is in use",
      SC("choose", { bothAvailable: false }),
      [
        "saveConflict.deletedTitle",
        "saveConflict.deletedLede",
        "saveConflict.otherUnknown",
        "saveConflict.deletedElsewhere",
        "saveConflict.acceptDelete",
        ...NEWER,
      ],
      {
        dropActions: ["keep-both"],
        mustNot: {
          invariant:
            "Keep both is disabled, with its reason, while all 16 save slots are in use; it never overwrites a slot.",
          actions: ["keep-both"],
        },
      },
    ),
    choose(
      "SaveConflict/choose: the other version is newer",
      SC("choose", { bothAvailable: true, newer: "remote" }),
      [
        "saveConflict.deletedTitle",
        "saveConflict.deletedLede",
        "saveConflict.otherUnknown",
        "saveConflict.deletedElsewhere",
        "saveConflict.acceptDelete",
        "saveConflict.bothFull",
        "saveConflict.newerThis",
      ],
      inv("Newer tags the version the app names and chooses nothing.", {
        states: ["keeping", "kept"],
        copy: ["saveConflict.newerThis"],
      }),
    ),
    choose(
      "SaveConflict/choose: this device's version is newer",
      SC("choose", { bothAvailable: true, newer: "local" }),
      [
        "saveConflict.deletedTitle",
        "saveConflict.deletedLede",
        "saveConflict.otherUnknown",
        "saveConflict.deletedElsewhere",
        "saveConflict.acceptDelete",
        "saveConflict.bothFull",
        "saveConflict.newerOther",
      ],
      inv("Newer tags the version the app names and chooses nothing.", {
        states: ["keeping", "kept"],
        copy: ["saveConflict.newerOther"],
      }),
    ),
    choose(
      "SaveConflict/choose: the other copy was deleted",
      SC("choose", { remote: null, bothAvailable: true }),
      [
        "saveConflict.title",
        "saveConflict.lede",
        "saveConflict.otherDevice",
        "saveConflict.otherUnknown",
        "saveConflict.savedOther",
        "saveConflict.keepOther",
        "saveConflict.keepBoth",
        "saveConflict.bothFull",
        ...NEWER,
      ],
      inv(
        "A deletion is accepted only by its own button, never as Keep the other, Keep both has nothing to keep, and the screen never says two versions.",
        {
          copy: [
            "saveConflict.keepOther",
            "saveConflict.keepBoth",
            "saveConflict.title",
          ],
          actions: ["keep-both"],
        },
      ),
    ),
    row(
      "SaveConflict/choose: a choice met a newer copy, so the versions are read again",
      SC("choose", {
        bothAvailable: true,
        newer: "remote",
        reopened: true,
        remote: { when: "today, 14:05", device: "Maya's Steam Deck" },
      }),
      "SaveConflict",
      "choose",
      but(
        "SaveConflict",
        "choose",
        "saveConflict.deletedTitle",
        "saveConflict.deletedLede",
        "saveConflict.otherUnknown",
        "saveConflict.deletedElsewhere",
        "saveConflict.acceptDelete",
        "saveConflict.bothFull",
        "saveConflict.newerThis",
      ),
      inv(
        "A choice that met a newer copy applies nothing: the person sees the new version and chooses again.",
        { states: ["keeping", "kept"] },
      ),
    ),
    choose(
      "SaveConflict/choose: one version, no Newer tag",
      SC("choose", { remote: null, bothAvailable: true, newer: "local" }),
      [
        "saveConflict.title",
        "saveConflict.lede",
        "saveConflict.otherDevice",
        "saveConflict.otherUnknown",
        "saveConflict.savedOther",
        "saveConflict.keepOther",
        "saveConflict.keepBoth",
        "saveConflict.bothFull",
        ...NEWER,
      ],
      inv("With one version there is nothing to compare: no Newer tag.", {
        copy: NEWER,
        actions: ["keep-both"],
      }),
    ),
    row(
      "SaveConflict/keeping: the choice is being applied",
      SC("keeping", { keep: "local" }),
      "SaveConflict",
      "keeping",
      ["saveConflict.title", "saveConflict.keeping", "a11y.busy"],
      inv("A choice is applied once: no control is offered while it runs.", {
        actions: ["keep-both", "keep-local", "keep-remote"],
      }),
    ),
    row(
      "SaveConflict/keeping: after a deletion elsewhere",
      SC("keeping", { remote: null, keep: "remote" }),
      "SaveConflict",
      "keeping",
      ["saveConflict.deletedTitle", "saveConflict.keeping", "a11y.busy"],
      inv(
        "After a deletion elsewhere no step says two versions, and nothing is offered while it runs.",
        {
          copy: ["saveConflict.title"],
          actions: ["keep-both", "keep-local", "keep-remote"],
        },
      ),
    ),
    ...(
      [
        [
          "this device's version",
          { keep: "local" },
          ["saveConflict.keptLocalTitle"],
        ],
        [
          "the other version",
          { keep: "remote" },
          ["saveConflict.keptRemoteTitle"],
        ],
        [
          "both versions",
          { keep: "both" },
          ["saveConflict.keptBothTitle", "saveConflict.keptCopy"],
        ],
        [
          "the deletion",
          { remote: null, keep: "remote" },
          ["saveConflict.keptDeletedTitle"],
        ],
        [
          "this device's version after a deletion elsewhere",
          { remote: null, keep: "local" },
          ["saveConflict.keptLocalTitle"],
        ],
      ] as [string, Obj, string[]][]
    ).map(([name, extra, own]) =>
      row(
        `SaveConflict/kept: ${name}`,
        SC("kept", extra),
        "SaveConflict",
        "kept",
        [...own, "common.done"],
        inv(KEPT_ONLY, { copy: keptOthers(own) }),
      ),
    ),
    row(
      "SaveConflict/failed: both saves are unchanged",
      SC("failed", { keep: "local" }),
      "SaveConflict",
      "failed",
      [
        "saveConflict.title",
        "saveConflict.failed",
        "common.tryAgain",
        "saveConflict.chooseAgain",
        "common.cancel",
      ],
      inv("A failed choice never says kept; both copies stay as they were.", {
        states: ["kept"],
        copy: [...KEPT, "saveConflict.failedDeleted"],
      }),
    ),
    row(
      "SaveConflict/failed: after a deletion elsewhere, your save is unchanged",
      SC("failed", { remote: null, keep: "remote" }),
      "SaveConflict",
      "failed",
      [
        "saveConflict.deletedTitle",
        "saveConflict.failedDeleted",
        "common.tryAgain",
        "saveConflict.chooseAgain",
        "common.cancel",
      ],
      inv(
        "A failed choice never says kept, and with one save it never says two versions or both saves.",
        {
          states: ["kept"],
          copy: [...KEPT, "saveConflict.failed", "saveConflict.title"],
        },
      ),
    ),
    row(
      "SaveConflict/hidden: Cloud Sync off",
      { services: SYNC_OFF, ...SC("choose", { bothAvailable: true }) },
      "SaveConflict",
      "hidden",
      [],
    ),
  ];
}

// ── theme ───────────────────────────────────────────────────────────────────────────────────

/** UI-KITS §1.2 and §3.4: the theme a kit resolves for an input. Checks every authored row. */
export function resolveTheme(input: Obj): ThemeRow["expect"] {
  const integrator = (input.integrator ?? {}) as Obj;
  const presentation =
    input.presentation === undefined
      ? (DEFAULTS.presentation as Obj)
      : (input.presentation as Obj | null);
  const bundle = (input.bundle ?? DEFAULTS.bundle) as Obj;
  const platform = (input.platform ?? DEFAULTS.platform) as Obj;
  const kit = input.kit as string;
  const preset = (input.preset as string | undefined) ?? "polaris-key";
  const name =
    (integrator.name as string | undefined) ??
    (presentation?.name as string | undefined) ??
    (bundle.name as string | undefined) ??
    (bundle.slug as string);
  const hasIcon = integrator.icon === true || presentation?.icon === true;
  const icon = kit === "terminal" ? "none" : hasIcon ? "image" : "monogram";
  const accentSource =
    integrator.accent === "core"
      ? "core"
      : typeof integrator.accent === "string"
        ? "integrator"
        : preset === "native"
          ? "host"
          : typeof presentation?.accent === "string"
            ? "product"
            : hasIcon
              ? "icon"
              : "ink";
  const colorScheme =
    (input.colorScheme as string | undefined) ??
    (kit === "godot" || platform.formFactor === "tv" ? "dark" : "system");
  return { name, accentSource, colorScheme, icon, preset };
}

function themeRows(): ThemeRow[] {
  const DRIFT = {
    name: "Drift Kart",
    developerName: "Lanternworks",
    accent: "#ff6a3d",
    icon: true,
  };
  const rows: [string, Obj][] = [
    ...KITS.map((kit): [string, Obj] => [
      `${kit}: Tidewater's accent comes from its icon`,
      { kit },
    ]),
    ...KITS.map((kit): [string, Obj] => [
      `${kit}: the native preset takes the host's accent`,
      { kit, preset: "native" },
    ]),
    [
      "godot: Drift Kart's own accent, dark by default",
      { kit: "godot", presentation: DRIFT },
    ],
    [
      "godot: Drift Kart in the light scheme the game asks for",
      { kit: "godot", presentation: DRIFT, colorScheme: "light" },
    ],
    [
      "react: Drift Kart's light accent on a light ground",
      { kit: "react", presentation: DRIFT, colorScheme: "light" },
    ],
    [
      "react: Drift Kart's light accent on a dark ground",
      { kit: "react", presentation: DRIFT, colorScheme: "dark" },
    ],
    [
      "react: the integrator's accent wins over presentation",
      { kit: "react", presentation: DRIFT, integrator: { accent: "#2f6fde" } },
    ],
    [
      "swiftui: the integrator's accent wins under native too",
      { kit: "swiftui", preset: "native", integrator: { accent: "#2f6fde" } },
    ],
    [
      "elements: Polaris violet only when the integrator asks",
      { kit: "elements", integrator: { accent: "core" } },
    ],
    [
      "compose: no accent and no icon falls to ink",
      {
        kit: "compose",
        presentation: { name: "Tidewater Studio", icon: false },
      },
    ],
    [
      "qt: no presentation, the bundle names it, ink and a monogram",
      { kit: "qt", presentation: null },
    ],
    [
      "react: the integrator's name and icon win",
      {
        kit: "react",
        presentation: null,
        integrator: { name: "Tidewater", icon: true },
      },
    ],
    [
      "compose: Android TV is dark by default",
      { kit: "compose", platform: ANDROID_TV },
    ],
    [
      "terminal: the integrator's accent, no icon drawn",
      { kit: "terminal", integrator: { accent: "#2f6fde" } },
    ],
    [
      "react: a long product name",
      {
        kit: "react",
        presentation: {
          name: "Tidewater Studio Professional Edition for Teams and Classrooms",
          developerName: "Harbor Audio",
          icon: true,
        },
      },
    ],
  ];
  return rows.map(([name, input]) => ({
    name,
    input,
    expect: resolveTheme(input),
  }));
}

// ── i18n: the generator-local reference formatter ───────────────────────────────────────────

type Piece = { text: string } | { arg: string } | { hash: true };
interface Parsed {
  head: Piece[];
  complex?: {
    arg: string;
    kind: "plural" | "select";
    cases: Record<string, Piece[]>;
  };
  tail: Piece[];
}

/** Parse the ICU subset of plans/UK-02.md D5 (plain args; one plural or a formFactor select). */
export function refParse(src: string): Parsed {
  let i = 0;
  const pieces = (inPlural: boolean, inCase: boolean): Piece[] => {
    const out: Piece[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ text });
      text = "";
    };
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "}") break;
      if (ch === "#" && inPlural) {
        flush();
        out.push({ hash: true });
        i++;
        continue;
      }
      if (ch === "{") {
        const m = /^\{([A-Za-z][A-Za-z0-9]*)(\}|,)/.exec(src.slice(i));
        if (!m)
          throw new Error(
            `ui-matrix i18n: bad argument in ${JSON.stringify(src)}`,
          );
        if (m[2] === ",") {
          if (inCase)
            throw new Error(
              `ui-matrix i18n: nested complex argument in ${JSON.stringify(src)}`,
            );
          break;
        }
        flush();
        out.push({ arg: m[1]! });
        i += m[0].length;
        continue;
      }
      text += ch;
      i++;
    }
    flush();
    return out;
  };
  const head = pieces(false, false);
  if (i >= src.length) return { head, tail: [] };
  const m = /^\{([A-Za-z][A-Za-z0-9]*), *(plural|select) *,/.exec(src.slice(i));
  if (!m)
    throw new Error(
      `ui-matrix i18n: bad complex argument in ${JSON.stringify(src)}`,
    );
  i += m[0].length;
  const kind = m[2] as "plural" | "select";
  const cases: Record<string, Piece[]> = {};
  for (;;) {
    while (src[i] === " ") i++;
    if (src[i] === "}") {
      i++;
      break;
    }
    const c = /^([a-z]+) *\{/.exec(src.slice(i));
    if (!c)
      throw new Error(`ui-matrix i18n: bad case in ${JSON.stringify(src)}`);
    i += c[0].length;
    cases[c[1]!] = pieces(kind === "plural", true);
    if (src[i] !== "}")
      throw new Error(
        `ui-matrix i18n: unclosed case in ${JSON.stringify(src)}`,
      );
    i++;
  }
  const tail = pieces(false, false);
  if (i < src.length)
    throw new Error(`ui-matrix i18n: trailing text in ${JSON.stringify(src)}`);
  return { head, complex: { arg: m[1]!, kind, cases }, tail };
}

/** Format one message: plain args substituted, the plural case by Intl.PluralRules(locale) with
 *  `#` as the number, the select case by `formFactor` (an unknown value takes `other`). */
export function refFormat(
  locale: string,
  message: string,
  args: Record<string, string | number>,
): string {
  const p = refParse(message);
  const render = (x: Piece): string =>
    "text" in x
      ? x.text
      : "arg" in x
        ? args[x.arg] === undefined
          ? `{${x.arg}}`
          : String(args[x.arg])
        : String(args[p.complex!.arg]);
  let body: Piece[] = [];
  if (p.complex) {
    const v = args[p.complex.arg];
    let c: string;
    if (p.complex.kind === "plural") {
      c = new Intl.PluralRules(locale).select(Number(v));
      if (!(c in p.complex.cases)) c = "other";
    } else c = typeof v === "string" && v in p.complex.cases ? v : "other";
    body = p.complex.cases[c]!;
  }
  return [...p.head, ...body, ...p.tail].map(render).join("");
}

/** UI-KITS §4.7's lookup: the locale's override, the locale's table, the English override, then
 *  English. A table is the kit catalog plus `core.*` (English core copy for a pending pack). */
export function refLookup(
  S: UiMatrixSources,
  locale: string,
  key: string,
  overrides: Record<string, Record<string, string>> = {},
): string | undefined {
  const table = (l: string): Record<string, string> | undefined =>
    S.kit[l] ? { ...S.kit[l], ...(S.core[l] ?? S.core.en) } : undefined;
  return (
    overrides[locale]?.[key] ??
    table(locale)?.[key] ??
    overrides.en?.[key] ??
    table("en")?.[key]
  );
}

const PLURAL_SAMPLES = [1, 0, 2, 3, 5, 11, 21, 100, 1000000];
const CLDR_ORDER = ["zero", "one", "two", "few", "many", "other"];

/** A locale's plural categories in CLDR order (ICU versions list them in different orders). */
export function pluralCategories(locale: string): string[] {
  const got = new Intl.PluralRules(locale).resolvedOptions()
    .pluralCategories as string[];
  return CLDR_ORDER.filter((c) => got.includes(c));
}

function i18nRows(S: UiMatrixSources): I18nRow[] {
  const rows: Omit<I18nRow, "expect">[] = [];
  const LONG = "Tidewater Studio Professional Edition for Teams and Classrooms";
  // Every plural category of every locale, on a counter and on a sentence around one.
  for (const locale of LOCALES) {
    for (const category of pluralCategories(locale)) {
      const n = PLURAL_SAMPLES.find(
        (x) => new Intl.PluralRules(locale).select(x) === category,
      );
      if (n === undefined)
        throw new Error(`ui-matrix i18n: no sample for ${locale} ${category}`);
      rows.push({
        name: `${locale}: devices.count, plural ${category}`,
        locale,
        key: "devices.count",
        args: { count: n },
      });
      rows.push({
        name: `${locale}: grace.daysLeft, plural ${category}`,
        locale,
        key: "grace.daysLeft",
        args: { days: n },
      });
    }
  }
  // Each formFactor case, in English and in a pack.
  for (const ff of FORM_FACTORS) {
    rows.push({
      name: `en: part.thisDeviceTitle, ${ff}`,
      locale: "en",
      key: "part.thisDeviceTitle",
      args: { formFactor: ff },
    });
    rows.push({
      name: `ja: deviceLimit.lede, ${ff}`,
      locale: "ja",
      key: "deviceLimit.lede",
      args: { formFactor: ff },
    });
  }
  rows.push({
    name: "en: an unknown formFactor takes other",
    locale: "en",
    key: "part.thisDeviceTitle",
    args: { formFactor: "watch" },
  });
  // Plain arguments in every locale, and the long product name in de and ja.
  for (const locale of LOCALES)
    rows.push({
      name: `${locale}: welcome.title`,
      locale,
      key: "welcome.title",
      args: { product: "Tidewater Studio" },
    });
  for (const locale of ["en", "de", "ja"])
    rows.push({
      name: `${locale}: a long product name`,
      locale,
      key: "update.readyTitle",
      args: { product: LONG, version: "2.5.0" },
    });
  // core.* keys: a translated pack, the pending fr pack, and arguments.
  for (const locale of ["en", "de", "fr", "ja"])
    rows.push({
      name: `${locale}: core.gate.expired.title`,
      locale,
      key: "core.gate.expired.title",
      args: {},
    });
  rows.push({
    name: "ko: core.codes.license_owned.message",
    locale: "ko",
    key: "core.codes.license_owned.message",
    args: { product: "Tidewater Studio" },
  });
  // The customer site's address (LK-00 §5): the displayed form of polaris.locker/activate.
  rows.push({
    name: "en: signin.handoff.url, the customer site address",
    locale: "en",
    key: "signin.handoff.url",
    args: { url: "polaris.locker/activate" },
  });
  // Per-key fallback from an override map, and a locale with no pack.
  const overrides = {
    de: { "welcome.signIn": "Mit Tidewater anmelden" },
    en: { "welcome.useKey": "Enter a Tidewater key" },
  };
  rows.push({
    name: "de: the locale's override wins",
    locale: "de",
    key: "welcome.signIn",
    args: {},
    overrides,
  });
  rows.push({
    name: "de: another key falls back to the locale's table",
    locale: "de",
    key: "welcome.trial",
    args: {},
    overrides,
  });
  rows.push({
    name: "de: the English override before English",
    locale: "de",
    key: "welcome.useKey",
    args: {},
    overrides,
  });
  rows.push({
    name: "sv: a locale with no pack falls back to English",
    locale: "sv",
    key: "welcome.title",
    args: { product: "Tidewater Studio" },
  });
  rows.push({
    name: "sv: and to the English override",
    locale: "sv",
    key: "welcome.useKey",
    args: {},
    overrides,
  });
  return rows.map((r) => {
    const message = refLookup(S, r.locale, r.key, r.overrides);
    if (message === undefined)
      throw new Error(`ui-matrix i18n: no table has ${r.key}`);
    const locale = S.kit[r.locale] ? r.locale : "en";
    return { ...r, expect: refFormat(locale, message, r.args) };
  });
}

// ── The terminal contract: the `cli` family (plans/UK-51.md §3) ─────────────────────────────
//
// What every terminal drop-in does, for Node, Python and the JVM alike (DL6 to DL8 in a terminal,
// docs/design/UI-KITS-LANGUAGE-MATRIX.md "Terminal form"). A `cli` row has no component, so the
// family is one object with typed sections rather than a COMPONENT_FAMILIES entry:
//
//   verbs         the verb ids (a verb's words joined with a space): the end-user set a mount
//                 offers by default, the developer verbs it offers only by name, the aliases
//   mount         {host, options} -> the commands mounted, the collision error, the verbs skipped
//                 and the options hidden
//   help          {host, options} -> the help page's sections in order
//   gate          licenseStatus x tty x json x entitled -> run, the inline flow, or a refusal
//   outcomes      a kit verb in a situation -> its mark, exit, result fields, stdout and fixes
//   stdin         activate with no key, per kind of stdin -> what it reads
//   capabilities  environment x streams x flags -> colour, unicode, interactive, animate, links
//   exit          the exit table
//
// Mount, help and the gate are references the adapters run (UK-46, UK-48, UK-52 to UK-54); the
// rest pins the two terminal kits as they are. The mount, help, gate and capability expectations
// are computed by the generator-local references below, which import nothing they check.

/** The exit codes of every terminal kit (Node's `EXIT`, Python's exit table). A refused gate is
 *  4, as `gh` exits for "requires authentication"; `status` and a network failure stay 1. */
export const CLI_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  licenseRequired: 4,
  interrupted: 130,
} as const;

/** The default mount: the verbs a person using the host's CLI needs. */
export const CLI_END_USER = [
  "activate",
  "deactivate",
  "devices approve",
  "devices deauthorize",
  "devices list",
  "devices rename",
  "login",
  "logout",
  "status",
  "update apply",
  "update check",
] as const;

/** Opt-in: mounted only when `verbs` names them. */
export const CLI_DEVELOPER = [
  "boot",
  "changelog",
  "completion",
  "config get",
  "config list",
  "config reset",
  "config set",
  "doctor",
  "enroll",
  "import-bundle",
  "mint",
  "offline-request",
  "packs ensure",
  "packs status",
  "register",
  "secret",
] as const;

/** Other names a one-word verb answers to, kept so older scripts still run. */
export const CLI_ALIASES: Readonly<Record<string, string>> = {
  "sign-in": "login",
  "sign-out": "logout",
};

/** The registration error a host command equal to a mounted one raises, and the two options that
 *  resolve it. */
export const CLI_COLLISION = "polaris-verb-collision";
export const CLI_COLLISION_FIXES = ["namespace", "verbs"] as const;
/** The kit copy key of the one help heading the mounted verbs sit under. */
export const CLI_HELP_GROUP = "cli.help.group";
/** The options a mount hides once the host gives it its `config`. */
export const CLI_CONFIG_OPTIONS = [
  "--base-url",
  "--product",
  "--trust",
] as const;
/** How long `activate` waits on a piped stdin that sends nothing (DL16). */
export const CLI_STDIN_WAIT_MS = 2000;

/** A step's mark, by its symbol name in the terminal tokens: `ok` (a check), `fail` (a cross,
 *  a failure: what happened), `warn` (a triangle, a refusal: what resolves it). */
export const CLI_MARKS = ["fail", "ok", "warn"] as const;
/** The gate statuses the host's action runs on (with the entitlement held). */
export const CLI_USABLE = ["grace", "not-applicable", "ok"] as const;
/** The statuses an interactive run resolves inline: activating another key or signing in fixes
 *  them; activating fixes neither version refusal nor a channel. */
export const CLI_INLINE_FLOW = [
  "expired",
  "needs-activation",
  "revoked",
] as const;
/** The host command the gate rows gate. */
const CLI_GATE_COMMAND = "export";

/** What each outcome row sets up. A runner drives the kit's verb with a stub client in that
 *  state, on a Unicode terminal 80 columns wide (`json: false`) or with `--json`. */
export const CLI_SITUATIONS: Readonly<Record<string, string>> = {
  "status-revoked":
    "`status` on a device signed in to an account, whose license the server revoked.",
  "status-expired": "`status`: the license expired.",
  "status-version-too-old":
    "`status`: this version is below the license's allowed range.",
  "status-version-too-new":
    "`status`: this version is above the license's allowed range.",
  "status-channel-not-entitled":
    "`status`: the license does not include this build's channel.",
  "status-version-too-new-no-page":
    "`status`: this version is above the license's allowed range, and the product's discovery says its portal is off (`core.portal` is `{enabled:false}`).",
  "status-channel-not-entitled-no-page":
    "`status`: the license does not include this build's channel, and the product's discovery says its portal is off (`core.portal` is `{enabled:false}`).",
  "activate-floating":
    "`activate`, a well-formed key on a piped stdin, the license is held by the key alone (no account on this device, no address on the license) and Identity is on: after the success, the recommendation title and the product page link (never `#key=`).",
  "activate-floating-no-page":
    "`activate`, as `activate-floating`, and the product's discovery says its portal is off (`core.portal` is `{enabled:false}`): the success alone, no recommendation line.",
  "activate-waiting":
    "`activate`, as `activate-floating`, but the license was sent to an address and no account holds it: the masked address and the `login` command row.",
  "activate-identity-off":
    "`activate`, as `activate-floating`, with Identity off for the product: the portal reason and the product page link.",
  "status-floating":
    "`status` on a license held by the key alone (no account on this device, no address on the license): the license row says it is not in an account, and the product page link follows.",
  network:
    "`devices list`: the request fails with the registry code `network`.",
  "key-refused":
    "`activate`, a well-formed key on a piped stdin: the server answers 401 `unauthorized`.",
  "device-limit":
    "`activate`, a well-formed key on a piped stdin: the server answers `device_limit` with a `manageUrl`; no key reader, so the flow ends.",
  "secret-hidden":
    "`secret api_key` for a secret that is set, without `--reveal`.",
  "mint-hidden": "`mint cdn` without `--reveal`.",
  usage: "`devices rename` with no device id.",
  interrupt:
    "`activate` on an interactive terminal with no key: Ctrl-C at the key prompt.",
  "sign-in-cancelled":
    "`login` on an interactive terminal: Esc while it waits for the browser.",
  "sign-in-denied":
    "`login`: the device-code poll answers `error` with `reason: access_denied`.",
  "sign-in-failed":
    "`login`: the device-code poll answers a bare `error` (no `reason`).",
  "sign-in-nearby":
    "`login` on an interactive terminal, nearby on: an approver answers within 2 s, the code is shown and the person taps it on the other device. With `--json` nearby never starts (no browse, no LAN request): the device-code flow runs and signs in.",
  "sign-in-nearby-handoff":
    "`login` on an interactive terminal, nearby on: no approver answers within 2 s, so nearby is cancelled and the regular sign-in runs and signs in.",
  "approve-approved":
    "`devices approve` on an interactive terminal, signed in: a device nearby asks, the person taps the code it shows (one of three) and the device is signed in.",
  "approve-mismatch":
    "`devices approve`: the person taps a code the other device does not show; the request is denied.",
  "approve-denied":
    "`devices approve`: the person chooses Deny; the request is denied.",
  "approve-not-nearby":
    "`devices approve`: the Worker answers that the device that asked is not on this network (`not_nearby`).",
  "approve-unsupported":
    "`devices approve` on a runtime that cannot take part in the nearby handshake (CC-15 answers `nearby-unsupported`).",
  "approve-account-required":
    "`devices approve` on a device that is signed out: there is no account to approve for.",
  "approve-json":
    "`devices approve --json`: both sides need a person, so the run is refused before anything starts.",
};

/** What `activate` with no key may find on stdin (DL16). */
export const CLI_STDIN_KINDS: Readonly<Record<string, string>> = {
  tty: "A terminal, on an interactive run.",
  "tty-noninteractive":
    "A terminal, on a run that cannot prompt (`CI` is truthy).",
  file: "A regular file.",
  fifo: "A FIFO: a shell pipe.",
  socket:
    "A socket: what a Node parent's pipe is (`spawn`, `execSync({ input })`, execa).",
  "char-device": "A character device such as /dev/null: never read.",
};

/** `vocabulary.cli`: how a runner reads each section. */
const CLI_VOCABULARY = {
  sections: {
    verbs:
      "Verb ids are a verb's words joined with a space. endUser is the default mount; developer verbs mount only when options.verbs names them; aliases maps another name to a one-word verb.",
    mount:
      "Register the kit's verbs into a host CLI whose own top-level commands are input.host, with input.options. mounted: the commands the host gains, as typed (namespace first). error: the registration error (nothing is mounted): every host command equal to a namespace, a verb's first word or an alias, and the two options that resolve it. skipped: the verbs onCollision skip dropped; the kit warns once, naming them. hidden: the options help hides once config is given. The host's own commands are never renamed, removed or re-described.",
    help: "The root help page's sections in order: the host's, under its headings, then one section whose heading is the kit copy key `copy` with what the mount added at the top level (a namespace is one entry). commands is each section's set; within a section the kit keeps its order.",
    gate: "requireLicense(handler, {entitlement?}) before the host's command input.command. run: the action runs and exits as it does. flow: the kit's activate or sign-in flow runs inline, then the action. refuse: mark, the title (copy; {command} is input.command; no message line, because the fix follows), then link (portal: the product page, from the kit's portal URL; contact: `status.contact` with the developer's name, where the kit resolves no product page, WIRE-CONTRACT-V4 section 5.7: input.portal is false) and the fix verbs as command rows, written once to stream (stderr: no escape off a terminal), the exit; fix is the verbs filtered by input.mounted (absent: the end-user set), and a link stands in when none is left. fail: input.check (the check throws, or answers a status that is not a licenseStatus) draws a cross with copy (title and message), no fix row, exit 4. With --json stdout carries only `result`, the envelope's result line (CLI_JSON_VERSION 1).",
    outcomes:
      "Drive the kit's verb in input.situation (situations) on a Unicode terminal (json false) or with --json, and compare: exit; mark, the outcome's step mark (that symbol is drawn and the other of fail and warn is not); error and code, the result's fields (null: no error); stdout (empty: nothing on stdout; screen: the flow is drawn on stdout; result: only JSON lines, the last the result); fix, the verb ids of the command rows drawn, as a set; link, the row drawn where no fix verb is (portal: the product page link; contact: `status.contact` with the developer's name, where the kit resolves no product page, WIRE-CONTRACT-V4 section 5.7 - a situation whose name ends -no-page sets up a client whose discovery says the portal is off; an `activate` row of that kind and no link draws neither the link nor a contact row, its success stands alone).",
    stdin:
      "activate with no key, stdin of kind input.stdin (stdinKinds) given input.lines, each followed by a newline (null: nothing is written and the writer stays open). read: prompt (the masked entry), key (the first non-empty line, here the fixture key, without waiting for the writer to close) or none (the copy key, the exit, the error, and with withinMs the run ends, process and all, within that many milliseconds). The none screen is drawn on stdout, like every kit verb's screen (outcomes stdout: screen); stderr is the gate's, because a gated host command's stdout is the host's.",
    capabilities:
      "detectTerminal over input.env, the streams (tty or pipe) and the flags (color false is --no-color), to colour, unicode, interactive, animate and links.",
    exit: "The exit codes every terminal kit uses.",
  },
  marks: {
    ok: "A check: done.",
    fail: "A cross: a failure, with what happened.",
    warn: "A triangle: a refusal the person can resolve, with its fix (DL6).",
  },
  collision: { code: CLI_COLLISION, fixes: [...CLI_COLLISION_FIXES] },
  helpGroup: CLI_HELP_GROUP,
  configOptions: [...CLI_CONFIG_OPTIONS],
  usable: [...CLI_USABLE],
  inlineFlow: [...CLI_INLINE_FLOW],
  errors: {
    license_required:
      "A refused gate: the license is not usable, or the version is outside its allowed range.",
    not_entitled:
      "A refused gate: the license does not include the channel, or the entitlement the gate asks for.",
    usage: "An argument error (exit 2).",
    interrupted: "Ctrl-C (exit 130).",
    internal: "An unexpected exception (exit 1).",
  },
  situations: CLI_SITUATIONS,
  stdinKinds: CLI_STDIN_KINDS,
  stdinWaitMs: CLI_STDIN_WAIT_MS,
};

export interface CliMountInput {
  /** The host's own top-level commands. */
  host: string[];
  options: {
    namespace?: string;
    /** The verb ids to mount; absent: the end-user set. */
    verbs?: string[];
    onCollision?: "error" | "skip";
    /** The host passed its `config` (product, trust and base URL) at registration. */
    config?: boolean;
  };
}
export interface CliMountExpect {
  /** The commands the host gains, as typed (namespace first), sorted; none when it fails. */
  mounted: string[];
  /** The registration error, or null: the colliding words, sorted, and the two fixes. */
  error: null | { code: string; words: string[]; fixes: string[] };
  /** Verb ids `onCollision: "skip"` dropped, sorted; the kit warns once, naming them. */
  skipped: string[];
  /** The options the mount hides, sorted. */
  hidden: string[];
}
export interface CliHelpSection {
  /** A host heading, as the host wrote it. */
  heading?: string;
  /** The kit copy key of the mounted verbs' heading. */
  copy?: string;
  /** The section's entries as a set (sorted); within a section the kit keeps its own order. */
  commands: string[];
}
export interface CliGateInput {
  status: string;
  /** stdin and stdout are terminals and the capability table answers interactive. */
  tty: boolean;
  json: boolean;
  /** The entitlement the gate asks for is held, or it asks for none. */
  entitled: boolean;
  command: string;
  /** The verb ids the host's mount offers; absent: the end-user set. */
  mounted?: string[];
  /** The kit knows no product page for this product (so the link is the developer's name). */
  portal?: false;
  /** The license check itself fails: `client.status()` throws, or answers a status that is not
   *  a licenseStatus. */
  check?: "throws" | "unknown-status";
}
export interface CliGateExpect {
  outcome: "run" | "flow" | "refuse" | "fail";
  mark?: string;
  exit?: number;
  error?: string;
  copy?: string[];
  fix?: string[];
  /** A row above the fix rows: the product page, or "Contact {developer}" where there is none. */
  link?: "portal" | "contact";
  stream?: "stderr" | "stdout";
  result?: Obj;
}
export interface CliOutcomeExpect {
  exit: number;
  mark?: string;
  /** The result's `error`; absent on a row that pins one means the result carries none. */
  error?: string | null;
  /** The result's `code` (an activation's registry code, `kind`'s wire code). */
  code?: string;
  stdout?: "empty" | "screen" | "result";
  fix?: string[];
  /** The product page link drawn instead of a fix row the screen cannot draw, or "Contact
   *  {developer}" where the kit resolves no product page (WIRE-CONTRACT-V4 §5.7). */
  link?: "portal" | "contact";
}
export interface CliStdinExpect {
  read: "prompt" | "key" | "none";
  key?: string;
  exit?: number;
  error?: string;
  copy?: string[];
  withinMs?: number;
}
export interface CliCapabilityInput {
  env: Record<string, string>;
  stdout: "tty" | "pipe";
  stdin: "tty" | "pipe";
  flags: { color?: boolean; ascii?: boolean; json?: boolean };
}
export interface CliCapabilityExpect {
  color: "none" | "ansi16" | "truecolor";
  unicode: boolean;
  interactive: boolean;
  animate: boolean;
  links: boolean;
}

export interface CliFamily {
  verbs: { endUser: string[]; developer: string[]; aliases: Obj };
  mount: { name: string; input: CliMountInput; expect: CliMountExpect }[];
  help: {
    name: string;
    input: {
      host: { heading: string; commands: string[] }[];
      options: CliMountInput["options"];
    };
    expect: { sections: CliHelpSection[] };
  }[];
  gate: { name: string; input: CliGateInput; expect: CliGateExpect }[];
  outcomes: {
    name: string;
    input: { verb: string; situation: string; json: boolean };
    expect: CliOutcomeExpect;
  }[];
  stdin: {
    name: string;
    /** The lines written to stdin, each ending in a newline; null: nothing is written and the
     *  writer stays open. */
    input: { stdin: string; lines: string[] | null };
    expect: CliStdinExpect;
  }[];
  capabilities: {
    name: string;
    input: CliCapabilityInput;
    expect: CliCapabilityExpect;
  }[];
  exit: typeof CLI_EXIT;
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
const cliVerbs = (): string[] => sorted([...CLI_END_USER, ...CLI_DEVELOPER]);
const aliasesOf = (verb: string): string[] =>
  sorted(
    Object.entries(CLI_ALIASES)
      .filter(([, v]) => v === verb)
      .map(([a]) => a),
  );

/** The mount rule (UK-51 §3 `mount`): the top-level words a mount takes are the namespace, or each
 *  verb's first word and its aliases. A host command equal to one fails the whole registration
 *  (nothing is mounted) naming every colliding word, unless `onCollision: "skip"` drops the verbs
 *  that use those words. The host's own commands are never renamed, removed or re-described. */
export function refMount(input: CliMountInput): CliMountExpect {
  const o = input.options;
  const verbs = o.verbs ?? [...CLI_END_USER];
  const wordsOf = (v: string): string[] =>
    o.namespace !== undefined
      ? [o.namespace]
      : [v.split(" ")[0]!, ...aliasesOf(v)];
  const host = new Set(input.host);
  const colliding = new Set(
    verbs.flatMap((v) => wordsOf(v).filter((w) => host.has(w))),
  );
  const hidden = o.config ? [...CLI_CONFIG_OPTIONS] : [];
  if (colliding.size > 0 && o.onCollision !== "skip")
    return {
      mounted: [],
      error: {
        code: CLI_COLLISION,
        words: sorted(colliding),
        fixes: [...CLI_COLLISION_FIXES],
      },
      skipped: [],
      hidden,
    };
  const skipped = verbs.filter((v) => wordsOf(v).some((w) => colliding.has(w)));
  const kept = verbs.filter((v) => !skipped.includes(v));
  return {
    mounted: sorted(
      kept.map((v) => (o.namespace !== undefined ? `${o.namespace} ${v}` : v)),
    ),
    error: null,
    skipped: sorted(skipped),
    hidden,
  };
}

/** The help rule: the host's sections first, in its order and under its headings; then one
 *  section under `cli.help.group` with what the mount added at the top level. */
export function refHelp(input: CliFamily["help"][number]["input"]): {
  sections: CliHelpSection[];
} {
  const m = refMount({
    host: input.host.flatMap((s) => s.commands),
    options: input.options,
  });
  const top =
    input.options.namespace !== undefined
      ? m.mounted.length > 0
        ? [input.options.namespace]
        : []
      : m.mounted;
  return {
    sections: [
      ...input.host.map((s) => ({
        heading: s.heading,
        commands: sorted(s.commands),
      })),
      { copy: CLI_HELP_GROUP, commands: sorted(top) },
    ],
  };
}

/** The gate rule (UK-51 §3 `gate`; DL6; H1a): a usable license with the entitlement runs the
 *  action; an interactive run resolves needs-activation, expired and revoked inline; a check that
 *  fails (it throws, or answers an unknown status) is a cross, exit 4, with no fix; everything
 *  else is a refusal, a triangle with its fix, exit 4, on stderr (once, no escape off a terminal)
 *  or, with `--json`, as the result line on stdout. Not-entitled, channel and version-too-new
 *  refusals lead with the product page link (the developer's name where there is none); a refusal
 *  whose fix verbs the mount does not offer is led by the link too, so it never has zero rows. */
export function refGate(i: CliGateInput): CliGateExpect {
  const usable = (CLI_USABLE as readonly string[]).includes(i.status);
  const stream = i.json ? ("stdout" as const) : ("stderr" as const);
  const result = (error: string) =>
    i.json
      ? {
          result: {
            v: 1,
            command: i.command,
            event: "result",
            ok: false,
            exit: CLI_EXIT.licenseRequired,
            error,
          },
        }
      : {};
  if (i.check)
    return {
      outcome: "fail",
      mark: "fail",
      exit: CLI_EXIT.licenseRequired,
      error: "license_required",
      copy: ["core.codes.sync-failed.message", "core.codes.sync-failed.title"],
      fix: [],
      stream,
      ...result("license_required"),
    };
  if (usable && i.entitled) return { outcome: "run" };
  if (
    !usable &&
    i.tty &&
    !i.json &&
    (CLI_INLINE_FLOW as readonly string[]).includes(i.status)
  )
    return { outcome: "flow" };
  const notEntitled = usable || i.status === "channel-not-entitled";
  const error = notEntitled ? "not_entitled" : "license_required";
  const copy = usable
    ? ["cli.gate.notIncluded"]
    : i.status === "needs-activation"
      ? ["cli.gate.needs"]
      : [`core.gate.${i.status}.title`];
  const verbs = notEntitled
    ? ["status"]
    : i.status === "version-too-new"
      ? ["status"]
      : i.status === "version-too-old"
        ? ["update apply"]
        : ["activate", "login"];
  const fix = verbs.filter(
    (v) => i.mounted === undefined || i.mounted.includes(v),
  );
  const leads = notEntitled || i.status === "version-too-new";
  const link =
    leads || fix.length === 0
      ? i.portal === false
        ? ("contact" as const)
        : ("portal" as const)
      : undefined;
  return {
    outcome: "refuse",
    mark: "warn",
    exit: CLI_EXIT.licenseRequired,
    error,
    copy,
    ...(link ? { link } : {}),
    fix,
    stream,
    ...result(error),
  };
}

/** The capability rule (DL13, DL16), the one both kits follow: CI is truthy over `CI`,
 *  `GITHUB_ACTIONS` and `BUILDKITE` (`0` and `false` are not); `FORCE_COLOR` forces colour on a
 *  pipe but never links; interaction needs both streams; animation and links follow stdout. */
export function refCapabilities(i: CliCapabilityInput): CliCapabilityExpect {
  const e = i.env;
  const truthy = (k: string) =>
    e[k] !== undefined && !["", "0", "false"].includes(e[k]!.toLowerCase());
  const ci = truthy("CI") || truthy("GITHUB_ACTIONS") || truthy("BUILDKITE");
  const dumb = e.TERM === "dumb";
  const out = i.stdout === "tty";
  const json = i.flags.json === true;
  const color: CliCapabilityExpect["color"] =
    json || i.flags.color === false || e.NO_COLOR || dumb
      ? "none"
      : truthy("FORCE_COLOR")
        ? "ansi16"
        : !out
          ? "none"
          : ["truecolor", "24bit"].includes(e.COLORTERM ?? "")
            ? "truecolor"
            : "ansi16";
  const live = out && !ci && !json && !dumb;
  return {
    color,
    unicode: !(i.flags.ascii === true || dumb || e.TERM === "linux"),
    interactive: live && i.stdin === "tty",
    animate: live,
    links: live,
  };
}

function cliFamily(): CliFamily {
  const mountRows: { name: string; input: CliMountInput }[] = [
    {
      name: "the end-user set mounts at the root",
      input: { host: ["build", "export"], options: {} },
    },
    {
      name: "a namespace nests every verb",
      input: { host: ["build", "export"], options: { namespace: "license" } },
    },
    {
      name: "verbs picks a subset",
      input: {
        host: ["export"],
        options: { verbs: ["activate", "login", "logout", "status"] },
      },
    },
    {
      name: "developer verbs mount only by name",
      input: {
        host: ["export"],
        options: { verbs: ["activate", "doctor", "secret", "status"] },
      },
    },
    {
      name: "a host command equal to a mounted verb fails at registration",
      input: { host: ["export", "status"], options: {} },
    },
    {
      name: "the error names every colliding word",
      input: { host: ["devices", "export", "status"], options: {} },
    },
    {
      name: "an alias collides as its verb",
      input: { host: ["sign-in"], options: {} },
    },
    {
      name: "a namespace avoids the collision",
      input: { host: ["status"], options: { namespace: "license" } },
    },
    {
      name: "the namespace's own word can collide",
      input: { host: ["license"], options: { namespace: "license" } },
    },
    {
      name: "onCollision skip drops the verb and warns once",
      input: { host: ["status"], options: { onCollision: "skip" } },
    },
    {
      name: "skip drops every verb under a colliding word",
      input: { host: ["devices"], options: { onCollision: "skip" } },
    },
    {
      name: "verbs without the colliding one needs no skip",
      input: {
        host: ["status"],
        options: { verbs: ["activate", "login", "logout"] },
      },
    },
    {
      name: "config hides the product, trust and base URL options",
      input: { host: ["export"], options: { config: true } },
    },
  ];
  const helpRows: {
    name: string;
    input: CliFamily["help"][number]["input"];
  }[] = [
    {
      name: "the host's commands first, then the license verbs under one heading",
      input: {
        host: [{ heading: "Commands", commands: ["export", "import"] }],
        options: {},
      },
    },
    {
      name: "the host's headings keep their order",
      input: {
        host: [
          { heading: "Build", commands: ["build", "watch"] },
          { heading: "Export", commands: ["export"] },
        ],
        options: {},
      },
    },
    {
      name: "a namespace is one entry under the heading",
      input: {
        host: [{ heading: "Commands", commands: ["export"] }],
        options: { namespace: "license" },
      },
    },
    {
      name: "verbs lists only the verbs it mounts",
      input: {
        host: [{ heading: "Commands", commands: ["export"] }],
        options: { verbs: ["activate", "status"] },
      },
    },
    {
      name: "a skipped verb is not listed",
      input: {
        host: [{ heading: "Commands", commands: ["export", "status"] }],
        options: { onCollision: "skip" },
      },
    },
    {
      name: "with no host commands only the license heading",
      input: { host: [], options: {} },
    },
  ];
  const gateRows: CliFamily["gate"] = [];
  for (const status of [
    "ok",
    "grace",
    "expired",
    "revoked",
    "needs-activation",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
    "not-applicable",
  ])
    for (const tty of [true, false])
      for (const json of [false, true])
        for (const entitled of [true, false]) {
          const input: CliGateInput = {
            status,
            tty,
            json,
            entitled,
            command: CLI_GATE_COMMAND,
          };
          gateRows.push({
            name: `${status}, ${tty ? "tty" : "no tty"}, ${json ? "--json" : "text"}, ${entitled ? "entitled" : "not entitled"}`,
            input,
            expect: refGate(input),
          });
        }
  const extra = (name: string, input: CliGateInput) =>
    gateRows.push({ name, input, expect: refGate(input) });
  const base = (status: string): CliGateInput => ({
    status,
    tty: false,
    json: false,
    entitled: status !== "ok",
    command: CLI_GATE_COMMAND,
  });
  // A check that fails closes the gate (H1a): a cross, exit 4, no fix.
  for (const check of ["throws", "unknown-status"] as const)
    for (const tty of [true, false])
      for (const json of [false, true])
        extra(
          `the check ${check === "throws" ? "throws" : "answers an unknown status"}, ${tty ? "tty" : "no tty"}, ${json ? "--json" : "text"}`,
          {
            status: check === "throws" ? "ok" : "unrecognised",
            tty,
            json,
            entitled: true,
            command: CLI_GATE_COMMAND,
            check,
          },
        );
  // No product page: the developer's name stands in for the link.
  for (const status of ["ok", "channel-not-entitled", "version-too-new"])
    extra(`${status}, no product page, text`, {
      ...base(status),
      portal: false,
    });
  // A mount that drops the fix verbs: the link is the fix.
  extra("version-too-old, the mount offers no update, text", {
    ...base("version-too-old"),
    mounted: ["status"],
  });
  extra("needs-activation, the mount offers neither activate nor login, text", {
    ...base("needs-activation"),
    mounted: ["status"],
  });
  const outcome = (
    situation: string,
    verb: string,
    text: CliOutcomeExpect,
    json?: CliOutcomeExpect,
  ): CliFamily["outcomes"] => [
    {
      name: situation,
      input: { verb, situation, json: false },
      expect: text,
    },
    ...(json
      ? [
          {
            name: `${situation}, --json`,
            input: { verb, situation, json: true },
            expect: { ...json, stdout: "result" as const },
          },
        ]
      : []),
  ];
  const statusRow = (
    status: string,
    fix: string[],
    link?: "portal" | "contact",
    suffix = "",
  ) =>
    outcome(
      `status-${status}${suffix}`,
      "status",
      {
        mark: "warn",
        exit: 1,
        error: null,
        stdout: "screen",
        fix,
        ...(link ? { link } : {}),
      },
      { exit: 1, error: null },
    );
  const outcomeRows: CliFamily["outcomes"] = [
    ...statusRow("revoked", ["activate", "login"]),
    ...statusRow("expired", ["activate", "login"]),
    ...statusRow("version-too-old", ["update apply"]),
    // Nothing here is a verb that fixes it: the product page is the way out, not a loop back to
    // `status` (H1a).
    ...statusRow("version-too-new", [], "portal"),
    ...statusRow("channel-not-entitled", [], "portal"),
    // The portal is off (core.portal, DISC-01): the developer's name stands in for the link.
    ...statusRow("version-too-new", [], "contact", "-no-page"),
    ...statusRow("channel-not-entitled", [], "contact", "-no-page"),
    // UK-43 D4: a license held by the key alone is offered the account in one line, never `#key=`
    // and never in `--json` (no new member). The page off: no line.
    ...outcome(
      "activate-floating",
      "activate",
      { mark: "ok", exit: 0, error: null, stdout: "screen", link: "portal" },
      { exit: 0, error: null },
    ),
    ...outcome(
      "activate-floating-no-page",
      "activate",
      { mark: "ok", exit: 0, error: null, stdout: "screen" },
      { exit: 0, error: null },
    ),
    ...outcome(
      "activate-waiting",
      "activate",
      {
        mark: "ok",
        exit: 0,
        error: null,
        stdout: "screen",
        fix: ["login"],
      },
      { exit: 0, error: null },
    ),
    ...outcome(
      "activate-identity-off",
      "activate",
      { mark: "ok", exit: 0, error: null, stdout: "screen", link: "portal" },
      { exit: 0, error: null },
    ),
    ...outcome(
      "status-floating",
      "status",
      { mark: "ok", exit: 0, error: null, stdout: "screen", link: "portal" },
      { exit: 0, error: null },
    ),
    ...outcome(
      "network",
      "devices list",
      { mark: "fail", exit: 1, error: "network", stdout: "screen" },
      { exit: 1, error: "network" },
    ),
    ...outcome(
      "key-refused",
      "activate",
      { mark: "warn", exit: 1, code: "unauthorized", stdout: "screen" },
      { exit: 1, error: null, code: "unauthorized" },
    ),
    ...outcome(
      "device-limit",
      "activate",
      { mark: "warn", exit: 1, code: "device_limit", stdout: "screen" },
      { exit: 1, error: null, code: "device_limit" },
    ),
    // The value reaches a screen, a log or a shell history only when asked (UK-45); a script
    // that read the value before must not read an empty stdout as success.
    ...outcome(
      "secret-hidden",
      "secret",
      { mark: "warn", exit: 2, error: null, stdout: "empty" },
      { exit: 0, error: null },
    ),
    ...outcome(
      "mint-hidden",
      "mint",
      { mark: "warn", exit: 2, error: null, stdout: "empty" },
      { exit: 0, error: null },
    ),
    ...outcome(
      "usage",
      "devices rename",
      { exit: 2 },
      { exit: 2, error: "usage" },
    ),
    ...outcome("interrupt", "activate", { exit: 130, error: "interrupted" }),
    // A cancel is the person's choice, not an error (DL7): it closes with no mark at all.
    ...outcome("sign-in-cancelled", "login", {
      exit: 1,
      error: null,
      stdout: "screen",
    }),
    ...outcome(
      "sign-in-denied",
      "login",
      { mark: "fail", exit: 1, error: "sign-in-denied", stdout: "screen" },
      { exit: 1, error: "sign-in-denied" },
    ),
    ...outcome(
      "sign-in-failed",
      "login",
      { mark: "fail", exit: 1, error: "sign-in-failed", stdout: "screen" },
      { exit: 1, error: "sign-in-failed" },
    ),
    // Nearby (I-47.1, D-5, D-10): first on an interactive run, never under `--json`.
    ...outcome(
      "sign-in-nearby",
      "login",
      { mark: "ok", exit: 0, error: null, stdout: "screen" },
      { exit: 0, error: null },
    ),
    ...outcome("sign-in-nearby-handoff", "login", {
      mark: "ok",
      exit: 0,
      error: null,
      stdout: "screen",
    }),
    // `devices approve` exits 0 only when a device was approved. Deny is the person's choice, like
    // a cancel: no mark. The rest are triangles (DL6); a person can retry or sign in.
    ...outcome("approve-approved", "devices approve", {
      mark: "ok",
      exit: 0,
      error: null,
      stdout: "screen",
    }),
    ...outcome("approve-mismatch", "devices approve", {
      mark: "warn",
      exit: 1,
      error: null,
      stdout: "screen",
    }),
    ...outcome("approve-denied", "devices approve", {
      exit: 1,
      error: null,
      stdout: "screen",
    }),
    ...outcome("approve-not-nearby", "devices approve", {
      mark: "warn",
      exit: 1,
      error: null,
      stdout: "screen",
    }),
    ...outcome("approve-unsupported", "devices approve", {
      mark: "warn",
      exit: 1,
      error: null,
      stdout: "screen",
    }),
    ...outcome("approve-account-required", "devices approve", {
      mark: "warn",
      exit: 1,
      error: null,
      stdout: "screen",
      fix: ["login"],
    }),
    // Only the --json run exists: a text run of this verb is every other row.
    {
      name: "approve-json, --json",
      input: { verb: "devices approve", situation: "approve-json", json: true },
      expect: { exit: 2, error: "usage", stdout: "result" },
    },
  ];
  const noKey = (copy: string, withinMs?: number): CliStdinExpect => ({
    read: "none",
    exit: CLI_EXIT.usage,
    error: "usage",
    copy: [copy],
    ...(withinMs !== undefined ? { withinMs } : {}),
  });
  const stdinRows: CliFamily["stdin"] = [
    {
      name: "a terminal: the masked prompt",
      input: { stdin: "tty", lines: null },
      expect: { read: "prompt" },
    },
    {
      name: "a terminal that cannot prompt: no key",
      input: { stdin: "tty-noninteractive", lines: null },
      expect: noKey("cli.activate.noKey"),
    },
    {
      name: "a file: its first line",
      input: { stdin: "file", lines: [KEY] },
      expect: { read: "key", key: KEY },
    },
    {
      name: "a file: the first non-empty line",
      input: { stdin: "file", lines: ["", "", KEY, "second line"] },
      expect: { read: "key", key: KEY },
    },
    {
      name: "an empty file: no key",
      input: { stdin: "file", lines: [] },
      expect: noKey("cli.activate.noKeyPiped"),
    },
    {
      name: "a shell pipe left open: the line, without waiting for the writer",
      input: { stdin: "fifo", lines: [KEY] },
      expect: { read: "key", key: KEY },
    },
    {
      name: "a socket left open: the line, without waiting for the writer",
      input: { stdin: "socket", lines: [KEY] },
      expect: { read: "key", key: KEY },
    },
    {
      name: "a silent open pipe: no key within the bound, and the process exits",
      input: { stdin: "fifo", lines: null },
      expect: noKey("cli.activate.noKeyPiped", CLI_STDIN_WAIT_MS),
    },
    {
      name: "a silent open socket: no key within the bound, and the process exits",
      input: { stdin: "socket", lines: null },
      expect: noKey("cli.activate.noKeyPiped", CLI_STDIN_WAIT_MS),
    },
    {
      name: "/dev/null: never read",
      input: { stdin: "char-device", lines: null },
      expect: noKey("cli.activate.noKeyPiped"),
    },
  ];
  // The capability table of UK-45, verbatim.
  const TERM = { TERM: "xterm-256color" };
  const capRows: { name: string; input: CliCapabilityInput }[] = [
    ["a terminal", TERM, "tty", "tty", {}],
    ["CI=true", { ...TERM, CI: "true" }, "tty", "tty", {}],
    ["CI=0 is not CI", { ...TERM, CI: "0" }, "tty", "tty", {}],
    ["CI=false is not CI", { ...TERM, CI: "false" }, "tty", "tty", {}],
    ["GITHUB_ACTIONS", { ...TERM, GITHUB_ACTIONS: "true" }, "tty", "tty", {}],
    ["BUILDKITE", { ...TERM, BUILDKITE: "true" }, "tty", "tty", {}],
    [
      "NO_COLOR keeps links on a terminal",
      { ...TERM, NO_COLOR: "1" },
      "tty",
      "tty",
      {},
    ],
    ["--no-color", TERM, "tty", "tty", { color: false }],
    ["a pipe", TERM, "pipe", "pipe", {}],
    [
      "FORCE_COLOR on a pipe: colour, never links",
      { ...TERM, FORCE_COLOR: "1" },
      "pipe",
      "pipe",
      {},
    ],
    ["animation follows stdout, not stdin", TERM, "tty", "pipe", {}],
    ["TERM=dumb", { TERM: "dumb" }, "tty", "tty", {}],
    ["--ascii", TERM, "tty", "tty", { ascii: true }],
    ["--json", TERM, "tty", "tty", { json: true }],
  ].map(([name, env, stdout, stdin, flags]) => ({
    name: name as string,
    input: {
      env: env as Record<string, string>,
      stdout: stdout as "tty" | "pipe",
      stdin: stdin as "tty" | "pipe",
      flags: flags as CliCapabilityInput["flags"],
    },
  }));
  return {
    verbs: {
      endUser: [...CLI_END_USER],
      developer: [...CLI_DEVELOPER],
      aliases: { ...CLI_ALIASES },
    },
    mount: mountRows.map((r) => ({ ...r, expect: refMount(r.input) })),
    help: helpRows.map((r) => ({ ...r, expect: refHelp(r.input) })),
    gate: gateRows,
    outcomes: outcomeRows,
    stdin: stdinRows,
    capabilities: capRows.map((r) => ({
      ...r,
      expect: refCapabilities(r.input),
    })),
    exit: { ...CLI_EXIT },
  };
}

/** The `cli` family's checks: closed vocabularies, sorted sets, the references' answers, and DL6
 *  (a refusal is a triangle with its fix, never a cross; a refused gate exits 4). */
export function checkCli(
  cli: CliFamily | undefined,
  S: UiMatrixSources,
): string[] {
  const errors: string[] = [];
  if (!cli) return ["cli: the family is missing"];
  const coreEn = S.core.en ?? {};
  const kitEn = S.kit.en ?? {};
  const verbs = cliVerbs();
  const isSorted = (xs: readonly string[]) =>
    xs.join("\u0000") === sorted(xs).join("\u0000");
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const exitCodes = new Set<number>(Object.values(CLI_EXIT));
  const envelopeErrors = new Set(["usage", "interrupted", "internal"]);
  const knownError = (e: string) =>
    envelopeErrors.has(e) || `core.codes.${e}.title` in coreEn;
  const names = (where: string, rows: { name: string }[]) => {
    const seen = new Set<string>();
    if (rows.length === 0) errors.push(`cli.${where}: no rows`);
    for (const r of rows) {
      if (seen.has(r.name))
        errors.push(`cli.${where} "${r.name}": duplicate name`);
      seen.add(r.name);
    }
  };

  // verbs and exit.
  const { endUser, developer, aliases } = cli.verbs;
  if (!isSorted(endUser) || !isSorted(developer))
    errors.push("cli.verbs: the sets are not sorted");
  for (const v of endUser)
    if (developer.includes(v))
      errors.push(`cli.verbs: ${v} is both end-user and developer`);
  for (const [a, v] of Object.entries(aliases)) {
    if (!verbs.includes(v as string))
      errors.push(`cli.verbs.aliases ${a}: ${String(v)} is not a verb`);
    if (verbs.includes(a)) errors.push(`cli.verbs.aliases ${a}: is a verb id`);
    if ((v as string).includes(" "))
      errors.push(`cli.verbs.aliases ${a}: only a one-word verb has aliases`);
  }
  if (!same(cli.exit, CLI_EXIT))
    errors.push("cli.exit: not the exit table (licenseRequired is 4)");

  // mount and help.
  names("mount", cli.mount);
  for (const r of cli.mount) {
    const where = `cli.mount "${r.name}"`;
    for (const v of r.input.options.verbs ?? [])
      if (!verbs.includes(v)) errors.push(`${where}: ${v} is not a verb`);
    if (!same(r.expect, refMount(r.input)))
      errors.push(`${where}: expectation is not the mount rule's`);
  }
  if (!cli.mount.some((r) => r.expect.error !== null))
    errors.push("cli.mount: no row pins the collision error");
  if (!cli.mount.some((r) => r.expect.skipped.length > 0))
    errors.push("cli.mount: no row pins onCollision skip");
  if (!cli.mount.some((r) => r.expect.hidden.length > 0))
    errors.push("cli.mount: no row pins the hidden options");
  names("help", cli.help);
  if (!(CLI_HELP_GROUP in kitEn))
    errors.push(`cli.help: ${CLI_HELP_GROUP} is not in kit-copy/en.json`);
  for (const r of cli.help)
    if (!same(r.expect, refHelp(r.input)))
      errors.push(`cli.help "${r.name}": expectation is not the help rule's`);

  // gate: the whole cross product, DL6 on every refusal.
  names("gate", cli.gate);
  const statuses = S.enums.licenseStatus ?? [];
  const cells = new Set<string>();
  for (const r of cli.gate) {
    const where = `cli.gate "${r.name}"`;
    const i = r.input;
    if (!i.check && !statuses.includes(i.status))
      errors.push(`${where}: ${i.status} is not a licenseStatus`);
    if (i.check && statuses.includes(i.status) && i.check === "unknown-status")
      errors.push(`${where}: an unknown status is not a licenseStatus`);
    for (const v of i.mounted ?? [])
      if (!verbs.includes(v))
        errors.push(`${where}: mounted ${v} is not a verb`);
    if (!i.check && i.mounted === undefined && i.portal === undefined)
      cells.add(`${i.status}|${i.tty}|${i.json}|${i.entitled}`);
    if (!same(r.expect, refGate(i)))
      errors.push(`${where}: expectation is not the gate rule's`);
    const e = r.expect;
    const copyKeys = (e.copy ?? []).filter((k) => !(k in coreEn));
    for (const k of copyKeys)
      if (!(k in kitEn)) errors.push(`${where}: ${k} is not core or kit copy`);
    if (!isSorted(e.copy ?? [])) errors.push(`${where}: copy is not sorted`);
    if (e.outcome === "refuse") {
      if (e.mark !== "warn" || e.exit !== CLI_EXIT.licenseRequired)
        errors.push(`${where}: a refusal is a triangle and exits 4 (DL6)`);
      if (!e.fix?.length && !e.link)
        errors.push(`${where}: a refusal has a fix verb or a link`);
      if (e.fix?.some((v) => !verbs.includes(v)))
        errors.push(`${where}: a refusal names its fix as verbs`);
      if (!knownError(e.error ?? ""))
        errors.push(`${where}: error ${String(e.error)} has no core copy`);
    }
    if (e.outcome === "fail") {
      if (e.mark !== "fail" || e.exit !== CLI_EXIT.licenseRequired)
        errors.push(`${where}: a failed check is a cross and exits 4`);
      if (e.fix?.length || e.link)
        errors.push(`${where}: a failed check has no fix row`);
    }
  }
  for (const s of statuses)
    for (const tty of [true, false])
      for (const json of [false, true])
        for (const entitled of [true, false])
          if (!cells.has(`${s}|${tty}|${json}|${entitled}`))
            errors.push(
              `cli.gate: no row for ${s}, tty ${tty}, json ${json}, entitled ${entitled}`,
            );

  // outcomes.
  names("outcomes", cli.outcomes);
  const refusals = new Set([
    "status-revoked",
    "status-expired",
    "status-version-too-old",
    "status-version-too-new",
    "status-channel-not-entitled",
    "status-version-too-new-no-page",
    "status-channel-not-entitled-no-page",
    "key-refused",
    "device-limit",
    "secret-hidden",
    "mint-hidden",
  ]);
  for (const r of cli.outcomes) {
    const where = `cli.outcomes "${r.name}"`;
    const { verb, situation, json } = r.input;
    const e = r.expect;
    if (!(situation in CLI_SITUATIONS))
      errors.push(`${where}: unknown situation ${situation}`);
    if (!verbs.includes(verb)) errors.push(`${where}: ${verb} is not a verb`);
    if (!exitCodes.has(e.exit))
      errors.push(`${where}: exit ${e.exit} is not in the exit table`);
    if (
      e.mark !== undefined &&
      !(CLI_MARKS as readonly string[]).includes(e.mark)
    )
      errors.push(`${where}: mark ${e.mark}`);
    if (json && e.mark !== undefined)
      errors.push(`${where}: a --json row draws no mark`);
    if (json && e.stdout !== "result")
      errors.push(`${where}: a --json row's stdout is its result lines`);
    if (!json && refusals.has(situation) && e.mark !== "warn")
      errors.push(
        `${where}: a refusal is a triangle with its fix, never a cross (DL6)`,
      );
    if (typeof e.error === "string" && !knownError(e.error))
      errors.push(`${where}: error ${e.error} has no core copy`);
    if (e.code !== undefined && !(`core.codes.${e.code}.title` in coreEn))
      errors.push(`${where}: code ${e.code} has no core copy`);
    for (const v of e.fix ?? [])
      if (!verbs.includes(v)) errors.push(`${where}: fix ${v} is not a verb`);
    if (
      !json &&
      situation.startsWith("status-") &&
      refusals.has(situation) &&
      !e.fix?.length &&
      !e.link
    )
      errors.push(`${where}: a refusal has a fix verb or a link`);
  }
  for (const s of Object.keys(CLI_SITUATIONS))
    if (!cli.outcomes.some((r) => r.input.situation === s))
      errors.push(`cli.outcomes: no row for ${s}`);

  // stdin.
  names("stdin", cli.stdin);
  for (const r of cli.stdin) {
    const where = `cli.stdin "${r.name}"`;
    if (!(r.input.stdin in CLI_STDIN_KINDS))
      errors.push(`${where}: unknown stdin ${r.input.stdin}`);
    const e = r.expect;
    if (e.read === "key" && e.key !== KEY)
      errors.push(`${where}: a read key is the fixture key`);
    if (e.read === "none") {
      if (e.exit !== CLI_EXIT.usage || e.error !== "usage")
        errors.push(`${where}: no key is a usage error, exit 2`);
      for (const k of e.copy ?? [])
        if (!(k in kitEn)) errors.push(`${where}: ${k} is not kit copy`);
    }
    if (e.withinMs !== undefined && e.withinMs !== CLI_STDIN_WAIT_MS)
      errors.push(`${where}: the bound is ${CLI_STDIN_WAIT_MS} ms`);
  }
  for (const kind of Object.keys(CLI_STDIN_KINDS))
    if (!cli.stdin.some((r) => r.input.stdin === kind))
      errors.push(`cli.stdin: no row for ${kind}`);

  // capabilities.
  names("capabilities", cli.capabilities);
  for (const r of cli.capabilities)
    if (!same(r.expect, refCapabilities(r.input)))
      errors.push(
        `cli.capabilities "${r.name}": expectation is not the capability rule's`,
      );
  return errors;
}

// ── connect (CC-19.9) ───────────────────────────────────────────────────────────────────────

function connectFamily(a: A): Draft[] {
  const { row, but, off } = a;
  const LP = "LinkPairing";
  const TO = "TransferOffer";
  const NO_CONNECT = off("connect");
  const CATS = ["contacts", "photos"];
  const inv = (invariant: string, m: Omit<MustNot, "invariant">) => ({
    mustNot: { invariant, ...m },
  });
  const pair = (step: string, extra: Obj = {}): Obj => ({
    linkPairing: { step, ...extra },
  });
  const CODE = { code: "123 456" };
  const BODIES = [
    "linkPairing.failedDeclined",
    "linkPairing.failedTimeout",
    "linkPairing.failedFull",
    "linkPairing.failedClosed",
  ];
  const failed = (reason: string, name: string): Draft =>
    row(
      `${LP}/failed: ${name}`,
      pair("failed", { reason, categories: CATS }),
      LP,
      "failed",
      but(
        LP,
        "failed",
        ...BODIES.filter(
          (k) =>
            !k.endsWith(`.failed${reason[0]!.toUpperCase()}${reason.slice(1)}`),
        ),
      ),
      inv("A session that ended without a link never says it linked.", {
        copy: [
          "linkPairing.linkedTitle",
          "linkPairing.linkedBody",
          "linkPairing.linkedWith",
        ],
        states: ["linked"],
      }),
    );
  const offer = (step: string, labelled = true): Obj => ({
    transferOffer: {
      step,
      name: "holiday.zip",
      ...(labelled ? { device: "Maya's laptop" } : {}),
    },
  });
  return [
    row(
      `${LP}/open: both people open it, nearby`,
      pair("open", { categories: CATS }),
      LP,
      "open",
      "all",
    ),
    row(
      `${LP}/code: the code, the label as reported, the categories before the choice`,
      pair("code", { ...CODE, device: "Maya's laptop", categories: CATS }),
      LP,
      "code",
      but(LP, "code", "linkPairing.reportedUnnamed", "linkPairing.sharesNone"),
      inv(
        "A label the other device sent is reported by the device, never shown as who it is.",
        {
          copy: ["linkPairing.reportedUnnamed"],
          states: ["linked"],
        },
      ),
    ),
    row(
      `${LP}/code: the device gave no name`,
      pair("code", { ...CODE, categories: CATS }),
      LP,
      "code",
      but(LP, "code", "linkPairing.reported", "linkPairing.sharesNone"),
      inv("A missing label is said to be missing; no name is made up.", {
        copy: ["linkPairing.reported"],
      }),
    ),
    row(
      `${LP}/code: the app asks for no categories`,
      pair("code", { ...CODE, device: "Maya's laptop", categories: [] }),
      LP,
      "code",
      but(LP, "code", "linkPairing.reportedUnnamed", "linkPairing.shares"),
      inv(
        "With nothing to share the screen says so; it never lists a category.",
        {
          copy: ["linkPairing.shares"],
        },
      ),
    ),
    row(
      `${LP}/confirm: waiting for the other person, the code still on screen`,
      pair("confirm", { ...CODE, device: "Maya's laptop", categories: CATS }),
      LP,
      "confirm",
      // The code, the reported line and the categories stay on screen while the other person decides.
      but(
        LP,
        "confirm",
        "linkPairing.reportedUnnamed",
        "linkPairing.sharesNone",
      ),
      inv("Waiting never reads as linked.", {
        states: ["linked"],
        copy: ["linkPairing.linkedTitle"],
      }),
    ),
    row(
      `${LP}/confirm: the device gave no name and nothing is shared`,
      pair("confirm", { ...CODE, categories: [] }),
      LP,
      "confirm",
      but(LP, "confirm", "linkPairing.reported", "linkPairing.shares"),
    ),
    row(
      `${LP}/linked: with what both approved`,
      pair("linked", { device: "Maya's laptop", categories: CATS }),
      LP,
      "linked",
      but(LP, "linked", "linkPairing.sharesNone", "linkPairing.linkedBody"),
    ),
    row(
      `${LP}/linked: nothing shared yet`,
      pair("linked", { categories: [] }),
      LP,
      "linked",
      but(LP, "linked", "linkPairing.shares", "linkPairing.linkedWith"),
    ),
    failed("declined", "someone said no"),
    failed("timeout", "the window or the exchange ran out"),
    failed("full", "one device holds the most links"),
    failed("closed", "the connection ended"),
    row(
      `${LP}/unavailable: links are off for the product`,
      pair("unavailable"),
      LP,
      "unavailable",
      "all",
      inv("A product with links off never offers to pair.", {
        copy: ["linkPairing.confirm", "linkPairing.title"],
        states: ["open", "code"],
      }),
    ),
    row(
      `${LP}/hidden: Connect off`,
      { services: NO_CONNECT, ...pair("open") },
      LP,
      "hidden",
      [],
    ),

    row(
      `${TO}/ask: the contact's label and the name it chose`,
      offer("ask"),
      TO,
      "ask",
      but(TO, "ask", "transferOffer.askUnnamed"),
      inv("Nothing is received before the person presses Accept (D-8).", {
        states: ["receiving", "done"],
      }),
    ),
    row(
      `${TO}/ask: the contact has no label`,
      offer("ask", false),
      TO,
      "ask",
      but(TO, "ask", "transferOffer.ask"),
    ),
    row(
      `${TO}/receiving: Cancel stops it`,
      offer("receiving"),
      TO,
      "receiving",
      "all",
    ),
    row(
      `${TO}/done: received`,
      offer("done"),
      TO,
      "done",
      "all",
      inv("A finished transfer offers nothing more to accept.", {
        copy: ["transferOffer.accept"],
      }),
    ),
    row(
      `${TO}/failed: nothing was saved`,
      offer("failed"),
      TO,
      "failed",
      "all",
      inv("A failed transfer never says received.", {
        copy: ["transferOffer.done"],
        states: ["done"],
      }),
    ),
    row(
      `${TO}/hidden: Connect off`,
      { services: NO_CONNECT, ...offer("ask") },
      TO,
      "hidden",
      [],
    ),
  ];
}

// ── local (CC-29K) ──────────────────────────────────────────────────────────────────────────

/** The local family's components. */
export const LOCAL_FAMILY_COMPONENTS = [
  "LocalPairing",
  "PairedDevices",
] as const;

function localFamily(a: A): Draft[] {
  const { row, off } = a;
  const LP = "LocalPairing";
  const PD = "PairedDevices";
  const NO_CONNECT = off("connect");
  const CATS = ["crates", "cues"];
  /** A negative case: what must never show here, and why. */
  const inv = (invariant: string, no: Omit<MustNot, "invariant">) => ({
    mustNot: { ...no, invariant },
  });
  const pair = (step: string, more: Obj = {}): Obj => ({
    localPairing: { ...more, step },
  });
  const SHOW = [
    "localPairing.title",
    "localPairing.showBody",
    "a11y.linkCode",
    "a11y.qrPairing",
    "localPairing.expires",
    "localPairing.waitingDevice",
    "localPairing.toEnter",
    "common.cancel",
  ];
  const WINDOW = {
    code: "4812 3456",
    qr: "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y",
    secondsLeft: 291,
  };
  const ENTER = [
    "localPairing.title",
    "localPairing.enterBody",
    "localPairing.codeLabel",
    "linkPairing.shares",
    "localPairing.pair",
    "localPairing.toShow",
    "common.back",
  ];
  const PH = "localPairing.codePlaceholder";
  const JOIN = [
    "localPairing.title",
    "localPairing.enterBody",
    "localPairing.codeLabel",
    "linkPairing.shares",
    "localPairing.pair",
    "a11y.busy",
    "common.cancel",
  ];
  const closed = (extra: Obj, copy: string[], o: Opts = {}, name = "") =>
    row(
      `${LP}/closed: ${name}`,
      pair("closed", extra),
      LP,
      "closed",
      ["linkPairing.failedTitle", ...copy, "common.close"],
      o,
    );
  const failed = (reason: string, body: string, name: string): Draft =>
    row(
      `${LP}/failed: ${name}`,
      pair("failed", { reason }),
      LP,
      "failed",
      [
        "linkPairing.failedTitle",
        body,
        reason === "full" ? "common.tryAgain" : "common.tryAgain",
        "common.close",
      ],
      inv("A pairing that ended never says it paired.", {
        copy: ["localPairing.pairedTitle", "localPairing.pairedBody"],
        states: ["paired"],
      }),
    );
  const devs = (n: number, offFrom = n, seen = true): Obj[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `L${i + 1}`,
      label: `Device ${i + 1}`,
      lastSeen: seen ? 1_700_000_000 - i * 86_400 : null,
      reachable: i < offFrom,
    }));
  const LIST = [
    "pairedDevices.title",
    "pairedDevices.lede",
    "pairedDevices.lastSeen",
    "a11y.deviceOptions",
    "devices.rename",
    "pairedDevices.forget",
    "pairedDevices.pair",
    "common.done",
  ];
  const SW = ["pairedDevices.canConnect", "a11y.letConnect"];
  const list = (step: string, extra: Obj, n: Obj[]): Obj => ({
    pairedDevices: { step, devices: n, ...extra },
  });
  // Scanning needs a camera: the SwiftUI kit on iOS and iPadOS, and Google's scanner on Compose.
  const NATIVE = ["react", "elements", "node", "python", "godot"];
  const SCAN_NA = {
    sdks: NATIVE,
    reason:
      "A camera scan is drawn only by the native kits (SwiftUI on iOS and iPadOS, Compose with Google's scanner); the others check the view and draw nothing. Typing stays everywhere.",
  };
  const CAMERA_NA = {
    sdks: [...NATIVE, "compose"],
    reason:
      "Google's scanner is its own sheet, so Compose has no camera screens of ours; the other native kit-less SDKs draw nothing for a scan either. Typing stays everywhere.",
  };
  const SHEET = {
    canScan: true,
    sheetScan: true,
    scanShares: true,
    categories: CATS,
  };
  const CHOOSE = [
    "localPairing.title",
    "localPairing.chooseBody",
    "localPairing.scan",
    "localPairing.show",
    "common.cancel",
  ];
  const SHEET_KEYS = [...CHOOSE, "localPairing.enter", "linkPairing.shares"];
  const sheet = (name: string, more: Obj, copy: string[], o: Opts = {}) =>
    row(
      `${LP}/choose: ${name}`,
      pair("choose", { ...SHEET, ...more }),
      LP,
      "choose",
      copy,
      { notApplicable: SCAN_NA, ...o },
    );
  const scanned = (name: string, more: Obj, extra: string[], o: Opts = {}) =>
    row(
      `${LP}/scan: ${name}`,
      pair("scan", { canScan: true, categories: CATS, ...more }),
      LP,
      "scan",
      [
        "localPairing.title",
        "localPairing.scanBody",
        "a11y.cameraView",
        ...extra,
        "linkPairing.shares",
        "localPairing.enterInstead",
        "common.back",
      ],
      { notApplicable: CAMERA_NA, ...o },
    );
  const NO_DIGITS = {
    invariant:
      "A scan screen shows no digits and no Pair: a code that reads pairs, which is the person's yes.",
    copy: ["localPairing.pair", "localPairing.codeLabel"],
  };
  const camera = (name: string, cats: string[], shares: string): Draft =>
    row(
      `${LP}/camera-off: ${name}`,
      pair("camera-off", {
        canScan: true,
        canOpenSettings: true,
        categories: cats,
      }),
      LP,
      "camera-off",
      [
        "localPairing.title",
        "localPairing.cameraOffTitle",
        "localPairing.cameraOffBody",
        "localPairing.openSettings",
        shares,
        "localPairing.enterInstead",
        "common.back",
      ],
      {
        notApplicable: CAMERA_NA,
        ...(cats.length > 0
          ? {
              mustNot: {
                invariant:
                  "A denied camera is a state of its own, never a blank view.",
                copy: ["a11y.cameraView"],
              },
            }
          : {}),
      },
    );
  const scanRows = (): Draft[] => [
    row(
      `${LP}/choose: Scan a code leads where the device can scan`,
      pair("choose", { canScan: true }),
      LP,
      "choose",
      [...CHOOSE.slice(0, 4), "common.cancel"],
      {
        notApplicable: CAMERA_NA,
        mustNot: {
          invariant:
            "Typing is reached from the scan screens: choose has no Enter a code beside Scan a code.",
          copy: ["localPairing.enter"],
        },
      },
    ),
    row(
      `${LP}/choose: Scan a code with the network prompt not yet answered`,
      pair("choose", { canScan: true, prePrompt: true }),
      LP,
      "choose",
      [...CHOOSE.slice(0, 4), "localPairing.prePrompt", "common.cancel"],
      { notApplicable: SCAN_NA },
    ),
    row(
      `${LP}/choose: no room, Scan a code drawn disabled`,
      pair("choose", { canScan: true, full: true, prePrompt: true }),
      LP,
      "choose",
      [
        ...CHOOSE.slice(0, 4),
        "core.codes.local-links-full.title",
        "core.codes.local-links-full.message",
        "localPairing.pairedDevices",
        "common.cancel",
      ],
      {
        disabled: ["localPairing.scan", "localPairing.show"],
        notApplicable: SCAN_NA,
      },
    ),
    sheet(
      "a scanner sheet of the host's own, typing is a link",
      { scanShares: false },
      [...CHOOSE.slice(0, 4), "localPairing.enter", "common.cancel"],
    ),
    sheet("what each shares comes before the sheet opens", {}, [...SHEET_KEYS]),
    sheet("nothing shared before the sheet opens", { categories: [] }, [
      ...CHOOSE.slice(0, 4),
      "localPairing.enter",
      "linkPairing.sharesNone",
      "common.cancel",
    ]),
    sheet(
      "another app's code, the scan entry stays",
      { scanNotice: "other-app" },
      [...SHEET_KEYS, "localPairing.otherApp"],
    ),
    sheet("the other device was not found", { scanNotice: "not-found" }, [
      ...SHEET_KEYS,
      "localPairing.scanNotFound",
    ]),
    sheet("the code has changed", { scanNotice: "stale" }, [
      ...SHEET_KEYS,
      "localPairing.scanStale",
    ]),
    sheet(
      "the scanner is not ready yet, the entry stays",
      { scanNotice: "not-ready" },
      [...SHEET_KEYS, "localPairing.scannerNotReady"],
    ),
    sheet("the scanner is being got ready", { scanNotice: "preparing" }, [
      ...SHEET_KEYS,
      "localPairing.scannerPreparing",
    ]),
    row(
      `${LP}/scan-prompt: once, before the system asks for the camera`,
      pair("scan-prompt", { canScan: true }),
      LP,
      "scan-prompt",
      [
        "localPairing.cameraPromptTitle",
        "localPairing.cameraPrePrompt",
        "common.continue",
        "localPairing.enterInstead",
      ],
      {
        notApplicable: CAMERA_NA,
        mustNot: {
          invariant:
            "The pre-prompt asks nothing of the camera: no view, no digits, no Pair.",
          copy: [
            "a11y.cameraView",
            "localPairing.pair",
            "localPairing.codeLabel",
          ],
        },
      },
    ),
    scanned("the camera view, one quiet link to typing", {}, [], {
      mustNot: {
        ...NO_DIGITS,
        copy: [...NO_DIGITS.copy, "localPairing.otherApp"],
      },
    }),
    row(
      `${LP}/scan: nothing shared`,
      pair("scan", { canScan: true, categories: [] }),
      LP,
      "scan",
      [
        "localPairing.title",
        "localPairing.scanBody",
        "a11y.cameraView",
        "linkPairing.sharesNone",
        "localPairing.enterInstead",
        "common.back",
      ],
      { notApplicable: CAMERA_NA },
    ),
    scanned(
      "another app's code, scanning goes on",
      { scanNotice: "other-app" },
      ["localPairing.otherApp"],
      {
        mustNot: {
          invariant:
            "Another app's code is not dialled, is not an error screen and never ends the scan.",
          copy: ["localPairing.notACode", "linkPairing.failedTitle"],
          states: ["failed", "enter"],
        },
      },
    ),
    scanned(
      "the other device was not found, scanning goes on",
      { scanNotice: "not-found" },
      ["localPairing.scanNotFound"],
      {
        mustNot: {
          invariant:
            "A scanned code that fails never drops the person into typing, and never blames a code they typed.",
          copy: ["localPairing.notFoundTitle", "localPairing.wrongCode"],
          states: ["enter"],
        },
      },
    ),
    scanned("the code has changed, scanning goes on", { scanNotice: "stale" }, [
      "localPairing.scanStale",
    ]),
    scanned("the camera is in use elsewhere", { cameraBusy: true }, [
      "localPairing.cameraBusy",
    ]),
    camera(
      "access denied, Open Settings and typing",
      CATS,
      "linkPairing.shares",
    ),
    camera("nothing shared", [], "linkPairing.sharesNone"),
    row(
      `${LP}/enter: Scan the code instead replaces Show a code instead`,
      pair("enter", {
        canScan: true,
        entry: "4812 3456",
        categories: CATS,
        triesLeft: 2,
      }),
      LP,
      "enter",
      [
        ...ENTER.filter((k) => k !== "localPairing.toShow"),
        "localPairing.scanInstead",
      ],
      { notApplicable: SCAN_NA, mustNot: { copy: ["localPairing.toShow"] } },
    ),
  ];
  return [
    row(
      `${LP}/choose: either device can show the code`,
      pair("choose"),
      LP,
      "choose",
      [
        "localPairing.title",
        "localPairing.chooseBody",
        "localPairing.show",
        "localPairing.enter",
        "common.cancel",
      ],
      inv("Neither way is the filled one: either device can show the code.", {
        copy: ["localPairing.pair"],
      }),
    ),
    row(
      `${LP}/choose: the system has not asked yet`,
      pair("choose", { prePrompt: true }),
      LP,
      "choose",
      [
        "localPairing.title",
        "localPairing.chooseBody",
        "localPairing.show",
        "localPairing.enter",
        "localPairing.prePrompt",
        "common.cancel",
      ],
    ),
    row(
      `${LP}/choose: no room, said before either button`,
      pair("choose", { full: true, prePrompt: true }),
      LP,
      "choose",
      [
        "localPairing.title",
        "localPairing.chooseBody",
        "localPairing.show",
        "localPairing.enter",
        "core.codes.local-links-full.title",
        "core.codes.local-links-full.message",
        "localPairing.pairedDevices",
        "common.cancel",
      ],
      {
        disabled: ["localPairing.show", "localPairing.enter"],
        mustNot: {
          invariant: "A device with no room nothing is advertised or dialled.",
          copy: ["localPairing.prePrompt"],
        },
      },
    ),
    row(
      `${LP}/opening: a placeholder code tile while the window opens`,
      pair("opening"),
      LP,
      "opening",
      [
        "localPairing.title",
        "localPairing.showBody",
        "a11y.busy",
        "localPairing.toEnter",
        "common.cancel",
      ],
      inv("A slow start never shows a code or a QR that is not there yet.", {
        copy: ["a11y.linkCode", "a11y.qrPairing", "localPairing.expires"],
      }),
    ),
    row(
      `${LP}/show: the code is the largest text, with its time`,
      pair("show", WINDOW),
      LP,
      "show",
      SHOW,
      inv("A shown code never has a Copy button and no countdown of tries.", {
        copy: ["localPairing.triesLeft", "localPairing.showNewIn"],
      }),
    ),
    row(
      `${LP}/show: a wrong code changed it`,
      pair("show", { ...WINDOW, notice: "rotated" }),
      LP,
      "show",
      [
        ...SHOW,
        "localPairing.rotatedTitle",
        "localPairing.rotatedBody",
        "localPairing.showNew",
        "a11y.newCode",
      ],
      inv(
        "The shower never says how many tries are left; only the joiner's limit binds.",
        {
          copy: ["localPairing.triesLeft"],
        },
      ),
    ),
    row(
      `${LP}/show: a new code is being asked for, Show a new code keeps its label`,
      pair("show", { ...WINDOW, notice: "rotated", busy: "new-code" }),
      LP,
      "show",
      [
        ...SHOW,
        "localPairing.rotatedTitle",
        "localPairing.rotatedBody",
        "localPairing.showNew",
        "a11y.newCode",
        "a11y.busy",
      ],
      {
        disabled: ["localPairing.showNew"],
        mustNot: {
          invariant:
            "A second press while the first is answered withdraws nothing and opens nothing.",
          copy: ["localPairing.showNewIn"],
        },
      },
    ),
    row(
      `${LP}/show: the other device said Not now`,
      pair("show", { ...WINDOW, notice: "declined", device: "LAPTOP-7QH3RX" }),
      LP,
      "show",
      [
        ...SHOW,
        "localPairing.notPairedWith",
        "localPairing.rotatedBody",
        "localPairing.showNew",
        "a11y.newCode",
      ],
      inv(
        "A decline is not shown as a wrong code, and the screen stays on its code.",
        {
          copy: ["localPairing.rotatedTitle", "linkPairing.failedTitle"],
          states: ["closed"],
        },
      ),
    ),
    row(
      `${LP}/show: something keeps interrupting`,
      pair("show", { ...WINDOW, notice: "blocked" }),
      LP,
      "show",
      [...SHOW, "localPairing.blockedTitle", "localPairing.blockedBody"],
    ),
    row(
      `${LP}/show: someone nearby may be guessing, the code still open`,
      pair("show", { ...WINDOW, notice: "guessing" }),
      LP,
      "show",
      [
        ...SHOW,
        "localPairing.rotatedTitle",
        "localPairing.tooManyAgainBody",
        "localPairing.showNew",
        "a11y.newCode",
      ],
      inv(
        "Five wrong codes over renewed windows warn but do not start the 30-second wait, and the warning is not titled as a repeat the person never saw.",
        {
          copy: ["localPairing.showNewIn", "localPairing.tooManyAgainTitle"],
          states: ["closed"],
        },
      ),
    ),
    closed(
      { closedBy: "too-many-tries", cooldownLeft: 24 },
      ["localPairing.failedTooMany", "localPairing.showNewIn"],
      {
        disabled: ["localPairing.showNewIn"],
        mustNot: {
          invariant:
            "No code or QR remains after Too many tries, and a new code waits 30 seconds.",
          copy: ["a11y.linkCode", "a11y.qrPairing", "localPairing.showNew"],
        },
      },
      "Too many tries, 24 seconds to wait",
    ),
    closed(
      { closedBy: "too-many-tries", cooldownLeft: 30, warn: true },
      [
        "localPairing.failedTooMany",
        "localPairing.tooManyAgainTitle",
        "localPairing.tooManyAgainBody",
        "localPairing.showNewIn",
      ],
      { disabled: ["localPairing.showNewIn"] },
      "the second Too many tries in a row",
    ),
    closed(
      { closedBy: "too-many-tries", cooldownLeft: 0 },
      ["localPairing.failedTooMany", "localPairing.showNew"],
      {},
      "the wait is over",
    ),
    closed(
      { closedBy: "expired" },
      ["localPairing.failedExpired", "localPairing.showNew"],
      {
        mustNot: {
          invariant: "A code that ran out has no wait: nothing was guessed.",
          copy: ["localPairing.showNewIn"],
        },
      },
      "time ran out, no wait",
    ),
    row(
      `${LP}/enter: an empty field, Pair unavailable`,
      pair("enter", {
        entry: "",
        categories: CATS,
        pairDisabled: true,
        triesLeft: null,
      }),
      LP,
      "enter",
      [...ENTER, PH],
      {
        disabled: ["localPairing.pair"],
        mustNot: {
          invariant:
            "The categories come before Pair, so pressing Pair is the consent.",
          copy: ["localPairing.confirmBody"],
        },
      },
    ),
    row(
      `${LP}/enter: eight digits, Pair ready`,
      pair("enter", { entry: "4812 3456", categories: CATS, triesLeft: 2 }),
      LP,
      "enter",
      ENTER,
      inv("A full code with a dial left leaves Pair available.", {
        copy: ["localPairing.notACode", "localPairing.wrongCode"],
      }),
    ),
    row(
      `${LP}/enter: one try left for these two digits`,
      pair("enter", { entry: "4812 3456", categories: CATS, triesLeft: 1 }),
      LP,
      "enter",
      [...ENTER, "localPairing.triesLeft"],
    ),
    row(
      `${LP}/enter: a wrong code keeps the first two digits`,
      pair("enter", {
        entry: "48",
        categories: CATS,
        error: "wrong",
        triesLeft: 1,
        pairDisabled: true,
      }),
      LP,
      "enter",
      [...ENTER, "localPairing.wrongCode", "localPairing.triesLeft"],
      {
        disabled: ["localPairing.pair"],
        mustNot: {
          invariant:
            "A code that just failed is never offered to Pair again until it differs.",
          copy: ["localPairing.notFoundTitle"],
        },
      },
    ),
    row(
      `${LP}/enter: these two digits are spent`,
      pair("enter", {
        entry: "4873",
        categories: CATS,
        triesLeft: 0,
        pairDisabled: true,
      }),
      LP,
      "enter",
      [...ENTER, "localPairing.spentCode"],
      { disabled: ["localPairing.pair"] },
    ),
    row(
      `${LP}/enter: too many tries, an empty field that stays editable`,
      pair("enter", {
        entry: "",
        categories: CATS,
        error: "too-many",
        pairDisabled: true,
        triesLeft: null,
      }),
      LP,
      "enter",
      [...ENTER, PH, "localPairing.cooldownTitle", "localPairing.cooldownBody"],
      {
        disabled: ["localPairing.pair"],
        mustNot: {
          invariant:
            "The joiner shows no countdown: the budget frees only after the other window closed.",
          copy: ["localPairing.showNewIn"],
        },
      },
    ),
    row(
      `${LP}/enter: nothing found on the network`,
      pair("enter", {
        entry: "4812 3456",
        categories: CATS,
        error: "not-found",
        triesLeft: 2,
      }),
      LP,
      "enter",
      [...ENTER, "localPairing.notFoundTitle", "localPairing.notFoundBody"],
    ),
    row(
      `${LP}/enter: not a code`,
      pair("enter", {
        entry: "4812",
        categories: CATS,
        error: "not-a-code",
        pairDisabled: true,
        triesLeft: 2,
      }),
      LP,
      "enter",
      [...ENTER, "localPairing.notACode"],
      { disabled: ["localPairing.pair"] },
    ),
    row(
      `${LP}/enter: the app asks for no categories`,
      pair("enter", {
        entry: "",
        categories: [],
        pairDisabled: true,
        triesLeft: null,
      }),
      LP,
      "enter",
      [
        ...ENTER.filter((k) => k !== "linkPairing.shares"),
        "linkPairing.sharesNone",
        PH,
      ],
      { disabled: ["localPairing.pair"] },
    ),
    row(
      `${LP}/joining: Pair keeps its label while it looks, Cancel stops it`,
      pair("joining", { entry: "4812 3456", categories: CATS }),
      LP,
      "joining",
      JOIN,
      {
        disabled: ["localPairing.pair"],
        mustNot: {
          invariant:
            "While looking, the screen never offers to show a code instead.",
          copy: ["localPairing.toShow", "common.back"],
        },
      },
    ),
    row(
      `${LP}/joining: nothing is shared`,
      pair("joining", { entry: "4812 3456", categories: [] }),
      LP,
      "joining",
      [
        ...JOIN.filter((k) => k !== "linkPairing.shares"),
        "linkPairing.sharesNone",
      ],
      { disabled: ["localPairing.pair"] },
    ),
    row(
      `${LP}/confirm: the device that entered the code, named`,
      pair("confirm", { device: "LAPTOP-7QH3RX", categories: CATS }),
      LP,
      "confirm",
      [
        "localPairing.confirmTitle",
        "localPairing.confirmBody",
        "linkPairing.shares",
        "localPairing.pair",
        "common.notNow",
      ],
      inv(
        "Not now leads, so Enter on arrival never pairs; the name is unauthenticated text.",
        {
          copy: ["localPairing.confirmUnnamed"],
          states: ["paired"],
        },
      ),
    ),
    row(
      `${LP}/confirm: the device sent no name`,
      pair("confirm", { categories: CATS }),
      LP,
      "confirm",
      [
        "localPairing.confirmUnnamed",
        "localPairing.confirmBody",
        "linkPairing.shares",
        "localPairing.pair",
        "common.notNow",
      ],
    ),
    row(
      `${LP}/confirm: nothing is shared`,
      pair("confirm", { device: "Studio PC", categories: [] }),
      LP,
      "confirm",
      [
        "localPairing.confirmTitle",
        "localPairing.confirmBody",
        "linkPairing.sharesNone",
        "localPairing.pair",
        "common.notNow",
      ],
    ),
    row(
      `${LP}/confirm: Pair was pressed, both controls wait for the answer`,
      pair("confirm", {
        device: "LAPTOP-7QH3RX",
        categories: CATS,
        busy: "pair",
      }),
      LP,
      "confirm",
      [
        "localPairing.confirmTitle",
        "localPairing.confirmBody",
        "linkPairing.shares",
        "localPairing.pair",
        "common.notNow",
        "a11y.busy",
      ],
      {
        disabled: ["localPairing.pair", "common.notNow"],
        mustNot: {
          invariant:
            "A second press never confirms twice, and the screen never says it paired before the window does.",
          copy: ["localPairing.pairedTitle"],
          states: ["paired"],
        },
      },
    ),
    row(
      `${LP}/confirm: Not now was pressed, both controls wait for the answer`,
      pair("confirm", {
        device: "LAPTOP-7QH3RX",
        categories: CATS,
        busy: "not-now",
      }),
      LP,
      "confirm",
      [
        "localPairing.confirmTitle",
        "localPairing.confirmBody",
        "linkPairing.shares",
        "localPairing.pair",
        "common.notNow",
        "a11y.busy",
      ],
      { disabled: ["localPairing.pair", "common.notNow"] },
    ),
    row(
      `${LP}/waiting: for the other person, named, with what each shares`,
      pair("waiting", { device: "Studio PC", categories: CATS }),
      LP,
      "waiting",
      [
        "linkPairing.waiting",
        "localPairing.waitingWith",
        "linkPairing.shares",
        "common.cancel",
      ],
    ),
    row(
      `${LP}/waiting: the shower sent no name, nothing is shared`,
      pair("waiting", { categories: [] }),
      LP,
      "waiting",
      ["linkPairing.waiting", "linkPairing.sharesNone", "common.cancel"],
    ),
    row(
      `${LP}/paired: the name starts as the one the device sent`,
      pair("paired", { device: "LAPTOP-7QH3RX" }),
      LP,
      "paired",
      [
        "localPairing.pairedTitle",
        "localPairing.pairedBody",
        "localPairing.nameLabel",
        "localPairing.nameHint",
        "common.done",
      ],
      inv("A pairing that was made never says it failed.", {
        copy: ["linkPairing.failedTitle"],
        states: ["failed"],
      }),
    ),
    row(
      `${LP}/paired: kept, but it cannot connect while 8 can`,
      pair("paired", { device: "LAPTOP-7QH3RX", cantConnect: true, max: 8 }),
      LP,
      "paired",
      [
        "localPairing.pairedTitle",
        "localPairing.pairedBody",
        "localPairing.nameLabel",
        "localPairing.nameHint",
        "localPairing.cantConnectTitle",
        "localPairing.cantConnectBody",
        "localPairing.pairedDevices",
        "common.done",
      ],
    ),
    row(
      `${LP}/paired: the name could not be kept, the screen stays`,
      pair("paired", { device: "LAPTOP-7QH3RX", nameError: "failed" }),
      LP,
      "paired",
      [
        "localPairing.pairedTitle",
        "localPairing.pairedBody",
        "localPairing.nameLabel",
        "localPairing.nameHint",
        "devices.renameFailed",
        "common.done",
      ],
      inv("A name that was not kept is never lost without a word.", {
        copy: ["pairedDevices.renameEmpty"],
      }),
    ),
    failed("declined", "linkPairing.failedDeclined", "someone said Not now"),
    failed(
      "timeout",
      "linkPairing.failedTimeout",
      "time ran out before both confirmed",
    ),
    failed("full", "localPairing.failedFull", "one device has no room"),
    failed("closed", "linkPairing.failedClosed", "the connection closed"),
    row(
      `${LP}/network-blocked: Open Settings where the platform can`,
      pair("network-blocked", { canOpenSettings: true }),
      LP,
      "network-blocked",
      [
        "core.codes.nearby-permission-denied.title",
        "core.codes.nearby-permission-denied.message",
        "localPairing.openSettings",
        "common.tryAgain",
        "common.close",
      ],
    ),
    row(
      `${LP}/network-blocked: the words alone elsewhere`,
      pair("network-blocked"),
      LP,
      "network-blocked",
      [
        "core.codes.nearby-permission-denied.title",
        "core.codes.nearby-permission-denied.message",
        "common.tryAgain",
        "common.close",
      ],
      inv(
        "A platform that cannot open its settings never offers a button that does nothing, and Try again returns to where the person was.",
        {
          copy: ["localPairing.openSettings"],
        },
      ),
    ),
    row(
      `${LP}/off: pairing is off for the app`,
      pair("off"),
      LP,
      "off",
      [
        "core.codes.local-pairing-off.title",
        "core.codes.local-pairing-off.message",
        "common.close",
      ],
      inv("An app with pairing off never offers to pair.", {
        copy: ["localPairing.show", "localPairing.enter", "localPairing.pair"],
        states: ["choose", "show", "enter"],
      }),
    ),
    row(
      `${LP}/hidden: Connect off`,
      { services: NO_CONNECT, ...pair("choose") },
      LP,
      "hidden",
      [],
    ),

    row(
      `${PD}/list: five paired devices, every one can connect`,
      list("list", {}, devs(5)),
      PD,
      "list",
      LIST,
      inv(
        "With every device on and 8 or fewer, the switch does nothing useful and is not drawn.",
        {
          copy: SW,
        },
      ),
    ),
    row(
      `${PD}/list: one is off, so the Can connect column shows`,
      list("list", {}, devs(5, 4)),
      PD,
      "list",
      [...LIST, ...SW],
    ),
    row(
      `${PD}/list: 8 can connect and more are paired`,
      list("list", {}, devs(10, 8)),
      PD,
      "list",
      [
        ...LIST,
        ...SW,
        "pairedDevices.reachableFullTitle",
        "pairedDevices.reachableFullBody",
      ],
    ),
    row(
      `${PD}/list: no room for another, Pair with a Code waits`,
      list("list", {}, devs(32, 8)),
      PD,
      "list",
      [
        ...LIST,
        ...SW,
        "pairedDevices.reachableFullTitle",
        "pairedDevices.reachableFullBody",
        "core.codes.local-links-full.title",
        "pairedDevices.fullBody",
      ],
      { disabled: ["pairedDevices.pair"] },
    ),
    row(
      `${PD}/list: never seen, so no Last seen`,
      list("list", {}, devs(2, 2, false)),
      PD,
      "list",
      LIST.filter((k) => k !== "pairedDevices.lastSeen"),
    ),
    row(
      `${PD}/list: the app could not find a device`,
      list(
        "list",
        { notice: { device: "Theo's laptop", kind: "not-found" } },
        devs(3),
      ),
      PD,
      "list",
      [...LIST, "pairedDevices.notFoundTitle", "pairedDevices.notFoundBody"],
    ),
    row(
      `${PD}/list: a device is busy`,
      list(
        "list",
        { notice: { device: "Theo's laptop", kind: "busy" } },
        devs(3),
      ),
      PD,
      "list",
      [...LIST, "pairedDevices.busyTitle", "common.tryAgain"],
    ),
    row(
      `${PD}/list: a device is no longer paired`,
      list(
        "list",
        { notice: { device: "Theo's laptop", kind: "unknown" } },
        devs(3),
      ),
      PD,
      "list",
      [
        ...LIST,
        "core.codes.link-unknown.title",
        "core.codes.link-unknown.message",
      ],
    ),
    row(
      `${PD}/renaming: in the row`,
      list("renaming", { target: "L1" }, devs(4, 3)),
      PD,
      "renaming",
      [
        ...LIST,
        ...SW,
        "devices.renameLabel",
        "localPairing.nameHint",
        "common.save",
        "common.cancel",
      ],
      inv("A name is never sent to the other device.", {
        copy: ["pairedDevices.renameLong", "pairedDevices.renameEmpty"],
      }),
    ),
    row(
      `${PD}/renaming: a name over 64 characters is refused`,
      list("renaming", { target: "L1", renameError: "long" }, devs(4, 3)),
      PD,
      "renaming",
      [
        ...LIST,
        ...SW,
        "devices.renameLabel",
        "localPairing.nameHint",
        "common.save",
        "common.cancel",
        "pairedDevices.renameLong",
      ],
    ),
    row(
      `${PD}/renaming: nothing left once cleaned`,
      list("renaming", { target: "L1", renameError: "empty" }, devs(4, 3)),
      PD,
      "renaming",
      [
        ...LIST,
        ...SW,
        "devices.renameLabel",
        "localPairing.nameHint",
        "common.save",
        "common.cancel",
        "pairedDevices.renameEmpty",
      ],
    ),
    row(
      `${PD}/renaming: the store could not keep the name`,
      list("renaming", { target: "L1", renameError: "failed" }, devs(4, 3)),
      PD,
      "renaming",
      [
        ...LIST,
        ...SW,
        "devices.renameLabel",
        "localPairing.nameHint",
        "common.save",
        "common.cancel",
        "devices.renameFailed",
      ],
      inv("A store failure is never worded as an empty name.", {
        copy: ["pairedDevices.renameEmpty"],
      }),
    ),
    row(
      `${PD}/forgetting: the store could not forget it, the question stays`,
      list("forgetting", { target: "L2", forgetError: true }, devs(4, 3)),
      PD,
      "forgetting",
      [
        ...LIST,
        ...SW,
        "pairedDevices.forgetConfirm",
        "pairedDevices.forgetBody",
        "pairedDevices.forgetFailed",
        "common.cancel",
      ],
    ),
    row(
      `${PD}/forgetting: asks inside the row`,
      list("forgetting", { target: "L2" }, devs(4, 3)),
      PD,
      "forgetting",
      [
        ...LIST,
        ...SW,
        "pairedDevices.forgetConfirm",
        "pairedDevices.forgetBody",
        "common.cancel",
      ],
      inv("Forget is local: it never reads as Remove, a server action.", {
        copy: ["devices.manage"],
      }),
    ),
    row(
      `${PD}/loading: the first read has not answered`,
      list("loading", {}, []),
      PD,
      "loading",
      ["pairedDevices.title", "a11y.busy", "common.done"],
      inv("Nothing is said about what is paired before the list is read.", {
        copy: ["pairedDevices.empty", "pairedDevices.pair"],
        states: ["empty", "list"],
      }),
    ),
    row(`${PD}/empty: nothing paired yet`, list("list", {}, []), PD, "empty", [
      "pairedDevices.title",
      "pairedDevices.empty",
      "pairedDevices.pair",
      "common.done",
    ]),
    row(
      `${PD}/load-failed: the record cannot be read`,
      list("load-failed", {}, []),
      PD,
      "load-failed",
      [
        "pairedDevices.title",
        "pairedDevices.loadFailed",
        "common.tryAgain",
        "common.done",
      ],
      inv("An unreadable record offers no list and no Pair with a Code.", {
        copy: ["pairedDevices.pair"],
        states: ["list", "empty"],
      }),
    ),
    row(
      `${PD}/off: pairing is off, Rename and Forget remain`,
      list("off", {}, devs(3)),
      PD,
      "off",
      [
        "pairedDevices.title",
        "core.codes.local-pairing-off.title",
        "pairedDevices.offBody",
        "pairedDevices.lastSeen",
        "a11y.deviceOptions",
        "devices.rename",
        "pairedDevices.forget",
        "common.done",
      ],
      inv(
        "With pairing off no switch and no Pair with a Code is drawn; deleting what is held still works.",
        {
          copy: [...SW, "pairedDevices.pair"],
        },
      ),
    ),
    row(
      `${PD}/hidden: Connect off`,
      { services: NO_CONNECT, ...list("list", {}, devs(2)) },
      PD,
      "hidden",
      [],
    ),
    ...scanRows(),
  ];
}

/** The window rule rows of the show screen (UI-KITS 4.3, LocalPairing). */
function localLayoutRows(): LayoutRow[] {
  const r = (
    name: string,
    window: LayoutRow["window"],
    expect: LayoutRow["expect"],
  ): LayoutRow => ({ name, window, expect });
  const two = {
    panes: 2,
    logo: true,
    scrolls: false,
    noticeBeforeQr: false,
  } as const;
  return [
    r("wide: two panes, the kit's logo", { width: 1280, height: 800 }, two),
    r(
      "600 wide is the first width with two panes",
      { width: 600, height: 700 },
      two,
    ),
    r(
      "599 wide is one column",
      { width: 599, height: 700 },
      {
        panes: 1,
        logo: true,
        scrolls: false,
        noticeBeforeQr: false,
      },
    ),
    r(
      "200 % text keeps one column in a window that is 1100 wide",
      { width: 1100, height: 800, textScale: 2 },
      {
        panes: 1,
        logo: true,
        scrolls: false,
        noticeBeforeQr: false,
      },
    ),
    r(
      "short and wide (720 by 420): two panes, no logo, no scroll",
      { width: 720, height: 420 },
      {
        panes: 2,
        logo: false,
        scrolls: false,
        noticeBeforeQr: false,
      },
    ),
    r(
      "narrow and short (390 by 420): one column that scrolls, the notice before the QR",
      { width: 390, height: 420 },
      {
        panes: 1,
        logo: false,
        scrolls: true,
        noticeBeforeQr: true,
      },
    ),
    r(
      "a TV is always two panes",
      { width: 480, height: 360, tv: true },
      {
        panes: 2,
        logo: true,
        scrolls: false,
        noticeBeforeQr: false,
      },
    ),
  ];
}

/** The local family's structure, and the window rule rows beside it. */
function checkLocal(doc: UiMatrix, S: UiMatrixSources): string[] {
  const errors = checkScreens(doc.local, "local", LOCAL_FAMILY_COMPONENTS, S);
  if (!Array.isArray(doc.localLayout) || doc.localLayout.length === 0)
    errors.push("localLayout: the family is empty");
  return errors;
}

// ── Checks (plans/UK-02b.md §4.7, UK-02 §4) ─────────────────────────────────────────────────

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The cloudSync family's components (ui-core `SYNC_SCREENS` plus CloudSyncStatus). */
export const SYNC_FAMILY_COMPONENTS = [
  "CloudSyncStatus",
  "UnlockSync",
  "RecoveryCode",
  "RingChange",
] as const;

/** A components.json state's copy list, or an error naming the row that cites a missing state. */
function stateList(
  S: UiMatrixSources,
  component: string,
  state: string,
  where: string,
  errors: string[],
): string[] | undefined {
  const listed = S.components[component]?.states[state]?.copy;
  if (!listed)
    errors.push(
      `${where}: ${component}.${state} is not a components.json state`,
    );
  return listed;
}

/** The cloudSync family's structure: components, states, and the keys each state lists. */
function checkCloudSync(doc: UiMatrix, S: UiMatrixSources): string[] {
  const errors: string[] = [];
  const rows = doc.cloudSync;
  if (!Array.isArray(rows) || rows.length === 0)
    return ["cloudSync: the family is empty"];
  const names = new Set<string>();
  const states = new Set<string>();
  for (const r of rows) {
    const where = `cloudSync "${r.name}"`;
    if (names.has(r.name)) errors.push(`${where}: duplicate name`);
    names.add(r.name);
    const { component, state, copy } = r.expect;
    if (!(SYNC_FAMILY_COMPONENTS as readonly string[]).includes(component)) {
      errors.push(`${where}: ${component} is not a cloudSync component`);
      continue;
    }
    states.add(`${component}.${state}`);
    const services = r.input.services as string[] | undefined;
    if (state === "hidden") {
      if (!services || services.includes("sync"))
        errors.push(`${where}: hidden needs Cloud Sync off`);
      if (copy.length > 0) errors.push(`${where}: hidden shows no copy`);
      continue;
    }
    const listed = stateList(S, component, state, where, errors);
    if (!listed) continue;
    for (const k of copy)
      if (!listed.includes(k))
        errors.push(`${where}: ${k} is not in ${component}.${state}'s list`);
    for (const k of r.mustNot?.copy ?? [])
      if (copy.includes(k)) errors.push(`${where}: expects ${k} it forbids`);
  }
  for (const c of SYNC_FAMILY_COMPONENTS)
    for (const st of Object.keys(S.components[c]?.states ?? {}))
      if (
        !states.has(`${c}.${st}`) &&
        (c !== "CloudSyncStatus" || ["locked", "ring-changed"].includes(st))
      )
        errors.push(`cloudSync: no row for ${c}.${st}`);
  return errors;
}

/** The saveConflict family's states beyond SaveConflict's own: CloudSyncStatus's transfer states. */
const SAVE_STATES: Record<string, readonly string[]> = {
  CloudSyncStatus: ["transferring", "waiting", "transfer-failed"],
  SaveConflict: ["choose", "keeping", "kept", "failed"],
};

/** The saveConflict family: components, states, copy and actions, and every listed key shown. */
function checkSaveConflict(doc: UiMatrix, S: UiMatrixSources): string[] {
  const errors: string[] = [];
  const rows = doc.saveConflict;
  if (!Array.isArray(rows) || rows.length === 0)
    return ["saveConflict: the family is empty"];
  const allSlugs = S.services.map((s) => s.slug);
  const names = new Set<string>();
  const shown = new Map<string, Set<string>>();
  for (const r of rows) {
    const where = `saveConflict "${r.name}"`;
    if (!names.has(r.name)) names.add(r.name);
    else errors.push(`${where}: duplicate name`);
    const { component, state, copy } = r.expect;
    const actions = r.expect.actions ?? [];
    if (!(component in SAVE_STATES)) {
      errors.push(`${where}: ${component} is not a saveConflict component`);
      continue;
    }
    const services = (r.input.services as string[] | undefined) ?? allSlugs;
    for (const s of S.services)
      if (services.includes(s.slug))
        for (const req of s.requires)
          if (!services.includes(req))
            errors.push(
              `${where}: services is not closed (${s.slug} needs ${req})`,
            );
    if ([...copy].sort().join() !== copy.join())
      errors.push(`${where}: copy is not sorted`);
    // A control drawn disabled is copy but not an action: it must be named by mustNot.
    const derived = actionsFor(copy);
    for (const x of derived)
      if (!actions.includes(x) && !(r.mustNot?.actions ?? []).includes(x))
        errors.push(`${where}: control ${x} is neither offered nor forbidden`);
    for (const x of actions) {
      if (!derived.includes(x))
        errors.push(`${where}: action ${x} is not a control the copy shows`);
      if (!(x in ACTIONS))
        errors.push(`${where}: action ${x} is not in the vocabulary`);
    }
    if (state === "hidden") {
      if (services.includes("sync") || copy.length > 0)
        errors.push(`${where}: hidden shows no copy and needs Cloud Sync off`);
      continue;
    }
    if (!SAVE_STATES[component]!.includes(state)) {
      errors.push(`${where}: ${component}.${state} is not a save state`);
      continue;
    }
    const listed = stateList(S, component, state, where, errors);
    if (!listed) continue;
    for (const k of copy)
      if (!listed.includes(k))
        errors.push(`${where}: ${k} is not in ${component}.${state}'s list`);
    const m = r.mustNot;
    if (m) {
      if ((m.states ?? []).includes(state))
        errors.push(`${where}: expects the state it forbids`);
      for (const k of m.copy ?? [])
        if (copy.includes(k)) errors.push(`${where}: expects ${k} it forbids`);
      for (const x of m.actions ?? [])
        if (actions.includes(x))
          errors.push(`${where}: offers ${x} it forbids`);
    }
    const set = shown.get(`${component}.${state}`) ?? new Set<string>();
    for (const k of copy) set.add(k);
    shown.set(`${component}.${state}`, set);
  }
  for (const [c, states] of Object.entries(SAVE_STATES))
    for (const st of states) {
      const union = shown.get(`${c}.${st}`);
      if (!union) {
        errors.push(`saveConflict: no row for ${c}.${st}`);
        continue;
      }
      for (const k of S.components[c]?.states[st]?.copy ?? [])
        if (!union.has(k))
          errors.push(`saveConflict: no row shows ${k} in ${c}.${st}`);
    }
  if (
    !rows.some(
      (r) =>
        r.expect.component === "SaveConflict" && r.expect.state === "hidden",
    )
  )
    errors.push("saveConflict: no hidden row for SaveConflict");
  return errors;
}

/** The connect family's components. */
export const CONNECT_FAMILY_COMPONENTS = [
  "LinkPairing",
  "TransferOffer",
] as const;

/**
 * A family of one-state screens: components, states, the keys each lists (and the controls drawn
 * disabled), a hidden row with Connect off for each, and every listed key shown by some row.
 */
function checkScreens(
  rows: Row[] | undefined,
  family: string,
  components: readonly string[],
  S: UiMatrixSources,
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(rows) || rows.length === 0)
    return [`${family}: the family is empty`];
  const names = new Set<string>();
  const shown = new Map<string, Set<string>>();
  for (const r of rows) {
    const where = `${family} "${r.name}"`;
    if (names.has(r.name)) errors.push(`${where}: duplicate name`);
    names.add(r.name);
    const { component, state, copy } = r.expect;
    if (!components.includes(component)) {
      errors.push(`${where}: ${component} is not a ${family} component`);
      continue;
    }
    const services = r.input.services as string[] | undefined;
    if (state === "hidden") {
      if (!services || services.includes("connect"))
        errors.push(`${where}: hidden needs Connect off`);
      if (copy.length > 0) errors.push(`${where}: hidden shows no copy`);
      shown.set(`${component}.hidden`, new Set());
      continue;
    }
    const listed = stateList(S, component, state, where, errors);
    if (!listed) continue;
    for (const k of copy)
      if (!listed.includes(k))
        errors.push(`${where}: ${k} is not in ${component}.${state}'s list`);
    for (const k of r.expect.disabled ?? [])
      if (!listed.includes(k))
        errors.push(`${where}: disabled ${k} is not in the state's list`);
    for (const k of r.mustNot?.copy ?? [])
      if (copy.includes(k)) errors.push(`${where}: expects ${k} it forbids`);
    if (r.mustNot?.states?.includes(state))
      errors.push(`${where}: mustNot names its own state`);
    const set = shown.get(`${component}.${state}`) ?? new Set<string>();
    for (const k of copy) set.add(k);
    shown.set(`${component}.${state}`, set);
  }
  for (const c of components) {
    if (!shown.has(`${c}.hidden`))
      errors.push(`${family}: no hidden row for ${c}`);
    for (const [st, { copy: list }] of Object.entries(
      S.components[c]?.states ?? {},
    )) {
      const union = shown.get(`${c}.${st}`);
      if (!union) {
        errors.push(`${family}: no row for ${c}.${st}`);
        continue;
      }
      for (const k of list)
        if (!union.has(k))
          errors.push(`${family}: no row shows ${k} in ${c}.${st}`);
    }
  }
  return errors;
}

/** The connect family's structure. */
const checkConnect = (doc: UiMatrix, S: UiMatrixSources): string[] =>
  checkScreens(doc.connect, "connect", CONNECT_FAMILY_COMPONENTS, S);

/** A row's copy keys against its state's list: a `core.*` key is in copy.en.json, any other is listed. */
function copyErrors(
  S: UiMatrixSources,
  where: string,
  component: string,
  state: string,
  copy: readonly string[],
  listed: readonly string[],
): string[] {
  const errors: string[] = [];
  for (const k of copy) {
    if (k.startsWith("core.")) {
      if (!(k in (S.core.en ?? {})))
        errors.push(`${where}: ${k} is not in copy.en.json`);
    } else if (!listed.includes(k))
      errors.push(`${where}: ${k} is not in ${component}.${state}'s list`);
  }
  return errors;
}

/** Every pinned state has a row, and the rows together show every key its list holds. */
function coverageErrors(
  family: string,
  states: Record<string, readonly string[]>,
  shown: Map<string, Set<string>>,
  S: UiMatrixSources,
): string[] {
  const errors: string[] = [];
  for (const [c, list] of Object.entries(states))
    for (const st of list) {
      const union = shown.get(`${c}.${st}`);
      if (!union) {
        errors.push(`${family}: no row for ${c}.${st}`);
        continue;
      }
      for (const k of S.components[c]?.states[st]?.copy ?? [])
        if (!union.has(k))
          errors.push(`${family}: no row shows ${k} in ${c}.${st}`);
    }
  return errors;
}

/** The nearby family's states (a must component's rows also count toward its coverage). */
const NEARBY_STATES: Record<string, readonly string[]> = {
  SignIn: [
    "nearby-choose",
    "nearby-none-found",
    "nearby-denied",
    "nearby-expired",
    "nearby-not-nearby",
    "nearby-failed",
    "nearby-rate-limited",
    "nearby-unavailable",
    "nearby-cancelled",
    "nearby-signed-out",
  ],
  NearbyApproval: ["listening", "stopped", "failed"],
};

/** The nearby family's structure: components, states, copy and actions. */
function checkNearby(doc: UiMatrix, S: UiMatrixSources): string[] {
  const errors: string[] = [];
  const rows = doc.nearby;
  if (!Array.isArray(rows) || rows.length === 0)
    return ["nearby: the family is empty"];
  const names = new Set<string>();
  const shown = new Map<string, Set<string>>();
  for (const r of rows) {
    const where = `nearby "${r.name}"`;
    if (names.has(r.name)) errors.push(`${where}: duplicate name`);
    names.add(r.name);
    const { component, state, copy } = r.expect;
    const actions = r.expect.actions ?? [];
    if (!NEARBY_STATES[component]?.includes(state)) {
      errors.push(`${where}: ${component}.${state} is not a nearby state`);
      continue;
    }
    if ([...copy].sort().join() !== copy.join())
      errors.push(`${where}: copy is not sorted`);
    const derived = actionsFor(copy);
    if (derived.join() !== actions.join())
      errors.push(
        `${where}: actions ${actions.join(",")} are not its controls' (${derived.join(",")})`,
      );
    const listed = stateList(S, component, state, where, errors);
    if (!listed) continue;
    errors.push(...copyErrors(S, where, component, state, copy, listed));
    const set = shown.get(`${component}.${state}`) ?? new Set<string>();
    for (const k of copy) set.add(k);
    shown.set(`${component}.${state}`, set);
  }
  errors.push(...coverageErrors("nearby", NEARBY_STATES, shown, S));
  return errors;
}

/** The holders family's components. */
export const HOLDERS_COMPONENTS = [
  "ActivateDone",
  "AddToAccount",
  "SignIn",
  "AccountAndLicense",
] as const;

/** The states the holders family pins (a must component's rows also count toward its coverage). */
const HOLDERS_STATES: Record<string, readonly string[]> = {
  ActivateDone: ["ready", "waiting"],
  AddToAccount: [
    "form",
    "invalid",
    "busy",
    "added",
    "owned",
    "email-bound",
    "other-account",
    "failed",
  ],
  SignIn: ["key-done", "attach", "added"],
};

/** The holders family's structure: components, states, copy and actions, Cloud Sync's line. */
function checkHolders(doc: UiMatrix, S: UiMatrixSources): string[] {
  const errors: string[] = [];
  const rows = doc.holders;
  if (!Array.isArray(rows) || rows.length === 0)
    return ["holders: the family is empty"];
  const allSlugs = S.services.map((s) => s.slug);
  const names = new Set<string>();
  const shown = new Map<string, Set<string>>();
  for (const r of rows) {
    const where = `holders "${r.name}"`;
    if (!names.has(r.name)) names.add(r.name);
    else errors.push(`${where}: duplicate name`);
    const { component, state, copy } = r.expect;
    const actions = r.expect.actions ?? [];
    if (!(HOLDERS_COMPONENTS as readonly string[]).includes(component)) {
      errors.push(`${where}: ${component} is not a holders component`);
      continue;
    }
    const services = (r.input.services as string[] | undefined) ?? allSlugs;
    for (const s of services)
      if (!allSlugs.includes(s)) errors.push(`${where}: unknown service ${s}`);
    for (const s of S.services)
      if (services.includes(s.slug))
        for (const req of s.requires)
          if (!services.includes(req))
            errors.push(
              `${where}: services is not closed (${s.slug} needs ${req})`,
            );
    if ([...copy].sort().join() !== copy.join())
      errors.push(`${where}: copy is not sorted`);
    const derived = actionsFor(copy);
    if (derived.join() !== actions.join())
      errors.push(
        `${where}: actions ${actions.join(",")} are not its controls' (${derived.join(",")})`,
      );
    for (const a of actions)
      if (!(a in ACTIONS))
        errors.push(`${where}: action ${a} is not in the vocabulary`);
    if (state === "hidden") {
      if (services.length === allSlugs.length || copy.length > 0)
        errors.push(`${where}: hidden shows no copy and needs a service off`);
      continue;
    }
    const listed = stateList(S, component, state, where, errors);
    if (!listed) continue;
    errors.push(...copyErrors(S, where, component, state, copy, listed));
    const on = (s: string) => services.includes(s);
    // The reasons rule (UK-42.3): Cloud Sync only with sync; get it back and move it only with
    // Identity; Identity off, the portal line alone.
    const has = (k: string) => copy.includes(k);
    if (has("activate.recommend.sync") && !on("sync"))
      errors.push(`${where}: Cloud Sync's line with Cloud Sync off`);
    if (has("activate.attach.syncOn") && !on("sync"))
      errors.push(`${where}: Cloud Sync's line with Cloud Sync off`);
    for (const k of [
      "activate.recommend.recover",
      "activate.recommend.devices",
    ])
      if (has(k) && !on("identity"))
        errors.push(`${where}: ${k} with Identity off`);
    if (has("activate.recommend.portal") && on("identity"))
      errors.push(`${where}: the portal line is for Identity off`);
    if (has("activate.recommend.title") && !has("activate.recommend.portal")) {
      const reasons = [
        "activate.recommend.sync",
        "activate.recommend.recover",
        "activate.recommend.devices",
      ];
      for (const k of reasons.slice(1))
        if (on("identity") && !has(k))
          errors.push(`${where}: Identity on lists ${k}`);
      if (on("sync") && !has(reasons[0]!))
        errors.push(`${where}: Cloud Sync on lists ${reasons[0]}`);
    }
    const set = shown.get(`${component}.${state}`) ?? new Set<string>();
    for (const k of copy) set.add(k);
    shown.set(`${component}.${state}`, set);
  }
  errors.push(...coverageErrors("holders", HOLDERS_STATES, shown, S));
  errors.push(...checkHoldersFlow(doc));
  for (const c of ["ActivateDone", "AddToAccount"])
    if (
      !rows.some((r) => r.expect.component === c && r.expect.state === "hidden")
    )
      errors.push(`holders: no hidden row for ${c}`);
  return errors;
}

/** Every check of §4.7 over a built matrix. Empty = valid. */
export function checkUiMatrix(doc: UiMatrix, S: UiMatrixSources): string[] {
  const errors: string[] = [];
  const allSlugs = S.services.map((s) => s.slug);
  const coreEn = S.core.en ?? {};
  const must = Object.entries(S.components).filter(
    ([, c]) => c.priority === "must",
  );
  const mustNames = must.map(([n]) => n);
  const familyOf = (c: string) => S.components[c]?.family;
  const stateRows = new Map<string, Row[]>();
  const absents = new Map<string, Row>();
  const offPairs = new Set<string>();
  const endings = new Set<string>();
  const mustNotSeen = new Set<string>();
  const delayedSeen = new Set<string>();
  const enumHas = (name: string, v: unknown) =>
    (S.enums[name] ?? []).includes(v as string);

  for (const s of S.services)
    for (const r of s.requires)
      if (!allSlugs.includes(r))
        errors.push(`tools/services.json ${s.slug}: requires unknown ${r}`);
  for (const [c, deps] of Object.entries(SERVICE_DEPENDENCIES)) {
    if (!mustNames.includes(c))
      errors.push(`SERVICE_DEPENDENCIES: ${c} is not a must component`);
    for (const d of deps)
      if (!allSlugs.includes(d))
        errors.push(`SERVICE_DEPENDENCIES ${c}: ${d} is not a service slug`);
  }
  for (const c of mustNames)
    if (!(c in SERVICE_DEPENDENCIES))
      errors.push(`SERVICE_DEPENDENCIES: ${c} is missing`);
  for (const [c, comp] of Object.entries(S.components))
    if ("hidden" in comp.states)
      errors.push(
        `components.json ${c}: "hidden" is reserved (plans/UK-02b.md §4.3)`,
      );
  for (const [where, keys] of Object.entries(UNREACHED)) {
    const [c, s] = where.split(".");
    const list = S.components[c!]?.states[s!]?.copy;
    if (!list) errors.push(`UNREACHED ${where}: not a components.json state`);
    for (const [k, why] of Object.entries(keys)) {
      if (list && !list.includes(k))
        errors.push(`UNREACHED ${where}: ${k} is not in its list`);
      if (!why.trim()) errors.push(`UNREACHED ${where} ${k}: no reason`);
    }
  }

  for (const family of COMPONENT_FAMILIES) {
    const rows = doc[family];
    if (!Array.isArray(rows) || rows.length === 0) {
      errors.push(`${family}: the family is empty`);
      continue;
    }
    const names = new Set<string>();
    for (const r of rows) {
      const where = `${family} "${r.name}"`;
      if (names.has(r.name)) errors.push(`${where}: duplicate name`);
      names.add(r.name);
      const { component, state, copy } = r.expect;
      const actions = r.expect.actions ?? [];
      const comp = S.components[component];
      if (!comp || comp.priority !== "must") {
        errors.push(`${where}: ${component} is not a must component`);
        continue;
      }
      if (familyOf(component) !== family)
        errors.push(`${where}: ${component} belongs to ${familyOf(component)}`);
      const input = r.input;
      const services = (input.services as string[] | undefined) ?? allSlugs;
      const on = (s: string) => services.includes(s);
      const offSlugs = allSlugs.filter((s) => !on(s));

      // Valid values.
      for (const s of services)
        if (!allSlugs.includes(s))
          errors.push(`${where}: unknown service ${s}`);
      for (const s of S.services)
        if (on(s.slug))
          for (const req of s.requires)
            if (!on(req))
              errors.push(
                `${where}: services is not closed (${s.slug} needs ${req})`,
              );
      const platform = (input.platform ?? DEFAULTS.platform) as Obj;
      if (
        !(MUST_OS as readonly string[]).includes(platform.os as string) ||
        !enumHas("platform", platform.os)
      )
        errors.push(
          `${where}: platform.os ${String(platform.os)} is not a must-tier platform`,
        );
      if (
        !(FORM_FACTORS as readonly string[]).includes(
          platform.formFactor as string,
        )
      )
        errors.push(
          `${where}: formFactor ${String(platform.formFactor)} is unknown`,
        );
      if (
        platform.formFactor === "tv" &&
        !["android", "linux"].includes(platform.os as string)
      )
        errors.push(`${where}: formFactor tv only with android or linux (D8)`);
      const registration = (input.registration ??
        DEFAULTS.registration) as string;
      if (!(REGISTRATION as readonly string[]).includes(registration))
        errors.push(`${where}: registration ${registration}`);
      const gate = input.gate as Obj | undefined;
      if (gate?.status !== undefined && !enumHas("licenseStatus", gate.status))
        errors.push(`${where}: gate.status ${String(gate.status)}`);
      const activation = input.activation as Obj | undefined;
      if (activation && !enumHas("activationResult", activation.result))
        errors.push(`${where}: activation.result ${String(activation.result)}`);
      const update = input.update as Obj | undefined;
      if (update) {
        if (!enumHas("updateAction", update.action))
          errors.push(`${where}: update.action ${String(update.action)}`);
        if (
          update.outlet !== undefined &&
          !enumHas("outletKind", update.outlet)
        )
          errors.push(`${where}: update.outlet ${String(update.outlet)}`);
        const progress = update.progress as Obj | undefined;
        if (
          progress &&
          !(PROGRESS_PHASES as readonly string[]).includes(
            progress.phase as string,
          )
        )
          errors.push(`${where}: progress.phase`);
        const reasons =
          update.action === "blocked"
            ? "updateBlockedReason"
            : update.action === "none"
              ? "updateNoneReason"
              : null;
        if (
          update.reason !== undefined &&
          (reasons === null || !enumHas(reasons, update.reason))
        )
          errors.push(`${where}: update.reason ${String(update.reason)}`);
      }
      const stage = input.stage as Obj | undefined;
      if (stage) {
        if (!S.stage.stages.includes(stage.stage as string))
          errors.push(`${where}: stage ${String(stage.stage)}`);
        if (!S.stage.outcomes.includes(stage.outcome as string))
          errors.push(`${where}: outcome ${String(stage.outcome)}`);
        if (
          stage.emit !== undefined &&
          !S.stage.emits.includes((stage.emit as Obj).type as string)
        )
          errors.push(`${where}: emit`);
      }
      const error = input.error as Obj | undefined;
      if (error && !(`core.codes.${String(error.code)}.title` in coreEn))
        errors.push(
          `${where}: error.code ${String(error.code)} has no core copy`,
        );
      if (
        input.pending !== undefined &&
        !(PENDING as readonly string[]).includes(input.pending as string)
      )
        errors.push(`${where}: pending ${String(input.pending)}`);
      const edit = input.edit as Obj | undefined;
      if (edit && !(EDITS as readonly string[]).includes(edit.kind as string))
        errors.push(`${where}: edit.kind`);
      // DL7's delayed response.
      if (input.elapsedMs !== undefined) {
        const ms = input.elapsedMs;
        const delayedState = (
          LOADING_DELAY.states as readonly string[]
        ).includes(`${component}.${state}`);
        if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0)
          errors.push(
            `${where}: elapsedMs is not a whole number of milliseconds`,
          );
        else if (!delayedState)
          errors.push(
            `${where}: elapsedMs only on a delayed loading state (DL7)`,
          );
        else if (ms >= LOADING_DELAY.min && ms < LOADING_DELAY.max)
          errors.push(
            `${where}: elapsedMs ${ms} is inside the ${LOADING_DELAY.min}-${LOADING_DELAY.max} ms window`,
          );
        else if (ms < LOADING_DELAY.min) {
          if (copy.length > 0 || actions.length > 0)
            errors.push(
              `${where}: a loading state shows nothing before the delay`,
            );
          delayedSeen.add(`${component}.${state}:before`);
        } else {
          const base = rows.find(
            (o) =>
              o !== r &&
              o.expect.component === component &&
              o.input.elapsedMs === undefined &&
              JSON.stringify({ ...o.input }) ===
                JSON.stringify(
                  Object.fromEntries(
                    Object.entries(input).filter(([k]) => k !== "elapsedMs"),
                  ),
                ),
          );
          if (!base || base.expect.copy.join() !== copy.join())
            errors.push(
              `${where}: past the delay a loading state shows its usual copy`,
            );
          delayedSeen.add(`${component}.${state}:past`);
        }
      }
      const toast = input.toast as Obj | undefined;
      if (
        toast &&
        !(TOASTS as readonly string[]).includes(toast.kind as string)
      )
        errors.push(`${where}: toast.kind`);
      const caps = {
        ...(DEFAULTS.capabilities as Obj),
        ...((input.capabilities as Obj | undefined) ?? {}),
      };
      for (const k of Object.keys(caps))
        if (!(k in (DEFAULTS.capabilities as Obj)))
          errors.push(`${where}: capability ${k}`);
      for (const a of actions)
        if (!(a in ACTIONS))
          errors.push(`${where}: action ${a} is not in the vocabulary`);

      const signIn = input.signIn as Obj | undefined;
      const deviceCode = input.deviceCode as Obj | undefined;
      if (signIn) {
        if (
          !(PRESENTATIONS as readonly string[]).includes(
            signIn.presentation as string,
          )
        )
          errors.push(`${where}: signIn.presentation`);
        if (
          !(REPLACE_MODES as readonly string[]).includes(
            signIn.replace as string,
          )
        )
          errors.push(`${where}: signIn.replace`);
        if (!(CHANNELS as readonly string[]).includes(signIn.channel as string))
          errors.push(`${where}: signIn.channel`);
        if (
          signIn.outcome !== undefined &&
          !(OUTCOMES as readonly string[]).includes(signIn.outcome as string)
        )
          errors.push(`${where}: signIn.outcome`);
        if (
          signIn.event !== undefined &&
          !(EVENTS as readonly string[]).includes(signIn.event as string)
        )
          errors.push(`${where}: signIn.event`);
        if (signIn.issuedNow !== undefined && signIn.outcome !== "signedIn")
          errors.push(`${where}: issuedNow only with outcome signedIn`);
      }
      // Input consistency (§4.7).
      if ((signIn?.channel === "device-code") !== (deviceCode !== undefined))
        errors.push(
          `${where}: a deviceCode input appears exactly with signIn.channel device-code`,
        );
      if (deviceCode) {
        if (
          !(DEVICE_CODE_PHASES as readonly string[]).includes(
            deviceCode.phase as string,
          )
        )
          errors.push(`${where}: deviceCode.phase`);
        if (signIn?.outcome !== undefined && signIn.outcome !== "signedIn")
          errors.push(
            `${where}: a device-code row's outcome is absent or signedIn (D3)`,
          );
        if (signIn?.outcome === "signedIn" && deviceCode.phase !== "ok")
          errors.push(`${where}: signedIn only with phase ok`);
      }
      if (!on("license")) {
        if (gate?.status !== undefined && gate.status !== "not-applicable")
          errors.push(
            `${where}: License off: gate.status must be not-applicable`,
          );
        if (registration === "requires-license")
          errors.push(
            `${where}: License off: registration cannot require a license`,
          );
        for (const k of ["choices", "replaceView", "activation"])
          if (k in input) errors.push(`${where}: License off: no ${k}`);
        if (signIn?.issuedNow !== undefined)
          errors.push(`${where}: License off: no issuedNow`);
        if (signIn?.event === "have-key" || state === "key")
          errors.push(`${where}: License off refuses the key path`);
      }
      if (!on("identity")) {
        if (signIn || deviceCode)
          errors.push(`${where}: Identity off: no signIn or deviceCode input`);
        if (caps.signIn === true)
          errors.push(
            `${where}: Identity off: capabilities.signIn cannot be true`,
          );
        if (registration === "requires-identity")
          errors.push(
            `${where}: Identity off: registration cannot require identity`,
          );
      }

      // Expectations.
      if (state === "hidden") {
        if (copy.length > 0 || actions.length > 0)
          errors.push(`${where}: hidden shows no copy and no actions`);
        if (offSlugs.length === 0)
          errors.push(
            `${where}: hidden only on a row that turns a service off`,
          );
      } else if (!(state in comp.states))
        errors.push(`${where}: ${component} has no state ${state}`);
      else {
        const list = comp.states[state]!.copy;
        const unreached = UNREACHED[`${component}.${state}`] ?? {};
        for (const k of copy) {
          if (k.startsWith("core.")) {
            if (!(k in coreEn))
              errors.push(`${where}: ${k} is not in copy.en.json`);
          } else if (!list.includes(k))
            errors.push(
              `${where}: ${k} is not in ${component}.${state}'s list (D7)`,
            );
          if (k in unreached)
            errors.push(`${where}: ${k} is listed as unreached`);
        }
        const rs = stateRows.get(`${component}.${state}`) ?? [];
        rs.push(r);
        stateRows.set(`${component}.${state}`, rs);
      }
      if ([...copy].sort().join() !== copy.join())
        errors.push(`${where}: copy is not sorted`);
      const derived = actionsFor(
        copy,
        actions.filter((x) => x === "replace-in-browser"),
      );
      if (derived.join() !== actions.join())
        errors.push(
          `${where}: actions ${actions.join(",")} are not its controls' (${derived.join(",")})`,
        );
      // D4 and §4.5: browser and device code never reach the in-app choice; replace browser never opens the list.
      const noChoice =
        signIn?.presentation === "browser" || signIn?.channel === "device-code";
      if (
        noChoice &&
        (component === "LicenseChoice" ||
          state === "choose" ||
          state === "replace")
      )
        errors.push(
          `${where}: a browser or device-code sign-in never reaches choose, replace or LicenseChoice (D4)`,
        );
      if (
        signIn?.replace === "browser" &&
        (state === "replace-open" || state === "replace")
      )
        errors.push(
          `${where}: replace browser never opens the device list in the app`,
        );
      // §4.5: how the form ends.
      if (component === "SignIn" && state === "done") {
        const want = !on("license")
          ? ["signin.return.signedInShort"]
          : signIn?.issuedNow === true
            ? [
                "signin.done.start",
                (input.account as Obj | undefined)?.tier
                  ? "signin.return.signedInTier"
                  : "signin.return.signedInShort",
              ]
            : ["signin.desktop.toast"];
        if (copy.join() !== [...want].sort().join())
          errors.push(`${where}: the form ends with ${want.join(", ")}`);
        if (signIn?.outcome !== "signedIn")
          errors.push(`${where}: done needs outcome signedIn`);
        if (on("license")) {
          const lane =
            signIn?.channel === "device-code"
              ? "device-code"
              : String(signIn?.presentation);
          endings.add(`${lane}:${String(signIn?.issuedNow === true)}`);
        }
      }
      // Service-off coverage.
      for (const s of offSlugs) offPairs.add(`${component}:${s}`);
      // D6.
      if (r.name === `${component}: presentation absent`)
        absents.set(component, r);
      // Must not.
      if (r.mustNot) {
        const m = r.mustNot;
        if (
          m.invariant !== MUST_NOT[component] &&
          !EXTRA_MUST_NOT[component]?.includes(m.invariant)
        )
          errors.push(`${where}: mustNot is not ${component}'s invariant`);
        if (m.states?.includes(state))
          errors.push(`${where}: mustNot names its own state`);
        for (const k of m.copy ?? [])
          if (copy.includes(k))
            errors.push(`${where}: mustNot copy ${k} is shown`);
        for (const k of m.actions ?? [])
          if (actions.includes(k))
            errors.push(`${where}: mustNot action ${k} is offered`);
        mustNotSeen.add(component);
      }
    }
  }

  // The holders and nearby families' rows count toward the states of the must components they name.
  for (const r of [...(doc.holders ?? []), ...(doc.nearby ?? [])]) {
    const { component, state } = r.expect;
    if (state === "hidden" || !mustNames.includes(component)) continue;
    const key = `${component}.${state}`;
    stateRows.set(key, [...(stateRows.get(key) ?? []), r]);
  }

  // Coverage.
  for (const [c, comp] of must) {
    for (const [state, { copy: list }] of Object.entries(comp.states)) {
      const rs = stateRows.get(`${c}.${state}`) ?? [];
      if (rs.length === 0) {
        errors.push(`${c}.${state}: no row`);
        continue;
      }
      const union = new Set(rs.flatMap((r) => r.expect.copy));
      const unreached = UNREACHED[`${c}.${state}`] ?? {};
      for (const k of list)
        if (!union.has(k) && !(k in unreached))
          errors.push(`${c}.${state}: no row shows ${k} (D7)`);
    }
    const absent = absents.get(c);
    if (!absent) errors.push(`${c}: no presentation-absent row (D6)`);
    else {
      if (absent.input.presentation !== null || "integrator" in absent.input)
        errors.push(
          `${c}: the presentation-absent row must set presentation null and no integrator`,
        );
      const base = defaultRowOf(doc, c, absent);
      if (!base)
        errors.push(`${c}: the presentation-absent row has no default row`);
      else {
        const dropped = base.expect.copy.filter(
          (k) => !absent.expect.copy.includes(k),
        );
        const added = absent.expect.copy.filter(
          (k) => !base.expect.copy.includes(k),
        );
        if (
          added.length > 0 ||
          dropped.some(
            (k) => !(IDENTITY_ONLY_KEYS as readonly string[]).includes(k),
          )
        )
          errors.push(
            `${c}: presentation absent changes more than identity-only keys`,
          );
        if (
          absent.expect.state !== base.expect.state ||
          (absent.expect.actions ?? []).join() !==
            (base.expect.actions ?? []).join()
        )
          errors.push(
            `${c}: presentation absent changes the state or the actions`,
          );
      }
    }
    for (const s of SERVICE_DEPENDENCIES[c] ?? [])
      if (!offPairs.has(`${c}:${s}`))
        errors.push(`${c}: no row turns ${s} off (D5)`);
    if (MUST_NOT[c] && !mustNotSeen.has(c))
      errors.push(`${c}: no negative row for "${MUST_NOT[c]}"`);
  }
  for (const where of LOADING_DELAY.states) {
    const [c, st] = where.split(".");
    if (!S.components[c!]?.states[st!])
      errors.push(`LOADING_DELAY ${where}: not a components.json state`);
    for (const side of ["before", "past"])
      if (!delayedSeen.has(`${where}:${side}`))
        errors.push(`${where}: no row ${side} the DL7 delay`);
  }
  for (const lane of ["inline", "sheet", "browser", "device-code"])
    for (const issued of ["true", "false"])
      if (!endings.has(`${lane}:${issued}`))
        errors.push(
          `signIn: no ${lane} ending with issuedNow ${issued} (§4.5)`,
        );
  const first = doc.signIn?.find((r) => r.name === "first-automatic-license");
  if (!first || "choices" in first.input || first.expect.state !== "done")
    errors.push(
      `signIn: the first-automatic-license row (I-27 D4) is missing or reaches a choice`,
    );

  // theme.
  const themeNames = new Set<string>();
  for (const t of doc.theme ?? []) {
    const where = `theme "${t.name}"`;
    if (themeNames.has(t.name)) errors.push(`${where}: duplicate name`);
    themeNames.add(t.name);
    if (!(KITS as readonly string[]).includes(t.input.kit as string))
      errors.push(`${where}: kit ${String(t.input.kit)}`);
    const e = t.expect;
    if (!(ACCENT_SOURCES as readonly string[]).includes(e.accentSource))
      errors.push(`${where}: accentSource`);
    if (!(COLOR_SCHEMES as readonly string[]).includes(e.colorScheme))
      errors.push(`${where}: colorScheme`);
    if (!(ICONS as readonly string[]).includes(e.icon))
      errors.push(`${where}: icon`);
    if (!(PRESETS as readonly string[]).includes(e.preset))
      errors.push(`${where}: preset`);
    if (JSON.stringify(resolveTheme(t.input)) !== JSON.stringify(e))
      errors.push(`${where}: expectation is not the resolution order's`);
  }
  for (const kit of KITS)
    for (const preset of PRESETS)
      if (
        !(doc.theme ?? []).some(
          (t) =>
            t.input.kit === kit && (t.input.preset ?? "polaris-key") === preset,
        )
      )
        errors.push(`theme: no ${kit} row under ${preset}`);
  for (const src of ACCENT_SOURCES)
    if (!(doc.theme ?? []).some((t) => t.expect.accentSource === src))
      errors.push(`theme: no row resolves to ${src}`);

  // i18n.
  for (const t of doc.i18n ?? []) {
    const message = refLookup(S, t.locale, t.key, t.overrides);
    if (message === undefined)
      errors.push(`i18n "${t.name}": no table has ${t.key}`);
  }
  for (const locale of LOCALES)
    for (const cat of pluralCategories(locale))
      if (
        !(doc.i18n ?? []).some(
          (t) =>
            t.name.startsWith(`${locale}: `) &&
            t.name.endsWith(`plural ${cat}`),
        )
      )
        errors.push(`i18n: ${locale} has no row for plural ${cat}`);
  for (const ff of FORM_FACTORS)
    if (!(doc.i18n ?? []).some((t) => t.args.formFactor === ff))
      errors.push(`i18n: no row for formFactor ${ff}`);

  // Declared gaps: each names its owner and its reason.
  const gaps = (doc.vocabulary.gaps ?? []) as Obj[];
  if (!Array.isArray(gaps)) errors.push("vocabulary.gaps: not a list");
  else
    for (const g of gaps) {
      for (const k of ["id", "what", "why", "then"])
        if (typeof g[k] !== "string" || !(g[k] as string).trim())
          errors.push(`vocabulary.gaps ${String(g.id)}: no ${k}`);
      if (
        !/^[A-Z][A-Za-z0-9]*-(?:[A-Z][0-9]{1,2}|[0-9]{2})[a-z]?$/.test(
          String(g.owner),
        )
      )
        errors.push(
          `vocabulary.gaps ${String(g.id)}: owner ${String(g.owner)} is not a work package id`,
        );
    }

  // No control character in any string (the file is written ASCII-escaped, so nothing else can
  // reach a runner that reads it as bytes).
  const walk = (v: unknown, at: string): void => {
    // eslint-disable-next-line no-control-regex
    if (typeof v === "string" && /[\u0000-\u001f\u007f]/.test(v))
      errors.push(`${at}: a control character`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (isObj(v))
      for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
  };
  walk(doc, "ui-matrix.json");
  errors.push(...checkCli(doc.cli, S));
  errors.push(...checkCloudSync(doc, S));
  errors.push(...checkSaveConflict(doc, S));
  errors.push(...checkHolders(doc, S));
  errors.push(...checkConnect(doc, S));
  errors.push(...checkLocal(doc, S));
  errors.push(...checkNearby(doc, S));
  return errors;
}

/** The default row a presentation-absent row twins: the component's row with the same input apart
 *  from identity, and no identity of its own. */
function defaultRowOf(
  doc: UiMatrix,
  component: string,
  absent: Row,
): Row | undefined {
  const strip = (input: Obj): string => {
    const rest: Obj = { ...input };
    delete rest.presentation;
    delete rest.bundle;
    delete rest.integrator;
    return JSON.stringify(rest);
  };
  for (const family of COMPONENT_FAMILIES)
    for (const r of doc[family])
      if (
        r !== absent &&
        r.expect.component === component &&
        strip(r.input) === strip(absent.input) &&
        r.input.presentation === undefined
      )
        return r;
  return undefined;
}

// ── Build ───────────────────────────────────────────────────────────────────────────────────

const DESCRIPTION = [
  "The UI state matrix (plans/UK-02.md §4, plans/UK-02b.md): layer (c) of every UI kit, pinned once for every language.",
  "Component rows: drive the headless model of expect.component with input (a member input omits takes vocabulary.defaults) and compare state, the sorted copy keys and the sorted actions (absent means none).",
  "A state is a components.json state of the component, or hidden: the drop-in renders nothing and a styled part renders empty; hidden appears only on rows that turn a service off.",
  "copy lists the keys this input shows: a subset of the state's components.json list plus core.* keys the input selects (D7); vocabulary.unreached names the listed keys no row can show yet.",
  "actions are the controls the copy names (vocabulary.actionKeys) plus replace-in-browser.",
  "vocabulary.gaps declares the variants not pinned yet, each with the work package that appends its rows.",
  "mustNot marks a negative case (UI-KITS §4.1): the expectation holds and none of its states, copy or actions appear.",
  "Inline sign-in rows have a sheet twin with the same expectation (D4); each must component has a presentation-absent twin of its default row (D6).",
  "theme rows pin UI-KITS §1.2 and §3.4's resolution; i18n rows the catalog lookup (the locale's override, the locale's table, the English override, English; a locale with no pack is English, and a pending core pack is English core copy) and the ICU subset, where # is the integer in plain ASCII digits (expect is computed by the generator's own formatter).",
  "vocabulary.loadingDelay pins DL7's delayed response: a row whose input has elapsedMs below min expects its loading state with no copy; from max, the state's usual copy.",
  "cli is the terminal drop-in contract (plans/UK-51.md), one object rather than component rows: verbs (the end-user set a mount offers, the developer verbs it offers only by name, the aliases), mount and help (what registering into a host CLI mounts, refuses with polaris-verb-collision, skips, hides and lists), gate (every licenseStatus x tty x json x entitled: run, the inline flow, or a refusal that is a triangle with its fix and exits 4), outcomes (a kit verb in a vocabulary.cli.situations situation: its mark, exit, result fields, stdout and fix verbs), stdin (what activate with no key reads, per vocabulary.cli.stdinKinds), capabilities (environment x streams x flags) and exit (the exit table). vocabulary.cli holds the rules; mount, help, gate and capabilities are computed by the generator's references.",
  "Every runner runs every row of every family; a row a natural model fails goes back as a bug against the row or the model. Append-only within a uiMatrixVersion: a changed row, input member or rule bumps it.",
].join(" ");

export function buildUiMatrix(
  S: UiMatrixSources = loadUiMatrixSources(),
): UiMatrix {
  const a = authoring(S);
  const families: Record<ComponentFamily, Draft[]> = {
    gate: gateFamily(a),
    activate: activateFamily(a),
    signIn: signInFamily(a),
    deviceLimit: deviceLimitFamily(a),
    devices: devicesFamily(a),
    update: updateFamily(a),
    settings: settingsFamily(a),
    paywall: paywallFamily(a),
  };
  const out = {} as Record<ComponentFamily, Row[]>;
  const delayed = new Set<string>();
  for (const family of COMPONENT_FAMILIES) {
    const drafts: Draft[] = [];
    for (const d of families[family]) {
      drafts.push(d);
      const key = `${d.expect.component}.${d.expect.state}`;
      if (
        (LOADING_DELAY.states as readonly string[]).includes(key) &&
        !delayed.has(key) &&
        d.input.services === undefined
      ) {
        delayed.add(key);
        drafts.push(...delayTwins(d));
      }
    }
    const withAbsent: Draft[] = [];
    for (const d of drafts) {
      withAbsent.push(d);
      if (d.isDefault) withAbsent.push(absentTwin(d));
    }
    const withSheets: Draft[] = [];
    for (const d of withAbsent) {
      withSheets.push(d);
      if ((d.input.signIn as Obj | undefined)?.presentation === "inline")
        withSheets.push(sheetTwin(d));
    }
    out[family] = withSheets.map(finish);
  }
  const doc: UiMatrix = {
    uiMatrixVersion: UI_MATRIX_VERSION,
    description: DESCRIPTION,
    vocabulary: {
      actions: ACTIONS as Obj,
      actionKeys: Object.fromEntries(
        Object.entries(ACTION_KEYS).map(([k, v]) => [k, [...v]]),
      ),
      inputs: INPUTS,
      defaults: DEFAULTS,
      precedence: PRECEDENCE,
      services: S.services.map((s) => ({ slug: s.slug, requires: s.requires })),
      serviceDependencies: Object.fromEntries(
        Object.entries(SERVICE_DEPENDENCIES).map(([k, v]) => [k, [...v]]),
      ),
      identityOnlyKeys: [...IDENTITY_ONLY_KEYS],
      mustNot: MUST_NOT as Obj,
      unreached: UNREACHED as unknown as Obj,
      gaps: GAPS.map((g) => ({ ...g })),
      loadingDelay: {
        min: LOADING_DELAY.min,
        max: LOADING_DELAY.max,
        states: [...LOADING_DELAY.states],
      },
      kits: [...KITS],
      platforms: [...MUST_OS],
      formFactors: [...FORM_FACTORS],
      presentations: [...PRESENTATIONS],
      replaceModes: [...REPLACE_MODES],
      channels: [...CHANNELS],
      outcomes: [...OUTCOMES],
      events: [...EVENTS],
      deviceCodePhases: [...DEVICE_CODE_PHASES],
      registration: [...REGISTRATION],
      pending: [...PENDING],
      edits: [...EDITS],
      toasts: [...TOASTS],
      progressPhases: [...PROGRESS_PHASES],
      accentSources: [...ACCENT_SOURCES],
      colorSchemes: [...COLOR_SCHEMES],
      icons: [...ICONS],
      presets: [...PRESETS],
      locales: [...LOCALES],
      cli: CLI_VOCABULARY as unknown as Obj,
    },
    ...out,
    cloudSync: cloudSyncFamily(a).map(finish),
    saveConflict: saveConflictFamily(a).map(finish),
    holders: holdersFamily(a).map(finish),
    holdersFlow: holdersFlow(),
    connect: connectFamily(a).map(finish),
    local: localFamily(a).map(finish),
    localLayout: localLayoutRows(),
    nearby: nearbyFamily(a).map(finish),
    theme: themeRows(),
    i18n: i18nRows(S),
    cli: cliFamily(),
  };
  const errors = checkUiMatrix(doc, S);
  if (errors.length > 0)
    throw new Error(`ui-matrix.json is invalid:\n  ${errors.join("\n  ")}`);
  return doc;
}
