/**
 * UX-69 (SETUP.md D42, W20) — the live credential check: a connect form sends the UNSAVED value
 * once, the Worker makes one minimal read-only call at the store with it, and answers what it
 * found in words. Against recorded-shape vendor answers (`fixtures/credentialCheck/*.json`):
 *
 *   - **Every store, every verdict.** App Store Connect, Google Play, Partner Center and Steam
 *     through `POST …/platform/store-connections/<store>/check`; itch.io, the Snap Store, GitHub
 *     (winget) and Steam's builder login through `POST …/distribution/storefronts/<id>/
 *     ci-secrets/<name>/check`: valid, which permission is missing, another team or account,
 *     expired, rejected, the store down, not checkable.
 *   - **Read-only, fixed hosts.** Every call is a GET to the store's one origin with
 *     `redirect: "manual"`; nothing else is ever sent.
 *   - **Nothing stored, nothing out.** No credential row, no KV write, no audit row; the response
 *     never carries the value; nothing is logged.
 *   - **Rate-limited per operator**, after the format check (a mistyped field costs nothing).
 *   - **Platform admins only**, POST only.
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import {
  putPlatformCredential,
  setPlatformPin,
} from "../src/core/platformCredentials.js";
import {
  transientOutletCredential,
  TransientOutletCredential,
} from "../src/core/outletCredentials.js";
import {
  bindDischarge,
  parseMacaroonV1,
  snapAuthorization,
} from "../src/services/distribution/ciSecretCheck.js";
import { CREDENTIAL_CHECK_LIMIT } from "../src/services/distribution/connectors/credentialCheck.js";
import { KvMock } from "./kvMock.js";
import { makeTestDb } from "./helpers.js";
import { CONSOLE, envFor, seedReleaseProduct } from "./releaseRoutesFixture.js";
import { addOutlet, ascP8 } from "./ascWorld.js";
import { NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
type Fixture = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
};
const fixtures = (name: string): Record<string, Fixture> =>
  JSON.parse(
    readFileSync(
      join(HERE, "fixtures", "credentialCheck", `${name}.json`),
      "utf8",
    ),
  ) as Record<string, Fixture>;
const ASC = fixtures("asc");
const GOOGLE = fixtures("google");
const ENTRA = fixtures("entra");
const STEAM = fixtures("steam");
const ITCH = fixtures("itch");
const SNAP = fixtures("snap");
const GITHUB = fixtures("github");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── the fake stores ──────────────────────────────────────────────────────────────────────────

interface Sent {
  method: string;
  url: string;
  redirect: RequestInit["redirect"];
  authorization: string | null;
  body: string | null;
}

/** Answers by `<host><path>` from `routes`; anything unrouted is a test failure (a 599). */
function fakeStores(routes: Record<string, Fixture | Fixture[]>) {
  const sent: Sent[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const h = new Headers(init?.headers);
    sent.push({
      method: init?.method ?? "GET",
      url: input,
      redirect: init?.redirect,
      authorization: h.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const key = `${url.host}${url.pathname}`;
    const r = routes[key];
    const f = Array.isArray(r) ? r.shift() : r;
    if (!f) return new Response("unrouted " + key, { status: 599 });
    return new Response(
      f.text ??
        (f.body === undefined || f.body === null ? "" : JSON.stringify(f.body)),
      {
        status: f.status,
        headers: {
          "content-type": f.text ? "text/html" : "application/json",
          ...f.headers,
        },
      },
    );
  };
  return { sent, fetchImpl };
}

interface World {
  env: Env;
  db: Db;
  kv: KvMock;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const kv = new KvMock();
  return { env: envFor({ kv }), db, kv };
}

async function call(
  w: World,
  stores: ReturnType<typeof fakeStores>,
  method: string,
  path: string,
  body?: unknown,
  opts: { groups?: string[]; sub?: string } = {},
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    {
      sub: opts.sub ?? "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: opts.groups ?? ["platform-admins"],
    },
    NOW,
  );
  const saved = globalThis.fetch;
  globalThis.fetch = stores.fetchImpl as typeof fetch;
  try {
    return await handleAdmin(
      new Request(`${CONSOLE}/manage/api${path}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      w.env,
      w.db,
      `/api${path}`,
      { now: NOW },
    );
  } finally {
    globalThis.fetch = saved;
  }
}

const storeCheck = (
  w: World,
  s: ReturnType<typeof fakeStores>,
  store: string,
  value: unknown,
  opts?: { groups?: string[]; sub?: string },
) =>
  call(
    w,
    s,
    "POST",
    `/platform/store-connections/${store}/check`,
    { value },
    opts,
  );

const ciCheck = (
  w: World,
  s: ReturnType<typeof fakeStores>,
  storefront: string,
  name: string,
  value: unknown,
) =>
  call(
    w,
    s,
    "POST",
    `/products/djdl/distribution/storefronts/${storefront}/ci-secrets/${name}/check`,
    { value },
  );

interface Check {
  verdict: string;
  reason: string;
  title: string;
  detail: string | null;
  facts: Array<{ label: string; value: string }>;
  field?: string;
  status?: number;
}

async function checkOf(res: Response): Promise<{ check: Check; text: string }> {
  expect(res.status).toBe(200);
  const text = await res.text();
  return { check: (JSON.parse(text) as { check: Check }).check, text };
}

/** Nothing of the check was kept: no credential row, no KV write, no audit row of any kind. */
async function expectNothingStored(w: World): Promise<void> {
  expect(
    await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM platform_credentials",
    ),
  ).toEqual({ n: 0 });
  expect(
    await w.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM platform_audit"),
  ).toEqual({ n: 0 });
  expect(
    await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit WHERE action LIKE '%credential%'",
    ),
  ).toEqual({ n: 0 });
  expect(w.kv.keys()).toEqual([]);
}

/** Every request a GET (or the token exchange's POST) to one of `hosts`, never following a
 *  redirect. */
function expectReadOnly(sent: Sent[], hosts: string[]): void {
  expect(sent.length).toBeGreaterThan(0);
  for (const r of sent) {
    expect(hosts).toContain(new URL(r.url).host);
    expect(r.redirect).toBe("manual");
    if (r.method !== "GET")
      expect(["login.microsoftonline.com", "oauth2.googleapis.com"]).toContain(
        new URL(r.url).host,
      );
  }
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────

const ISSUER = "69a6de7f-0000-47e3-e053-5b8c7c11a4d1";
const ascKey = (p8 = ascP8()) => ({
  keyId: "TEAMKEY123",
  issuerId: ISSUER,
  p8,
});

function googleKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    type: "service_account",
    project_id: "acme-platform",
    private_key_id: "fedcba9876543210",
    client_email: "pkey@acme-platform.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

const PC_SECRET = "Zq8~sEcReT.value-0123456789";
const pcKey = () => ({
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  clientSecret: PC_SECRET,
  sellerId: "12345678",
});
const STEAM_KEY = "0123456789ABCDEF0123456789ABCDEF";

const ASC_HOST = "api.appstoreconnect.apple.com";
const STEAM_HOST = "partner.steam-api.com";

// ── App Store Connect ────────────────────────────────────────────────────────────────────────

describe("live check: App Store Connect", () => {
  it("valid: names the team, the key and the apps it sees, with one read-only call", async () => {
    const w = await world();
    const s = fakeStores({ [`${ASC_HOST}/v1/apps`]: ASC.apps! });
    const key = ascKey();
    const { check, text } = await checkOf(
      await storeCheck(w, s, "app-store", key),
    );
    expect(check).toMatchObject({
      verdict: "valid",
      reason: "ok",
      title: "Team 69a6de7f · 2 apps",
    });
    expect(check.facts).toEqual([
      { label: "Issuer ID (team)", value: ISSUER },
      { label: "Key ID", value: "TEAMKEY123" },
      { label: "Apps", value: "2" },
      { label: "Apps seen", value: "Tonebox, Dice" },
    ]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.method).toBe("GET");
    expect(new URL(s.sent[0]!.url).searchParams.get("limit")).toBe("200");
    expect(s.sent[0]!.authorization).toMatch(/^Bearer ey/);
    expectReadOnly(s.sent, [ASC_HOST]);
    // Never the key, in any form.
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(key.p8.split("\n")[1]!);
    await expectNothingStored(w);
  });

  it("accepts the key file pasted as JSON text, like a PUT", async () => {
    const w = await world();
    const s = fakeStores({ [`${ASC_HOST}/v1/apps`]: ASC.apps! });
    const { check } = await checkOf(
      await storeCheck(w, s, "app-store", JSON.stringify(ascKey())),
    );
    expect(check.verdict).toBe("valid");
  });

  it("rejected: a revoked or mismatched key (401) says which three values must match", async () => {
    const w = await world();
    const s = fakeStores({ [`${ASC_HOST}/v1/apps`]: ASC.notAuthorized! });
    const { check, text } = await checkOf(
      await storeCheck(w, s, "app-store", ascKey()),
    );
    expect(check).toMatchObject({
      verdict: "invalid",
      reason: "rejected",
      title: "App Store Connect did not accept this key",
      status: 401,
    });
    // Apple's own error text is never copied.
    expect(text).not.toContain("Generating Tokens");
  });

  it("permission: a key whose role cannot read apps (403) names the role it needs", async () => {
    const w = await world();
    const s = fakeStores({ [`${ASC_HOST}/v1/apps`]: ASC.forbidden! });
    const { check } = await checkOf(
      await storeCheck(w, s, "app-store", ascKey()),
    );
    expect(check).toMatchObject({ verdict: "invalid", reason: "permission" });
    expect(check.detail).toContain("App Manager or Admin");
  });

  it("unavailable: a rate limit is answered as 'check again', without retrying", async () => {
    const w = await world();
    const s = fakeStores({ [`${ASC_HOST}/v1/apps`]: ASC.rateLimited! });
    const { check } = await checkOf(
      await storeCheck(w, s, "app-store", ascKey()),
    );
    expect(check).toMatchObject({
      verdict: "unavailable",
      reason: "rate-limited",
    });
    expect(s.sent).toHaveLength(1);
  });

  it("wrong team: an assigned app the key cannot see is a warning naming it", async () => {
    const w = await world();
    await setPlatformPin(w.db, {
      id: "app-store.api-key",
      product: "djdl",
      pin: "5555555555",
      actor: "u1",
      now: NOW,
    });
    const s = fakeStores({ [`${ASC_HOST}/v1/apps`]: ASC.apps! });
    const { check } = await checkOf(
      await storeCheck(w, s, "app-store", ascKey()),
    );
    expect(check).toMatchObject({
      verdict: "warning",
      reason: "wrong-account",
      title: "This key cannot see an app a product is assigned: 5555555555",
    });
  });

  it("wrong team: a key from another issuer than the connected one is a warning", async () => {
    const w = await world();
    await putPlatformCredential(w.env, w.db, {
      id: "app-store.api-key",
      value: { ...ascKey(), issuerId: "aaaaaaaa-0000-0000-0000-000000000000" },
      actor: "u1",
      now: NOW,
    });
    const s = fakeStores({ [`${ASC_HOST}/v1/apps`]: ASC.apps! });
    const { check } = await checkOf(
      await storeCheck(w, s, "app-store", ascKey()),
    );
    expect(check).toMatchObject({
      verdict: "warning",
      reason: "wrong-account",
    });
    expect(check.title).toBe(
      "This key belongs to another team than the one connected now",
    );
  });

  it("format: a broken .p8 is caught before any call and names the field", async () => {
    const w = await world();
    const s = fakeStores({});
    const { check } = await checkOf(
      await storeCheck(w, s, "app-store", { ...ascKey(), p8: "not a key" }),
    );
    expect(check).toMatchObject({
      verdict: "invalid",
      reason: "format",
      field: "value.p8",
    });
    expect(s.sent).toEqual([]);
  });

  it("the In-App Purchase key is format-checked only: no team-wide read exists for it", async () => {
    const w = await world();
    const s = fakeStores({});
    const res = await call(
      w,
      s,
      "POST",
      "/platform/store-connections/app-store/credentials/in-app-purchase-key/check",
      { value: ascKey() },
    );
    const { check } = await checkOf(res);
    expect(check).toMatchObject({
      verdict: "unchecked",
      reason: "not-checkable",
    });
    expect(check.facts).toContainEqual({
      label: "Key ID",
      value: "TEAMKEY123",
    });
    expect(s.sent).toEqual([]);
  });
});

// ── Google Play ──────────────────────────────────────────────────────────────────────────────

const G_TOKEN = "oauth2.googleapis.com/token";
const G_SEARCH = "playdeveloperreporting.googleapis.com/v1beta1/apps:search";

describe("live check: Google Play", () => {
  it("valid: the token exchange, then one page of apps:search", async () => {
    const w = await world();
    const s = fakeStores({
      [G_TOKEN]: GOOGLE.token!,
      [G_SEARCH]: GOOGLE.apps!,
    });
    const key = googleKey();
    const { check, text } = await checkOf(
      await storeCheck(w, s, "google-play", key),
    );
    expect(check).toMatchObject({ verdict: "valid", title: "pkey · 2 apps" });
    expect(check.facts[0]).toEqual({
      label: "Service account",
      value: key.client_email,
    });
    expect(s.sent.map((r) => r.method)).toEqual(["POST", "GET"]);
    expect(s.sent[1]!.authorization).toBe("Bearer ya29.c.fake-transient-token");
    expectReadOnly(s.sent, [
      "oauth2.googleapis.com",
      "playdeveloperreporting.googleapis.com",
    ]);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("ya29");
    // The transient token is never cached (a stored key's would be, sealed, in KV).
    await expectNothingStored(w);
  });

  it("rejected: a deleted key (invalid_grant) says to create a new one", async () => {
    const w = await world();
    const s = fakeStores({ [G_TOKEN]: GOOGLE.invalidGrant! });
    const { check, text } = await checkOf(
      await storeCheck(w, s, "google-play", googleKey()),
    );
    expect(check).toMatchObject({
      verdict: "invalid",
      reason: "rejected",
      status: 400,
    });
    expect(check.detail).toContain("deleted or disabled");
    expect(text).not.toContain("Invalid JWT Signature");
  });

  it("permission: not invited to the Play Console", async () => {
    const w = await world();
    const s = fakeStores({
      [G_TOKEN]: GOOGLE.token!,
      [G_SEARCH]: GOOGLE.permissionDenied!,
    });
    const { check } = await checkOf(
      await storeCheck(w, s, "google-play", googleKey()),
    );
    expect(check).toMatchObject({
      verdict: "invalid",
      reason: "permission",
      title: "This service account is not in your Play Console",
    });
    expect(check.detail).toContain("Users and permissions");
  });

  it("permission: the Reporting API is off in the key's Cloud project", async () => {
    const w = await world();
    const s = fakeStores({
      [G_TOKEN]: GOOGLE.token!,
      [G_SEARCH]: GOOGLE.serviceDisabled!,
    });
    const { check, text } = await checkOf(
      await storeCheck(w, s, "google-play", googleKey()),
    );
    expect(check.title).toBe(
      "The Play Developer Reporting API is turned off for this key's Cloud project",
    );
    expect(text).not.toContain("123456789012");
  });

  it("warning: accepted, but it sees no apps", async () => {
    const w = await world();
    const s = fakeStores({
      [G_TOKEN]: GOOGLE.token!,
      [G_SEARCH]: GOOGLE.noApps!,
    });
    const { check } = await checkOf(
      await storeCheck(w, s, "google-play", googleKey()),
    );
    expect(check).toMatchObject({ verdict: "warning", reason: "permission" });
  });
});

// ── Microsoft Store ──────────────────────────────────────────────────────────────────────────

const E_TOKEN =
  "login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/token";
const MS_APPS = "manage.devcenter.microsoft.com/v1.0/my/applications";

describe("live check: Partner Center", () => {
  it("valid: Entra's token, then one read of the seller's apps", async () => {
    const w = await world();
    const s = fakeStores({
      [E_TOKEN]: ENTRA.token!,
      [MS_APPS]: ENTRA.applications!,
    });
    const { check, text } = await checkOf(
      await storeCheck(w, s, "microsoft-store", pcKey()),
    );
    expect(check).toMatchObject({
      verdict: "valid",
      title: "Seller 12345678 · 1 app",
    });
    expect(s.sent[0]!.body).toContain("client_secret=");
    expectReadOnly(s.sent, [
      "login.microsoftonline.com",
      "manage.devcenter.microsoft.com",
    ]);
    expect(text).not.toContain(PC_SECRET);
    await expectNothingStored(w);
  });

  it("expired: AADSTS7000222 says the secret expired, on the secret field", async () => {
    const w = await world();
    const s = fakeStores({ [E_TOKEN]: ENTRA.secretExpired! });
    const { check, text } = await checkOf(
      await storeCheck(w, s, "microsoft-store", pcKey()),
    );
    expect(check).toMatchObject({
      verdict: "invalid",
      reason: "expired",
      title: "This client secret has expired",
      field: "value.clientSecret",
    });
    expect(text).not.toContain("AADSTS");
  });

  it("rejected: AADSTS7000215 (the secret's ID pasted instead of its value)", async () => {
    const w = await world();
    const s = fakeStores({ [E_TOKEN]: ENTRA.secretWrong! });
    const { check } = await checkOf(
      await storeCheck(w, s, "microsoft-store", pcKey()),
    );
    expect(check).toMatchObject({
      reason: "rejected",
      field: "value.clientSecret",
    });
    expect(check.detail).toContain("not its Secret ID");
  });

  it("wrong account: AADSTS700016, no such app in the tenant", async () => {
    const w = await world();
    const s = fakeStores({ [E_TOKEN]: ENTRA.appNotFound! });
    const { check } = await checkOf(
      await storeCheck(w, s, "microsoft-store", pcKey()),
    );
    expect(check).toMatchObject({
      reason: "wrong-account",
      field: "value.clientId",
    });
  });

  it("permission: Entra accepts it, the Store API does not (not added to Partner Center)", async () => {
    const w = await world();
    const s = fakeStores({
      [E_TOKEN]: ENTRA.token!,
      [MS_APPS]: ENTRA.unauthorized!,
    });
    const { check } = await checkOf(
      await storeCheck(w, s, "microsoft-store", pcKey()),
    );
    expect(check).toMatchObject({
      verdict: "invalid",
      reason: "permission",
      title: "This app is not added to Partner Center",
    });
    expect(check.detail).toContain("Manager role");
  });
});

// ── Steam ────────────────────────────────────────────────────────────────────────────────────

const STEAM_LIST = `${STEAM_HOST}/ISteamApps/GetPartnerAppListForWebAPIKey/v2/`;

describe("live check: Steam publisher key", () => {
  it("valid: the group's apps, the key only in the query of one GET", async () => {
    const w = await world();
    const s = fakeStores({ [STEAM_LIST]: STEAM.applist! });
    const { check, text } = await checkOf(
      await storeCheck(w, s, "steam", { key: STEAM_KEY.toLowerCase() }),
    );
    expect(check).toMatchObject({
      verdict: "valid",
      title: "Publisher key · 2 apps",
    });
    expect(check.facts).toContainEqual({ label: "First apps", value: "Dice" });
    expectReadOnly(s.sent, [STEAM_HOST]);
    expect(text.toUpperCase()).not.toContain(STEAM_KEY);
    await expectNothingStored(w);
  });

  it("rejected: Steam's 403 for a personal or unknown key", async () => {
    const w = await world();
    const s = fakeStores({ [STEAM_LIST]: STEAM.forbidden! });
    const { check, text } = await checkOf(
      await storeCheck(w, s, "steam", { key: STEAM_KEY }),
    );
    expect(check).toMatchObject({
      verdict: "invalid",
      reason: "rejected",
      status: 403,
    });
    expect(text).not.toContain("key=");
  });

  it("store down: a 503 is unavailable, never 'invalid'", async () => {
    const w = await world();
    const s = fakeStores({ [STEAM_LIST]: { status: 503, text: "busy" } });
    const { check } = await checkOf(
      await storeCheck(w, s, "steam", { key: STEAM_KEY }),
    );
    expect(check).toMatchObject({
      verdict: "unavailable",
      reason: "store-down",
      status: 503,
    });
  });
});

// ── the route's guarantees ───────────────────────────────────────────────────────────────────

describe("live check: route guarantees", () => {
  it("is platform-admin only, POST only, and unknown slots are 404", async () => {
    const w = await world();
    const s = fakeStores({});
    expect(
      (
        await storeCheck(
          w,
          s,
          "steam",
          { key: STEAM_KEY },
          { groups: ["devs"] },
        )
      ).status,
    ).toBe(403);
    expect(
      (await call(w, s, "GET", "/platform/store-connections/steam/check"))
        .status,
    ).toBe(405);
    expect(
      (
        await call(
          w,
          s,
          "POST",
          "/platform/store-connections/steam/credentials/nope/check",
          {
            value: {},
          },
        )
      ).status,
    ).toBe(404);
    expect(s.sent).toEqual([]);
  });

  it("logs nothing of the value", async () => {
    const w = await world();
    const logged: unknown[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(...a);
      });
    const s = fakeStores({ [E_TOKEN]: ENTRA.secretExpired! });
    await storeCheck(w, s, "microsoft-store", pcKey());
    expect(JSON.stringify(logged)).not.toContain(PC_SECRET);
  });

  it("is rate-limited per operator, counted only after the format check", async () => {
    const w = await world();
    const s = fakeStores({});
    // Format failures are free: no call, no budget.
    for (let i = 0; i < CREDENTIAL_CHECK_LIMIT.limit + 5; i++)
      expect(
        (await checkOf(await storeCheck(w, s, "steam", { key: "short" }))).check
          .reason,
      ).toBe("format");
    const ok = fakeStores({
      [STEAM_LIST]: Array.from({ length: 40 }, () => STEAM.applist!),
    });
    for (let i = 0; i < CREDENTIAL_CHECK_LIMIT.limit; i++)
      expect(
        (await storeCheck(w, ok, "steam", { key: STEAM_KEY })).status,
      ).toBe(200);
    const refused = await storeCheck(w, ok, "steam", { key: STEAM_KEY });
    expect(refused.status).toBe(429);
    expect(ok.sent).toHaveLength(CREDENTIAL_CHECK_LIMIT.limit);
    // Another operator has a budget of their own.
    expect(
      (await storeCheck(w, ok, "steam", { key: STEAM_KEY }, { sub: "u2" }))
        .status,
    ).toBe(200);
  });
});

describe("the transient credential", () => {
  it("serialises, prints and inspects without its value", async () => {
    const t = await transientOutletCredential("ms-partner-center", pcKey());
    if (!t.ok) throw new Error(t.message);
    const c = t.credential;
    expect(c).toBeInstanceOf(TransientOutletCredential);
    expect(JSON.stringify({ c })).not.toContain(PC_SECRET);
    expect(String(c)).toBe("[transient ms-partner-center]");
    const { inspect } = await import("node:util");
    expect(inspect(c, { depth: 5, showHidden: true })).not.toContain(PC_SECRET);
    expect(Object.keys(c)).not.toContain("value");
    expect(c.reveal().clientSecret).toBe(PC_SECRET);
  });
});

// ── CI secrets ───────────────────────────────────────────────────────────────────────────────

const ITCH_PROFILE = "api.itch.io/profile";
const ITCH_GAMES = "api.itch.io/profile/games";
const BUTLER = "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCd";

describe("CI secret check: itch.io BUTLER_API_KEY", () => {
  it("valid: whose key, and that it can push to the outlet's game", async () => {
    const w = await world();
    await addOutlet(w.db, "itch", "itch", {
      target: "acme/tonebox",
      gameId: 1001,
    });
    const s = fakeStores({
      [ITCH_PROFILE]: ITCH.profile!,
      [ITCH_GAMES]: ITCH.games!,
    });
    const { check, text } = await checkOf(
      await ciCheck(w, s, "itch", "BUTLER_API_KEY", BUTLER),
    );
    expect(check).toMatchObject({
      verdict: "valid",
      title: "itch.io user acme · can push to acme/tonebox",
    });
    expect(
      s.sent.every((r) => r.method === "GET" && r.redirect === "manual"),
    ).toBe(true);
    expect(s.sent[0]!.authorization).toBe(`Bearer ${BUTLER}`);
    expect(text).not.toContain(BUTLER);
    await expectNothingStored(w);
  });

  it("rejected: itch.io's 200 with an errors list", async () => {
    const w = await world();
    const s = fakeStores({ [ITCH_PROFILE]: ITCH.invalidKey! });
    const { check } = await checkOf(
      await ciCheck(w, s, "itch", "BUTLER_API_KEY", BUTLER),
    );
    expect(check).toMatchObject({ verdict: "invalid", reason: "rejected" });
  });

  it("wrong account: the key's user is not the target's", async () => {
    const w = await world();
    await addOutlet(w.db, "itch", "itch", {
      target: "studio/tonebox",
      gameId: 1001,
    });
    const s = fakeStores({ [ITCH_PROFILE]: ITCH.profile! });
    const { check } = await checkOf(
      await ciCheck(w, s, "itch", "BUTLER_API_KEY", BUTLER),
    );
    expect(check).toMatchObject({
      verdict: "warning",
      reason: "wrong-account",
    });
  });

  it("not found: the game page does not exist yet", async () => {
    const w = await world();
    await addOutlet(w.db, "itch", "itch", {
      target: "acme/dice",
      gameId: 2002,
    });
    const s = fakeStores({
      [ITCH_PROFILE]: ITCH.profile!,
      [ITCH_GAMES]: ITCH.games!,
    });
    const { check } = await checkOf(
      await ciCheck(w, s, "itch", "BUTLER_API_KEY", BUTLER),
    );
    expect(check).toMatchObject({ verdict: "invalid", reason: "not-found" });
  });

  it("format: not an API key, no call", async () => {
    const w = await world();
    const s = fakeStores({});
    const { check } = await checkOf(
      await ciCheck(w, s, "itch", "BUTLER_API_KEY", "has spaces in it!"),
    );
    expect(check.reason).toBe("format");
    expect(s.sent).toEqual([]);
  });
});

// A v1 macaroon, built here: location, identifier, signature (32 bytes).
function macaroon(id: string, sig: number): string {
  const packet = (k: string, v: Uint8Array) => {
    const key = new TextEncoder().encode(k);
    const len = 4 + key.length + 1 + v.length + 1;
    return Buffer.concat([
      Buffer.from(len.toString(16).padStart(4, "0")),
      Buffer.from(key),
      Buffer.from(" "),
      Buffer.from(v),
      Buffer.from("\n"),
    ]);
  };
  return Buffer.concat([
    packet("location", new TextEncoder().encode("https://login.ubuntu.com")),
    packet("identifier", new TextEncoder().encode(id)),
    packet("signature", new Uint8Array(32).fill(sig)),
  ]).toString("base64url");
}

const SNAP_WHOAMI = "dashboard.snapcraft.io/api/v2/tokens/whoami";
const exportLogin = (v: unknown) =>
  Buffer.from(JSON.stringify({ t: "u1-macaroon", v })).toString("base64");

describe("CI secret check: SNAPCRAFT_STORE_CREDENTIALS", () => {
  it("binds the Ubuntu One discharge to its root, like craft-store", async () => {
    const root = macaroon("root-id", 1);
    const discharge = macaroon("discharge-id", 2);
    const bound = (await bindDischarge(root, discharge))!;
    const packets = parseMacaroonV1(bound)!;
    expect(packets.map((p) => p.key)).toEqual([
      "location",
      "identifier",
      "signature",
    ]);
    // HMAC(0^32, HMAC(0^32, sig1) || HMAC(0^32, sig2)), computed independently.
    const { createHmac } = await import("node:crypto");
    const zero = Buffer.alloc(32);
    const h = (d: Buffer) => createHmac("sha256", zero).update(d).digest();
    const expected = h(
      Buffer.concat([h(Buffer.alloc(32, 1)), h(Buffer.alloc(32, 2))]),
    );
    expect(Buffer.from(packets[2]!.value).equals(expected)).toBe(true);
    expect(
      await snapAuthorization(exportLogin({ r: root, d: discharge })),
    ).toBe(`Macaroon root=${root}, discharge=${bound}`);
    expect(
      await snapAuthorization(
        Buffer.from(JSON.stringify({ t: "macaroon", v: root })).toString(
          "base64",
        ),
      ),
    ).toBe(`Macaroon ${root}`);
    expect(await snapAuthorization("not a login")).toBeNull();
  });

  it("valid: the account, its ACLs, its snaps and its expiry", async () => {
    const w = await world();
    await addOutlet(w.db, "snap", "snap", {
      name: "tonebox",
      channels: ["stable"],
    });
    const s = fakeStores({ [SNAP_WHOAMI]: SNAP.whoami! });
    const value = exportLogin({ r: macaroon("r", 1), d: macaroon("d", 2) });
    const { check, text } = await checkOf(
      await ciCheck(w, s, "snap", "SNAPCRAFT_STORE_CREDENTIALS", value),
    );
    expect(check).toMatchObject({
      verdict: "valid",
      title: "Snap Store account acme · can push tonebox",
    });
    expect(check.facts).toContainEqual({
      label: "Expires",
      value: "2027-01-01",
    });
    expect(s.sent[0]!.authorization).toMatch(/^Macaroon root=/);
    expect(text).not.toContain(value);
  });

  it("permission: a login without package_release, or for another snap", async () => {
    const w = await world();
    await addOutlet(w.db, "snap", "snap", {
      name: "tonebox",
      channels: ["stable"],
    });
    const noRelease = {
      status: 200,
      body: {
        ...(SNAP.whoami!.body as object),
        permissions: ["package_access", "package_push"],
      },
    };
    const otherSnap = {
      status: 200,
      body: { ...(SNAP.whoami!.body as object), packages: [{ name: "dice" }] },
    };
    const s = fakeStores({ [SNAP_WHOAMI]: [noRelease, otherSnap] });
    const value = exportLogin({ r: macaroon("r", 1), d: macaroon("d", 2) });
    const a = (
      await checkOf(
        await ciCheck(w, s, "snap", "SNAPCRAFT_STORE_CREDENTIALS", value),
      )
    ).check;
    expect(a).toMatchObject({ verdict: "invalid", reason: "permission" });
    expect(a.title).toContain("lacks package_release");
    expect(a.detail).toContain("--acls package_push,package_release");
    const b = (
      await checkOf(
        await ciCheck(w, s, "snap", "SNAPCRAFT_STORE_CREDENTIALS", value),
      )
    ).check;
    expect(b.title).toBe("This login is not scoped to tonebox");
  });

  it("expired: the dashboard's needs-refresh, and an expiry in the past", async () => {
    const w = await world();
    const past = {
      status: 200,
      body: {
        ...(SNAP.whoami!.body as object),
        expires: "2023-01-01T00:00:00.000",
      },
    };
    const s = fakeStores({ [SNAP_WHOAMI]: [SNAP.expired!, past] });
    const value = exportLogin({ r: macaroon("r", 1), d: macaroon("d", 2) });
    expect(
      (
        await checkOf(
          await ciCheck(w, s, "snap", "SNAPCRAFT_STORE_CREDENTIALS", value),
        )
      ).check,
    ).toMatchObject({ verdict: "invalid", reason: "expired" });
    expect(
      (
        await checkOf(
          await ciCheck(w, s, "snap", "SNAPCRAFT_STORE_CREDENTIALS", value),
        )
      ).check,
    ).toMatchObject({ verdict: "invalid", reason: "expired" });
  });
});

const GH_USER = "api.github.com/user";
const GH_FORK = "api.github.com/repos/acme-bot/winget-pkgs";
const CLASSIC = `ghp_${"a".repeat(36)}`;
const FINE = `github_pat_${"B".repeat(22)}_${"c".repeat(59)}`;

describe("CI secret check: winget PKEY_PR_TOKEN", () => {
  it("valid: a classic public_repo token with its fork", async () => {
    const w = await world();
    const s = fakeStores({
      [GH_USER]: GITHUB.userClassic!,
      [GH_FORK]: GITHUB.fork!,
    });
    const { check, text } = await checkOf(
      await ciCheck(w, s, "winget", "PKEY_PR_TOKEN", CLASSIC),
    );
    expect(check).toMatchObject({
      verdict: "valid",
      title: "GitHub account acme-bot · can open winget pull requests",
    });
    expect(check.facts).toContainEqual({
      label: "Expires",
      value: "2027-01-01",
    });
    expect(s.sent.every((r) => r.method === "GET")).toBe(true);
    expect(text).not.toContain(CLASSIC);
  });

  it("permission: a classic token without public_repo", async () => {
    const w = await world();
    const s = fakeStores({ [GH_USER]: GITHUB.userClassicNoScope! });
    const { check } = await checkOf(
      await ciCheck(w, s, "winget", "PKEY_PR_TOKEN", CLASSIC),
    );
    expect(check).toMatchObject({ verdict: "invalid", reason: "permission" });
    expect(check.detail).toContain("public_repo");
  });

  it("not found: a fine-grained token cannot create the fork it needs", async () => {
    const w = await world();
    const s = fakeStores({
      [GH_USER]: GITHUB.userFineGrained!,
      [GH_FORK]: GITHUB.notFound!,
    });
    const { check } = await checkOf(
      await ciCheck(w, s, "winget", "PKEY_PR_TOKEN", FINE),
    );
    expect(check).toMatchObject({ verdict: "invalid", reason: "not-found" });
  });

  it("expiring: a working token that expires within two weeks is a warning", async () => {
    const w = await world();
    // The handler's clock is the request's `now`: an expiry three days after it.
    const s2 = fakeStores({
      [GH_USER]: {
        ...GITHUB.userFineGrained!,
        headers: {
          "github-authentication-token-expiration": `${new Date((NOW + 3 * 86400) * 1000).toISOString().slice(0, 10)} 00:00:00 UTC`,
        },
      },
      [GH_FORK]: GITHUB.fork!,
    });
    const { check } = await checkOf(
      await ciCheck(w, s2, "winget", "PKEY_PR_TOKEN", FINE),
    );
    expect(check).toMatchObject({ verdict: "warning", reason: "expiring" });
  });

  it("rejected: GitHub's 401", async () => {
    const w = await world();
    const s = fakeStores({ [GH_USER]: GITHUB.badCredentials! });
    const { check } = await checkOf(
      await ciCheck(w, s, "winget", "PKEY_PR_TOKEN", CLASSIC),
    );
    expect(check).toMatchObject({ verdict: "invalid", reason: "rejected" });
  });
});

describe("CI secret check: Steam builder login and the route", () => {
  it("is answered 'not checkable', with no call and no budget spent", async () => {
    const w = await world();
    const s = fakeStores({});
    const { check } = await checkOf(
      await ciCheck(w, s, "steam", "STEAM_CONFIG_VDF", '"users" { }'),
    );
    expect(check).toMatchObject({
      verdict: "unchecked",
      reason: "not-checkable",
    });
    expect(s.sent).toEqual([]);
  });

  it("an unknown storefront or secret name is 404; GET is 405", async () => {
    const w = await world();
    const s = fakeStores({});
    expect((await ciCheck(w, s, "itch", "NOPE", "x")).status).toBe(404);
    expect((await ciCheck(w, s, "flathub", "BUTLER_API_KEY", "x")).status).toBe(
      404,
    );
    expect(
      (
        await call(
          w,
          s,
          "GET",
          "/products/djdl/distribution/storefronts/itch/ci-secrets/BUTLER_API_KEY/check",
        )
      ).status,
    ).toBe(405);
  });

  it("is platform-admin only", async () => {
    const w = await world();
    await seedProduct(w.db, "other");
    const s = fakeStores({});
    const res = await call(
      w,
      s,
      "POST",
      "/products/djdl/distribution/storefronts/itch/ci-secrets/BUTLER_API_KEY/check",
      { value: BUTLER },
      { groups: ["devs"] },
    );
    expect(res.status).toBe(403);
    expect(s.sent).toEqual([]);
  });
});
