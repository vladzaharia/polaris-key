// I-09 (WIRE-CONTRACT-V4 §12.2 step 3, §12.3, §12.6; plans/I-09.md §2 and §7): the account on the
// device wire. Each security property of plan §7 has a positive case and a negative control:
//
//   - account takeover via attach: the holder is the account signed in on the device, never one
//     the request names and never the licence's owner; an owned licence never moves;
//   - enumeration: `license_owned` only after a valid key, carrying no account detail and no key;
//   - the race: two accounts, one compare-and-set, one owner;
//   - sign-out releases only a sign-in-bound seat of the signing-out account, on this device;
//   - a stolen device token reaches only its own device's licence;
//   - nothing a device verifies changes: the licence document is the same before and after.

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { serializeServices, SERVICE_SLUGS } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { invalidatePlatformSettings } from "../src/core/platformSettings.js";
import { countKeyEntries } from "../src/core/keyEntries.js";
import { setDeviceSubject, subjectFor } from "../src/core/accountSubjects.js";
import {
  bindSignedInDevice,
  compareCandidates,
  licenseAccess,
  rankAnchorCandidates,
} from "../src/core/anchor.js";
import { enrollFate } from "../src/services/license/enroll.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { getLicense } from "../src/core/data.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { LicenseRow } from "../src/core/data.js";

const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const DEV_A = "I09DEVICEA0000000000000000000001";
const DEV_B = "I09DEVICEB0000000000000000000002";
const DEV_C = "I09DEVICEC0000000000000000000003";

let db: SqliteDb;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  await seedProduct(db, SLUG);
});

async function setIdentity(
  on: boolean,
  registration?: "open" | "requires-license",
): Promise<Product> {
  const enabled = on
    ? ["license", "config", "identity"]
    : ["license", "config"];
  const services = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, { enabled: enabled.includes(s) }]),
  );
  await setServices(
    db,
    SLUG,
    serializeServices(
      (registration ? { services, registration } : { services }) as Parameters<
        typeof serializeServices
      >[0],
    ),
    "manifest",
    NOW,
  );
  return (await loadProduct(env, db, SLUG))!;
}

