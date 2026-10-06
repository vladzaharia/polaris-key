// The SDK constants generator (P1b-02, PARITY §4.4).
//
//   pnpm gen:constants              # (re)write every generated constants module
//   pnpm gen:constants -- --check   # regenerate in memory; exit 1 if any file differs
//
// One constants module per language, every one from the same sources, so that names are
// identical up to casing (PARITY §2.1) and nobody has to remember the mapping:
//
//   conformance/parity/errors.json      the error-code registry (+ errors.schema.json)
//   conformance/parity/enums.json       platform, arch, … (+ enums.schema.json)
//   conformance/parity/features.json    feature ids and the supports() reason enum (P1b-01)
//   <sdk>/parity.json                   each SDK's manifest, for its capability table (P1b-10,
//                                       tools/capabilities.ts): `CAPABILITIES`, the table
//                                       `supports()` reads, and its `CAPABILITY_DIGEST`
//   tools/services.json                 the service slugs (P0-09)
//   @polaris-key/protocol/core          PROTOCOL_VERSION, the HEADER_* names, every
//                                       CHANNEL_* / PR_* channel constant (P0-04) and the
//                                       PLATFORM_SPELLINGS / ARCH_SPELLINGS header-value tables
//                                       (WIRE-CONTRACT-V3 §5.2, P1b-04) — read as exports, so a
//                                       constant added there flows through here
//                                       and the wire contract v4 limits MAX_WIRE_INTEGER,
//                                       MAX_JSON_DEPTH and MAX_RECORD_JWS_BYTES, and the
//                                       PACK_LIMIT_EXPORTS (plans/P4-01.md §2.13)
//   conformance/parity/copy.en.json     the core copy (core.copy, plans/SP-00.md §4; + copy.schema.json):
//                                       a title and message per errors.json code, licenseStatus
//                                       and activationResult, checked key for key against those
//                                       sources and against the closed placeholder set, and
//                                       emitted as a separate copy module per SDK (COPY_TARGETS)
//   conformance/parity/copy.<locale>.json  translated core packs (plans/UK-02.md D4): checked
//                                       against copy.en.json (keys, placeholders, locale,
//                                       reviewed) and not emitted here; gen:brand's kit tables
//                                       carry them
//   conformance/corpus/v2/*.json        corpusVersion, gateMatrixVersion, fingerprintVersion,
//                                       stageMatrixVersion, updateMatrixVersion,
//                                       outletMatrixVersion, planMatrixVersion, and
//                                       content/cases.json's contentCorpusVersion
//
// Outputs, each with a GENERATED banner (TypeScript is prettier-formatted, as sign-corpus.ts
// does): see TARGETS. The GDScript module is written only while `sdks/godot/addons/polaris_key`
// exists. `--check` is the drift gate in CI and the green gate.
//
// THE ERROR REGISTRY IS CHECKED AGAINST SOURCE. Loading the sources scans the Worker the way
// packages/docs/scripts/gen-reference.mjs does — `PolarisErrorCode`, the Worker's `ErrorCode`
// object, and every `errorResponse(…)` / `wireError(…)` call site and `error:` / `code:` literal
// under packages/worker/src (the console API in src/admin/ is not an SDK surface and is not
// scanned) — and refuses to generate when errors.json lacks a code the Worker emits, or lists a
// `wire` code the Worker no longer emits. The boot stage machine's own error codes are checked
// the same way, from the `error` emits pinned in conformance/corpus/v2/stage-matrix.json (a code
// that only echoes the host's `fail` event is the host's, not the SDK's). Other client codes
// (raised only by an SDK) are checked by each SDK's own registry test, against the module
// generated here.
//
// WHY conformance/parity/ AND NOT shared-protocol. Editing `shared-protocol` or `client-core` is
// plan mode (CLAUDE.md); importing their exports is not. The same reason gives Node and React a
// generated module each instead of one shared one.
//
// SERVICE SLUGS. tools/gen-services.ts owns the `*services.generated.*` files; this generator
// reads the same table and emits a `ServiceSlug` group of its own — except in Swift and Kotlin,
// where `ServiceSlug.generated.swift` and `ServiceSlug.generated.kt` already declare the enum and
// a second declaration would clash.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as protocolCore from "@polaris-key/protocol/core";
import Ajv2020Module from "ajv/dist/2020.js";
import * as prettier from "prettier";
import {
  capabilityDigest,
  capabilityTable,
  type CapabilityManifest,
  type SdkCapabilities,
} from "./capabilities.js";
import { KOTLIN_KEYWORDS, loadTable, SWIFT_KEYWORDS } from "./gen-services.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Sources ────────────────────────────────────────────────────────────────────────────────

export type ErrorKind = "wire" | "client";

export interface ErrorEntry {
  code: string;
  kind: ErrorKind;
  service: string;
  description: string;
}

export interface ErrorRegistry {
  $comment?: string;
  registryVersion: 1;
  codes: ErrorEntry[];
}

export interface EnumDef {
  name: string;
  description: string;
  values: string[];
}

export interface EnumRegistry {
  $comment?: string;
  enums: EnumDef[];
}

/** One piece of core copy: what a person reads. */
export interface CopyEntry {
  title: string;
  message: string;
}

/** conformance/parity/copy.<locale>.json (copy.schema.json). */
export interface CopyDoc {
  $comment?: string;
  copyVersion: 1;
  locale: string;
  fallback: CopyEntry;
  codes: Record<string, CopyEntry>;
  gate: Record<string, CopyEntry>;
  activation: Record<string, CopyEntry>;
}

/** The only placeholders core copy may use (plans/SP-00.md §4). */
export const COPY_PLACEHOLDERS = [
  "code",
  "detail",
  "limit",
  "deviceCount",
  "retryAfterSeconds",
  "product",
] as const;

/** Everything the renderers need, already read. Tests build one by hand. */
export interface Sources {
  errors: ErrorEntry[];
  enums: EnumDef[];
  features: string[];
  reasons: string[];
  services: string[];
  /** Each SDK's capability table (tools/capabilities.ts), keyed by registry SDK id. */
  capabilities?: Record<string, SdkCapabilities>;
  /** The `@polaris-key/protocol/core` module namespace (or a stand-in with the same exports). */
  protocol: Record<string, unknown>;
  /** The core copy (copy.en.json), already checked by validateCopy. */
  copy?: CopyDoc;
  corpus: {
    corpusVersion: number;
    gateMatrixVersion: number;
    fingerprintVersion: number;
    stageMatrixVersion: number;
    updateMatrixVersion: number;
    outletMatrixVersion: number;
    planMatrixVersion: number;
    contentCorpusVersion: number;
  };
}

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

