/**
 * I-49.8: turning Identity off or back on ends every silent-restore key of the product
 * (WIRE-CONTRACT-V5 §12.11.8, "Revocation"). `DELETE restore` answers 404 while Identity is off,
 * so a key must not survive that window. The purge is a services-write listener
 * (`restore/servicesListener.ts`, run by `applyServiceTransitions`): it removes keys and origin
 * marks of the one product, writes one audit row naming the reason, and writes none when there was
 * nothing to remove.
 */
import { describe, expect, it } from "vitest";
import { NOW, seedProduct } from "../../seed.js";
import { adminWorld } from "../../adminWorld.js";
import {
  markRestoreOrigin,
  mintRestoreKey,
} from "../../../src/services/identity/restore/store.js";
import { listAudit } from "../../../src/core/audit.js";
import { applyServiceTransitions } from "../../../src/core/servicesTransitions.js";
import { parseServices } from "../../../src/core/services.js";
import { getProduct } from "../../../src/core/products/store.js";

const SLUG = "djdl";
const OTHER = "other";
const DEV_1 = "1".repeat(32);
const DEV_2 = "2".repeat(32);
const SUBJECT = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const PATH = `/api/products/${SLUG}/services`;

async function setup() {
  const w = await adminWorld({ products: [SLUG] });
  await seedProduct(w.db, OTHER);
  const session = await w.login({
    sub: "u1",
    name: "Ada",
    email: "ada@x.io",
    groups: ["platform-admins"],
    authTime: NOW,
  });
  const enrol = async (product: string, device: string) => {
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject)
       VALUES (?, ?, '', 'authorized', ?, ?, ?)`,
      product,
      device,
      NOW,
      NOW,
      SUBJECT,
    );
    await mintRestoreKey(w.env, w.db, {
      product,
      deviceId: device,
      subject: SUBJECT,
      boundSubject: SUBJECT,
      now: NOW,
    });
    await markRestoreOrigin(w.db, {
      product,
      deviceId: device,
      subject: SUBJECT,
      now: NOW,
    });
  };
  // A key no device row backs, so no device-lifecycle event can have ended it: only the services
  // listener can.
  const straggler = async (product: string, device: string, id: string) => {
    await w.db.run(
      `INSERT INTO identity_restore_keys (id, product, device_id, subject, secret_hash, created_at, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      product,
      device,
      SUBJECT,
      "0".repeat(64),
      NOW,
      NOW,
    );
    await markRestoreOrigin(w.db, {
      product,
      deviceId: device,
      subject: SUBJECT,
      now: NOW,
    });
  };
  const count = async (table: string, product: string) =>
    (await w.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE product = ?`,
      product,
    ))!.n;
  const identity = (enabled: boolean) =>
    w.call("PATCH", PATH, {
      as: session,
      body: { services: { identity: { enabled } } },
    });
  const purges = async () =>
    (await listAudit(w.db, SLUG)).filter(
      (a) => a.action === "identity.restore.purge",
    );
  return { w, enrol, straggler, count, identity, purges };
}

describe("Identity toggles end the restore keys of the product", () => {
  it("enrol, Identity off, Identity on: the key and its origin mark are gone", async () => {
    const { enrol, count, identity } = await setup();
    expect((await identity(true)).status).toBe(200);
    await enrol(SLUG, DEV_1);
    await enrol(OTHER, DEV_2);
    expect(await count("identity_restore_keys", SLUG)).toBe(1);

    expect((await identity(false)).status).toBe(200);
    expect(await count("identity_restore_keys", SLUG)).toBe(0);
    expect(await count("identity_restore_origins", SLUG)).toBe(0);

    expect((await identity(true)).status).toBe(200);
    expect(await count("identity_restore_keys", SLUG)).toBe(0);
    expect(await count("identity_restore_origins", SLUG)).toBe(0);
    // Another product's key is untouched.
    expect(await count("identity_restore_keys", OTHER)).toBe(1);
    expect(await count("identity_restore_origins", OTHER)).toBe(1);
  });

  it("a key no device backs goes when Identity is turned off, with one row naming why", async () => {
    const { straggler, count, identity, purges } = await setup();
    expect((await identity(true)).status).toBe(200);
    await straggler(SLUG, DEV_1, "rk_AAAAAAAAAAAAAAAAAAAAAA");
    await straggler(OTHER, DEV_2, "rk_BBBBBBBBBBBBBBBBBBBBBB");

    expect((await identity(false)).status).toBe(200);
    expect(await count("identity_restore_keys", SLUG)).toBe(0);
    expect(await count("identity_restore_origins", SLUG)).toBe(0);
    expect(await count("identity_restore_keys", OTHER)).toBe(1);
    const rows = await purges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_kind: "product",
      target_id: SLUG,
      actor_name: "Ada",
      summary:
        "Purged 1 restore key(s): Identity is off, so a key cannot be revoked.",
    });
    // Neither the id nor a hash reaches the trail.
    expect(JSON.stringify(rows)).not.toContain("rk_AAAA");
    expect(JSON.stringify(rows)).not.toContain("0".repeat(64));
  });

  it("every services write while Identity is off purges again, as a resync does", async () => {
    const { w, straggler, count, identity, purges } = await setup();
    expect((await identity(false)).status).toBe(200);
    await straggler(SLUG, DEV_1, "rk_AAAAAAAAAAAAAAAAAAAAAA");
    const row = (await getProduct(w.db, SLUG))!;
    await applyServiceTransitions(
      w.env,
      w.db,
      SLUG,
      parseServices(row.services_json).services,
      { sub: "manifest", name: "Manifest resync", email: null },
      NOW + 1,
    );
    expect(await count("identity_restore_keys", SLUG)).toBe(0);
    expect(await purges()).toHaveLength(1);
    // Nothing left: the next write adds no row.
    await applyServiceTransitions(
      w.env,
      w.db,
      SLUG,
      parseServices(row.services_json).services,
      { sub: "manifest", name: "Manifest resync", email: null },
      NOW + 2,
    );
    expect(await purges()).toHaveLength(1);
  });

  it("a key left while Identity was off goes when the console turns it back on, and the row says so", async () => {
    const { straggler, count, identity, purges } = await setup();
    expect((await identity(false)).status).toBe(200);
    await straggler(SLUG, DEV_1, "rk_AAAAAAAAAAAAAAAAAAAAAA");
    expect((await identity(true)).status).toBe(200);
    expect(await count("identity_restore_keys", SLUG)).toBe(0);
    expect(await count("identity_restore_origins", SLUG)).toBe(0);
    const rows = await purges();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe(
      "Purged 1 restore key(s): Identity was turned back on.",
    );
  });

  it("a write that leaves Identity on purges nothing and writes no row", async () => {
    const { w, straggler, count, identity, purges } = await setup();
    expect((await identity(true)).status).toBe(200);
    await straggler(SLUG, DEV_1, "rk_AAAAAAAAAAAAAAAAAAAAAA");
    const res = await identity(true);
    expect(res.status).toBe(200);
    expect(await count("identity_restore_keys", SLUG)).toBe(1);
    expect(await purges()).toHaveLength(0);
    void w;
  });
});
