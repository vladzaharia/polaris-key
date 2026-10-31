/**
 * U-11a.1: `GET /manage/api/products/<slug>/sync/subjects/<subject>`, the Data tab's summary.
 * Settings today, the collections and files when the object has their tables (read defensively),
 * the key ring with its device labels, and one audit row per load (D-13). Driven through the real
 * admin dispatcher and the real `CloudSyncDO` over the SQLite mock.
 *
 * What it pins: no value, record id or file name in either mode, another product's subject is a
 * `404` (and writes no audit row), and the read creates nothing in an object that was never
 * written. Admin routes are narrative-only (rule 10).
 */

import { describe, expect, it } from "vitest";
import { handleAdmin } from "../../../src/console/index.js";
import { ADMIN_COOKIE } from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { createRing } from "../../../src/core/keyring/store.js";
import { setDeviceLabel } from "../../../src/core/devices/store.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { NOW, seedProduct } from "../../seed.js";
import {
  DEVICE,
  mut,
  push,
  SLUG,
  world,
  type World,
} from "./cloudSyncAbuseWorld.js";

const GROUP = "platform-admins";
const OTHER = "other";

const stringKey = (key: string, user?: object) => ({
  key,
  kind: "config",
  category: "data",
  label: key,
  description: `The ${key} setting`,
  schema: { type: "string" },
  ...(user ? { user } : {}),
});
const catalog = (
  encryption: "server" | "e2e",
  collections: object[] = [],
): unknown => ({
  schemaVersion: 1,
  entries: [
    stringKey("ui.theme"),
    stringKey("game.volume", { sync: "platform" }),
  ],
  cloudSync: { encryption, ...(collections.length ? { collections } : {}) },
});

/** A shaped envelope, version byte 1 and one padded block: the server never decodes it. */
const SEALED = Buffer.concat([Buffer.from([1]), Buffer.alloc(112, 7)]).toString(
  "base64url",
);
/** A blinded name of an open setting. */
const blind = (n: number): string => `x:${"A".repeat(42)}${n}`;

const SECRET_VALUE = "SECRET-VALUE-9f3a";
const OPEN_NAME = "my.private.name";

async function adminWorld(
  opts: { encryption?: "server" | "e2e"; collections?: object[] } = {},
) {
  const encryption = opts.encryption ?? "server";
  const w = await world({
    catalog: catalog(encryption, opts.collections),
    gate: "on",
  });
  w.env.ADMIN_SESSION_SECRET = "subject-admin-secret";
  w.env.PLATFORM_ADMIN_GROUP = GROUP;
  // A second product with its own person, so a subject of another product can be asked for here.
  await seedProduct(w.db, OTHER);
  const on = { enabled: true };
  const off = { enabled: false };
  await setServices(
    w.db,
    OTHER,
    serializeServices({
      services: {
        license: on,
        config: on,
        release: off,
        distribution: off,
        update: off,
        identity: on,
        sync: on,
        commerce: off,
        connect: off,
      },
    }),
    "manifest",
    NOW,
  );
  const r = await signIn(
    w.db,
    { issuerKey: "email", subject: "ada@example.com", kind: "email" },
    NOW,
    { unfenced: true, product: { slug: OTHER } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  const otherSubject = r.subject!;
  const token = (
    await consoleTestSession(
      w.env,
      w.db,
      {
        sub: "u1",
        groups: [GROUP],
        name: "A",
        email: "a@example.test",
      },
      NOW,
    )
  ).token;
  const get = (product: string, subject: string, tk = token) => {
    const path = `/api/products/${product}/sync/subjects/${subject}`;
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        headers: { cookie: `${ADMIN_COOKIE}=${tk}` },
      }),
      w.env,
      w.db,
      path,
      { now: NOW },
    );
  };
  const audits = (product = SLUG) =>
    w.db.all<{
      action: string;
      target_kind: string | null;
      target_id: string | null;
      summary: string;
    }>(
      "SELECT action, target_kind, target_id, summary FROM audit WHERE product = ? AND action LIKE 'sync.%'",
      product,
    );
  const pushed = async (mutations: ReturnType<typeof mut>[]): Promise<void> => {
    const res = await push(w, mutations);
    expect(res.status).toBe(200);
  };
  return { w, otherSubject, token, get, audits, pushed };
}

/** The person's Durable Object database, for the tables a later schema version adds. */
function objectSql(w: World): { exec(sql: string): void } {
  const inst = w.ns.instances.get(`${SLUG}:${w.subject}`);
  if (!inst) throw new Error("no object");
  return inst.storage.sql.db;
}

