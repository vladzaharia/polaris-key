// The kit copy catalog generator (plans/UK-02.md §3.1–§3.3, UK-02a). Called by gen.ts, so
// `pnpm gen:brand` writes these outputs and `pnpm gen:brand -- --check` is their drift gate.
//
// Sources (hand-written, each with a JSON Schema beside it):
//   packages/brand/kit-copy/en.json             every kit string: {value, role, note, variants?}
//   packages/brand/kit-copy/<locale>.json       the eight launch packs, values only, reviewed: false
//   packages/brand/kit-copy/glossary.json       fixed translations of the product vocabulary
//   packages/brand/kit-copy/components.json     each UI-KITS §4.1 component's states and copy keys
//   conformance/parity/copy.<locale>.json       the core copy (SP-00), read here as core.* keys
//
// Outputs (one lookup table per platform, kit keys plus core.* keys, D2/D3):
//   web     packages/brand/src/generated/kit-copy/<locale>.json + index.ts
//   Node    packages/sdk-node/src/kitCopy.generated.ts
//   Swift   sdks/swift/Sources/PolarisKeyUI/Resources/Localizable.xcstrings
//   Kotlin  sdks/kotlin/ui/src/commonMain/composeResources/values{,-<q>}/strings.xml
//   Godot   sdks/godot/addons/polaris_key/ui/locale/polaris_key_ui.pot + <locale>.po
//   Python  sdks/python/src/polaris_key/ui/kit_copy_generated.py + ui/locale/polaris_key_ui.pot
//
// The ICU subset (D5, tightened here so every target can express it without a runtime ICU
// library): plain `{arg}` arguments; at most one complex argument per message, either
// `{n, plural, …}` on an integer argument with exactly the locale's CLDR categories, or
// `{formFactor, select, …}` with exactly the form-factor cases; no nesting; plural case text holds
// `#` and literal text only (plain arguments stay outside the plural), select case text may hold
// plain arguments. No `%`, no apostrophe quoting, no literal braces, no control characters.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020Module from "ajv/dist/2020.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(PKG, "..", "..");

// ── Constants ───────────────────────────────────────────────────────────────────────────────

/** The launch locales (UI-KITS owner decisions, 2026-10-05). English first; it is the source. */
export const KIT_LOCALES = [
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
export type KitLocale = (typeof KIT_LOCALES)[number];

/**
 * Core copy packs another package owns and has not landed yet: the kit tables fall back to the
 * English core copy for these locales until the pack exists (plans/UK-02.md D4: copy.fr.json is
 * SP-03's). Any other missing core pack fails the generator.
 */
export const CORE_PACK_PENDING: Readonly<Record<string, string>> = {
  fr: "SP-03",
};

export const ROLES = [
  "title",
  "body",
  "label",
  "button",
  "menu",
  "windowTitle",
  "a11y",
  "hint",
] as const;
export type Role = (typeof ROLES)[number];

export const VARIANT_PLATFORMS = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
  "godot",
  "terminal",
  "tv",
] as const;
export type VariantPlatform = (typeof VARIANT_PLATFORMS)[number];

/** Roles that may carry platform variants (the verb or the casing, UI-KITS §4.7). */
const VARIANT_ROLES: readonly Role[] = ["button", "menu", "windowTitle"];

/** First key segments: a §4.1 component, a shared group, or SIGN-IN.md's signin namespace. */
export const KEY_NAMESPACES = [
  "gate",
  "boot",
  "welcome",
  "signIn",
  "signInHandoff",
  "activate",
  "offlineActivation",
  "deviceLimit",
  "devices",
  "update",
  "updateProgress",
  "releaseNotes",
  "status",
  "grace",
  "account",
  "settings",
  "paywall",
  "entitlement",
  "cloudSync",
  "about",
  "channel",
  "toast",
  "part",
  "common",
  "a11y",
  "signin",
] as const;

/** Namespaces whose keys need not be listed by a component state (parts and shared groups). */
const SHARED_NAMESPACES = new Set(["part", "common", "a11y", "signin"]);

/** The §4.1 component names, exactly. */
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

/** ui-matrix.json families (plans/UK-02.md §3.5) a component may name. */
const FAMILIES = new Set([
  "gate",
  "activate",
  "signIn",
  "deviceLimit",
  "devices",
  "update",
  "settings",
  "paywall",
]);

/** Pre-formatted string arguments: the plan's closed set plus the SIGN-IN.md §5.2 arguments. */
export const STRING_ARGS = [
  // plans/UK-02.md §3.1
  "product",
  "device",
  "time",
  "date",
  "version",
  "size",
  "total",
  "org",
  "method",
  "store",
  "min",
  "max",
  // SIGN-IN.md §5.2 and the kit values that feed it
  "app",
  "developer",
  "provider",
  "code",
  "email",
  "place",
  "name",
  "origin",
  "term",
  "license",
  "position",
  "thisDevice",
  "newDevice",
  "platform",
  "when",
  "url",
  "identity",
  "tier",
  "command",
  "idp",
  "host",
  "prefix",
  "s",
] as const;

/** Integer arguments: the only ones a plural may select on (they may also appear plain). */
export const PLURAL_ARGS = [
  "count",
  "days",
  "minutes",
  "used",
  "limit",
  "seconds",
  "left",
  "n",
] as const;

/** The formFactor select's cases, all required. */
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

const CLDR_ORDER = ["zero", "one", "two", "few", "many", "other"] as const;

/** English values must not use these (S-19 and AGENTS rule 4: license, device, tier). */
const BANNED_EN = /\b(licences?|grants?|retry|machines?|plans?)\b/i;

const KEY_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const STATE_PATTERN = /^[a-z]+(-[a-z]+)*$/;
const BRAND = "Polaris Key";

/** D13: words macOS title case leaves lower case unless first or last. */
/** D13: a particle after one of these verbs is part of a phrasal verb and keeps its capital ("Sign In"). */
const PHRASAL_VERBS = new Set(
  "sign log check set opt back turn look start try".split(" "),
);
const PARTICLES = new Set(["in", "out", "up", "on", "off"]);
const SMALL_WORDS = new Set(
  "a an and as at but by for from in into nor of on or per the to via vs with".split(
    " ",
  ),
);

// ── Source types ────────────────────────────────────────────────────────────────────────────

