/**
 * Layer and service boundary enforcement (design spec §5.1 "Boundary enforcement", D-02; the
 * layering of P0-17).
 *
 * ── THE LAYERS ──────────────────────────────────────────────────────────────────────────────
 *
 * `src/` is layered, lowest first. A layer imports only itself and the layers below it:
 *
 *   platform/, db/   primitives with no domain knowledge (env, crypto, KV, the key vault, HTTP
 *                    and security headers, encodings; the `Db` interface and its adapters)
 *   core/            the always-on substrate (products, devices, licensing, accounts, trust,
 *                    assets, the package registry, ops, and `core/console/`, what Core lends
 *                    the console and every service's admin handlers)
 *   services/<slug>/ one opt-in service each (the rule below)
 *   console/         the operator console's handlers; it reads a service only through that
 *                    service's `public.ts`
 *   src/*.ts         the entry and composition modules (`index.ts`, `dispatch.ts`, `router.ts`,
 *                    `mount.ts`, `scheduled.ts`, the Durable Objects, the webhooks)
 *
 * Type-only imports count: a layer that names a higher layer's type is still coupled to it.
 *
 * ── THE SERVICE RULE ────────────────────────────────────────────────────────────────────────
 *
 * A file under `src/services/<slug>/` may import:
 *
 *   1. `../../core/…`, `../../platform/…` and `../../db/…` — the substrate and the primitives.
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
 *   - reaching up into the console or the composition modules (`../../console/…`,
 *     `../../router.js`, …). That is the seam the re-organisation exists to remove, and it is
 *     exactly the import a hurried move would leave behind.
 *
 * ── TRANSITIVELY ────────────────────────────────────────────────────────────────────────────
 *
 * The direct rules are checked hop by hop, and the runtime import graph is then walked from
 * every file: no service reaches another (but `update → release`), and nothing under
 * `platform/`, `db/` or `core/` reaches a service, the console or a composition module. P0-48
 * seeded that walk report-only (Core's admin seam then pulled Release, Distribution, Identity
 * and Config into every service); P0-17 made it blocking.
 *
 * ── WHY A TEST AND NOT A LINT RULE ──────────────────────────────────────────────────────────
 *
 * This repo has no ESLint installed — `pnpm lint` is Prettier. Standing up a whole flat-config
 * toolchain (and its dependency tree) to express these zones would be a larger change than the
 * rules it enforces, and it would not run in the place that already gates every commit. A test
 * runs on the same gate, needs no new dependencies, and can say *why* in its failure message.
 *
 * The identity carve (P3) is the one that exercised the service rule hardest, because identity
 * genuinely needs licence-shaped answers: its OIDC sign-in mints and claims licences, its browser
 * session authorizes a device and enforces the build gate. None of that became an
 * `identity -> license` import. It became `core/licensing/authz.ts` and `core/licensing/gate.ts`
 * — the same move `injectAdminPolicy` and the semver algebra made in P2. That is what "everything
 * else crosses via core-mediated interfaces" means in practice, and this suite is what stops the
 * cheaper answer from being taken next time.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
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

  if (
    segments[0] === "core" ||
    segments[0] === "platform" ||
    segments[0] === "db"
  )
    return null;

  if (segments[0] === "services") {
    const target = segments[1];
    if (target === service) return null;
    if (target && CROSS_SERVICE_EXCEPTIONS[service]?.includes(target))
      return null;
    return `imports service "${target}" from service "${service}"; the only sanctioned cross-service edge is update -> release (D-05). Route it through core/ instead`;
  }

  return `imports "${specifier}" (resolves to src/${resolved}); a service may only reach core/, platform/, db/, its own directory, and shared packages`;
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
    // come from `core/licensing/authz.ts` and `core/licensing/gate.ts`.
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
    // …and the live tree honours it: distribution imports only the lower layers and itself. The specifier
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
        !target.startsWith("src/core/") &&
        !target.startsWith("src/platform/") &&
        !target.startsWith("src/db/")
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
      "../../platform/crypto.js",
      "../../db/types.js",
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
      ["../../console/api.js", "the console"],
      ["../../console/lib/shape.js", "the console"],
      ["../../router.js", "a composition module"],
      ["../../services/release/public.js", "another service's public surface"],
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

// ── The layers (P0-17) ───────────────────────────────────────────────────────────────────────

const SRC = join(WORKER_ROOT, "src");
const srcRel = (abs: string) => relative(SRC, abs).split("\\").join("/");

/** The layer a `src/`-relative path belongs to. */
function layerOf(path: string): string {
  const [head, next] = path.split("/");
  if (next === undefined) return "root"; // a composition module: `src/<name>.ts`
  return head === "services" ? "services" : head!;
}

