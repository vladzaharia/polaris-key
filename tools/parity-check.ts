// The parity gate (PARITY §3.2): every SDK declares every registry feature as `implemented`,
// `na` or `planned`, and the declaration has to be true.
//
//   pnpm parity:check            # read-only; one line per violation, exit 1 on any
//   pnpm parity:check -- --check # the same (accepted for symmetry with gen:corpus --check)
//
// Inputs, all hand-written:
//
//   conformance/parity/features.json        the registry (+ features.schema.json)
//   <sdk>/parity.json                        one manifest per SDK (+ manifest.schema.json)
//   `@pkey-feature <id> [<id>…]` comments    in the tests under each manifest's testRoots
//   docs/research/…/program/workpackages.json   which work packages exist and are open
//
// It fails when:
//
//   1. a registry id is missing from a manifest, or a manifest names an id the registry lacks;
//   2. an `implemented` entry has no tagged test under the manifest's testRoots, or, for a
//      corpus proof that exists, no tagged file names the corpus file (or family) it loads;
//   3. an `na` or `except` names a runtime or trait the manifest does not list, or a
//      runtime/reason pair the registry does not allow;
//   4. a `planned` entry's `wp` is not a work package, or that package is already `done`
//      (`unowned: true` with a note is listed, not failed; with no program file, skipped);
//   5. a tag names an unknown feature id.
//
// Schema violations of the registry or a manifest fail too. The parity docs page is written
// by the docs generator (packages/docs/scripts/gen-reference.mjs), never by this file.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";

// ── Shapes ─────────────────────────────────────────────────────────────────────────────────

export type Reason =
  | "runtime"
  | "outlet"
  | "product"
  | "dependency"
  | "version";

export interface Proof {
  kind: "corpus" | "transcript" | "unit" | "generated" | "device" | "snapshot";
  file?: string;
  family?: string;
  command?: string;
  wp?: string;
}

export interface AllowedNa {
  runtime: string;
  reason: Reason;
  why: string;
}

export interface Feature {
  id: string;
  family: string;
  title: string;
  service: string;
  proof: Proof[];
  allowedNa: AllowedNa[];
  note?: string;
}

export interface Registry {
  registryVersion: number;
  reasons: Reason[];
  runtimes: { id: string; title: string }[];
  traits: { id: string; title: string }[];
  families: { id: string; title: string }[];
  sdks: { id: string; title: string; manifest: string }[];
  features: Feature[];
}

export interface ExceptEntry {
  runtime: string;
  reason: Reason;
  note?: string;
}

export type ManifestEntry =
  | { status: "implemented"; except?: ExceptEntry[]; note?: string }
  | { status: "na"; runtime: string | string[]; reason: Reason; note?: string }
  | {
      status: "planned";
      wp?: string;
      unowned?: true;
      except?: ExceptEntry[];
      note?: string;
    };

export interface Manifest {
  sdk: string;
  runtimes: string[];
  traits?: string[];
  testRoots: string[];
  features: Record<string, ManifestEntry>;
}

export interface UnownedGap {
  sdk: string;
  feature: string;
  note: string;
}

export interface ParityResult {
  violations: string[];
  warnings: string[];
  unowned: UnownedGap[];
}

export interface ParityOptions {
  /** Repository root. Every other path is resolved against it. */
  root: string;
  /** Override the program file (tests); repo-relative. */
  programFile?: string;
}

export const REGISTRY_PATH = "conformance/parity/features.json";
export const REGISTRY_SCHEMA_PATH = "conformance/parity/features.schema.json";
export const MANIFEST_SCHEMA_PATH = "conformance/parity/manifest.schema.json";
export const CORPUS_DIR = "conformance/corpus/v2";
export const PROGRAM_PATH =
  "docs/research/2026-09-29-godot-omniplatform/program/workpackages.json";

/** Source extensions scanned for tags. Everything else (JSON vectors, resources) is data. */
const TAGGED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".swift",
  ".gd",
  ".kt",
  ".cs",
  ".rs",
];
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  ".build",
  ".venv",
  "__pycache__",
  ".git",
  ".godot",
]);

