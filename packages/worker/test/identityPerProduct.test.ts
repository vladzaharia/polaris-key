/**
 * PX-W17: Identity as a per-product service (plans/PX-W17.md §6; PORTAL.md §3.1, G34).
 *
 * One account per person; a product's `identity` toggle gates only sign-in THROUGH it:
 *
 *   - two products see two different pairwise subjects for one account, on every developer
 *     surface (`ownerSubject` on the console's licences, `subject` on its devices);
 *   - every app-sign-in entry refuses a product with Identity off: a person's navigation gets the
 *     `303` to the friendly card, every device and JSON caller keeps `404 not_found`;
 *   - turning Identity off clears every device binding (no seat released, documents unchanged),
 *     after a dry run that counts them;
 *   - Core refuses to write a binding while the toggle is off;
 *   - licences still attach to accounts with Identity off.
 */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { dispatchWith } from "../src/dispatch.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { getDevice, setServices } from "../src/core/repo.js";
import {
  DEFAULT_SERVICES,
  serializeServices,
  type ServicesMap,
} from "../src/core/services.js";
import { loadProduct } from "../src/core/products.js";
import {
  PAIRWISE_SUBJECT_PATTERN,
  setDeviceSubject,
  subjectFor,
} from "../src/core/accounts/accountSubjects.js";
import { registerDeviceBinding } from "../src/core/devices.js";
import {
  IDENTITY_NAVIGATION_ENTRIES,
  IdentityDisabledBindError,
  identityDisabledResponse,
  identityEnabled,
  isNavigation,
} from "../src/core/accounts/identityGate.js";
import {
  applyServiceTransitions,
  MANIFEST_RESYNC_ACTOR,
} from "../src/core/servicesTransitions.js";
import { getTokenRecord } from "../src/platform/kv.js";
import { hashKey } from "../src/platform/crypto.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { attachLicense } from "../src/services/identity/accounts/claim.js";

const ORIGIN = "https://key.plrs.im";

const IDENTITY_ON: ServicesMap = {
  ...DEFAULT_SERVICES,
  identity: { enabled: true },
};
const IDENTITY_OFF: ServicesMap = {
  ...DEFAULT_SERVICES,
  identity: { enabled: false },
};

interface World {
  db: Db;
  env: Env;
  cookie: string;
  csrf: string;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "platform-admins";
  const { token, session } = await issueSession(
    env,
    { sub: "op", name: "Op", email: "op@x.io", groups: ["platform-admins"] },
    NOW,
  );
  return { db, env, cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

async function setIdentity(db: Db, slug: string, on: boolean): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({ services: on ? IDENTITY_ON : IDENTITY_OFF }),
    "manifest",
    NOW,
  );
}

