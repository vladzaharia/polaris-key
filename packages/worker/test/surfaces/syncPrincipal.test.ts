/**
 * U-02: the Cloud Sync principal (plans/U-01.md §6.1, §2.1; S-17 §5.2, §5.8 item 2).
 *
 * `resolveSyncPrincipal(device)` is the device binding (`devices.subject`) and nothing else:
 * Cloud Sync needs sign-in, so a key-activated device has no principal even on a licence an
 * account owns, and a floating licence never has one, not even with a binding on the device
 * (S-24, owner 2026-10-06: a floating licence has no account features). An alias resolves to the
 * survivor (D21), a deleted subject to nothing. Every clearing trigger (sign-out, sign out
 * everywhere, disable, deletion, per-product removal, relink) drops the binding; a plain detach
 * does not, but hides it: removed from an account's library, the licence is floating for that
 * account's devices (S-24 D19, lead 2026-10-06, PX-23) until the key adds it back. Any re-bind without a sign-in (key
 * re-entry, open re-registration) drops it. `syncAccess` never falls back to the licence owner,
 * and no answer carries an account id.
 */
import type { ManagedEntry } from "@polaris-key/protocol";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { asR2, R2Mock } from "../r2Mock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../seed.js";
import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";
import { type DeviceRow } from "../../src/core/repo.js";
import { getDevice } from "../../src/core/devices/store.js";
import { invalidatePlatformSettings } from "../../src/core/platformSettings.js";
import { getLicense } from "../../src/core/licensing/store.js";
import { setServices } from "../../src/core/products/store.js";
import { serializeServices } from "../../src/core/services.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import {
  isFloatingLicense,
  resolveSyncPrincipal,
  setDeviceSubject,
  subjectFor,
} from "../../src/core/accounts/accountSubjects.js";
import { clearDeviceSubjects } from "../../src/core/accounts/subjectHooks.js";
import { syncAccess } from "../../src/core/accounts/syncAccess.js";
import { handleRegister } from "../../src/core/register.js";
import { SERVICES } from "../../src/mount.js";
import { CLOUD_SYNC_CEILINGS } from "@polaris-key/catalog";
import { handleActivate } from "../../src/services/license/activation.js";
import { signIn } from "../../src/services/identity/accounts/signIn.js";
import type { AccountContext } from "../../src/services/identity/accounts/links.js";
import { mergeAccounts } from "../../src/services/identity/accounts/merge.js";
import {
  attachLicense,
  detachLicense,
  reassignLicense,
} from "../../src/services/identity/accounts/claim.js";
import {
  deleteAccount,
  disableAccount,
  removeProductData,
} from "../../src/services/identity/accounts/deletion.js";

const SLUG = "djdl";

interface World {
  db: Db;
  env: Env;
  product: Product;
  ctx: AccountContext;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  await seedProduct(db, SLUG);
  // PX-W17: a device binding needs the product's Identity service on.
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
        identity: { enabled: true },
        sync: { enabled: false },
        commerce: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  const product = (await loadProduct(env, db, SLUG))!;
  return {
    db,
    env,
    product,
    ctx: { db, env, now: NOW, origin: "https://key.plrs.im" },
  };
}

