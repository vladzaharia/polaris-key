/**
 * I-49.5: the operator's "Purge restore keys" (`POST …/identity/restore/purge`; WIRE-CONTRACT-V5
 * §12.11.8, "Revocation"). A step-up route with the product slug typed; it deletes every restore
 * key and origin mark of the one product, writes one audit row naming the operator and the count,
 * and runs whatever the launch gate, the product setting or the Identity toggle say.
 *
 * I-49.8: turning Identity back on ends the product's keys too (`DELETE restore` is 404 while
 * Identity is off), through a services-write listener (`restore/servicesListener.ts`).
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
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { servicesOn } from "../../transcripts/world.js";

const SLUG = "djdl";
const OTHER = "other";
const DEV_1 = "1".repeat(32);
const DEV_2 = "2".repeat(32);
const DEV_3 = "3".repeat(32);
const SUBJECT = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const PATH = `/api/products/${SLUG}/identity/restore/purge`;

async function setup() {
  const w = await adminWorld({ products: [SLUG] });
  await seedProduct(w.db, OTHER);
  const fresh = await w.login({
    sub: "u1",
    name: "Ada",
    email: "ada@x.io",
    groups: ["platform-admins"],
    authTime: NOW,
    stepUp: true,
  });
  for (const [product, device] of [
    [SLUG, DEV_1],
    [SLUG, DEV_2],
    [OTHER, DEV_3],
  ] as const) {
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
  }
  const count = async (table: string, product: string) =>
    (await w.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE product = ?`,
      product,
    ))!.n;
  return { w, fresh, count };
}

describe("purge restore keys", () => {
  it("needs a fresh step-up", async () => {
    const { w, count } = await setup();
    const res = await w.call("POST", PATH, { body: { confirmSlug: SLUG } });
    expect(res.status).toBe(403);
    expect(
      ((await res.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("step_up_required");
    expect(await count("identity_restore_keys", SLUG)).toBe(2);
  });

  it("needs the product slug typed", async () => {
    const { w, fresh, count } = await setup();
    for (const body of [{}, { confirmSlug: "nope" }, { confirmSlug: OTHER }]) {
      const res = await w.call("POST", PATH, { as: fresh, body });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(await count("identity_restore_keys", SLUG)).toBe(2);
  });

  it("deletes every key and origin mark of this product only, and audits the count", async () => {
    const { w, fresh, count } = await setup();
    const res = await w.call("POST", PATH, {
      as: fresh,
      body: { confirmSlug: SLUG },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, purged: 2 });
    expect(await count("identity_restore_keys", SLUG)).toBe(0);
    expect(await count("identity_restore_origins", SLUG)).toBe(0);
    // Another product's keys are untouched.
    expect(await count("identity_restore_keys", OTHER)).toBe(1);
    expect(await count("identity_restore_origins", OTHER)).toBe(1);
    const audit = (await listAudit(w.db, SLUG)).filter(
      (a) => a.action === "identity.restore.purge",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      target_kind: "product",
      target_id: SLUG,
      summary: "Purged 2 restore key(s).",
    });
    expect(audit[0]!.actor_name).toBe("Ada");
    // No id, hash or secret reaches the trail.
    const keys = await w.db.all<{ id: string; secret_hash: string }>(
      "SELECT id, secret_hash FROM identity_restore_keys",
    );
    expect(JSON.stringify(audit)).not.toContain(keys[0]!.secret_hash);
  });

  it("runs while the launch gate, the setting and Identity are all off, and twice", async () => {
    const { w, fresh, count } = await setup();
    (w.env as unknown as Record<string, unknown>).LAUNCH_IDENTITY_RESTORE =
      "off";
    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.restore', 'false', 'manifest', ?, 'test')`,
      SLUG,
      NOW,
    );
    const first = await w.call("POST", PATH, {
      as: fresh,
      body: { confirmSlug: SLUG },
    });
    expect(await first.json()).toEqual({ ok: true, purged: 2 });
    const again = await w.call("POST", PATH, {
      as: fresh,
      body: { confirmSlug: SLUG },
    });
    expect(await again.json()).toEqual({ ok: true, purged: 0 });
    expect(await count("identity_restore_keys", SLUG)).toBe(0);
  });

  it("is refused to a member without the sign-in area, and to a GET", async () => {
    const { w, fresh } = await setup();
    const weak = await w.login({
      sub: "u9",
      name: "Bob",
      email: "b@x.io",
      groups: [],
      authTime: NOW,
      stepUp: true,
    });
    const res = await w.call("POST", PATH, {
      as: weak,
      body: { confirmSlug: SLUG },
    });
    expect(res.status).toBe(403);
    const get = await w.call("GET", PATH, { as: fresh });
    expect(get.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Identity turned back on ends the restore keys of the product", () => {
  const SERVICES = `/api/products/${SLUG}/services`;
  type T = Awaited<ReturnType<typeof setup>>;
  const reasons = async (t: T) =>
    (await listAudit(t.w.db, SLUG))
      .filter((a) => a.action === "identity.restore.purge")
      .map((a) => a.summary);
  /** The console's PATCH, which must be accepted. */
  const identity = async (t: T, enabled: boolean): Promise<void> => {
    const res = await t.w.call("PATCH", SERVICES, {
      as: t.fresh,
      body: { services: { identity: { enabled } } },
    });
    expect(res.status).toBe(200);
  };
  /** Identity on without the listener hearing of it: the keys the setup wrote stay. */
  const identityOn = ({ w }: T) =>
    setServices(
      w.db,
      SLUG,
      serializeServices({ services: servicesOn("config", "identity") }),
      "admin",
      NOW,
    );
  /** The product's keys and origin marks are gone; another product's stay. */
  const expectEnded = async (t: T): Promise<void> => {
    expect(await t.count("identity_restore_keys", SLUG)).toBe(0);
    expect(await t.count("identity_restore_origins", SLUG)).toBe(0);
    expect(await t.count("identity_restore_keys", OTHER)).toBe(1);
    expect(await t.count("identity_restore_origins", OTHER)).toBe(1);
  };
  /** The keys stay and the device rows behind them go, so no device event can have ended them. */
  const orphan = ({ w }: T) => w.db.run("DELETE FROM devices");

  it("enrol, Identity off, Identity on: the key and its origin mark are gone", async () => {
    const t = await setup();
    await identityOn(t);
    expect(await t.count("identity_restore_keys", SLUG)).toBe(2);
    await identity(t, false);
    await identity(t, true);
    await expectEnded(t);
  });

  it("a key no device event ended survives Identity off and goes when it is turned back on, with one row naming why and no id", async () => {
    const t = await setup();
    await identityOn(t);
    await orphan(t);
    await identity(t, false);
    expect(await t.count("identity_restore_keys", SLUG)).toBe(2);
    expect(await reasons(t)).toEqual([]);
    await identity(t, true);
    await expectEnded(t);
    expect(await reasons(t)).toEqual([
      "Purged 2 restore key(s): Identity was turned back on.",
    ]);
    const row = (await listAudit(t.w.db, SLUG)).find(
      (a) => a.action === "identity.restore.purge",
    );
    expect(row).toMatchObject({ target_id: SLUG, actor_name: "Ada" });
    expect(JSON.stringify(row)).not.toContain("rk_");
  });

  it("a manifest resync that turns Identity back on purges too, as the actor it ran as", async () => {
    const t = await setup();
    await identityOn(t);
    await orphan(t);
    const off = servicesOn("config");
    const on = servicesOn("config", "identity");
    const actor = { sub: "manifest", name: "Manifest resync", email: null };
    // A resync that leaves Identity off, or on, is not a transition.
    await applyServiceTransitions(t.w.env, t.w.db, SLUG, off, actor, NOW + 1, {
      before: off,
    });
    await applyServiceTransitions(t.w.env, t.w.db, SLUG, on, actor, NOW + 2, {
      before: on,
    });
    await applyServiceTransitions(t.w.env, t.w.db, SLUG, on, actor, NOW + 3);
    expect(await t.count("identity_restore_keys", SLUG)).toBe(2);
    await applyServiceTransitions(t.w.env, t.w.db, SLUG, on, actor, NOW + 4, {
      before: off,
    });
    expect(await t.count("identity_restore_keys", SLUG)).toBe(0);
    expect(await reasons(t)).toHaveLength(1);
    // Nothing left: turning it on again adds no row.
    await applyServiceTransitions(t.w.env, t.w.db, SLUG, on, actor, NOW + 5, {
      before: off,
    });
    expect(await reasons(t)).toHaveLength(1);
  });

  it("a write that leaves Identity on purges nothing and writes no row", async () => {
    const t = await setup();
    await identityOn(t);
    await identity(t, true);
    expect(await t.count("identity_restore_keys", SLUG)).toBe(2);
    expect(await reasons(t)).toEqual([]);
  });
});
