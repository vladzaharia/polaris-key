import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { BYTE_ROUTES } from "../src/mount.js";
import {
  bytesHostname,
  dispatchBytesHost,
  isBytesHost,
  type ByteRoute,
} from "../src/core/bytesHost.js";
import { BLOB_CSP } from "../src/core/blobs.js";
import { ADMIN_COOKIE } from "../src/admin/session.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_EXPOSE_HEADERS,
  serializeWebOrigins,
} from "../src/core/cors.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const BYTES = "https://dl.example.test";
const CONSOLE = "https://key.example.test";

function env(blobOrigin?: string): Env {
  const e = makeEnv(new KvMock(), []);
  if (blobOrigin !== undefined) e.BLOB_ORIGIN = blobOrigin;
  return e;
}

/** Paths that, on the console, reach the admin SPA, the docs gate, the portal, discovery, a
 *  service route, the webhook and the alias table. None of them may answer on the bytes host. */
const CONSOLE_PATHS = [
  "/",
  "/index.html",
  "/manage",
  "/manage/api/me",
  "/manage/login",
  "/docs",
  "/docs/start/concepts/",
  "/login",
  "/api/me",
  "/download/abc",
  "/djdl/.well-known/polaris.json",
  "/djdl/.well-known/jwks.json",
  "/djdl/release/dl/x",
  "/djdl/appcast.xml",
  "/webhooks/github",
  "/blobs/sha256/" + "a".repeat(64),
];

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