/** A validator for one JSON Schema (draft 2020-12) file: data → error lines, empty = valid. */
export function compileSchema(path: string): (data: unknown) => string[] {
  const Ajv2020 =
    (Ajv2020Module as unknown as { default?: unknown }).default ??
    Ajv2020Module;
  const ajv = new (Ajv2020 as new (opts: object) => {
    compile(schema: unknown): ((data: unknown) => boolean) & {
      errors?: { instancePath: string; message?: string }[] | null;
    };
  })({ allErrors: true, strict: false });
  const validate = ajv.compile(readJson(path));
  return (data) =>
    validate(data)
      ? []
      : (validate.errors ?? []).map(
          (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`,
        );
}

/** Rules the schema cannot say: a code appears once. Empty = valid. */
export function validateErrors(registry: ErrorRegistry): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const entry of registry.codes) {
    if (seen.has(entry.code)) errors.push(`duplicate code "${entry.code}"`);
    seen.add(entry.code);
  }
  return errors;
}

/** Rules the schema cannot say: an enum name appears once. Empty = valid. */
export function validateEnums(registry: EnumRegistry): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const def of registry.enums) {
    if (seen.has(def.name)) errors.push(`duplicate enum "${def.name}"`);
    seen.add(def.name);
  }
  return errors;
}

/** Every placeholder-shaped token in one string, and whether its braces are otherwise balanced. */
function placeholderErrors(where: string, text: string): string[] {
  const errors: string[] = [];
  const known = new Set<string>(COPY_PLACEHOLDERS);
  for (const m of text.matchAll(/\{([^{}]*)\}/g))
    if (!known.has(m[1]!))
      errors.push(
        `${where}: unknown placeholder {${m[1]}} (allowed: ${COPY_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`,
      );
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, "")))
    errors.push(`${where}: a brace that is not part of a {placeholder}`);
  return errors;
}

/** One section's keys against its source, in both directions. */
function keyErrors(
  section: string,
  actual: Record<string, unknown>,
  expected: readonly string[],
  source: string,
): string[] {
  const want = new Set(expected);
  return [
    ...expected
      .filter((k) => !(k in actual))
      .map((k) => `${section}: no entry for "${k}" (${source})`),
    ...Object.keys(actual)
      .filter((k) => !want.has(k))
      .map((k) => `${section}: "${k}" is not in ${source}`),
  ];
}

/**
 * The checks the copy schema cannot say (plans/SP-00.md §4): `codes` keys equal the errors.json
 * codes, `gate` keys equal `licenseStatus`, `activation` keys equal `activationResult`, and every
 * placeholder is one of COPY_PLACEHOLDERS. Empty = valid.
 */
export function validateCopy(
  copy: CopyDoc,
  sources: { codes: readonly string[]; enums: readonly EnumDef[] },
): string[] {
  const values = (name: string): string[] | undefined =>
    sources.enums.find((e) => e.name === name)?.values;
  const errors: string[] = [];
  errors.push(...keyErrors("codes", copy.codes, sources.codes, "errors.json"));
  for (const [section, enumName] of [
    ["gate", "licenseStatus"],
    ["activation", "activationResult"],
  ] as const) {
    const expected = values(enumName);
    if (!expected) errors.push(`enums.json has no ${enumName} enum`);
    else
      errors.push(
        ...keyErrors(
          section,
          copy[section],
          expected,
          `enums.json ${enumName}`,
        ),
      );
  }
  const entries: [string, CopyEntry][] = [
    ["fallback", copy.fallback],
    ...(["codes", "gate", "activation"] as const).flatMap((section) =>
      Object.entries(copy[section]).map(
        ([k, e]) => [`${section}.${k}`, e] as [string, CopyEntry],
      ),
    ),
  ];
  for (const [where, entry] of entries)
    for (const field of ["title", "message"] as const)
      errors.push(...placeholderErrors(`${where}.${field}`, entry[field]));
  return errors;
}

/**
 * A translated core copy pack, `copy.<locale>.json` (plans/UK-02.md D4): the same sections and
 * keys as copy.en.json, the same placeholder set in every string, a `locale` matching the file
 * name and an explicit `reviewed`. The schema and validateCopy's placeholder rules apply too.
 * Translations are not emitted by this generator; the kit tables (gen:brand) carry them.
 */
export function validateCopyLocale(
  doc: CopyDoc & { reviewed?: boolean },
  en: CopyDoc,
  locale: string,
): string[] {
  const errors: string[] = [];
  if (doc.locale !== locale)
    errors.push(`locale is "${doc.locale}", not "${locale}"`);
  if (typeof doc.reviewed !== "boolean")
    errors.push("a translated pack states reviewed: true or false");
  const names = (text: string) =>
    [...text.matchAll(/\{([^{}]*)\}/g)]
      .map((m) => m[1]!)
      .sort()
      .join(", ");
  const compare = (where: string, a: CopyEntry, b: CopyEntry | undefined) => {
    if (!b) return;
    for (const field of ["title", "message"] as const) {
      errors.push(...placeholderErrors(`${where}.${field}`, b[field]));
      if (names(a[field]) !== names(b[field]))
        errors.push(
          `${where}.${field}: placeholders {${names(b[field])}} differ from English {${names(a[field])}}`,
        );
    }
  };
  compare("fallback", en.fallback, doc.fallback);
  for (const section of ["codes", "gate", "activation"] as const) {
    errors.push(
      ...keyErrors(
        section,
        doc[section] ?? {},
        Object.keys(en[section]),
        "copy.en.json",
      ),
    );
    for (const [k, e] of Object.entries(en[section]))
      compare(`${section}.${k}`, e, doc[section]?.[k]);
  }
  return errors;
}

function loadValidated<T>(
  root: string,
  file: string,
  schema: string,
  extra: (data: T) => string[],
): T {
  const path = join(root, "conformance", "parity", file);
  const data = readJson(path) as T;
  const errors = [
    ...compileSchema(join(root, "conformance", "parity", schema))(data),
    ...extra(data),
  ];
  if (errors.length > 0) {
    throw new Error(
      `${relative(root, path)} is invalid:\n  ${errors.join("\n  ")}`,
    );
  }
  return data;
}

// ── The Worker source scan ────────────────────────────────────────────────────────────────

export interface WorkerSource {
  /** packages/shared-protocol/src/core.ts */
  protocolCore: string;
  /** packages/worker/src/core/errors.ts */
  workerErrors: string;
  /** Every other scanned file under packages/worker/src, repo-relative path → text. */
  files: { path: string; text: string }[];
}

/** Wire codes the source emits, each with where it was seen. */
export type ScannedCodes = Map<string, string[]>;

const CODE = "[a-z][a-z0-9_]*";
const CALL_LITERAL = new RegExp(
  `\\b(?:errorResponse|wireError)\\(\\s*[^,()]+?,\\s*"(${CODE})"`,
  "g",
);
const CALL_ENUM =
  /\b(?:errorResponse|wireError)\(\s*[^,()]+?,\s*ErrorCode\.([A-Za-z]+)/g;
const FIELD_LITERAL = new RegExp(`\\b(?:error|code):\\s*"(${CODE})"`, "g");

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

/**
 * Every wire code the Worker's source emits, read the way gen-reference.mjs reads it: the
 * `PolarisErrorCode` union, the Worker's `ErrorCode` object, and, per file, every
 * `errorResponse(<status>, "<code>")` / `wireError(…)` call (literal or `ErrorCode.<Member>`)
 * and every `error: "<code>"` / `code: "<code>"` literal.
 */
export function scanWorkerSource(src: WorkerSource): ScannedCodes {
  const found: ScannedCodes = new Map();
  const add = (code: string, where: string): void => {
    const list = found.get(code) ?? [];
    list.push(where);
    found.set(code, list);
  };

  const union = src.protocolCore.match(
    /export type PolarisErrorCode =([\s\S]*?);/,
  );
  if (!union) throw new Error("PolarisErrorCode not found in protocol core");
  for (const m of union[1]!.matchAll(/"([a-z_]+)"/g))
    add(m[1]!, "PolarisErrorCode");

  const object =
    src.workerErrors.match(
      /export const ErrorCode = \{([\s\S]*?)\n\} as const/,
    ) ?? src.workerErrors.match(/export const ErrorCode = \{([\s\S]*?)\n\};/);
  if (!object) throw new Error("ErrorCode not found in the Worker's errors.ts");
  const members = new Map<string, string>();
  for (const m of object[1]!.matchAll(/([A-Za-z]+):\s*"([a-z_]+)"/g)) {
    members.set(m[1]!, m[2]!);
    add(m[2]!, `ErrorCode.${m[1]}`);
  }

  for (const { path, text } of src.files) {
    for (const m of text.matchAll(CALL_LITERAL))
      add(m[1]!, `${path}:${lineOf(text, m.index!)}`);
    for (const m of text.matchAll(FIELD_LITERAL))
      add(m[1]!, `${path}:${lineOf(text, m.index!)}`);
    for (const m of text.matchAll(CALL_ENUM)) {
      const code = members.get(m[1]!);
      if (code === undefined) {
        throw new Error(
          `${path}:${lineOf(text, m.index!)}: ErrorCode.${m[1]} is not a member of the Worker's ErrorCode`,
        );
      }
      add(code, `${path}:${lineOf(text, m.index!)}`);
    }
  }
  return found;
}

/** errors.json against the scan: wire codes it lacks, and `wire` entries nothing emits. */
export function checkCoverage(
  errors: readonly ErrorEntry[],
  scanned: ScannedCodes,
): string[] {
  const problems: string[] = [];
  const byCode = new Map(errors.map((e) => [e.code, e]));
  for (const [code, where] of scanned) {
    const entry = byCode.get(code);
    if (!entry) {
      problems.push(
        `the Worker emits "${code}" (${where[0]}${where.length > 1 ? `, +${where.length - 1} more` : ""}) but conformance/parity/errors.json has no entry — add one`,
      );
    } else if (entry.kind !== "wire") {
      problems.push(
        `"${code}" is emitted by the Worker (${where[0]}) but errors.json marks it kind "${entry.kind}" — it is "wire"`,
      );
    }
  }
  for (const entry of errors) {
    if (entry.kind === "wire" && !scanned.has(entry.code)) {
      problems.push(
        `errors.json lists wire code "${entry.code}" but the Worker's source no longer emits it — remove it or mark it "client"`,
      );
    }
  }
  return problems;
}

/**
 * The error codes the boot stage machine itself originates, from the stage matrix's pinned
 * emits: every `{ type: "error", code }` emit whose code is not the step's own `fail` event
 * code echoed back (that one is the host's, passed through). Code → `rows[i].steps[j]` sites.
 */
export function scanStageMatrix(matrix: unknown): ScannedCodes {
  const found: ScannedCodes = new Map();
  const rows = (matrix as { rows?: unknown }).rows;
  if (!Array.isArray(rows))
    throw new Error("conformance/corpus/v2/stage-matrix.json has no rows");
  rows.forEach((row: { steps?: unknown }, i) => {
    const steps = Array.isArray(row.steps) ? row.steps : [];
    steps.forEach(
      (
        step: { event?: { type?: unknown; code?: unknown }; emits?: unknown },
        j,
      ) => {
        const echoed =
          step.event?.type === "fail" ? step.event.code : undefined;
        for (const emit of Array.isArray(step.emits) ? step.emits : []) {
          const { type, code } = emit as { type?: unknown; code?: unknown };
          if (type !== "error" || typeof code !== "string" || code === echoed)
            continue;
          const where = `stage-matrix.json rows[${i}].steps[${j}]`;
          found.set(code, [...(found.get(code) ?? []), where]);
        }
      },
    );
  });
  return found;
}

/** errors.json against the stage machine's own codes: each must be registered as `client`. */
export function checkStageCoverage(
  errors: readonly ErrorEntry[],
  scanned: ScannedCodes,
): string[] {
  const byCode = new Map(errors.map((e) => [e.code, e]));
  const problems: string[] = [];
  for (const [code, where] of scanned) {
    const entry = byCode.get(code);
    if (!entry) {
      problems.push(
        `the boot stage machine emits "${code}" (${where[0]}) but conformance/parity/errors.json has no entry — add one`,
      );
    } else if (entry.kind !== "client") {
      problems.push(
        `"${code}" is emitted by the boot stage machine (${where[0]}) but errors.json marks it kind "${entry.kind}" — it is "client"`,
      );
    }
  }
  return problems;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walkTs(abs));
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(abs);
  }
  return out;
}

