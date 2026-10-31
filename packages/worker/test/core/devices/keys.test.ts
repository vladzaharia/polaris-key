// Device keys store (CC-03.1): upsert and rotation, the unique agreeKey, account listing, delete on
// purge, and the `keys` proof of possession.
import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import { makeTestDb } from "../../helpers.js";
import {
  DeviceKeysConflictError,
  DeviceKeysInvalidError,
  accountDeviceKeys,
  deleteDeviceKeys,
  deviceSignKey,
  getDeviceKeys,
  isValidAgreeKey,
  isValidSignKey,
  upsertDeviceKeys,
} from "../../../src/core/devices/keys.js";
import {
  keyPopMessage,
  verifyKeyPop,
} from "../../../src/core/devices/proof.js";
import {
  purgeDeviceData,
  stmtsDeauthorizeDevice,
} from "../../../src/core/devices/store.js";
import type { SqliteDb } from "../../../src/db/sqlite.js";

const P = "djdl";
const PS_ONE = "ps_" + "A".repeat(22);
const PS_TWO = "ps_" + "B".repeat(22);

/** A live account subject, so the principal rule resolves it. */
async function seedSubject(db: SqliteDb, subject: string): Promise<void> {
  const id = `acc_${subject.slice(3, 6)}`;
  await db.run(
    "INSERT INTO accounts (id, created_at, modified_at) VALUES (?, 1, 1)",
    id,
  );
  await db.run(
    "INSERT INTO account_product_subjects (account_id, product, subject, created_at) VALUES (?, ?, ?, 1)",
    id,
    P,
    subject,
  );
}
const b64 = (b: Uint8Array): string => base64UrlEncodeBytes(b);

async function signPair(): Promise<{
  signKey: string;
  priv: CryptoKey;
}> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
  );
  return { signKey: b64(raw), priv: kp.privateKey };
}

function agree(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  raw[31]! &= 0x7f;
  return b64(raw);
}

/** True when the key's top bit is set: it is not a canonical agreement key. */
function b64FirstBitSet(k: string): boolean {
  const raw = base64UrlDecode(k);
  return (raw[31]! & 0x80) !== 0;
}

async function keys(): Promise<{
  signKey: string;
  agreeKey: string;
  priv: CryptoKey;
}> {
  const s = await signPair();
  return { ...s, agreeKey: agree() };
}