export interface EnMessage {
  value: string;
  role: Role;
  note: string;
  variants?: Partial<Record<VariantPlatform, string>>;
}
export interface EnCatalog {
  $schema?: string;
  $comment?: string;
  kitCopyVersion: 1;
  locale: "en";
  messages: Record<string, EnMessage>;
}
export interface LocalePack {
  $schema?: string;
  $comment?: string;
  kitCopyVersion: 1;
  locale: string;
  reviewed: boolean;
  glossaryVersion: number;
  messages: Record<string, string>;
}
export interface Glossary {
  $schema?: string;
  $comment?: string;
  glossaryVersion: number;
  neverTranslate: string[];
  terms: Record<string, Record<string, string>>;
}
export interface ComponentsDoc {
  $schema?: string;
  $comment?: string;
  componentsVersion: 1;
  components: Record<
    string,
    {
      priority: "must" | "should" | "could";
      family: string | null;
      states: Record<string, { copy: string[] }>;
    }
  >;
}
interface CoreEntry {
  title: string;
  message: string;
}
export interface CoreCopy {
  locale: string;
  reviewed?: boolean;
  fallback: CoreEntry;
  codes: Record<string, CoreEntry>;
  gate: Record<string, CoreEntry>;
  activation: Record<string, CoreEntry>;
}

export interface KitCopySources {
  en: EnCatalog;
  packs: Record<string, LocalePack>;
  glossary: Glossary;
  components: ComponentsDoc;
  /** Core copy by locale; English is required, a pending pack may be absent. */
  core: Record<string, CoreCopy>;
}

// ── ICU subset ──────────────────────────────────────────────────────────────────────────────

/** A run of a message: literal text, a plain argument, or (in plural cases) the number. */
export type Piece = { text: string } | { arg: string } | { hash: true };

export interface ParsedMessage {
  /** Pieces before the complex argument (or the whole message when there is none). */
  head: Piece[];
  complex?: {
    arg: string;
    kind: "plural" | "select";
    cases: Record<string, Piece[]>;
  };
  /** Pieces after the complex argument. */
  tail: Piece[];
}

/** Parse one message in the subset. Throws a readable error outside it. */
export function parseMessage(src: string): ParsedMessage {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`${why} at ${i} in ${JSON.stringify(src)}`);
  };
  const readPieces = (inCase: "plural" | "select" | null): Piece[] => {
    const out: Piece[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ text });
      text = "";
    };
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "}") break;
      if (ch === "#" && inCase === "plural") {
        flush();
        out.push({ hash: true });
        i++;
        continue;
      }
      if (ch === "{") {
        const m = /^\{([A-Za-z][A-Za-z0-9]*)(\}|,)/.exec(src.slice(i));
        if (!m) fail("expected an argument name after {");
        if (m![2] === ",") {
          // A complex argument: only allowed at the top level, handled by the caller.
          if (inCase !== null) fail("a plural or select cannot nest");
          break;
        }
        if (inCase === "plural")
          fail("a plural case may hold # and text only, not {" + m![1] + "}");
        flush();
        out.push({ arg: m![1]! });
        i += m![0].length;
        continue;
      }
      if (ch === "'" && /['{}#]/.test(src[i + 1] ?? ""))
        fail("ICU apostrophe quoting is not allowed");
      text += ch;
      i++;
    }
    flush();
    return out;
  };
  const head = readPieces(null);
  if (i >= src.length) return { head, tail: [] };
  if (src[i] === "}") fail("unbalanced }");
  // complex argument
  const m = /^\{([A-Za-z][A-Za-z0-9]*), *([a-z]+) *(,|\})/.exec(src.slice(i));
  if (!m) fail("malformed complex argument");
  const [whole, arg, kind] = m!;
  if (kind !== "plural" && kind !== "select")
    fail(`ICU type "${kind}" is outside the subset (plural and select only)`);
  if (m![3] !== ",") fail("a plural or select needs cases");
  i += whole.length;
  const cases: Record<string, Piece[]> = {};
  for (;;) {
    while (src[i] === " ") i++;
    if (src[i] === "}") {
      i++;
      break;
    }
    const cm = /^([A-Za-z0-9=:]+) *\{/.exec(src.slice(i));
    if (!cm) fail("expected a case name and {");
    const name = cm![1]!;
    if (!/^[a-z]+$/.test(name))
      fail(`case "${name}" is outside the subset (no offsets or =N cases)`);
    if (name in cases) fail(`duplicate case "${name}"`);
    i += cm![0].length;
    cases[name] = readPieces(kind as "plural" | "select");
    if (src[i] !== "}") fail("unclosed case");
    i++;
  }
  const tail = readPieces(null);
  if (i < src.length) fail("only one plural or select per message");
  return {
    head,
    complex: { arg: arg!, kind: kind as "plural" | "select", cases },
    tail,
  };
}

/** Every argument a parsed message names (the complex one included), in first-seen order. */
export function messageArgs(p: ParsedMessage): string[] {
  const seen: string[] = [];
  const visit = (pieces: Piece[]) => {
    for (const x of pieces)
      if ("arg" in x && !seen.includes(x.arg)) seen.push(x.arg);
  };
  visit(p.head);
  if (p.complex) {
    if (!seen.includes(p.complex.arg)) seen.push(p.complex.arg);
    for (const c of Object.values(p.complex.cases)) visit(c);
  }
  visit(p.tail);
  return seen;
}

/** The plural categories a locale uses, in CLDR order. */
export function pluralCategories(locale: string): string[] {
  const got = new Set(
    new Intl.PluralRules(locale).resolvedOptions().pluralCategories as string[],
  );
  return CLDR_ORDER.filter((c) => got.has(c));
}

/** The whole-string text of one case: head + case + tail, with `#` written by `hash`. */
export function expandCase(
  p: ParsedMessage,
  caseName: string | null,
  render: (piece: Piece) => string,
): string {
  const pieces = [
    ...p.head,
    ...(p.complex && caseName !== null ? p.complex.cases[caseName]! : []),
    ...p.tail,
  ];
  return pieces.map(render).join("");
}

// ── Reference formatter ─────────────────────────────────────────────────────────────────────

/** A flat table for one locale: kit keys and core.* keys, ICU-subset strings. */
export type KitTable = Record<string, string>;

/**
 * Format one message the way every kit must: plain arguments substituted, the plural case picked
 * by Intl.PluralRules(locale) with `#` as the integer, the select case picked by `formFactor`
 * (unknown values take `other`). A missing argument stays as `{name}` so the gap is visible.
 */