/** The scan inputs from a checkout. `src/admin/` (the console API) is not an SDK surface. */
export function readWorkerSource(root = ROOT): WorkerSource {
  const src = join(root, "packages", "worker", "src");
  const errorsPath = join(src, "core", "errors.ts");
  return {
    protocolCore: readFileSync(
      join(root, "packages", "shared-protocol", "src", "core.ts"),
      "utf8",
    ),
    workerErrors: readFileSync(errorsPath, "utf8"),
    files: walkTs(src)
      .filter((abs) => !relative(src, abs).startsWith("admin/"))
      .map((abs) => ({
        path: relative(root, abs),
        text: readFileSync(abs, "utf8"),
      })),
  };
}

/** Read and validate every source from a checkout. Throws on an invalid or stale registry. */
export function loadSources(root = ROOT): Sources {
  const errors = loadValidated<ErrorRegistry>(
    root,
    "errors.json",
    "errors.schema.json",
    validateErrors,
  );
  const enums = loadValidated<EnumRegistry>(
    root,
    "enums.json",
    "enums.schema.json",
    validateEnums,
  );
  const copy = loadValidated<CopyDoc>(
    root,
    "copy.en.json",
    "copy.schema.json",
    (doc) =>
      validateCopy(doc, {
        codes: errors.codes.map((e) => e.code),
        enums: enums.enums,
      }),
  );
  // The translated core packs: checked, not emitted (plans/UK-02.md D4).
  for (const file of readdirSync(join(root, "conformance", "parity")).sort()) {
    const m = /^copy\.(.+)\.json$/.exec(file);
    if (!m || m[1] === "en" || m[1] === "schema") continue;
    loadValidated<CopyDoc>(root, file, "copy.schema.json", (doc) =>
      validateCopyLocale(doc, copy, m[1]!),
    );
  }
  const coverage = [
    ...checkCoverage(errors.codes, scanWorkerSource(readWorkerSource(root))),
    ...checkStageCoverage(
      errors.codes,
      scanStageMatrix(
        readJson(
          join(root, "conformance", "corpus", "v2", "stage-matrix.json"),
        ),
      ),
    ),
  ];
  if (coverage.length > 0) {
    throw new Error(
      `conformance/parity/errors.json is out of step with the Worker or the boot stage machine:\n  ${coverage.join("\n  ")}`,
    );
  }
  const features = readJson(
    join(root, "conformance", "parity", "features.json"),
  ) as {
    reasons: string[];
    features: { id: string; service: string }[];
    sdks: { id: string; manifest: string }[];
  };
  const capabilities: Record<string, SdkCapabilities> = {};
  for (const sdk of features.sdks)
    capabilities[sdk.id] = capabilityTable(
      features,
      readJson(join(root, sdk.manifest)) as CapabilityManifest,
    );
  const corpus = (file: string, key: string): number => {
    const value = (
      readJson(join(root, "conformance", "corpus", "v2", file)) as Record<
        string,
        unknown
      >
    )[key];
    if (typeof value !== "number")
      throw new Error(`conformance/corpus/v2/${file} has no numeric ${key}`);
    return value;
  };
  return {
    errors: errors.codes,
    enums: enums.enums,
    features: features.features.map((f) => f.id),
    reasons: features.reasons,
    capabilities,
    services: loadTable(join(root, "tools", "services.json")).services.map(
      (r) => r.slug,
    ),
    protocol: { ...protocolCore },
    copy,
    corpus: {
      corpusVersion: corpus("cases.json", "corpusVersion"),
      gateMatrixVersion: corpus("gate-matrix.json", "gateMatrixVersion"),
      fingerprintVersion: corpus("fingerprint.json", "fingerprintVersion"),
      stageMatrixVersion: corpus("stage-matrix.json", "stageMatrixVersion"),
      updateMatrixVersion: corpus("update-matrix.json", "updateMatrixVersion"),
      outletMatrixVersion: corpus("outlet-matrix.json", "outletMatrixVersion"),
      planMatrixVersion: corpus("plan-matrix.json", "planMatrixVersion"),
      contentCorpusVersion: corpus(
        "content/cases.json",
        "contentCorpusVersion",
      ),
    },
  };
}

// ── Identifiers ────────────────────────────────────────────────────────────────────────────

/** A value's words: split on `-`, `_` and `.`. `license.channels` → [license, channels]. */
export function words(value: string): string[] {
  return value.split(/[-_.]+/).filter((w) => w.length > 0);
}

/** camelCase. A word that starts with a digit keeps an underscore: `x86_64` → `x86_64`. */
export function camelName(ws: readonly string[]): string {
  return ws
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i === 0) return lower;
      if (/^[0-9]/.test(lower)) return `_${lower}`;
      return lower[0]!.toUpperCase() + lower.slice(1);
    })
    .join("");
}

/** UPPER_SNAKE: `sign-in-failed` → `SIGN_IN_FAILED`. */
export function upperName(ws: readonly string[]): string {
  return ws.map((w) => w.toUpperCase()).join("_");
}

