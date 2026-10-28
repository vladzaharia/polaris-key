/// <reference types="@cloudflare/workers-types" />
// Device keys: spelling, replay, keySeq floor, seat filter, erasure and the signer's key check.
import { describe, expect, it } from "vitest";
import { base64UrlDecode } from "@polaris-key/jws";
import { NOW } from "../../seed.js";
import {
  b64,
  body,
  DEVICE as DEV_A,
  DEVICE_2 as DEV_B,
  newKeys,
  put,
  register,
  world,
} from "./keysFixture.js";
import {
  accountDeviceKeys,
  DeviceKeysInvalidError,
  getDeviceKeys,
  isValidAgreeKey,
  upsertDeviceKeys,
} from "../../../src/core/devices/keys.js";
import { setDeviceStatus } from "../../../src/core/devices/store.js";
import { writeDeviceSubject } from "../../../src/core/devices.js";
import { deleteProduct } from "../../../src/core/products/store.js";
import { assertConnectDoc } from "../../../src/core/signing.js";

describe("device keys hardening", () => {
  it("refuses every entry of the retired low-order list and accepts an ordinary key", () => {
    const retired = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
      "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    for (const hex of retired) {
      const raw = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
      expect(isValidAgreeKey(b64(raw)), hex).toBe(false);
    }
    const nine = new Uint8Array(32);
    nine[0] = 9;
    expect(isValidAgreeKey(b64(nine))).toBe(true);
  });

  it("refuses the top-bit spelling of an X25519 key at registration", async () => {
    const w = await world();
    const a = await newKeys();
    await upsertDeviceKeys(w.db, "djdl", DEV_A, a, NOW);
    const raw = base64UrlDecode(a.agreeKey).slice();
    raw[31]! |= 0x80; // the same point to X25519, a different string
    const b = await newKeys(raw);
    expect(isValidAgreeKey(b.agreeKey)).toBe(false);
    await expect(upsertDeviceKeys(w.db, "djdl", DEV_B, b, NOW)).rejects.toThrow(
      DeviceKeysInvalidError,
    );
  });

  it("refuses u >= p spellings and keeps accepting canonical keys", () => {
    const at = (low: number, high: number): string => {
      const raw = new Uint8Array(32).fill(0xff);
      raw[0] = low;
      raw[31] = high;
      return b64(raw);
    };
    expect(isValidAgreeKey(at(0xf0, 0x7f))).toBe(false); // p + 3
    expect(isValidAgreeKey(at(0xc0, 0x7f))).toBe(true); // below p
    const nine = new Uint8Array(32);
    nine[0] = 9;
    expect(isValidAgreeKey(b64(nine))).toBe(true);
  });

  it("the signer refuses a non-canonical agreeKey in a certificate and a roster", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    raw[31]! |= 0x80;
    const base = {
      iss: "key.plrs.im",
      aud: "djdl",
      sub: "ps_AAAAAAAAAAAAAAAAAAAAAA",
    };
    const entry = {
      deviceId: DEV_A,
      signKey: (await newKeys()).signKey,
      agreeKey: b64(raw),
    };
    expect(() =>
      assertConnectDoc(
        { ...base, ...entry, ringEpoch: 1, issuedAt: 10, expiresAt: 100 },
        "pkey-peer+jws",
      ),
    ).toThrow(/canonical/);
    expect(() =>
      assertConnectDoc(
        { ...base, epoch: 1, issuedAt: 10, expiresAt: 100, devices: [entry] },
        "pkey-ring+jws",
      ),
    ).toThrow(/canonical/);
  });

  it("a captured keys proof does not replay after a rotation", async () => {
    const w = await world();
    const token = await register(w, DEV_A);
    const k1 = await newKeys();
    const k2 = await newKeys();
    const p1 = await body(k1, DEV_A, NOW);
    const p2 = await body(k2, DEV_A, NOW + 5);
    expect((await put(w, token, p1)).body).toEqual({ keySeq: 1 });
    expect((await put(w, token, p2, NOW + 10)).body).toEqual({ keySeq: 2 });
    const replay = await put(w, token, p1, NOW + 20);
    expect(replay.status).toBe(400);
    expect((await getDeviceKeys(w.db, "djdl", DEV_A))?.sign_key).toBe(
      k2.signKey,
    );
  });

  it("a proof as old as the last accepted one is refused, a newer one is accepted", async () => {
    const w = await world();
    const token = await register(w, DEV_A);
    const k1 = await newKeys();
    const k2 = await newKeys();
    const k3 = await newKeys();
    expect((await put(w, token, await body(k1, DEV_A, NOW))).status).toBe(200);
    expect(
      (await put(w, token, await body(k2, DEV_A, NOW), NOW + 1)).status,
    ).toBe(400);
    expect(
      (await put(w, token, await body(k2, DEV_A, NOW + 1), NOW + 1)).status,
    ).toBe(200);
    expect(
      (await put(w, token, await body(k3, DEV_A, NOW + 2), NOW + 2)).body,
    ).toEqual({ keySeq: 3 });
  });

  it("keySeq only increases across deauthorize and re-registration", async () => {
    const w = await world();
    await register(w, DEV_A);
    await upsertDeviceKeys(w.db, "djdl", DEV_A, await newKeys(), NOW);
    await upsertDeviceKeys(w.db, "djdl", DEV_A, await newKeys(), NOW + 1);
    const r3 = await upsertDeviceKeys(
      w.db,
      "djdl",
      DEV_A,
      await newKeys(),
      NOW + 2,
    );
    expect(r3.keySeq).toBe(3);
    await setDeviceStatus(w.db, "djdl", DEV_A, "deauthorized");
    expect(await getDeviceKeys(w.db, "djdl", DEV_A)).toBeNull();
    const again = await upsertDeviceKeys(
      w.db,
      "djdl",
      DEV_A,
      await newKeys(),
      NOW + 3,
    );
    expect(again.keySeq).toBe(4);
  });

  it("a device whose seat and token were released leaves accountDeviceKeys when seats are held", async () => {
    const w = await world();
    await register(w, DEV_A);
    await w.db.run(
      "INSERT INTO accounts (id, created_at, modified_at) VALUES ('acc_h', 1, 1)",
    );
    await w.db.run(
      "INSERT INTO account_product_subjects (account_id, product, subject, created_at) VALUES ('acc_h', 'djdl', 'ps_AAAAAAAAAAAAAAAAAAAAAA', 1)",
    );
    await writeDeviceSubject(w.db, "djdl", DEV_A, "ps_AAAAAAAAAAAAAAAAAAAAAA");
    await upsertDeviceKeys(w.db, "djdl", DEV_A, await newKeys(), NOW);
    const sub = "ps_AAAAAAAAAAAAAAAAAAAAAA";
    // the licence service is off: no seat is ever held, so the device stays
    expect(
      (await accountDeviceKeys(w.db, "djdl", sub)).map((r) => r.deviceId),
    ).toEqual([DEV_A]);
    // exactly the statement releaseDormantSeats runs (core/devices/store.ts)
    await w.db.run(
      "UPDATE devices SET seat_no = NULL, token_hash = NULL WHERE product = ? AND device_id = ?",
      "djdl",
      DEV_A,
    );
    expect(
      await accountDeviceKeys(w.db, "djdl", sub, { seatsHeld: true }),
    ).toEqual([]);
  });

  it("product deletion removes the device keys and their floors", async () => {
    const w = await world();
    await register(w, DEV_A);
    await upsertDeviceKeys(w.db, "djdl", DEV_A, await newKeys(), NOW);
    await deleteProduct(w.db, "djdl", NOW + 5);
    expect(await getDeviceKeys(w.db, "djdl", DEV_A)).toBeNull();
    expect(
      await w.db.first(
        "SELECT 1 FROM device_key_floor WHERE product = ?",
        "djdl",
      ),
    ).toBeNull();
  });
});