export function formatMessage(
  locale: string,
  message: string,
  args: Record<string, string | number> = {},
): string {
  const p = parseMessage(message);
  const plain = (x: Piece): string =>
    "text" in x
      ? x.text
      : "arg" in x
        ? args[x.arg] !== undefined
          ? String(args[x.arg])
          : `{${x.arg}}`
        : String(args[p.complex!.arg] ?? "#");
  if (!p.complex) return expandCase(p, null, plain);
  const v = args[p.complex.arg];
  let caseName: string;
  if (p.complex.kind === "plural") {
    const n = typeof v === "number" ? v : Number(v);
    caseName = new Intl.PluralRules(locale).select(n);
    if (!(caseName in p.complex.cases)) caseName = "other";
  } else {
    caseName = typeof v === "string" && v in p.complex.cases ? v : "other";
  }
  return expandCase(p, caseName, plain);
}

/**
 * Look a key up the way every kit must (UI-KITS §4.7): the integrator's override for the locale,
 * then the locale's table, then the English override, then English. Returns undefined only for a
 * key no table has.
 */
export function lookup(
  tables: Record<string, KitTable>,
  locale: string,
  key: string,
  overrides: Record<string, Partial<KitTable>> = {},
): string | undefined {
  return (
    overrides[locale]?.[key] ??
    tables[locale]?.[key] ??
    overrides.en?.[key] ??
    tables.en?.[key]
  );
}

/** D13: English macOS title case for a button, menu or window title. */
export function titleCase(value: string): string {
  const words = value.split(" ");
  return words
    .map((w, idx) => {
      if (w.startsWith("{") || /^[a-z]+[A-Z]/.test(w)) return w; // argument or iPhone-style
      const lower = w.toLowerCase();
      const edge = idx === 0 || idx === words.length - 1;
      const bare = lower.replace(/[^a-z]/g, "");
      const phrasal =
        PARTICLES.has(bare) &&
        PHRASAL_VERBS.has((words[idx - 1] ?? "").toLowerCase());
      if (!edge && !phrasal && SMALL_WORDS.has(bare)) return lower;
      return w
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("-");
    })
    .join(" ");
}

// ── Loading ─────────────────────────────────────────────────────────────────────────────────

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

function schemaErrors(schemaPath: string, data: unknown): string[] {
  const Ajv2020 =
    (Ajv2020Module as unknown as { default?: unknown }).default ??
    Ajv2020Module;
  const ajv = new (Ajv2020 as new (opts: object) => {
    compile(schema: unknown): ((data: unknown) => boolean) & {
      errors?: { instancePath: string; message?: string }[] | null;
    };
  })({ allErrors: true, strict: false });
  const validate = ajv.compile(readJson(schemaPath));
  return validate(data)
    ? []
    : (validate.errors ?? []).map(
        (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`,
      );
}

/** Read every source from a checkout, schema-checked. Throws with every schema error. */
export function loadKitCopySources(
  root = REPO_ROOT,
  opts: { partial?: boolean; only?: string } = {},
): KitCopySources {
  const dir = join(root, "packages", "brand", "kit-copy");
  const parity = join(root, "conformance", "parity");
  const errors: string[] = [];
  const load = <T>(file: string, schema: string): T => {
    const data = readJson(join(dir, file));
    for (const e of schemaErrors(join(dir, schema), data))
      errors.push(`kit-copy/${file}: ${e}`);
    return data as T;
  };
  const en = load<EnCatalog>("en.json", "kit-copy.schema.json");
  const packs: Record<string, LocalePack> = {};
  for (const locale of KIT_LOCALES.slice(1)) {
    if (opts.only && opts.only !== locale) continue;
    try {
      packs[locale] = load<LocalePack>(
        `${locale}.json`,
        "kit-copy-locale.schema.json",
      );
    } catch (err) {
      if (!opts.partial)
        errors.push(`kit-copy/${locale}.json: ${(err as Error).message}`);
    }
  }
  const strays = readdirSync(dir).filter(
    (f) =>
      f.endsWith(".json") &&
      !f.endsWith(".schema.json") &&
      !["glossary.json", "components.json"].includes(f) &&
      !(KIT_LOCALES as readonly string[]).includes(f.replace(/\.json$/, "")),
  );
  for (const f of strays)
    errors.push(
      `kit-copy/${f}: not a launch locale (${KIT_LOCALES.join(", ")})`,
    );
  const glossary = load<Glossary>("glossary.json", "glossary.schema.json");
  const components = load<ComponentsDoc>(
    "components.json",
    "components.schema.json",
  );
  const core: Record<string, CoreCopy> = {};
  for (const locale of KIT_LOCALES) {
    let doc: CoreCopy;
    try {
      doc = readJson(join(parity, `copy.${locale}.json`)) as CoreCopy;
    } catch {
      if (locale in CORE_PACK_PENDING || opts.partial) continue;
      errors.push(
        `conformance/parity/copy.${locale}.json is missing (plans/UK-02.md D4)`,
      );
      continue;
    }
    core[locale] = doc;
  }
  if (errors.length > 0)
    throw new Error(
      `the kit copy sources are invalid:\n  ${errors.join("\n  ")}`,
    );
  return { en, packs, glossary, components, core };
}

// ── Checks (plans/UK-02.md §3.2) ────────────────────────────────────────────────────────────

/** The core.* table for one locale (the English one when the locale's pack is pending). */
export function coreTable(src: KitCopySources, locale: string): KitTable {
  const doc = src.core[locale] ?? src.core.en;
  if (!doc) throw new Error("conformance/parity/copy.en.json is missing");
  const out: KitTable = {
    "core.fallback.title": doc.fallback.title,
    "core.fallback.message": doc.fallback.message,
  };
  for (const section of ["codes", "gate", "activation"] as const)
    for (const [k, e] of Object.entries(doc[section])) {
      out[`core.${section}.${k}.title`] = e.title;
      out[`core.${section}.${k}.message`] = e.message;
    }
  return out;
}

function checkText(where: string, value: string): string[] {
  const errors: string[] = [];
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value))
    errors.push(`${where}: control character or tab (terminal safety)`);
  if (value.includes("%"))
    errors.push(
      `${where}: "%" is not allowed (it is a format character on Swift and Kotlin)`,
    );
  if (value !== value.trim())
    errors.push(`${where}: leading or trailing space`);
  return errors;
}

interface ArgShape {
  args: Map<string, "string" | "plural" | "select">;
  categories?: string[];
}

function shapeOf(
  where: string,
  value: string,
  locale: string,
  errors: string[],
): ArgShape | undefined {
  let p: ParsedMessage;
  try {
    p = parseMessage(value);
  } catch (err) {
    errors.push(`${where}: ${(err as Error).message}`);
    return undefined;
  }
  const args = new Map<string, "string" | "plural" | "select">();
  for (const a of messageArgs(p)) args.set(a, "string");
  let categories: string[] | undefined;
  if (p.complex) {
    const { arg, kind, cases } = p.complex;
    args.set(arg, kind);
    const names = Object.keys(cases);
    if (kind === "plural") {
      if (!(PLURAL_ARGS as readonly string[]).includes(arg))
        errors.push(
          `${where}: plural on {${arg}}, which is not an integer argument (${PLURAL_ARGS.join(", ")})`,
        );
      const want = pluralCategories(locale);
      if (names.length !== want.length || !want.every((c) => names.includes(c)))
        errors.push(
          `${where}: plural categories ${names.join(", ")} differ from ${locale}'s CLDR categories ${want.join(", ")}`,
        );
      categories = want;
      // the plural argument appears only through #
      const plainUse = [...p.head, ...p.tail].some(
        (x) => "arg" in x && x.arg === arg,
      );
      if (plainUse)
        errors.push(
          `${where}: {${arg}} is the plural argument; write it as # inside the plural`,
        );
    } else {
      if (arg !== "formFactor")
        errors.push(
          `${where}: select is only allowed on formFactor, not {${arg}}`,
        );
      if (
        names.length !== FORM_FACTORS.length ||
        !FORM_FACTORS.every((c) => names.includes(c))
      )
        errors.push(
          `${where}: formFactor cases ${names.join(", ")} differ from ${FORM_FACTORS.join(", ")}`,
        );
    }
  }
  for (const [a, kind] of args) {
    if (kind === "select") continue;
    const known =
      (STRING_ARGS as readonly string[]).includes(a) ||
      (PLURAL_ARGS as readonly string[]).includes(a);
    if (!known)
      errors.push(`${where}: argument {${a}} is outside the closed set`);
  }
  return { args, categories };
}