/** `ErrorCode` → `ERROR_CODE`. */
export function pascalToUpper(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names GDScript reserves as built-in constants; an UPPER_SNAKE member may not take one. */
const GDSCRIPT_RESERVED = new Set(["PI", "TAU", "INF", "NAN"]);

/** Godot's all-caps native class and built-in type names. A GDScript constant may not shadow
 *  one (a parse error), so the GDScript renderer writes such a member with a trailing `_`
 *  (`DataOnlyExtension.JSON_`); every other language keeps `upper`. */
export const GDSCRIPT_NATIVE_CLASSES: ReadonlySet<string> = new Set([
  "AABB",
  "IP",
  "JSON",
  "OS",
  "RID",
  "UPNP",
]);

/** The GDScript member name: `upper`, or `upper_` where it would shadow a native class. */
export const gdName = (m: Member): string =>
  GDSCRIPT_NATIVE_CLASSES.has(m.upper) ? `${m.upper}_` : m.upper;

// ── The model ──────────────────────────────────────────────────────────────────────────────

export interface Member {
  value: string;
  /** TypeScript and Swift member name. */
  camel: string;
  /** Python and GDScript member name. */
  upper: string;
}

export interface Group {
  /** PascalCase type name: `ErrorCode`. */
  name: string;
  doc: string;
  members: Member[];
  /** False where the language already declares the type (Swift's `ServiceSlug`). */
  swift: boolean;
  /** Emit only the `*_VALUES` list, in every language: the SDKs declare the type natively
   *  under the same name (see VALUES_ONLY_ENUMS). */
  valuesOnly?: boolean;
}

export type ScalarValue = string | number | string[] | Record<string, string>;

export interface Scalar {
  /** UPPER_SNAKE in every language. */
  name: string;
  doc: string;
  value: ScalarValue;
}

export interface Model {
  groups: Group[];
  /** Registry order, code → kind. */
  errorKinds: [string, ErrorKind][];
  scalars: Scalar[];
  /** Each SDK's capability table, keyed by registry SDK id. */
  capabilities: Record<string, SdkCapabilities>;
  /** The core copy, each section in its source's order; absent when Sources has none. */
  copy?: CopyModel;
}

export interface CopyModel {
  copyVersion: number;
  locale: string;
  fallback: CopyEntry;
  /** errors.json order. */
  codes: [string, CopyEntry][];
  /** licenseStatus order. */
  gate: [string, CopyEntry][];
  /** activationResult order. */
  activation: [string, CopyEntry][];
}

function copyModel(sources: Sources): CopyModel | undefined {
  const copy = sources.copy;
  if (!copy) return undefined;
  const order = (name: string): string[] =>
    sources.enums.find((e) => e.name === name)?.values ?? [];
  const pick = (
    section: Record<string, CopyEntry>,
    keys: readonly string[],
  ): [string, CopyEntry][] =>
    keys.map((k) => {
      const e = section[k];
      if (!e) throw new Error(`copy.${copy.locale}.json has no entry "${k}"`);
      return [k, { title: e.title, message: e.message }];
    });
  return {
    copyVersion: copy.copyVersion,
    locale: copy.locale,
    fallback: { title: copy.fallback.title, message: copy.fallback.message },
    codes: pick(
      copy.codes,
      sources.errors.map((e) => e.code),
    ),
    gate: pick(copy.gate, order("licenseStatus")),
    activation: pick(copy.activation, order("activationResult")),
  };
}

function group(
  name: string,
  doc: string,
  members: Member[],
  swift = true,
  valuesOnly = false,
): Group {
  const camel = new Map<string, string>();
  const upper = new Map<string, string>();
  const gd = new Map<string, string>();
  for (const m of members) {
    for (const [kind, ident, seen] of [
      ["camelCase", m.camel, camel],
      ["UPPER_SNAKE", m.upper, upper],
      ["GDScript", gdName(m), gd],
    ] as const) {
      if (!IDENT.test(ident)) {
        throw new Error(
          `${name}: "${m.value}" maps to "${ident}", which is not a valid ${kind} identifier`,
        );
      }
      const other = seen.get(ident);
      if (other !== undefined) {
        throw new Error(
          `${name}: "${other}" and "${m.value}" both map to the ${kind} identifier "${ident}" — rename one`,
        );
      }
      seen.set(ident, m.value);
    }
    if (GDSCRIPT_RESERVED.has(m.upper)) {
      throw new Error(
        `${name}: "${m.value}" maps to "${m.upper}", a GDScript built-in constant`,
      );
    }
  }
  return valuesOnly
    ? { name, doc, members, swift, valuesOnly }
    : { name, doc, members, swift };
}

const fromValues = (values: readonly string[]): Member[] =>
  values.map((value) => {
    const ws = words(value);
    return { value, camel: camelName(ws), upper: upperName(ws) };
  });

/** The `@polaris-key/protocol/core` exports this generator mirrors as channel constants. */
export const CHANNEL_EXPORT = /^(?:CHANNEL|PR)_[A-Z0-9_]+$/;
/** The `@polaris-key/protocol/core` exports this generator mirrors as the client-metadata
 *  header-value tables (WIRE-CONTRACT-V3 §5.2). */
export const SPELLINGS_EXPORT = /^(?:PLATFORM|ARCH)_SPELLINGS$/;
const HEADER_EXPORT = /^HEADER_([A-Z0-9_]+)$/;
/** The wire contract v4 limits every SDK applies (WIRE-CONTRACT-V4 §1.2, §3). */
export const WIRE_LIMIT_EXPORTS = [
  "MAX_WIRE_INTEGER",
  "MAX_JSON_DEPTH",
  "MAX_RECORD_JWS_BYTES",
  "MAX_FEED_REVOCATIONS",
  "REVOCATION_REASON_MAX_BYTES",
  // plans/P4-29.md §2.2: the feed's delta menu.
  "MAX_FEED_DELTAS",
  "MAX_FEED_DELTAS_PER_TARGET",
  // plans/P4-19.md §2.8: content-key delegation.
  "MAX_DELEGATION_TTL_SECONDS",
  "MAX_DELEGATION_TYPES",
  "DATA_ONLY_HEAD_BYTES",
  "DATA_ONLY_TAIL_BYTES",
  "MAX_DELEGATIONS_PER_CHECK",
] as const;
/** The packs-on-the-wire limits and format strings every SDK applies (plans/P4-01.md §2.13). */
export const PACK_LIMIT_EXPORTS = [
  "MAX_PACK_VARIANTS",
  "MAX_VARIANT_DELTAS",
  "MAX_CONTENT_PINS",
  "MAX_BUILD_EMBEDS",
  "MAX_INDEX_FILES",
  "MAX_FILES_INDEX_BYTES",
  "MAX_PACK_PATH_BYTES",
  "FILES_FORMAT",
  "PATCH_FORMAT",
  "MARKER_FORMAT",
  "CONTENT_STAMP_FORMAT",
  "PLAN_REQUEST_WEIGHT",
  "CHUNKS_FORMAT",
  "MAX_CHUNK_INDEX_BYTES",
  "MAX_CHUNK_BYTES",
] as const;

/** The three P4-10 entries of `PACK_LIMIT_EXPORTS`, documented against plans/P4-10.md. */
const CHUNK_LIMIT_EXPORTS: ReadonlySet<string> = new Set([
  "CHUNKS_FORMAT",
  "MAX_CHUNK_INDEX_BYTES",
  "MAX_CHUNK_BYTES",
]);

function scalarValue(name: string, value: unknown): ScalarValue {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string"))
    return [...value];
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  )
    return { ...(value as Record<string, string>) };
  throw new Error(
    `@polaris-key/protocol/core exports ${name} as a value this generator cannot render (string, integer, string[] or Record<string, string>)`,
  );
}

/** Enums whose PascalCase name an SDK already uses for its own type, so a generated group of that
 *  name would clash with it or shadow it at the package root: `LicenseStatus` is a declared enum
 *  in Swift (PolarisKeyCore/Models.swift) and Kotlin (:core Models.kt), and a type alias in Python
 *  (core/models.py); `ActivationResult` is the activation sum type in Node (license/endpoints.ts),
 *  Python (license/endpoints.py), Swift (PolarisKeyLicense/Endpoints.swift) and Kotlin (:license).
 *  They emit only their `*_VALUES` list, in every language alike, and validateCopy checks the
 *  copy's `gate` and `activation` keys against them (plans/SP-00.md §4). */
export const VALUES_ONLY_ENUMS: ReadonlySet<string> = new Set([
  "licenseStatus",
  "activationResult",
]);

/** Build the language-neutral model. Throws on any identifier collision. */
export function buildModel(sources: Sources): Model {
  const { protocol } = sources;
  const exportNames = Object.keys(protocol).sort();

  const headers: Member[] = exportNames.flatMap((name) => {
    const m = HEADER_EXPORT.exec(name);
    const value = protocol[name];
    if (!m || typeof value !== "string") return [];
    const ws = words(m[1]!.toLowerCase());
    return [{ value, camel: camelName(ws), upper: upperName(ws) }];
  });
  if (headers.length === 0)
    throw new Error("@polaris-key/protocol/core exports no HEADER_* names");

  const protocolVersion = protocol.PROTOCOL_VERSION;
  if (typeof protocolVersion !== "number")
    throw new Error("@polaris-key/protocol/core exports no PROTOCOL_VERSION");

  const groups: Group[] = [
    group(
      "ErrorCode",
      "Every error code the Worker answers with or an SDK raises (conformance/parity/errors.json). Hosts match on these strings.",
      fromValues(sources.errors.map((e) => e.code)),
    ),
    group(
      "Feature",
      "Every feature id in the parity registry (conformance/parity/features.json).",
      fromValues(sources.features),
    ),
    group(
      "UnsupportedReason",
      "Why a feature is unsupported here: the `supports()` reason enum (PARITY §2.2).",
      fromValues(sources.reasons),
    ),
    ...sources.enums.map((def) => {
      const name = def.name[0]!.toUpperCase() + def.name.slice(1);
      return group(
        name,
        def.description,
        fromValues(def.values),
        !SWIFT_DECLARED.has(name),
        VALUES_ONLY_ENUMS.has(def.name),
      );
    }),
    group(
      "HeaderName",
      "The `X-PKey-*` request header names (wire contract v3 §5).",
      headers,
    ),
    group(
      "ServiceSlug",
      "The opt-in services (tools/services.json). Core is not a service — it is always on.",
      fromValues(sources.services),
      false,
    ),
  ];
  const names = new Set<string>();
  for (const g of groups) {
    if (names.has(g.name)) throw new Error(`two groups are named ${g.name}`);
    names.add(g.name);
  }

  const scalars: Scalar[] = [
    {
      name: "PROTOCOL_VERSION",
      doc: "The wire contract version (`@polaris-key/protocol/core`).",
      value: protocolVersion,
    },
    {
      name: "CORPUS_VERSION",
      doc: "`corpusVersion` of conformance/corpus/v2/cases.json.",
      value: sources.corpus.corpusVersion,
    },
    {
      name: "GATE_MATRIX_VERSION",
      doc: "`gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json.",
      value: sources.corpus.gateMatrixVersion,
    },
    {
      name: "FINGERPRINT_VERSION",
      doc: "`fingerprintVersion` of conformance/corpus/v2/fingerprint.json.",
      value: sources.corpus.fingerprintVersion,
    },
    {
      name: "STAGE_MATRIX_VERSION",
      doc: "`stageMatrixVersion` of conformance/corpus/v2/stage-matrix.json.",
      value: sources.corpus.stageMatrixVersion,
    },
    {
      name: "UPDATE_MATRIX_VERSION",
      doc: "`updateMatrixVersion` of conformance/corpus/v2/update-matrix.json.",
      value: sources.corpus.updateMatrixVersion,
    },
    {
      name: "OUTLET_MATRIX_VERSION",
      doc: "`outletMatrixVersion` of conformance/corpus/v2/outlet-matrix.json.",
      value: sources.corpus.outletMatrixVersion,
    },
    {
      name: "PLAN_MATRIX_VERSION",
      doc: "`planMatrixVersion` of conformance/corpus/v2/plan-matrix.json.",
      value: sources.corpus.planMatrixVersion,
    },
    {
      name: "CONTENT_CORPUS_VERSION",
      doc: "`contentCorpusVersion` of conformance/corpus/v2/content/cases.json.",
      value: sources.corpus.contentCorpusVersion,
    },
    ...WIRE_LIMIT_EXPORTS.map((name) => {
      const value = protocol[name];
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw new Error(
          `@polaris-key/protocol/core exports no integer ${name}`,
        );
      return {
        name,
        doc: `Wire contract v4 limit \`${name}\` (\`@polaris-key/protocol/core\`).`,
        value,
      };
    }),
    ...PACK_LIMIT_EXPORTS.map((name) => {
      const value = protocol[name];
      if (
        typeof value !== "string" &&
        (typeof value !== "number" || !Number.isSafeInteger(value))
      )
        throw new Error(
          `@polaris-key/protocol/core exports no integer or string ${name}`,
        );
      return {
        name,
        doc: `Packs on the wire: \`${name}\` (${CHUNK_LIMIT_EXPORTS.has(name) ? "plans/P4-10.md §2.3" : "plans/P4-01.md §2.13"}, \`@polaris-key/protocol/core\`).`,
        value,
      };
    }),
    ...exportNames
      .filter((name) => CHANNEL_EXPORT.test(name))
      .map((name) => ({
        name,
        doc: `Channel constant \`${name}\` (\`@polaris-key/protocol/core\`).`,
        value: scalarValue(name, protocol[name]),
      })),
    ...exportNames
      .filter((name) => SPELLINGS_EXPORT.test(name))
      .map((name) => ({
        name,
        doc: `Header-value table \`${name}\`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, \`@polaris-key/protocol/core\`).`,
        value: scalarValue(name, protocol[name]),
      })),
  ];

  return {
    groups,
    errorKinds: sources.errors.map((e) => [e.code, e.kind]),
    scalars,
    capabilities: sources.capabilities ?? {},
    ...(sources.copy ? { copy: copyModel(sources)! } : {}),
  };
}

