/**
 * The registry host (F-02, plans/F-01.md §6.1): every row of the isolation contract, pinned.
 *
 * Adapted from `bytesHost.test.ts`: the registry host is that host's sibling and keeps every one
 * of its compensations (no cookies, `nosniff`, a `sandbox` CSP, JSON errors), adds
 * `Cross-Origin-Resource-Policy: same-origin`, answers NO CORS at all, and widens only the type
 * allowlist.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { feedRoute } from "../src/services/distribution/registry/serve.js";
import worker from "../src/index.js";
import { REGISTRY_ROUTES } from "../src/mount.js";
import {
  PYPI_HTML_TYPE,
  REGISTRY_CSP,
  REGISTRY_ECOSYSTEMS,
  REGISTRY_HOST_TYPES,
  RESERVED_ECOSYSTEMS,
  dispatchRegistryHost,
  isRegistryHost,
  refusedRegistryType,
  registryEcosystemOf,
  registryHostname,
  registryOrigin,
  FEED_AUTH_ROUTE,
  FEED_PUBLISH_ROUTE,
  FEED_PUSH_ROUTE,
  FEED_READ_ROUTE,
  type RegistryRoute,
} from "../src/core/registryHost.js";
import { inertDocumentPolicy } from "../src/core/bytesHost.js";
import { BLOB_CSP } from "../src/core/blobs.js";
import { LANDING_CSS, landingCsp } from "../src/core/bytesLanding.js";
import { ADMIN_COOKIE } from "../src/admin/session.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import { serializeWebOrigins } from "../src/core/cors.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const PKG = "https://pkg.example.test";
const BYTES = "https://dl.example.test";
const CONSOLE = "https://key.example.test";

function env(pkgOrigin?: string, blobOrigin: string | undefined = BYTES): Env {
  const e = makeEnv(new KvMock(), []);
  if (blobOrigin !== undefined) e.BLOB_ORIGIN = blobOrigin;
  if (pkgOrigin !== undefined) e.PKG_ORIGIN = pkgOrigin;
  return e;
}

/** Console, portal, docs, product, service and byte-route paths: none answers on the host. */
const CONSOLE_PATHS = [
  "/index.html",
  "/favicon.ico",
  "/manage",
  "/manage/api/me",
  "/manage/login",
  "/docs",
  "/docs/start/concepts/",
  "/login",
  "/api/me",
  "/download/abc",
  "/djdl",
  "/djdl/.well-known/polaris.json",
  "/djdl/.well-known/jwks.json",
  "/djdl/release/dl/x",
  "/djdl/appcast.xml",
  "/djdl/distribution/download",
  "/djdl/distribution/blobs/sha256/" + "a".repeat(64),
  "/djdl/release/builds/stable/macos",
  "/webhooks/github",
  "/blobs/sha256/" + "a".repeat(64),
  "/oci/djdl/x",
];

/** The headers every answer on the host carries. */
function expectHardened(res: Response, at: string, csp = REGISTRY_CSP): void {
  expect(res.headers.get("set-cookie"), at).toBeNull();
  expect(res.headers.get("x-content-type-options"), at).toBe("nosniff");
  expect(res.headers.get("content-security-policy"), at).toBe(csp);
  expect(res.headers.get("referrer-policy"), at).toBe("no-referrer");
  expect(res.headers.get("cross-origin-resource-policy"), at).toBe(
    "same-origin",
  );
  for (const [k] of res.headers)
    expect(k.startsWith("access-control-"), `${at}: ${k}`).toBe(false);
}

async function snapshot(res: Response): Promise<unknown> {
  return {
    status: res.status,
    headers: [...res.headers].filter(([k]) => k !== "date"),
    body: await res.text(),
  };
}

async function outcome(req: Request, e: Env): Promise<unknown> {
  try {
    return await snapshot(await worker.fetch(req, e));
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

async function setProductServices(
  db: Db,
  slug: string,
  services: Partial<ServicesMap>,
): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
        ...services,
      },
    }),
    "manifest",
    NOW,
  );
}

// ── Configuration ────────────────────────────────────────────────────────────────────────────

