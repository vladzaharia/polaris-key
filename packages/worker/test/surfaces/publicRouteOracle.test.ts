/**
 * The portal and the core public routes against the hand dispatch they replaced (P0-25b).
 *
 * P0-25b moved `handlePortal`'s if-chain and `dispatch.ts`'s core route switch onto tables, and
 * the CORS service-path list onto a flag on the service route rows. None of it may change an
 * answer. `fixtures/public-route-oracle.json` was recorded from the hand dispatch BEFORE the move
 * (`PKEY_RECORD_ORACLE=4`), and this test replays the same requests through `dispatchWith` and
 * compares status, the headers that matter and a digest of the body. Three groups:
 *
 *   - `portal`: the root portal's paths, hostile spellings included, under every method.
 *   - `core`: the core product routes (discovery, JWKS, trust, devices, report, register,
 *     attest, assets) and near misses, under every method, with and without a body.
 *   - `cors`: EVERY route the pipeline can reach (each service surface path, the permanent
 *     aliases, the core routes and the platform surfaces) as a browser page on a listed origin
 *     sees it: `GET`, `OPTIONS` (a listed origin, another origin, and the preflight headers).
 *     That is the CORS answer per route; a route that gained or lost a flag changes a row.
 *
 * Regenerating the fixture is a deliberate act and a reviewer reads the diff: a changed row is a
 * changed route.
 */

import { createHash } from "node:crypto";
import { format, resolveConfig } from "prettier";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { TEST_RSA_PKCS8 } from "../releaseFixtures.js";
import { dispatchWith } from "../../src/dispatch.js";
import { SERVICES } from "../../src/mount.js";
import { serializeServices } from "../../src/core/services.js";
import { serializeWebOrigins } from "../../src/core/cors.js";
import { setServices } from "../../src/core/products/store.js";
import { seedDeliveryAccess } from "../releaseSurface.js";
import { issuerMetadataResponse } from "../oidcIssuerFake.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { TEST_ROOT as here } from "../paths.js";

const FIXTURE = join(here, "fixtures", "public-route-oracle.json");
const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";
/** A stored avatar rendition (`/media/avatar/<64 hex>.png`): the PNG signature is all it sniffs. */
const AVATAR = "ab".repeat(32);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
]);
const ORIGIN = "https://play.djdl.example";
const OTHER_ORIGIN = "https://elsewhere.example";
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const PARAMS: Record<string, string> = {
  product: SLUG,
  sha256: "a".repeat(64),
  mintId: "recipe-1",
  channel: "stable",
  version: "1.2.3",
  asset: "djdl-arm64",
};
function instantiate(template: string): string {
  return template.replace(
    /\{(\w+)\}/g,
    (_m, name: string) => PARAMS[name] ?? "a1",
  );
}

/** The root portal, spelled every way a hand `if` could read differently from a table. */
const PORTAL: string[] = [
  "/",
  "/index.html",
  "/activate",
  "/activate?key=pkey_abc",
  "/assets/portal.js",
  "/assets/",
  "/assets/x/y.js",
  "/login",
  "/login/",
  "/login?next=%2F",
  "/login/sso",
  "/login/sso/",
  "/login/sso/conn1",
  "/login/sso/conn1/",
  "/login/sso/conn1/extra",
  "/login/sso//x",
  "/login/google",
  "/login/google/",
  "/login/google/callback",
  "/login/google/notifications",
  "/login/apple",
  "/login/apple/callback",
  "/login/apple/notifications",
  "/login/steam",
  "/login/steam/callback",
  "/login/nope",
  "/login/nope/callback",
  "/login/google/callback/extra",
  "/login/%2e%2e/x",
  "/login/google%2Fcallback",
  "/callback",
  "/callback/",
  "/callback?code=x&state=y",
  "/callback/extra",
  "/logout",
  "/logout/",
  "/logout/extra",
  "/magic/verify",
  "/magic/verify?token=abc",
  "/magic/verify/extra",
  "/magic",
  "/api",
  "/api/",
  "/api/capabilities",
  "/api/me",
  "/api/library",
  "/api/signin/start",
  "/api/signin/nope",
  "/api/nope",
  "/api/nope/deep/path",
  "/api//me",
  "/api/%2e%2e/me",
  "/api/me/",
  "/media",
  "/media/",
  "/media/djdl",
  "/media/djdl/",
  "/media/djdl/icon",
  "/media/djdl/icon/",
  "/media/djdl/icon/extra",
  "/media/avatar",
  "/media/avatar/",
  "/media/avatar/a1",
  `/media/avatar/${AVATAR}`,
  `/media/avatar/${AVATAR}.png`,
  `/media/avatar/${AVATAR}-96.png`,
  `/media/avatar/${AVATAR}.webp`,
  "/media/avatar/a1/extra",
  "/media/avatar/%zz",
  "/media/%zz/icon",
  "/media/djdl/%2e%2e",
  "/media//icon",
  "/download",
  "/download/",
  "/download/tok",
  "/download/tok/",
  "/download/tok/extra",
  "/download/to%20k",
  "/download/%2e%2e",
  "/download/%zz",
  "/signin",
  "/signin?request=rq_x",
  "/signin?bind=1",
  "/device",
  "/tv",
  "/device/approve",
  "/help",
  "/help/x",
  "/.well-known/webauthn",
  "/webhooks/github",
  "/webhooks/deploy",
  "/nope",
  "/nope/deep",
  "/docs",
];

