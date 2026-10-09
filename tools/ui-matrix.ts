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
// `uiMatrixVersion` 1: a new row keeps the version; a changed row, input member or rule bumps it
// (plans/UK-02b.md §4.8).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UI_MATRIX_VERSION = 1;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Types ───────────────────────────────────────────────────────────────────────────────────

type J = null | boolean | number | string | J[] | { [k: string]: J };
type Obj = { [k: string]: J };

export interface Expect {
  component: string;
  state: string;
  copy: string[];
  actions?: string[];
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
  theme: ThemeRow[];
  i18n: I18nRow[];
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
  /** core.* strings per locale, from conformance/parity/copy.<locale>.json (absent: pending). */
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
      continue; // a pending pack (copy.fr.json is SP-03's): the tables fall back to English
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
  "copy-link": "Copy the sign-in link or the address to the clipboard.",
  retry:
    "Repeat the step that failed or lapsed (Try again, Reconnect, Sign in again, Get a new code).",
  cancel: "Leave the step or the flow (Cancel).",
};

/** The copy keys whose control is each action (UI-KITS §4.1: copy matches controls). */
export const ACTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  "open-card": ["signin.desktop.continue", "signin.email.continue"],
  "open-browser": ["signin.handoff.again", "signin.handoff.openBrowser"],
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
  keyField:
    "The license key field: {text, submitted?}. A key is `pkey_<slug>_` and a 22-character secret.",
  activation:
    "An activation result: {result: activationResult, code?, limit?, deviceCount?, manageUrl?}.",
  offline:
    "Offline activation: {copied?, file?, submitted?, verified?} (the request code copied, a response loaded, submitted, its signature verified).",
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
  offers: "{available, purchased?}.",
  toast: "{kind}: the toast being shown.",
  error: "{code}: a core.codes code the step failed with.",
};

/** The precedence a model applies where several states could hold (authoring notes, pinned by
 *  the rows). */
const PRECEDENCE: Record<string, string> = {
  LicenseChoice:
    "loading, grant-expired, raced, replace-open (open-replace with replace inline), none-keys or none-no-keys (state none), new (state autoIssue), create (create selected), all-full (no free row), keep, current, mixed (account and seat licences together), one, many.",
  SignIn:
    "error, expired, done (signedIn), key (have-key while choosing), replace (open-replace with replace inline), choose, finishing (redeeming, or device-code ok), code (device code, or use-code), handoff (pending), methods.",
  Settings:
    "loading, error, saving (pending save or saved), dirty, locked (a locked row), list.",
  Devices:
    "loading, error, browser-mode, renaming or confirming (edit), empty, list.",
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
}