async function account(db: Db, email: string) {
  const r = await signIn(
    db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
    { unfenced: true, product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return { id: r.account.id, subject: r.subject! };
}

/** Licence-key activation through the real route: the device is bound by key. */
async function activateByKey(
  w: World,
  key: string,
  deviceId: string,
): Promise<DeviceRow> {
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": deviceId,
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  expect(res.status).toBe(200);
  return (await getDevice(w.db, SLUG, deviceId))!;
}

async function principalOf(w: World, deviceId: string) {
  const device = await getDevice(w.db, SLUG, deviceId);
  return device ? resolveSyncPrincipal(w.db, device) : null;
}

/** A device the sign-in bound (`bound_by = 'signin'`), inserted directly. */
async function insertSignedInDevice(
  db: Db,
  deviceId: string,
  licenseId: string,
  subject: string,
): Promise<void> {
  await db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by, token_hash)
     VALUES (?, ?, ?, 'authorized', ?, ?, ?, 'signin', ?)`,
    SLUG,
    deviceId,
    licenseId,
    NOW,
    NOW,
    subject,
    `th-${deviceId}`,
  );
}

describe("resolveSyncPrincipal: the binding only, never the licence owner", () => {
  it("a key-activated device on an owned licence has no principal; after sign-in it is the pairwise subject", async () => {
    const w = await world();
    const { key, licenseId } = await seedLicenseWithKey(w.db, SLUG);
    const ada = await account(w.db, "ada@example.com");
    const attached = await attachLicense(w.ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId,
      via: "key",
    });
    expect(attached.ok).toBe(true);
    const device = await activateByKey(w, key, "dev-1");
    // Licence-key activation never sets the binding, even on a licence the account owns.
    expect(device.subject ?? null).toBeNull();
    expect(device.bound_by).toBe("key");
    expect(await resolveSyncPrincipal(w.db, device)).toBeNull();
    expect(await syncAccess(w.env, w.db, w.product, device, NOW)).toBeNull();

    // The account signs in on the device (Identity's sign-in calls Core's setter).
    expect(
      await setDeviceSubject(w.env, w.db, SLUG, "dev-1", ada.subject),
    ).toBe(true);
    expect(await principalOf(w, "dev-1")).toEqual({
      product: SLUG,
      subject: ada.subject,
    });
  });

  it("a device on a floating licence has no principal, even after someone signs in on it (S-24)", async () => {
    const w = await world();
    const { key, licenseId } = await seedLicenseWithKey(w.db, SLUG);
    // Floating: no account owns it and no email associates it with one.
    await w.db.run(
      "UPDATE licenses SET account_id = NULL, email = NULL WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    const device = await activateByKey(w, key, "dev-1");
    expect(await resolveSyncPrincipal(w.db, device)).toBeNull();
    expect(await syncAccess(w.env, w.db, w.product, device, NOW)).toBeNull();
    const bo = await account(w.db, "bo@example.com");
    await setDeviceSubject(w.env, w.db, SLUG, "dev-1", bo.subject);
    // The binding is written, but a floating licence has no account features (S-24).
    expect((await getDevice(w.db, SLUG, "dev-1"))?.subject).toBe(bo.subject);
    expect(await principalOf(w, "dev-1")).toBeNull();
    expect(
      await syncAccess(
        w.env,
        w.db,
        w.product,
        (await getDevice(w.db, SLUG, "dev-1"))!,
        NOW,
      ),
    ).toBeNull();
    // The licence stays floating: signing in on a device does not claim its licence.
    expect(
      await w.db.first<{ account_id: string | null }>(
        "SELECT account_id FROM licenses WHERE product = ?",
        SLUG,
      ),
    ).toEqual({ account_id: null });
  });

  it("a device naming a missing licence fails closed; a blank email is no email; a licence-less device keeps its binding", async () => {
    const w = await world();
    // seedLicenseWithKey writes ada@example.com: an assigned (waiting) licence.
    const { licenseId } = await seedLicenseWithKey(w.db, SLUG);
    const ada = await account(w.db, "ada@example.com");
    await insertSignedInDevice(w.db, "dev-1", licenseId, ada.subject);
    expect(await principalOf(w, "dev-1")).toEqual({
      product: SLUG,
      subject: ada.subject,
    });
    // An email of only spaces is no email (`isFloatingLicense`): the licence is floating.
    await w.db.run(
      "UPDATE licenses SET email = '   ' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    expect(await principalOf(w, "dev-1")).toBeNull();
    // The device names a licence row that is gone: no principal (fail closed), not "no licence".
    await w.db.run(
      "UPDATE devices SET license_id = 'lic_gone' WHERE product = ? AND device_id = ?",
      SLUG,
      "dev-1",
    );
    expect(await principalOf(w, "dev-1")).toBeNull();
    // A device with no licence at all (`NO_LICENSE_ID`: License off, or a keyless device of an
    // `open` registration product) has nothing to be floating: its principal is its binding.
    await w.db.run(
      "UPDATE devices SET license_id = '' WHERE product = ? AND device_id = ?",
      SLUG,
      "dev-1",
    );
    expect(await principalOf(w, "dev-1")).toEqual({
      product: SLUG,
      subject: ada.subject,
    });
  });

  it("an aliased subject resolves to the survivor's; a deleted one, a malformed one and a revoked device to no principal", async () => {
    const w = await world();
    const { licenseId } = await seedLicenseWithKey(w.db, SLUG);
    const a = await account(w.db, "a@example.com");
    const b = await account(w.db, "b@example.com");
    await insertSignedInDevice(w.db, "dev-b", licenseId, b.subject);
    expect(
      await mergeAccounts(w.ctx, {
        survivor: { accountId: a.id, authenticatedAt: NOW },
        absorbed: { accountId: b.id, authenticatedAt: NOW },
      }),
    ).toMatchObject({ ok: true });
    // The merge re-binds the device to the survivor's subject in its batch...
    expect((await getDevice(w.db, SLUG, "dev-b"))?.subject).toBe(a.subject);
    // ...and a binding that still names the absorbed subject (written before the merge's batch
    // committed) resolves to the survivor through the alias (D21).
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = ?",
      b.subject,
      SLUG,
      "dev-b",
    );
    expect(await principalOf(w, "dev-b")).toEqual({
      product: SLUG,
      subject: a.subject,
    });

    // A subject that no longer exists (its row is gone) resolves to nothing.
    const c = await account(w.db, "c@example.com");
    await insertSignedInDevice(w.db, "dev-c", licenseId, c.subject);
    await w.db.run(
      "DELETE FROM account_product_subjects WHERE product = ? AND subject = ?",
      SLUG,
      c.subject,
    );
    expect(await principalOf(w, "dev-c")).toBeNull();

    const base = (await getDevice(w.db, SLUG, "dev-b"))!;
    expect(
      await resolveSyncPrincipal(w.db, {
        ...base,
        subject: "acct_not-a-subject",
      }),
    ).toBeNull();
    expect(
      await resolveSyncPrincipal(w.db, { ...base, status: "deauthorized" }),
    ).toBeNull();
  });

  it("re-entering a key never carries or resurrects a binding", async () => {
    const w = await world();
    const { key, licenseId } = await seedLicenseWithKey(w.db, SLUG);
    const ada = await account(w.db, "ada@example.com");
    await activateByKey(w, key, "dev-1");
    await setDeviceSubject(w.env, w.db, SLUG, "dev-1", ada.subject);
    // Re-activating an authorized, signed-in device on the same licence mints a new credential
    // without a sign-in: the binding is dropped (anyone holding the key could do this).
    const reactivated = await activateByKey(w, key, "dev-1");
    expect(reactivated.subject ?? null).toBeNull();
    expect(await resolveSyncPrincipal(w.db, reactivated)).toBeNull();

    // The device is revoked without a sign-out (a console deauthorize), then the key is entered
    // again: the old account must not come back as this device's Cloud Sync principal.
    await setDeviceSubject(w.env, w.db, SLUG, "dev-1", ada.subject);
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      SLUG,
      "dev-1",
    );
    const again = await activateByKey(w, key, "dev-1");
    expect(again.subject ?? null).toBeNull();
    expect(await resolveSyncPrincipal(w.db, again)).toBeNull();

    // Moving to another licence by key drops it as well. SEC-LIC-1: a LIVE device is not another
    // licence's to take, so the move goes through the device being released first.
    await setDeviceSubject(w.env, w.db, SLUG, "dev-1", ada.subject);
    const other = await seedLicenseWithKey(w.db, SLUG, { id: "lic_other" });
    expect(other.licenseId).not.toBe(licenseId);
    const refused = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${other.key}`,
        "x-pkey-device": "dev-1",
      }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(refused.status).toBe(401);
    expect((await getDevice(w.db, SLUG, "dev-1"))?.license_id).toBe(licenseId);
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      SLUG,
      "dev-1",
    );
    const moved = await activateByKey(w, other.key, "dev-1");
    expect(moved.license_id).toBe("lic_other");
    expect(moved.subject ?? null).toBeNull();
  });

  it("does not permit anonymous re-registration once Identity is needed for account binding", async () => {
    const w = await world();
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: false },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: true },
          sync: { enabled: false },
          commerce: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
    const response = await handleRegister(
      mkReq("POST", { "x-pkey-device": DEVICE }),
      w.env,
      w.db,
      product,
      NOW,
      SERVICES,
    );
    expect(response.status).toBe(403);
    expect(await getDevice(w.db, SLUG, DEVICE)).toBeNull();
  });
});

