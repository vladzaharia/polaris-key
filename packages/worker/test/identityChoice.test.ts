// I-08b (WIRE-CONTRACT-V4 §12.4.1, §12.5.1; plans/I-08.md D2, D5; plans/I-04.md §C, §F, §G):
// the licence choice at sign-in. Each property has a positive case and a negative control:
//
//   - the card's reads list only the signed-in account's licences, and one 404 hides the rest;
//   - a Continue mints the first automatic licence once (the claim), never while a usable one
//     exists, and fails closed when the store is unreachable;
//   - Replace frees a seat and claims it in one batch, on the portal's budget, with its audit row;
//   - the pending sign-in grant answers only its device, spends 30 reads, ends on complete or
//     cancel, and `choice/complete` answers what `token` answers;
//   - a key entered in the app is counted exactly once;
//   - with Identity off every route is refused.

import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import { stmtsDeauthorizeDevice } from "../src/core/devices/store.js";
import { withMintClaim } from "../src/services/identity/passthrough/mint.js";
import { dispatchWith } from "../src/dispatch.js";
import { loadProduct } from "../src/core/products.js";
import {
  serializeServices,
  SERVICE_SLUGS,
  type ServicesMap,
} from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { handlePortalApi as portalApi } from "../src/services/identity/portal/api.js";
import { codeCopy, CLOSE_PAGE } from "../src/core/brandPage.js";
import { escapeHtml } from "../src/platform/html.js";
import { SETTINGS } from "../src/mount.js";
import { portalHooksFor } from "./portalHarness.js";
import { validateRedirectUri } from "../src/services/identity/passthrough/redirectUri.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

/** The portal API as the composition root wires it, settings registry included. */
const handlePortalApi = (
  req: Request,
  e: Env,
  d: SqliteDb,
  path: string,
  now: number,
): Promise<Response> =>
  portalApi(req, e, d, path, now, portalHooksFor(e, d), SETTINGS);

const SLUG = "tidewater";
const BASE = "https://key.plrs.im";
const APP = "https://app.example";
const CB = `${APP}/auth/callback`;
const DEVICE = "I08DEVICEA0000000000000000000001";
const STATE = "s".repeat(24);
const VERIFIER = "v".repeat(48);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let db: SqliteDb;
let env: Env;