async function setRefusals(on: boolean): Promise<void> {
  await db.run(
    `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
     VALUES ('KEYENTRY_REFUSALS', ?, 1, ?, 'test')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    JSON.stringify(on ? "on" : "off"),
    NOW,
  );
  invalidatePlatformSettings(env, db);
}

/** A request through the production router. */
function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
  now = NOW,
): Promise<Response> {
  return dispatchWith(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    env,
    db,
    now,
  );
}

async function activate(
  key: string,
  device: string,
  now = NOW,
): Promise<Response> {
  return call(
    "POST",
    `/${SLUG}/license/activate`,
    { authorization: `Bearer ${key}`, "x-pkey-device": device },
    undefined,
    now,
  );
}

async function tokenOf(key: string, device: string): Promise<string> {
  const res = await activate(key, device);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function attach(
  token: string,
  device: string,
  body: unknown = { confirm: true },
): Promise<Response> {
  return call(
    "POST",
    `/${SLUG}/identity/attach`,
    { authorization: `Bearer ${token}`, "x-pkey-device": device },
    body,
  );
}

function subjectOf(token: string, device: string): Promise<Response> {
  return call("GET", `/${SLUG}/identity/subject`, {
    authorization: `Bearer ${token}`,
    "x-pkey-device": device,
  });
}

function signOut(token: string, device: string): Promise<Response> {
  return call("POST", `/${SLUG}/identity/signout`, {
    authorization: `Bearer ${token}`,
    "x-pkey-device": device,
  });
}

/** An active account with `email` verified, and its pairwise subject for the product. */
async function account(
  email: string,
): Promise<{ id: string; subject: string }> {
  const acct = await getOrCreateAccountByEmail(db, email, NOW);
  await db.run(
    "UPDATE accounts SET primary_email = ?, primary_email_verified_at = ? WHERE id = ?",
    email,
    NOW,
    acct.id,
  );
  return { id: acct.id, subject: await subjectFor(db, acct.id, SLUG, NOW) };
}

/** A completed sign-in's binding, as I-08's sign-in writes it (seeded until I-08 lands). */
async function signIn(device: string, subject: string): Promise<void> {
  expect(await setDeviceSubject(env, db, SLUG, device, subject)).toBe(true);
}

async function ownerOf(licenseId: string): Promise<string | null> {
  return (
    (
      await db.first<{ account_id: string | null }>(
        "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
        SLUG,
        licenseId,
      )
    )?.account_id ?? null
  );
}

async function licenseDocument(
  token: string,
  now = NOW + 600,
): Promise<string> {
  const res = await call(
    "GET",
    `/${SLUG}/license/document`,
    {
      authorization: `Bearer ${token}`,
      "x-pkey-version": "1.2.3",
    },
    undefined,
    now,
  );
  expect(res.status).toBe(200);
  return res.text();
}

// ── §12.2 step 3: an owned licence never moves by key ─────────────────────────────────────

describe("key entry step 3: license_owned (§12.2)", () => {
  async function owned() {
    await setIdentity(true);
    await setRefusals(true);
    const seeded = await seedLicenseWithKey(db, SLUG);
    const holder = await account("holder@example.com");
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      holder.id,
      SLUG,
      seeded.licenseId,
    );
    return { ...seeded, holder };
  }

  it("refuses a new device with signInUrl, counting nothing and writing no device", async () => {
    const { key, licenseId, holder } = await owned();
    const res = await activate(key, DEV_A);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: "license_owned",
      message: "license is in an account",
      signInUrl: `${BASE}/signin?product=${SLUG}`,
    });
    // No key, no account detail: neither the account id, its subject nor its email.
    const text = JSON.stringify(body);
    for (const leak of [key, holder.id, holder.subject, "holder@example.com"])
      expect(text).not.toContain(leak);
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(0);
    expect(
      await db.first(
        "SELECT 1 FROM devices WHERE product = ? AND device_id = ?",
        SLUG,
        DEV_A,
      ),
    ).toBeNull();
    const logged = await db.all<{ reason: string }>(
      "SELECT reason FROM license_refusals WHERE product = ? AND license_id = ?",
      SLUG,
      licenseId,
    );
    expect(logged.map((r) => r.reason)).toEqual(["license_owned"]);
  });

  it("uses the console origin for the link when one is configured", async () => {
    const { key } = await owned();
    env.CONSOLE_ORIGIN = "https://console.example.com";
    const res = await activate(key, DEV_A);
    expect(((await res.json()) as { signInUrl: string }).signInUrl).toBe(
      `https://console.example.com/signin?product=${SLUG}`,
    );
  });

  it("re-entry on an enrolled device still succeeds (step 2 first)", async () => {
    await setIdentity(true);
    await setRefusals(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    expect((await activate(key, DEV_A)).status).toBe(200);
    const holder = await account("holder@example.com");
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      holder.id,
      SLUG,
      licenseId,
    );
    expect((await activate(key, DEV_A, NOW + 60)).status).toBe(200);
    expect((await activate(key, DEV_B, NOW + 60)).status).toBe(403);
  });

  it("with refusals off the entry is admitted and counted", async () => {
    const { key, licenseId } = await owned();
    await setRefusals(false);
    const res = await activate(key, DEV_A);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { keyEntries: unknown }).keyEntries).toEqual({
      used: 1,
      limit: 10,
    });
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(1);
  });

  it("with Identity off an owned licence's key still activates a new device, uncounted", async () => {
    const { key, licenseId } = await owned();
    await setIdentity(false);
    const res = await activate(key, DEV_A);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("keyEntries");
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(0);
  });

  it("is no oracle: an unknown key and an unusable owned licence keep their 401", async () => {
    const { key, licenseId } = await owned();
    expect(
      (await activate("pkey_djdl_notakey000000000000", DEV_A)).status,
    ).toBe(401);
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    const res = await activate(key, DEV_A);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unauthorized",
    );
  });

  it("refuses the browser key session the same way", async () => {
    const { key, licenseId } = await owned();
    const res = await call(
      "POST",
      `/${SLUG}/identity/session/license`,
      {},
      { key },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "license_owned",
      signInUrl: `${BASE}/signin?product=${SLUG}`,
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(0);
  });
});

// ── §12.3 attach ─────────────────────────────────────────────────────────────────────────