async function admin(
  w: World,
  method: string,
  path: string,
  opts: { query?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: w.cookie,
    [CSRF_HEADER]: w.csrf,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return handleAdmin(
    new Request(`${ORIGIN}/manage${path}${opts.query ?? ""}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }) as unknown as Request,
    w.env,
    w.db,
    path,
    { now: NOW },
  );
}

/** A request through the production router, at the pinned instant. */
function route(
  w: World,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return dispatchWith(
    new Request(`${ORIGIN}${path}`, { method, headers }) as unknown as Request,
    w.env,
    w.db,
    NOW,
  );
}

async function account(db: Db, email: string) {
  const r = await signIn(
    db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return r.account.id;
}

/** A device row bound by sign-in to `subject`, with a KV token record. */
async function boundDevice(
  w: World,
  product: string,
  deviceId: string,
  licenseId: string,
  subject: string,
  boundBy: "signin" | "key",
  seatNo = 1,
): Promise<string> {
  const tokenHash = `th-${deviceId}`;
  await w.db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by, token_hash, seat_no)
     VALUES (?, ?, ?, 'authorized', ?, ?, ?, ?, ?, ?)`,
    product,
    deviceId,
    licenseId,
    NOW,
    NOW,
    subject,
    boundBy,
    tokenHash,
    seatNo,
  );
  return tokenHash;
}

describe("pairwise subjects per product (PX-W17)", () => {
  it("two products see two different ids for one account, and neither is the account id", async () => {
    const w = await world();
    await seedProduct(w.db, "alpha");
    await seedProduct(w.db, "beta");
    // One product with Identity on, one with it off: subjects are platform-wide (Q5).
    await setIdentity(w.db, "alpha", true);
    await setIdentity(w.db, "beta", false);
    const a = await seedLicenseWithKey(w.db, "alpha");
    const b = await seedLicenseWithKey(w.db, "beta");
    const accountId = await account(w.db, "ada@example.com");
    const ctx = { db: w.db, env: w.env, now: NOW, origin: ORIGIN };
    for (const [product, licenseId] of [
      ["alpha", a.licenseId],
      ["beta", b.licenseId],
    ] as const) {
      expect(
        (
          await attachLicense(ctx, {
            accountId,
            product,
            licenseId,
            via: "key",
          })
        ).ok,
      ).toBe(true);
    }

    const alpha = await subjectFor(w.db, accountId, "alpha", NOW);
    const beta = await subjectFor(w.db, accountId, "beta", NOW);
    expect(alpha).toMatch(PAIRWISE_SUBJECT_PATTERN);
    expect(beta).toMatch(PAIRWISE_SUBJECT_PATTERN);
    expect(alpha).not.toBe(beta);
    expect(alpha).not.toBe(accountId);
    expect(beta).not.toBe(accountId);

    // The developer surfaces carry the subject of THEIR product only.
    for (const [product, licenseId, subject] of [
      ["alpha", a.licenseId, alpha],
      ["beta", b.licenseId, beta],
    ] as const) {
      const list = (await (
        await admin(w, "GET", `/api/products/${product}/license/licenses`)
      ).json()) as { licenses: Array<{ id: string; ownerSubject: string }> };
      expect(list.licenses.find((l) => l.id === licenseId)?.ownerSubject).toBe(
        subject,
      );
      const detail = (await (
        await admin(
          w,
          "GET",
          `/api/products/${product}/license/licenses/${licenseId}`,
        )
      ).json()) as { ownerSubject: string };
      expect(detail.ownerSubject).toBe(subject);
    }

    // A device signed in on alpha shows alpha's subject; a key-bound one shows null.
    await boundDevice(w, "alpha", "dev-signed", a.licenseId, alpha, "signin");
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, bound_by)
       VALUES ('alpha', 'dev-key', ?, 'authorized', ?, ?, 'key')`,
      a.licenseId,
      NOW,
      NOW,
    );
    const devices = (await (
      await admin(w, "GET", "/api/products/alpha/devices")
    ).json()) as {
      devices: Array<{ deviceId: string; subject: string | null }>;
    };
    const byId = Object.fromEntries(
      devices.devices.map((d) => [d.deviceId, d.subject]),
    );
    expect(byId).toEqual({ "dev-signed": alpha, "dev-key": null });
    const one = (await (
      await admin(w, "GET", "/api/products/alpha/devices/dev-signed")
    ).json()) as { subject: string };
    expect(one.subject).toBe(alpha);
    const licDevices = (await (
      await admin(
        w,
        "GET",
        `/api/products/alpha/license/licenses/${a.licenseId}/devices`,
      )
    ).json()) as {
      devices: Array<{ deviceId: string; subject: string | null }>;
    };
    expect(
      Object.fromEntries(
        licDevices.devices.map((d) => [d.deviceId, d.subject]),
      ),
    ).toEqual({ "dev-signed": alpha, "dev-key": null });
  });

  it("a floating licence has ownerSubject null", async () => {
    const w = await world();
    await seedProduct(w.db, "alpha");
    const { licenseId } = await seedLicenseWithKey(w.db, "alpha");
    const detail = (await (
      await admin(w, "GET", `/api/products/alpha/license/licenses/${licenseId}`)
    ).json()) as { ownerSubject: unknown };
    expect(detail.ownerSubject).toBeNull();
  });
});

describe("every app-sign-in entry refuses a product with Identity off (PX-W17)", () => {
  const NAVIGATIONS: Array<[string, Record<string, string>]> = [
    ["Sec-Fetch-Mode: navigate", { "sec-fetch-mode": "navigate" }],
    [
      "a browser Accept",
      {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    ],
  ];

  it("a navigation to each entry gets the 303 to the card, with no-store", async () => {
    const w = await world();
    await seedProduct(w.db, "djdl");
    await setIdentity(w.db, "djdl", false);
    expect(IDENTITY_NAVIGATION_ENTRIES).toEqual([
      "authorize",
      "auth/start",
      "auth/device",
      "auth/device/verify",
    ]);
    for (const entry of IDENTITY_NAVIGATION_ENTRIES) {
      for (const method of ["GET", "HEAD"]) {
        for (const [label, headers] of NAVIGATIONS) {
          const res = await route(
            w,
            method,
            `/djdl/identity/${entry}?user_code=ABCD-EFGH`,
            headers,
          );
          expect(`${method} ${entry} (${label}) ${res.status}`).toBe(
            `${method} ${entry} (${label}) 303`,
          );
          expect(res.headers.get("location")).toBe(
            `${ORIGIN}/signin?product=djdl&error=identity_disabled`,
          );
          expect(res.headers.get("cache-control")).toBe("no-store");
        }
      }
    }
  });

  it("the same entries answer 404 not_found to every device and JSON caller", async () => {
    const w = await world();
    await seedProduct(w.db, "djdl");
    await setIdentity(w.db, "djdl", false);
    const notNavigations: Array<[string, string, Record<string, string>]> = [
      ["GET", "no headers", {}],
      ["GET", "Accept: application/json", { accept: "application/json" }],
      ["GET", "Accept: */*", { accept: "*/*" }],
      ["GET", "text/html refused", { accept: "text/html;q=0, */*" }],
      ["GET", "a fetch from a page", { "sec-fetch-mode": "cors" }],
      ["POST", "a navigating POST", { "sec-fetch-mode": "navigate" }],
    ];
    for (const entry of IDENTITY_NAVIGATION_ENTRIES) {
      for (const [method, label, headers] of notNavigations) {
        const res = await route(w, method, `/djdl/identity/${entry}`, headers);
        expect(`${method} ${entry} (${label}) ${res.status}`).toBe(
          `${method} ${entry} (${label}) 404`,
        );
        expect(await res.json()).toEqual({ error: { code: "not_found" } });
      }
    }
    // Every other Identity route, navigation or not: the registry's 404.
    for (const path of [
      "/djdl/identity/auth/device/start",
      "/djdl/identity/auth/device/poll",
      "/djdl/identity/session",
      "/djdl/identity/subject",
    ]) {
      const res = await route(w, "GET", path, { "sec-fetch-mode": "navigate" });
      expect(`${path} ${res.status}`).toBe(`${path} 404`);
    }
    const start = await route(w, "POST", "/djdl/identity/auth/device/start", {
      "content-type": "application/json",
    });
    expect(start.status).toBe(404);
    // Keyless registration keeps its one body: the JSON API never says "Identity is off".
    const register = await route(w, "POST", "/djdl/devices/register", {
      "x-pkey-device": "dev-1",
      "x-pkey-version": "1.0.0",
    });
    expect(register.status).toBe(403);
    expect(await register.json()).toEqual({
      error: { code: "registration_closed" },
    });
  });

  it("an Identity product, or an unknown product, is never redirected", async () => {
    const w = await world();
    await seedProduct(w.db, "djdl");
    await setIdentity(w.db, "djdl", true);
    const page = await route(w, "GET", "/djdl/identity/auth/device", {
      "sec-fetch-mode": "navigate",
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const unknown = await route(w, "GET", "/nope/identity/auth/device", {
      "sec-fetch-mode": "navigate",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("location")).toBeNull();
  });

  it("the portal passthrough context's refusal is 403 identity_disabled, nested", async () => {
    const res = identityDisabledResponse();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "identity_disabled" },
    });
  });

  it("navigation sniffing never matches an SDK", () => {
    const req = (method: string, headers: Record<string, string>) =>
      new Request(`${ORIGIN}/x`, { method, headers }) as unknown as Request;
    expect(isNavigation(req("GET", {}))).toBe(false);
    expect(isNavigation(req("GET", { accept: "application/json" }))).toBe(
      false,
    );
    expect(isNavigation(req("GET", { accept: "*/*" }))).toBe(false);
    expect(isNavigation(req("GET", { accept: "text/html;q=0" }))).toBe(false);
    expect(isNavigation(req("GET", { accept: "TEXT/HTML; q=0.5" }))).toBe(true);
    expect(isNavigation(req("HEAD", { "sec-fetch-mode": "navigate" }))).toBe(
      true,
    );
    expect(isNavigation(req("POST", { accept: "text/html" }))).toBe(false);
  });
});

describe("turning Identity off clears every binding (PX-W17)", () => {
  async function boundWorld() {
    const w = await world();
    await seedProduct(w.db, "djdl");
    await seedProduct(w.db, "other");
    await setIdentity(w.db, "djdl", true);
    await setIdentity(w.db, "other", true);
    const { key, licenseId } = await seedLicenseWithKey(w.db, "djdl");
    const other = await seedLicenseWithKey(w.db, "other");
    const accountId = await account(w.db, "ada@example.com");
    const subject = await subjectFor(w.db, accountId, "djdl", NOW);
    const otherSubject = await subjectFor(w.db, accountId, "other", NOW);
    // A key-activated device that later signed in…
    const activated = (await (
      await route(w, "POST", "/djdl/license/activate", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-key",
        "x-pkey-version": "1.0.0",
      })
    ).json()) as { token: string };
    expect(
      await setDeviceSubject(w.env, w.db, "djdl", "dev-key", subject),
    ).toBe(true);
    // …a device the sign-in itself bound (a sign-out would release this one)…
    await boundDevice(w, "djdl", "dev-signin", licenseId, subject, "signin", 2);
    // …and a signed-in device of another product, which must not move.
    await boundDevice(
      w,
      "other",
      "dev-other",
      other.licenseId,
      otherSubject,
      "signin",
    );
    const tokenHash = await hashKey(activated.token, w.env.KEY_HASH_PEPPER);
    await w.db.run(
      `INSERT INTO account_product_grants (account_id, product, claims_json, granted_at, modified_at)
       VALUES (?, 'djdl', NULL, ?, ?)`,
      accountId,
      NOW,
      NOW,
    );
    return { w, licenseId, subject, tokenHash, token: activated.token };
  }

  it("the dry run counts the signed-in devices and writes nothing", async () => {
    const { w } = await boundWorld();
    const res = await admin(w, "PATCH", "/api/products/djdl/services", {
      query: "?dryRun=1",
      body: { services: { identity: { enabled: false } } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changes: [{ field: "services.identity.enabled", from: true, to: false }],
      signedInDevicesToClear: 2,
    });
    expect(await identityEnabled(w.db, "djdl")).toBe(true);
    expect((await getDevice(w.db, "djdl", "dev-key"))?.subject).toMatch(
      PAIRWISE_SUBJECT_PATTERN,
    );
    // Keeping Identity on clears nothing.
    const keep = await admin(w, "PATCH", "/api/products/djdl/services", {
      query: "?dryRun=1",
      body: { services: { config: { enabled: false } } },
    });
    expect(await keep.json()).toEqual({
      changes: [{ field: "services.config.enabled", from: true, to: false }],
      signedInDevicesToClear: 0,
    });
  });

  it("the console PATCH clears every binding of the product, releases no seat and keeps documents byte-identical", async () => {
    const { w, tokenHash, token } = await boundWorld();
    const docBefore = await (
      await route(w, "GET", "/djdl/license/document", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": "dev-key",
        "x-pkey-version": "1.0.0",
      })
    ).text();
    expect(docBefore.split(".")).toHaveLength(3);

    const res = await admin(w, "PATCH", "/api/products/djdl/services", {
      body: { services: { identity: { enabled: false } } },
    });
    expect(res.status).toBe(200);
    expect(await identityEnabled(w.db, "djdl")).toBe(false);

    for (const id of ["dev-key", "dev-signin"]) {
      const d = await getDevice(w.db, "djdl", id);
      expect(`${id} ${d?.subject ?? null}`).toBe(`${id} null`);
      // No seat released: still authorized, still holding its seat and licence.
      expect(`${id} ${d?.status}`).toBe(`${id} authorized`);
      expect(d?.seat_no).not.toBeNull();
    }
    expect((await getTokenRecord(w.env, "djdl", tokenHash))?.subject).toBe(
      undefined,
    );
    expect(await getTokenRecord(w.env, "djdl", tokenHash)).not.toBeNull();
    // Another product's binding is untouched.
    expect((await getDevice(w.db, "other", "dev-other"))?.subject).toMatch(
      PAIRWISE_SUBJECT_PATTERN,
    );
    // The audit row names the count.
    const audit = await w.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE product = 'djdl' AND action = 'services.identity_disabled'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain("signed out 2 devices");
    // Consent grants are kept, so turning Identity back on asks nobody again.
    expect(
      await w.db.all(
        "SELECT product FROM account_product_grants WHERE product = 'djdl'",
      ),
    ).toEqual([{ product: "djdl" }]);
    // The device's licence document is byte-identical (legacy entitlement model).
    const docAfter = await (
      await route(w, "GET", "/djdl/license/document", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": "dev-key",
        "x-pkey-version": "1.0.0",
      })
    ).text();
    expect(docAfter).toBe(docBefore);
  });

  it("the transition is idempotent and heals a straggler on every write, without a second audit row", async () => {
    const { w } = await boundWorld();
    await setIdentity(w.db, "djdl", false);
    const first = await applyServiceTransitions(
      w.env,
      w.db,
      "djdl",
      IDENTITY_OFF,
      MANIFEST_RESYNC_ACTOR,
      NOW,
    );
    expect(first).toEqual({ signedInDevicesCleared: 2 });
    const again = await applyServiceTransitions(
      w.env,
      w.db,
      "djdl",
      IDENTITY_OFF,
      MANIFEST_RESYNC_ACTOR,
      NOW,
    );
    expect(again).toEqual({ signedInDevicesCleared: 0 });
    const rows = await w.db.all<{ actor_name: string }>(
      "SELECT actor_name FROM audit WHERE action = 'services.identity_disabled'",
    );
    expect(rows).toEqual([{ actor_name: "Manifest resync" }]);
    // Identity on: nothing is cleared.
    expect(
      await applyServiceTransitions(
        w.env,
        w.db,
        "other",
        IDENTITY_ON,
        MANIFEST_RESYNC_ACTOR,
        NOW,
      ),
    ).toEqual({ signedInDevicesCleared: 0 });
  });

  it("revert runs the transition too", async () => {
    const { w } = await boundWorld();
    await setIdentity(w.db, "djdl", false);
    const res = await admin(w, "POST", "/api/products/djdl/services/revert");
    expect(res.status).toBe(200);
    expect((await getDevice(w.db, "djdl", "dev-signin"))?.subject ?? null).toBe(
      null,
    );
  });
});

describe("the bind guard (PX-W17)", () => {
  it("Core refuses to write a binding while Identity is off, and writes no row", async () => {
    const w = await world();
    await seedProduct(w.db, "djdl");
    await setIdentity(w.db, "djdl", false);
    const { key } = await seedLicenseWithKey(w.db, "djdl");
    const accountId = await account(w.db, "ada@example.com");
    const subject = await subjectFor(w.db, accountId, "djdl", NOW);
    const activated = await route(w, "POST", "/djdl/license/activate", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": "dev-key",
      "x-pkey-version": "1.0.0",
    });
    expect(activated.status).toBe(200);
    await expect(
      setDeviceSubject(w.env, w.db, "djdl", "dev-key", subject),
    ).rejects.toBeInstanceOf(IdentityDisabledBindError);
    expect((await getDevice(w.db, "djdl", "dev-key"))?.subject ?? null).toBe(
      null,
    );

    const product = (await loadProduct(w.env, w.db, "djdl"))!;
    await expect(
      registerDeviceBinding(w.env, w.db, product, "dev-new", NOW, {
        existing: null,
        presented: null,
        metadata: {
          userAgent: null,
          platform: null,
          arch: null,
          appVersion: null,
          sdkName: null,
          sdkVersion: null,
        },
        boundBy: "signin",
        subject,
      }),
    ).rejects.toBeInstanceOf(IdentityDisabledBindError);
    expect(await getDevice(w.db, "djdl", "dev-new")).toBeNull();

    // With Identity on, the same calls bind.
    await setIdentity(w.db, "djdl", true);
    expect(
      await setDeviceSubject(w.env, w.db, "djdl", "dev-key", subject),
    ).toBe(true);
  });
});

describe("licences attach to accounts with Identity off (PX-W17)", () => {
  it("attach by key works and the licence still activates", async () => {
    const w = await world();
    await seedProduct(w.db, "djdl");
    await setIdentity(w.db, "djdl", false);
    const { key, licenseId } = await seedLicenseWithKey(w.db, "djdl");
    const accountId = await account(w.db, "ada@example.com");
    const attached = await attachLicense(
      { db: w.db, env: w.env, now: NOW, origin: ORIGIN },
      { accountId, product: "djdl", licenseId, via: "key" },
    );
    expect(attached.ok).toBe(true);
    const row = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM licenses WHERE product = 'djdl' AND id = ?",
      licenseId,
    );
    expect(row?.account_id).toBe(accountId);
    const res = await route(w, "POST", "/djdl/license/activate", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": "dev-1",
      "x-pkey-version": "1.0.0",
    });
    expect(res.status).toBe(200);
    expect((await getDevice(w.db, "djdl", "dev-1"))?.subject ?? null).toBe(
      null,
    );
  });
});
