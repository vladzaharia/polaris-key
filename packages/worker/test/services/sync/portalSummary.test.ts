/**
 * U-12.5: `GET /api/products/<product>/sync`, Cloud Sync's summary for the Polaris Locker portal
 * (the `cloudSyncSummary` hook), and the hourly pull stamp of `clients.last_seen` that feeds its
 * device times. Driven through `handlePortalApi` and the real `CloudSyncDO` over the SQLite mock.
 *
 * What it pins: 404 when Sync is off, the product is unknown or the account is not linked (one
 * answer); the shape is the published schema; no value, setting name, record id, client id or
 * device id in either mode; `state` is one of active, paused, full; the pull stamp moves
 * `last_seen` at most hourly and never `writes`, `seq` or the pull's own answer.
 */

import { describe, expect, it } from "vitest";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { setDeviceLabel } from "../../../src/core/devices/store.js";
import { setServices } from "../../../src/core/products/store.js";
import {
  SERVICE_SLUGS,
  serializeServices,
  type ServicesMap,
} from "../../../src/core/services.js";
import { getOrCreateAccountByEmail } from "../../../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../../src/services/identity/portal/session.js";
import { recordSubjectErasure } from "../../../src/services/identity/accounts/subjectErasureLedger.js";
import { handlePortalApi } from "../../portalHarness.js";
import { asR2, R2Mock } from "../../r2Mock.js";
import { issuePortalSessionRow } from "../../portalSessionRow.js";
import { SPEC, validateAgainst } from "../../specSchema.js";
import {
  authed,
  CLIENT,
  DEVICE,
  mut,
  objectDb,
  pull,
  push,
  send,
  SLUG,
  world,
  type World,
} from "./cloudSyncAbuseWorld.js";
import { NOW } from "../../seed.js";

const SECRET_VALUE = "SECRET-VALUE-9f3a";
const OPEN_NAME = "my.private.name";

/** A signed-in portal session for an address: the cookie and the CSRF header it goes with. */
async function session(w: World, email: string) {
  const account = await getOrCreateAccountByEmail(w.db, email, NOW);
  const issued = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId: account.id, email, name: null },
    NOW,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${issued.token}`,
    csrf: issued.session.csrf,
  };
}

async function portal(
  w: World,
  path: string,
  who: { cookie: string; csrf: string },
) {
  w.env.PORTAL_SESSION_SECRET ??= "test-portal-session-secret";
  const url = new URL(`https://key.plrs.im${path}`);
  return handlePortalApi(
    new Request(url, {
      headers: { cookie: who.cookie, [PORTAL_CSRF_HEADER]: who.csrf },
    }) as unknown as Request,
    w.env,
    w.db,
    url.pathname,
    NOW,
  );
}

async function setup(catalog?: unknown, gate?: "on" | "off") {
  const secret = "test-portal-session-secret";
  const w = await world({
    ...(catalog ? { catalog } : {}),
    ...(gate ? { gate } : {}),
  });
  w.env.PORTAL_SESSION_SECRET = secret;
  // The account the world's sign-in created.
  const ada = await session(w, "ada@example.com");
  return { w, ada };
}

const sql = (w: World) =>
  objectDb(w) as unknown as {
    prepare(q: string): {
      get(...a: unknown[]): unknown;
      run(...a: unknown[]): unknown;
    };
  };
const clientRow = (w: World) =>
  sql(w)
    .prepare("SELECT last_seen AS s FROM clients WHERE client_id = ?")
    .get(CLIENT) as { s: number };
const meta = (w: World, k: string) =>
  (
    sql(w).prepare("SELECT value FROM meta WHERE key = ?").get(k) as
      | { value: string }
      | undefined
  )?.value;