describe("attach (§12.3)", () => {
  /** Identity on; a licence with the buyer email ada@example.com, activated by key on DEV_A. */
  async function keyed() {
    await setIdentity(true);
    const seeded = await seedLicenseWithKey(db, SLUG);
    const token = await tokenOf(seeded.key, DEV_A);
    return { ...seeded, token };
  }

  it("answers 401 without the device's own credential", async () => {
    const { token } = await keyed();
    expect((await attach("pkeyt_" + "x".repeat(43), DEV_A)).status).toBe(401);
    // A real token presented for another device id is not that device's.
    expect((await attach(token, DEV_B)).status).toBe(401);
    const missing = await call(
      "POST",
      `/${SLUG}/identity/attach`,
      { authorization: `Bearer ${token}` },
      { confirm: true },
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: { code: "bad_request" } });
  });

  it("needs a boolean confirm", async () => {
    const { token } = await keyed();
    for (const body of [{}, { confirm: "yes" }, { confirm: 1 }, []])
      expect(
        (await attach(token, DEV_A, body)).status,
        JSON.stringify(body),
      ).toBe(400);
  });

  it("answers account_required while no account is signed in on the device, whatever the request names", async () => {
    const { token, licenseId } = await keyed();
    const other = await account("ada@example.com");
    // Negative control: the request cannot nominate a holder.
    const res = await attach(token, DEV_A, {
      confirm: true,
      accountId: other.id,
      subject: other.subject,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "account_required" } });
    expect(await ownerOf(licenseId)).toBeNull();
  });

  it("previews without writing, then attaches to the signed-in account, rotating the token and auditing", async () => {
    const { token, licenseId } = await keyed();
    const ada = await account("ada@example.com");
    await signIn(DEV_A, ada.subject);

    const preview = await attach(token, DEV_A, { confirm: false });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(await preview.json()).toEqual({
      status: "confirm",
      license: { id: licenseId, tierId: null, name: "Ada Lovelace" },
    });
    expect(await ownerOf(licenseId)).toBeNull();

    const before = await licenseDocument(token);
    const res = await attach(token, DEV_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      subject: ada.subject,
      attached: "claimed",
      license: { id: licenseId },
      device: { id: DEV_A, licenseId },
    });
    expect(await ownerOf(licenseId)).toBe(ada.id);
    // The token rotated: the old one is dead, the new one works, and the document did not move.
    const fresh = body.token as string;
    expect(fresh).not.toBe(token);
    expect((await subjectOf(token, DEV_A)).status).toBe(401);
    expect(await licenseDocument(fresh)).toBe(before);
    // Attach never re-anchors the device.
    const device = await db.first<{ license_id: string; bound_by: string }>(
      "SELECT license_id, bound_by FROM devices WHERE product = ? AND device_id = ?",
      SLUG,
      DEV_A,
    );
    expect(device).toEqual({ license_id: licenseId, bound_by: "key" });
    // The licence's history names the subject and the device, never the account id.
    const audit = await db.all<{ actor_sub: string; summary: string }>(
      "SELECT actor_sub, summary FROM audit WHERE product = ? AND action = 'license.attach' AND target_id = ?",
      SLUG,
      licenseId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_sub).toBe(ada.subject);
    expect(audit[0]!.summary).toContain(DEV_A);
    expect(audit[0]!.summary).not.toContain(ada.id);

    // Idempotent: again, no `attached`, nothing new in the history.
    const again = await attach(fresh, DEV_A);
    expect(again.status).toBe(200);
    expect(await again.json()).not.toHaveProperty("attached");
    expect(
      (
        await db.all(
          "SELECT 1 FROM audit WHERE product = ? AND action = 'license.attach'",
          SLUG,
        )
      ).length,
    ).toBe(1);
  });

  it("never moves an owned licence: another account's licence is license_owned, with no link and no detail", async () => {
    const { token, licenseId } = await keyed();
    const victim = await account("ada@example.com");
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      victim.id,
      SLUG,
      licenseId,
    );
    const attacker = await account("mallory@example.com");
    await signIn(DEV_A, attacker.subject);
    for (const confirm of [false, true]) {
      const res = await attach(token, DEV_A, { confirm });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "license_owned" } });
    }
    expect(await ownerOf(licenseId)).toBe(victim.id);
  });

  it("holds an email-bound licence for the verified address unless claimByKey is set", async () => {
    const { token, licenseId } = await keyed();
    const other = await account("someone@example.com");
    await signIn(DEV_A, other.subject);
    const res = await attach(token, DEV_A);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "license_email_bound" },
    });
    // No address in the answer, not even masked.
    expect(text).not.toContain("ada@");
    expect(await ownerOf(licenseId)).toBeNull();
    // The developer opted in to claim by key: the same attach goes through.
    await db.run(
      `INSERT INTO portal_product_settings (product, claim_by_key, created_at, modified_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(product) DO UPDATE SET claim_by_key = 1`,
      SLUG,
      NOW,
      NOW,
    );
    expect((await attach(token, DEV_A)).status).toBe(200);
    expect(await ownerOf(licenseId)).toBe(other.id);
  });

  it("first claim wins: two accounts racing get one owner and one license_owned", async () => {
    await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      "UPDATE licenses SET email = NULL WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    const tA = await tokenOf(key, DEV_A);
    const tB = await tokenOf(key, DEV_B);
    const a = await account("a@example.com");
    const b = await account("b@example.com");
    await signIn(DEV_A, a.subject);
    await signIn(DEV_B, b.subject);
    const [ra, rb] = await Promise.all([attach(tA, DEV_A), attach(tB, DEV_B)]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 403]);
    const loser = ra.status === 403 ? ra : rb;
    expect(await loser.json()).toEqual({ error: { code: "license_owned" } });
    const winner = ra.status === 200 ? a : b;
    expect(await ownerOf(licenseId)).toBe(winner.id);
    expect(
      (
        await db.all(
          "SELECT 1 FROM audit WHERE product = ? AND action = 'license.attach'",
          SLUG,
        )
      ).length,
    ).toBe(1);
  });

  it("a stolen device token reaches only that device's licence", async () => {
    await setIdentity(true);
    const first = await seedLicenseWithKey(db, SLUG, { id: "lic_one" });
    const second = await seedLicenseWithKey(db, SLUG, { id: "lic_two" });
    for (const id of ["lic_one", "lic_two"])
      await db.run(
        "UPDATE licenses SET email = NULL WHERE product = ? AND id = ?",
        SLUG,
        id,
      );
    const token = await tokenOf(first.key, DEV_A);
    await tokenOf(second.key, DEV_B);
    const thief = await account("thief@example.com");
    await signIn(DEV_A, thief.subject);
    // The body cannot name another licence or device: the attach takes the device's own.
    const res = await attach(token, DEV_A, {
      confirm: true,
      licenseId: second.licenseId,
      deviceId: DEV_B,
    });
    expect(res.status).toBe(200);
    expect(await ownerOf(first.licenseId)).toBe(thief.id);
    expect(await ownerOf(second.licenseId)).toBeNull();
  });

  it("answers not_found for a device with no licence, and 401 for an unusable one", async () => {
    await setIdentity(true, "open");
    const reg = await call("POST", `/${SLUG}/devices/register`, {
      "x-pkey-device": DEV_C,
    });
    expect(reg.status).toBe(200);
    const keyless = ((await reg.json()) as { token: string }).token;
    const someone = await account("someone@example.com");
    await signIn(DEV_C, someone.subject);
    const res = await attach(keyless, DEV_C);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });

    const { token, licenseId } = await (async () => {
      const s = await seedLicenseWithKey(db, SLUG);
      return { ...s, token: await tokenOf(s.key, DEV_A) };
    })();
    await signIn(DEV_A, someone.subject);
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    expect((await attach(token, DEV_A)).status).toBe(401);
  });

  it("does not exist while Identity is off", async () => {
    const { token } = await keyed();
    await setIdentity(false);
    for (const res of [
      await attach(token, DEV_A),
      await subjectOf(token, DEV_A),
      await signOut(token, DEV_A),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found" } });
    }
  });

  it("answers a listed web origin without credentials (no ambient auth)", async () => {
    const { token } = await keyed();
    await db.run(
      "UPDATE products SET web_origins_json = ? WHERE slug = ?",
      JSON.stringify(["https://app.example.com"]),
      SLUG,
    );
    const res = await call("GET", `/${SLUG}/identity/subject`, {
      authorization: `Bearer ${token}`,
      "x-pkey-device": DEV_A,
      origin: "https://app.example.com",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    // A cookie is never a credential here: no bearer, no answer.
    const cookieOnly = await call("GET", `/${SLUG}/identity/subject`, {
      cookie: "__Host-pkey_portal=whatever",
      "x-pkey-device": DEV_A,
    });
    expect(cookieOnly.status).toBe(401);
  });
});

// ── §12.3 subject and sign-out ────────────────────────────────────────────────────────────

describe("subject and sign-out (§12.3)", () => {
  it("subject answers the binding, then null after sign-out; a key-bound seat is kept", async () => {
    await setIdentity(true);
    const { key } = await seedLicenseWithKey(db, SLUG);
    const token = await tokenOf(key, DEV_A);
    expect(await (await subjectOf(token, DEV_A)).json()).toEqual({
      subject: null,
    });
    const before = await licenseDocument(token);
    // A counted key entry by another device changes nothing this device verifies.
    expect((await activate(key, DEV_B)).status).toBe(200);
    expect(await licenseDocument(token)).toBe(before);
    const ada = await account("ada@example.com");
    await signIn(DEV_A, ada.subject);
    expect(await (await subjectOf(token, DEV_A)).json()).toEqual({
      subject: ada.subject,
    });
    // Nor does the sign-in binding.
    expect(await licenseDocument(token)).toBe(before);
    const out = await signOut(token, DEV_A);
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ released: false });
    // Key-bound: the device keeps its licence and its token.
    expect(await (await subjectOf(token, DEV_A)).json()).toEqual({
      subject: null,
    });
    expect(await licenseDocument(token)).toBe(before);
  });

  it("releases a sign-in-bound seat of the signing-out account, and only on this device", async () => {
    await setIdentity(true);
    const ada = await account("ada@example.com");
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      ada.id,
      SLUG,
      licenseId,
    );
    const product = (await loadProduct(env, db, SLUG))!;
    const license = (await getLicense(db, SLUG, licenseId))!;
    const bind = async (device: string) => {
      const r = await bindSignedInDevice(env, db, product, {
        accountId: ada.id,
        subject: ada.subject,
        deviceId: device,
        choice: { kind: "license", licenseId: license.id },
        now: NOW,
      });
      if (!r.ok || !r.token) throw new Error(JSON.stringify(r));
      return r.token;
    };
    const tA = await bind(DEV_A);
    const tB = await bind(DEV_B);
    const out = await signOut(tA, DEV_A);
    expect(await out.json()).toEqual({ released: true });
    // This device is released: its token stops working.
    expect((await subjectOf(tA, DEV_A)).status).toBe(401);
    // Negative control: the account's other device keeps its seat and its binding.
    expect(await (await subjectOf(tB, DEV_B)).json()).toEqual({
      subject: ada.subject,
    });
  });

  it("does not release a sign-in-bound device whose licence is another account's", async () => {
    await setIdentity(true);
    const ada = await account("ada@example.com");
    const bob = await account("bob@example.com");
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      ada.id,
      SLUG,
      licenseId,
    );
    const product = (await loadProduct(env, db, SLUG))!;
    const r = await bindSignedInDevice(env, db, product, {
      accountId: ada.id,
      subject: ada.subject,
      deviceId: DEV_A,
      choice: { kind: "license", licenseId },
      now: NOW,
    });
    if (!r.ok || !r.token) throw new Error("bind");
    // Bob signs in on the device afterwards (a keep): the seat is Ada's licence.
    await signIn(DEV_A, bob.subject);
    expect(await (await signOut(r.token, DEV_A)).json()).toEqual({
      released: false,
    });
    expect((await subjectOf(r.token, DEV_A)).status).toBe(200);
  });
});