/** The core product routes and their neighbours. */
const CORE: string[] = [
  ".well-known/polaris.json",
  ".well-known/polaris.json/",
  ".well-known/polaris.json?x=1",
  ".well-known/jwks.json",
  ".well-known/polaris-trust.jws",
  ".well-known/nope",
  ".well-known/polaris.json/extra",
  "devices",
  "devices/",
  "devices?limit=1",
  "devices/report",
  "devices/report/",
  "devices/register",
  "devices/register/",
  "devices/attest",
  "devices/attest/",
  "devices/attest/challenge",
  "devices/attest/challenge/",
  "devices/attest/challenge/extra",
  "devices/keyring",
  "devices/keyring/",
  "devices/keyring/wraps/dev1",
  "devices/keyring/wraps/dev1/",
  "devices/keyring/wraps",
  "devices/keyring/wraps/%zz",
  "devices/keyring/recovery",
  "devices/dev1",
  "devices/dev1/",
  "devices/dev1/extra",
  "devices/%2e%2e",
  "devices/dev%2F1",
  "devices/%zz",
  "devices//",
  "assets",
  "assets/",
  "assets/extra",
  "assets?slot=icon",
].map((n) => `/${SLUG}/${n}`);

/** The permanent aliases and the bare product path. */
const ALIASES: string[] = [
  `/${SLUG}`,
  `/${SLUG}/appcast.xml`,
  `/${SLUG}/stable/appcast.xml`,
  `/${SLUG}/version`,
  `/${SLUG}/install.sh`,
  `/${SLUG}/release/install.sh`,
  `/${SLUG}/release/dl/1.2.3/djdl-arm64`,
  `/${SLUG}/release/builds/stable/b1`,
  `/${SLUG}/release/files/r1/x.zip`,
  `/${SLUG}/release/blobs/sha256/${"a".repeat(64)}`,
  `/${SLUG}/changelog`,
  `/${SLUG}/nope`,
  `/${SLUG}/nope/deep`,
  `/nope-product`,
  `/nope-product/.well-known/polaris.json`,
  `/nope-product/license/activate`,
];

const CARRIED = [
  "allow",
  "content-type",
  "cache-control",
  "www-authenticate",
  "vary",
  "location",
  "retry-after",
  "content-length",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
  "access-control-expose-headers",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "strict-transport-security",
  "access-control-allow-credentials",
];