describe("GET /api/products/<product>/sync", () => {
  it("shows a device label only while the device is still bound to this person", async () => {
    const { w, ada } = await setup();
    expect((await push(w, [mut("ui.theme", "set", { value: 1 })])).status).toBe(
      200,
    );
    await setDeviceLabel(w.db, SLUG, DEVICE, "Ada's Mac");
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = ?",
      "ps_someoneElse",
      SLUG,
      DEVICE,
    );
    const body = await (
      await portal(w, `/api/products/${SLUG}/sync`, ada)
    ).text();
    expect(body).not.toContain("Ada's Mac");
    expect(JSON.parse(body).devices[0].label).toBe("Unnamed device");
  });

  it("is rate limited per account and product", async () => {
    const { w, ada } = await setup();
    let last = 200;
    for (let i = 0; i < 61; i++)
      last = (await portal(w, `/api/products/${SLUG}/sync`, ada)).status;
    expect(last).toBe(429);
  });

  it("is the published shape and carries sizes and times only", async () => {
    const { w, ada } = await setup();
    expect(
      (
        await push(w, [
          mut("ui.theme", "set", { value: SECRET_VALUE }),
          mut(OPEN_NAME, "set", { value: SECRET_VALUE }),
        ])
      ).status,
    ).toBe(200);
    await setDeviceLabel(w.db, SLUG, DEVICE, "Ada's Mac");
    const res = await portal(w, `/api/products/${SLUG}/sync`, ada);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(validateAgainst("PortalCloudSyncSummary", body)).toEqual([]);
    expect(body).toMatchObject({
      encryption: "server",
      empty: false,
      state: "active",
      pausedSince: null,
    });
    expect(body.usage.bytes).toBeGreaterThan(0);
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].label).toBe("Ada's Mac");
    expect(body.devices[0].lastSyncAt).toBeGreaterThan(0);
    for (const hidden of [SECRET_VALUE, OPEN_NAME, "ui.theme", DEVICE, CLIENT])
      expect(text).not.toContain(hidden);
    const schema = SPEC.components.schemas.PortalCloudSyncSummary as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(
      Object.keys(body).sort(),
    );
  });

  it("an end-to-end product reads the same, and names no blinded setting", async () => {
    const { w, ada } = await setup(
      { schemaVersion: 1, entries: [], cloudSync: { encryption: "e2e" } },
      "on",
    );
    const res = await portal(w, `/api/products/${SLUG}/sync`, ada);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateAgainst("PortalCloudSyncSummary", body)).toEqual([]);
    expect(body).toMatchObject({ encryption: "e2e", empty: true, devices: [] });
  });

  it("an account with nothing here yet reads as empty and creates no object", async () => {
    const { w } = await setup();
    const bob = await session(w, "bob@example.com");
    // Not linked: the same 404 as a product that does not exist.
    const unlinked = await portal(w, `/api/products/${SLUG}/sync`, bob);
    const nope = await portal(w, `/api/products/nope/sync`, bob);
    expect(unlinked.status).toBe(404);
    expect(nope.status).toBe(404);
    expect(await unlinked.text()).toBe(await nope.text());
    expect(w.ns.calls).toEqual([]);
  });

  it("is 404 while Cloud Sync is off for the product", async () => {
    const { w, ada } = await setup();
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: Object.fromEntries(
          SERVICE_SLUGS.map((slug) => [slug, { enabled: slug === "license" }]),
        ) as ServicesMap,
      }),
      "manifest",
      NOW,
    );
    const res = await portal(w, `/api/products/${SLUG}/sync`, ada);
    expect(res.status).toBe(404);
    expect(w.ns.calls).toEqual([]);
  });

  it("state is paused while writes are on hold, full at the limit, else active", async () => {
    const { w, ada } = await setup();
    await push(w, [mut("ui.theme", "set", { value: SECRET_VALUE })]);
    const state = async () =>
      (await (await portal(w, `/api/products/${SLUG}/sync`, ada)).json()) as {
        state: string;
        pausedSince: number | null;
      };
    expect((await state()).state).toBe("active");
    await w.db.run(
      `INSERT OR REPLACE INTO sync_directory (product, subject, bytes, settings, records, record_bytes, files,
         file_bytes, revision_bytes, quota_bytes, tier_id, platform, last_active_at, updated_at)
       VALUES (?, ?, 1, 1, 0, 0, 0, 0, 0, 1, NULL, NULL, ?, ?)`,
      SLUG,
      w.subject,
      NOW,
      NOW,
    );
    expect((await state()).state).toBe("full");
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudSync.writesPaused', '"on"', 1, ?, 'test')`,
      NOW,
    );
    invalidatePlatformSettings(w.env, w.db);
    const paused = await state();
    expect(paused.state).toBe("paused");
    expect(paused.pausedSince).toBe(NOW);
  });

  it("state is removing while a recorded removal of this person's data is still owed (PX-18)", async () => {
    const { w, ada } = await setup();
    w.env.BLOBS = asR2(new R2Mock());
    await push(w, [mut("ui.theme", "set", { value: SECRET_VALUE })]);
    const read = async () => {
      const res = await portal(w, `/api/products/${SLUG}/sync`, ada);
      expect(res.status).toBe(200);
      return (await res.json()) as { state: string };
    };
    expect((await read()).state).toBe("active");
    // U-12.1 records the removal before it starts; while the subject row is still live (a store
    // that failed, a pass to come), the removal is owed.
    expect(await recordSubjectErasure(w.env, SLUG, w.subject, NOW)).toBe(
      "created",
    );
    const body = await read();
    expect(body.state).toBe("removing");
    expect(validateAgainst("PortalCloudSyncSummary", body)).toEqual([]);
    // Another product's ledger entry is not this one's.
    w.env.BLOBS = asR2(new R2Mock());
    await recordSubjectErasure(w.env, "other-product", w.subject, NOW);
    expect((await read()).state).toBe("active");
  });

  it("needs the session, and only answers GET", async () => {
    const { w, ada } = await setup();
    const url = new URL(`https://key.plrs.im/api/products/${SLUG}/sync`);
    const call = (method: string, headers: Record<string, string>) =>
      handlePortalApi(
        new Request(url, { method, headers }) as unknown as Request,
        w.env,
        w.db,
        url.pathname,
        NOW,
      );
    expect((await call("GET", {})).status).toBe(401);
    expect((await call("GET", { cookie: ada.cookie })).status).toBe(200);
    expect(
      (
        await call("POST", {
          cookie: ada.cookie,
          [PORTAL_CSRF_HEADER]: ada.csrf,
        })
      ).status,
    ).toBe(405);
  });
});

