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
//   tools/services.json                 the service slugs (P0-09)
//   @polaris-key/protocol/core          PROTOCOL_VERSION, the HEADER_* names, every
//                                       CHANNEL_* / PR_* channel constant (P0-04) and the
//                                       PLATFORM_SPELLINGS / ARCH_SPELLINGS header-value tables
//                                       (WIRE-CONTRACT-V3 §5.2, P1b-04) — read as exports, so a
//                                       constant added there flows through here
//                                       and the wire contract v4 limits MAX_WIRE_INTEGER,
//                                       MAX_JSON_DEPTH and MAX_RECORD_JWS_BYTES, and the
//                                       PACK_LIMIT_EXPORTS (plans/P4-01.md §2.13)
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
// reads the same table and emits a `ServiceSlug` group of its own — except in Swift, where
// `ServiceSlug.generated.swift` already declares the enum and a second declaration would clash.

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
import { loadTable, SWIFT_KEYWORDS } from "./gen-services.js";

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

/** Everything the renderers need, already read. Tests build one by hand. */
export interface Sources {
  errors: ErrorEntry[];
  enums: EnumDef[];
  features: string[];
  reasons: string[];
  services: string[];
  /** The `@polaris-key/protocol/core` module namespace (or a stand-in with the same exports). */
  protocol: Record<string, unknown>;
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
  ) as { reasons: string[]; features: { id: string }[] };
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
    services: loadTable(join(root, "tools", "services.json")).services.map(
      (r) => r.slug,
    ),
    protocol: { ...protocolCore },
    corpus: {
      corpusVersion: corpus("cases.json", "corpusVersion"),
      gateMatrixVersion: corpus("gate-matrix.json", "gateMatrixVersion"),
      fingerprintVersion: corpus("fingerprint.json", "fingerprintVersion"),
      stageMatrixVersion: corpus("stage-matrix.json", "stageMatrixVersion"),
      updateMatrixVersion: corpus("update-matrix.json", "updateMatrixVersion"),
      outletMatrixVersion: corpus("outlet-matrix.json", "outletMatrixVersion"),
      planMatrixVersion: corpus("plan-matrix.json", "planMatrixVersion"),
      contentCorpusVersion: corpus("content/cases.json", "contentCorpusVersion"),
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
}

function group(
  name: string,
  doc: string,
  members: Member[],
  swift = true,
): Group {
  const camel = new Map<string, string>();
  const upper = new Map<string, string>();
  for (const m of members) {
    for (const [kind, ident, seen] of [
      ["camelCase", m.camel, camel],
      ["UPPER_SNAKE", m.upper, upper],
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
  return { name, doc, members, swift };
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
] as const;

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
        doc: `Packs on the wire: \`${name}\` (plans/P4-01.md §2.13, \`@polaris-key/protocol/core\`).`,
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

export function renderTs(model: Model): string {
  const out: string[] = [banner("//")];
  for (const g of model.groups) {
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

export function renderPython(model: Model): string {
  const exported = [
    ...model.groups.flatMap((g) => [g.name, valuesName(g)]),
    "ERROR_CODE_KINDS",
    ...model.scalars.map((s) => s.name),
  ];
  const out: string[] = [
    `${banner("#")}"""Polaris Key's shared constants: error codes, header names, enums, feature ids, versions."""

from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping, Tuple

__all__ = [
${exported.map((n) => `    ${q(n)},`).join("\n")}
]
`,
  ];
  for (const g of model.groups) {
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

export function renderSwift(model: Model): string {
  const out: string[] = [
    `${banner("//")}
// \`ServiceSlug\` is not here: ServiceSlug.generated.swift (pnpm gen:services) declares it.
// \`StoreBackend\` and \`StoreDegradedReason\` are not here: Store.swift declares them as
// \`String\`-backed enums.
`,
  ];
  for (const g of model.groups) {
    if (!g.swift) continue;
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

export function renderGdscript(model: Model): string {
  const out: string[] = [
    `${banner("#")}class_name ${GDSCRIPT_CLASS}
extends RefCounted
## Polaris Key's shared constants: error codes, header names, enums, feature ids, versions.
## Read them as \`${GDSCRIPT_CLASS}.ErrorCode.SERVICE_UNAVAILABLE\`, \`${GDSCRIPT_CLASS}.PROTOCOL_VERSION\`.
`,
  ];
  for (const g of model.groups) {
    out.push(`

## ${g.doc}
class ${g.name}:
${g.members.map((m) => `\tconst ${m.upper} := ${q(m.value)}`).join("\n")}


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
  return out.join("");
}

// ── Targets ────────────────────────────────────────────────────────────────────────────────

export interface Target {
  /** Repo-relative path. */
  path: string;
  render: (model: Model) => string;
  /** Prettier parser, for the targets `pnpm lint` checks. */
  parser?: "typescript";
  /** Written only while this repo-relative directory exists. */
  onlyIfDir?: string;
}

export const TARGETS: readonly Target[] = [
  {
    path: "packages/sdk-node/src/constants.generated.ts",
    render: renderTs,
    parser: "typescript",
  },
  {
    path: "packages/sdk-react/src/constants.generated.ts",
    render: renderTs,
    parser: "typescript",
  },
  {
    path: "sdks/python/src/polaris_key/constants_generated.py",
    render: renderPython,
  },
  {
    path: "sdks/swift/Sources/PolarisKeyCore/Constants.generated.swift",
    render: renderSwift,
  },
  {
    path: "sdks/godot/addons/polaris_key/core/constants_generated.gd",
    render: renderGdscript,
    onlyIfDir: "sdks/godot/addons/polaris_key",
  },
];

/** Every applicable generated file's content, keyed by repo-relative path. */
export async function renderAll(
  model: Model,
  root = ROOT,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const target of TARGETS) {
    if (target.onlyIfDir && !existsSync(join(root, target.onlyIfDir))) continue;
    let content = target.render(model);
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
    console.log("up to date: every generated SDK constants module");
    return;
  }
  for (const path of stale) console.log(`wrote ${path}`);
  if (stale.length === 0) console.log("nothing to write");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