function sameArgs(a: ArgShape, b: ArgShape): boolean {
  if (a.args.size !== b.args.size) return false;
  for (const [k, v] of a.args) if (b.args.get(k) !== v) return false;
  return true;
}

const describeArgs = (s: ArgShape) =>
  [...s.args]
    .map(([k, v]) => (v === "string" ? `{${k}}` : `{${k}, ${v}}`))
    .join(" ") || "none";

/** Every check of plans/UK-02.md §3.2. Empty = valid. */
export function validateKitCopy(src: KitCopySources): string[] {
  const errors: string[] = [];
  const { en, packs, glossary, components } = src;
  const enCore = coreTable(src, "en");
  const coreValues = new Map(
    Object.entries(enCore).map(([k, v]) => [v.toLocaleLowerCase("en"), k]),
  );
  const enShapes = new Map<string, ArgShape>();

  // English: keys, roles, notes, variants, vocabulary, the duplicate ban.
  for (const [key, msg] of Object.entries(en.messages)) {
    const where = `en ${key}`;
    if (!KEY_PATTERN.test(key)) errors.push(`${where}: key breaks the pattern`);
    const ns = key.split(".")[0]!;
    if (ns === "core")
      errors.push(`${where}: core.* is reserved for core copy`);
    else if (!(KEY_NAMESPACES as readonly string[]).includes(ns))
      errors.push(
        `${where}: "${ns}" is not a component, part, common, a11y or signin`,
      );
    if (!msg.note.trim()) errors.push(`${where}: note is empty`);
    const texts: [string, string][] = [[where, msg.value]];
    for (const [platform, v] of Object.entries(msg.variants ?? {}))
      texts.push([`${where} (${platform})`, v]);
    const shape = shapeOf(where, msg.value, "en", errors);
    if (shape) enShapes.set(key, shape);
    for (const [w, text] of texts) {
      errors.push(...checkText(w, text));
      const banned = BANNED_EN.exec(text);
      if (banned)
        errors.push(
          `${w}: "${banned[0]}" is banned vocabulary (license, device, tier; never grant)`,
        );
      const dup = coreValues.get(text.toLocaleLowerCase("en"));
      if (dup)
        errors.push(
          `${w}: duplicates core copy ${dup}; reference that key instead`,
        );
    }
    if (msg.variants) {
      if (!VARIANT_ROLES.includes(msg.role))
        errors.push(
          `${where}: variants are only allowed on button, menu and windowTitle keys`,
        );
      const p = shape && parseMessage(msg.value);
      if (p?.complex)
        errors.push(
          `${where}: a plural or select message cannot carry variants`,
        );
      for (const [platform, v] of Object.entries(msg.variants)) {
        const vs = shapeOf(`${where} (${platform})`, v, "en", errors);
        if (shape && vs && !sameArgs(shape, vs))
          errors.push(
            `${where} (${platform}): arguments differ from the value's`,
          );
      }
    }
  }

  // The packs: same keys, same arguments, the locale's plural categories, the brand intact.
  for (const locale of KIT_LOCALES.slice(1)) {
    const pack = packs[locale];
    if (!pack) {
      errors.push(`${locale}: pack is missing`);
      continue;
    }
    if (pack.locale !== locale)
      errors.push(`${locale}.json: locale is "${pack.locale}"`);
    if (pack.glossaryVersion !== glossary.glossaryVersion)
      errors.push(
        `${locale}.json: glossaryVersion ${pack.glossaryVersion} is not the glossary's ${glossary.glossaryVersion}`,
      );
    for (const key of Object.keys(en.messages))
      if (!(key in pack.messages)) errors.push(`${locale} ${key}: missing`);
    for (const [key, value] of Object.entries(pack.messages)) {
      const where = `${locale} ${key}`;
      if (!(key in en.messages)) {
        errors.push(`${where}: not in en.json`);
        continue;
      }
      errors.push(...checkText(where, value));
      const shape = shapeOf(where, value, locale, errors);
      const enShape = enShapes.get(key);
      if (shape && enShape && !sameArgs(shape, enShape))
        errors.push(
          `${where}: arguments ${describeArgs(shape)} differ from en's ${describeArgs(enShape)}`,
        );
      const brands = (s: string) => s.split(BRAND).length - 1;
      if (brands(value) !== brands(en.messages[key]!.value))
        errors.push(`${where}: "${BRAND}" must appear exactly as in English`);
    }
  }

  // The glossary covers every pack.
  for (const [term, byLocale] of Object.entries(glossary.terms))
    for (const locale of KIT_LOCALES.slice(1))
      if (!byLocale[locale])
        errors.push(`glossary ${term}: no ${locale} entry`);

  // components.json: the §4.1 set, known keys, every component key listed.
  const names = Object.keys(components.components);
  for (const name of COMPONENTS)
    if (!names.includes(name))
      errors.push(`components.json: ${name} is missing`);
  for (const name of names)
    if (!(COMPONENTS as readonly string[]).includes(name))
      errors.push(`components.json: ${name} is not a UI-KITS §4.1 component`);
  const listed = new Set<string>();
  for (const [name, comp] of Object.entries(components.components)) {
    if (comp.family !== null && !FAMILIES.has(comp.family))
      errors.push(
        `components.json ${name}: family "${comp.family}" is not a ui-matrix family`,
      );
    for (const [state, { copy }] of Object.entries(comp.states)) {
      if (!STATE_PATTERN.test(state))
        errors.push(`components.json ${name}.${state}: states are kebab-case`);
      for (const key of copy) {
        listed.add(key);
        if (key.startsWith("core.")) {
          if (!(key in enCore))
            errors.push(
              `components.json ${name}.${state}: ${key} is not in copy.en.json`,
            );
        } else if (!(key in en.messages))
          errors.push(
            `components.json ${name}.${state}: ${key} is not in en.json`,
          );
      }
    }
  }
  for (const key of Object.keys(en.messages))
    if (!SHARED_NAMESPACES.has(key.split(".")[0]!) && !listed.has(key))
      errors.push(`en ${key}: no component state lists it`);
  return errors;
}