// ── Renderers ──────────────────────────────────────────────────────────────────────────────

const q = (s: string): string => JSON.stringify(s);
const valuesName = (g: Group): string => `${pascalToUpper(g.name)}_VALUES`;

function banner(comment: string): string {
  return [
    `${comment} GENERATED FILE — do not edit by hand.`,
    comment,
    `${comment} Written by \`pnpm gen:constants\` (tools/gen-sdk-constants.ts) from conformance/parity/`,
    `${comment} errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core`,
    `${comment} and the conformance corpus. \`pnpm gen:constants -- --check\` fails the green gate on any`,
    `${comment} difference. To change a constant, edit its source and regenerate.`,
    "",
  ].join("\n");
}

function tsScalar(s: Scalar): string {
  const v = s.value;
  if (typeof v === "string" || typeof v === "number")
    return `export const ${s.name} = ${typeof v === "string" ? q(v) : v};`;
  if (Array.isArray(v))
    return `export const ${s.name} = [${v.map(q).join(", ")}] as const;`;
  return `export const ${s.name} = {\n${Object.entries(v)
    .map(([k, x]) => `  ${q(k)}: ${q(x)},`)
    .join("\n")}\n} as const;`;
}

const CAPS_DOC =
  "This SDK's capability table, generated from its parity manifest (tools/capabilities.ts): per feature, the manifest's status, the owning service and every declared (runtime, reason) N/A. `supports()` reads it (P1b-10, PARITY §2.2).";

function tsCaps(caps: SdkCapabilities): string {
  return `/** The parity-registry id of the SDK this module belongs to. */
export const CAPABILITY_SDK = ${q(caps.sdk)};

/** The runtimes this SDK's manifest lists. */
export const CAPABILITY_RUNTIMES = [${caps.runtimes.map(q).join(", ")}] as const;

/** One declared N/A: on \`runtime\`, the feature is unsupported for \`reason\`. */
export interface CapabilityNa {
  readonly runtime: string;
  readonly reason: UnsupportedReason;
}

/** One feature's row in \`CAPABILITIES\`. */
export interface CapabilityRow {
  readonly status: "implemented" | "planned" | "na";
  readonly service: string;
  readonly na: readonly CapabilityNa[];
}

/** ${CAPS_DOC} */
export const CAPABILITIES: Readonly<Record<Feature, CapabilityRow>> = {
${caps.rows
  .map(
    (r) =>
      `  ${q(r.feature)}: { status: ${q(r.status)}, service: ${q(r.service)}, na: [${r.na
        .map((n) => `{ runtime: ${q(n.runtime)}, reason: ${q(n.reason)} }`)
        .join(", ")}] },`,
  )
  .join("\n")}
};

/** SHA-256 of the canonical table; \`pnpm parity:check\` recomputes it from the manifest. */
export const CAPABILITY_DIGEST = ${q(capabilityDigest(caps))};
`;
}

export function renderTs(model: Model, caps?: SdkCapabilities): string {
  const out: string[] = [banner("//")];
  for (const g of model.groups) {
    if (g.valuesOnly) {
      out.push(`/** ${g.doc} Every value, in source order. */
export const ${valuesName(g)}: readonly string[] = [${g.members.map((m) => q(m.value)).join(", ")}];
`);
      continue;
    }
    out.push(`/** ${g.doc} */
export const ${g.name} = {
${g.members.map((m) => `  ${m.camel}: ${q(m.value)},`).join("\n")}
} as const;
export type ${g.name} = (typeof ${g.name})[keyof typeof ${g.name}];

/** Every \`${g.name}\` value, in source order. */
export const ${valuesName(g)}: readonly ${g.name}[] = [${g.members.map((m) => q(m.value)).join(", ")}];
`);
    if (g.name === "ErrorCode") {
      out.push(`/** \`wire\`: appears in a Worker response body. \`client\`: raised only by an SDK. */
export type ErrorCodeKind = "wire" | "client";

/** The registry: every error code and its kind. */
export const ERROR_CODE_KINDS: Readonly<Record<ErrorCode, ErrorCodeKind>> = {
${model.errorKinds.map(([code, kind]) => `  ${q(code)}: ${q(kind)},`).join("\n")}
};
`);
    }
  }
  for (const s of model.scalars) out.push(`/** ${s.doc} */\n${tsScalar(s)}\n`);
  if (caps) out.push(tsCaps(caps));
  return out.join("\n");
}

function pyLiteral(v: ScalarValue): string {
  if (typeof v === "string") return q(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v))
    return v.length === 0
      ? "()"
      : `(\n${v.map((x) => `    ${q(x)},\n`).join("")})`;
  return `MappingProxyType(\n    {\n${Object.entries(v)
    .map(([k, x]) => `        ${q(k)}: ${q(x)},\n`)
    .join("")}    }\n)`;
}

function pyType(v: ScalarValue): string {
  if (typeof v === "string") return "Final[str]";
  if (typeof v === "number") return "Final[int]";
  if (Array.isArray(v)) return "Tuple[str, ...]";
  return "Mapping[str, str]";
}

function pyCaps(caps: SdkCapabilities): string {
  return `

class CapabilityNa(NamedTuple):
    """One declared N/A: on \`\`runtime\`\`, the feature is unsupported for \`\`reason\`\`."""

    runtime: str
    reason: str


class CapabilityRow(NamedTuple):
    """One feature's row in \`\`CAPABILITIES\`\`."""

    status: str
    service: str
    na: Tuple[CapabilityNa, ...]


#: The parity-registry id of the SDK this module belongs to.
CAPABILITY_SDK: Final[str] = ${q(caps.sdk)}

#: The runtimes this SDK's manifest lists.
CAPABILITY_RUNTIMES: Tuple[str, ...] = ${pyLiteral(caps.runtimes)}

#: ${CAPS_DOC}
CAPABILITIES: Mapping[str, CapabilityRow] = MappingProxyType(
    {
${caps.rows
  .map(
    (r) =>
      `        ${q(r.feature)}: CapabilityRow(${q(r.status)}, ${q(r.service)}, (${r.na
        .map((n) => `CapabilityNa(${q(n.runtime)}, ${q(n.reason)}),`)
        .join(" ")})),\n`,
  )
  .join("")}    }
)

#: SHA-256 of the canonical table; \`\`pnpm parity:check\`\` recomputes it from the manifest.
CAPABILITY_DIGEST: Final[str] = ${q(capabilityDigest(caps))}
`;
}

const PY_CAPS_EXPORTS = [
  "CapabilityNa",
  "CapabilityRow",
  "CAPABILITY_SDK",
  "CAPABILITY_RUNTIMES",
  "CAPABILITIES",
  "CAPABILITY_DIGEST",
];

