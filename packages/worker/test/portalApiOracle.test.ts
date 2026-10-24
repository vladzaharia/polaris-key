/**
 * The portal's `/api/*` against the hand dispatch it replaces (P0-25b-2).
 *
 * `handlePortalApi` walked its path by hand: pre-auth routes first, then the session proof, the
 * CSRF check (every change, and the two GETs that hand over personal data), the lifecycle routes
 * that skip the licence-link sweep, then the signed-in routes. P0-25b-2 moves that walk onto a
 * table whose rows carry their session and CSRF gates. None of it may change an answer.
 * `fixtures/portal-api-oracle.json` was recorded from the hand dispatch BEFORE the move
 * (`PKEY_RECORD_ORACLE=5`); this test replays the same requests and compares status, the headers
 * that matter, the cookies a response sets and a digest of the body.
 *
 * Every request runs in its OWN copy of one seeded deployment (a signed-in account that owns a
 * licence with a key and an activated device, a sign-in request bound to the browser's binder,
 * an IdP, the customer host), so a change one request makes (a deletion scheduled, a session
 * ended, a rate-limit bucket) cannot hide the next request's row. The matrix is every `/api` path
 * x every method x with and without a session x with, without and with a wrong CSRF header x
 * with and without a body, on the console host, and the customer host for the session modes.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { format, resolveConfig } from "prettier";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { seedDeliveryAccess } from "./releaseSurface.js";
import { issuerMetadataResponse } from "./oidcIssuerFake.js";
import { hashKey } from "../src/platform/crypto.js";
import { dispatchWith } from "../src/dispatch.js";
import { SqliteDb } from "../src/db/sqlite.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { createSignInRequest } from "../src/services/identity/passthrough/request.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "portal-api-oracle.json");
const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";
const LICENSE = "lic_djdl_1";
const DEVICE = "dev-1";
/** The browser's sign-in request binder (`__Host-pk_req`), a fixed 43-character value. */
const BINDER = "B".repeat(43);