/** What each layer may import, by target layer (services/ is policed by `violation` above). */
const LAYER_ALLOWS: Record<string, readonly string[]> = {
  platform: ["platform", "db"],
  db: ["platform", "db"],
  core: ["core", "platform", "db"],
};

/**
 * Why `file` (a `src/`-relative path) may not import `specifier`, or `null`. The layers below
 * `services/` import only themselves and lower layers; the console reads a service only through
 * its `public.ts`; the composition modules are unrestricted.
 */
function layerViolation(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // packages are the service rule's concern
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (target.startsWith("..")) return `imports "${specifier}", outside src/`;
  const from = layerOf(file);
  const to = layerOf(target);
  const allows = LAYER_ALLOWS[from];
  if (allows && !allows.includes(to))
    return `src/${from}/ imports src/${target} ("${specifier}"); ${from}/ may import only ${allows.join("/, ")}/`;
  if (from === "console" && to === "services") {
    const [, slug, ...rest] = target.split("/");
    const file = rest.join("/").replace(/\.js$/, ".ts");
    if (file !== "public.ts")
      return `the console imports src/${target} ("${specifier}"); it reads a service only through services/${slug}/public.ts`;
  }
  return null;
}

function layerSites(): Array<{ file: string; specifier: string }> {
  const out: Array<{ file: string; specifier: string }> = [];
  for (const dir of ["platform", "db", "core", "console"])
    for (const abs of walkTs(join(SRC, dir)))
      for (const specifier of importsOf(readFileSync(abs, "utf8")))
        out.push({ file: srcRel(abs), specifier });
  return out;
}

describe("the layers (P0-17)", () => {
  it("holds for every file under src/platform, src/db, src/core and src/console", () => {
    const sites = layerSites();
    // Not a no-op: every layer is walked.
    for (const dir of ["platform/", "db/", "core/", "console/"])
      expect(
        sites.some((s) => s.file.startsWith(dir)),
        `${dir} should be walked`,
      ).toBe(true);
    const bad = sites
      .map((s) => {
        const why = layerViolation(s.file, s.specifier);
        return why ? `${s.file}: ${why}` : null;
      })
      .filter((v): v is string => v !== null);
    expect(bad).toEqual([]);
  });

  it("refuses an import into a higher layer (negative control)", () => {
    const refused: Array<[string, string]> = [
      ["platform/crypto.ts", "../core/repo.js"],
      ["platform/env.ts", "../router.js"],
      ["db/d1.ts", "../core/errors.js"],
      ["core/devices.ts", "../console/api.js"],
      ["core/devices.ts", "../services/release/store.js"],
      ["core/cors.ts", "../router.js"],
      ["core/licensing/payload.ts", "../../console/lib/shape.js"],
      ["core/console/audit.ts", "../../services/license/index.js"],
      ["core/assets/blobGc.ts", "../../mount.js"],
      ["console/handlers/feeds.ts", "../../services/release/packages/prune.js"],
      ["console/lib/shape.ts", "../../services/config/mint.js"],
    ];
    for (const [file, specifier] of refused)
      expect(
        layerViolation(file, specifier),
        `${file} -> ${specifier} should be refused`,
      ).not.toBeNull();
  });

  it("allows the lower layers and a service's public.ts", () => {
    const allowed: Array<[string, string]> = [
      ["platform/keyvault.ts", "./bytes.js"],
      ["platform/kv.ts", "../db/types.js"],
      ["core/devices.ts", "../platform/crypto.js"],
      ["core/licensing/payload.ts", "../repo.js"],
      ["core/console/audit.ts", "../../db/types.js"],
      ["console/handlers/feeds.ts", "../../services/release/public.js"],
      ["console/handlers/feeds.ts", "../../core/console/respond.js"],
      ["console/api.ts", "../mount.js"],
      ["dispatch.ts", "./services/release/routes.js"],
    ];
    for (const [file, specifier] of allowed)
      expect(
        layerViolation(file, specifier),
        `${file} -> ${specifier} should be allowed`,
      ).toBeNull();
  });
});

// ── Transitively (P0-48 seeded it report-only; P0-17 made it blocking) ──────────────────────