const FEATURE_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
// A comment marker (`//`, `///`, `#`, `/*`, or a `*` continuation line), then the tag.
const TAG_LINE = /(?:\/\/+|#|\/\*+|^\s*\*)\s*@pkey-feature\b(.*)$/;

// ── Tags ───────────────────────────────────────────────────────────────────────────────────

export interface Tag {
  file: string; // repo-relative
  line: number;
  ids: string[];
}

/** Every `@pkey-feature` tag in one source text. Ids are read up to the first non-id token. */
export function parseTags(text: string, file: string): Tag[] {
  const tags: Tag[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = TAG_LINE.exec(lines[i] ?? "");
    if (!match) continue;
    const ids: string[] = [];
    for (const token of (match[1] ?? "").trim().split(/[\s,]+/)) {
      if (!FEATURE_ID.test(token)) break;
      ids.push(token);
    }
    tags.push({ file, line: i + 1, ids });
  }
  return tags;
}

function walk(root: string, abs: string, out: string[]): void {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (TAGGED_EXTENSIONS.some((ext) => abs.endsWith(ext)))
      out.push(relative(root, abs));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(abs).sort()) {
    if (SKIPPED_DIRS.has(name)) continue;
    walk(root, join(abs, name), out);
  }
}

// ── The check ──────────────────────────────────────────────────────────────────────────────

type Validator = ((data: unknown) => boolean) & {
  errors?: { instancePath: string; message?: string }[] | null;
};