interface Opts {
  default?: true;
  actions?: string[];
  mustNot?: Omit<MustNot, "invariant"> & { invariant?: string };
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

const KEY = "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhp"; // a 22-character secret
const MANAGE_URL =
  "https://key.plrs.im/#/p/tidewater/free-device?license=lic_pro&for=MacBook%20Pro";
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
  "https://key.plrs.im/#/p/tidewater/free-device?license=lic_edu&for=MacBook%20Pro&return=/signin?request=req_tidewater";
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
  activateUrl: "https://key.plrs.im/activate?product=tidewater",
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
  const { row, all, hidden, off } = a;
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
      { default: true },
    ),
    row(
      "StatusScreen/expired",
      { gate: { status: "expired" } },
      "StatusScreen",
      "expired",
      "all",
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
      "all",
      { default: true },
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
      ["part.keyField.malformed"],
    ),
    row(
      "Activate/rejected: submitted empty",
      { keyField: { text: "", submitted: true } },
      "Activate",
      "rejected",
      ["part.keyField.empty"],
    ),
    row(
      "Activate/rejected: the license is disabled",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "license-disabled" },
      },
      "Activate",
      "rejected",
      [
        "core.activation.license-disabled.title",
        "core.activation.license-disabled.message",
      ],
    ),
    row(
      "Activate/rejected: another account holds the license",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "refused", code: "license_owned" },
      },
      "Activate",
      "rejected",
      ["core.codes.license_owned.title", "core.codes.license_owned.message"],
    ),
    row(
      "Activate/rejected: the key-entry limit",
      {
        keyField: { text: KEY, submitted: true },
        activation: { result: "key-entry-limit" },
      },
      "Activate",
      "rejected",
      [
        "core.activation.key-entry-limit.title",
        "core.activation.key-entry-limit.message",
      ],
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
      "OfflineActivation/loaded: the request code was copied",
      { capabilities: { offlineActivation: true }, offline: { copied: true } },
      "OfflineActivation",
      "loaded",
      ["offlineActivation.submit", "offlineActivation.codeCopied"],
    ),
    row(
      "OfflineActivation/loaded: a loaded file is not yet an activation",
      { capabilities: { offlineActivation: true }, offline: { file: true } },
      "OfflineActivation",
      "loaded",
      ["offlineActivation.submit"],
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
      ["offlineActivation.submit", "offlineActivation.empty"],
    ),
    row(
      "OfflineActivation/rejected-signature",
      {
        capabilities: { offlineActivation: true },
        offline: { file: true, submitted: true, verified: false },
      },
      "OfflineActivation",
      "rejected-signature",
      "all",
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
      "SignIn/key: another account holds the key's license",
      lc(
        VIEW_MANY,
        { activation: { result: "refused", code: "license_owned" } },
        { event: "have-key" },
      ),
      "SignIn",
      "key",
      "all",
    ),

    // Step 4 (§4.5: how the form ends; sheet rows are the inline rows' twins).
    row(
      "first-automatic-license",
      { signIn: si({ outcome: "signedIn", issuedNow: true }) },
      "SignIn",
      "done",
      issued,
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
        "a11y.qr",
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
      "all",
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
      "all",
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
      "all",
      {
        mustNot: { states: ["offers", "purchasing"] },
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
  const actions = actionsFor(copy, d.extraActions);
  const out: Row = {
    name: d.name,
    input: d.input,
    expect: {
      component: d.expect.component,
      state: d.expect.state,
      copy,
      ...(actions.length > 0 ? { actions } : {}),
    },
  };
  if (d.mustNot) {
    const m: MustNot = { invariant: d.mustNot.invariant };
    for (const k of ["states", "copy", "actions"] as const)
      if (d.mustNot[k]?.length) m[k] = [...d.mustNot[k]!].sort();
    out.mustNot = m;
  }
  return out;
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

// ── Checks (plans/UK-02b.md §4.7, UK-02 §4) ─────────────────────────────────────────────────

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
            ? ["signin.done.start", "signin.return.signedInShort"]
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
        if (m.invariant !== MUST_NOT[component])
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
  "mustNot marks a negative case (UI-KITS §4.1): the expectation holds and none of its states, copy or actions appear.",
  "Inline sign-in rows have a sheet twin with the same expectation (D4); each must component has a presentation-absent twin of its default row (D6).",
  "theme rows pin UI-KITS §1.2 and §3.4's resolution; i18n rows the catalog lookup (the locale's override, the locale's table, the English override, English; a locale with no pack is English, and a pending core pack is English core copy) and the ICU subset, where # is the integer in plain ASCII digits (expect is computed by the generator's own formatter).",
  "Every runner runs every row of every family; a row a natural model fails goes back as a bug against the row or the model. Append-only within uiMatrixVersion 1: a changed row, input member or rule bumps it.",
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
  for (const family of COMPONENT_FAMILIES) {
    const drafts = families[family];
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
    },
    ...out,
    theme: themeRows(),
    i18n: i18nRows(S),
  };
  const errors = checkUiMatrix(doc, S);
  if (errors.length > 0)
    throw new Error(`ui-matrix.json is invalid:\n  ${errors.join("\n  ")}`);
  return doc;
}