async function services(over: Partial<Record<string, boolean>> = {}) {
  const on: Record<string, boolean> = {
    license: true,
    config: true,
    identity: true,
    ...over,
  };
  const map = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, { enabled: on[s] === true }]),
  ) as ServicesMap;
  await setServices(
    db,
    SLUG,
    serializeServices({ services: map }),
    "manifest",
    NOW,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    JSON.stringify([APP]),
    SLUG,
  );
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, 'identity.redirectPaths', ?, 'manifest', ?, 'test')`,
    SLUG,
    JSON.stringify(["/auth/callback"]),
    NOW,
  );
  await services();
});

function route(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return dispatchWith(
    new Request(`${BASE}${path}`, {
      method,
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
    }) as unknown as Request,
    env,
    db,
    NOW,
  );
}

function authorizeUrl(over: Record<string, string | null> = {}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: SLUG,
    redirect_uri: CB,
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  return `/${SLUG}/identity/authorize?${q}`;
}

const authorize = (over: Record<string, string | null> = {}, cookie?: string) =>
  route("GET", authorizeUrl(over), cookie ? { headers: { cookie } } : {});

/** authorize, then the handle and binder cookie from the card redirect. */
async function begin(over: Record<string, string | null> = {}) {
  const res = await authorize(over);
  expect(res.status).toBe(303);
  const location = res.headers.get("location")!;
  const handle = new URL(location).searchParams.get("request")!;
  expect(handle).toMatch(/^rq_[A-Za-z0-9_-]{22}$/);
  expect(new URL(location).origin + new URL(location).pathname).toBe(
    `${BASE}/signin`,
  );
  const binder = res.headers.get("set-cookie")!.split(";")[0]!;
  return { handle, binder, res };
}

async function signedIn(email = "ada@example.com") {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
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
  return {
    id: account.id,
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
  };
}

function card(
  path: string,
  s: { cookie: string; csrf: string },
  binder: string | null,
  body?: unknown,
  csrf: string | null = s.csrf,
): Promise<Response> {
  return handlePortalApi(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        cookie: binder ? `${s.cookie}; ${binder}` : s.cookie,
        ...(csrf ? { [PORTAL_CSRF_HEADER]: csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    path,
    NOW,
  );
}

/** Continue and read the redirect it answers. */
async function proceed(
  handle: string,
  s: { cookie: string; csrf: string },
  binder: string,
  body: unknown = {},
) {
  const res = await card(
    `/api/signin/requests/${handle}/continue`,
    s,
    binder,
    body,
  );
  return { res, json: (await res.clone().json()) as Record<string, string> };
}

function codeOf(redirect: string): string {
  return new URL(redirect).searchParams.get("code")!;
}

function tokenReq(
  fields: Record<string, string | null>,
  opts: {
    device?: string | null;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Response> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: SLUG,
    code_verifier: VERIFIER,
    redirect_uri: CB,
  });
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) form.delete(k);
    else form.set(k, v);
  }
  return route("POST", `/${SLUG}/identity/token`, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(opts.device === null
        ? {}
        : { "x-pkey-device": opts.device ?? DEVICE }),
      ...(opts.headers ?? {}),
    },
    body: opts.body ?? form.toString(),
  });
}

/** A full web sign-in up to the code. */
async function codeFor(
  over: Record<string, string | null> = {},
  body: unknown = {},
) {
  const { handle, binder } = await begin(over);
  const s = await signedIn();
  const out = await proceed(handle, s, binder, body);
  expect(out.res.status).toBe(200);
  return {
    code: codeOf(out.json.redirect!),
    s,
    handle,
    binder,
    redirect: out.json.redirect!,
  };
}

const DEVICE_B = "I08DEVICEB0000000000000000000002";
const DEVICE_C = "I08DEVICEC0000000000000000000003";

async function ownLicense(
  accountId: string,
  id: string,
  opts: { limit?: number; tierId?: string } = {},
) {
  const seeded = await seedLicenseWithKey(db, SLUG, {
    id,
    ...(opts.tierId ? { tierId: opts.tierId } : {}),
  });
  await db.run(
    "UPDATE licenses SET account_id = ?, device_limit = ? WHERE product = ? AND id = ?",
    accountId,
    opts.limit ?? 5,
    SLUG,
    id,
  );
  return seeded;
}

/** A licence no account holds: the seed's email would otherwise let a portal sweep claim it. */
async function unlinked(id: string) {
  const seeded = await seedLicenseWithKey(db, SLUG, { id });
  await db.run(
    "UPDATE licenses SET email = NULL WHERE product = ? AND id = ?",
    SLUG,
    id,
  );
  return seeded;
}

async function activateWithKey(key: string, device: string) {
  const res = await route("POST", `/${SLUG}/license/activate`, {
    headers: { authorization: `Bearer ${key}`, "x-pkey-device": device },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string };
}

function cardGet(
  path: string,
  s: { cookie: string },
  binder: string | null,
): Promise<Response> {
  return handlePortalApi(
    new Request(`${BASE}${path}`, {
      headers: { cookie: binder ? `${s.cookie}; ${binder}` : s.cookie },
    }),
    env,
    db,
    path,
    NOW,
  );
}

function grantReq(
  action: string,
  body: unknown,
  opts: { device?: string | null; bearer?: string } = {},
): Promise<Response> {
  return route("POST", `/${SLUG}/identity/choice/${action}`, {
    headers: {
      "content-type": "application/json",
      ...(opts.device === null
        ? {}
        : { "x-pkey-device": opts.device ?? DEVICE }),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** authorize (app mode) -> Continue -> token: the `choose` answer. */
async function chooseGrant(
  accountEmail = "ada@example.com",
  body: unknown = {},
  device = DEVICE,
) {
  const { handle, binder } = await begin({ license_choice: "app" });
  const s = await signedIn(accountEmail);
  const out = await proceed(handle, s, binder, body);
  expect(out.res.status).toBe(200);
  const res = await tokenReq({ code: codeOf(out.json.redirect!) }, { device });
  return { res, s, handle, binder };
}

async function setPolicy() {
  await seedTier(db, SLUG, "free", { deviceLimit: 2 });
  await db.run(
    "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
    JSON.stringify({
      enabled: true,
      tierId: "free",
      mode: "oidcDefault",
      rateLimitPerHour: 100,
    }),
    SLUG,
  );
}

/** Make writes to the `license-mint` claim throw; returns the function that heals the store. */
function breakMintStore(): () => void {
  const original = env.SINGLE_USE;
  const ns = original!;
  const real = ns.get.bind(ns);
  (env as { SINGLE_USE: unknown }).SINGLE_USE = {
    ...ns,
    idFromName: ns.idFromName.bind(ns),
    get: (id: unknown) => {
      const stub = real(id as never);
      return {
        fetch: async (url: string, init?: RequestInit) => {
          const body = init?.body
            ? (JSON.parse(String(init.body)) as { key?: string })
            : {};
          if (body.key?.startsWith("license-mint:"))
            throw new Error("store down");
          return stub.fetch(url, init);
        },
      };
    },
  };
  return () => {
    (env as { SINGLE_USE: unknown }).SINGLE_USE = original;
  };
}

const licenseCount = async (accountId: string) =>
  (
    await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM licenses WHERE product = ? AND account_id = ?",
      SLUG,
      accountId,
    )
  )?.n ?? 0;

describe("the card's licence reads (§12.4.1)", () => {
  it("lists the account's own licences with their seat state, and Replace on the full one", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const free = await ownLicense(s.id, "lic_free");
    const full = await ownLicense(s.id, "lic_full", { limit: 1 });
    await activateWithKey(full.key, DEVICE_B);
    void free;
    await unlinked("lic_foreign");
    const res = await cardGet(
      `/api/signin/requests/${handle}/licenses`,
      s,
      binder,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const view = (await res.json()) as {
      state: string;
      keep: boolean;
      choices: {
        id: string;
        state: string;
        replace: unknown;
        access: string;
        seats: { used: number; limit: number };
      }[];
    };
    expect(view.state).toBe("choose");
    expect(view.keep).toBe(false);
    expect(view.choices.map((c) => c.id).sort()).toEqual([
      "lic_free",
      "lic_full",
    ]);
    const row = view.choices.find((c) => c.id === "lic_full")!;
    expect(row.state).toBe("full");
    expect(row.seats).toEqual({ used: 1, limit: 1 });
    expect(row.replace).toEqual({ allowed: true, retryAfter: null });
    expect(view.choices.find((c) => c.id === "lic_free")!.replace).toBeNull();
  });

  it("answers one 404 for an unknown, foreign or non-full licence's devices", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    await ownLicense(s.id, "lic_free");
    const full = await ownLicense(s.id, "lic_full", { limit: 1 });
    await activateWithKey(full.key, DEVICE_B);
    const bob = await signedIn("bob@example.com");
    await ownLicense(bob.id, "lic_bobs", { limit: 1 });
    const get = (id: string) =>
      cardGet(
        `/api/signin/requests/${handle}/licenses/${id}/devices`,
        s,
        binder,
      );
    for (const id of ["lic_nope", "lic_bobs", "lic_free"]) {
      const res = await get(id);
      expect(res.status, id).toBe(404);
      expect(await res.json(), id).toEqual({ error: "not_found" });
    }
    const ok = await get("lic_full");
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as {
      devices: { id: string; leastRecent: boolean }[];
      replace: { allowed: boolean };
    };
    expect(view.devices.map((d) => d.id)).toEqual([DEVICE_B]);
    expect(view.devices[0]!.leastRecent).toBe(true);
    expect(view.replace.allowed).toBe(true);
  });

  it("needs the session and the binder", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    expect(
      (await cardGet(`/api/signin/requests/${handle}/licenses`, s, null))
        .status,
    ).toBe(404);
    expect(
      (
        await cardGet(
          `/api/signin/requests/${handle}/licenses`,
          { cookie: "" },
          binder,
        )
      ).status,
    ).toBe(401);
  });
});

describe("Continue and the choice (card mode)", () => {
  it("refuses a full licence without a device to replace, and a keep or key from a browser", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const full = await ownLicense(s.id, "lic_full", { limit: 1 });
    await activateWithKey(full.key, DEVICE_B);
    for (const choice of [
      { kind: "license", licenseId: "lic_full" },
      { kind: "keep" },
      { kind: "create" },
    ])
      expect((await proceed(handle, s, binder, { choice })).res.status).toBe(
        409,
      );
    expect(
      (await proceed(handle, s, binder, { choice: { kind: "key", key: "x" } }))
        .res.status,
    ).toBe(409);
    expect(
      (
        await proceed(handle, s, binder, {
          choice: {
            kind: "license",
            licenseId: "lic_full",
            replaceDeviceId: "nope",
          },
        })
      ).res.status,
    ).toBe(404);
  });

  it("Replace: Continue records it, token frees the device and takes the seat in one batch", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const full = await ownLicense(s.id, "lic_full", { limit: 1 });
    const old = await activateWithKey(full.key, DEVICE_B);
    const out = await proceed(handle, s, binder, {
      choice: {
        kind: "license",
        licenseId: "lic_full",
        replaceDeviceId: DEVICE_B,
      },
    });
    expect(out.res.status).toBe(200);
    // Nothing is freed at Continue.
    expect((await device(DEVICE_B))?.status).toBe("authorized");
    const res = await tokenReq({ code: codeOf(out.json.redirect!) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { license: { id: string } }).license.id).toBe(
      "lic_full",
    );
    expect((await device(DEVICE_B))?.status).toBe("deauthorized");
    expect((await device(DEVICE))?.status).toBe("authorized");
    // The same audit row as the portal's Remove, naming the device that took the seat.
    const audit = await db.first<{ summary: string }>(
      "SELECT summary FROM portal_audit WHERE action = 'portal.device.disconnect'",
    );
    expect(audit?.summary).toContain(`Disconnected device ${DEVICE_B}`);
    // The replaced device's next call is refused.
    const refresh = await route("POST", `/${SLUG}/license/token`, {
      headers: {
        authorization: `Bearer ${old.token}`,
        "x-pkey-device": DEVICE_B,
      },
    });
    expect(refresh.status).toBe(401);
  });

  it("Replace shares the portal's removal budget", async () => {
    const s = await signedIn();
    const full = await ownLicense(s.id, "lic_full", { limit: 1 });
    await activateWithKey(full.key, DEVICE_B);
    // 20 removals of a device that is not there still spend the budget (charged once ownership is proven).
    for (let i = 0; i < 20; i++) {
      const del = await handlePortalApi(
        new Request(`${BASE}/api/licenses/${SLUG}/lic_full/devices/ghost${i}`, {
          method: "DELETE",
          headers: { cookie: s.cookie, [PORTAL_CSRF_HEADER]: s.csrf },
        }),
        env,
        db,
        `/api/licenses/${SLUG}/lic_full/devices/ghost${i}`,
        NOW,
      );
      expect(del.status).toBe(404);
    }
    const { handle, binder } = await begin();
    const out = await proceed(handle, s, binder, {
      choice: {
        kind: "license",
        licenseId: "lic_full",
        replaceDeviceId: DEVICE_B,
      },
    });
    const res = await tokenReq({ code: codeOf(out.json.redirect!) });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect((await device(DEVICE_B))?.status).toBe("authorized");
  });
});

const device = (id: string) =>
  db.first<{ status: string; license_id: string }>(
    "SELECT status, license_id FROM devices WHERE product = ? AND device_id = ?",
    SLUG,
    id,
  );

describe("the first automatic licence (D4, D5)", () => {
  it("Continue mints one account licence (origin oidc, no sub, no key); token binds the device to it", async () => {
    await setPolicy();
    const { handle, binder } = await begin();
    const s = await signedIn();
    const out = await proceed(handle, s, binder);
    expect(out.res.status).toBe(200);
    const minted = await db.all<{
      id: string;
      sub: string | null;
      origin: string;
      tier_id: string;
    }>(
      "SELECT id, sub, origin, tier_id FROM licenses WHERE product = ? AND account_id = ?",
      SLUG,
      s.id,
    );
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      sub: null,
      origin: "oidc",
      tier_id: "free",
    });
    expect(
      await db.first(
        "SELECT 1 FROM keys_index WHERE product = ? AND license_id = ?",
        SLUG,
        minted[0]!.id,
      ),
    ).toBeNull();
    const res = await tokenReq({ code: codeOf(out.json.redirect!) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { license: { id: string } }).license.id).toBe(
      minted[0]!.id,
    );
    // The view of a licence-less account says autoIssue before the press.
    const again = await begin();
    const view = await cardGet(
      `/api/signin/requests/${again.handle}/licenses`,
      s,
      again.binder,
    );
    expect(view.status).toBe(200);
  });

  it("the view says autoIssue with a New row while the account holds nothing", async () => {
    await setPolicy();
    const { handle, binder } = await begin();
    const s = await signedIn();
    const view = (await (
      await cardGet(`/api/signin/requests/${handle}/licenses`, s, binder)
    ).json()) as {
      state: string;
      create: { tierName: string; access: string } | null;
      choices: unknown[];
    };
    expect(view.state).toBe("autoIssue");
    expect(view.choices).toEqual([]);
    expect(view.create).toEqual({ tierName: "free", access: "account" });
  });

  it("two Continue presses on one account leave exactly one licence; the loser is 409", async () => {
    await setPolicy();
    const a = await begin();
    const b = await begin();
    const s = await signedIn();
    const [ra, rb] = await Promise.all([
      proceed(a.handle, s, a.binder),
      proceed(b.handle, s, b.binder),
    ]);
    const statuses = [ra.res.status, rb.res.status].sort();
    // Whoever lost the claim, or found the winner's licence, was told to choose; never two mints.
    expect(await licenseCount(s.id)).toBe(1);
    expect(statuses[0]).toBe(200);
    if (statuses[1] === 409)
      expect((ra.res.status === 409 ? ra : rb).json.error).toBe(
        "license_choice_required",
      );
  });

  it("a held claim makes a Continue mint nothing and answer 409", async () => {
    await setPolicy();
    const { handle, binder } = await begin();
    const s = await signedIn();
    const held = await withMintClaim(env, { slug: SLUG }, s.id, async () =>
      proceed(handle, s, binder),
    );
    expect(held.won && held.value.res.status).toBe(409);
    expect(await licenseCount(s.id)).toBe(0);
    // The loser consumed nothing: the same request goes through once the claim is released.
    expect((await proceed(handle, s, binder)).res.status).toBe(200);
    expect(await licenseCount(s.id)).toBe(1);
  });

  it("an unreachable claim store mints nothing", async () => {
    await setPolicy();
    const { handle, binder } = await begin();
    const s = await signedIn();
    breakMintStore();
    const out = await proceed(handle, s, binder);
    expect(out.res.status).toBe(503);
    expect(await licenseCount(s.id)).toBe(0);
  });

  it("never mints while a usable licence exists, unless the choice is create and every row is full", async () => {
    await setPolicy();
    const s = await signedIn();
    const lic = await ownLicense(s.id, "lic_a", { limit: 1 });
    await activateWithKey(lic.key, DEVICE_B);
    const before = await licenseCount(s.id);
    // The only licence is full: a plain Continue is refused and mints nothing.
    const first = await begin();
    expect((await proceed(first.handle, s, first.binder)).res.status).toBe(409);
    expect(await licenseCount(s.id)).toBe(before);
    // The explicit create is offered because every row is full.
    const view = (await (
      await cardGet(
        `/api/signin/requests/${first.handle}/licenses`,
        s,
        first.binder,
      )
    ).json()) as { create: unknown; preselected: string | null };
    expect(view.create).not.toBeNull();
    expect(view.preselected).not.toBe("create");
    const out = await proceed(first.handle, s, first.binder, {
      choice: { kind: "create" },
    });
    expect(out.res.status).toBe(200);
    expect(await licenseCount(s.id)).toBe(before + 1);
    // A free licence in the account forbids create.
    const next = await begin();
    expect(
      (
        await proceed(next.handle, s, next.binder, {
          choice: { kind: "create" },
        })
      ).res.status,
    ).toBe(409);
  });
});

describe("stmtsDeauthorizeDevice (Replace's removal)", () => {
  it("leaves a device that was rebound to another licence alone", async () => {
    const s = await signedIn();
    const a = await ownLicense(s.id, "lic_a", { limit: 2 });
    const b = await ownLicense(s.id, "lic_b", { limit: 2 });
    await activateWithKey(a.key, DEVICE_B);
    // The device moves to licence B after the removal was planned against A.
    await activateWithKey(b.key, DEVICE_C);
    await db.run(
      "UPDATE devices SET license_id = 'lic_b', seat_no = 9 WHERE product = ? AND device_id = ?",
      SLUG,
      DEVICE_B,
    );
    await db.run(
      "INSERT INTO device_facts (product, device_id, updated_at) VALUES (?, ?, ?)",
      SLUG,
      DEVICE_B,
      NOW,
    );
    await db.batch(stmtsDeauthorizeDevice(SLUG, DEVICE_B, "lic_a"));
    expect((await device(DEVICE_B))?.status).toBe("authorized");
    expect(
      await db.first(
        "SELECT 1 FROM device_facts WHERE product = ? AND device_id = ?",
        SLUG,
        DEVICE_B,
      ),
    ).not.toBeNull();
    await db.batch(stmtsDeauthorizeDevice(SLUG, DEVICE_B, "lic_b"));
    expect((await device(DEVICE_B))?.status).toBe("deauthorized");
    expect(
      await db.first(
        "SELECT 1 FROM device_facts WHERE product = ? AND device_id = ?",
        SLUG,
        DEVICE_B,
      ),
    ).toBeNull();
  });
});

describe("the pending sign-in grant (app mode, §12.5.1)", () => {
  it("token answers choose with a grant, and choice/complete answers the token response", async () => {
    const s0 = await signedIn();
    await ownLicense(s0.id, "lic_a");
    const { res } = await chooseGrant();
    expect(res.status).toBe(200);
    const pending = (await res.json()) as {
      status: string;
      grant: string;
      expiresIn: number;
      choices: { state: string; choices: { id: string }[] };
    };
    expect(pending.status).toBe("choose");
    expect(pending.grant).toMatch(/^sg_[A-Za-z0-9_-]{43}$/);
    expect(pending.expiresIn).toBe(300);
    expect(pending.choices.choices.map((c) => c.id)).toEqual(["lic_a"]);
    // The device is not bound yet.
    expect(await device(DEVICE)).toBeNull();

    const view = await grantReq("licenses", { grant: pending.grant });
    expect(view.status).toBe(200);
    const done = await grantReq("complete", {
      grant: pending.grant,
      choice: { kind: "license", licenseId: "lic_a" },
    });
    expect(done.status).toBe(200);
    const body = (await done.json()) as Record<string, unknown>;
    // The same members the `token` response carries.
    expect(Object.keys(body).sort()).toEqual(
      [
        "access_token",
        "device",
        "license",
        "schemaVersion",
        "scope",
        "subject",
        "token_type",
      ].sort(),
    );
    expect((body.license as { id: string }).id).toBe("lic_a");
    expect((await device(DEVICE))?.license_id).toBe("lic_a");
    // The grant is spent.
    const again = await grantReq("complete", {
      grant: pending.grant,
      choice: { kind: "license", licenseId: "lic_a" },
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({
      error: { code: "invalid_grant" },
    });
  });

  it("a grant redeemed from another device id is invalid_grant and is not burned", async () => {
    const s0 = await signedIn();
    await ownLicense(s0.id, "lic_a");
    const { res } = await chooseGrant();
    const { grant } = (await res.json()) as { grant: string };
    for (const action of ["licenses", "devices", "complete", "cancel"]) {
      const other = await grantReq(
        action,
        { grant, licenseId: "lic_a", choice: { kind: "keep" } },
        { device: DEVICE_C },
      );
      expect(other.status, action).toBe(400);
      expect(await other.json(), action).toMatchObject({
        error: { code: "invalid_grant" },
      });
    }
    expect((await grantReq("licenses", { grant })).status).toBe(200);
  });

  it("never issues a grant on the device-code channel, and a forged or expired grant is invalid_grant", async () => {
    const s0 = await signedIn();
    await ownLicense(s0.id, "lic_a");
    for (const grant of [`sg_${"A".repeat(43)}`, "sg_short", "", 7, null]) {
      const res = await grantReq("licenses", { grant });
      expect(res.status).toBe(400);
    }
    // Device code: the poll answers the activation shape only; no `grant` member exists there.
    const start = await route("POST", `/${SLUG}/identity/auth/device/start`, {
      headers: { "x-pkey-device": DEVICE },
    });
    expect(JSON.stringify(await start.text())).not.toContain("sg_");
  });

  it("spends 30 reads per grant; the 31st is 429", async () => {
    const s0 = await signedIn();
    await ownLicense(s0.id, "lic_a");
    const { res } = await chooseGrant();
    const { grant } = (await res.json()) as { grant: string };
    for (let i = 0; i < 30; i++)
      expect(
        (await grantReq("licenses", { grant })).status,
        `read ${i + 1}`,
      ).toBe(200);
    expect((await grantReq("licenses", { grant })).status).toBe(429);
  });

  it("choice/devices answers one 404 for an unknown, foreign or non-full licence", async () => {
    const s0 = await signedIn();
    await ownLicense(s0.id, "lic_free");
    const full = await ownLicense(s0.id, "lic_full", { limit: 1 });
    await activateWithKey(full.key, DEVICE_B);
    const bob = await signedIn("bob@example.com");
    await ownLicense(bob.id, "lic_bobs", { limit: 1 });
    const { res } = await chooseGrant();
    const { grant } = (await res.json()) as { grant: string };
    for (const id of ["lic_nope", "lic_bobs", "lic_free"]) {
      const r = await grantReq("devices", { grant, licenseId: id });
      expect(r.status, id).toBe(404);
      expect(await r.json(), id).toEqual({ error: { code: "not_found" } });
    }
    const ok = await grantReq("devices", { grant, licenseId: "lic_full" });
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { devices: { id: string }[] }).devices[0]!.id,
    ).toBe(DEVICE_B);
  });

  it("Replace through the grant frees the device in one batch; a lost seat leaves the grant open", async () => {
    const s0 = await signedIn();
    const full = await ownLicense(s0.id, "lic_full", { limit: 1 });
    const old = await activateWithKey(full.key, DEVICE_B);
    const { res } = await chooseGrant();
    const { grant } = (await res.json()) as { grant: string };
    // Without a replace the full licence is refused, with a fresh view, and the grant stays open.
    const full409 = await grantReq("complete", {
      grant,
      choice: { kind: "license", licenseId: "lic_full" },
    });
    expect(full409.status).toBe(403);
    const refused = (await full409.json()) as {
      error: { code: string };
      view: { choices: unknown[] };
    };
    expect(refused.error.code).toBe("device_limit");
    expect(refused.view.choices).toHaveLength(1);
    expect((await device(DEVICE_B))?.status).toBe("authorized");
    const done = await grantReq("complete", {
      grant,
      choice: {
        kind: "license",
        licenseId: "lic_full",
        replaceDeviceId: DEVICE_B,
      },
    });
    expect(done.status).toBe(200);
    expect((await device(DEVICE_B))?.status).toBe("deauthorized");
    expect((await device(DEVICE))?.license_id).toBe("lic_full");
    const refresh = await route("POST", `/${SLUG}/license/token`, {
      headers: {
        authorization: `Bearer ${old.token}`,
        "x-pkey-device": DEVICE_B,
      },
    });
    expect(refresh.status).toBe(401);
  });

  it("a key entered in the app is one app key entry, atomic with the seat", async () => {
    const { key } = await unlinked("lic_keyed");
    const { res } = await chooseGrant();
    expect(res.status).toBe(200);
    const pending = (await res.json()) as {
      grant: string;
      choices: { state: string; getLicense: { keyEntry: boolean } | null };
    };
    expect(pending.choices.state).toBe("none");
    expect(pending.choices.getLicense?.keyEntry).toBe(true);
    // A wrong key leaves the grant open.
    const wrong = await grantReq("complete", {
      grant: pending.grant,
      choice: { kind: "key", key: "pkey_nope" },
    });
    expect(wrong.status).toBe(401);
    const done = await grantReq("complete", {
      grant: pending.grant,
      choice: { kind: "key", key },
    });
    expect(done.status).toBe(200);
    const body = (await done.json()) as {
      keyEntries: { used: number; limit: number };
      license: { id: string };
      subject: string;
    };
    expect(body.license.id).toBe("lic_keyed");
    expect(body.keyEntries.used).toBe(1);
    const entries = await db.all<{ surface: string }>(
      "SELECT surface FROM license_key_entries WHERE product = ? AND license_id = ?",
      SLUG,
      "lic_keyed",
    );
    expect(entries).toEqual([{ surface: "app" }]);
    // The account is signed in on the device too, and the key still binds it.
    const row = await db.first<{ subject: string; bound_by: string }>(
      "SELECT subject, bound_by FROM devices WHERE product = ? AND device_id = ?",
      SLUG,
      DEVICE,
    );
    expect(row?.subject).toBe(body.subject);
    expect(row?.bound_by).toBe("key");
  });

  it("create with the claim store down answers 503, mints nothing and keeps the grant", async () => {
    await setPolicy();
    const s0 = await signedIn();
    const lic = await ownLicense(s0.id, "lic_a", { limit: 1 });
    await activateWithKey(lic.key, DEVICE_B);
    const before = await licenseCount(s0.id);
    const { res } = await chooseGrant();
    const { grant } = (await res.json()) as { grant: string };
    const heal = breakMintStore();
    const down = await grantReq("complete", {
      grant,
      choice: { kind: "create" },
    });
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: { code: "unavailable" } });
    expect(await licenseCount(s0.id)).toBe(before);
    heal();
    const ok = await grantReq("complete", {
      grant,
      choice: { kind: "create" },
    });
    expect(ok.status).toBe(200);
    expect(await licenseCount(s0.id)).toBe(before + 1);
  });

  it("cancel ends the grant and binds nothing", async () => {
    const s0 = await signedIn();
    await ownLicense(s0.id, "lic_a");
    const { res } = await chooseGrant();
    const { grant } = (await res.json()) as { grant: string };
    const out = await grantReq("cancel", { grant });
    expect(out.status).toBe(204);
    expect(await device(DEVICE)).toBeNull();
    expect((await grantReq("licenses", { grant })).status).toBe(400);
  });

  it("with a first automatic licence in app mode no choice is due: token binds, no grant", async () => {
    await setPolicy();
    const { res } = await chooseGrant();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBeUndefined();
    expect(body.access_token).toBeTruthy();
    expect((body.license as { id: string }).id).toMatch(/^lic_/);
  });
});

describe("token (the I-08 review notes)", () => {
  it("a licence-less device row with a credential is taken over only with its own token", async () => {
    const first = await codeFor();
    const res = await tokenReq({ code: first.code });
    expect(res.status).toBe(200);
    const { access_token } = (await res.json()) as { access_token: string };
    const second = await codeFor();
    const noProof = await tokenReq({ code: second.code });
    expect(noProof.status).toBe(403);
    expect(await noProof.json()).toMatchObject({ error: "not_entitled" });
    const third = await codeFor();
    const proof = await tokenReq(
      { code: third.code },
      { headers: { authorization: `Bearer ${access_token}` } },
    );
    expect(proof.status).toBe(200);
  });
});

describe("discovery and the Identity toggle", () => {
  it("lists the four choice endpoints with Identity on, none with it off", async () => {
    const on = await route("GET", `/${SLUG}/.well-known/polaris.json`);
    const doc = (await on.json()) as {
      services?: { identity?: { endpoints?: Record<string, string> } };
    };
    const ep = doc.services?.identity?.endpoints ?? {};
    expect(ep.choiceLicenses).toBe(`${BASE}/${SLUG}/identity/choice/licenses`);
    for (const k of ["choiceDevices", "choiceComplete", "choiceCancel"])
      expect(ep[k]).toBeTruthy();
    await services({ identity: false });
    const off = await route("GET", `/${SLUG}/.well-known/polaris.json`);
    expect(JSON.stringify(await off.json())).not.toContain("choiceLicenses");
  });

  it("refuses every choice route with Identity off", async () => {
    await services({ identity: false });
    for (const action of ["licenses", "devices", "complete", "cancel"]) {
      const res = await grantReq(action, { grant: `sg_${"A".repeat(43)}` });
      expect(res.status, action).toBe(404);
    }
  });
});