function compile(schema: object): Validator {
  const Ajv2020 =
    (Ajv2020Module as unknown as { default?: unknown }).default ??
    Ajv2020Module;
  const ajv = new (Ajv2020 as new (opts: object) => {
    compile: (s: object) => Validator;
  })({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function schemaErrors(
  file: string,
  validate: Validator,
  data: unknown,
): string[] {
  if (validate(data)) return [];
  return (validate.errors ?? []).map(
    (e) =>
      `[schema] ${file}: ${e.instancePath || "/"} ${e.message ?? "is invalid"}`,
  );
}

function readJson(
  root: string,
  file: string,
): { data?: unknown; error?: string } {
  const abs = join(root, file);
  if (!existsSync(abs)) return { error: `${file} does not exist` };
  try {
    return { data: JSON.parse(readFileSync(abs, "utf8")) };
  } catch (e) {
    return { error: `${file} is not valid JSON: ${(e as Error).message}` };
  }
}

/** Does `text` mention `token` as a whole word (`gate-matrix`, not `gate-matrix2`)? */
function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(
    text,
  );
}

/** A corpus proof is enforced once what it names exists; until then it must name an owner. */
function corpusProofState(
  root: string,
  proof: Proof,
): { active: boolean; token: string } {
  const file = proof.file ?? "";
  const token = proof.family ?? file.replace(/\/$/, "").replace(/\.json$/, "");
  const abs = join(root, CORPUS_DIR, file);
  if (!existsSync(abs)) return { active: false, token };
  if (proof.family) {
    try {
      const data = JSON.parse(readFileSync(abs, "utf8")) as Record<
        string,
        unknown
      >;
      return { active: proof.family in data, token };
    } catch {
      return { active: false, token };
    }
  }
  return { active: true, token };
}

interface ProgramPackage {
  id: string;
  status: string;
}

export function checkParity(options: ParityOptions): ParityResult {
  const { root } = options;
  const violations: string[] = [];
  const warnings: string[] = [];
  const unowned: UnownedGap[] = [];

  // ── The registry ────────────────────────────────────────────────────────────────────────
  const reg = readJson(root, REGISTRY_PATH);
  const regSchema = readJson(root, REGISTRY_SCHEMA_PATH);
  const manSchema = readJson(root, MANIFEST_SCHEMA_PATH);
  for (const r of [reg, regSchema, manSchema])
    if (r.error) violations.push(`[registry] ${r.error}`);
  if (reg.error || regSchema.error || manSchema.error)
    return { violations, warnings, unowned };

  const regErrors = schemaErrors(
    REGISTRY_PATH,
    compile(regSchema.data as object),
    reg.data,
  );
  violations.push(...regErrors);
  if (regErrors.length) return { violations, warnings, unowned };
  const registry = reg.data as Registry;
  const validateManifest = compile(manSchema.data as object);

  const features = new Map<string, Feature>();
  for (const f of registry.features) {
    if (features.has(f.id))
      violations.push(
        `[registry] ${REGISTRY_PATH}: duplicate feature id "${f.id}"`,
      );
    features.set(f.id, f);
  }
  const runtimeIds = new Set(registry.runtimes.map((r) => r.id));
  const traitIds = new Set(registry.traits.map((t) => t.id));
  const familyIds = new Set(registry.families.map((f) => f.id));
  const reasons = new Set<string>(registry.reasons);
  for (const f of registry.features) {
    if (!familyIds.has(f.family))
      violations.push(`[registry] ${f.id}: unknown family "${f.family}"`);
    for (const na of f.allowedNa) {
      if (na.runtime === "*") {
        if (na.reason === "runtime")
          violations.push(
            `[registry] ${f.id}: a "*" allowedNa must use a reason decided at runtime, not "runtime"`,
          );
      } else if (!runtimeIds.has(na.runtime) && !traitIds.has(na.runtime))
        violations.push(
          `[registry] ${f.id}: allowedNa names unknown runtime or trait "${na.runtime}"`,
        );
      if (!reasons.has(na.reason))
        violations.push(
          `[registry] ${f.id}: allowedNa reason "${na.reason}" is not in reasons`,
        );
    }
    for (const proof of f.proof) {
      if (proof.kind !== "corpus") continue;
      if (!corpusProofState(root, proof).active && !proof.wp)
        violations.push(
          `[registry] ${f.id}: corpus proof ${proof.file}${proof.family ? `#${proof.family}` : ""} does not exist and names no work package that adds it`,
        );
    }
  }

  // ── The program (rule 4's source of truth) ──────────────────────────────────────────────
  const programFile = options.programFile ?? PROGRAM_PATH;
  let program: Map<string, ProgramPackage> | null = null;
  const programJson = readJson(root, programFile);
  if (programJson.error) {
    warnings.push(
      `[rule 4] skipped: ${programJson.error}; planned entries' work packages are not checked`,
    );
  } else {
    const packages =
      (programJson.data as { workPackages?: ProgramPackage[] }).workPackages ??
      [];
    program = new Map(packages.map((p) => [p.id, p]));
  }

  // ── Every manifest ──────────────────────────────────────────────────────────────────────
  const tagsByFile = new Map<string, Tag[]>();
  const textByFile = new Map<string, string>();
  const seenSdks = new Set<string>();

  for (const sdk of registry.sdks) {
    if (seenSdks.has(sdk.id))
      violations.push(`[registry] duplicate sdk id "${sdk.id}"`);
    seenSdks.add(sdk.id);
    const loaded = readJson(root, sdk.manifest);
    if (loaded.error) {
      violations.push(`[manifest] ${sdk.id}: ${loaded.error}`);
      continue;
    }
    const schemaViolations = schemaErrors(
      sdk.manifest,
      validateManifest,
      loaded.data,
    );
    if (schemaViolations.length) {
      violations.push(...schemaViolations);
      continue;
    }
    const manifest = loaded.data as Manifest;
    const where = sdk.id;
    if (manifest.sdk !== sdk.id)
      violations.push(
        `[manifest] ${sdk.manifest}: "sdk" is "${manifest.sdk}", but the registry lists it as "${sdk.id}"`,
      );
    for (const r of manifest.runtimes)
      if (!runtimeIds.has(r))
        violations.push(`[manifest] ${where}: unknown runtime "${r}"`);
    for (const t of manifest.traits ?? [])
      if (!traitIds.has(t))
        violations.push(`[manifest] ${where}: unknown trait "${t}"`);
    const listed = new Set([...manifest.runtimes, ...(manifest.traits ?? [])]);

    // Tags under this SDK's roots.
    const files: string[] = [];
    for (const testRoot of manifest.testRoots) {
      if (!existsSync(join(root, testRoot))) {
        violations.push(
          `[manifest] ${where}: testRoot ${testRoot} does not exist`,
        );
        continue;
      }
      walk(root, join(root, testRoot), files);
    }
    const taggedFiles = new Map<string, Set<string>>(); // feature id → files
    for (const file of new Set(files)) {
      if (!tagsByFile.has(file)) {
        const text = readFileSync(join(root, file), "utf8");
        textByFile.set(file, text);
        tagsByFile.set(file, parseTags(text, file));
      }
      for (const tag of tagsByFile.get(file) ?? [])
        for (const id of tag.ids) {
          if (!taggedFiles.has(id)) taggedFiles.set(id, new Set());
          taggedFiles.get(id)!.add(file);
        }
    }

    // Rule 1: the id sets match.
    for (const id of features.keys())
      if (!(id in manifest.features))
        violations.push(
          `[rule 1] ${where}: ${id} is missing from ${sdk.manifest}`,
        );
    for (const id of Object.keys(manifest.features))
      if (!features.has(id))
        violations.push(
          `[rule 1] ${where}: ${id} is not a registry feature (${sdk.manifest})`,
        );

    const allowed = (
      feature: Feature,
      runtime: string,
      reason: string,
    ): boolean =>
      feature.allowedNa.some(
        (na) =>
          (na.runtime === runtime || na.runtime === "*") &&
          na.reason === reason,
      );
    const checkNa = (
      feature: Feature,
      runtime: string,
      reason: string,
      label: string,
    ): void => {
      if (!listed.has(runtime))
        violations.push(
          `[rule 3] ${where}: ${feature.id}: ${label} names runtime "${runtime}", which the manifest does not list`,
        );
      else if (!allowed(feature, runtime, reason))
        violations.push(
          `[rule 3] ${where}: ${feature.id}: ${label} ${runtime}: ${reason} is not an N/A the registry allows`,
        );
    };

    for (const [id, entry] of Object.entries(manifest.features)) {
      const feature = features.get(id);
      if (!feature) continue;
      if (entry.status === "implemented") {
        // Rule 2: a tagged test proves it.
        const tagged = taggedFiles.get(id);
        if (!tagged?.size) {
          violations.push(
            `[rule 2] ${where}: ${id} is implemented but no test under ${manifest.testRoots.join(", ")} is tagged @pkey-feature ${id}`,
          );
        } else {
          for (const proof of feature.proof) {
            if (proof.kind !== "corpus") continue;
            const state = corpusProofState(root, proof);
            if (!state.active) continue;
            const loads = [...tagged].some((file) =>
              mentions(textByFile.get(file) ?? "", state.token),
            );
            if (!loads)
              violations.push(
                `[rule 2] ${where}: ${id} is proven by corpus ${proof.file}${proof.family ? `#${proof.family}` : ""}, but no file tagged @pkey-feature ${id} loads "${state.token}"`,
              );
          }
        }
      } else if (entry.status === "na") {
        const runtimes = Array.isArray(entry.runtime)
          ? entry.runtime
          : [entry.runtime];
        for (const r of runtimes) checkNa(feature, r, entry.reason, "na");
      } else {
        if (entry.wp !== undefined) {
          if (program) {
            const pkg = program.get(entry.wp);
            if (!pkg)
              violations.push(
                `[rule 4] ${where}: ${id} is planned in ${entry.wp}, which is not a work package`,
              );
            else if (pkg.status === "done")
              violations.push(
                `[rule 4] ${where}: ${id} is planned in ${entry.wp}, which is done — update the manifest`,
              );
          }
        } else if (entry.unowned) {
          unowned.push({ sdk: sdk.id, feature: id, note: entry.note ?? "" });
        }
      }
      if (entry.status !== "na")
        for (const ex of entry.except ?? [])
          checkNa(feature, ex.runtime, ex.reason, "except");
    }
  }

  // Rule 5: every tag names a registry feature.
  for (const tags of tagsByFile.values())
    for (const tag of tags) {
      if (!tag.ids.length)
        violations.push(
          `[rule 5] ${tag.file}:${tag.line}: @pkey-feature names no feature id`,
        );
      for (const id of tag.ids)
        if (!features.has(id))
          violations.push(
            `[rule 5] ${tag.file}:${tag.line}: @pkey-feature names unknown feature "${id}"`,
          );
    }

  return { violations, warnings, unowned };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // `--check` is accepted and ignored: the checker never writes anything.
  const { violations, warnings, unowned } = checkParity({ root });
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (unowned.length) {
    console.log(
      `parity: ${unowned.length} planned entries have no owning work package:`,
    );
    for (const u of unowned)
      console.log(`  ${u.sdk}: ${u.feature} (${u.note})`);
  }
  if (violations.length) {
    for (const v of violations) console.error(v);
    console.error(`parity:check: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log("parity:check: every manifest agrees with the registry");
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
