/**
 * Router ↔ OpenAPI coverage — a route can be added but not silently undocumented.
 *
 * Three directions:
 *  1. Every `Route` kind the router SOURCE declares is either mapped to spec paths here or
 *     explicitly listed as narrative-only (browser surfaces the docs site documents in
 *     prose). A new kind fails until someone decides which it is.
 *  2. Every canonical service route (the `services/<slug>/routes.ts` dispatch surface,
 *     pinned as a table here) and all four permanent aliases exist in the spec with the
 *     right methods.
 *  3. The spec contains NO path outside the expected set — documentation for routes that do
 *     not exist is drift too.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SERVICES } from "../src/mount.js";
import { matchRoute } from "../src/router.js";

const here = dirname(fileURLToPath(import.meta.url));
const spec = parseYaml(
  readFileSync(join(here, "..", "openapi", "polaris-key.v3.yaml"), "utf8"),
) as { paths: Record<string, Record<string, unknown>> };
const routerSource = readFileSync(join(here, "..", "src", "router.ts"), "utf8");

/** Browser/admin surfaces documented narratively on the docs site, not in the wire spec. */
const NARRATIVE_ONLY = new Set([
  "adminSpa",
  "adminApi",
  "adminLogin",
  "adminCallback",
  "portalSpa",
  "portalApi",
  "portalLogin",
  "portalCallback",
  "portalLogout",
  "portalMagicVerify",
  "portalDownload",
  "products",
  "githubWebhook",
  "docs",
  "notFound",
  // A3-07. Not a surface: `badRequest` is what the router answers when the PATH will not decode,
  // so it documents no endpoint and has no method. It sits here rather than in the table below
  // for the same reason `notFound` does.
  "badRequest",
]);

/** Core route kinds → the spec paths (with methods) that document them. */
const CORE_KIND_PATHS: Record<string, Array<[string, string[]]>> = {
  discovery: [["/{product}/.well-known/polaris.json", ["get"]]],
  jwks: [["/{product}/.well-known/jwks.json", ["get"]]],
  trustManifest: [["/{product}/.well-known/polaris-trust.jws", ["get"]]],
  devices: [
    ["/{product}/devices", ["get"]],
    ["/{product}/devices/{deviceId}", ["get", "patch", "delete"]],
  ],
  report: [["/{product}/devices/report", ["post"]]],
  register: [["/{product}/devices/register", ["post"]]],
};

/**
 * The canonical service surface — DERIVED from the composition root (B7-09).
 *
 * This used to be a hand-written literal transcribing each `services/<slug>/routes.ts`, which
 * made the gate answerable in the wrong direction: it compared one copy of the spec against
 * another copy of the spec, so a service could grow a route, nobody could document it, and the
 * test stayed green because neither side of the comparison knew about it. Now the list comes off
 * `ServiceDescriptor.surface` — declared beside the router it describes, in the service's own
 * directory — so this file no longer holds an opinion about the service surface at all, and a
 * service added to or removed from `mount.ts` changes what this test demands without anybody
 * editing this file.
 *
 * `mount.ts` is the ONE table both dispatchers use (public router + admin API), so deriving from
 * it also means a service that is declared but never mounted contributes nothing here.
 */
const SERVICE_PATHS: Array<[string, string[]]> = [...SERVICES.values()].flatMap(
  (descriptor) =>
    descriptor.surface.map((route): [string, string[]] => [
      route.path,
      [...route.methods],
    ]),
);

/**
 * The admin surface the spec documents — the ONE exception to "admin is narrative-only".
 *
 * `adminApi` stays in `NARRATIVE_ONLY` above because the route KIND is: `/manage/api/*` is a
 * browser API driven by a session cookie and a CSRF double-submit, and the docs site describes it
 * in prose. The API-TOKEN surface underneath that kind is different in the one way that matters
 * here — it is spoken by a program (`pkey bundle`, from a terminal and from CI) with an
 * `Authorization: Bearer pkeya_…` header and no browser anywhere — so it is documented in the
 * machine-readable file and pinned in BOTH directions, exactly like a service route: missing from
 * the spec fails the first test below, present in the spec but absent from this table fails the
 * phantom-path sweep.
 */
const ADMIN_PATHS: Array<[string, string[]]> = [
  ["/manage/api/tokens", ["get", "post"]],
  ["/manage/api/tokens/{tokenId}", ["delete"]],
];

/** The four permanent pre-namespace aliases (D-07). */
const ALIAS_PATHS: Array<[string, string[]]> = [
  ["/{product}/appcast.xml", ["get"]],
  ["/{product}/{channel}/appcast.xml", ["get"]],
  ["/{product}/install.sh", ["get"]],
  ["/{product}/version", ["get"]],
];

function specMethods(path: string): string[] {
  const entry = spec.paths[path];
  if (!entry) return [];
  return Object.keys(entry).filter((k) =>
    ["get", "post", "put", "patch", "delete"].includes(k),
  );
}