describe("the clearing hook's Cloud Sync cases", () => {
  async function signedInDevice(w: World) {
    const { licenseId } = await seedLicenseWithKey(w.db, SLUG);
    const ada = await account(w.db, "ada@example.com");
    const attached = await attachLicense(w.ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId,
      via: "key",
    });
    if (!attached.ok) throw new Error("attach failed");
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by)
       VALUES (?, 'dev-1', ?, 'authorized', ?, ?, ?, 'key')`,
      SLUG,
      licenseId,
      NOW,
      NOW,
      ada.subject,
    );
    expect((await principalOf(w, "dev-1"))?.subject).toBe(ada.subject);
    return { ada, licenseId };
  }

  const bindingOf = async (w: World) =>
    (await getDevice(w.db, SLUG, "dev-1"))?.subject ?? null;

  it("sign-out clears it", async () => {
    const w = await world();
    await signedInDevice(w);
    await clearDeviceSubjects(
      w.db,
      w.env,
      { kind: "device", product: SLUG, deviceId: "dev-1" },
      "signout",
    );
    expect(await bindingOf(w)).toBeNull();
    expect(await principalOf(w, "dev-1")).toBeNull();
  });

  it("sign out everywhere clears it on every device of the account", async () => {
    const w = await world();
    const { ada, licenseId } = await signedInDevice(w);
    await insertSignedInDevice(w.db, "dev-2", licenseId, ada.subject);
    const r = await clearDeviceSubjects(
      w.db,
      w.env,
      { kind: "account", accountId: ada.id },
      "signout_everywhere",
    );
    expect(r.cleared).toBe(2);
    expect(await bindingOf(w)).toBeNull();
    expect((await getDevice(w.db, SLUG, "dev-2"))?.subject ?? null).toBeNull();
  });

  it("account disable clears it", async () => {
    const w = await world();
    const { ada } = await signedInDevice(w);
    expect(await disableAccount(w.ctx, ada.id)).toEqual({ ok: true });
    expect(await bindingOf(w)).toBeNull();
  });

  it("account deletion clears it", async () => {
    const w = await world();
    const { ada } = await signedInDevice(w);
    // I-11: an erasure is recorded on the ledger (R2) before D1 changes.
    w.env.BLOBS = asR2(new R2Mock());
    expect(await deleteAccount(w.ctx, ada.id)).toEqual({ ok: true });
    expect(await bindingOf(w)).toBeNull();
  });

  it("per-product data removal clears it", async () => {
    const w = await world();
    const { ada } = await signedInDevice(w);
    expect(
      await removeProductData(w.ctx, {
        accountId: ada.id,
        product: SLUG,
        alsoDetachLicenses: false,
      }),
    ).toMatchObject({ ok: true });
    expect(await bindingOf(w)).toBeNull();
  });

  it("a relink of the device's licence clears it", async () => {
    const w = await world();
    const { licenseId } = await signedInDevice(w);
    const bo = await account(w.db, "bo@example.com");
    expect(
      await reassignLicense(w.ctx, {
        product: SLUG,
        licenseId,
        toAccountId: bo.id,
        actor: "admin:op",
      }),
    ).toMatchObject({ ok: true });
    expect(await bindingOf(w)).toBeNull();
  });

  it("a plain detach does not sign the device out, but the principal is hidden: removed, the licence is floating for that account (S-24 D19)", async () => {
    const w = await world();
    const { ada, licenseId } = await signedInDevice(w);
    expect(
      await detachLicense(w.ctx, {
        accountId: ada.id,
        product: SLUG,
        licenseId,
      }),
    ).toEqual({ ok: true });
    expect(await bindingOf(w)).toBe(ada.subject);
    // Still email-associated (the seed licence carries an email), so assigned and waiting, not
    // floating; but LX-26's block marks it removed from Ada's library, and for her devices that
    // is the same as floating (lead decision, 2026-10-06; PX-23).
    expect(isFloatingLicense((await getLicense(w.db, SLUG, licenseId))!)).toBe(
      false,
    );
    expect(await principalOf(w, "dev-1")).toBeNull();
    // With no email either, the licence is floating: the binding is kept, the principal hidden.
    await w.db.run(
      "UPDATE licenses SET email = NULL WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    expect(await bindingOf(w)).toBe(ada.subject);
    expect(await principalOf(w, "dev-1")).toBeNull();
  });

  it("re-adding the key lifts the block, and the principal returns with it", async () => {
    const w = await world();
    const { ada, licenseId } = await signedInDevice(w);
    await detachLicense(w.ctx, { accountId: ada.id, product: SLUG, licenseId });
    expect(await principalOf(w, "dev-1")).toBeNull();
    // An automatic attach cannot bring it back (the block), so nothing changes.
    expect(
      await attachLicense(w.ctx, {
        accountId: ada.id,
        product: SLUG,
        licenseId,
        via: "email",
      }),
    ).toMatchObject({ ok: false, reason: "auto_attach_blocked" });
    expect(await principalOf(w, "dev-1")).toBeNull();
    // The person adds the key again: an explicit act.
    expect(
      await attachLicense(w.ctx, {
        accountId: ada.id,
        product: SLUG,
        licenseId,
        via: "key",
      }),
    ).toMatchObject({ ok: true, attached: true });
    expect((await principalOf(w, "dev-1"))?.subject).toBe(ada.subject);
  });

  it("only the removing account's devices lose it: another account's binding on the licence keeps its principal", async () => {
    const w = await world();
    const { ada, licenseId } = await signedInDevice(w);
    const bo = await account(w.db, "bo@example.com");
    await insertSignedInDevice(w.db, "dev-bo", licenseId, bo.subject);
    expect((await principalOf(w, "dev-bo"))?.subject).toBe(bo.subject);
    await detachLicense(w.ctx, { accountId: ada.id, product: SLUG, licenseId });
    expect(await principalOf(w, "dev-1")).toBeNull();
    expect((await principalOf(w, "dev-bo"))?.subject).toBe(bo.subject);
  });

  it("a merged account's devices follow the survivor's block; a block on a licence the account holds is inert", async () => {
    const w = await world();
    const { ada, licenseId } = await signedInDevice(w);
    // A block row for the account that holds the licence (as a merge can leave behind): inert.
    await w.db.run(
      `INSERT INTO license_auto_attach_blocks (product, license_id, account_id, created_at)
       VALUES (?, ?, ?, ?)`,
      SLUG,
      licenseId,
      ada.id,
      NOW,
    );
    expect((await principalOf(w, "dev-1"))?.subject).toBe(ada.subject);
    // Removed, then Ada's account is absorbed by Bo's: the merge re-binds dev-1 to Bo's subject
    // and moves the block to Bo, so the device still has no principal.
    await detachLicense(w.ctx, { accountId: ada.id, product: SLUG, licenseId });
    const bo = await account(w.db, "bo@example.com");
    expect(
      await mergeAccounts(w.ctx, {
        survivor: { accountId: bo.id, authenticatedAt: NOW },
        absorbed: { accountId: ada.id, authenticatedAt: NOW },
      }),
    ).toMatchObject({ ok: true });
    expect(await bindingOf(w)).toBe(bo.subject);
    expect(await principalOf(w, "dev-1")).toBeNull();
  });
});

describe("syncAccess", () => {
  it("answers from the anchor licence, never from its owner, and carries no account id", async () => {
    const w = await world();
    const { key, licenseId } = await seedLicenseWithKey(w.db, SLUG, {
      entitlements: {
        saves: { state: "enforced", value: true, updatedAt: NOW },
      },
    });
    const ada = await account(w.db, "ada@example.com");
    await attachLicense(w.ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId,
      via: "key",
    });
    await activateByKey(w, key, "dev-1");
    // Owned licence, key-activated device: no owner fallback, so no access answer at all.
    expect(
      await syncAccess(
        w.env,
        w.db,
        w.product,
        (await getDevice(w.db, SLUG, "dev-1"))!,
        NOW,
      ),
    ).toBeNull();

    // Someone ELSE signs in on the device: the principal is theirs, not the licence owner's.
    const bo = await account(w.db, "bo@example.com");
    await setDeviceSubject(w.env, w.db, SLUG, "dev-1", bo.subject);
    const device = (await getDevice(w.db, SLUG, "dev-1"))!;
    const access = await syncAccess(w.env, w.db, w.product, device, NOW);
    expect(access).toEqual({
      subject: bo.subject,
      licensed: true,
      entitlements: expect.objectContaining({ saves: true }),
      quota: { bytes: 268_435_456, files: true },
      tierId: null,
    });
    expect(access!.subject).not.toBe(ada.subject);
    const serialized = JSON.stringify(access);
    expect(serialized).not.toContain(ada.id);
    expect(serialized).not.toContain(bo.id);
    // The subject belongs to this product: a different product's view of the row is refused.
    expect(
      await syncAccess(
        w.env,
        w.db,
        { ...w.product, slug: "other" },
        device,
        NOW,
      ),
    ).toBeNull();
  });

  it("an unusable anchor licence leaves the principal but no licence; the License service off makes the anchor moot", async () => {
    const w = await world();
    const { key, licenseId } = await seedLicenseWithKey(w.db, SLUG);
    const ada = await account(w.db, "ada@example.com");
    await activateByKey(w, key, "dev-1");
    await setDeviceSubject(w.env, w.db, SLUG, "dev-1", ada.subject);
    await w.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    const device = (await getDevice(w.db, SLUG, "dev-1"))!;
    expect(await syncAccess(w.env, w.db, w.product, device, NOW)).toEqual({
      subject: ada.subject,
      licensed: false,
      entitlements: {},
      quota: { bytes: 1_048_576, files: false },
      tierId: null,
    });

    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: false },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: true },
          sync: { enabled: false },
          commerce: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const configOnly = (await loadProduct(w.env, w.db, SLUG))!;
    expect(
      await syncAccess(w.env, w.db, configOnly, device, NOW),
    ).toMatchObject({
      subject: ada.subject,
      licensed: false,
      quota: { bytes: 268_435_456, files: true },
      tierId: null,
    });
  });

  it("subjectFor stays Config's: it creates the owner's subject on first use", async () => {
    const w = await world();
    const ada = await signIn(
      w.db,
      { issuerKey: "email", subject: "ada@example.com", kind: "email" },
      NOW,
      { unfenced: true },
    );
    if (ada.status !== "signed_in") throw new Error(ada.status);
    expect(
      await w.db.first(
        "SELECT subject FROM account_product_subjects WHERE account_id = ?",
        ada.account.id,
      ),
    ).toBeNull();
    const s = await subjectFor(w.db, ada.account.id, SLUG, NOW);
    expect(await subjectFor(w.db, ada.account.id, SLUG, NOW)).toBe(s);
  });
});

describe("syncAccess: the quota per device (plans/U-01b.md D5)", () => {
  const MIB = 1024 * 1024;
  const bytesEntitlement = (value: ManagedEntry["value"]) => ({
    "pkey.cloudSync.bytes": {
      state: "enforced" as const,
      value,
      updatedAt: NOW,
    },
  });

  /** A signed-in device on a licence seeded with `opts`. */
  async function quotaOf(
    opts: Parameters<typeof seedLicenseWithKey>[2] & {
      licenseOff?: boolean;
      platformDefault?: number;
      disable?: boolean;
    } = {},
  ) {
    const w = await world();
    const { licenseId } = await seedLicenseWithKey(w.db, SLUG, opts);
    const ada = await account(w.db, "ada@example.com");
    await insertSignedInDevice(w.db, "dev-1", licenseId, ada.subject);
    if (opts.disable)
      await w.db.run(
        "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
        SLUG,
        licenseId,
      );
    if (opts.platformDefault !== undefined) {
      await w.db.run(
        `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
         VALUES ('cloudSync.quota.defaultBytes', ?, 1, ?, 'test')`,
        JSON.stringify(opts.platformDefault),
        NOW,
      );
      invalidatePlatformSettings(w.env, w.db);
    }
    let product = w.product;
    if (opts.licenseOff) {
      await setServices(
        w.db,
        SLUG,
        serializeServices({
          services: {
            license: { enabled: false },
            config: { enabled: true },
            release: { enabled: false },
            distribution: { enabled: false },
            update: { enabled: false },
            identity: { enabled: true },
            sync: { enabled: false },
            commerce: { enabled: false },
          },
        }),
        "manifest",
        NOW,
      );
      product = (await loadProduct(w.env, w.db, SLUG))!;
    }
    const device = (await getDevice(w.db, SLUG, "dev-1"))!;
    return (await syncAccess(w.env, w.db, product, device, NOW))!;
  }

  it("License off: the platform default, files allowed", async () => {
    expect((await quotaOf({ licenseOff: true })).quota).toEqual({
      bytes: 256 * MIB,
      files: true,
    });
    expect(
      (await quotaOf({ licenseOff: true, platformDefault: 10 * MIB })).quota,
    ).toEqual({ bytes: 10 * MIB, files: true });
  });

  it("a usable anchor licence: its integer entitlement, else the platform default", async () => {
    const a = await quotaOf({ entitlements: bytesEntitlement(5 * MIB) });
    expect(a.quota).toEqual({ bytes: 5 * MIB, files: true });
    expect(a.licensed).toBe(true);
    expect((await quotaOf({ platformDefault: 8 * MIB })).quota).toEqual({
      bytes: 8 * MIB,
      files: true,
    });
    // The entitlement beats the platform default.
    expect(
      (
        await quotaOf({
          entitlements: bytesEntitlement(5 * MIB),
          platformDefault: 8 * MIB,
        })
      ).quota.bytes,
    ).toBe(5 * MIB);
  });

  it("a non-integer or negative entitlement is no value: the platform default applies", async () => {
    for (const bad of [
      1.5,
      "100",
      -1,
      null,
      true,
      Number.NaN,
      2 ** 60,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(
        (await quotaOf({ entitlements: bytesEntitlement(bad) })).quota,
        String(bad),
      ).toEqual(
        bad === Number.MAX_SAFE_INTEGER
          ? { bytes: CLOUD_SYNC_CEILINGS.perPerson.bytes, files: true }
          : { bytes: 256 * MIB, files: true },
      );
    }
  });

  it("clamps to the per-person ceiling", async () => {
    const q = await quotaOf({
      entitlements: bytesEntitlement(CLOUD_SYNC_CEILINGS.perPerson.bytes + 1),
    });
    expect(q.quota.bytes).toBe(CLOUD_SYNC_CEILINGS.perPerson.bytes);
    expect(q.quota.files).toBe(true);
  });

  it("0 means reads only: a zero quota, not a fallback", async () => {
    expect(
      (await quotaOf({ entitlements: bytesEntitlement(0) })).quota,
    ).toEqual({ bytes: 0, files: true });
  });

  it("no usable licence: 1 MiB, files refused; an unusable licence's entitlement is not read", async () => {
    const disabled = await quotaOf({
      entitlements: bytesEntitlement(5 * MIB),
      tierId: "pro",
      disable: true,
    });
    expect(disabled.quota).toEqual({ bytes: MIB, files: false });
    expect(disabled.tierId).toBeNull();
    expect(disabled.entitlements).toEqual({});
    // Expired (past graceUntil-less expiry) is unusable too.
    const expired = await quotaOf({
      entitlements: bytesEntitlement(5 * MIB),
      expiresAt: NOW - 1,
    });
    expect(expired.licensed).toBe(false);
    expect(expired.quota).toEqual({ bytes: MIB, files: false });
    // The platform default does not lift an unlicensed device.
    expect(
      (await quotaOf({ disable: true, platformDefault: 8 * MIB })).quota,
    ).toEqual({ bytes: MIB, files: false });
  });

  it("tierId is the anchor's tier when usable, and always a string the object accepts (1 to 256 characters)", async () => {
    expect((await quotaOf({ tierId: "pro" })).tierId).toBe("pro");
    expect((await quotaOf({})).tierId).toBeNull();
    expect((await quotaOf({ tierId: "" })).tierId).toBeNull();
    expect((await quotaOf({ tierId: "t".repeat(256) })).tierId).toBe(
      "t".repeat(256),
    );
    expect((await quotaOf({ tierId: "t".repeat(257) })).tierId).toBeNull();
    expect(
      (await quotaOf({ licenseOff: true, tierId: "pro" })).tierId,
    ).toBeNull();
  });

  it("two devices of one person can differ: the quota follows the requesting device's anchor", async () => {
    const w = await world();
    const big = await seedLicenseWithKey(w.db, SLUG, {
      id: "lic_big",
      entitlements: bytesEntitlement(50 * MIB),
    });
    const small = await seedLicenseWithKey(w.db, SLUG, { id: "lic_small" });
    const ada = await account(w.db, "ada@example.com");
    await insertSignedInDevice(w.db, "dev-big", big.licenseId, ada.subject);
    await insertSignedInDevice(w.db, "dev-small", small.licenseId, ada.subject);
    await w.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      small.licenseId,
    );
    const at = async (id: string) =>
      (await syncAccess(
        w.env,
        w.db,
        w.product,
        (await getDevice(w.db, SLUG, id))!,
        NOW,
      ))!;
    const a = await at("dev-big");
    const b = await at("dev-small");
    expect(a.subject).toBe(b.subject);
    expect(a.quota.bytes).toBe(50 * MIB);
    expect(b.quota).toEqual({ bytes: MIB, files: false });
  });

  it("still no owner fallback: an owned licence on a key-activated device has no quota answer", async () => {
    const w = await world();
    const { key, licenseId } = await seedLicenseWithKey(w.db, SLUG, {
      entitlements: bytesEntitlement(5 * MIB),
    });
    const ada = await account(w.db, "ada@example.com");
    await attachLicense(w.ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId,
      via: "key",
    });
    const device = await activateByKey(w, key, "dev-1");
    expect(await syncAccess(w.env, w.db, w.product, device, NOW)).toBeNull();
  });
});
