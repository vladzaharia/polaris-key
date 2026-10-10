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
 *   3. a package: `@polaris-key/*` shared packages, plus the worker's other declared runtime
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
 *     core-mediated interface — for Distribution and Update reading one another's state, the
 *     descriptor hooks in `core/hooks.ts` (P2b-01). Distribution is NOT an exception: it reads
 *     Release only through `hooks.releaseCatalog()`.
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
 * `src/services/` now holds all six: `license/`, `config/`, `release/`, `distribution/`,
 * `update/` and `identity/`. The last case in this file is the one that does the work — it walks every file
 * actually present — so the rule is exhaustive rather than hypothetical.
 *
 * The identity carve (P3) is the one that exercised the rule hardest, because identity genuinely
 * needs licence-shaped answers: its OIDC sign-in mints and claims licences, its browser session
 * authorizes a device and enforces the build gate. None of that became an
 * `identity -> license` import. It became `core/licensing/authz.ts` and `core/licensing/gate.ts`, with License
 * re-exporting them — the same move `injectAdminPolicy` and the semver algebra made in P2. That
 * is what "everything else crosses via core-mediated interfaces" means in practice, and this
 * suite is what stops the cheaper answer from being taken next time.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVICE_SLUGS } from "../src/core/services.js";

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
    // A subpath export of an allowed package (`@polaris-key/protocol/license`).
    const scoped = specifier.split("/").slice(0, 2).join("/");
    if (specifier.startsWith("@") && ALLOWED_PACKAGES.has(scoped)) return null;
    const bare = specifier.split("/")[0] ?? specifier;
    if (ALLOWED_PACKAGES.has(bare)) return null;
    return `imports "${specifier}", which is not a declared dependency of @polaris-key/worker`;
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

  it("is actually policing every service in the table", () => {
    // The guard against this file quietly becoming a no-op: if a service directory stopped being
    // scanned — a rename, a move, a broken walk — the last case below would pass on an empty
    // set and nobody would notice. Naming the expected services makes that failure loud. The
    // expected set is the generated service table (`tools/services.json`), so a new row fails
    // here until its `src/services/<slug>/` directory exists.
    const dirs = new Set(listDirs(SERVICES_ROOT));
    const services = new Set(collectImportSites().map((s) => s.service));
    for (const slug of SERVICE_SLUGS) {
      expect(
        dirs.has(slug),
        `src/services/${slug}/ is missing — tools/services.json has a "${slug}" row, so the service needs its own directory`,
      ).toBe(true);
      expect(services, `${slug} should be scanned`).toContain(slug);
    }
  });

  it("scans identity's nested portal/ directory, not just its top level", () => {
    // `identity/` is the only service with a sub-directory, and it is the one holding the files
    // with the most legacy imports (`portal/api.ts` alone reached six top-level modules before
    // the carve). A walk that stopped at the service root would pass this file while leaving
    // exactly those imports unpoliced.
    const portalFiles = new Set(
      collectImportSites()
        .filter((s) => s.service === "identity")
        .map((s) => s.file),
    );
    expect(
      [...portalFiles].filter((f) => f.includes("identity/portal/")).length,
    ).toBeGreaterThan(0);
  });

  it("refuses identity -> license, the edge the carve was most likely to introduce", () => {
    // Identity mints licences, claims enrolled ones and runs the build gate, so `../license/…`
    // is the import a hurried carve leaves behind. It is not a sanctioned edge: those answers
    // come from `core/licensing/authz.ts` and `core/licensing/gate.ts`, which License re-exports.
    for (const specifier of [
      "../license/authz.js",
      "../license/gate.js",
      "../license/index.js",
    ]) {
      expect(
        violation({
          service: "identity",
          file: "src/services/identity/browserSession.ts",
          specifier,
        }),
        `${specifier} should be refused`,
      ).not.toBeNull();
    }
  });

  it("keeps update -> release the ONLY exception: distribution reads release and update reads distribution through core/hooks.ts (P2b-01)", () => {
    expect(CROSS_SERVICE_EXCEPTIONS).toEqual({ update: ["release"] });
    // The chain release ← distribution ← update is NOT a licence to import along it.
    const refused: Array<[string, string, string]> = [
      [
        "distribution",
        "src/services/distribution/index.ts",
        "../release/model.js",
      ],
      [
        "distribution",
        "src/services/distribution/index.ts",
        "../update/feed.js",
      ],
      ["update", "src/services/update/feed.ts", "../distribution/delivery.js"],
      [
        "release",
        "src/services/release/catalog.ts",
        "../distribution/index.js",
      ],
    ];
    for (const [service, file, specifier] of refused) {
      expect(
        violation({ service, file, specifier }),
        `${service} -> ${specifier} should be refused`,
      ).not.toBeNull();
    }
    // …and the live tree honours it: distribution imports only core/ and itself. The specifier
    // is resolved against its file, so a sub-directory (`connectors/asc/`, P5-02) reaching its
    // own service's files is not a crossing and one reaching another service still is.
    const crossings = collectImportSites().filter((s) => {
      if (s.service !== "distribution" || !s.specifier.startsWith("."))
        return false;
      const target = posix.normalize(
        posix.join(posix.dirname(s.file), s.specifier),
      );
      return (
        !target.startsWith("src/services/distribution/") &&
        !target.startsWith("src/core/")
      );
    });
    expect(crossings).toEqual([]);
    expect(
      collectImportSites().some(
        (s) =>
          s.service === "distribution" && s.specifier === "../../core/hooks.js",
      ),
    ).toBe(true);
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
      "@polaris-key/protocol",
      "@polaris-key/protocol/license",
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

/**
 * A-18a (notes/S-15 §6.1): the adapter layer is Core, consumed by services, never the reverse.
 *
 *   - `core/adapters/` (the shared base) imports nothing at all: it is types and one pure helper.
 *   - `core/storefront/` imports no service (Core's shared helpers, `crypto.ts` included, are fine).
 *   - Its DECLARATION modules (the contract and registry, the store declarations, the rule
 *     tables, the gate engine and matchers, the deep-link table, the CI allow-list, the listing
 *     slot, typed confirmation) import only each other, `core/adapters/`, and type-only from
 *     `@polaris-key/manifest`. That keeps them dependency-free, so the CLI's copy is a straight
 *     serialise (the generated JSON A-18h emits).
 */
describe("the adapter layer (A-18a)", () => {
  const CORE = join(WORKER_ROOT, "src", "core");
  const resolveFrom = (file: string, specifier: string) =>
    relative(join(WORKER_ROOT, "src"), join(dirname(file), specifier)).split(
      /[\\/]/,
    );
  const RUNTIME = new Set(["ledger.ts", "audit.ts", "budget.ts"]);

  it("core/adapters imports nothing", () => {
    for (const file of walkTs(join(CORE, "adapters")))
      expect(importsOf(readFileSync(file, "utf8")), file).toEqual([]);
  });

  it("core/storefront imports no service", () => {
    const bad: string[] = [];
    for (const file of walkTs(join(CORE, "storefront")))
      for (const s of importsOf(readFileSync(file, "utf8"))) {
        if (!s.startsWith(".")) continue;
        const seg = resolveFrom(file, s);
        if (seg[0] === "services" || seg[0] === "admin")
          bad.push(`${relative(WORKER_ROOT, file)}: ${s}`);
      }
    expect(bad).toEqual([]);
  });

  it("the declaration modules import only the adapter layer (and manifest types)", () => {
    const bad: string[] = [];
    for (const file of walkTs(join(CORE, "storefront"))) {
      const name = relative(join(CORE, "storefront"), file);
      if (RUNTIME.has(name)) continue;
      const source = readFileSync(file, "utf8");
      for (const s of importsOf(source)) {
        if (!s.startsWith(".")) {
          const typeOnly = new RegExp(
            `import\\s+type\\s[^;]*from\\s+["']${s.replace(/[/.]/g, "\\$&")}["']`,
          ).test(source);
          if (s === "@polaris-key/manifest" && typeOnly) continue;
          bad.push(`${name}: ${s}`);
          continue;
        }
        const seg = resolveFrom(file, s);
        if (
          seg[0] === "core" &&
          (seg[1] === "adapters" ||
            (seg[1] === "storefront" &&
              !RUNTIME.has(seg.slice(2).join("/").replace(/\.js$/, ".ts"))))
        )
          continue;
        bad.push(`${name}: ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
