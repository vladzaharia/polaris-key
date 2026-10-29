/// <reference types="@cloudflare/workers-types" />

// `POST /<p>/identity/nearby/start` (I-40.4; WIRE-CONTRACT-V5 §12.11.5): the 201 and its handle,
// each off state, the proof and key refusals, Q8 (a device that already holds a credential), the
// label, that only a hash of the network is stored, and the budget.

import { describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { newKeys, world, type World } from "../../deviceKeyFixtures.js";
import { mkReq, NOW, seedLicenseWithKey } from "../../seed.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { loadProduct } from "../../../src/core/products.js";
import { setServices } from "../../../src/core/products/store.js";
import {
  serializeServices,
  type ServiceSlug,
} from "../../../src/core/services.js";
import { servicesOn } from "../../transcripts/world.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import {
  handleNearbyStart,
  NEARBY_START_RATE,
} from "../../../src/services/identity/passthrough/nearbyStart.js";
import {
  nearbyNetHash,
  nearbyRef,
  readNearby,
} from "../../../src/services/identity/passthrough/nearbyStore.js";

const SLUG = "djdl";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";
const IP = "198.51.100.7";
const HANDLE = /^nr_[A-Za-z0-9_-]{22}$/;

type Keys = Awaited<ReturnType<typeof newKeys>>;

async function proof(
  priv: CryptoKey,
  keys: { signKey: string; agreeKey: string },
  o: { device?: string; purpose?: string; value?: string } = {},
): Promise<string> {
  const msg = [
    "pkey-proof/1",
    o.purpose ?? "nearby-start",
    SLUG,
    o.device ?? DEVICE,
    o.value ?? `${keys.signKey}.${keys.agreeKey}`,
    "-",
  ].join("\n");
  return base64UrlEncodeBytes(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)),
    ),
  );
}

async function body(k: Keys, extra: Record<string, unknown> = {}) {
  return {
    signKey: k.signKey,
    agreeKey: k.agreeKey,
    proof: await proof(k.priv, k),
    ...extra,
  };
}