describe("bytes host: configuration", () => {
  it("resolves BLOB_ORIGIN to a lowercase hostname, and nothing for unset or junk", () => {
    expect(bytesHostname({ BLOB_ORIGIN: "https://DL.plrs.im" })).toBe(
      "dl.plrs.im",
    );
    expect(bytesHostname({ BLOB_ORIGIN: "https://dl.plrs.im/" })).toBe(
      "dl.plrs.im",
    );
    // The fully-qualified form (trailing dot) is the same DNS name.
    expect(bytesHostname({ BLOB_ORIGIN: "https://dl.plrs.im./" })).toBe(
      "dl.plrs.im",
    );
    expect(
      isBytesHost(new URL("https://dl.plrs.im./manage"), {
        BLOB_ORIGIN: "https://dl.plrs.im",
      }),
    ).toBe(true);
    expect(
      isBytesHost(new URL("https://DL.plrs.im../manage"), {
        BLOB_ORIGIN: "https://dl.plrs.im",
      }),
    ).toBe(true);
    expect(
      isBytesHost(new URL("https://key.plrs.im./manage"), {
        BLOB_ORIGIN: "https://dl.plrs.im",
      }),
    ).toBe(false);
    expect(bytesHostname({})).toBeNull();
    expect(bytesHostname({ BLOB_ORIGIN: "" })).toBeNull();
    expect(bytesHostname({ BLOB_ORIGIN: "not a url" })).toBeNull();
    expect(bytesHostname({ BLOB_ORIGIN: "ftp://dl.plrs.im" })).toBeNull();
    expect(isBytesHost(new URL("https://dl.plrs.im/x"), {})).toBe(false);
  });

  it("the committed wrangler.toml points each environment's BLOB_ORIGIN at its own dl host", () => {
    const toml = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    for (const [envName, host] of [
      ["prod", "dl.plrs.im"],
      ["staging", "dl-staging.plrs.im"],
      ["dev", "dl-dev.plrs.im"],
    ] as const) {
      const block = toml
        .split(`[env.${envName}]`)[1]!
        .split(/\n\[env\.(?!\w+\.)/)[0]!;
      expect(block, envName).toContain(`BLOB_ORIGIN = "https://${host}"`);
      expect(block, envName).toMatch(
        new RegExp(
          `pattern = "${host.replace(/\./g, "\\.")}"\\s*\\ncustom_domain = true`,
        ),
      );
      expect(block, envName).toContain(
        `bucket_name = "polaris-key-blobs-${envName}"`,
      );
    }
  });

  it("P2-05 registers exactly Release's three byte routes, each owned by the release service", () => {
    expect(BYTE_ROUTES.map((r) => [r.name, r.service])).toEqual([
      ["release.build", "release"],
      ["release.file", "release"],
      ["release.blob", "release"],
    ]);
    const hex = "a".repeat(64);
    expect(BYTE_ROUTES[0]!.match("/djdl/release/builds/stable/macos")).toEqual({
      product: "djdl",
      params: { kind: "build", selector: "stable", buildId: "macos" },
    });
    expect(BYTE_ROUTES[1]!.match("/djdl/release/files/v1.2.3/a.zip")).toEqual({
      product: "djdl",
      params: { kind: "file", releaseId: "v1.2.3", name: "a.zip" },
    });
    expect(BYTE_ROUTES[2]!.match(`/djdl/release/blobs/sha256/${hex}`)).toEqual({
      product: "djdl",
      params: { kind: "blob", sha256: hex },
    });
    // Nothing else on the host: not the legacy download, not a short or bad hash.
    for (const path of [
      "/djdl/release/dl/latest/djdl-arm64",
      `/djdl/release/blobs/sha256/${"A".repeat(64)}`,
      "/djdl/release/blobs/sha256/abc",
      "/djdl/release/builds/stable",
      "/DJDL/release/builds/stable/macos",
      "/djdl/update/appcast.xml",
    ]) {
      expect(
        BYTE_ROUTES.map((r) => r.match(path)).filter(Boolean),
        path,
      ).toEqual([]);
    }
  });

  /**
   * The BLOB_ORIGIN guard (P2-05). Two misconfigurations break host isolation silently:
   * BLOB_ORIGIN equal to the console's hostname (every console path 404s), and a dl* route
   * deployed without BLOB_ORIGIN (the full console then answers on the same-site sibling). The
   * committed configuration may contain neither, in any environment.
   */
  it("no environment points BLOB_ORIGIN at a console host or deploys a dl route without it", () => {
    const toml = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    const blocks = toml.split(/\n(?=\[env\.[a-z]+\]\n)/).slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      const name = /^\[env\.([a-z]+)\]/.exec(block)![1]!;
      const patterns = [...block.matchAll(/pattern = "([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      const origin = /BLOB_ORIGIN = "([^"]+)"/.exec(block)?.[1];
      const dlHosts = patterns.filter((p) => /^dl[.-]/.test(p));
      const consoleHosts = patterns.filter((p) => !/^dl[.-]/.test(p));
      if (dlHosts.length > 0) {
        expect(origin, `${name}: a dl route needs BLOB_ORIGIN`).toBeDefined();
      }
      if (origin !== undefined) {
        const host = bytesHostname({ BLOB_ORIGIN: origin });
        expect(host, `${name}: BLOB_ORIGIN must parse`).not.toBeNull();
        expect(consoleHosts, `${name}: BLOB_ORIGIN is a console host`).not.toContain(
          host,
        );
        expect(dlHosts, `${name}: BLOB_ORIGIN names its own dl route`).toContain(
          host,
        );
      }
    }
  });
});

describe("bytes host: isolation", () => {
  it("every console, portal, docs and product path answers the plain not-found there", async () => {
    for (const path of CONSOLE_PATHS) {
      for (const method of ["GET", "POST"]) {
        const res = await worker.fetch(
          new Request(BYTES + path, { method }),
          env(BYTES),
        );
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.json(), path).toEqual({ error: "not_found" });
        expect(res.headers.get("set-cookie"), path).toBeNull();
        expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
        expect(res.headers.get("content-security-policy"), path).toBe(BLOB_CSP);
        expect(res.headers.get("content-security-policy"), path).toMatch(
          /\bsandbox\b/,
        );
        // The dispatcher's HSTS backstop still applies to the bytes host.
        expect(res.headers.get("strict-transport-security"), path).toContain(
          "max-age=",
        );
      }
    }
  });

  it("the fully-qualified host (trailing dot) is the bytes host too, not a way around it", async () => {
    // The edge routes `dl.plrs.im.` to this Worker with the dot kept in req.url; an exact
    // hostname comparison would hand it the whole console.
    for (const base of [BYTES + ".", "https://DL.example.test.:443"]) {
      for (const path of CONSOLE_PATHS) {
        const res = await worker.fetch(new Request(base + path), env(BYTES));
        expect(res.status, base + path).toBe(404);
        expect(await res.json(), base + path).toEqual({ error: "not_found" });
        expect(res.headers.get("content-security-policy"), base + path).toBe(
          BLOB_CSP,
        );
        expect(res.headers.get("x-content-type-options"), base + path).toBe(
          "nosniff",
        );
      }
    }
  });

  it("the host match is case-insensitive and ignores the port", async () => {
    const res = await worker.fetch(
      new Request("https://DL.EXAMPLE.TEST:443/manage"),
      env(BYTES),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
  });

  it("with BLOB_ORIGIN unset, routing is byte-identical to today — on any host", async () => {
    for (const path of CONSOLE_PATHS) {
      for (const host of [CONSOLE, BYTES]) {
        const without = await outcome(new Request(host + path), env());
        const junk = await outcome(new Request(host + path), env("not a url"));
        expect(junk, host + path).toEqual(without);
      }
    }
  });

  it("with BLOB_ORIGIN set, the console host is unchanged", async () => {
    for (const path of CONSOLE_PATHS) {
      const without = await outcome(new Request(CONSOLE + path), env());
      const withIt = await outcome(new Request(CONSOLE + path), env(BYTES));
      expect(withIt, path).toEqual(without);
    }
  });
});

/** Enablement written the way the manifest writes it: a full set, through the owning writer. */
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
        update: { enabled: false },
        identity: { enabled: false },
        ...services,
      },
    }),
    "manifest",
    NOW,
  );
}

