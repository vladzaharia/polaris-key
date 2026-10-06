/**
 * The per-product CORS allowlist (P0-05), driven through the real `dispatch` pipeline.
 *
 * Every assertion here is about the wire: what a browser page on a listed origin, an unlisted
 * origin, or no origin at all gets back. The covered-path TABLE is pinned against the OpenAPI
 * spec and the router in `routeCoverage.test.ts`; this file proves the headers themselves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { dispatch } from "../src/dispatch.js";
import { secureResponse } from "../src/securityHeaders.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_EXPOSE_HEADERS,
  CORS_MAX_AGE,
  parseWebOrigins,
  serializeWebOrigins,
  withCors,
} from "../src/core/cors.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { seedDeliveryAccess } from "./releaseSurface.js";

const SLUG = "djdl";
const LISTED = "https://play.djdl.example";
const OTHER_LISTED = "http://localhost:8060";
const UNLISTED = "https://evil.example";
const BASE = "https://key.plrs.im";

/** Every Access-Control-* header on a response, lower-cased names. */
function acHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("access-control-"))
      out[key.toLowerCase()] = value;
  });
  return out;
}

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers,
  }) as unknown as Request;
}

/** Seed a product with every service on, a public release config and the given allowlist. */
async function seed(
  db: Db,
  origins: string[] = [LISTED, OTHER_LISTED],
): Promise<void> {
  await seedProduct(db, SLUG);
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
        identity: { enabled: true },
        sync: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    serializeWebOrigins(origins),
    SLUG,
  );
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker,
        artifact_policy_json, metadata_access, artifacts_access, operator_policy_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    SLUG,
    "acme",
    "djdl",
    42,
    "channel.yml",
    "main",
    "[]",
    "djdl",
    null,
    null,
    "pkey:summary",
    "{}",
    "public",
    "public",
    // The signature opt-out is operator policy, stored in `operator_policy_json` since P0-01.
    JSON.stringify({ requireSparkleSignature: false }),
  );
  // The `dist_access` row migration 0038 (or any link/resync) writes for this configuration: no
  // row reads fail-closed as `entitled` (P2b-04).
  await seedDeliveryAccess(db, SLUG, "public");
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

const RELEASE = {
  tag_name: "v1.2.3",
  name: "1.2.3",
  body: null,
  published_at: "2026-01-02T03:04:05Z",
  html_url: "https://github.com/acme/djdl/releases/tag/v1.2.3",
  prerelease: false,
  draft: false,
  assets: [
    {
      id: 777,
      name: "djdl-arm64",
      size: 1024,
      content_type: "application/octet-stream",
      browser_download_url: "https://example/djdl-arm64",
    },
    {
      id: 100,
      name: "djdl-arm64.dmg",
      size: 4096,
      content_type: "application/octet-stream",
      browser_download_url: "https://example/djdl-arm64.dmg",
    },
  ],
};

