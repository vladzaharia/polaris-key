/**
 * SEC-WEB-1 — the docs gate must hold on EVERY route that can reach the assembled asset tree.
 *
 * The bypass: `/manage/<anything with a dot>` was proxied to ASSETS by `serveAdminAsset` with no
 * session check, so `/manage/docs/admin/kek/index.html` (and the search index, OpenAPI, sitemap)
 * returned gated docs bytes anonymously. The fix is an allowlist: the unauthenticated SPA proxies
 * (`/manage/*`, the portal) serve only `/assets/<file>`, the content-hashed bundle directory;
 * everything else is the SPA shell. Docs are served only by `handleDocs`, after the session check.
 *
 * The fake ASSETS binding below enumerates the REAL assembled tree when it has been built
 * (`pnpm --filter @polaris-key/worker assemble`) and a fixture tree otherwise; each file answers
 * `ASSET:<path>`, so a leak is detectable from the body alone.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/platform/env.js";
import { dispatchWith } from "../src/dispatch.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { makeTestDb } from "./helpers.js";
import { ADMIN_COOKIE, issueSession } from "../src/core/console/session.js";

const DB = makeTestDb();
const here = dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = join(here, "..", "assets");

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory())
      out.push(...walk(full, `${prefix}/${name}`));
    else out.push(`${prefix}/${name}`);
  }
  return out;
}

const FIXTURE_TREE = [
  "/index.html",
  "/manage.html",
  "/assets/manage-abc.js",
  "/assets/branding/key/favicon.svg",
  "/docs/index.html",
  "/docs/404.html",
  "/docs/admin/kek/index.html",
  "/docs/operations/index.html",
  "/docs/_astro/app.abc.css",
  "/docs/pagefind/pagefind.js",
  "/docs/pagefind/pagefind-entry.json",
  "/docs/pagefind/index/en_abc.pf_index",
  "/docs/openapi/openapi.json",
  "/docs/schemas/v1/product.schema.json",
  "/docs/sitemap-index.xml",
  "/docs/sitemap-0.xml",
  "/docs/docs-slugs.json",
];
const REAL = existsSync(ASSET_ROOT);
const TREE = REAL ? walk(ASSET_ROOT) : FIXTURE_TREE;
const DOCS_FILES = TREE.filter((p) => p.startsWith("/docs/"));
const treeSet = new Set(TREE);

function assets(): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const u = new URL(
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url,
      );
      // Mirror html_handling = "none": exact files only.
      if (!treeSet.has(u.pathname)) return new Response("nf", { status: 404 });
      return new Response(`ASSET:${u.pathname}`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  } as unknown as Fetcher;
}

function env(): Env {
  const e = makeEnv(new KvMock(), []);
  e.ADMIN_SESSION_SECRET = "docs-bypass-secret";
  e.PLATFORM_ADMIN_GROUP = "admins";
  e.PLATFORM_OIDC_ISSUER = "https://id.example.com";
  e.PLATFORM_OIDC_CLIENT_ID = "polaris-admin";
  e.ASSETS = assets();
  return e;
}

async function send(
  e: Env,
  path: string,
  init: { method?: string; cookie?: string; range?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.range) headers.range = init.range;
  const res = await dispatchWith(
    new Request(`https://key.plrs.im${path}`, {
      method: init.method ?? "GET",
      headers,
    }),
    e,
    DB,
    NOW,
  );
  return { status: res.status, body: await res.text() };
}

const leaks = (r: { body: string }) => r.body.startsWith("ASSET:/docs/");

/** Every way to name a docs file through a route other than `/docs`. */
function bypassVariants(p: string): string[] {
  const dir = p.slice(0, p.lastIndexOf("/"));
  return [
    `/manage${p}`,
    `/manage/${p.slice(1)}`,
    `/manage//${p.slice(1)}`,
    `/manage${p}/`,
    `/manage${dir}/`,
    `/manage${p.replace("/docs/", "/DOCS/")}`,
    `/manage${p.replace(/\//g, "%2f")}`,
    `/manage${p.replace("/docs", "/%64ocs")}`,
    `/manage/x/..${p}`,
    `/manage/%2e%2e${p}`,
    `/manage/assets/..${p}`,
    `/manage/assets/%2e%2e${p}`,
    `/assets/..${p}`,
    `/assets/%2e%2e${p}`,
    `/assets/${p.slice(1)}`,
    `/assets${p}`,
    `/index.html${p}`,
    `/manage${p};x=1`,
    `/manage${p}?a=1#f`,
  ];
}