describe("registry host: configuration", () => {
  it("resolves PKG_ORIGIN to a lowercase hostname, and nothing for unset, junk or the bytes host", () => {
    expect(registryHostname({ PKG_ORIGIN: "https://PKG.plrs.im" })).toBe(
      "pkg.plrs.im",
    );
    expect(registryHostname({ PKG_ORIGIN: "https://pkg.plrs.im./" })).toBe(
      "pkg.plrs.im",
    );
    expect(
      isRegistryHost(new URL("https://PKG.plrs.im../manage"), {
        PKG_ORIGIN: "https://pkg.plrs.im",
      }),
    ).toBe(true);
    expect(
      isRegistryHost(new URL("https://key.plrs.im/"), {
        PKG_ORIGIN: "https://pkg.plrs.im",
      }),
    ).toBe(false);
    expect(registryHostname({})).toBeNull();
    expect(registryHostname({ PKG_ORIGIN: "" })).toBeNull();
    expect(registryHostname({ PKG_ORIGIN: "not a url" })).toBeNull();
    expect(registryHostname({ PKG_ORIGIN: "ftp://pkg.plrs.im" })).toBeNull();
    // The bytes host wins: a PKG_ORIGIN naming it is no registry host at all.
    expect(
      registryHostname({
        PKG_ORIGIN: "https://dl.plrs.im",
        BLOB_ORIGIN: "https://DL.plrs.im",
      }),
    ).toBeNull();
    expect(registryOrigin({ PKG_ORIGIN: "https://pkg.plrs.im/x" })).toBe(
      "https://pkg.plrs.im",
    );
    expect(registryOrigin({})).toBeNull();
  });

  it("the committed wrangler.toml gives each environment its own pkg custom domain and PKG_ORIGIN", () => {
    const toml = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    for (const [envName, host] of [
      ["prod", "pkg.plrs.im"],
      ["staging", "pkg-staging.plrs.im"],
      ["dev", "pkg-dev.plrs.im"],
    ] as const) {
      const block = toml
        .split(`[env.${envName}]`)[1]!
        .split(/\n\[env\.(?!\w+\.)/)[0]!;
      expect(block, envName).toContain(`PKG_ORIGIN = "https://${host}"`);
      expect(block, envName).toMatch(
        new RegExp(
          `pattern = "${host.replace(/\./g, "\\.")}"\\s*\\ncustom_domain = true`,
        ),
      );
    }
  });

  it("no environment deploys a pkg route without PKG_ORIGIN, or points PKG_ORIGIN at another host", () => {
    const toml = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    const blocks = toml.split(/\n(?=\[env\.[a-z]+\]\n)/).slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      const name = /^\[env\.([a-z]+)\]/.exec(block)![1]!;
      const patterns = [...block.matchAll(/pattern = "([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      const origin = /PKG_ORIGIN = "([^"]+)"/.exec(block)?.[1];
      const blob = /BLOB_ORIGIN = "([^"]+)"/.exec(block)?.[1];
      const pkgHosts = patterns.filter((p) => /^pkg[.-]/.test(p));
      if (pkgHosts.length > 0)
        expect(origin, `${name}: a pkg route needs PKG_ORIGIN`).toBeDefined();
      if (origin !== undefined) {
        const host = registryHostname({
          PKG_ORIGIN: origin,
          ...(blob ? { BLOB_ORIGIN: blob } : {}),
        });
        expect(
          host,
          `${name}: PKG_ORIGIN must parse and differ from BLOB_ORIGIN`,
        ).not.toBeNull();
        expect(
          pkgHosts,
          `${name}: PKG_ORIGIN names its own pkg route`,
        ).toContain(host);
      }
    }
  });

  it("every registry route is Distribution's (Release's for a native publish or an OCI push), names a known live ecosystem and has a unique name", () => {
    // F-04 to F-09 add theirs; routeCoverage's REGISTRY_PATHS follows them (rule 10).
    expect(REGISTRY_ROUTES.length).toBeGreaterThan(0);
    const names = REGISTRY_ROUTES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const r of REGISTRY_ROUTES) {
      // A publish (F-22) or push (F-23) is Release's ingest (rule 6); every read and credential
      // route is Distribution's.
      expect(r.service, r.name).toBe(
        r[FEED_PUBLISH_ROUTE] || r[FEED_PUSH_ROUTE]
          ? "release"
          : "distribution",
      );
      expect(REGISTRY_ECOSYSTEMS).toContain(r.ecosystem);
      expect(RESERVED_ECOSYSTEMS.has(r.ecosystem), r.name).toBe(false);
    }
  });

  it("the ecosystem of a path: oci at /v2, the closed list elsewhere, nothing for a product slug", () => {
    expect(registryEcosystemOf("/v2")).toBe("oci");
    expect(registryEcosystemOf("/v2/")).toBe("oci");
    expect(registryEcosystemOf("/v2/acme/app/manifests/1")).toBe("oci");
    expect(registryEcosystemOf("/v20")).toBeNull();
    expect(registryEcosystemOf("/npm/acme/@acme%2fsdk")).toBe("npm");
    expect(registryEcosystemOf("/pypi")).toBe("pypi");
    expect(registryEcosystemOf("/oci/acme/x")).toBeNull();
    expect(registryEcosystemOf("/djdl/release/x")).toBeNull();
    expect(registryEcosystemOf("/NPM/acme")).toBeNull();
    expect(registryEcosystemOf("/")).toBeNull();
  });
});

describe("registry host: the type allowlist", () => {
  it("every allowed type is inert: no HTML, XML, SVG or script; text/x-swift is the only text type", () => {
    for (const t of REGISTRY_HOST_TYPES) {
      expect(t, t).not.toMatch(/html|xml|svg|script|ecmascript|multipart/i);
      if (t.startsWith("text/")) expect(t).toBe("text/x-swift");
    }
    expect(REGISTRY_HOST_TYPES.has(PYPI_HTML_TYPE)).toBe(false);
    expect(REGISTRY_HOST_TYPES.has("text/html")).toBe(false);
    expect(REGISTRY_HOST_TYPES.has("application/xml")).toBe(false);
    expect([...REGISTRY_HOST_TYPES].sort()).toEqual(
      [
        "application/json",
        "application/vnd.npm.install-v1+json",
        "application/vnd.pypi.simple.v1+json",
        "application/vnd.swift.registry.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "text/x-swift",
        "image/png",
        "image/jpeg",
        "application/zip",
        "application/gzip",
        "application/x-tar",
        "application/octet-stream",
      ].sort(),
    );
    expect(REGISTRY_CSP).toBe(BLOB_CSP);
  });

  it("refuses never-served types at every status, and unlisted ones on success", () => {
    const r = (type: string | null, status = 200, body: string | null = "x") =>
      refusedRegistryType(
        new Response(body, {
          status,
          headers: type === null ? {} : { "content-type": type },
        }),
      );
    for (const t of [
      "text/html",
      "text/html; charset=utf-8",
      PYPI_HTML_TYPE,
      "image/svg+xml",
      "application/xml",
      "text/xml",
      "application/xhtml+xml",
      "text/javascript",
      "application/javascript",
      "application/ecmascript",
      "text/plain",
      "text/css",
      "multipart/form-data",
    ]) {
      expect(r(t), t).toBe(true);
      expect(r(t, 404), `${t} 404`).toBe(true);
    }
    expect(r(null)).toBe(true);
    expect(r(null, 304, null)).toBe(false);
    expect(r("image/gif")).toBe(true);
    expect(r("application/problem+json")).toBe(true);
    expect(r("application/problem+json", 404)).toBe(false);
    expect(r("application/json", 401)).toBe(false);
    for (const t of REGISTRY_HOST_TYPES) expect(r(t), t).toBe(false);
    expect(r("text/x-swift; charset=utf-8")).toBe(false);
  });
});

// ── Isolation ────────────────────────────────────────────────────────────────────────────────

describe("registry host: isolation", () => {
  it("every console, portal, docs, product and byte path answers the plain not-found there", async () => {
    for (const path of CONSOLE_PATHS) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const res = await worker.fetch(
          new Request(PKG + path, {
            method,
            headers: { cookie: `${ADMIN_COOKIE}=x` },
          }),
          env(PKG),
        );
        const at = `${method} ${path}`;
        expect(res.status, at).toBe(404);
        if (method !== "HEAD")
          expect(await res.json(), at).toEqual({ error: "not_found" });
        expectHardened(res, at);
        expect(res.headers.get("strict-transport-security"), at).toContain(
          "max-age=",
        );
      }
    }
  });

  it("the fully-qualified, upper-case or ported host is the registry host too", async () => {
    for (const base of [PKG + ".", "https://PKG.example.test.:443"]) {
      for (const path of CONSOLE_PATHS) {
        const res = await worker.fetch(new Request(base + path), env(PKG));
        expect(res.status, base + path).toBe(404);
        expectHardened(res, base + path);
      }
    }
  });

  it("with PKG_ORIGIN unset or junk, routing is byte-identical on every host", async () => {
    for (const path of [...CONSOLE_PATHS, "/", "/v2/"]) {
      for (const host of [CONSOLE, PKG, BYTES]) {
        const without = await outcome(new Request(host + path), env());
        const junk = await outcome(new Request(host + path), env("not a url"));
        expect(junk, host + path).toEqual(without);
      }
    }
  });

  it("with PKG_ORIGIN set, the console and bytes hosts are unchanged", async () => {
    for (const path of [...CONSOLE_PATHS, "/", "/v2/"]) {
      for (const host of [CONSOLE, BYTES]) {
        const without = await outcome(new Request(host + path), env());
        const withIt = await outcome(new Request(host + path), env(PKG));
        expect(withIt, host + path).toEqual(without);
      }
    }
  });

  it("a PKG_ORIGIN equal to BLOB_ORIGIN leaves the bytes host in charge", async () => {
    const res = await worker.fetch(
      new Request(`${BYTES}/manage`),
      env(BYTES, BYTES),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
  });

  it("reserved ecosystems (cargo, go, nuget) and unknown repositories answer the not-found", async () => {
    for (const path of [
      "/cargo/djdl/index/config.json",
      "/go/djdl/example.com/m/@v/list",
      "/nuget/djdl/v3/index.json",
      // No D1 here, so only paths no route matches: F-04's npm routes load the owner for a
      // scoped name (test/registry/npm.test.ts pins their not-found with a database).
      "/npm/djdl/sdk",
      // `/pypi/…` has routes since F-05 (its unknown owners: test/registry/pypi.test.ts).
      // Maven has routes (F-07): its unknown owners and repositories are pinned, with a
      // database, in test/registry/maven.test.ts.
      // No Godot route matches this path (F-09's routes are pinned in test/registry/godot.test.ts).
      "/godot/djdl/no-such-document.json",
    ]) {
      const res = await worker.fetch(new Request(PKG + path), env(PKG));
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "not_found" });
      expectHardened(res, path);
    }
    // A path no Swift route matches (F-06's routes read D1, which this env does not seed).
    const swift = await worker.fetch(
      new Request(`${PKG}/swift/djdl/acme`),
      env(PKG),
    );
    expect(swift.status).toBe(404);
    expect(swift.headers.get("content-type")).toBe("application/problem+json");
    const oci = await worker.fetch(
      // F-08's routes answer repository paths (with a database: test/registryOci.test.ts); a
      // path no OCI route matches, like the catalog (not served in tier 1), is the not-found.
      new Request(`${PKG}/v2/_catalog`),
      env(PKG),
    );
    expect(oci.status).toBe(404);
    expect(await oci.json()).toEqual({
      errors: [
        {
          code: "NAME_UNKNOWN",
          message: "repository name not known to registry",
        },
      ],
    });
    expectHardened(oci, "oci");
  });
});