/** Runtime module specifiers: `import type` and `export type … from` are erased, so skipped. */
const RUNTIME_RE =
  /(?:^|[\s;}])(?:import|export)\s+(type\s+)?(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** The runtime import graph over `src/`, keyed and valued by `src/`-relative paths. */
function runtimeGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const abs of walkTs(SRC)) {
    const edges: string[] = [];
    for (const m of readFileSync(abs, "utf8").matchAll(RUNTIME_RE)) {
      if (m[1]) continue;
      const specifier = m[2] ?? m[3];
      if (!specifier?.startsWith(".")) continue;
      const base = resolve(dirname(abs), specifier).replace(/\.js$/, "");
      const target = [`${base}.ts`, join(base, "index.ts")].find((f) =>
        existsSync(f),
      );
      if (target) edges.push(srcRel(target));
    }
    graph.set(srcRel(abs), edges);
  }
  return graph;
}

/** Every file reachable from `root`, each with the path that first reached it. */
function reachFrom(
  graph: ReadonlyMap<string, readonly string[]>,
  root: string,
): Map<string, string> {
  const path = new Map<string, string>([[root, root]]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++)
    for (const next of graph.get(queue[i]!) ?? [])
      if (!path.has(next)) {
        path.set(next, `${path.get(queue[i]!)} → ${next}`);
        queue.push(next);
      }
  return path;
}

const serviceOf = (path: string): string | null => {
  const [head, slug] = path.split("/");
  return head === "services" ? (slug ?? null) : null;
};

/**
 * The transitive violations in `graph`: a service file reaching another service (but the
 * sanctioned `update → release`), and a platform/, db/ or core/ file reaching a service, the
 * console or a composition module. One example path each.
 */
function reachViolations(
  graph: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  for (const file of graph.keys()) {
    const layer = layerOf(file);
    const own = serviceOf(file);
    if (!own && !LAYER_ALLOWS[layer]) continue; // console/ and composition modules
    const seen = new Set<string>(); // one example per root and reached service or layer
    for (const [reached, path] of reachFrom(graph, file)) {
      const other = serviceOf(reached);
      const to = layerOf(reached);
      let what: string | null = null;
      if (own)
        what =
          other &&
          other !== own &&
          !CROSS_SERVICE_EXCEPTIONS[own]?.includes(other)
            ? `service ${own} reaches service ${other}`
            : null;
      else if (other) what = `${layer}/ reaches service ${other}`;
      else if (!LAYER_ALLOWS[layer]!.includes(to))
        what = `${layer}/ reaches ${to === "root" ? "a composition module" : `${to}/`}`;
      if (what && !seen.has(what)) {
        seen.add(what);
        out.push(`${what}: ${path}`);
      }
    }
  }
  return out.sort();
}

describe("transitive reach (blocking)", () => {
  const graph = runtimeGraph();

  it("no service reaches another (but update → release), and no lower layer reaches up", () => {
    expect(graph.size).toBeGreaterThan(100);
    expect(reachViolations(graph)).toEqual([]);
  });

  it("sees the sanctioned edge, so the walk is live", () => {
    const fromUpdate = [...graph.keys()]
      .filter((f) => serviceOf(f) === "update")
      .flatMap((f) => [...reachFrom(graph, f).keys()]);
    expect(fromUpdate.some((f) => serviceOf(f) === "release")).toBe(true);
  });

  it("catches a reach that is legal hop by hop (negative control)", () => {
    // The shape P0-48 measured: a service → Core's admin seam → the console's shaping module →
    // another service. Each hop passed the one-hop rule; the walk must not.
    const indirect = new Map<string, string[]>([
      ["services/license/admin/batches.ts", ["core/adminSeam.ts"]],
      ["core/adminSeam.ts", ["console/lib/shape.ts"]],
      ["console/lib/shape.ts", ["services/release/store.ts"]],
      ["services/release/store.ts", []],
    ]);
    expect(reachViolations(indirect)).toEqual([
      "core/ reaches console/: core/adminSeam.ts → console/lib/shape.ts",
      "core/ reaches service release: core/adminSeam.ts → console/lib/shape.ts → services/release/store.ts",
      "service license reaches service release: services/license/admin/batches.ts → core/adminSeam.ts → console/lib/shape.ts → services/release/store.ts",
    ]);
    // …while the sanctioned edge, and a type-only import, are not reach.
    expect(
      reachViolations(
        new Map([
          ["services/update/appcast.ts", ["services/release/channels.ts"]],
          ["services/release/channels.ts", ["core/hooks.ts"]],
          ["core/hooks.ts", []],
        ]),
      ),
    ).toEqual([]);
    const kinds = [
      ...'import type { A } from "./a.js";\nexport type { B } from "./b.js";\nimport { c } from "./c.js";'.matchAll(
        RUNTIME_RE,
      ),
    ].map((m) => (m[1] ? `type ${m[2]}` : (m[2] ?? m[3])));
    expect(kinds).toEqual(["type ./a.js", "type ./b.js", "./c.js"]);
  });
});