// ── The sign-in licence choice (core/anchor.ts) ───────────────────────────────────────────

describe("rankAnchorCandidates and bindSignedInDevice", () => {
  async function accountLicence(
    accountId: string,
    id: string,
    opts: {
      expiresAt?: number | null;
      activatedAt?: number;
      limit?: number;
    } = {},
  ): Promise<void> {
    await seedLicenseWithKey(db, SLUG, {
      id,
      expiresAt: opts.expiresAt ?? null,
      ...(opts.limit !== undefined
        ? {
            entitlements: {
              deviceLimit: {
                state: "enforced" as const,
                value: opts.limit,
                updatedAt: NOW,
              },
            },
          }
        : {}),
    });
    await db.run(
      "UPDATE licenses SET account_id = ?, activated_at = ? WHERE product = ? AND id = ?",
      accountId,
      opts.activatedAt ?? NOW,
      SLUG,
      id,
    );
  }

  it("orders rank-first and lists a full licence as full, never hiding it", async () => {
    const product = await setIdentity(true);
    const ada = await account("ada@example.com");
    await accountLicence(ada.id, "lic_exp_late", { expiresAt: NOW + 900 });
    await accountLicence(ada.id, "lic_exp_soon", { expiresAt: NOW + 100 });
    await accountLicence(ada.id, "lic_forever_new", { activatedAt: NOW });
    await accountLicence(ada.id, "lic_forever_old", {
      activatedAt: NOW - 100,
      limit: 1,
    });
    // Fill the oldest perpetual one.
    await seedLicenseWithKey(db, SLUG, { id: "lic_unused" });
    const full = await getLicense(db, SLUG, "lic_forever_old");
    const r = await bindSignedInDevice(env, db, product, {
      accountId: ada.id,
      subject: ada.subject,
      deviceId: DEV_B,
      choice: { kind: "license", licenseId: full!.id },
      now: NOW,
    });
    expect(r.ok).toBe(true);
    const ranked = await rankAnchorCandidates(db, product, ada.id, NOW, {
      deviceId: DEV_A,
    });
    expect(ranked.candidates.map((c) => c.licenseId)).toEqual([
      "lic_forever_old",
      "lic_forever_new",
      "lic_exp_late",
      "lic_exp_soon",
    ]);
    expect(ranked.candidates[0]).toMatchObject({
      state: "full",
      seats: { used: 1, limit: 1 },
      current: false,
    });
    // A higher rank that is full is never preselected; the first free one is.
    expect(ranked.preselected).toBe("lic_forever_new");
    expect(ranked.keep).toBe(false);
    expect(ranked.create).toBe(false);
    // The ranking is the one the legacy chooser and the consent line use.
    expect(
      compareCandidates(
        { id: "a", expiresAt: null, activatedAt: 2 },
        { id: "b", expiresAt: null, activatedAt: 1 },
      ),
    ).toBeGreaterThan(0);
  });

  it("preselects the device's own licence, else Keep for a usable licence it runs on outside the list", async () => {
    const product = await setIdentity(true);
    const ada = await account("ada@example.com");
    await accountLicence(ada.id, "lic_mine");
    // DEV_A runs on a key-entered licence that is not Ada's.
    const floating = await seedLicenseWithKey(db, SLUG, { id: "lic_floating" });
    await db.run("UPDATE licenses SET email = NULL WHERE id = 'lic_floating'");
    await tokenOf(floating.key, DEV_A);
    const kept = await rankAnchorCandidates(db, product, ada.id, NOW, {
      deviceId: DEV_A,
    });
    expect(kept.keep).toBe(true);
    expect(kept.preselected).toBe("keep");
    // The floating licence is never listed.
    expect(kept.candidates.map((c) => c.licenseId)).toEqual(["lic_mine"]);
  });

  it("never mints a second automatic licence while a usable one exists", async () => {
    const product = await setIdentity(true);
    const ada = await account("ada@example.com");
    await accountLicence(ada.id, "lic_mine");
    let minted = 0;
    const mint = async (): Promise<LicenseRow | null> => {
      minted++;
      return null;
    };
    for (const choice of [null, { kind: "create" as const }]) {
      const r = await bindSignedInDevice(env, db, product, {
        accountId: ada.id,
        subject: ada.subject,
        deviceId: DEV_A,
        choice,
        now: NOW,
        rank: { grantTierId: "free" },
        mint,
      });
      expect(r).toEqual({ ok: false, reason: "license_choice_required" });
    }
    expect(minted).toBe(0);
    // With no licence at all, create is offered and preselected, and only then mints.
    const bob = await account("bob@example.com");
    const none = await rankAnchorCandidates(db, product, bob.id, NOW, {
      grantTierId: "free",
    });
    expect(none).toEqual({
      candidates: [],
      keep: false,
      create: true,
      preselected: "create",
    });
    await seedTier(db, SLUG, "free", { deviceLimit: 2 });
    const r = await bindSignedInDevice(env, db, product, {
      accountId: bob.id,
      subject: bob.subject,
      deviceId: DEV_A,
      choice: null,
      now: NOW,
      rank: { grantTierId: "free" },
      mint: async () => {
        minted++;
        await accountLicence(bob.id, "lic_new");
        return getLicense(db, SLUG, "lic_new");
      },
    });
    expect(r).toMatchObject({ ok: true, licenseId: "lic_new", minted: true });
    expect(minted).toBe(1);
  });

  it("binds only a candidate of this account", async () => {
    const product = await setIdentity(true);
    const ada = await account("ada@example.com");
    const bob = await account("bob@example.com");
    await accountLicence(bob.id, "lic_bob");
    const r = await bindSignedInDevice(env, db, product, {
      accountId: ada.id,
      subject: ada.subject,
      deviceId: DEV_A,
      choice: { kind: "license", licenseId: "lic_bob" },
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "not_found" });
    const bound = await bindSignedInDevice(env, db, product, {
      accountId: bob.id,
      subject: bob.subject,
      deviceId: DEV_A,
      choice: { kind: "license", licenseId: "lic_bob" },
      now: NOW,
    });
    expect(bound.ok).toBe(true);
    const row = await db.first<{ subject: string; bound_by: string }>(
      "SELECT subject, bound_by FROM devices WHERE product = ? AND device_id = ?",
      SLUG,
      DEV_A,
    );
    expect(row).toEqual({ subject: bob.subject, bound_by: "signin" });
  });

  it("licenseAccess: a held licence with no key is a sign-in licence, anything with a key is seats", async () => {
    await setIdentity(true);
    const ada = await account("ada@example.com");
    await accountLicence(ada.id, "lic_keyed");
    expect(
      await licenseAccess(db, (await getLicense(db, SLUG, "lic_keyed"))!),
    ).toBe("seats");
    await db.run(
      `INSERT INTO licenses (product, id, status, activated_at, modified_at, account_id, origin)
       VALUES (?, 'lic_signin', 'active', ?, ?, ?, 'oidc')`,
      SLUG,
      NOW,
      NOW,
      ada.id,
    );
    expect(
      await licenseAccess(db, (await getLicense(db, SLUG, "lic_signin"))!),
    ).toBe("account");
    // Negative control: a keyless licence nobody holds is not a sign-in licence.
    await db.run(
      `INSERT INTO licenses (product, id, status, activated_at, modified_at)
       VALUES (?, 'lic_nobody', 'active', ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    expect(
      await licenseAccess(db, (await getLicense(db, SLUG, "lic_nobody"))!),
    ).toBe("seats");
  });
});

// ── enrollFate ────────────────────────────────────────────────────────────────────────────

describe("enrollFate", () => {
  const row = (over: Partial<LicenseRow>): LicenseRow =>
    ({
      product: SLUG,
      id: "lic_enroll",
      status: "active",
      sub: null,
      origin: "enroll",
      account_id: null,
      ...over,
    }) as LicenseRow;

  it("answers claimed for an enroll licence in an account with no sub", () => {
    expect(enrollFate(row({ account_id: "acct_1" }))).toBe("claimed");
    expect(enrollFate(row({ sub: "s" }))).toBe("claimed");
    expect(enrollFate(row({ status: "disabled" }))).toBe("disabled");
    // Negative control: the anonymous row is handed back.
    expect(typeof enrollFate(row({}))).toBe("object");
  });
});

// ── §12.6 discovery ───────────────────────────────────────────────────────────────────────

describe("discovery (§12.6)", () => {
  async function fragment(): Promise<Record<string, unknown>> {
    const res = await call("GET", `/${SLUG}/.well-known/polaris.json`);
    const body = (await res.json()) as {
      services: Record<string, Record<string, unknown>>;
    };
    return body.services.identity!;
  }

  it("publishes the account members and the enforced key-entry limit while Identity is on", async () => {
    await setIdentity(true);
    await db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.keyEntry.limit', '3', 'console', ?, 'test')`,
      SLUG,
      NOW,
    );
    const f = await fragment();
    expect(f).toMatchObject({ enabled: true, account: true, keyEntryLimit: 3 });
    expect(f.endpoints).toMatchObject({
      attach: `${BASE}/${SLUG}/identity/attach`,
      subject: `${BASE}/${SLUG}/identity/subject`,
      signout: `${BASE}/${SLUG}/identity/signout`,
      accountPortal: `${BASE}/#/p/${SLUG}`,
    });
  });

  it("omits accountPortal while the product's portal is off, and says nothing with Identity off", async () => {
    await setIdentity(true);
    await db.run(
      `INSERT INTO portal_product_settings (product, portal_enabled, created_at, modified_at)
       VALUES (?, 0, ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    expect((await fragment()).endpoints).not.toHaveProperty("accountPortal");
    await setIdentity(false);
    expect(await fragment()).toEqual({ enabled: false });
  });
});