export function renderPython(model: Model, caps?: SdkCapabilities): string {
  const exported = [
    ...model.groups.flatMap((g) =>
      g.valuesOnly ? [valuesName(g)] : [g.name, valuesName(g)],
    ),
    "ERROR_CODE_KINDS",
    ...model.scalars.map((s) => s.name),
    ...(caps ? PY_CAPS_EXPORTS : []),
  ];
  const out: string[] = [
    `${banner("#")}"""Polaris Key's shared constants: error codes, header names, enums, feature ids, versions."""

from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping, ${caps ? "NamedTuple, " : ""}Tuple

__all__ = [
${exported.map((n) => `    ${q(n)},`).join("\n")}
]
`,
  ];
  for (const g of model.groups) {
    if (g.valuesOnly) {
      out.push(`

#: ${g.doc} Every value, in source order.
${valuesName(g)}: Tuple[str, ...] = ${pyLiteral(g.members.map((m) => m.value))}
`);
      continue;
    }
    out.push(`

class ${g.name}:
    """${g.doc}"""

${g.members.map((m) => `    ${m.upper}: Final = ${q(m.value)}`).join("\n")}


#: Every \`\`${g.name}\`\` value, in source order.
${valuesName(g)}: Tuple[str, ...] = ${pyLiteral(g.members.map((m) => m.value))}
`);
    if (g.name === "ErrorCode") {
      out.push(`

#: The registry: every error code and its kind (\`\`wire\`\` or \`\`client\`\`).
ERROR_CODE_KINDS: Mapping[str, str] = ${pyLiteral(Object.fromEntries(model.errorKinds))}
`);
    }
  }
  for (const s of model.scalars) {
    out.push(`

#: ${s.doc}
${s.name}: ${pyType(s.value)} = ${pyLiteral(s.value)}
`);
  }
  if (caps) out.push(pyCaps(caps));
  return out.join("");
}

/** A camelCase member as a Swift identifier, back-ticked if it is a keyword. */
export function swiftIdent(camel: string): string {
  return SWIFT_KEYWORDS.has(camel) ? `\`${camel}\`` : camel;
}

function swiftScalar(s: Scalar): string {
  const v = s.value;
  if (typeof v === "string") return `public let ${s.name} = ${q(v)}`;
  if (typeof v === "number") return `public let ${s.name} = ${v}`;
  if (Array.isArray(v))
    return `public let ${s.name}: [String] = [${v.map(q).join(", ")}]`;
  const entries = Object.entries(v);
  return entries.length === 0
    ? `public let ${s.name}: [String: String] = [:]`
    : `public let ${s.name}: [String: String] = [\n${entries.map(([k, x]) => `    ${q(k)}: ${q(x)},`).join("\n")}\n]`;
}

/** Enum groups Swift declares by hand as `String`-backed enums, so a generated caseless enum of
 *  the same name would clash. `KeychainStoreTests` pins their raw values. */
export const SWIFT_DECLARED: ReadonlySet<string> = new Set([
  "StoreBackend", // Store.swift (P1b-09)
  "StoreDegradedReason", // Store.swift (P1b-09)
]);

function swiftCaps(caps: SdkCapabilities): string {
  return `
/// One declared N/A: on \`runtime\`, the feature is unsupported for \`reason\`.
public struct CapabilityNa: Sendable, Equatable {
    public let runtime: String
    public let reason: String

    public init(runtime: String, reason: String) {
        self.runtime = runtime
        self.reason = reason
    }
}

/// One feature's row in \`CAPABILITIES\`.
public struct CapabilityRow: Sendable, Equatable {
    public let status: String
    public let service: String
    public let na: [CapabilityNa]

    public init(status: String, service: String, na: [CapabilityNa]) {
        self.status = status
        self.service = service
        self.na = na
    }
}

/// The parity-registry id of the SDK this module belongs to.
public let CAPABILITY_SDK = ${q(caps.sdk)}

/// The runtimes this SDK's manifest lists.
public let CAPABILITY_RUNTIMES: [String] = [${caps.runtimes.map(q).join(", ")}]

/// ${CAPS_DOC}
public let CAPABILITIES: [String: CapabilityRow] = [
${caps.rows
  .map(
    (r) =>
      `    ${q(r.feature)}: CapabilityRow(status: ${q(r.status)}, service: ${q(r.service)}, na: [${r.na
        .map(
          (n) =>
            `CapabilityNa(runtime: ${q(n.runtime)}, reason: ${q(n.reason)})`,
        )
        .join(", ")}]),`,
  )
  .join("\n")}
]

/// SHA-256 of the canonical table; \`pnpm parity:check\` recomputes it from the manifest.
public let CAPABILITY_DIGEST = ${q(capabilityDigest(caps))}
`;
}

export function renderSwift(model: Model, caps?: SdkCapabilities): string {
  const out: string[] = [
    `${banner("//")}
// \`ServiceSlug\` is not here: ServiceSlug.generated.swift (pnpm gen:services) declares it.
// \`StoreBackend\` and \`StoreDegradedReason\` are not here: Store.swift declares them as
// \`String\`-backed enums.
`,
  ];
  for (const g of model.groups) {
    if (!g.swift) continue;
    if (g.valuesOnly) {
      out.push(`
/// ${g.doc} Every value, in source order.
public let ${valuesName(g)}: [String] = [
${g.members.map((m) => `    ${q(m.value)},`).join("\n")}
]
`);
      continue;
    }
    out.push(`
/// ${g.doc}
public enum ${g.name} {
${g.members.map((m) => `    public static let ${swiftIdent(m.camel)} = ${q(m.value)}`).join("\n")}
}

/// Every \`${g.name}\` value, in source order.
public let ${valuesName(g)}: [String] = [
${g.members.map((m) => `    ${q(m.value)},`).join("\n")}
]
`);
    if (g.name === "ErrorCode") {
      out.push(`
/// The registry: every error code and its kind (\`wire\` or \`client\`).
public let ERROR_CODE_KINDS: [String: String] = [
${model.errorKinds.map(([code, kind]) => `    ${q(code)}: ${q(kind)},`).join("\n")}
]
`);
    }
  }
  for (const s of model.scalars)
    out.push(`\n/// ${s.doc}\n${swiftScalar(s)}\n`);
  if (caps) out.push(swiftCaps(caps));
  return out.join("");
}

function gdLiteral(v: ScalarValue): string {
  if (typeof v === "string") return q(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(q).join(", ")}]`;
  const entries = Object.entries(v);
  return entries.length === 0
    ? "{}"
    : `{\n${entries.map(([k, x]) => `\t${q(k)}: ${q(x)},`).join("\n")}\n}`;
}

/** The GDScript module's global class name. */
export const GDSCRIPT_CLASS = "PKeyConstants";

function gdCaps(caps: SdkCapabilities): string {
  return `
## The parity-registry id of the SDK this module belongs to.
const CAPABILITY_SDK := ${q(caps.sdk)}

## The runtimes this SDK's manifest lists.
const CAPABILITY_RUNTIMES := ${gdLiteral(caps.runtimes)}

## ${CAPS_DOC}
## Each row is {status, service, na: [{runtime, reason}]}. A function, not a const, so every call
## builds a fresh Dictionary that any thread may read.
static func capabilities() -> Dictionary:
\treturn {
${caps.rows
  .map(
    (r) =>
      `\t\t${q(r.feature)}: {"status": ${q(r.status)}, "service": ${q(r.service)}, "na": [${r.na
        .map((n) => `{"runtime": ${q(n.runtime)}, "reason": ${q(n.reason)}}`)
        .join(", ")}]},`,
  )
  .join("\n")}
\t}

## SHA-256 of the canonical table; \`pnpm parity:check\` recomputes it from the manifest.
const CAPABILITY_DIGEST := ${q(capabilityDigest(caps))}
`;
}

export function renderGdscript(model: Model, caps?: SdkCapabilities): string {
  const out: string[] = [
    `${banner("#")}class_name ${GDSCRIPT_CLASS}
extends RefCounted
## Polaris Key's shared constants: error codes, header names, enums, feature ids, versions.
## Read them as \`${GDSCRIPT_CLASS}.ErrorCode.SERVICE_UNAVAILABLE\`, \`${GDSCRIPT_CLASS}.PROTOCOL_VERSION\`.
`,
  ];
  for (const g of model.groups) {
    if (g.valuesOnly) {
      out.push(`

## ${g.doc} Every value, in source order.
const ${valuesName(g)} := ${gdLiteral(g.members.map((m) => m.value))}
`);
      continue;
    }
    out.push(`

## ${g.doc}
class ${g.name}:
${g.members.map((m) => `\tconst ${gdName(m)} := ${q(m.value)}`).join("\n")}


## Every \`${g.name}\` value, in source order.
const ${valuesName(g)} := ${gdLiteral(g.members.map((m) => m.value))}
`);
    if (g.name === "ErrorCode") {
      out.push(`