async function post(
  w: World,
  payload: unknown,
  o: { device?: string | null; ip?: string; bearer?: string } = {},
): Promise<{ status: number; headers: Headers; body: Record<string, any> }> {
  const device = o.device === undefined ? DEVICE : o.device;
  const res = await handleNearbyStart(
    new Request(`https://key.plrs.im/${SLUG}/identity/nearby/start`, {
      method: "POST",
      headers: {
        ...(device ? { "x-pkey-device": device } : {}),
        "cf-connecting-ip": o.ip ?? IP,
        ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
      },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  };
}

/** The stored request a 201 handed out. */
async function recordOf(w: World, r: { body: Record<string, any> }) {
  const ref = await nearbyRef(w.env, SLUG, r.body.request);
  return (await readNearby(w.env, ref!))!;
}

const gate = (w: World, v: string | undefined) => {
  const env = w.env as unknown as Record<string, unknown>;
  if (v === undefined) delete env.LAUNCH_IDENTITY_NEARBY;
  else env.LAUNCH_IDENTITY_NEARBY = v;
};

async function services(w: World, ...on: ServiceSlug[]): Promise<void> {
  await setServices(
    w.db,
    SLUG,
    serializeServices({ services: servicesOn(...on) }),
    "manifest",
    NOW,
  );
}

async function nearbySetting(w: World, value: boolean): Promise<void> {
  await w.db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, 'identity.nearby', ?, 'manifest', ?, 'test')`,
    SLUG,
    JSON.stringify(value),
    NOW,
  );
}

describe("POST /<p>/identity/nearby/start", () => {
  it("answers 201 with a handle, 300 seconds and the 3 second interval, no-store", async () => {
    const w = await world();
    const r = await post(w, await body(await newKeys()));
    expect(r.status).toBe(201);
    expect(r.body.request).toMatch(HANDLE);
    expect(r.body).toMatchObject({ expiresIn: 300, interval: 3 });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const again = await post(w, await body(await newKeys()), {
      ip: "198.51.100.8",
    });
    expect(again.body.request).not.toBe(r.body.request);
  });

  it("writes a pending record holding the keys, the label and only a hash of the network", async () => {
    const w = await world();
    const k = await newKeys();
    const r = await post(w, await body(k, { deviceName: "Kitchen TV" }));
    const ref = (await nearbyRef(w.env, SLUG, r.body.request))!;
    const rec = (await readNearby(w.env, ref))!;
    expect(rec).toMatchObject({
      product: SLUG,
      deviceId: DEVICE,
      signKey: k.signKey,
      agreeKey: k.agreeKey,
      label: "Kitchen TV",
      state: "pending",
      startedAt: NOW,
      proven: false,
    });
    expect(rec.netHash).toBe(
      await nearbyNetHash(
        w.env,
        new Request("https://x/", { headers: { "cf-connecting-ip": IP } }),
      ),
    );
    expect(JSON.stringify(rec)).not.toContain(IP);
  });

  it("normalises the label as §12.7.1, and stores none when it is empty", async () => {
    const w = await world();
    const a = await post(
      w,
      await body(await newKeys(), { deviceName: "  Kit‮chen​ \t TV  " }),
    );
    const ra = await recordOf(w, a);
    expect(ra.label).toBe("Kitchen TV");
    const b = await post(
      w,
      await body(await newKeys(), { deviceName: "​ ‮" }),
      {
        ip: "198.51.100.9",
      },
    );
    const rb = await recordOf(w, b);
    expect(rb.label).toBeNull();
  });

  describe("off states are 404", () => {
    it("the launch gate", async () => {
      const w = await world();
      gate(w, undefined);
      const r = await post(w, await body(await newKeys()));
      expect(r).toMatchObject({
        status: 404,
        body: { error: { code: "not_found" } },
      });
    });

    it("the launch gate hard-off in [vars]", async () => {
      const w = await world();
      gate(w, "off");
      expect((await post(w, await body(await newKeys()))).status).toBe(404);
    });

    it("the product's identity.nearby setting", async () => {
      const w = await world();
      await nearbySetting(w, false);
      expect((await post(w, await body(await newKeys()))).status).toBe(404);
    });

    it("Identity off, through the router", async () => {
      const w = await world();
      await services(w, "config", "license");
      const k = await newKeys();
      const res = await dispatchWith(
        new Request(`https://key.plrs.im/${SLUG}/identity/nearby/start`, {
          method: "POST",
          headers: { "x-pkey-device": DEVICE },
          body: JSON.stringify(await body(k)),
        }) as unknown as Request,
        w.env,
        w.db,
        NOW,
      );
      expect(res.status).toBe(404);
    });

    it("a malformed body to an off route is 404, never 400", async () => {
      for (const off of ["launch", "setting"] as const) {
        const w = await world();
        if (off === "launch") gate(w, undefined);
        else await nearbySetting(w, false);
        for (const bad of ["not json", [], {}])
          expect(await post(w, bad)).toMatchObject({
            status: 404,
            body: { error: { code: "not_found" } },
          });
      }
    });

    it("is served through the router with everything on", async () => {
      const w = await world();
      await services(w, "config", "license", "identity");
      const k = await newKeys();
      const res = await dispatchWith(
        new Request(`https://key.plrs.im/${SLUG}/identity/nearby/start`, {
          method: "POST",
          headers: { "x-pkey-device": DEVICE, "cf-connecting-ip": IP },
          body: JSON.stringify(await body(k)),
        }) as unknown as Request,
        w.env,
        w.db,
        NOW,
      );
      expect(res.status).toBe(201);
    });
  });

  describe("shape", () => {
    it("a body that is not the documented shape is 400 bad_request", async () => {
      const w = await world();
      const k = await newKeys();
      for (const bad of [
        "not json",
        [],
        {},
        { ...(await body(k)), proof: 5 },
        { ...(await body(k)), deviceName: 7 },
      ])
        expect(await post(w, bad)).toMatchObject({
          status: 400,
          body: { error: { code: "bad_request" } },
        });
    });

    it("a missing or malformed X-PKey-Device is 400 bad_request", async () => {
      const w = await world();
      const b = await body(await newKeys());
      expect((await post(w, b, { device: null })).body).toMatchObject({
        error: { code: "bad_request" },
      });
      expect((await post(w, b, { device: "short" })).status).toBe(400);
    });
  });

  describe("proof", () => {
    it("every failure is one 400 invalid_grant", async () => {
      const w = await world();
      const k = await newKeys();
      const other = await newKeys();
      const wrongs = [
        await proof(other.priv, k), // another key
        await proof(k.priv, k, { purpose: "nearby-poll" }),
        await proof(k.priv, k, { device: DEVICE_2 }),
        await proof(k.priv, k, { value: k.signKey }),
        "A".repeat(86),
        "x",
      ];
      const seen = new Set<string>();
      for (const p of wrongs) {
        const r = await post(w, {
          signKey: k.signKey,
          agreeKey: k.agreeKey,
          proof: p,
        });
        expect(r).toMatchObject({
          status: 400,
          body: { error: { code: "invalid_grant" } },
        });
        seen.add(JSON.stringify(r.body));
      }
      expect(seen.size).toBe(1);
    });
  });

  describe("keys are 400 device_keys_invalid", () => {
    const invalid = {
      status: 400,
      body: { error: { code: "device_keys_invalid" } },
    };

    it("a malformed key", async () => {
      const w = await world();
      const k = await newKeys();
      expect(
        await post(w, { signKey: "short", agreeKey: k.agreeKey, proof: "x" }),
      ).toMatchObject(invalid);
      expect(
        await post(w, { signKey: k.signKey, agreeKey: "short", proof: "x" }),
      ).toMatchObject(invalid);
    });

    it("a device with a registered signing key must present that key", async () => {
      const w = await world();
      const held = await newKeys();
      await upsertDeviceKeys(w.db, SLUG, DEVICE, held, NOW);
      expect(await post(w, await body(await newKeys()))).toMatchObject(invalid);
      const ok = await post(w, await body(held));
      expect(ok.status).toBe(201);
    });

    it("an agreeKey held by another device", async () => {
      const w = await world();
      const a = await newKeys();
      await upsertDeviceKeys(w.db, SLUG, DEVICE_2, a, NOW);
      const k = await newKeys(
        Uint8Array.from(
          atob(a.agreeKey.replace(/-/g, "+").replace(/_/g, "/") + "="),
          (c) => c.charCodeAt(0),
        ),
      );
      expect(await post(w, await body(k))).toMatchObject(invalid);
    });

    it("the key rules come before the proof", async () => {
      const w = await world();
      const held = await newKeys();
      await upsertDeviceKeys(w.db, SLUG, DEVICE, held, NOW);
      const k = await newKeys();
      const r = await post(w, {
        signKey: k.signKey,
        agreeKey: k.agreeKey,
        proof: "x",
      });
      expect(r).toMatchObject(invalid);
    });
  });

  describe("Q8: a device id that already holds a credential", () => {
    async function credentialed() {
      const w = await world();
      await services(w, "config", "license", "identity");
      const product = (await loadProduct(w.env, w.db, SLUG))!;
      const seeded = await seedLicenseWithKey(w.db, SLUG);
      const key = seeded.key;
      const res = await handleActivate(
        mkReq("POST", {
          authorization: `Bearer ${key}`,
          "x-pkey-device": DEVICE,
        }),
        w.env,
        w.db,
        product,
        NOW,
      );
      expect(res.status).toBe(200);
      const token = ((await res.json()) as { token: string }).token;
      return { w: { ...w, product } as World, token };
    }

    it("without its bearer or a registered key it is refused", async () => {
      const { w } = await credentialed();
      expect(await post(w, await body(await newKeys()))).toMatchObject({
        status: 400,
        body: { error: { code: "device_keys_invalid" } },
      });
    });

    it("another device's bearer does not prove it", async () => {
      const { w } = await credentialed();
      const r = await post(w, await body(await newKeys()), {
        bearer: `pkeyt_${"x".repeat(43)}`,
      });
      expect(r.status).toBe(400);
    });

    it("its bearer proves it, and the record says so", async () => {
      const { w, token } = await credentialed();
      const r = await post(w, await body(await newKeys()), { bearer: token });
      expect(r.status).toBe(201);
      const rec = await recordOf(w, r);
      expect(rec.proven).toBe(true);
    });

    it("its registered signing key proves it", async () => {
      const { w } = await credentialed();
      const held = await newKeys();
      await upsertDeviceKeys(w.db, SLUG, DEVICE, held, NOW);
      const r = await post(w, await body(held));
      expect(r.status).toBe(201);
      const rec = await recordOf(w, r);
      expect(rec.proven).toBe(true);
    });
  });

  describe("budget", () => {
    it("allows 10 a minute per client network and then answers 429 rate_limited", async () => {
      const w = await world();
      expect(NEARBY_START_RATE).toMatchObject({ limit: 10, windowSec: 60 });
      for (let i = 0; i < NEARBY_START_RATE.limit; i++)
        expect((await post(w, await body(await newKeys()))).status).toBe(201);
      expect(await post(w, await body(await newKeys()))).toMatchObject({
        status: 429,
        body: { error: { code: "rate_limited" } },
      });
      // Another network has its own budget.
      expect(
        (await post(w, await body(await newKeys()), { ip: "203.0.113.50" }))
          .status,
      ).toBe(201);
    });

    it("a refused call before the budget does not spend it", async () => {
      const w = await world();
      gate(w, undefined);
      for (let i = 0; i < 12; i++) await post(w, await body(await newKeys()));
      gate(w, "on");
      expect((await post(w, await body(await newKeys()))).status).toBe(201);
    });
  });
});
