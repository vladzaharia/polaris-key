/**
 * Service boundary enforcement (design spec §5.1 "Boundary enforcement", D-02).
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────
 *
 * A file under `src/services/<slug>/` may import:
 *
 *   1. `../../core/…`         — the always-on substrate (products, devices, trust, signing,
 *                               discovery, rate limiting, errors, audit, registry).
 *   2. anything within its own service directory (`./x`, `./sub/y`).
 *   3. a package: `@plrs/*` shared packages, plus the worker's other declared runtime
 *      dependencies. A bare specifier cannot name a worker-internal module, so it can never be
 *      a boundary violation; the set is read from `package.json` `dependencies` so widening it
 *      requires a reviewed dependency change rather than an edit to this file.
 *   4. node builtins (`node:*`).
 *
 * Everything else is refused, and in particular:
 *
 *   - `services/<a>/…` importing `services/<b>/…`. The ONE sanctioned exception is
 *     `update → release`: Update renders a feed over Release's truth store, which is a hard
 *     dependency by design (D-05). Every other cross-service need goes through a
 *     core-mediated interface.
 *   - reaching back into legacy top-level modules (`../../repo.js`, `../../licensing.js`, …).
 *     That is the seam the whole re-organisation exists to remove, and it is exactly the
 *     import a hurried move would leave behind.
 *
 * ── WHY A TEST AND NOT A LINT RULE ──────────────────────────────────────────────────────────
 *
 * This repo has no ESLint installed — `pnpm lint` is Prettier. Standing up a whole flat-config
 * toolchain (and its dependency tree) to express one `no-restricted-imports` zone would be a
 * larger change than the rule it enforces, and it would not run in the place that already
 * gates every commit. A test runs on the same gate, needs no new dependencies, and can say
 * *why* in its failure message.
 *
 * `src/services/` now holds `license/`, `config/`, `release/` and `update/`; `identity/` lands in
 * P3. The last case in this file is the one that does the work — it walks every file actually
 * present — so the rule stops being hypothetical as each directory appears.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..");
const SERVICES_ROOT = join(WORKER_ROOT, "src", "services");

/** The single sanctioned cross-service edge: `update` depends on `release` (D-05). */
const CROSS_SERVICE_EXCEPTIONS: Record<string, readonly string[]> = {
  update: ["release"],
};

/** Bare specifiers a service may import: the worker's declared runtime dependencies. */
const ALLOWED_PACKAGES = new Set(
  Object.keys(
    (
      JSON.parse(readFileSync(join(WORKER_ROOT, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      }
    ).dependencies ?? {},
  ),
);

interface ImportSite {
  /** Service directory name, e.g. "update". */
  service: string;
  /** Path relative to the worker package, for readable failures. */
  file: string;
  specifier: string;
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root).filter((name) =>
      statSync(join(root, name)).isDirectory(),
    );
  } catch {
    return []; // `src/services/` not created yet — the rule has nothing to police.
  }
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Every module specifier in a source file.
 *
 * A regex, deliberately: a TypeScript parser is not a dependency of this package, and the
 * shapes that matter (`import … from "x"`, `import "x"`, `export … from "x"`,
 * `import("x")`) are all anchored on a quoted specifier after a keyword. Over-matching a
 * specifier inside a string literal or comment can only produce a FALSE POSITIVE — a failing
 * test someone must look at — never a false pass, which is the safe direction for a guard.
 */
const SPECIFIER_RE =
  /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPECIFIER_RE)) {
    const specifier = m[1] ?? m[2];
    if (specifier) out.push(specifier);
  }
  return out;
}

function collectImportSites(): ImportSite[] {
  const sites: ImportSite[] = [];
  for (const service of listDirs(SERVICES_ROOT)) {
    for (const file of walkTs(join(SERVICES_ROOT, service))) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        sites.push({
          service,
          file: relative(WORKER_ROOT, file),
          specifier,
        });
      }
    }
  }
  return sites;
}

/** Why this import is refused, or `null` when it is allowed. */
function violation(site: ImportSite): string | null {
  const { service, specifier } = site;

  if (specifier.startsWith("node:")) return null;
  if (!specifier.startsWith(".")) {
    if (ALLOWED_PACKAGES.has(specifier)) return null;
    // A subpath export of an allowed package (`@plrs/protocol/license`).
    const scoped = specifier.split("/").slice(0, 2).join("/");
    if (specifier.startsWith("@") && ALLOWED_PACKAGES.has(scoped)) return null;
    const bare = specifier.split("/")[0] ?? specifier;
    if (ALLOWED_PACKAGES.has(bare)) return null;
    return `imports "${specifier}", which is not a declared dependency of @plrs/worker`;
  }

  // Resolve the specifier against the importing file, as a path under `src/`.
  const resolved = relative(
    join(WORKER_ROOT, "src"),
    join(dirname(join(WORKER_ROOT, site.file)), specifier),
  );
  const segments = resolved.split(/[\\/]/);

  if (segments[0] === "core") return null;

  if (segments[0] === "services") {
    const target = segments[1];
    if (target === service) return null;
    if (target && CROSS_SERVICE_EXCEPTIONS[service]?.includes(target))
      return null;
    return `imports service "${target}" from service "${service}"; the only sanctioned cross-service edge is update -> release (D-05). Route it through core/ instead`;
  }

  return `imports "${specifier}" (resolves to src/${resolved}); a service may only reach core/, its own directory, and shared packages`;
}