/** Placeholders: `{lic}` the licence, `{dev}` its device, `{rq}` the sign-in request handle. */
const API: string[] = [
  "",
  "/",
  "//",
  "/capabilities",
  "/capabilities?product=djdl",
  "/capabilities/x",
  "/magic/start",
  "/magic/start/x",
  "/magic",
  "/signin",
  "/signin/",
  "/signin/start",
  "/signin/requests",
  "/signin/requests/",
  "/signin/requests/{rq}",
  "/signin/requests/{rq}/",
  "/signin/requests/rq_nope",
  "/signin/requests/{rq}/consent",
  "/signin/requests/rq_nope/consent",
  "/signin/requests/{rq}/consent/x",
  "/signin/requests/{rq}/licenses",
  "/signin/requests/{rq}/licenses/{lic}/devices",
  "/signin/requests/{rq}/licenses/{lic}/devices/x",
  "/signin/requests/{rq}/licenses/{lic}",
  "/signin/requests/{rq}/continue",
  "/signin/requests/{rq}/cancel",
  "/signin/requests/{rq}/other",
  "/signin/requests/{rq}/continue/x",
  "/signin/email/start",
  "/signin/email/verify",
  "/signin/email/resend",
  "/signin/email/nope",
  "/signin/email",
  "/signin/flow",
  "/signin/flow/x",
  "/signin/confirm-email",
  "/signin/confirm-email/x",
  "/signin/passkey/options",
  "/signin/passkey/verify",
  "/signin/passkey/nope",
  "/signin/nope",
  "/key/preview",
  "/key/preview/",
  "/key/preview/x",
  "/key",
  "/device-login",
  "/device-login/",
  "/device-login/start",
  "/device-login/start/x",
  "/device-login/lookup",
  "/device-login/lookup/x",
  "/device-login/approve",
  "/device-login/approve/x",
  "/device-login/ABCD-EFGH",
  "/device-login/ABCD-EFGH/x",
  "/me",
  "/me/",
  "/me/x",
  "/me/export",
  "/me/export/",
  "/me/export/x",
  "/me/deletion",
  "/me/deletion/cancel",
  "/me/deletion/cancel/x",
  "/me/deletion/nope",
  "/me/passkeys",
  "/me/passkeys/options",
  "/me/passkeys/register",
  "/me/passkeys/pk1",
  "/me/passkeys/pk1/x",
  "/me/methods",
  "/me/methods/email",
  "/me/methods/email/verify",
  "/me/methods/passkey",
  "/me/methods/google",
  "/me/methods/apple",
  "/me/methods/nope",
  "/me/link",
  "/me/link/start",
  "/me/link/confirm",
  "/me/link/cancel",
  "/me/link/undo",
  "/me/link/nope",
  "/me/tokens",
  "/me/tokens/",
  "/me/tokens/t1",
  "/me/tokens/t1/x",
  "/me/profile",
  "/me/profile/",
  "/me/profile/picture",
  "/me/profile/x",
  "/me/profile/picture/x",
  "/sessions",
  "/sessions/",
  "/sessions/sign-out-everywhere",
  "/sessions/sign-out-everywhere/x",
  "/sessions/s1",
  "/sessions/s1/x",
  "/licenses",
  "/licenses/",
  "/licenses/x",
  "/licenses/{prod}",
  "/licenses/{prod}/{lic}",
  "/licenses/{prod}/{lic}/",
  "/licenses/{prod}/nope",
  "/licenses/{prod}/{lic}/x",
  "/licenses/{prod}/{lic}/devices",
  "/licenses/{prod}/{lic}/devices/{dev}",
  "/licenses/{prod}/{lic}/devices/nope",
  "/licenses/{prod}/{lic}/devices/{dev}/x",
  "/licenses/{prod}/{lic}/keys",
  "/licenses/{prod}/{lic}/keys/x",
  "/licenses/{prod}/nope/keys",
  "/licenses/{prod}/{lic}/registry-tokens",
  "/licenses/{prod}/{lic}/registry-tokens/t1",
  "/licenses/{prod}/{lic}/registry-tokens/t1/x",
  "/licenses/{prod}/{lic}/registry-tokens/t1/x/y",
  "/licenses/{prod}/{lic}/other",
  "/claim",
  "/claim/license-key",
  "/claim/license-key/x",
  "/claim/x",
  "/activate",
  "/activate/preview",
  "/activate/preview/x",
  "/activate/x",
  "/releases",
  "/releases/",
  "/releases/{prod}",
  "/releases/{prod}/x",
  "/releases/{prod}/x/y",
  "/library",
  "/library/",
  "/library/{prod}",
  "/library/{prod}/x",
  "/library/nope",
  "/discover",
  "/discover/",
  "/discover/{prod}",
  "/discover/{prod}/claim",
  "/discover/{prod}/claim/x",
  "/discover/{prod}/x",
  "/discover/nope",
  "/discover/nope/claim",
  "/products",
  "/products/",
  "/products/{prod}",
  "/products/{prod}/",
  "/products/nope",
  "/products/{prod}/downloads",
  "/products/{prod}/downloads/x",
  "/products/{prod}/email-download",
  "/products/{prod}/export",
  "/products/{prod}/export/x",
  "/products/{prod}/data",
  "/products/{prod}/support-code",
  "/products/{prod}/nope",
  "/products/nope/downloads",
  "/products/nope/export",
  "/products/nope/data",
  "/products/nope/support-code",
  "/products/nope/email-download",
  "/nope",
  "/nope/deep/path",
  "/%2e%2e/me",
  "/me%2Fexport",
  "/%zz",
  "/me/%zz",
  "/licenses/%7Bx",
  "/licenses/{prod}/{lic}%2Fdevices",
  "/products/{prod}/export%2F",
  "?x=1",
  "/me?x=1",
  "/me/export?format=zip",
];

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const CARRIED = [
  "allow",
  "content-type",
  "cache-control",
  "www-authenticate",
  "vary",
  "location",
  "retry-after",
  "content-length",
  "content-disposition",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "strict-transport-security",
];

type Mode = "anon" | "cookie" | "csrf" | "badcsrf";