async function seedDevice(
  db: SqliteDb,
  deviceId: string,
  subject: string | null,
  status = "authorized",
): Promise<void> {
  // the licence row is not the subject of this test
  await db.run("PRAGMA foreign_keys = OFF");
  await db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject)
     VALUES (?, ?, 'lic_1', ?, 1, 1, ?)`,
    P,
    deviceId,
    status,
    subject,
  );
}

describe("device keys store", () => {
  it("registers once, keeps key_seq for the same keys and bumps it on a rotation", async () => {
    const db = makeTestDb();
    const a = await keys();
    expect(await upsertDeviceKeys(db, P, "dev_a", a, 100)).toEqual({
      keySeq: 1,
      changed: true,
      rotated: false,
    });
    expect(await upsertDeviceKeys(db, P, "dev_a", a, 200)).toEqual({
      keySeq: 1,
      changed: false,
      rotated: false,
    });
    const b = await keys();
    expect(await upsertDeviceKeys(db, P, "dev_a", b, 300)).toEqual({
      keySeq: 2,
      changed: true,
      rotated: true,
    });
    const row = await getDeviceKeys(db, P, "dev_a");
    expect(row).toMatchObject({
      sign_key: b.signKey,
      agree_key: b.agreeKey,
      key_seq: 2,
      created_at: 100,
      rotated_at: 300,
    });
    expect(await deviceSignKey(db, P, "dev_a")).toBe(b.signKey);
    expect(await deviceSignKey(db, P, "dev_none")).toBeNull();
  });

  it("refuses an agreeKey another device of the product holds, but not across products", async () => {
    const db = makeTestDb();
    const a = await keys();
    await upsertDeviceKeys(db, P, "dev_a", a, 1);
    const s = await signPair();
    await expect(
      upsertDeviceKeys(db, P, "dev_b", { ...s, agreeKey: a.agreeKey }, 2),
    ).rejects.toBeInstanceOf(DeviceKeysConflictError);
    expect(await getDeviceKeys(db, P, "dev_b")).toBeNull();
    await upsertDeviceKeys(
      db,
      "other",
      "dev_b",
      { ...s, agreeKey: a.agreeKey },
      2,
    );
  });

  it("a key string is held by one device and one role per product", async () => {
    const db = makeTestDb();
    const a = await keys();
    await upsertDeviceKeys(db, P, "dev_a", a, 1);
    // Another device's signing key, as a signing key.
    await expect(
      upsertDeviceKeys(
        db,
        P,
        "dev_b",
        { ...(await keys()), signKey: a.signKey },
        2,
      ),
    ).rejects.toBeInstanceOf(DeviceKeysConflictError);
    // An agreement key equal to another device's signing key (one that reads as a valid agreement key).
    let s = await signPair();
    while (b64FirstBitSet(s.signKey)) s = await signPair();
    await upsertDeviceKeys(
      db,
      P,
      "dev_c",
      { signKey: s.signKey, agreeKey: agree() },
      3,
    );
    await expect(
      upsertDeviceKeys(
        db,
        P,
        "dev_b",
        { signKey: (await signPair()).signKey, agreeKey: s.signKey },
        4,
      ),
    ).rejects.toBeInstanceOf(DeviceKeysConflictError);
    // One key in both roles.
    await expect(
      upsertDeviceKeys(
        db,
        P,
        "dev_d",
        { signKey: s.signKey, agreeKey: s.signKey },
        5,
      ),
    ).rejects.toBeInstanceOf(DeviceKeysConflictError);
    expect(await getDeviceKeys(db, P, "dev_b")).toBeNull();
    expect(await getDeviceKeys(db, P, "dev_d")).toBeNull();
    // Another product is a separate space.
    await upsertDeviceKeys(
      db,
      "other",
      "dev_b",
      { ...(await keys()), signKey: a.signKey },
      6,
    );
  });

  it("a rotation that matched no row is refused when another set was stored, and kept unchanged for the same set", async () => {
    const db = makeTestDb();
    await upsertDeviceKeys(db, P, "dev_a", await keys(), 1);
    const racing = (
      write: (want: { signKey: string; agreeKey: string }) => string[],
    ) => {
      const wrapped = Object.create(db) as SqliteDb;
      return (want: { signKey: string; agreeKey: string }) => {
        wrapped.batchChanges = async (stmts) => {
          const [sql, ...params] = write(want);
          await db.run(sql!, ...params);
          return db.batchChanges!(stmts);
        };
        return wrapped;
      };
    };
    // A different set lands between the read and the write: the loser is refused.
    const want = await keys();
    const other = await keys();
    const lose = racing(() => [
      "UPDATE device_keys SET sign_key = ?, agree_key = ?, key_seq = key_seq + 1 WHERE product = ? AND device_id = ?",
      other.signKey,
      other.agreeKey,
      P,
      "dev_a",
    ])(want);
    await expect(
      upsertDeviceKeys(lose, P, "dev_a", want, 2),
    ).rejects.toBeInstanceOf(DeviceKeysInvalidError);
    // The same set lands: the answer is correct, nothing changed here.
    const same = racing(() => [
      "UPDATE device_keys SET sign_key = ?, agree_key = ?, key_seq = key_seq + 1 WHERE product = ? AND device_id = ?",
      want.signKey,
      want.agreeKey,
      P,
      "dev_a",
    ])(want);
    await expect(
      upsertDeviceKeys(same, P, "dev_a", want, 3),
    ).resolves.toMatchObject({
      changed: false,
      rotated: false,
    });
  });

  it("the unique index is the arbiter when the read-then-write loses a race", async () => {
    const db = makeTestDb();
    const a = await keys();
    await upsertDeviceKeys(db, P, "dev_a", a, 1);
    await expect(
      db.run(
        `INSERT INTO device_keys (product, device_id, sign_key, agree_key, created_at)
         VALUES (?, 'dev_x', 'x', ?, 1)`,
        P,
        a.agreeKey,
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("refuses keys that are malformed, non-canonical or of low or small order", async () => {
    const db = makeTestDb();
    const good = await keys();
    const bad: Array<[string, string]> = [
      ["short", good.agreeKey],
      [good.signKey + "A", good.agreeKey],
      [b64(new Uint8Array(32)), good.agreeKey], // small-order sign key
      [good.signKey, b64(new Uint8Array(32))], // low-order agree key
      [good.signKey, b64(Uint8Array.from([1, ...new Uint8Array(31)]))],
      [good.signKey, b64(Uint8Array.from([...new Uint8Array(31), 0x80]))],
      [good.signKey, ""],
    ];
    for (const [signKey, agreeKey] of bad) {
      await expect(
        upsertDeviceKeys(db, P, "dev_a", { signKey, agreeKey }, 1),
      ).rejects.toBeInstanceOf(DeviceKeysInvalidError);
    }
    expect(await getDeviceKeys(db, P, "dev_a")).toBeNull();
    // 43 chars that decode to 32 bytes but spell the last symbol non-canonically
    expect(isValidAgreeKey(good.agreeKey.slice(0, 42) + "B")).toBe(false);
    expect(isValidSignKey(good.signKey)).toBe(true);
    expect(isValidSignKey(undefined)).toBe(false);
  });

  it("lists the authorized devices bound to a subject, in device order", async () => {
    const db = makeTestDb();
    await seedSubject(db, PS_ONE);
    await seedSubject(db, PS_TWO);
    await seedDevice(db, "dev_b", PS_ONE);
    await seedDevice(db, "dev_a", PS_ONE);
    await seedDevice(db, "dev_gone", PS_ONE, "deauthorized");
    await seedDevice(db, "dev_other", PS_TWO);
    await seedDevice(db, "dev_unbound", null);
    await seedDevice(db, "dev_nokeys", PS_ONE);
    for (const id of [
      "dev_a",
      "dev_b",
      "dev_gone",
      "dev_other",
      "dev_unbound",
    ]) {
      await upsertDeviceKeys(db, P, id, await keys(), 1);
    }
    // a device that names no licence has its binding as its principal
    await db.run("UPDATE devices SET license_id = ''");
    const list = await accountDeviceKeys(db, P, PS_ONE);
    expect(list.map((d) => d.deviceId)).toEqual(["dev_a", "dev_b"]);
    expect(list[0]).toMatchObject({ keySeq: 1 });
    expect(await accountDeviceKeys(db, "other", PS_ONE)).toEqual([]);
  });

  it("goes with the device: delete, purge and a deauthorize batch", async () => {
    const db = makeTestDb();
    for (const id of ["d1", "d2", "d3"]) {
      await seedDevice(db, id, PS_ONE);
      await upsertDeviceKeys(db, P, id, await keys(), 1);
    }
    await deleteDeviceKeys(db, P, "d1");
    await deleteDeviceKeys(db, P, "d1"); // none left: no error
    expect(await getDeviceKeys(db, P, "d1")).toBeNull();
    await purgeDeviceData(db, P, "d2");
    expect(await getDeviceKeys(db, P, "d2")).toBeNull();
    // the batch is guarded by the licence the caller proved
    await db.batch(stmtsDeauthorizeDevice(P, "d3", "lic_other"));
    expect(await getDeviceKeys(db, P, "d3")).not.toBeNull();
    await db.batch(stmtsDeauthorizeDevice(P, "d3", "lic_1"));
    expect(await getDeviceKeys(db, P, "d3")).toBeNull();
  });
});

describe("keys proof of possession", () => {
  const now = 1_761_300_000;
  async function proof(
    over: Partial<{ issuedAt: number; deviceId: string }> = {},
  ) {
    const k = await keys();
    const input = {
      product: P,
      deviceId: over.deviceId ?? "dev_a",
      signKey: k.signKey,
      agreeKey: k.agreeKey,
      issuedAt: over.issuedAt ?? now,
    };
    const msg = keyPopMessage(input)!;
    const sig = b64(
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", k.priv, msg as BufferSource),
      ),
    );
    return { ...input, sig, now, priv: k.priv };
  }

  it("signs the pkey-proof/1 lines for purpose keys", async () => {
    const p = await proof();
    const text = new TextDecoder().decode(keyPopMessage(p)!);
    expect(text).toBe(
      [
        "pkey-proof/1",
        "keys",
        P,
        "dev_a",
        `${p.signKey}.${p.agreeKey}.${now}`,
        "-",
      ].join("\n"),
    );
    expect(await verifyKeyPop(p)).toBe(true);
  });

  it("accepts the edges of the 300 s window and refuses outside it", async () => {
    for (const d of [-300, 300, 0]) {
      expect(await verifyKeyPop(await proof({ issuedAt: now + d }))).toBe(true);
    }
    for (const d of [-301, 301]) {
      expect(await verifyKeyPop(await proof({ issuedAt: now + d }))).toBe(
        false,
      );
    }
  });

  it("binds the product, device, both keys and the time", async () => {
    const p = await proof();
    expect(await verifyKeyPop({ ...p, product: "other" })).toBe(false);
    expect(await verifyKeyPop({ ...p, deviceId: "dev_b" })).toBe(false);
    expect(await verifyKeyPop({ ...p, agreeKey: agree() })).toBe(false);
    const other = await signPair();
    expect(await verifyKeyPop({ ...p, signKey: other.signKey })).toBe(false);
    expect(await verifyKeyPop({ ...p, issuedAt: p.issuedAt + 1 })).toBe(false);
  });

  it("refuses a bad signature shape and a field that holds a newline", async () => {
    const p = await proof();
    expect(await verifyKeyPop({ ...p, sig: "" })).toBe(false);
    expect(await verifyKeyPop({ ...p, sig: p.sig.slice(0, 85) })).toBe(false);
    expect(await verifyKeyPop({ ...p, sig: p.sig.slice(0, 85) + "B" })).toBe(
      false,
    );
    expect(await verifyKeyPop({ ...p, sig: b64(new Uint8Array(64)) })).toBe(
      false,
    );
    expect(keyPopMessage({ ...p, deviceId: "dev\nx" })).toBeNull();
    expect(keyPopMessage({ ...p, product: "a\nb" })).toBeNull();
    expect(keyPopMessage({ ...p, issuedAt: 1.5 })).toBeNull();
    expect(await verifyKeyPop({ ...p, deviceId: "dev_a\n" })).toBe(false);
  });
});