describe("bytes host: dispatch", () => {
  const SLUG = "djdl";
  const LISTED = "https://play.djdl.example";
  const seen: Request[] = [];
  let db: Db;

  beforeEach(async () => {
    seen.length = 0;
    db = makeTestDb();
    await seedProduct(db, SLUG);
    // The fake route below belongs to Release, which is off by default.
    await setProductServices(db, SLUG, { release: { enabled: true } });
    await db.run(
      "UPDATE products SET web_origins_json = ? WHERE slug = ?",
      serializeWebOrigins([LISTED]),
      SLUG,
    );
  });

  /** A fake byte route under `/<product>/fake/...`, the shape P2-05's routes will take. */
  const echo = (
    body: BodyInit | null,
    headers: Record<string, string>,
    status = 200,
  ): ByteRoute => ({
    name: "fake",
    service: "release",
    match: (p) => {
      const m = /^\/([^/]+)\/fake\/(.*)$/.exec(p);
      return m ? { product: m[1]!, params: { rest: m[2]! } } : null;
    },
    handle: async (req, ctx) => {
      seen.push(req);
      expect(ctx.product.slug).toBe(SLUG);
      return new Response(body, { status, headers });
    },
  });
  const octet = { "content-type": "application/octet-stream" };

  it("only allowlisted routes answer; the Cookie header never reaches them", async () => {
    const route = echo("bytes", {
      ...octet,
      "set-cookie": "pkey_x=1; Path=/",
    });
    const res = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/a`, {
        headers: { cookie: `${ADMIN_COOKIE}=forged; ${PORTAL_COOKIE}=forged` },
      }),
      env(BYTES),
      db,
      [route],
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("cookie")).toBeNull();
    // ...and no cookie is set on the host, whatever a route tried.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);

    const other = await dispatchBytesHost(
      new Request(BYTES + "/nope"),
      env(BYTES),
      db,
      [route],
    );
    expect(other.status).toBe(404);
  });

  it("a route for an unknown product answers not-found without running", async () => {
    const res = await dispatchBytesHost(
      new Request(`${BYTES}/nobody/fake/a`),
      env(BYTES),
      db,
      [echo("bytes", octet)],
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(seen).toHaveLength(0);
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
  });

  it("a route whose service is disabled for the product never runs and answers not-found", async () => {
    const route = echo("bytes", octet);
    const ok = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/a`),
      env(BYTES),
      db,
      [route],
    );
    expect(ok.status).toBe(200);
    expect(seen).toHaveLength(1);
    seen.length = 0;

    // The product turns Release off: its bytes stop answering on the host at once, exactly
    // as its release paths on the console fall to the registry not-found.
    await setProductServices(db, SLUG, { release: { enabled: false } });
    const off = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/a`, { headers: { origin: LISTED } }),
      env(BYTES),
      db,
      [route],
    );
    expect(seen).toHaveLength(0);
    expect(off.status).toBe(404);
    // Indistinguishable from an unknown product or an unmatched path on this host.
    const offBody = await off.json();
    const absent = await dispatchBytesHost(
      new Request(`${BYTES}/nobody/fake/a`, { headers: { origin: LISTED } }),
      env(BYTES),
      db,
      [route],
    );
    expect(offBody).toEqual(await absent.json());
    expect(offBody).toEqual({ error: "not_found" });
    expect(off.headers.get("x-content-type-options")).toBe("nosniff");
    expect(off.headers.get("content-security-policy")).toBe(BLOB_CSP);
    expect(off.headers.get("access-control-allow-origin")).toBeNull();

    // A route of another service is judged by ITS service, not Release's.
    const licensed = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/a`),
      env(BYTES),
      db,
      [{ ...route, service: "license" }],
    );
    expect(licensed.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("a route that answers with an executable or renderable type is replaced by not-found", async () => {
    for (const type of [
      "text/html; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "application/javascript",
      "text/javascript",
      "application/xml",
      "text/plain",
      "application/json",
    ]) {
      const res = await dispatchBytesHost(
        new Request(`${BYTES}/${SLUG}/fake/x`, {
          headers: { origin: LISTED },
        }),
        env(BYTES),
        db,
        [echo("<script>alert(1)</script>", { "content-type": type })],
      );
      expect(res.status, type).toBe(404);
      expect(await res.json(), type).toEqual({ error: "not_found" });
      expect(res.headers.get("x-content-type-options"), type).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), type).toBe(BLOB_CSP);
    }
  });

  /** A body with no Content-Type at all (a string body would get `text/plain` implicitly). */
  const untypedBody = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("%PDF-1.7 <script>"));
        c.close();
      },
    });

  it("a success answer whose type is not on the inert allowlist is replaced by not-found", async () => {
    const cases: Array<[string, () => ByteRoute]> = [
      [
        "application/pdf inline",
        () =>
          echo("%PDF-1.7", {
            "content-type": "application/pdf",
            "content-disposition": "inline",
          }),
      ],
      [
        "application/pdf",
        () => echo("%PDF-1.7", { "content-type": "application/pdf" }),
      ],
      [
        "video/mp4 inline",
        () =>
          echo("v", {
            "content-type": "video/mp4",
            "content-disposition": "inline",
          }),
      ],
      ["image/png", () => echo("png", { "content-type": "image/png" })],
      [
        "image/png inline",
        () =>
          echo("png", {
            "content-type": "image/png",
            "content-disposition": "inline",
          }),
      ],
      ["no Content-Type (stream body)", () => echo(untypedBody(), {})],
      ["no Content-Type (206)", () => echo(untypedBody(), {}, 206)],
      [
        "empty Content-Type",
        () => echo(new Uint8Array([1, 2]), { "content-type": "" }),
      ],
      [
        "JSON below 400",
        () => echo("{}", { "content-type": "application/json" }, 201),
      ],
    ];
    for (const [label, route] of cases) {
      const res = await dispatchBytesHost(
        new Request(`${BYTES}/${SLUG}/fake/x`, { headers: { origin: LISTED } }),
        env(BYTES),
        db,
        [route()],
      );
      expect(res.status, label).toBe(404);
      expect(await res.json(), label).toEqual({ error: "not_found" });
      expect(res.headers.get("content-disposition"), label).toBeNull();
      expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), label).toBe(BLOB_CSP);
    }
  });

  it("an allowlisted answer leaves as attachment unless the route asked for inline", async () => {
    const run = async (headers: Record<string, string>): Promise<Response> =>
      dispatchBytesHost(
        new Request(`${BYTES}/${SLUG}/fake/x`),
        env(BYTES),
        db,
        [echo(new Uint8Array([1]), headers)],
      );
    const apk = "application/vnd.android.package-archive";
    const none = await run({ "content-type": apk });
    expect(none.status).toBe(200);
    expect(none.headers.get("content-type")).toBe(apk);
    expect(none.headers.get("content-disposition")).toBe("attachment");

    const odd = await run({
      "content-type": apk,
      "content-disposition": "form-data; name=x",
    });
    expect(odd.headers.get("content-disposition")).toBe("attachment");

    const att = await run({
      "content-type": apk,
      "content-disposition": 'attachment; filename="a.apk"',
    });
    expect(att.headers.get("content-disposition")).toBe(
      'attachment; filename="a.apk"',
    );

    const inline = await run({
      "content-type": "application/wasm",
      "content-disposition": 'inline; filename="a.wasm"',
    });
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-disposition")).toBe(
      'inline; filename="a.wasm"',
    );
    expect(inline.headers.get("content-security-policy")).toBe(BLOB_CSP);
  });

  it("body-less answers with no type (304, HEAD-style 200) pass untouched", async () => {
    const notModified = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`),
      env(BYTES),
      db,
      [echo(null, { etag: '"abc"' }, 304)],
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("content-disposition")).toBeNull();
    expect(notModified.headers.get("content-security-policy")).toBe(BLOB_CSP);

    const head = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`, { method: "HEAD" }),
      env(BYTES),
      db,
      [echo(null, octet)],
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-disposition")).toBe("attachment");
  });

  it("an error answer may be the platform's JSON or an allowlisted type, nothing else", async () => {
    for (const [type, status, allowed] of [
      ["application/json", 403, true],
      ["application/problem+json", 429, true],
      ["application/octet-stream", 416, true],
      ["application/pdf", 403, false],
      ["image/png", 404, false],
      ["text/html", 500, false],
    ] as const) {
      const res = await dispatchBytesHost(
        new Request(`${BYTES}/${SLUG}/fake/x`),
        env(BYTES),
        db,
        [echo(new Uint8Array([1]), { "content-type": type }, status)],
      );
      expect(res.status, type).toBe(allowed ? status : 404);
      expect(res.headers.get("content-security-policy"), type).toBe(BLOB_CSP);
    }
    const untyped = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`),
      env(BYTES),
      db,
      [echo(untypedBody(), {}, 400)],
    );
    expect(untyped.status).toBe(404);
  });

  it("a JSON error body from a route is allowed through (it is not a payload)", async () => {
    const res = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`),
      env(BYTES),
      db,
      [
        echo(
          '{"error":"forbidden"}',
          { "content-type": "application/json" },
          403,
        ),
      ],
    );
    expect(res.status).toBe(403);
  });

  it("CORS: the product's own web.origins decide, through the same core/cors.ts step", async () => {
    const route = echo("b", octet);
    const listed = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`, { headers: { origin: LISTED } }),
      env(BYTES),
      db,
      [route],
    );
    expect(listed.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(listed.headers.get("access-control-expose-headers")).toBe(
      CORS_EXPOSE_HEADERS,
    );
    expect(listed.headers.get("access-control-allow-credentials")).toBeNull();
    expect(listed.headers.get("vary")).toMatch(/origin/i);
    // The hardening survives CORS decoration.
    expect(listed.headers.get("content-security-policy")).toBe(BLOB_CSP);
    expect(listed.headers.get("x-content-type-options")).toBe("nosniff");

    const unlisted = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`, {
        headers: { origin: "https://evil.example" },
      }),
      env(BYTES),
      db,
      [route],
    );
    expect(unlisted.status).toBe(200);
    expect(unlisted.headers.get("access-control-allow-origin")).toBeNull();
    expect(unlisted.headers.get("vary")).toMatch(/origin/i);
  });

  it("CORS preflight is answered before the route runs", async () => {
    const route = echo("b", octet);
    const pre = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`, {
        method: "OPTIONS",
        headers: {
          origin: LISTED,
          "access-control-request-method": "GET",
          "access-control-request-headers": "range",
        },
      }),
      env(BYTES),
      db,
      [route],
    );
    expect(pre.status).toBe(204);
    expect(seen).toHaveLength(0);
    expect(pre.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(pre.headers.get("access-control-allow-methods")).toBe(
      CORS_ALLOW_METHODS,
    );
    expect(pre.headers.get("access-control-allow-headers")).toBe(
      CORS_ALLOW_HEADERS,
    );
    expect(pre.headers.get("content-security-policy")).toBe(BLOB_CSP);

    const evil = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
      env(BYTES),
      db,
      [route],
    );
    expect(evil.status).toBe(204);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a route cannot set its own Access-Control-* headers", async () => {
    const res = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/x`, {
        headers: { origin: "https://evil.example" },
      }),
      env(BYTES),
      db,
      [
        echo("b", {
          ...octet,
          "access-control-allow-origin": "*",
          "access-control-allow-credentials": "true",
        }),
      ],
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("...nor for a product with no web.origins, where core/cors.ts adds nothing", async () => {
    // `withCors` returns a product-without-origins response untouched, so this is the case
    // where a route's own headers would otherwise survive.
    await seedProduct(db, "quiet");
    await setProductServices(db, "quiet", { release: { enabled: true } });
    const res = await dispatchBytesHost(
      new Request(`${BYTES}/quiet/fake/x`, {
        headers: { origin: "https://evil.example" },
      }),
      env(BYTES),
      db,
      [
        {
          ...echo("b", {}),
          handle: async () =>
            new Response(new Uint8Array([1]), {
              headers: {
                ...octet,
                "access-control-allow-origin": "*",
                "access-control-allow-credentials": "true",
                "access-control-expose-headers": "*",
              },
            }),
        },
      ],
    );
    expect(res.status).toBe(200);
    for (const [k] of res.headers)
      expect(k.startsWith("access-control-"), k).toBe(false);
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
  });

  it("a throw inside a byte route answers a hardened JSON 500, not the platform's HTML error (P2-05)", async () => {
    const boom: ByteRoute = {
      ...echo(null, octet),
      handle: async () => {
        throw new Error("route exploded with a secret-looking message");
      },
    };
    const res = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/a`),
      env(BYTES),
      db,
      [boom],
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
    expect(res.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
  });

  it("a throw while loading the product answers the same hardened JSON 500 (P2-05)", async () => {
    const broken = {
      ...db,
      first: async () => {
        throw new Error("D1 is down");
      },
    } as unknown as Db;
    const res = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/a`),
      env(BYTES),
      broken,
      [echo("bytes", octet)],
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
    expect(seen).toHaveLength(0);
  });

  it("a byte route is handed the product WITHOUT its signing key (P2-05)", async () => {
    let handed: unknown = null;
    const peek: ByteRoute = {
      ...echo("bytes", octet),
      handle: async (_req, ctx) => {
        handed = ctx.product;
        return new Response("bytes", { headers: octet });
      },
    };
    const res = await dispatchBytesHost(
      new Request(`${BYTES}/${SLUG}/fake/a`),
      env(BYTES),
      db,
      [peek],
    );
    expect(res.status).toBe(200);
    expect(handed).toMatchObject({ slug: SLUG });
    expect(handed).not.toHaveProperty("signingKeyPem");
  });
});

describe("console session cookies cannot reach the bytes host", () => {
  // The bytes host is a *.plrs.im sibling (owner decision; THREAT-MODEL §3). What keeps the
  // console's sessions off it is that every session cookie is HOST-ONLY: no Domain attribute.
  // `__Host-` makes the browser enforce that for the admin and portal cookies.
  it("admin and portal cookies are __Host- prefixed", () => {
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
          // Code only: comment lines are dropped (session.ts quotes an attacker's
          // `Domain=plrs.im` cookie in prose to explain why `__Host-` is used).
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