/** Opaque tokens and times differ per run; their shape does not. */
function normalise(text: string): string {
  return text
    .replace(/\b(state|nonce)=[^&\s"]+/g, "$1=<tok>")
    .replace(/[A-Za-z0-9_-]{24,}/g, "<tok>")
    .replace(/\b1[67]\d{8}\b/g, "<ts>");
}

interface Row {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
}

async function observe(res: Response): Promise<Row> {
  const headers: Record<string, string> = {};
  for (const name of CARRIED) {
    const v = res.headers.get(name);
    if (v !== null) headers[name] = normalise(v);
  }
  const setCookies =
    (
      res.headers as unknown as { getSetCookie?(): string[] }
    ).getSetCookie?.() ?? [];
  // Name, then the attributes (Path, Max-Age, HttpOnly, Secure, SameSite, Domain); the value is
  // an opaque token and not compared.
  const cookies = setCookies
    .map((c) => {
      const [pair = "", ...attrs] = c.split(";");
      return [
        pair.split("=")[0],
        ...attrs.map((a) => normalise(a.trim())),
      ].join("; ");
    })
    .sort();
  const text = normalise(await res.text());
  return {
    status: res.status,
    headers,
    cookies,
    body: `${text.length}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
  };
}

async function seed(db: Db): Promise<void> {
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
        sync: { enabled: true },
        commerce: { enabled: true },
        connect: { enabled: false },
      },
    }),
    "manifest",
    NOW,
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
    JSON.stringify({ requireSparkleSignature: false }),
  );
  await seedDeliveryAccess(db, SLUG, "public");
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    serializeWebOrigins([ORIGIN]),
    SLUG,
  );
}

/**
 * A deployment with everything the portal rows answer from: a platform IdP (so `/login` is a 302
 * to it, not the sign-in-off 404), the session secrets, a stored avatar rendition and, with
 * `customer`, the customer host. Without these every `/login*` path and every `/media/*` path
 * answered one identical 404, and a row that took the wrong handler went unseen.
 */
async function envFor(customer = false): Promise<Env> {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  Object.assign(env, {
    PLATFORM_OIDC_ISSUER: "https://id.platform.example",
    PLATFORM_OIDC_CLIENT_ID: "platform-client",
    PLATFORM_OIDC_CLIENT_SECRET: "platform-secret",
  });
  if (customer) {
    env.CUSTOMER_ORIGIN = CUSTOMER;
    env.CONSOLE_ORIGIN = BASE;
  }
  await env.BLOBS!.put(`avatars/${AVATAR}/256.png`, PNG);
  await env.BLOBS!.put(`avatars/${AVATAR}/96.png`, PNG);
  return env;
}

describe("the portal and core public routes replay the hand dispatch", () => {
  let db: Db;
  beforeEach(async () => {
    db = makeTestDb();
    await seed(db);
    vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) =>
        (await issuerMetadataResponse(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
          null,
        )) ?? new Response("upstream", { status: 503 }),
    );
    vi.stubGlobal("caches", {
      default: {
        async match() {
          return undefined;
        },
        async put() {},
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  interface Job {
    group: string;
    path: string;
    method: string;
    body: boolean;
    origin?: string;
    preflight?: boolean;
    /** The customer host rather than the console host. */
    customer?: boolean;
  }

  async function replay(jobs: Job[]): Promise<Record<string, Row>> {
    const observed: Record<string, Row> = {};
    for (const job of jobs) {
      const init: RequestInit = { method: job.method };
      const headers: Record<string, string> = {};
      if (job.body) {
        init.body = "{}";
        headers["content-type"] = "application/json";
      }
      if (job.origin) {
        headers.origin = job.origin;
        if (job.preflight) {
          headers["access-control-request-method"] = "GET";
          headers["access-control-request-headers"] = "authorization";
        }
      }
      init.headers = headers;
      let row: Row;
      try {
        const res = await dispatchWith(
          new Request(
            `${job.customer ? CUSTOMER : BASE}${job.path}`,
            init,
          ) as unknown as Request,
          await envFor(job.customer),
          db,
          NOW,
        );
        row = await observe(res);
      } catch (e) {
        row = {
          status: -1,
          headers: {},
          cookies: [],
          body: normalise(e instanceof Error ? e.message : String(e)),
        };
      }
      observed[
        `${job.group}${job.customer ? "@customer" : ""} ${job.method}${job.body ? "+body" : ""}${job.origin ? `+${job.origin === ORIGIN ? "origin" : "other"}` : ""}${job.preflight ? "+preflight" : ""} ${job.path}`
      ] = row;
    }
    return observed;
  }

  function plain(group: string, list: string[], customer = false): Job[] {
    const jobs: Job[] = [];
    for (const path of list)
      for (const method of METHODS)
        for (const body of method === "GET" || method === "HEAD"
          ? [false]
          : [false, true])
          jobs.push({ group, path, method, body, customer });
    return jobs;
  }

  function corsJobs(list: string[]): Job[] {
    const jobs: Job[] = [];
    for (const path of list) {
      jobs.push({ group: "cors", path, method: "GET", body: false });
      for (const origin of [ORIGIN, OTHER_ORIGIN]) {
        jobs.push({ group: "cors", path, method: "GET", body: false, origin });
        jobs.push({
          group: "cors",
          path,
          method: "OPTIONS",
          body: false,
          origin,
          preflight: true,
        });
      }
      jobs.push({ group: "cors", path, method: "OPTIONS", body: false });
      jobs.push({
        group: "cors",
        path,
        method: "POST",
        body: true,
        origin: ORIGIN,
      });
    }
    return jobs;
  }

  function surfacePaths(): string[] {
    const out = new Set<string>();
    for (const d of SERVICES.values())
      for (const r of d.surface) out.add(instantiate(r.path));
    return [...out].sort();
  }

  it("answers every request as the recorded dispatch did", async () => {
    const everyRoute = [...surfacePaths(), ...CORE, ...ALIASES, ...PORTAL];
    const observed = {
      ...(await replay(plain("portal", PORTAL))),
      ...(await replay(plain("portal", PORTAL, true))),
      ...(await replay(plain("core", [...CORE, ...ALIASES]))),
      ...(await replay(corsJobs(everyRoute))),
    };
    if (process.env.PKEY_RECORD_ORACLE === "4") {
      const config = (await resolveConfig(FIXTURE)) ?? {};
      writeFileSync(
        FIXTURE,
        await format(JSON.stringify(observed, null, 1), {
          ...config,
          filepath: FIXTURE,
        }),
      );
      return;
    }
    const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
      string,
      Row
    >;
    expect(Object.keys(observed)).toEqual(Object.keys(recorded));
    const changed = Object.keys(recorded).filter(
      (k) => JSON.stringify(observed[k]) !== JSON.stringify(recorded[k]),
    );
    expect(changed).toEqual([]);
  }, 300_000);
});