describe("SEC-WEB-1: docs are unreachable without the admin session", () => {
  it("tests the real assembled tree when it is built (CI assembles before testing)", () => {
    expect(TREE.length).toBeGreaterThan(5);
    expect(DOCS_FILES.length).toBeGreaterThan(5);
  });

  it("walk-all: no docs file leaks anonymously through any /manage, /assets or encoded variant", async () => {
    const e = env();
    const bad: string[] = [];
    for (const p of DOCS_FILES) {
      for (const v of bypassVariants(p)) {
        for (const method of ["GET", "HEAD"]) {
          const r = await send(e, v, { method });
          if (leaks(r)) bad.push(`${method} ${v}`);
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
  }, 120_000);

  it("the audited paths are the SPA shell or a gate redirect, never docs bytes", async () => {
    const e = env();
    for (const p of [
      "/manage/docs/admin/kek/index.html",
      "/manage/docs/pagefind/pagefind-entry.json",
      "/manage/docs/openapi/openapi.json",
      "/manage/docs/sitemap-index.xml",
      "/manage/docs/index.html",
      "/manage/docs/404.html",
    ]) {
      const r = await send(e, p);
      expect(leaks(r), p).toBe(false);
      expect(r.body.startsWith("ASSET:/docs"), p).toBe(false);
    }
  });

  it("direct /docs paths (every file, plus variants) redirect to sign-in anonymously", async () => {
    const e = env();
    for (const p of DOCS_FILES) {
      for (const v of [
        p,
        p.replace("/docs/", "/DOCS/"),
        `/docs//${p.slice(6)}`,
        `${p}/`,
        `/docs/x/..${p.slice(5)}`,
        `/docs/%2e%2e${p}`,
        p.replace("/docs/", "/docs/%2e/"),
      ]) {
        for (const init of [
          { method: "GET" },
          { method: "HEAD" },
          { method: "GET", range: "bytes=0-5" },
        ]) {
          const r = await send(e, v, init);
          expect(leaks(r), `${init.method} ${v}`).toBe(false);
        }
      }
    }
    for (const p of [
      "/docs",
      "/docs/",
      "/docs/admin/kek/",
      "/docs/admin/kek",
    ]) {
      const res = await dispatchWith(
        new Request(`https://key.plrs.im${p}`),
        e,
        DB,
        NOW,
      );
      expect(res.status, p).toBe(302);
      expect(res.headers.get("location")).toContain("/manage/login");
    }
  }, 120_000);

  it("legitimate SPA bundle files stay public", async () => {
    const e = env();
    const bundle = TREE.find(
      (p) => p.startsWith("/assets/") && p.endsWith(".js"),
    );
    expect(bundle).toBeTruthy();
    expect((await send(e, bundle!)).body).toBe(`ASSET:${bundle}`);
    expect((await send(e, `/manage${bundle}`)).body).toBe(`ASSET:${bundle}`);
  });

  it("with a platform-admin session the docs ARE served at /docs (and only there)", async () => {
    const e = env();
    const { token } = await issueSession(
      e,
      { sub: "op", name: "Op", email: "op@example.com", groups: ["admins"] },
      NOW,
    );
    const cookie = `${ADMIN_COOKIE}=${token}`;
    const sample = DOCS_FILES.filter((p) => !p.endsWith("/404.html")).slice(
      0,
      25,
    );
    for (const p of sample) {
      const r = await send(e, p, { cookie });
      expect(r.status, p).toBe(200);
      expect(r.body, p).toBe(`ASSET:${p}`);
      const head = await send(e, p, { cookie, method: "HEAD" });
      expect(head.status, p).toBe(200);
      const rng = await send(e, p, { cookie, range: "bytes=0-5" });
      expect(rng.status, p).toBe(200);
    }
    expect((await send(e, "/docs/", { cookie })).body).toBe(
      "ASSET:/docs/index.html",
    );
    // Even with a session the /manage route is not a docs door.
    for (const p of sample) {
      expect(leaks(await send(e, `/manage${p}`, { cookie })), p).toBe(false);
    }
  }, 120_000);
});
