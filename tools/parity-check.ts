// The parity gate (PARITY §3.2): every SDK declares every registry feature as `implemented`,
// `na` or `planned`, and the declaration has to be true.
//
//   pnpm parity:check            # read-only; one line per violation, exit 1 on any
//   pnpm parity:check -- --check # the same (accepted for symmetry with gen corpus --check)
//
// Inputs, all hand-written:
//
//   conformance/parity/features.json        the registry (+ features.schema.json)
//   <sdk>/parity.json                        one manifest per SDK (+ manifest.schema.json)
//   `@pkey-feature <id> [<id>…]` comments    in the tests under each manifest's testRoots
//   docs/research/…/program/workpackages.json   which work packages exist and are open
//
// and one GENERATED input: `conformance/transcripts/*.json` (P1b-03, `pnpm gen transcripts`).
//
// It fails when:
//
//   1. a registry id is missing from a manifest, or a manifest names an id the registry lacks;
//   2. an `implemented` entry has no tagged test under the manifest's testRoots, or, for a
//      corpus proof that exists, no tagged file LOADS the corpus file — names it in a string
//      literal, not merely in prose — (and, for a family proof, names the family);
//   3. an `na` or `except` names a runtime or trait the manifest does not list, or a
//      runtime/reason pair the registry does not allow, or an `na` leaves one of the
//      manifest's runtimes uncovered (unless it names a trait the manifest lists);
//   4. a `planned` entry's `wp` is not a work package, or that package is already `done`
//      (`unowned: true` with a note is listed, not failed; with no program file, skipped); and
//      likewise a registry corpus proof that does not exist yet names a `wp` that is unknown or
//      already `done` (an active proof's `wp` is provenance and is not checked);
//   5. a tag names an unknown feature id;
//   6. a transcript is malformed, names a feature the registry lacks, or lists a feature whose
//      registry entry has no `transcript` proof; or a transcript APPLIES to an SDK — every id in
//      its `features` is `implemented` there and none in its `requires` is `na` — and for some
//      id in its `features` no test tagged `@pkey-feature <id>` under that SDK's testRoots
//      mentions `conformance/transcripts` (the replayer). The replayers apply the same
//      `applies` rule at run time, so a transcript runs exactly where the gate demands it.
//   7. an SDK's generated constants module (the registry's `constants` path) does not carry the
//      capability table its manifest implies: the module's `CAPABILITY_DIGEST` must equal the
//      digest tools/capabilities.ts computes from the registry and the manifest (P1b-10). The
//      table is what `supports()` reads, so a manifest edited without `pnpm gen constants` would
//      otherwise ship an SDK whose answers disagree with its parity row.
//
// A `transcript` proof no transcript lists yet is not enforced; it is listed (with its owner,
// if it names one), and a warning is printed when the owner is already `done`.
//
// Schema violations of the registry or a manifest fail too. The parity docs page is written
// by the docs generator (packages/docs/scripts/gen-reference.mjs), never by this file.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { capabilityDigest, capabilityTable } from "./capabilities.js";

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
  sdks: { id: string; title: string; manifest: string; constants: string }[];
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

/** A registry `transcript` proof that no committed transcript lists yet. */
export interface UnrecordedTranscript {
  feature: string;
  wp?: string;
}

export interface ParityResult {
  violations: string[];
  warnings: string[];
  unowned: UnownedGap[];
  unrecorded: UnrecordedTranscript[];
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
export const TRANSCRIPTS_DIR = "conformance/transcripts";
/** What a replayer mentions — the directory it replays from. */
const TRANSCRIPTS_TOKEN = "conformance/transcripts";
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

function readFileSafe(root: string, file: string): string | null {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
}

/** Does `text` mention `token` as a whole word (`gate-matrix`, not `gate-matrix2`)? */
function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(
    text,
  );
}

/**
 * Does `text` actually LOAD the corpus file a proof names? A whole-word mention is not enough —
 * a tagged file that merely says "edge cases" would satisfy `cases.json` — so the file has to
 * appear as a STRING LITERAL: `v2("cases.json")`, `/ "gate-matrix.json"`, Swift's
 * `forResource: "cases"`, a directory as `"content"` or `"content/"`, optionally behind a path
 * (`"corpus/v2/cases.json"`). A family proof additionally needs the family named (the key the
 * runner reads, `corpus.bundleCases`). Prose in comments and docstrings is not a load.
 */