describe("GET sync/subjects/<subject>: server mode", () => {
  it("summarises settings by name and size, open settings as a count, and audits the load once", async () => {
    const { w, get, audits, pushed } = await adminWorld();
    await pushed([
      mut("ui.theme", "set", { value: SECRET_VALUE }),
      mut("game.volume", "set", {
        value: SECRET_VALUE,
        target: { setting: "game.volume", scope: "platform" },
      }),
      mut(OPEN_NAME, "set", { value: SECRET_VALUE }),
    ]);
    const res = await get(SLUG, w.subject);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      enabled: true,
      empty: false,
      encryption: "server",
      encryptionSince: null,
      uploadsOpen: 0,
      ring: null,
      collections: [],
    });
    expect(body.settings.declared.map((s: { key: string }) => s.key)).toEqual([
      "game.volume",
      "ui.theme",
    ]);
    const theme = body.settings.declared.find(
      (s: { key: string }) => s.key === "ui.theme",
    );
    expect(theme.bytes).toBe("ui.theme".length + `"${SECRET_VALUE}"`.length);
    expect(theme.platform).toBeNull();
    expect(theme.updatedAt).toBeGreaterThan(0);
    expect(
      body.settings.declared.find(
        (s: { key: string }) => s.key === "game.volume",
      ).platform,
    ).toBeTypeOf("string");
    expect(body.settings.open).toEqual({
      count: 1,
      bytes: OPEN_NAME.length + `"${SECRET_VALUE}"`.length,
    });
    expect(body.usage.settings).toBe(3);
    // Sizes and names only: no value, and no open setting's name.
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(OPEN_NAME);
    expect(text).not.toContain(DEVICE);

    expect(await audits()).toEqual([
      {
        action: "sync.data.view",
        target_kind: "user",
        target_id: w.subject,
        summary: "Viewed Cloud Sync data",
      },
    ]);
    await get(SLUG, w.subject);
    expect(await audits()).toHaveLength(2);
  });

  it("reads defensively: collections and files from the tables an object has, nothing else", async () => {
    const { w, get, pushed } = await adminWorld({
      collections: [
        { name: "saves", template: "saves" },
        { name: "notes", label: "Notes" },
      ],
    });
    await pushed([mut("ui.theme", "set", { value: "dark" })]);
    // Before anything is written to them the declared collections read as empty.
    const before = (await (await get(SLUG, w.subject)).json()) as {
      collections: { name: string; label: string; records: number }[];
      uploadsOpen: number;
    };
    expect(before.collections.map((c) => [c.name, c.label, c.records])).toEqual(
      [
        ["saves", "Saves", 0],
        ["notes", "Notes", 0],
      ],
    );

    const sql = objectSql(w);
    sql.exec(`
      INSERT INTO records (collection, id, version, hlc, client_id, value_json, kind, deleted) VALUES
        ('saves', 'slot-1', 1, '000000000064:0000', 'c', '"aaaa"', 'value', 0),
        ('saves', 'slot-2', 2, '0000000000c8:0000', 'c', '"bbbb"', 'value', 0),
        ('saves', 'slot-3', 3, '0000001e8480:0000', 'c', '"gone"', 'value', 1),
        ('legacy', 'x', 4, '0000000f4240:0000', 'c', '1', 'value', 0);
      INSERT INTO files (collection, record_id, version, object_key, format, enc, size, sha256, status, created_at, client_id) VALUES
        ('saves', 'slot-1', 1, 'k1', 'raw', 'none', 1000, 'h', 'live', 0, 'c'),
        ('saves', 'slot-2', 1, 'k2', 'raw', 'none', 2000, 'h', 'live', 0, 'c'),
        ('saves', 'slot-1', 0, 'k0', 'raw', 'none', 500, 'h', 'revision', 0, 'c');
      INSERT INTO uploads (upload_id, collection, record_id, mode, format, enc, size, sha256, reserved_bytes, device_id, created_at, expires_at, state) VALUES
        ('u1', 'saves', 'slot-1', 'new', 'raw', 'none', 1, 'h', 1, 'd', 0, 1, 'open'),
        ('u2', 'saves', 'slot-1', 'new', 'raw', 'none', 1, 'h', 1, 'd', 0, 1, 'done'),
        ('u3', 'saves', 'slot-1', 'new', 'raw', 'none', 1, 'h', 1, 'd', 0, 1, 'open');
    `);
    const res = await get(SLUG, w.subject);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.uploadsOpen).toBe(2);
    expect(body.collections).toEqual([
      {
        name: "saves",
        label: "Saves",
        records: 2,
        bytes: "slot-1".length + 6 + ("slot-2".length + 6),
        files: 2,
        fileBytes: 3000,
        revisionBytes: 500,
        lastWriteAt: 2000,
      },
      {
        name: "notes",
        label: "Notes",
        records: 0,
        bytes: 0,
        files: 0,
        fileBytes: 0,
        revisionBytes: 0,
        lastWriteAt: null,
      },
      // A collection the catalog no longer declares still shows, by its name.
      {
        name: "legacy",
        label: "legacy",
        records: 1,
        bytes: "x".length + 1,
        files: 0,
        fileBytes: 0,
        revisionBytes: 0,
        lastWriteAt: 1000,
      },
    ]);
    // No record id, no file key and no value in the answer.
    for (const banned of ["slot-1", "slot-2", "k1", "aaaa", "bbbb", "gone"])
      expect(text).not.toContain(banned);
  });

  it("skips a table whose columns it does not recognise", async () => {
    const { w, get, pushed } = await adminWorld();
    await pushed([mut("ui.theme", "set", { value: "dark" })]);
    objectSql(w).exec(
      `DROP TABLE records; DROP TABLE uploads;
       CREATE TABLE records (a TEXT); INSERT INTO records VALUES ('x');
       CREATE TABLE uploads (a TEXT);`,
    );
    const body = (await (await get(SLUG, w.subject)).json()) as {
      collections: unknown[];
      uploadsOpen: number;
    };
    expect(body.collections).toEqual([]);
    expect(body.uploadsOpen).toBe(0);
  });
});