## The registry: every error code and its kind (\`wire\` or \`client\`).
const ERROR_CODE_KINDS := ${gdLiteral(Object.fromEntries(model.errorKinds))}
`);
    }
  }
  for (const s of model.scalars)
    out.push(`\n## ${s.doc}\nconst ${s.name} := ${gdLiteral(s.value)}\n`);
  if (caps) out.push(gdCaps(caps));
  return out.join("");
}

/** A Kotlin string literal: JSON's escapes, plus `$` (a template in Kotlin) and `\f` (no Kotlin escape). */
export function ktq(value: string): string {
  return JSON.stringify(value).replace(/\$/g, "\\$").replace(/\\f/g, "\\u000C");
}

/** A camelCase member as a Kotlin identifier, back-ticked if it is a hard keyword. */
export function kotlinIdent(camel: string): string {
  return KOTLIN_KEYWORDS.has(camel) ? `\`${camel}\`` : camel;
}

/** Groups the Kotlin SDK declares by hand: `ServiceSlug` is ServiceSlug.generated.kt (gen:services). */
export const KOTLIN_DECLARED: ReadonlySet<string> = new Set(["ServiceSlug"]);

function kotlinScalar(s: Scalar): string {
  const v = s.value;
  if (typeof v === "string")
    return `public const val ${s.name}: String = ${ktq(v)}`;
  if (typeof v === "number")
    return Math.abs(v) <= 2147483647
      ? `public const val ${s.name}: Int = ${v}`
      : `public const val ${s.name}: Long = ${v}L`;
  if (Array.isArray(v))
    return `public val ${s.name}: List<String> = listOf(${v.map(ktq).join(", ")})`;
  const entries = Object.entries(v);
  return entries.length === 0
    ? `public val ${s.name}: Map<String, String> = emptyMap()`
    : `public val ${s.name}: Map<String, String> = mapOf(\n${entries.map(([k, x]) => `    ${ktq(k)} to ${ktq(x)},`).join("\n")}\n)`;
}

function kotlinCaps(caps: SdkCapabilities): string {
  return `
/** One declared N/A: on \`runtime\`, the feature is unsupported for \`reason\`. */
public data class CapabilityNa(val runtime: String, val reason: String)

/** One feature's row in \`CAPABILITIES\`. */
public data class CapabilityRow(val status: String, val service: String, val na: List<CapabilityNa>)

/** The parity-registry id of the SDK this module belongs to. */
public const val CAPABILITY_SDK: String = ${ktq(caps.sdk)}

/** The runtimes this SDK's manifest lists. */
public val CAPABILITY_RUNTIMES: List<String> = listOf(${caps.runtimes.map(ktq).join(", ")})

/** ${CAPS_DOC} */
public val CAPABILITIES: Map<String, CapabilityRow> = mapOf(
${caps.rows
  .map(
    (r) =>
      `    ${ktq(r.feature)} to CapabilityRow(${ktq(r.status)}, ${ktq(r.service)}, listOf(${r.na
        .map((n) => `CapabilityNa(${ktq(n.runtime)}, ${ktq(n.reason)})`)
        .join(", ")})),`,
  )
  .join("\n")}
)

/** SHA-256 of the canonical table; \`pnpm parity:check\` recomputes it from the manifest. */
public const val CAPABILITY_DIGEST: String = ${ktq(capabilityDigest(caps))}
`;
}

export function renderKotlin(model: Model, caps?: SdkCapabilities): string {
  const out: string[] = [
    `${banner("//")}
// \`ServiceSlug\` is not here: ServiceSlug.generated.kt (pnpm gen:services) declares it.

@file:Suppress("unused", "ObjectPropertyName")

package im.plrs.key.core
`,
  ];
  for (const g of model.groups) {
    if (KOTLIN_DECLARED.has(g.name)) continue;
    if (g.valuesOnly) {
      out.push(`
/** ${g.doc} Every value, in source order. */
public val ${valuesName(g)}: List<String> = listOf(
${g.members.map((m) => `    ${ktq(m.value)},`).join("\n")}
)
`);
      continue;
    }
    out.push(`
/** ${g.doc} */
public object ${g.name} {
${g.members.map((m) => `    public const val ${kotlinIdent(m.camel)}: String = ${ktq(m.value)}`).join("\n")}
}

/** Every \`${g.name}\` value, in source order. */
public val ${valuesName(g)}: List<String> = listOf(
${g.members.map((m) => `    ${ktq(m.value)},`).join("\n")}
)
`);
    if (g.name === "ErrorCode") {
      out.push(`
/** The registry: every error code and its kind (\`wire\` or \`client\`). */
public val ERROR_CODE_KINDS: Map<String, String> = mapOf(
${model.errorKinds.map(([code, kind]) => `    ${ktq(code)} to ${ktq(kind)},`).join("\n")}
)
`);
    }
  }
  for (const s of model.scalars)
    out.push(`\n/** ${s.doc} */\n${kotlinScalar(s)}\n`);
  if (caps) out.push(kotlinCaps(caps));
  return out.join("");
}

// ── Core copy renderers (core.copy, plans/SP-00.md §4) ────────────────────────────────────
//
// One SEPARATE module per SDK, data only: the English copy every SDK's `copy.message(code)` /
// `copy.title(code)` reads once its SP task wires it in. The names match up to casing (PARITY
// §2.1): COPY_VERSION, COPY_LOCALE, COPY_PLACEHOLDERS, COPY_FALLBACK, COPY_CODES, COPY_GATE and
// COPY_ACTIVATION, plus a `CopyEntry` {title, message} type where the language needs one.

function copyBanner(comment: string): string {
  return [
    `${comment} GENERATED FILE — do not edit by hand.`,
    comment,
    `${comment} Written by \`pnpm gen:constants\` (tools/gen-sdk-constants.ts) from conformance/parity/`,
    `${comment} copy.en.json, checked against errors.json and enums.json (licenseStatus, activationResult).`,
    `${comment} \`pnpm gen:constants -- --check\` fails the green gate on any difference. To change a string,`,
    `${comment} edit copy.en.json and regenerate.`,
    "",
  ].join("\n");
}

const COPY_DOC =
  "The core copy (core.copy): a title and message per error code, gate status (licenseStatus) and activation result (activationResult). A code missing from COPY_CODES shows COPY_FALLBACK with {code} filled in, never the raw body.";

function requireCopy(model: Model): CopyModel {
  if (!model.copy) throw new Error("the model carries no core copy");
  return model.copy;
}

export function renderCopyTs(model: Model): string {
  const c = requireCopy(model);
  const entry = (e: CopyEntry): string =>
    `{ title: ${q(e.title)}, message: ${q(e.message)} }`;
  const table = (name: string, doc: string, rows: [string, CopyEntry][]) =>
    `/** ${doc} */
export const ${name}: Readonly<Record<string, CopyEntry>> = {
${rows.map(([k, e]) => `  ${q(k)}: ${entry(e)},`).join("\n")}
};
`;
  return [
    copyBanner("//"),
    `// ${COPY_DOC}

/** One piece of core copy. */
export interface CopyEntry {
  readonly title: string;
  readonly message: string;
}

export const COPY_VERSION = ${c.copyVersion};
export const COPY_LOCALE = ${q(c.locale)};
/** The only placeholders a copy string may hold, each written \`{name}\`. */
export const COPY_PLACEHOLDERS: readonly string[] = [${COPY_PLACEHOLDERS.map(q).join(", ")}];
/** Shown for a code this table does not know, with {code} filled in. */
export const COPY_FALLBACK: CopyEntry = ${entry(c.fallback)};
`,
    table("COPY_CODES", "Per error code (errors.json order).", c.codes),
    table("COPY_GATE", "Per licenseStatus.", c.gate),
    table("COPY_ACTIVATION", "Per activationResult.", c.activation),
  ].join("\n");
}

export function renderCopyPython(model: Model): string {
  const c = requireCopy(model);
  const entry = (e: CopyEntry): string =>
    `CopyEntry(${q(e.title)}, ${q(e.message)})`;
  const table = (name: string, doc: string, rows: [string, CopyEntry][]) =>
    `

#: ${doc}
${name}: Mapping[str, CopyEntry] = MappingProxyType(
    {
${rows.map(([k, e]) => `        ${q(k)}: ${entry(e)},`).join("\n")}
    }
)
`;
  return [
    copyBanner("#"),
    `"""Polaris Key's core copy (core.copy). ${COPY_DOC}"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping, NamedTuple, Tuple

__all__ = [
    "CopyEntry",
    "COPY_VERSION",
    "COPY_LOCALE",
    "COPY_PLACEHOLDERS",
    "COPY_FALLBACK",
    "COPY_CODES",
    "COPY_GATE",
    "COPY_ACTIVATION",
]


class CopyEntry(NamedTuple):
    """One piece of core copy."""

    title: str
    message: str


COPY_VERSION: Final = ${c.copyVersion}
COPY_LOCALE: Final = ${q(c.locale)}
#: The only placeholders a copy string may hold, each written \`\`{name}\`\`.
COPY_PLACEHOLDERS: Tuple[str, ...] = (${COPY_PLACEHOLDERS.map(q).join(", ")})
#: Shown for a code this table does not know, with {code} filled in.
COPY_FALLBACK: Final = ${entry(c.fallback)}`,
    table("COPY_CODES", "Per error code (errors.json order).", c.codes),
    table("COPY_GATE", "Per licenseStatus.", c.gate),
    table("COPY_ACTIVATION", "Per activationResult.", c.activation),
  ].join("");
}