describe("service boundaries", () => {
  it("tolerates src/services/ not existing yet", () => {
    // P1–P3 create the per-service directories. Until then this suite must not fail, and must
    // not silently stop being wired up either — hence the explicit case.
    expect(() => collectImportSites()).not.toThrow();
  });

  it("is actually policing the four services that exist", () => {
    // The guard against this file quietly becoming a no-op: if a service directory stopped being
    // scanned — a rename, a move, a broken walk — the last case below would pass on an empty
    // set and nobody would notice. Naming the expected services makes that failure loud.
    const services = new Set(collectImportSites().map((s) => s.service));
    for (const slug of ["license", "config", "release", "update"]) {
      expect(services, `${slug} should be scanned`).toContain(slug);
    }
  });

  it("proves update -> release is a LIVE edge, not just a permitted one", () => {
    // D-05 makes Update a feed over Release's truth, so the exception exists to be used. If it
    // ever stopped being used, the exception should be deleted rather than left standing as a
    // hole nothing needs.
    const crossings = collectImportSites().filter(
      (s) => s.service === "update" && s.specifier.startsWith("../release/"),
    );
    expect(crossings.length).toBeGreaterThan(0);
    // …and nothing crosses the other way.
    expect(
      collectImportSites().filter(
        (s) => s.service === "release" && s.specifier.startsWith("../update/"),
      ),
    ).toEqual([]);
  });

  it("lets services import core, their own directory, packages and node builtins", () => {
    // A self-test of the rule itself, so an empty `src/services/` cannot make this file a
    // no-op that nobody notices has stopped working.
    const allowed = [
      "../../core/services.js",
      "../../core/devices.js",
      "./document.js",
      "./admin/handlers.js",
      "@plrs/protocol",
      "@plrs/protocol/license",
      "jose",
      "node:crypto",
    ];
    for (const specifier of allowed) {
      expect(
        violation({
          service: "license",
          file: "src/services/license/routes.ts",
          specifier,
        }),
        `${specifier} should be allowed`,
      ).toBeNull();
    }
  });

  it("refuses a cross-service import and a reach back into legacy modules", () => {
    const refused: Array<[string, string]> = [
      ["../../services/identity/oidc.js", "cross-service"],
      ["../release/store.js", "cross-service"],
      ["../../repo.js", "legacy module"],
      ["../../licensing.js", "legacy module"],
      ["../../admin/repo.js", "legacy module"],
      ["some-undeclared-package", "undeclared package"],
    ];
    for (const [specifier, why] of refused) {
      expect(
        violation({
          service: "license",
          file: "src/services/license/routes.ts",
          specifier,
        }),
        `${specifier} (${why}) should be refused`,
      ).not.toBeNull();
    }
  });

  it("permits the one sanctioned cross-service edge, update -> release", () => {
    expect(
      violation({
        service: "update",
        file: "src/services/update/appcast.ts",
        specifier: "../release/channels.js",
      }),
    ).toBeNull();
    // …and only in that direction.
    expect(
      violation({
        service: "release",
        file: "src/services/release/sync.ts",
        specifier: "../update/appcast.ts",
      }),
    ).not.toBeNull();
  });

  it("extracts specifiers from every import form", () => {
    const source = [
      'import { a } from "./a.js";',
      'import type { B } from "../../core/b.js";',
      'import "./side-effect.js";',
      'export { c } from "./c.js";',
      'export * from "./d.js";',
      'const e = await import("./e.js");',
    ].join("\n");
    expect(importsOf(source)).toEqual([
      "./a.js",
      "../../core/b.js",
      "./side-effect.js",
      "./c.js",
      "./d.js",
      "./e.js",
    ]);
  });

  it("holds for every file currently under src/services/", () => {
    const violations = collectImportSites()
      .map((site) => {
        const why = violation(site);
        return why ? `${site.file}: ${why}` : null;
      })
      .filter((v): v is string => v !== null);
    expect(violations).toEqual([]);
  });
});
