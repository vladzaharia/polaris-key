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

const here = dirname(fileURLToPath(import.meta.url));
const spec = parseYaml(
  readFileSync(join(here, "..", "openapi", "polaris-key.v3.yaml"), "utf8"),
) as { paths: Record<string, Record<string, unknown>> };
const routerSource = readFileSync(
  join(here, "..", "src", "router.ts"),
  "utf8",
);

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
 * The canonical service surface — mirrors each `services/<slug>/routes.ts`. The `service`
 * route kind carries every one of these; documenting the KIND means documenting this table.
 */
const SERVICE_PATHS: Array<[string, string[]]> = [
  ["/{product}/license/activate", ["post"]],
  ["/{product}/license/enroll", ["post"]],
  ["/{product}/license/token", ["post"]],
  ["/{product}/license/deauthorize", ["post"]],
  ["/{product}/license/document", ["get"]],
  ["/{product}/config/document", ["get"]],
  ["/{product}/config/schema", ["get"]],
  ["/{product}/config/mint/{mintId}/token", ["get", "post"]],
  ["/{product}/config/mint/{mintId}/auth", ["get"]],
  ["/{product}/release/changelog", ["get"]],
  ["/{product}/release/install.sh", ["get"]],
  ["/{product}/release/dl/{version}/{asset}", ["get"]],
  ["/{product}/update/appcast.xml", ["get"]],
  ["/{product}/update/{channel}/appcast.xml", ["get"]],
  ["/{product}/update/version", ["get"]],
  ["/{product}/identity/session", ["get"]],
  ["/{product}/identity/session/license", ["post"]],
  ["/{product}/identity/auth/start", ["get"]],
  ["/{product}/identity/auth/callback", ["get"]],
  ["/{product}/identity/auth/poll", ["get"]],
  ["/{product}/identity/auth/logout", ["post"]],
  ["/{product}/identity/auth/device/start", ["post"]],
  ["/{product}/identity/auth/device/verify", ["get", "post"]],
  ["/{product}/identity/auth/device/poll", ["post"]],
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
    for (const [path, methods] of SERVICE_PATHS) {
      for (const method of methods) {
        expect(specMethods(path), `${method} ${path}`).toContain(method);
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
});

describe("spec → router", () => {
  it("the spec documents no path that does not exist", () => {
    const expected = new Set(
      [...Object.values(CORE_KIND_PATHS).flat(), ...SERVICE_PATHS, ...ALIAS_PATHS].map(
        ([path]) => path,
      ),
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