export function renderCopySwift(model: Model): string {
  const c = requireCopy(model);
  const entry = (e: CopyEntry): string =>
    `CopyEntry(title: ${q(e.title)}, message: ${q(e.message)})`;
  const table = (name: string, doc: string, rows: [string, CopyEntry][]) =>
    `
/// ${doc}
public let ${name}: [String: CopyEntry] = [
${rows.map(([k, e]) => `    ${q(k)}: ${entry(e)},`).join("\n")}
]
`;
  return [
    copyBanner("//"),
    `// ${COPY_DOC}

/// One piece of core copy.
public struct CopyEntry: Sendable, Equatable {
    public let title: String
    public let message: String

    public init(title: String, message: String) {
        self.title = title
        self.message = message
    }
}

public let COPY_VERSION = ${c.copyVersion}
public let COPY_LOCALE = ${q(c.locale)}
/// The only placeholders a copy string may hold, each written \`{name}\`.
public let COPY_PLACEHOLDERS: [String] = [${COPY_PLACEHOLDERS.map(q).join(", ")}]
/// Shown for a code this table does not know, with {code} filled in.
public let COPY_FALLBACK = ${entry(c.fallback)}
`,
    table("COPY_CODES", "Per error code (errors.json order).", c.codes),
    table("COPY_GATE", "Per licenseStatus.", c.gate),
    table("COPY_ACTIVATION", "Per activationResult.", c.activation),
  ].join("");
}

/** The GDScript copy module's class name (beside \`PKeyConstants\`). */
export const GDSCRIPT_COPY_CLASS = "PKeyCoreCopy";

export function renderCopyGdscript(model: Model): string {
  const c = requireCopy(model);
  const entry = (e: CopyEntry): string =>
    `{"title": ${q(e.title)}, "message": ${q(e.message)}}`;
  const table = (name: string, doc: string, rows: [string, CopyEntry][]) =>
    `
## ${doc}
const ${name} := {
${rows.map(([k, e]) => `\t${q(k)}: ${entry(e)},`).join("\n")}
}
`;
  return [
    copyBanner("#"),
    `class_name ${GDSCRIPT_COPY_CLASS}
extends RefCounted
## ${COPY_DOC}
## Each entry is {"title": String, "message": String}.

const COPY_VERSION := ${c.copyVersion}
const COPY_LOCALE := ${q(c.locale)}
## The only placeholders a copy string may hold, each written \`{name}\`.
const COPY_PLACEHOLDERS := [${COPY_PLACEHOLDERS.map(q).join(", ")}]
## Shown for a code this table does not know, with {code} filled in.
const COPY_FALLBACK := ${entry(c.fallback)}
`,
    table("COPY_CODES", "Per error code (errors.json order).", c.codes),
    table("COPY_GATE", "Per licenseStatus.", c.gate),
    table("COPY_ACTIVATION", "Per activationResult.", c.activation),
  ].join("");
}

export function renderCopyKotlin(model: Model): string {
  const c = requireCopy(model);
  const entry = (e: CopyEntry): string =>
    `CopyEntry(${ktq(e.title)}, ${ktq(e.message)})`;
  const table = (name: string, doc: string, rows: [string, CopyEntry][]) =>
    `
/** ${doc} */
public val ${name}: Map<String, CopyEntry> = mapOf(
${rows.map(([k, e]) => `    ${ktq(k)} to ${entry(e)},`).join("\n")}
)
`;
  return [
    copyBanner("//"),
    `// ${COPY_DOC}

@file:Suppress("unused")

package im.plrs.key.core

/** One piece of core copy. */
public data class CopyEntry(public val title: String, public val message: String)

public const val COPY_VERSION: Int = ${c.copyVersion}
public const val COPY_LOCALE: String = ${ktq(c.locale)}

/** The only placeholders a copy string may hold, each written \`{name}\`. */
public val COPY_PLACEHOLDERS: List<String> = listOf(${COPY_PLACEHOLDERS.map(ktq).join(", ")})

/** Shown for a code this table does not know, with {code} filled in. */
public val COPY_FALLBACK: CopyEntry = ${entry(c.fallback)}
`,
    table("COPY_CODES", "Per error code (errors.json order).", c.codes),
    table("COPY_GATE", "Per licenseStatus.", c.gate),
    table("COPY_ACTIVATION", "Per activationResult.", c.activation),
  ].join("");
}

// ── Targets ────────────────────────────────────────────────────────────────────────────────

export interface Target {
  /** Repo-relative path. */
  path: string;
  render: (model: Model, caps?: SdkCapabilities) => string;
  /** The registry SDK id whose capability table this module carries. */
  sdk: string;
  /** Prettier parser, for the targets `pnpm lint` checks. */
  parser?: "typescript";
  /** Written only while this repo-relative directory exists. */
  onlyIfDir?: string;
}

export const TARGETS: readonly Target[] = [
  {
    path: "packages/sdk-node/src/constants.generated.ts",
    sdk: "node",
    render: renderTs,
    parser: "typescript",
  },
  {
    path: "packages/sdk-react/src/constants.generated.ts",
    sdk: "react",
    render: renderTs,
    parser: "typescript",
  },
  {
    path: "sdks/python/src/polaris_key/constants_generated.py",
    sdk: "python",
    render: renderPython,
  },
  {
    path: "sdks/swift/Sources/PolarisKeyCore/Constants.generated.swift",
    sdk: "swift",
    render: renderSwift,
  },
  {
    path: "sdks/godot/addons/polaris_key/core/constants_generated.gd",
    sdk: "godot",
    render: renderGdscript,
    onlyIfDir: "sdks/godot/addons/polaris_key",
  },
  {
    path: "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Constants.generated.kt",
    sdk: "kotlin",
    render: renderKotlin,
  },
];

/** The core copy modules, one per SDK, each separate from its constants module (plans/SP-00.md
 *  §4). They carry no capability table. */
export const COPY_TARGETS: readonly Target[] = [
  {
    path: "packages/sdk-node/src/copy.generated.ts",
    sdk: "node",
    render: renderCopyTs,
    parser: "typescript",
  },
  {
    path: "packages/sdk-react/src/copy.generated.ts",
    sdk: "react",
    render: renderCopyTs,
    parser: "typescript",
  },
  {
    path: "sdks/python/src/polaris_key/copy_generated.py",
    sdk: "python",
    render: renderCopyPython,
  },
  {
    path: "sdks/swift/Sources/PolarisKeyCore/Copy.generated.swift",
    sdk: "swift",
    render: renderCopySwift,
  },
  {
    path: "sdks/godot/addons/polaris_key/core/copy_generated.gd",
    sdk: "godot",
    render: renderCopyGdscript,
    onlyIfDir: "sdks/godot/addons/polaris_key",
  },
  {
    path: "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Copy.generated.kt",
    sdk: "kotlin",
    render: renderCopyKotlin,
  },
];

/** Every applicable generated file's content, keyed by repo-relative path. */
export async function renderAll(
  model: Model,
  root = ROOT,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const target of [...TARGETS, ...(model.copy ? COPY_TARGETS : [])]) {
    if (target.onlyIfDir && !existsSync(join(root, target.onlyIfDir))) continue;
    let content = target.render(model, model.capabilities[target.sdk]);
    if (target.parser) {
      const options =
        (await prettier.resolveConfig(join(ROOT, target.path))) ?? {};
      content = await prettier.format(content, {
        ...options,
        parser: target.parser,
      });
    }
    out.set(target.path, content);
  }
  return out;
}

/** Write (or, with `check`, compare) every target. Returns the stale paths. */
export async function run(opts: {
  check: boolean;
  root?: string;
  model?: Model;
}): Promise<string[]> {
  const root = opts.root ?? ROOT;
  const model = opts.model ?? buildModel(loadSources());
  const stale: string[] = [];
  for (const [path, content] of await renderAll(model, root)) {
    const abs = join(root, path);
    let current: string | undefined;
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    stale.push(path);
    if (opts.check) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return stale;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let stale: string[];
  try {
    stale = await run({ check });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  if (check) {
    for (const path of stale)
      console.error(`stale: ${path} — run \`pnpm gen:constants\``);
    if (stale.length > 0) process.exit(1);
    console.log(
      "up to date: every generated SDK constants and core copy module",
    );
    return;
  }
  for (const path of stale) console.log(`wrote ${path}`);
  if (stale.length === 0) console.log("nothing to write");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