// ── The model every renderer reads ──────────────────────────────────────────────────────────

interface Entry {
  key: string;
  /** The English value, for translator comments. */
  english: string;
  note: string;
  role?: Role;
  /** Positional argument order (en's first-seen order; the formFactor select excluded). */
  args: string[];
  /** The plural argument, if any. */
  pluralArg?: string;
  select: boolean;
  /** Per locale: the ICU-subset value. */
  values: Record<string, string>;
  /** English platform variants (explicit, or D13 title case on macOS). */
  variants: Partial<Record<VariantPlatform, string>>;
}

export interface KitCopyModel {
  locales: readonly string[];
  entries: Entry[];
  /** Locales whose core.* strings fell back to English (a pending pack). */
  coreFallback: string[];
}

export function buildKitCopyModel(src: KitCopySources): KitCopyModel {
  const errors = validateKitCopy(src);
  if (errors.length > 0)
    throw new Error(
      `the kit copy catalog is invalid:\n  ${errors.join("\n  ")}`,
    );
  const entries: Entry[] = [];
  for (const [key, msg] of Object.entries(src.en.messages)) {
    const p = parseMessage(msg.value);
    const variants: Partial<Record<VariantPlatform, string>> = {
      ...(msg.variants ?? {}),
    };
    if (
      VARIANT_ROLES.includes(msg.role) &&
      !p.complex &&
      variants.macos === undefined
    ) {
      const t = titleCase(msg.value);
      if (t !== msg.value) variants.macos = t;
    }
    const values: Record<string, string> = { en: msg.value };
    for (const locale of KIT_LOCALES.slice(1))
      values[locale] = src.packs[locale]!.messages[key]!;
    entries.push({
      key,
      english: msg.value,
      note: msg.note,
      role: msg.role,
      args: messageArgs(p).filter(
        (a) => !(p.complex?.kind === "select" && a === p.complex.arg),
      ),
      pluralArg: p.complex?.kind === "plural" ? p.complex.arg : undefined,
      select: p.complex?.kind === "select",
      values,
      variants,
    });
  }
  const enCore = coreTable(src, "en");
  const coreTables = Object.fromEntries(
    KIT_LOCALES.map((l) => [l, coreTable(src, l)]),
  );
  for (const [key, english] of Object.entries(enCore)) {
    const p = parseMessage(english);
    const section = key.split(".")[1];
    entries.push({
      key,
      english,
      note: `Core copy (conformance/parity/copy.en.json, ${section}).`,
      args: messageArgs(p),
      select: false,
      values: Object.fromEntries(
        KIT_LOCALES.map((l) => [l, coreTables[l]![key]!]),
      ),
      variants: {},
    });
  }
  return {
    locales: KIT_LOCALES,
    entries,
    coreFallback: KIT_LOCALES.filter((l) => !src.core[l]),
  };
}

/** The flat ICU table for a locale (kit keys then core.* keys). */
export function tableFor(model: KitCopyModel, locale: string): KitTable {
  return Object.fromEntries(
    model.entries.map((e) => [e.key, e.values[locale]!]),
  );
}

// ── Renderers ───────────────────────────────────────────────────────────────────────────────

const BANNER_LINES = [
  "GENERATED FILE — do not edit by hand.",
  "",
  "Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/kit-copy.ts) from",
  "packages/brand/kit-copy/ (en.json and the eight locale packs) and the core copy in",
  "conformance/parity/copy.<locale>.json. `pnpm gen:brand -- --check` fails the green gate on any",
  "difference. To change a string, edit its source and regenerate.",
];
const banner = (prefix: string) =>
  BANNER_LINES.map((l) => (l ? `${prefix} ${l}` : prefix)).join("\n");

const variantsFor = (model: KitCopyModel) =>
  Object.fromEntries(
    model.entries
      .filter((e) => Object.keys(e.variants).length > 0)
      .map((e) => [e.key, e.variants]),
  );

// web ----------------------------------------------------------------------------------------

export const webJson = (model: KitCopyModel, locale: string): string =>
  JSON.stringify(tableFor(model, locale));