describe("router → spec", () => {
  it("every Route kind is documented or explicitly narrative-only", () => {
    const kinds = [...routerSource.matchAll(/kind: "([a-zA-Z]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(kinds.length).toBeGreaterThan(15);
    const documented = new Set([...Object.keys(CORE_KIND_PATHS), "service"]);
    const unhandled = [...new Set(kinds)].filter(
      (kind) => !documented.has(kind) && !NARRATIVE_ONLY.has(kind),
    );
    expect(
      unhandled,
      `route kinds neither documented nor narrative-only: ${unhandled.join(", ")}`,
    ).toEqual([]);
  });

  for (const [kind, paths] of Object.entries(CORE_KIND_PATHS)) {
    it(`core kind "${kind}" is documented`, () => {
      for (const [path, methods] of paths) {
        for (const method of methods) {
          expect(specMethods(path), `${method} ${path}`).toContain(method);
        }
      }
    });
  }

  it("every canonical service route is documented", () => {
    expect(SERVICE_PATHS.length).toBeGreaterThan(20);
    for (const [path, methods] of SERVICE_PATHS) {
      for (const method of methods) {
        expect(specMethods(path), `${method} ${path}`).toContain(method);
      }
    }
  });

  it("every mounted service declares a surface", () => {
    for (const [slug, descriptor] of SERVICES) {
      expect(
        descriptor.surface.length,
        `${slug} declares no routes`,
      ).toBeGreaterThan(0);
      for (const route of descriptor.surface) {
        expect(route.path, `${slug}: ${route.path}`).toMatch(
          new RegExp(`^/\\{product\\}/${slug}/`),
        );
        expect(route.methods.length, `${slug}: ${route.path}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  /**
   * B7-09's other half: a DECLARED path must be one the core router actually dispatches to that
   * service. Without this the surface would be prose in a different file — a service could
   * declare a path it does not serve and the spec would faithfully document a 404.
   *
   * Templates are instantiated with concrete segments (`{channel}` → `beta`, `{version}` →
   * `1.2.3`, …) because `matchRoute` works on real pathnames, not on templates.
   */
  it("every declared service route is dispatched to its own service", () => {
    const sample: Record<string, string> = {
      "{channel}": "beta",
      "{version}": "1.2.3",
      "{asset}": "djdl-arm64",
      "{mintId}": "musickit",
      "{deviceId}": "d".repeat(32),
    };
    for (const [slug, descriptor] of SERVICES) {
      for (const route of descriptor.surface) {
        const pathname = route.path
          .replace("/{product}/", "/djdl/")
          .split("/")
          .map((seg) => sample[seg] ?? seg)
          .join("/");
        const matched = matchRoute(pathname);
        expect(matched.kind, `${route.path} → ${pathname}`).toBe("service");
        expect(
          matched.kind === "service" ? matched.slug : null,
          `${route.path} → ${pathname}`,
        ).toBe(slug);
      }
    }
  });

  it("all four permanent aliases are documented", () => {
    for (const [path, methods] of ALIAS_PATHS) {
      for (const method of methods) {
        expect(specMethods(path), `${method} ${path}`).toContain(method);
      }
    }
  });

  it("the documented admin surface exists in the spec", () => {
    for (const [path, methods] of ADMIN_PATHS) {
      for (const method of methods) {
        expect(specMethods(path), `${method} ${path}`).toContain(method);
      }
    }
  });

  /** The admin routes are the one place the spec crosses into `/manage`; nothing else may. */
  it("no other admin path leaks into the spec", () => {
    const allowed = new Set(ADMIN_PATHS.map(([path]) => path));
    const stray = Object.keys(spec.paths).filter(
      (path) => path.startsWith("/manage") && !allowed.has(path),
    );
    expect(stray, `undeclared /manage paths: ${stray.join(", ")}`).toEqual([]);
  });
});

describe("spec → router", () => {
  it("the spec documents no path that does not exist", () => {
    const expected = new Set(
      [
        ...Object.values(CORE_KIND_PATHS).flat(),
        ...SERVICE_PATHS,
        ...ADMIN_PATHS,
        ...ALIAS_PATHS,
      ].map(([path]) => path),
    );
    const phantom = Object.keys(spec.paths).filter(
      (path) => !expected.has(path),
    );
    expect(
      phantom,
      `spec paths with no corresponding route: ${phantom.join(", ")}`,
    ).toEqual([]);
  });

  it("alias operations are marked as aliases and rewrite targets exist", () => {
    for (const [path] of ALIAS_PATHS) {
      const op = spec.paths[path]?.get as
        | { tags?: string[]; summary?: string }
        | undefined;
      expect(op?.tags, path).toContain("aliases");
      // Every alias names its canonical target in the summary; that target must be a
      // documented path too (rewrites cannot point at nothing).
      const target = op?.summary?.match(/→ (\/\S+)/)?.[1];
      expect(target, `${path} summary must name its target`).toBeTruthy();
      expect(spec.paths[target!], `${path} → ${target}`).toBeTruthy();
    }
  });
});
