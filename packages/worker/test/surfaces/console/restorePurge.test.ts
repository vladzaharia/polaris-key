/**
 * I-49.5: the operator's "Purge restore keys" (`POST …/identity/restore/purge`; WIRE-CONTRACT-V5
 * §12.11.8, "Revocation"). A step-up route with the product slug typed; it deletes every restore
 * key and origin mark of the one product, writes one audit row naming the operator and the count,
 * and runs whatever the launch gate, the product setting or the Identity toggle say.
 */
import { describe, expect, it } from "vitest";
import { NOW, seedProduct } from "../../seed.js";
import { adminWorld } from "../../adminWorld.js";
import {
  markRestoreOrigin,
  mintRestoreKey,
} from "../../../src/services/identity/restore/store.js";
import { listAudit } from "../../../src/core/audit.js";

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
    await mintRestoreKey(w.env, w.db, {
      product,
      deviceId: device,
      subject: SUBJECT,
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
