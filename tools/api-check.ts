// The SDK API registry gate (SP-35), rule 4 of its checker; `tools/parity-check.ts` runs it as
// rule 8 of `pnpm gen --check`'s `parity` family and prints each violation as `[rule 8]`.
//
//   conformance/parity/api.json          the registry (+ api.schema.json)
//   conformance/parity/features.json     the feature ids a concept may name
//   conformance/parity/enums.json        the enum names a concept may name
//   docs/research/…/program/workpackages.json   which work packages exist and are open
//
// It fails when:
//
//   - api.json does not match api.schema.json;
//   - a `planned` or `reserved` package, or a `removed` row's `package`, is not a work package;
//     a `planned` or `removed` package is already `done` (the entry or row is stale);
//   - a concept names a `feature` or `enum` the registries lack;
//   - a `removed` row whose `from` is a common word has no `scan`.
//
// Rules 1 to 3 (the surface scanners, removed names, reserved spellings) land with SP-35.5 to .7.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";

export const API_PATH = "conformance/parity/api.json";
export const API_SCHEMA_PATH = "conformance/parity/api.schema.json";
const FEATURES_PATH = "conformance/parity/features.json";
const ENUMS_PATH = "conformance/parity/enums.json";
const PROGRAM_PATH =
  "docs/research/2026-09-29-godot-omniplatform/program/workpackages.json";

/** Words a bare `from` name shares with unrelated code, so the row has to say where to look. */
export const COMMON_WORDS = [
  "trust",
  "product",
  "secret",
  "config",
  "activate",
  "changes",
];

interface SdkEntry {
  planned?: string;
}
interface Concept {
  id: string;
  feature?: string;
  enum?: string;
  reserved?: string;
  sdks?: Record<string, SdkEntry>;
}
interface Removed {
  from: string;
  package: string;
  scan?: unknown;
}
interface Api {
  concepts: Concept[];
  removed: Removed[];
}

export interface CheckApiOptions {
  /** The parsed registry to check instead of reading api.json (tests mutate a copy). */
  api?: unknown;
}

function readJson(root: string, file: string): unknown {
  const abs = join(root, file);
  if (!existsSync(abs)) return undefined;
  return JSON.parse(readFileSync(abs, "utf8"));
}

/** Returns one `[rule 8]` line per violation; empty when the registry is sound. */
export function checkApi(
  root: string,
  options: CheckApiOptions = {},
): string[] {
  const out: string[] = [];
  const api = options.api ?? readJson(root, API_PATH);
  const schema = readJson(root, API_SCHEMA_PATH);
  if (api === undefined) return [`[rule 8] ${API_PATH}: file not found`];
  if (schema === undefined)
    return [`[rule 8] ${API_SCHEMA_PATH}: file not found`];

  const Ajv2020 =
    (Ajv2020Module as unknown as { default?: unknown }).default ??
    Ajv2020Module;
  const ajv = new (Ajv2020 as new (opts: object) => {
    compile(s: object): {
      (d: unknown): boolean;
      errors?: { instancePath: string; message?: string }[] | null;
    };
  })({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as object);
  if (!validate(api)) {
    for (const e of validate.errors ?? [])
      out.push(
        `[rule 8] ${API_PATH}${e.instancePath}: ${e.message ?? "schema violation"}`,
      );
    return out;
  }
  const doc = api as Api;

  const features = new Set(
    (
      (readJson(root, FEATURES_PATH) as { features?: { id: string }[] })
        ?.features ?? []
    ).map((f) => f.id),
  );
  const enums = new Set(
    (
      (readJson(root, ENUMS_PATH) as { enums?: { name: string }[] })?.enums ??
      []
    ).map((e) => e.name),
  );
  const program = readJson(root, PROGRAM_PATH) as
    | { workPackages?: { id: string; status: string }[] }
    | undefined;
  const wps = program
    ? new Map((program.workPackages ?? []).map((p) => [p.id, p.status]))
    : null;

  /** A package must exist; `open` also requires that it is not done. */
  const checkPackage = (where: string, pkg: string, open: boolean): void => {
    if (!wps) return;
    const status = wps.get(pkg);
    if (status === undefined)
      out.push(`[rule 8] ${where}: ${pkg} is not a work package`);
    else if (open && status === "done")
      out.push(`[rule 8] ${where}: ${pkg} is done; drop the entry or row`);
  };

  const seen = new Set<string>();
  for (const c of doc.concepts) {
    if (seen.has(c.id)) out.push(`[rule 8] ${c.id}: duplicate concept id`);
    seen.add(c.id);
    if (c.feature !== undefined && !features.has(c.feature))
      out.push(`[rule 8] ${c.id}: unknown feature "${c.feature}"`);
    if (c.enum !== undefined && !enums.has(c.enum))
      out.push(`[rule 8] ${c.id}: unknown enum "${c.enum}"`);
    if (c.reserved !== undefined)
      checkPackage(`${c.id} (reserved)`, c.reserved, false);
    for (const [sdk, entry] of Object.entries(c.sdks ?? {}))
      if (entry.planned !== undefined)
        checkPackage(`${c.id} (${sdk} planned)`, entry.planned, true);
  }
  for (const r of doc.removed) {
    checkPackage(`removed ${r.from}`, r.package, true);
    const last = r.from.split(".").pop() ?? r.from;
    if (COMMON_WORDS.includes(last.toLowerCase()) && !r.scan)
      out.push(
        `[rule 8] removed ${r.from}: a common word needs its own "scan" (pattern or files)`,
      );
  }
  return out;
}