describe("GET sync/subjects/<subject>: end-to-end mode", () => {
  it("shows the mode, the sealed-since line and the ring's device labels, and still no value", async () => {
    const { w, get, pushed } = await adminWorld({ encryption: "e2e" });
    await pushed([
      mut("ui.theme", "set", { ct: SEALED }),
      mut(blind(1), "set", { ct: SEALED }),
    ]);
    await setDeviceLabel(w.db, SLUG, DEVICE, "Ada's laptop");
    expect(
      await createRing(w.db, {
        product: SLUG,
        subject: w.subject,
        ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
        rootKid: "kid-1",
        wrap: {
          deviceId: DEVICE,
          ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
          epoch: 1,
          kid: "kid-1",
          kem: 32,
          enc: "WRAP-ENC-SECRET",
          ct: "WRAP-CT-SECRET",
          by: DEVICE,
        },
        recoveryCt: "RECOVERY-SECRET",
        now: NOW - 60,
      }),
    ).toBe("created");
    const res = await get(SLUG, w.subject);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.encryption).toBe("e2e");
    expect(body.encryptionSince).toBeTypeOf("number");
    expect(body.settings.declared.map((s: { key: string }) => s.key)).toEqual([
      "ui.theme",
    ]);
    expect(body.settings.open.count).toBe(1);
    expect(body.ring).toEqual({
      kid: "kid-1",
      createdAt: NOW - 60,
      recoverySet: true,
      devices: ["Ada's laptop"],
    });
    for (const banned of [
      "WRAP-ENC-SECRET",
      "WRAP-CT-SECRET",
      "RECOVERY-SECRET",
      blind(1),
      SEALED,
      DEVICE,
    ])
      expect(text).not.toContain(banned);
  });

  it("names an unlabelled device, and carries when a reset ring's predecessor stops opening", async () => {
    const { w, get, pushed } = await adminWorld({ encryption: "e2e" });
    await pushed([mut("ui.theme", "set", { ct: SEALED })]);
    await createRing(w.db, {
      product: SLUG,
      subject: w.subject,
      ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
      rootKid: "kid-1",
      wrap: {
        deviceId: "dev-gone",
        ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
        epoch: 1,
        kid: "kid-1",
        kem: 32,
        enc: "e",
        ct: "c",
        by: "dev-gone",
      },
      now: NOW - 60,
    });
    const body = (await (await get(SLUG, w.subject)).json()) as {
      ring: { devices: string[]; recoverySet: boolean };
    };
    expect(body.ring.devices).toEqual(["Unnamed device"]);
    expect(body.ring.recoverySet).toBe(false);
  });
});

describe("GET sync/subjects/<subject>: scope and refusals", () => {
  it("refuses another product's subject with 404, both ways, and writes no audit row", async () => {
    const { w, otherSubject, get, audits } = await adminWorld();
    const mine = await get(SLUG, otherSubject);
    expect(mine.status).toBe(404);
    const theirs = await get(OTHER, w.subject);
    expect(theirs.status).toBe(404);
    expect(await audits()).toEqual([]);
    expect(await audits(OTHER)).toEqual([]);
    // The same answer as a subject nobody holds, so the route confirms nothing.
    const none = await get(SLUG, "ps_AAAAAAAAAAAAAAAAAAAAAA");
    expect(none.status).toBe(404);
    expect(await none.text()).toBe(await mine.clone().text());
    // A malformed subject never reaches the object.
    expect((await get(SLUG, "not-a-subject")).status).toBe(404);
    expect(w.ns.calls).toEqual([]);
  });

  it("creates nothing in an object that was never written", async () => {
    const { w, get } = await adminWorld();
    const res = await get(SLUG, w.subject);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      empty: true,
      settings: { declared: [], open: { count: 0, bytes: 0 } },
      usage: { bytes: 0, settings: 0 },
      encryptionSince: null,
    });
    const inst = w.ns.instances.get(`${SLUG}:${w.subject}`)!;
    const tables = inst.storage.sql.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    expect(tables).toEqual([]);
  });

  it("answers { enabled: false } while Cloud Sync is off, without touching the object", async () => {
    const { w, get, audits } = await adminWorld();
    const off = { enabled: false };
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: off,
          distribution: off,
          update: off,
          identity: { enabled: true },
          sync: off,
          commerce: off,
          connect: off,
        },
      }),
      "manifest",
      NOW,
    );
    const res = await get(SLUG, w.subject);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(await audits()).toEqual([]);
  });
});