describe("registry host: methods and CORS", () => {
  it("GET and HEAD only: any other method on a registry path is 405, with OCI's body under /v2/", async () => {
    // F-23 declares POST on `…/blobs/uploads/` and PUT on `…/manifests/<reference>`; a method no
    // route declares for the path is still the 405, before any owner loads.
    for (const [method, path] of [
      ["POST", "/v2/djdl/app/tags/list"],
      ["PUT", "/v2/djdl/app/blobs/uploads/"],
      ["PATCH", "/v2/djdl/app/blobs/uploads/"],
      ["DELETE", "/v2/djdl/app/manifests/1.0.0"],
      ["POST", "/v2/djdl/app/manifests/1.0.0"],
      ["OPTIONS", "/v2/djdl/app/blobs/uploads/"],
    ] as const) {
      const oci = await worker.fetch(
        new Request(`${PKG}${path}`, { method }),
        env(PKG),
      );
      expect(oci.status, `${method} ${path}`).toBe(405);
      expect(await oci.json(), method).toEqual({
        errors: [
          { code: "UNSUPPORTED", message: "The operation is unsupported." },
        ],
      });
      expectHardened(oci, method);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      // A tarball path: F-22's `npm publish` route answers PUT on the packument path, and only
      // there (`registryPublish.test.ts`); every other write on an npm path stays 405.
      const npm = await worker.fetch(
        new Request(`${PKG}/npm/djdl/@djdl%2fsdk/-/sdk-1.0.0.tgz`, { method }),
        env(PKG),
      );
      expect(npm.status, method).toBe(405);
      expect(npm.headers.get("allow"), method).toBe("GET, HEAD");
      expect(await npm.json(), method).toEqual({ error: "method_not_allowed" });
      expectHardened(npm, method);
    }
  });

  it("no preflight is ever answered: OPTIONS is 405 everywhere, with no Access-Control-* header", async () => {
    for (const path of ["/", "/v2/", "/npm/djdl/x", "/manage", "/djdl"]) {
      const res = await worker.fetch(
        new Request(PKG + path, {
          method: "OPTIONS",
          headers: {
            origin: "https://evil.example",
            "access-control-request-method": "GET",
          },
        }),
        env(PKG),
      );
      expect(res.status, path).toBe(405);
      expectHardened(res, path);
    }
  });
});