export function webIndex(model: KitCopyModel): string {
  const keys = model.entries.map((e) => JSON.stringify(e.key));
  return `${banner("//")}
/**
 * The Polaris Key kit copy (plans/UK-02.md): one flat table per launch locale holding every kit
 * string and every core copy string (under \`core.*\`), as ICU MessageFormat-subset text. Kits look
 * a key up per locale with a per-key fallback to English and format it with the ui-core formatter.
 */
import en from "./en.json" with { type: "json" };

/** Every key a kit table holds. */
export type KitCopyKey =
  | ${keys.join("\n  | ")};

/** One locale's table. */
export type KitCopyTable = Readonly<Record<KitCopyKey, string>>;

/** The launch locales, English first. */
export const KIT_COPY_LOCALES = ${JSON.stringify(model.locales)} as const;
export type KitCopyLocale = (typeof KIT_COPY_LOCALES)[number];

/** The English table, always bundled: every lookup falls back to it key by key. */
export const KIT_COPY_EN: KitCopyTable = en as KitCopyTable;

/** English platform variants (D13 title case on macOS and documented verbs); other locales have none. */
export const KIT_COPY_VARIANTS: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(variantsFor(model))};

/** Locales whose core.* strings are English until their core pack lands. */
export const KIT_COPY_CORE_FALLBACK: readonly string[] = ${JSON.stringify(model.coreFallback)};

/** Load one locale's table (code-split per locale). */
export async function loadKitCopy(locale: KitCopyLocale): Promise<KitCopyTable> {
  switch (locale) {
${model.locales
  .map(
    (l) =>
      `    case ${JSON.stringify(l)}:\n      return (await import("./${l}.json", { with: { type: "json" } })).default as KitCopyTable;`,
  )
  .join("\n")}
  }
}
`;
}

// Node terminal ------------------------------------------------------------------------------

export function nodeModule(model: KitCopyModel): string {
  const tables = Object.fromEntries(
    model.locales.map((l) => [l, tableFor(model, l)]),
  );
  return `${banner("//")}
/**
 * The Polaris Key kit copy for the terminal kit (plans/UK-02.md §3.3): the same tables as
 * \`@polaris-key/brand/kit-copy\`, inlined so \`@polaris-key/node\` takes no brand dependency. Every
 * table holds the kit keys and the core copy (\`core.*\`) as ICU MessageFormat-subset text.
 */

/** The launch locales, English first. */
export const KIT_COPY_LOCALES = ${JSON.stringify(model.locales)} as const;
export type KitCopyLocale = (typeof KIT_COPY_LOCALES)[number];

/** One table per locale. Look a key up in the locale, then in English. */
export const KIT_COPY: Readonly<Record<KitCopyLocale, Readonly<Record<string, string>>>> = ${JSON.stringify(tables)};

/** English platform variants (\`terminal\` is the one this kit reads). */
export const KIT_COPY_VARIANTS: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(variantsFor(model))};
`;
}

// Swift (.xcstrings) -------------------------------------------------------------------------

/** formFactor case → Xcode device variation. phone, tablet and computer never run on Apple. */
const APPLE_DEVICE: Record<string, string> = {
  iphone: "iphone",
  ipad: "ipad",
  mac: "mac",
  tv: "appletv",
  other: "other",
};

function swiftFormat(e: Entry, value: string, caseName: string | null): string {
  const p = parseMessage(value);
  const render = (x: Piece): string => {
    if ("text" in x) return x.text;
    if ("hash" in x) return "%arg";
    return `%${e.args.indexOf(x.arg) + 1}$@`;
  };
  if (p.complex?.kind === "plural") {
    // head + %#@arg@ + tail; the substitution carries the cases
    return [
      ...p.head.map(render),
      `%#@${p.complex.arg}@`,
      ...p.tail.map(render),
    ].join("");
  }
  return expandCase(p, caseName, render);
}

function swiftUnit(value: string) {
  return { stringUnit: { state: "translated", value } };
}

function swiftLocalization(e: Entry, locale: string): unknown {
  const value = e.values[locale]!;
  const p = parseMessage(value);
  if (p.complex?.kind === "plural") {
    const arg = p.complex.arg;
    const caseText = (c: string) =>
      p.complex!.cases[c]!.map((x) => ("text" in x ? x.text : "%arg")).join("");
    return {
      stringUnit: { state: "translated", value: swiftFormat(e, value, null) },
      substitutions: {
        [arg]: {
          argNum: e.args.indexOf(arg) + 1,
          formatSpecifier: "lld",
          variations: {
            plural: Object.fromEntries(
              Object.keys(p.complex.cases).map((c) => [
                c,
                swiftUnit(caseText(c)),
              ]),
            ),
          },
        },
      },
    };
  }
  if (p.complex?.kind === "select") {
    return {
      variations: {
        device: Object.fromEntries(
          Object.entries(APPLE_DEVICE).map(([ff, device]) => [
            device,
            swiftUnit(swiftFormat(e, value, ff)),
          ]),
        ),
      },
    };
  }
  const base = swiftFormat(e, value, null);
  const v = locale === "en" ? e.variants : {};
  const devices: Record<string, string> = {};
  if (v.macos) devices.mac = swiftFormat(e, v.macos, null);
  if (v.ios) devices.iphone = devices.ipad = swiftFormat(e, v.ios, null);
  if (v.tv) devices.appletv = swiftFormat(e, v.tv, null);
  if (Object.keys(devices).length === 0) return swiftUnit(base);
  return {
    variations: {
      device: {
        ...Object.fromEntries(
          Object.entries(devices).map(([d, s]) => [d, swiftUnit(s)]),
        ),
        other: swiftUnit(base),
      },
    },
  };
}

const argComment = (e: Entry) =>
  e.args.length
    ? ` Arguments: ${e.args.map((a, i) => `${i + 1}=${a}`).join(", ")}.`
    : "";

export function xcstrings(model: KitCopyModel): string {
  const strings: Record<string, unknown> = {};
  for (const e of [...model.entries].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  ))
    strings[e.key] = {
      comment: `${e.note}${argComment(e)}${e.select ? " Varies by device (formFactor)." : ""}`,
      extractionState: "manual",
      localizations: Object.fromEntries(
        model.locales.map((l) => [l, swiftLocalization(e, l)]),
      ),
    };
  return JSON.stringify(
    { sourceLanguage: "en", strings, version: "1.0" },
    null,
    2,
  );
}

// Kotlin (Compose Resources strings.xml) -----------------------------------------------------

/** BCP 47 → Compose Resources qualifier (plans/UK-02.md §3.3). */
export const COMPOSE_QUALIFIER: Record<string, string> = {
  en: "",
  de: "-de",
  fr: "-fr",
  es: "-es",
  "pt-BR": "-pt-rBR",
  it: "-it",
  ja: "-ja",
  ko: "-ko",
  "zh-Hans": "-zh-rCN",
};