describe("the pull stamps clients.last_seen hourly", () => {
  // The device pulls with its client id.
  const pullAs = (w: World, clientId = CLIENT) =>
    send(w, authed(w), `/${SLUG}/sync?cursor=0&clientId=${clientId}`, "GET");

  it("moves a stale stamp, leaves a fresh one, and never writes, seq or the answer", async () => {
    const { w } = await setup();
    await push(w, [mut("ui.theme", "set", { value: SECRET_VALUE })]);
    const writes = meta(w, "writes");
    const seq = meta(w, "seq");
    const before = await (await pullAs(w)).text();

    sql(w)
      .prepare("UPDATE clients SET last_seen = 1 WHERE client_id = ?")
      .run(CLIENT);
    const first = await (await pullAs(w)).text();
    const stamped = clientRow(w).s;
    expect(stamped).toBeGreaterThan(1);

    // Within the hour: not touched again.
    const recent = stamped - 60;
    sql(w)
      .prepare("UPDATE clients SET last_seen = ? WHERE client_id = ?")
      .run(recent, CLIENT);
    await pullAs(w);
    expect(clientRow(w).s).toBe(recent);

    // The device-facing answer and the merge guard's counters did not move.
    expect(first).toBe(before);
    expect(meta(w, "writes")).toBe(writes);
    expect(meta(w, "seq")).toBe(seq);
    // A pull without a client id, or from an unknown one, stamps nothing and creates nothing.
    await pull(w);
    await pullAs(w, "c_BBBBBBBBBBBBBBBBBBBBBB");
    expect(
      (
        sql(w).prepare("SELECT COUNT(*) AS n FROM clients").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });
});