function loadsCorpus(text: string, proof: Proof): boolean {
  const file = proof.file ?? "";
  const base = file.replace(/\/$/, "").replace(/\.json$/, "");
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = file.endsWith("/") ? "/?" : "(?:\\.json)?";
  const literal = new RegExp(`(["'])(?:[^"'\\n]*/)?${escaped}${tail}\\1`);
  if (!literal.test(text)) return false;
  return proof.family ? mentions(text, proof.family) : true;
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
    // A directory proof (`content/`) names the family in that directory's `cases.json`.
    const casesFile = statSync(abs).isDirectory()
      ? join(abs, "cases.json")
      : abs;
    try {
      const data = JSON.parse(readFileSync(casesFile, "utf8")) as Record<
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

/** The part of a transcript the gate reads. The Worker's generator owns the full format
 *  (packages/worker/test/transcripts/format.ts). */
export interface TranscriptHead {
  file: string;
  id: string;
  features: string[];
  requires: string[];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Read and sanity-check every committed transcript (rule 6). A missing directory is simply
 *  "no transcripts yet". */
function readTranscripts(
  root: string,
  features: Map<string, Feature>,
  violations: string[],
): TranscriptHead[] {
  const dir = join(root, TRANSCRIPTS_DIR);
  if (!existsSync(dir)) return [];
  const out: TranscriptHead[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = `${TRANSCRIPTS_DIR}/${name}`;
    const loaded = readJson(root, file);
    if (loaded.error) {
      violations.push(`[rule 6] ${loaded.error}`);
      continue;
    }
    const t = loaded.data as Record<string, unknown>;
    const id = name.replace(/\.json$/, "");
    if (
      t.id !== id ||
      !isStringArray(t.features) ||
      !t.features.length ||
      !isStringArray(t.requires)
    ) {
      violations.push(
        `[rule 6] ${file}: needs "id": "${id}", a non-empty "features" list and a "requires" list`,
      );
      continue;
    }
    for (const f of t.features) {
      const feature = features.get(f);
      if (!feature)
        violations.push(`[rule 6] ${file}: names unknown feature "${f}"`);
      else if (!feature.proof.some((p) => p.kind === "transcript"))
        violations.push(
          `[rule 6] ${file}: lists ${f}, whose registry entry has no transcript proof`,
        );
    }
    for (const f of t.requires)
      if (!features.has(f))
        violations.push(`[rule 6] ${file}: requires unknown feature "${f}"`);
    out.push({ file, id, features: t.features, requires: t.requires });
  }
  return out;
}

/** Does the transcript apply to this SDK? Every feature it proves is `implemented`, and none it
 *  presupposes is `na` — the same rule each SDK's replayer uses to decide what to run. */
export function transcriptApplies(
  t: Pick<TranscriptHead, "features" | "requires">,
  manifest: Pick<Manifest, "features">,
): boolean {
  return (
    t.features.every((id) => manifest.features[id]?.status === "implemented") &&
    t.requires.every((id) => manifest.features[id]?.status !== "na")
  );
}

export function checkParity(options: ParityOptions): ParityResult {
  const { root } = options;
  const violations: string[] = [];
  const warnings: string[] = [];
  const unowned: UnownedGap[] = [];
  const unrecorded: UnrecordedTranscript[] = [];

  // ── The registry ────────────────────────────────────────────────────────────────────────
  const reg = readJson(root, REGISTRY_PATH);
  const regSchema = readJson(root, REGISTRY_SCHEMA_PATH);
  const manSchema = readJson(root, MANIFEST_SCHEMA_PATH);
  for (const r of [reg, regSchema, manSchema])
    if (r.error) violations.push(`[registry] ${r.error}`);
  if (reg.error || regSchema.error || manSchema.error)
    return { violations, warnings, unowned, unrecorded };

  const regErrors = schemaErrors(
    REGISTRY_PATH,
    compile(regSchema.data as object),
    reg.data,
  );
  violations.push(...regErrors);
  if (regErrors.length) return { violations, warnings, unowned, unrecorded };
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
      const where = `${proof.file}${proof.family ? `#${proof.family}` : ""}`;
      // An active proof's `wp` is provenance only. A proof that does not exist yet must name
      // the open work package that adds it (rule 4, proof level).
      if (corpusProofState(root, proof).active) continue;
      if (!proof.wp) {
        violations.push(
          `[registry] ${f.id}: corpus proof ${where} does not exist and names no work package that adds it`,
        );
        continue;
      }
      if (!program) continue;
      const owner = program.get(proof.wp);
      if (!owner)
        violations.push(
          `[rule 4] ${f.id}: corpus proof ${where} names ${proof.wp}, which is not a work package`,
        );
      else if (owner.status === "done")
        violations.push(
          `[rule 4] ${f.id}: corpus proof names ${proof.wp}, which is done, but ${CORPUS_DIR}/${proof.file} does not exist${proof.family ? ` (or lacks ${proof.family})` : ""}`,
        );
    }
  }

  // ── The transcripts (rule 6) ────────────────────────────────────────────────────────────
  const transcripts = readTranscripts(root, features, violations);
  const recorded = new Set(transcripts.flatMap((t) => t.features));
  for (const f of registry.features)
    for (const proof of f.proof) {
      if (proof.kind !== "transcript" || recorded.has(f.id)) continue;
      unrecorded.push({ feature: f.id, ...(proof.wp ? { wp: proof.wp } : {}) });
      if (proof.wp && program?.get(proof.wp)?.status === "done")
        warnings.push(
          `[rule 6] ${f.id}: its transcript proof names ${proof.wp}, which is done, but no transcript lists ${f.id}`,
        );
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

    // Rule 7: the generated capability table is this manifest's. Only once rule 1 holds: a
    // manifest that lacks a feature has no table to compare.
    const complete = registry.features.every((f) => f.id in manifest.features);
    if (complete) {
      const constants = readFileSafe(root, sdk.constants);
      const digest = capabilityDigest(capabilityTable(registry, manifest));
      if (constants === null)
        violations.push(
          `[rule 7] ${where}: ${sdk.constants} does not exist (run \`pnpm gen constants\`)`,
        );
      else if (!constants.includes(digest))
        violations.push(
          `[rule 7] ${where}: the capability table in ${sdk.constants} is not ${sdk.manifest}'s (CAPABILITY_DIGEST ${digest}); run \`pnpm gen constants\``,
        );
    }
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

    // Rule 6: every transcript that applies here has a tagged replayer for each feature it
    // proves. One line per feature, naming the transcripts that demand it.
    const demanded = new Map<string, string[]>(); // feature id → transcript ids
    for (const t of transcripts) {
      if (!transcriptApplies(t, manifest)) continue;
      for (const id of t.features) {
        if (!demanded.has(id)) demanded.set(id, []);
        demanded.get(id)!.push(t.id);
      }
    }
    for (const [id, ids] of demanded) {
      const replays = [...(taggedFiles.get(id) ?? [])].some((file) =>
        mentions(textByFile.get(file) ?? "", TRANSCRIPTS_TOKEN),
      );
      if (!replays)
        violations.push(
          `[rule 6] ${where}: ${ids.join(", ")} ${ids.length === 1 ? "applies" : "apply"} here, but no test tagged @pkey-feature ${id} replays ${TRANSCRIPTS_TOKEN}`,
        );
    }

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
              loadsCorpus(textByFile.get(file) ?? "", proof),
            );
            if (!loads)
              violations.push(
                `[rule 2] ${where}: ${id} is proven by corpus ${proof.file}${proof.family ? `#${proof.family}` : ""}, but no file tagged @pkey-feature ${id} loads it (a string literal naming "${proof.file}"${proof.family ? ` and the family ${state.token}` : ""})`,
              );
          }
        }
      } else if (entry.status === "na") {
        const runtimes = Array.isArray(entry.runtime)
          ? entry.runtime
          : [entry.runtime];
        for (const r of runtimes) checkNa(feature, r, entry.reason, "na");
        // An SDK-wide N/A must be allowed on EVERY runtime the SDK ships to. A trait the
        // manifest lists covers them all (it is a property of the whole SDK); otherwise one
        // allowed runtime would silently stretch the N/A over runtimes the registry does not
        // allow it on. A mixed SDK declares `implemented`/`planned` with `except` instead.
        // (An unlisted name already failed above; the coverage line would only be noise.)
        const traits = new Set(manifest.traits ?? []);
        if (
          runtimes.every((r) => listed.has(r)) &&
          !runtimes.some((r) => traits.has(r))
        ) {
          const uncovered = manifest.runtimes.filter(
            (r) => !runtimes.includes(r),
          );
          if (uncovered.length)
            violations.push(
              `[rule 3] ${where}: ${id}: na covers ${runtimes.join(", ")} but not ${uncovered.join(", ")}; declare a partial N/A with except`,
            );
        }
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

  return { violations, warnings, unowned, unrecorded };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // `--check` is accepted and ignored: the checker never writes anything.
  const { violations, warnings, unowned, unrecorded } = checkParity({ root });
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (unowned.length) {
    console.log(
      `parity: ${unowned.length} planned entries have no owning work package:`,
    );
    for (const u of unowned)
      console.log(`  ${u.sdk}: ${u.feature} (${u.note})`);
  }
  if (unrecorded.length) {
    console.log(
      `parity: ${unrecorded.length} transcript proofs have no recorded transcript yet:`,
    );
    for (const u of unrecorded)
      console.log(`  ${u.feature} (${u.wp ?? "no owning work package"})`);
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