/** A GitHub stand-in on the global `fetch` the release service uses when dispatched. */
function stubGithub(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_installation_token" }));
    }
    if (url.includes("/releases/tags/") || url.includes("/releases?per_page")) {
      const body = url.includes("/releases/tags/") ? RELEASE : [RELEASE];
      return new Response(JSON.stringify(body));
    }
    if (url.includes("/releases/assets/777")) {
      const range = new Headers(init?.headers).get("Range");
      if (range === "bytes=0-3") {
        return new Response("BINA", {
          status: 206,
          headers: {
            "Content-Range": "bytes 0-3/6",
            "Content-Length": "4",
            "Accept-Ranges": "bytes",
            ETag: '"asset-777"',
            // Upstream CORS must never leak through: the dispatcher decides these alone.
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      return new Response("BINARY", {
        headers: { ETag: '"asset-777"', "Accept-Ranges": "bytes" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  return { calls };
}

/** A Map-backed `caches.default`, so the release gateway's edge cache runs in the Node lane. */
function stubEdgeCache(): Map<string, Response> {
  const store = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      async match(key: Request): Promise<Response | undefined> {
        return store.get(key.url)?.clone();
      },
      async put(key: Request, res: Response): Promise<void> {
        store.set(key.url, res);
      },
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preflight (OPTIONS)", () => {
  let db: Db;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = envFor();
    await seed(db);
  });

  it("answers a listed origin with the exact allow set", async () => {
    const res = await dispatch(
      request("OPTIONS", `/${SLUG}/license/document`, {
        Origin: LISTED,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, x-pkey-version",
      }),
      env,
      db,
    );
    expect(res.status).toBe(204);
    expect(acHeaders(res)).toEqual({
      "access-control-allow-origin": LISTED,
      "access-control-allow-methods": "GET, POST, PATCH, DELETE",
      "access-control-allow-headers":
        "Authorization, Content-Type, Range, If-None-Match, If-Range, X-PKey-Device, " +
        "X-PKey-Version, X-PKey-Channel, X-PKey-SDK, X-PKey-SDK-Version, X-PKey-Platform, " +
        "X-PKey-Arch",
      "access-control-max-age": "600",
    });
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    // The constants are what the worker sends; pin them to the brief's spelling once.
    expect(CORS_ALLOW_METHODS).toBe("GET, POST, PATCH, DELETE");
    expect(CORS_MAX_AGE).toBe("600");
    expect(CORS_ALLOW_HEADERS.split(", ")).toContain("Authorization");
  });

  it("answers an unlisted origin with a bare 204", async () => {
    const res = await dispatch(
      request("OPTIONS", `/${SLUG}/license/document`, {
        Origin: UNLISTED,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, x-pkey-version",
      }),
      env,
      db,
    );
    expect(res.status).toBe(204);
    expect(acHeaders(res)).toEqual({});
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("does not depend on whether the service behind the path is enabled", async () => {
    await setServices(
      db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
          sync: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const enabled = await dispatch(
      request("OPTIONS", `/${SLUG}/license/document`, { Origin: LISTED }),
      env,
      db,
    );
    const disabled = await dispatch(
      request("OPTIONS", `/${SLUG}/update/appcast.xml`, { Origin: LISTED }),
      env,
      db,
    );
    expect(disabled.status).toBe(enabled.status);
    expect(acHeaders(disabled)).toEqual(acHeaders(enabled));
  });

  it("covers core routes and the permanent aliases", async () => {
    for (const path of [
      `/${SLUG}/.well-known/polaris.json`,
      `/${SLUG}/.well-known/jwks.json`,
      `/${SLUG}/.well-known/polaris-trust.jws`,
      `/${SLUG}/devices/register`,
      `/${SLUG}/appcast.xml`,
      `/${SLUG}/install.sh`,
    ]) {
      const res = await dispatch(
        request("OPTIONS", path, { Origin: OTHER_LISTED }),
        env,
        db,
      );
      expect(res.status, path).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe(
        OTHER_LISTED,
      );
    }
  });

  it("matches the Origin byte-for-byte: no case folding, no trailing slash", async () => {
    for (const origin of [
      LISTED.toUpperCase(),
      `${LISTED}/`,
      `${LISTED}:443`,
      "null",
    ]) {
      const res = await dispatch(
        request("OPTIONS", `/${SLUG}/license/document`, { Origin: origin }),
        env,
        db,
      );
      expect(acHeaders(res), origin).toEqual({});
    }
  });

  it("an unknown product is a plain 404, not a preflight answer", async () => {
    const res = await dispatch(
      request("OPTIONS", "/nope/license/document", { Origin: LISTED }),
      env,
      db,
    );
    expect(res.status).toBe(404);
    expect(acHeaders(res)).toEqual({});
  });
});

describe("responses on covered routes", () => {
  let db: Db;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = envFor();
    await seed(db);
  });

  it("a release download carries allow-origin, expose and Vary — including a 206", async () => {
    stubGithub();
    const full = await dispatch(
      request("GET", `/${SLUG}/release/dl/1.2.3/djdl-arm64`, {
        Origin: LISTED,
      }),
      env,
      db,
    );
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("BINARY");
    expect(full.headers.get("Access-Control-Allow-Origin")).toBe(LISTED);
    expect(full.headers.get("Access-Control-Expose-Headers")).toBe(
      "ETag, Content-Range, Accept-Ranges, Content-Length, Repr-Digest",
    );
    expect(full.headers.get("Vary")).toContain("Origin");

    const partial = await dispatch(
      request("GET", `/${SLUG}/release/dl/1.2.3/djdl-arm64`, {
        Origin: LISTED,
        Range: "bytes=0-3",
      }),
      env,
      db,
    );
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("BINA");
    expect(partial.headers.get("Content-Range")).toBe("bytes 0-3/6");
    expect(partial.headers.get("ETag")).toBe('"asset-777"');
    expect(acHeaders(partial)).toEqual({
      "access-control-allow-origin": LISTED,
      "access-control-expose-headers": CORS_EXPOSE_HEADERS,
    });
    expect(partial.headers.get("Vary")).toContain("Origin");
    expect(partial.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("an unlisted or absent Origin gets Vary: Origin and nothing else", async () => {
    stubGithub();
    for (const headers of [{ Origin: UNLISTED }, {}] as Record<
      string,
      string
    >[]) {
      const res = await dispatch(
        request("GET", `/${SLUG}/release/dl/1.2.3/djdl-arm64`, headers),
        env,
        db,
      );
      expect(res.status).toBe(200);
      expect(acHeaders(res)).toEqual({});
      expect(res.headers.get("Vary")).toContain("Origin");
    }
  });

  it("a cached public appcast never replays one origin's allow header to another", async () => {
    const { calls } = stubGithub();
    const store = stubEdgeCache();

    const fromA = await dispatch(
      request("GET", `/${SLUG}/update/appcast.xml`, { Origin: LISTED }),
      env,
      db,
    );
    expect(fromA.status).toBe(200);
    expect(fromA.headers.get("Access-Control-Allow-Origin")).toBe(LISTED);
    // The object stored in the edge cache is origin-free.
    expect(store.size).toBe(1);
    for (const cached of store.values()) {
      expect(acHeaders(cached)).toEqual({});
    }
    const upstreamCalls = calls.length;

    const fromB = await dispatch(
      request("GET", `/${SLUG}/update/appcast.xml`, { Origin: OTHER_LISTED }),
      env,
      db,
    );
    expect(fromB.status).toBe(200);
    expect(calls.length, "second fetch must be a cache hit").toBe(
      upstreamCalls,
    );
    expect(fromB.headers.get("Access-Control-Allow-Origin")).toBe(OTHER_LISTED);

    const fromEvil = await dispatch(
      request("GET", `/${SLUG}/update/appcast.xml`, { Origin: UNLISTED }),
      env,
      db,
    );
    expect(fromEvil.status).toBe(200);
    expect(acHeaders(fromEvil)).toEqual({});
    expect(fromEvil.headers.get("Vary")).toContain("Origin");
  });

  it("a product with no web.origins behaves exactly as before: no CORS, no Vary", async () => {
    const plain = makeTestDb();
    await seed(plain, []);
    stubGithub();
    const res = await dispatch(
      request("GET", `/${SLUG}/release/dl/1.2.3/djdl-arm64`, {
        Origin: LISTED,
      }),
      env,
      plain,
    );
    expect(res.status).toBe(200);
    expect(acHeaders(res)).toEqual({});
    expect(res.headers.get("Vary")).toBeNull();

    const pre = await dispatch(
      request("OPTIONS", `/${SLUG}/license/document`, { Origin: LISTED }),
      env,
      plain,
    );
    expect(pre.status).toBe(204);
    expect(acHeaders(pre)).toEqual({});
  });

  it("discovery and JWKS answer the listed origin, and survive the secureResponse backstop", async () => {
    for (const path of [
      `/${SLUG}/.well-known/polaris.json`,
      `/${SLUG}/.well-known/jwks.json`,
    ]) {
      const res = secureResponse(
        await dispatch(request("GET", path, { Origin: LISTED }), env, db),
      );
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe(LISTED);
      expect(res.headers.get("Vary"), path).toContain("Origin");
    }
  });
});

describe("surfaces that never answer CORS", () => {
  let db: Db;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = envFor();
    await seed(db);
  });

  for (const path of [
    "/manage/api/me",
    "/api/capabilities",
    `/${SLUG}/identity/session`,
    `/${SLUG}/identity/session/license`,
    `/${SLUG}/identity/auth/start`,
    `/${SLUG}/config/mint/applemusic/auth`,
    "/docs/",
    "/webhooks/github",
  ]) {
    for (const method of ["GET", "OPTIONS"]) {
      it(`${method} ${path} carries no Access-Control-* even from a listed origin`, async () => {
        const res = await dispatch(
          request(method, path, {
            Origin: LISTED,
            "Access-Control-Request-Method": "GET",
          }),
          env,
          db,
        );
        expect(acHeaders(res)).toEqual({});
        expect(res.status).not.toBe(204);
      });
    }
  }
});

describe("stored-row parsing", () => {
  it("fails closed on anything that is not a list of exact origins", () => {
    expect(parseWebOrigins(null)).toEqual([]);
    expect(parseWebOrigins("")).toEqual([]);
    expect(parseWebOrigins("{")).toEqual([]);
    expect(parseWebOrigins('"https://a.example"')).toEqual([]);
    expect(
      parseWebOrigins(
        JSON.stringify([
          "*",
          "null",
          "https://a.example/",
          "https://A.example",
          "https://a.example",
          "https://a.example",
          42,
        ]),
      ),
    ).toEqual(["https://a.example"]);
  });

  it("serializes an empty list as NULL", () => {
    expect(serializeWebOrigins([])).toBeNull();
    expect(serializeWebOrigins(["https://a.example"])).toBe(
      '["https://a.example"]',
    );
  });

  it("withCors appends Origin to an existing Vary and drops handler-set CORS", () => {
    const res = withCors(
      { webOrigins: ["https://a.example"] },
      new Request("https://key.plrs.im/x", {
        headers: { Origin: "https://a.example" },
      }) as unknown as Request,
      new Response("ok", {
        headers: {
          Vary: "Accept-Encoding",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Origin": "*",
        },
      }),
    );
    expect(res.headers.get("Vary")).toBe("Accept-Encoding, Origin");
    expect(acHeaders(res)).toEqual({
      "access-control-allow-origin": "https://a.example",
      "access-control-expose-headers": CORS_EXPOSE_HEADERS,
    });
  });
});