interface Row {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
  /** What the request left behind: the licence's account link (the sweep), live sessions. */
  after: string;
}

interface World {
  snapshot: Buffer;
  kv: Map<string, string>;
  cookie: string;
  csrf: string;
  secrets: Map<string, string>;
}

async function buildWorld(): Promise<World> {
  const db = makeTestDb();
  const kv = new KvMock();
  const env = baseEnv(kv);
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
  const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
  const { licenseId, key } = await seedLicenseWithKey(db, SLUG, {
    id: LICENSE,
  });
  const product = (await loadProduct(env, db, SLUG))!;
  await handleActivate(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": DEVICE }),
    env,
    db,
    product,
    NOW,
  );
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  const secrets = new Map<string, string>([
    [account.id, "<acct>"],
    [session.csrf, "<csrf>"],
    [token, "<sess>"],
    [await hashKey(key), "<keyhash>"],
  ]);
  const raw = (db as unknown as { db: Database.Database }).db;
  return {
    snapshot: raw.serialize(),
    kv: new Map(
      await Promise.all(
        kv.keys().map(async (k) => [k, (await kv.get(k))!] as const),
      ),
    ),
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    secrets,
  };
}

function baseEnv(kv: KvMock, customer = false): Env {
  const env = makeEnv(kv, [SLUG]);
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
  return env;
}

