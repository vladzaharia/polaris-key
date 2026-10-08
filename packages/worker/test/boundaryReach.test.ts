/**
 * P0-48 — the transitive half of the service boundary, REPORT-ONLY.
 *
 * `boundaries.test.ts` checks one hop: a file under `src/services/<a>/` may import Core, itself
 * and packages, and `update → release` is the one sanctioned cross-service edge. It cannot see a
 * service reaching another THROUGH Core: `services/license/admin/deletion.ts → core/adminApi.ts →
 * admin/lib/shape.ts → services/release/store.ts` is legal hop by hop, and loads Release's store
 * whenever License runs. This file walks the runtime import graph over `src/` (type-only imports
 * are erased at build and skipped) and prints, per service, every other service its files reach,
 * with one example path each, and the Core modules that reach any service at all.
 *
 * It does not fail on reach: the layering move (P0-17, the audits' CQW-03) is what removes it,
 * and this report is its measurable before and after. `BASELINE` is the reach measured on
 * 2026-10-07; the report names what has grown or shrunk since. When the layering lands, the
 * report is expected to read "none" for every service but `update → release`, and the test can
 * turn into an assertion. Today every path runs through `core/adminApi.ts → admin/lib/shape.ts`.
 *
 * The default reporter hides a passing test's output; to read the report:
 *
 *   pnpm --filter @polaris-key/worker exec vitest run test/boundaryReach.test.ts --reporter=verbose
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVICE_SLUGS } from "../src/core/services.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The reach measured on 2026-10-07 (cq-worker-core §2.3, re-measured on this tree). */
const BASELINE: Record<string, readonly string[]> = {
  config: ["distribution", "identity", "release"],
  distribution: ["config", "identity", "release"],
  identity: ["config", "distribution", "release"],
  license: ["config", "distribution", "identity", "release"],
  release: ["config", "distribution", "identity"],
  sync: [],
  update: ["config", "distribution", "identity", "release"],
};
/** Core modules whose runtime imports reach a service (2026-10-07). */
const CORE_BASELINE: readonly string[] = [
  "core/adminApi.ts",
  "core/ascProvisioning.ts",
  "core/blobGc.ts",
  "core/deviceAdmin.ts",
  "core/storefront/audit.ts",
  "core/storefront/ledger.ts",
];

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Runtime module specifiers: `import type` and `export type … from` are erased, so skipped. */
const SPECIFIER_RE =
  /(?:^|[\s;}])(?:import|export)\s+(type\s+)?(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function runtimeImports(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(SPECIFIER_RE)) {
    if (m[1]) continue;
    const specifier = m[2] ?? m[3];
    if (!specifier?.startsWith(".")) continue;
    const base = resolve(dirname(file), specifier).replace(/\.js$/, "");
    const target = [`${base}.ts`, join(base, "index.ts")].find((f) =>
      existsSync(f),
    );
    if (target) out.push(target);
  }
  return out;
}

const FILES = walkTs(SRC);
const GRAPH = new Map(FILES.map((f) => [f, runtimeImports(f)]));
const rel = (f: string) => relative(SRC, f).split("\\").join("/");
const serviceOf = (f: string): string | null => {
  const parts = rel(f).split("/");
  return parts[0] === "services" ? (parts[1] ?? null) : null;
};

/** Breadth-first from `roots`: every reachable file, with the file it was first reached from. */
function reach(roots: readonly string[]): Map<string, string | null> {
  const parent = new Map<string, string | null>(roots.map((r) => [r, null]));
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    for (const next of GRAPH.get(queue[i]!) ?? [])
      if (!parent.has(next)) {
        parent.set(next, queue[i]!);
        queue.push(next);
      }
  }
  return parent;
}

function pathTo(parent: Map<string, string | null>, file: string): string {
  const hops: string[] = [];
  for (let f: string | null = file; f !== null; f = parent.get(f) ?? null)
    hops.unshift(rel(f));
  return hops.join(" → ");
}

interface Reach {
  services: string[];
  examples: Map<string, string>;
}

function serviceReach(slug: string): Reach {
  const roots = FILES.filter((f) => serviceOf(f) === slug);
  const parent = reach(roots);
  const examples = new Map<string, string>();
  for (const file of parent.keys()) {
    const other = serviceOf(file);
    if (other && other !== slug && !examples.has(other))
      examples.set(other, pathTo(parent, file));
  }
  return { services: [...examples.keys()].sort(), examples };
}

function coreReach(): string[] {
  return FILES.filter((f) => rel(f).startsWith("core/"))
    .filter((f) => [...reach([f]).keys()].some((g) => serviceOf(g) !== null))
    .map(rel)
    .sort();
}

const diff = (now: readonly string[], then: readonly string[]) => ({
  grown: now.filter((x) => !then.includes(x)),
  shrunk: then.filter((x) => !now.includes(x)),
});

describe("transitive service reach (report-only, P0-48)", () => {
  it("reports what each service's runtime imports reach, against the 2026-10-07 baseline", () => {
    const lines = ["Transitive service reach (runtime imports over src/):"];
    for (const slug of SERVICE_SLUGS) {
      const { services, examples } = serviceReach(slug);
      const { grown, shrunk } = diff(services, BASELINE[slug] ?? []);
      lines.push(
        `  ${slug} → ${services.join(", ") || "none"}` +
          (grown.length ? `  [grown: ${grown.join(", ")}]` : "") +
          (shrunk.length ? `  [shrunk: ${shrunk.join(", ")}]` : ""),
      );
      for (const [other, path] of examples)
        lines.push(`      ${other}: ${path}`);
    }
    const core = coreReach();
    const { grown, shrunk } = diff(core, CORE_BASELINE);
    lines.push(
      `  core modules reaching a service: ${core.length} (baseline ${CORE_BASELINE.length})` +
        (grown.length ? `  [new: ${grown.join(", ")}]` : "") +
        (shrunk.length ? `  [gone: ${shrunk.join(", ")}]` : ""),
    );
    for (const m of core) lines.push(`      ${m}`);
    console.info(lines.join("\n"));

    // Report-only: the walk must be real, but reach itself never fails this test.
    expect(FILES.length).toBeGreaterThan(100);
    for (const slug of SERVICE_SLUGS)
      expect(
        FILES.some((f) => serviceOf(f) === slug),
        `src/services/${slug}/ should be walked`,
      ).toBe(true);
    // The sanctioned edge is live, so the walk does see a cross-service import.
    expect(serviceReach("update").services).toContain("release");
  });

  it("skips type-only imports, which the build erases", () => {
    const sample = [
      'import type { A } from "./a.js";',
      'export type { B } from "./b.js";',
      'import { c } from "./c.js";',
    ].join("\n");
    const kinds = [...sample.matchAll(SPECIFIER_RE)].map((m) =>
      m[1] ? `type ${m[2]}` : (m[2] ?? m[3]),
    );
    expect(kinds).toEqual(["type ./a.js", "type ./b.js", "./c.js"]);
  });
});