// ── The fixed answers ────────────────────────────────────────────────────────────────────────

describe("registry host: OCI's /v2/ root", () => {
  it("GET /v2/ and /v2 answer 200 with Docker-Distribution-API-Version, hardened", async () => {
    for (const path of ["/v2/", "/v2"]) {
      const res = await worker.fetch(
        new Request(PKG + path, { headers: { cookie: "a=b" } }),
        env(PKG),
      );
      expect(res.status, path).toBe(200);
      expect(res.headers.get("docker-distribution-api-version")).toBe(
        "registry/2.0",
      );
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({});
      expectHardened(res, path);
    }
    const head = await worker.fetch(
      new Request(`${PKG}/v2/`, { method: "HEAD" }),
      env(PKG),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

function sha256B64(text: string): string {
  return createHash("sha256").update(text).digest("base64");
}

describe("registry host: the landing page at /", () => {
  it("GET / answers the static page under the inert policy, with every host header", async () => {
    const e = env(PKG);
    e.CONSOLE_ORIGIN = CONSOLE;
    const res = await worker.fetch(
      new Request(`${PKG}/`, { headers: { cookie: "a=b" } }),
      e,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(await landingCsp());
    expect(inertDocumentPolicy(csp)).toBe(true);
    expect(csp).not.toMatch(/script|connect-src|allow-|'self'|'unsafe/);
    expect(csp).toContain(`'sha256-${sha256B64(LANDING_CSS)}'`);
    expectHardened(res, "/", csp);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-disposition")).toBeNull();
    const html = await res.text();
    expect(html).not.toMatch(
      /<script|\son[a-z]+=|\sstyle=|<form|<iframe|<object|<embed|@import|@font-face|url\(/i,
    );
    expect(html).toContain('role="img" aria-label="Polaris Key Delivery"');
    expect(html).toContain("<title>Polaris Key Delivery</title>");
    expect(html).toContain(
      "The package registry for libraries and tools published through Polaris Key.",
    );
    expect(html).not.toContain("noindex");
    const urls = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((u) => !u.startsWith("data:image/svg+xml,"));
    expect(urls).toEqual([`${CONSOLE}/`, `${CONSOLE}/docs/`]);
  });

  it("HEAD / has no body; other methods keep the not-found; the console host's / is untouched", async () => {
    const head = await worker.fetch(
      new Request(`${PKG}/`, { method: "HEAD" }),
      env(PKG),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await worker.fetch(
      new Request(`${PKG}/`, { method: "POST" }),
      env(PKG),
    );
    expect(post.status).toBe(404);
    expectHardened(post, "POST /");
    const consoleRoot = await worker.fetch(
      new Request(`${CONSOLE}/`),
      env(PKG),
    );
    expect(await consoleRoot.text()).not.toContain("The package registry");
  });

  it("staging and dev hosts name their environment and are not indexed; junk CONSOLE_ORIGIN falls back", async () => {
    for (const [origin, word] of [
      ["https://pkg-staging.plrs.im", "Staging"],
      ["https://pkg-dev.plrs.im", "Development"],
    ] as const) {
      const e = env(origin);
      e.CONSOLE_ORIGIN = "javascript:alert(1)";
      const html = await (
        await worker.fetch(new Request(`${origin}/`), e)
      ).text();
      expect(html, origin).toContain(`<p class="env">${word} environment</p>`);
      expect(html, origin).toContain(
        `<title>Polaris Key Delivery (${word})</title>`,
      );
      expect(html, origin).toContain(
        '<meta name="robots" content="noindex, nofollow">',
      );
      expect(html, origin).toContain('href="https://key.plrs.im/"');
      expect(html, origin).not.toContain("javascript:");
    }
  });
});

// ── Dispatch through fake routes ─────────────────────────────────────────────────────────────

describe("registry host: the access ladder cannot be skipped", () => {
  it("every REGISTRY_ROUTES read is built by feedRoute (serveFeedRead around its work)", () => {
    for (const route of REGISTRY_ROUTES) {
      if (route.methods !== undefined) continue;
      expect(route[FEED_READ_ROUTE], `${route.name} skips the ladder`).toBe(
        true,
      );
    }
  });

  it("the only non-read routes are F-21's credential routes (feedAuthRoute, POST), F-22's publish routes (publishRoute) and F-23's push routes (Release's, OCI only)", () => {
    const others = REGISTRY_ROUTES.filter((r) => r.methods !== undefined);
    const auth = others.filter((r) => r[FEED_AUTH_ROUTE]);
    const publish = others.filter((r) => r[FEED_PUBLISH_ROUTE]);
    const push = others.filter((r) => r[FEED_PUSH_ROUTE]);
    expect(auth.map((r) => r.name)).toEqual(["swift.login"]);
    expect(publish.map((r) => r.name).sort()).toEqual(
      ["npm.publish", "pypi.upload", "swift.publish", "maven.deploy"].sort(),
    );
    expect(push.map((r) => r.name)).toEqual([
      "oci.push.uploads",
      "oci.push.upload",
      "oci.push.manifest",
    ]);
    expect(auth.length + publish.length + push.length).toBe(others.length);
    for (const route of auth) {
      expect(route[FEED_READ_ROUTE], route.name).toBeUndefined();
      expect(route[FEED_PUSH_ROUTE], route.name).toBeUndefined();
      expect(route[FEED_PUBLISH_ROUTE], route.name).toBeUndefined();
      expect(route.methods, route.name).toEqual(["POST"]);
    }
    for (const route of publish) {
      expect(route[FEED_READ_ROUTE], route.name).toBeUndefined();
      expect(route[FEED_AUTH_ROUTE], route.name).toBeUndefined();
      expect(route[FEED_PUSH_ROUTE], route.name).toBeUndefined();
      expect(route.service, route.name).toBe("release");
      expect(route.methods, route.name).toEqual([
        route.name === "pypi.upload" ? "POST" : "PUT",
      ]);
    }
    for (const route of push) {
      expect(route[FEED_READ_ROUTE], route.name).toBeUndefined();
      expect(route[FEED_AUTH_ROUTE], route.name).toBeUndefined();
      expect(route.service, route.name).toBe("release");
      expect(route.ecosystem, route.name).toBe("oci");
    }
  });

  it("feedRoute marks its routes and a hand-written route is not marked", () => {
    const built = feedRoute({
      name: "x",
      ecosystem: "npm",
      match: () => null,
      deliverableId: () => null,
      serve: async () => new Response(""),
    });
    expect(built[FEED_READ_ROUTE]).toBe(true);
    const handWritten: RegistryRoute = {
      name: "y",
      service: "distribution",
      ecosystem: "npm",
      match: () => null,
      handle: async () => new Response(""),
    };
    expect(handWritten[FEED_READ_ROUTE]).toBeUndefined();
  });
});

describe("registry host: dispatch", () => {
  const SLUG = "djdl";
  const seen: Request[] = [];
  let db: Db;

  beforeEach(async () => {
    seen.length = 0;
    db = makeTestDb();
    await seedProduct(db, SLUG);
    await setProductServices(db, SLUG, { distribution: { enabled: true } });
    await db.run(
      "UPDATE products SET web_origins_json = ? WHERE slug = ?",
      serializeWebOrigins(["https://play.djdl.example"]),
      SLUG,
    );
  });

  /** A fake npm route under `/npm/<owner>/fake/...`. */
  const echo = (
    body: BodyInit | null,
    headers: Record<string, string>,
    status = 200,
    extra: Partial<RegistryRoute> = {},
  ): RegistryRoute => ({
    name: "fake",
    service: "distribution",
    ecosystem: "npm",
    match: (p) => {
      const m = /^\/npm\/([^/]+)\/fake\/(.*)$/.exec(p);
      return m ? { owner: m[1]!, params: { rest: m[2]! } } : null;
    },
    handle: async (req, ctx) => {
      seen.push(req);
      expect(ctx.product.slug).toBe(SLUG);
      expect(ctx.ecosystem).toBe("npm");
      return new Response(body, { status, headers });
    },
    ...extra,
  });
  const jsonType = { "content-type": "application/json" };
  const go = (
    route: RegistryRoute,
    path = `/npm/${SLUG}/fake/a`,
    init?: RequestInit,
  ) =>
    dispatchRegistryHost(new Request(PKG + path, init), env(PKG), db, [route]);

  it("only routes of the path's ecosystem answer; the Cookie header never reaches them; Set-Cookie is dropped", async () => {
    const route = echo("{}", { ...jsonType, "set-cookie": "pkey_x=1; Path=/" });
    const res = await go(route, `/npm/${SLUG}/fake/a`, {
      headers: { cookie: `${ADMIN_COOKIE}=forged; ${PORTAL_COOKIE}=forged` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("cookie")).toBeNull();
    expectHardened(res, "route");
    // The same path shape under another ecosystem never reaches an npm route.
    const other = await go(route, `/pypi/${SLUG}/fake/a`);
    expect(other.status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it("an unknown owner, or Distribution off for the owner, answers the not-found without running", async () => {
    const route = echo("{}", jsonType);
    const unknown = await go(route, "/npm/nobody/fake/a");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
    await setProductServices(db, SLUG, { distribution: { enabled: false } });
    const off = await go(route);
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: "not_found" });
    expect(seen).toHaveLength(0);
    expectHardened(off, "off");
  });

  it("a route answering HTML, SVG, XML, script or plain text is overridden by the not-found", async () => {
    for (const type of [
      "text/html; charset=utf-8",
      "image/svg+xml",
      "application/xml",
      "text/xml",
      "application/javascript",
      "text/plain",
      PYPI_HTML_TYPE,
    ]) {
      const res = await go(echo("<x/>", { "content-type": type }));
      expect(res.status, type).toBe(404);
      expect(await res.json(), type).toEqual({ error: "not_found" });
      expectHardened(res, type);
    }
    const untyped = await go(echo("bytes", {}));
    expect(untyped.status).toBe(404);
    const html500 = await go(
      echo("<h1>oops</h1>", { "content-type": "text/html" }, 500),
    );
    expect(html500.status).toBe(404);
  });

  it("a route cannot set its own Access-Control-* headers", async () => {
    const res = await go(
      echo("{}", {
        ...jsonType,
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
      }),
      `/npm/${SLUG}/fake/a`,
      { headers: { origin: "https://play.djdl.example" } },
    );
    expect(res.status).toBe(200);
    expectHardened(res, "cors");
  });

  it("archives, opaque bytes and Swift source leave as attachments; JSON and images are left alone", async () => {
    for (const type of [
      "application/octet-stream",
      "application/zip",
      "application/gzip",
      "application/x-tar",
      "text/x-swift",
    ]) {
      const res = await go(echo("x", { "content-type": type }));
      expect(res.status, type).toBe(200);
      expect(res.headers.get("content-disposition"), type).toBe("attachment");
    }
    const named = await go(
      echo("x", {
        "content-type": "text/x-swift",
        "content-disposition": 'inline; filename="Package.swift"',
      }),
    );
    expect(named.headers.get("content-disposition")).toBe(
      'attachment; filename="Package.swift"',
    );
    for (const type of ["application/json", "image/png"]) {
      const res = await go(echo("x", { "content-type": type }));
      expect(res.status, type).toBe(200);
      expect(res.headers.get("content-disposition"), type).toBeNull();
    }
  });

  it("XML goes out only as an octet-stream attachment", async () => {
    const pom = "<project/>";
    const res = await go(
      echo(pom, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="sdk-1.0.0.pom"',
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="sdk-1.0.0.pom"',
    );
    expect(await res.text()).toBe(pom);
  });

  it("error answers may be the platform's JSON, problem+json or OCI's error JSON", async () => {
    const plain = await go(echo('{"error":"unauthorized"}', jsonType, 401));
    expect(plain.status).toBe(401);
    const problem = await go(
      echo("{}", { "content-type": "application/problem+json" }, 404),
    );
    expect(problem.status).toBe(404);
    expect(problem.headers.get("content-type")).toBe(
      "application/problem+json",
    );
  });

  it("a throw in a route or while loading the owner answers a hardened JSON 500", async () => {
    const boom = echo(null, jsonType, 200, {
      handle: async () => {
        throw new Error("secret-looking message");
      },
    });
    const res = await go(boom);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expectHardened(res, "throw");
    const broken = {
      ...db,
      first: async () => {
        throw new Error("D1 is down");
      },
    } as unknown as Db;
    const down = await dispatchRegistryHost(
      new Request(`${PKG}/npm/${SLUG}/fake/a`),
      env(PKG),
      broken,
      [echo("{}", jsonType)],
    );
    expect(down.status).toBe(500);
    expectHardened(down, "down");
  });

  it("a route is handed the owner WITHOUT its signing key", async () => {
    let handed: unknown = null;
    await go(
      echo("{}", jsonType, 200, {
        handle: async (_req, ctx) => {
          handed = ctx.product;
          return new Response("{}", { headers: jsonType });
        },
      }),
    );
    expect(handed).toMatchObject({ slug: SLUG });
    expect(handed).not.toHaveProperty("signingKeyPem");
  });

  describe("the PyPI HTML page", () => {
    const pypi = (
      headers: Record<string, string>,
      inert = true,
    ): RegistryRoute => ({
      name: "fake.pypi",
      service: "distribution",
      ecosystem: "pypi",
      ...(inert ? { inertDocument: true as const } : {}),
      match: (p) => {
        const m = /^\/pypi\/([^/]+)\/simple\/$/.exec(p);
        return m ? { owner: m[1]!, params: {} } : null;
      },
      handle: async () =>
        new Response('<!doctype html><a href="x">x</a>', { headers }),
    });
    const INERT =
      "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    const at = `/pypi/${SLUG}/simple/`;

    it("is admitted on a flagged route under an inert policy, which it keeps", async () => {
      const res = await go(
        pypi({
          "content-type": PYPI_HTML_TYPE,
          "content-security-policy": INERT,
        }),
        at,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(PYPI_HTML_TYPE);
      expectHardened(res, "pypi", INERT);
    });

    it("is refused without the flag, under a policy that allows script, or as text/html", async () => {
      for (const [route, label] of [
        [
          pypi(
            {
              "content-type": PYPI_HTML_TYPE,
              "content-security-policy": INERT,
            },
            false,
          ),
          "unflagged",
        ],
        [
          pypi({
            "content-type": PYPI_HTML_TYPE,
            "content-security-policy": `${INERT}; script-src 'self'`,
          }),
          "script",
        ],
        [pypi({ "content-type": PYPI_HTML_TYPE }), "no policy"],
        [
          pypi({
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": INERT,
          }),
          "text/html",
        ],
        [
          pypi({
            "content-type": PYPI_HTML_TYPE,
            "content-security-policy": INERT,
            "content-disposition": "inline",
          }),
          "disposition",
        ],
      ] as const) {
        const res = await go(route, at);
        expect(res.status, label).toBe(404);
        expectHardened(res, label);
      }
    });
  });
});

describe("console session cookies cannot reach the registry host", () => {
  it("admin and portal cookies are __Host- prefixed (host-only, never sent to pkg.plrs.im)", () => {
    expect(ADMIN_COOKIE.startsWith("__Host-")).toBe(true);
    expect(PORTAL_COOKIE.startsWith("__Host-")).toBe(true);
  });

  it("no Set-Cookie anywhere in src/ carries a Domain attribute", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          const code = readFileSync(p, "utf8")
            .split("\n")
            .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
            .join("\n");
          if (/Domain=/i.test(code)) offenders.push(p);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