function normalise(text: string, secrets: Map<string, string>): string {
  let out = text;
  for (const [value, name] of secrets)
    if (value) out = out.replaceAll(value, name);
  return out
    .replace(/base64,[A-Za-z0-9+/=]+/g, "base64,<b64>")
    .replace(/\blnk_[A-Za-z0-9_-]+/g, "lnk_<id>")
    .replace(/\b[A-Z]{4}-[A-Z]{4}\b/g, "<usercode>")
    .replace(/\b[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}\b/g, "<support>")
    .replace(/\b(state|nonce)=[^&\s"]+/g, "$1=<tok>")
    .replace(/[A-Za-z0-9_-]{24,}/g, "<tok>")
    .replace(/\b1[67]\d{8}\b/g, "<ts>");
}

async function observe(
  res: Response,
  secrets: Map<string, string>,
): Promise<Row> {
  const headers: Record<string, string> = {};
  for (const name of CARRIED) {
    const v = res.headers.get(name);
    // The export's byte length follows its random ids; its normalised digest below stands in.
    if (name === "content-length" && res.headers.get("content-disposition"))
      continue;
    if (v !== null) headers[name] = normalise(v, secrets);
  }
  const setCookies =
    (
      res.headers as unknown as { getSetCookie?(): string[] }
    ).getSetCookie?.() ?? [];
  const cookies = setCookies
    .map((c) => {
      const [pair = "", ...attrs] = c.split(";");
      return [
        pair.split("=")[0],
        ...attrs.map((a) => normalise(a.trim(), secrets)),
      ].join("; ");
    })
    .sort();
  const raw = await res.text();
  let text: string;
  // The account export lists audit rows that share a second in the order of their random ids and
  // keys some objects by them: it is compared normalised leaf by leaf, arrays and keys as sets.
  // No other response is reordered.
  if (res.headers.get("content-disposition")) {
    try {
      text = JSON.stringify(
        canonical(JSON.parse(raw) as unknown, (x) => normalise(x, secrets)),
      );
    } catch {
      text = normalise(raw, secrets);
    }
  } else text = normalise(raw, secrets);
  return {
    status: res.status,
    headers,
    cookies,
    after: "",
    body: `${text.length}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
  };
}

/** The rows a request can change that its response does not show. */
async function afterState(db: Db): Promise<string> {
  const lic = await db.first<{ linked: number }>(
    "SELECT COUNT(account_id) AS linked FROM licenses WHERE id = ?",
    LICENSE,
  );
  const sessions = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM account_sessions",
  );
  const links = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM account_links",
  );
  return `linked:${lic?.linked} sessions:${sessions?.n} links:${links?.n}`;
}

function canonical(v: unknown, leaf: (text: string) => string): unknown {
  if (Array.isArray(v))
    return v
      .map((x) => canonical(x, leaf))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .map(([k, x]) => [leaf(k), canonical(x, leaf)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  if (typeof v === "string" || typeof v === "number") return leaf(String(v));
  return v;
}

interface Job {
  path: string;
  method: string;
  mode: Mode;
  body: boolean;
  customer: boolean;
}

function jobs(): Job[] {
  const out: Job[] = [];
  for (const path of API)
    for (const customer of [false, true])
      for (const mode of ["anon", "cookie", "csrf", "badcsrf"] as Mode[]) {
        // The customer host repeats the session modes that matter: signed out, and fully proven.
        if (customer && mode !== "anon" && mode !== "csrf") continue;
        for (const method of METHODS)
          for (const body of method === "GET" ||
          method === "HEAD" ||
          method === "OPTIONS"
            ? [false]
            : customer
              ? [true]
              : [false, true])
            out.push({ path, method, mode, body, customer });
      }
  return out;
}

describe("the portal /api routes replay the hand dispatch", () => {
  let world: World;
  beforeAll(async () => {
    vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] });
    world = await buildWorld();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function run(job: Job): Promise<[string, Row]> {
    const raw = new Database(world.snapshot);
    const db: Db = new SqliteDb(raw);
    const kv = new KvMock();
    for (const [k, v] of world.kv) await kv.put(k, v);
    const env = baseEnv(kv, job.customer);
    const secrets = new Map(world.secrets);
    const bound = await createSignInRequest(
      env,
      new Request(`${BASE}/signin`, {
        headers: { cookie: `__Host-pk_req=${BINDER}` },
      }) as unknown as Request,
      { product: SLUG, kind: "web", flowRef: "flow-1" },
      NOW,
    );
    secrets.set(bound.handle, "<rq>");
    const path = job.path
      .replaceAll("{rq}", bound.handle)
      .replaceAll("{lic}", LICENSE)
      .replaceAll("{dev}", DEVICE)
      .replaceAll("{prod}", SLUG);
    const headers: Record<string, string> = {};
    const cookies = [`__Host-pk_req=${BINDER}`];
    if (job.mode !== "anon") cookies.push(world.cookie);
    headers.cookie = cookies.join("; ");
    if (job.mode === "csrf") headers[PORTAL_CSRF_HEADER] = world.csrf;
    if (job.mode === "badcsrf")
      headers[PORTAL_CSRF_HEADER] = "x".repeat(world.csrf.length);
    const init: RequestInit = { method: job.method, headers };
    if (job.body) {
      init.body = "{}";
      headers["content-type"] = "application/json";
    }
    const key = `${job.customer ? "customer" : "console"} ${job.mode} ${job.method}${job.body ? "+body" : ""} /api${job.path}`;
    try {
      const url = `${job.customer ? CUSTOMER : BASE}/api${path}`;
      // A path that starts with `?` or is empty is the bare `/api` plus a query.
      const res = await dispatchWith(
        new Request(url.replace("/api?", "/api?"), init) as unknown as Request,
        env,
        db,
        NOW,
      );
      const row = await observe(res, secrets);
      row.after = await afterState(db);
      return [key, row];
    } catch (e) {
      return [
        key,
        {
          status: -1,
          headers: {},
          cookies: [],
          body: normalise(e instanceof Error ? e.message : String(e), secrets),
          after: await afterState(db),
        },
      ];
    } finally {
      raw.close();
    }
  }

  it("answers every request as the recorded dispatch did", async () => {
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
    const observed: Record<string, string> = {};
    for (const job of jobs()) {
      const [key, row] = await run(job);
      observed[key] =
        `${row.status} ${createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 16)}`;
    }
    if (process.env.PKEY_RECORD_ORACLE === "5") {
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
      string
    >;
    expect(Object.keys(observed)).toEqual(Object.keys(recorded));
    const changed = Object.keys(recorded).filter(
      (k) => observed[k] !== recorded[k],
    );
    expect(changed).toEqual([]);
  }, 900_000);
});