export const resourceName = (key: string) => key.replace(/[.-]/g, "_");

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function kotlinFormat(
  e: Entry,
  value: string,
  caseName: string | null,
): string {
  const p = parseMessage(value);
  return expandCase(p, caseName, (x) =>
    "text" in x
      ? x.text
      : "hash" in x
        ? `%${e.args.indexOf(p.complex!.arg) + 1}$d`
        : `%${e.args.indexOf(x.arg) + 1}$s`,
  );
}

export function stringsXml(model: KitCopyModel, locale: string): string {
  const names = new Map<string, string>();
  const lines: string[] = [];
  const add = (name: string, key: string, line: string) => {
    const prior = names.get(name);
    if (prior !== undefined && prior !== key)
      throw new Error(
        `Compose resource name ${name} is shared by ${prior} and ${key}`,
      );
    names.set(name, key);
    lines.push(line);
  };
  for (const e of model.entries) {
    const name = resourceName(e.key);
    const value = e.values[locale]!;
    const p = parseMessage(value);
    const comment = `    <!-- ${xmlEscape(e.note.replace(/--/g, "-"))}${argComment(e)} -->`;
    lines.push(comment);
    if (p.complex?.kind === "plural") {
      const items = Object.keys(p.complex.cases)
        .map(
          (c) =>
            `        <item quantity="${c}">${xmlEscape(kotlinFormat(e, value, c))}</item>`,
        )
        .join("\n");
      add(
        name,
        e.key,
        `    <plurals name="${name}">\n${items}\n    </plurals>`,
      );
      continue;
    }
    if (p.complex?.kind === "select") {
      add(
        name,
        e.key,
        `    <string name="${name}">${xmlEscape(kotlinFormat(e, value, "other"))}</string>`,
      );
      for (const ff of FORM_FACTORS.filter((f) => f !== "other"))
        add(
          `${name}__${ff}`,
          e.key,
          `    <string name="${name}__${ff}">${xmlEscape(kotlinFormat(e, value, ff))}</string>`,
        );
      continue;
    }
    add(
      name,
      e.key,
      `    <string name="${name}">${xmlEscape(kotlinFormat(e, value, null))}</string>`,
    );
    for (const platform of Object.keys(e.variants) as VariantPlatform[]) {
      // Every locale carries the variant entry so a lookup never leaves the locale.
      const v = locale === "en" ? e.variants[platform]! : value;
      add(
        `${name}__${platform}`,
        e.key,
        `    <string name="${name}__${platform}">${xmlEscape(kotlinFormat(e, v, null))}</string>`,
      );
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
${BANNER_LINES.map((l) => (l ? `  ${l}` : "")).join("\n")}

  The kit copy for locale ${locale} (Compose Multiplatform resources). Names are the catalog key with
  "." and "-" as "_". A formFactor select is <name>__<case> (the bare name is "other"); a platform
  variant is <name>__<platform>. Inert until UK-09 makes :ui a KMP module.
-->
<resources>
${lines.join("\n")}
</resources>`;
}

// gettext (Godot and Python) -----------------------------------------------------------------

/** BCP 47 → gettext locale. */
export const GETTEXT_LOCALE: Record<string, string> = {
  en: "en",
  de: "de",
  fr: "fr",
  es: "es",
  "pt-BR": "pt_BR",
  it: "it",
  ja: "ja",
  ko: "ko",
  "zh-Hans": "zh_Hans",
};

/** Plural-Forms per locale; msgstr[i] follows pluralCategories(locale)'s order. Tested against Intl. */
export const PLURAL_FORMS: Record<string, string> = {
  en: "nplurals=2; plural=(n != 1);",
  de: "nplurals=2; plural=(n != 1);",
  fr: "nplurals=3; plural=(n == 0 || n == 1) ? 0 : (n != 0 && n % 1000000 == 0) ? 1 : 2;",
  "pt-BR":
    "nplurals=3; plural=(n == 0 || n == 1) ? 0 : (n != 0 && n % 1000000 == 0) ? 1 : 2;",
  es: "nplurals=3; plural=(n == 1) ? 0 : (n != 0 && n % 1000000 == 0) ? 1 : 2;",
  it: "nplurals=3; plural=(n == 1) ? 0 : (n != 0 && n % 1000000 == 0) ? 1 : 2;",
  ja: "nplurals=1; plural=0;",
  ko: "nplurals=1; plural=0;",
  "zh-Hans": "nplurals=1; plural=0;",
};

const poString = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function gettextText(e: Entry, value: string, caseName: string | null): string {
  const p = parseMessage(value);
  return expandCase(p, caseName, (x) =>
    "text" in x ? x.text : "hash" in x ? `{${p.complex!.arg}}` : `{${x.arg}}`,
  );
}

function poEntries(model: KitCopyModel, locale: string | null): string[] {
  const out: string[] = [];
  for (const e of model.entries) {
    const comments = [`#. ${e.english}`, `#. ${e.note}`].join("\n");
    const value = locale ? e.values[locale]! : e.english;
    const p = parseMessage(value);
    if (p.complex?.kind === "plural") {
      const cats = locale ? Object.keys(p.complex.cases) : ["one", "other"];
      const order = locale ? pluralCategories(locale) : cats;
      out.push(
        [
          comments,
          `#. Plural on {${p.complex.arg}}.`,
          `msgid ${poString(e.key)}`,
          `msgid_plural ${poString(e.key)}`,
          ...order.map(
            (c, i) =>
              `msgstr[${i}] ${locale ? poString(gettextText(e, value, c)) : '""'}`,
          ),
        ].join("\n"),
      );
      continue;
    }
    if (p.complex?.kind === "select") {
      out.push(
        [
          comments,
          `msgid ${poString(e.key)}`,
          `msgstr ${locale ? poString(gettextText(e, value, "other")) : '""'}`,
        ].join("\n"),
      );
      for (const ff of FORM_FACTORS.filter((f) => f !== "other"))
        out.push(
          [
            `#. formFactor ${ff}: ${gettextText(e, e.english, ff)}`,
            `msgctxt ${poString(ff)}`,
            `msgid ${poString(e.key)}`,
            `msgstr ${locale ? poString(gettextText(e, value, ff)) : '""'}`,
          ].join("\n"),
        );
      continue;
    }
    out.push(
      [
        comments,
        `msgid ${poString(e.key)}`,
        `msgstr ${locale ? poString(gettextText(e, value, null)) : '""'}`,
      ].join("\n"),
    );
    for (const platform of Object.keys(e.variants) as VariantPlatform[]) {
      const v = locale === "en" ? e.variants[platform]! : value;
      out.push(
        [
          `#. ${platform}: ${e.variants[platform]}`,
          `msgctxt ${poString(platform)}`,
          `msgid ${poString(e.key)}`,
          `msgstr ${locale ? poString(gettextText(e, v, null)) : '""'}`,
        ].join("\n"),
      );
    }
  }
  return out;
}

export function gettextFile(
  model: KitCopyModel,
  locale: string | null,
  project: string,
): string {
  const header = [
    banner("#"),
    "#",
    `# The kit copy as gettext (${project}). msgid is the catalog key; arguments are {name}. A`,
    '# formFactor select is msgctxt <case> (the bare msgid is "other"); a platform variant is',
    "# msgctxt <platform>.",
    'msgid ""',
    'msgstr ""',
    `"Project-Id-Version: polaris-key-ui\\n"`,
    `"MIME-Version: 1.0\\n"`,
    `"Content-Type: text/plain; charset=UTF-8\\n"`,
    `"Content-Transfer-Encoding: 8bit\\n"`,
    ...(locale
      ? [
          `"Language: ${GETTEXT_LOCALE[locale]}\\n"`,
          `"Plural-Forms: ${PLURAL_FORMS[locale]}\\n"`,
        ]
      : [`"Plural-Forms: nplurals=2; plural=(n != 1);\\n"`]),
  ].join("\n");
  return `${header}\n\n${poEntries(model, locale).join("\n\n")}\n`;
}

// Python ---------------------------------------------------------------------------------------

const pyString = (s: string) => JSON.stringify(s); // JSON string literals are valid Python

export function pythonModule(model: KitCopyModel): string {
  const table = (l: string) =>
    model.entries
      .map((e) => `        ${pyString(e.key)}: ${pyString(e.values[l]!)},`)
      .join("\n");
  const variants = variantsFor(model);
  return `${banner("#")}
"""Polaris Key's kit copy (plans/UK-02.md §3.3, D6).

One table per launch locale, holding every kit string and the core copy (\`\`core.*\`\`) as ICU
MessageFormat-subset text. The Qt and terminal kits look a key up in the locale, then in English,
and format it with \`\`polaris_key.ui.core\`\`.
"""

from __future__ import annotations

from typing import Final, Mapping

__all__ = ["KIT_COPY_LOCALES", "KIT_COPY", "KIT_COPY_VARIANTS", "KIT_COPY_CORE_FALLBACK"]

#: The launch locales, English first.
KIT_COPY_LOCALES: Final = (${model.locales.map(pyString).join(", ")},)

#: Locales whose core.* strings are English until their core pack lands.
KIT_COPY_CORE_FALLBACK: Final = (${model.coreFallback.map((l) => `${pyString(l)},`).join(" ")})

#: One table per locale.
KIT_COPY: Final[Mapping[str, Mapping[str, str]]] = {
${model.locales.map((l) => `    ${pyString(l)}: {\n${table(l)}\n    },`).join("\n")}
}

#: English platform variants (D13 title case on macOS and documented verbs).
KIT_COPY_VARIANTS: Final[Mapping[str, Mapping[str, str]]] = {
${Object.entries(variants)
  .map(
    ([k, v]) =>
      `    ${pyString(k)}: {${Object.entries(v)
        .map(([p, s]) => `${pyString(p)}: ${pyString(s!)}`)
        .join(", ")}},`,
  )
  .join("\n")}
}
`;
}

// ── Targets ─────────────────────────────────────────────────────────────────────────────────

export interface KitCopyTarget {
  path: string;
  render: () => string;
  parser?: "typescript" | "json";
}

let cached: KitCopyModel | undefined;
const model = (): KitCopyModel =>
  (cached ??= buildKitCopyModel(loadKitCopySources()));

const GODOT_LOCALE_DIR = "sdks/godot/addons/polaris_key/ui/locale";
const PY_UI = "sdks/python/src/polaris_key/ui";

export const KIT_COPY_TARGETS: KitCopyTarget[] = [
  ...KIT_LOCALES.map((l) => ({
    path: `packages/brand/src/generated/kit-copy/${l}.json`,
    render: () => webJson(model(), l),
    parser: "json" as const,
  })),
  {
    path: "packages/brand/src/generated/kit-copy/index.ts",
    render: () => webIndex(model()),
    parser: "typescript",
  },
  {
    path: "packages/sdk-node/src/kitCopy.generated.ts",
    render: () => nodeModule(model()),
    parser: "typescript",
  },
  {
    path: "sdks/swift/Sources/PolarisKeyUI/Resources/Localizable.xcstrings",
    render: () => xcstrings(model()),
  },
  ...KIT_LOCALES.map((l) => ({
    path: `sdks/kotlin/ui/src/commonMain/composeResources/values${COMPOSE_QUALIFIER[l]}/strings.xml`,
    render: () => stringsXml(model(), l),
  })),
  {
    path: `${GODOT_LOCALE_DIR}/polaris_key_ui.pot`,
    render: () => gettextFile(model(), null, "Godot kit template"),
  },
  ...KIT_LOCALES.map((l) => ({
    path: `${GODOT_LOCALE_DIR}/${GETTEXT_LOCALE[l]}.po`,
    render: () => gettextFile(model(), l, `Godot kit, ${l}`),
  })),
  {
    path: `${PY_UI}/__init__.py`,
    render: () =>
      `${banner("#")}\n"""Polaris Key UI kits for Python (Qt and the terminal; UK-12 and UK-13)."""\n`,
  },
  {
    path: `${PY_UI}/kit_copy_generated.py`,
    render: () => pythonModule(model()),
  },
  {
    path: `${PY_UI}/locale/polaris_key_ui.pot`,
    render: () =>
      gettextFile(model(), null, "Python Qt and terminal kit template"),
  },
];

// ── CLI: `tsx scripts/kit-copy.ts --validate [--partial]` (translators' loop) ──────────────────

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly && process.argv.includes("--validate")) {
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt > 0 ? process.argv[onlyAt + 1] : undefined;
  const partial = process.argv.includes("--partial") || only !== undefined;
  const src = loadKitCopySources(REPO_ROOT, { partial, only });
  const errors = validateKitCopy(src).filter(
    (e) => !(partial && / pack is missing$/.test(e)),
  );
  for (const e of errors) console.error(e);
  console.log(
    errors.length === 0
      ? `kit copy valid (${Object.keys(src.packs).length} packs)`
      : `${errors.length} problem(s)`,
  );
  process.exit(errors.length === 0 ? 0 : 1);
}
