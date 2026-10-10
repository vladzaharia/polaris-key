/**
 * Commerce hook hardening. Fakes only (`commerceFake.ts`); the routes run through the
 * real router.
 */

import { afterEach, describe, expect, it } from "vitest";
import { certificateKey, X509Error } from "../src/core/trust/x509.js";
import { storeGrantDrift } from "../src/core/licensing/grants.js";
import { NOW } from "./seed.js";
import { SLUG } from "./releaseRoutesFixture.js";
import { PLAY_SKU, STEAM_DLC } from "./commerceFake.js";
import {
  FLAG,
  bindingOf,
  commerceWorld,
  grants,
  route,
  tick,
  type CommerceWorld,
} from "./commerceWorld.js";

let w: CommerceWorld | null = null;
afterEach(async () => {
  if (w) expect(await storeGrantDrift(w.db, SLUG)).toEqual([]);
  w?.close();
  w = null;
});
async function world() {
  w = await commerceWorld({});
  return w;
}
const hook = (cw: CommerceWorld, signedPayload: unknown, ip?: string) =>
  route(cw, "POST", "/distribution/hooks/app-store", {
    body: { signedPayload },
    ...(ip ? { headers: { "cf-connecting-ip": ip } } : {}),
  });
const uuid = (n: number) =>
  `1b6e2f6a-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("a key that is not a curve point is a refusal, not a crash", () => {
  it("certificateKey throws X509Error for an invalid EC point", async () => {
    const bad = {
      spki: new Uint8Array(91).fill(7),
      curve: "P-256",
    } as never;
    await expect(certificateKey(bad)).rejects.toBeInstanceOf(X509Error);
  });
});

describe("App Store hook", () => {
  it("refuses a notification signed more than 24 h ago, with a bare 401", async () => {
    const cw = await world();
    const old = await cw.fakes.apple.signNotification(
      { uuid: uuid(1), type: "TEST" },
      NOW - 2 * 86_400,
    );
    const res = await hook(cw, old);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/invalid_jws|reason/);
    const fresh = await cw.fakes.apple.signNotification(
      { uuid: uuid(2), type: "TEST" },
      NOW - 3600,
    );
    expect((await hook(cw, fresh)).status).toBe(200);
  });
});

describe("only notifications that cost a Server API call spend the product bucket", () => {
  it("120+ Apple-signed notifications for another app cannot 429 a real refund", async () => {
    const cw = await world();
    const binding = await bindingOf(cw, cw.tokenA);
    const tx = { transactionId: "2000000111", appAccountToken: binding };
    cw.fakes.apple.transactions.set(tx.transactionId, tx);
    for (let i = 0; i < 130; i++) {
      const other = await cw.fakes.apple.signNotification(
        {
          uuid: uuid(100 + i),
          type: "ONE_TIME_CHARGE",
          tx,
          bundleId: "gg.x.y",
        },
        NOW,
      );
      await hook(cw, other, `198.51.100.${i % 250}`);
    }
    const real = await cw.fakes.apple.signNotification(
      { uuid: uuid(900), type: "ONE_TIME_CHARGE", tx },
      NOW,
    );
    expect((await hook(cw, real, "17.58.0.1")).status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
  });
});

describe("an unresolved notification is retried, not deduped", () => {
  it("the same notification applies on redelivery once the binding exists", async () => {
    const cw = await world();
    const tx = { transactionId: "2000000222" }; // no appAccountToken: unbound
    cw.fakes.apple.transactions.set(tx.transactionId, tx);
    const n = await cw.fakes.apple.signNotification(
      { uuid: uuid(5), type: "ONE_TIME_CHARGE", tx },
      NOW,
    );
    expect((await hook(cw, n)).status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([]);
    cw.fakes.apple.transactions.set(tx.transactionId, {
      ...tx,
      appAccountToken: await bindingOf(cw, cw.tokenA),
    });
    const again = await hook(cw, n);
    expect(await again.json()).not.toMatchObject({ duplicate: true });
    expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
  });
});

describe("Play hook", () => {
  const TOKEN = "opaque-token-up-to-1kb.AO-J1Oz_test";
  const push = async (
    cw: CommerceWorld,
    messageId: string,
    data: Record<string, unknown>,
  ) =>
    route(cw, "POST", "/distribution/hooks/play-rtdn", {
      body: cw.fakes.google.pushBody(messageId, {
        packageName: "gg.acme.djdl",
        ...data,
      }),
      headers: {
        authorization: `Bearer ${await cw.fakes.google.pushToken(NOW)}`,
      },
    });
  const oneTime = {
    oneTimeProductNotification: {
      notificationType: 1,
      purchaseToken: TOKEN,
      sku: PLAY_SKU,
    },
  };

  it("a rejected push is a bare 401", async () => {
    const cw = await world();
    const res = await route(cw, "POST", "/distribution/hooks/play-rtdn", {
      body: cw.fakes.google.pushBody("m-1", { packageName: "gg.acme.djdl" }),
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("no_token");
  });

  it("a store reporting pending after active does not regress the purchase", async () => {
    const cw = await world();
    const binding = await bindingOf(cw, cw.tokenA);
    cw.fakes.google.purchases.set(`${PLAY_SKU}/${TOKEN}`, {
      purchaseState: 0,
      acknowledgementState: 1,
      obfuscatedExternalAccountId: binding,
    } as never);
    expect((await push(cw, "m-a", oneTime)).status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([`play:${FLAG}`]);
    cw.fakes.google.purchases.set(`${PLAY_SKU}/${TOKEN}`, {
      purchaseState: 2,
      acknowledgementState: 1,
      obfuscatedExternalAccountId: binding,
    } as never);
    await push(cw, "m-b", oneTime);
    const row = await cw.db.first<{ state: string }>(
      "SELECT state FROM dist_purchases WHERE product = ? AND store = 'play'",
      SLUG,
    );
    expect(row!.state).toBe("active");
    expect(await grants(cw, cw.licenseA)).toEqual([`play:${FLAG}`]);
  });

  it("a reused messageId with different content is not dropped as a duplicate", async () => {
    const cw = await world();
    expect(
      (await push(cw, "same-id", { testNotification: { version: "1.0" } }))
        .status,
    ).toBe(200);
    const binding = await bindingOf(cw, cw.tokenA);
    cw.fakes.google.purchases.set(`${PLAY_SKU}/${TOKEN}`, {
      purchaseState: 0,
      acknowledgementState: 1,
      obfuscatedExternalAccountId: binding,
    } as never);
    const res = await push(cw, "same-id", oneTime);
    expect(await res.json()).not.toMatchObject({ duplicate: true });
    expect(await grants(cw, cw.licenseA)).toEqual([`play:${FLAG}`]);
  });
});

describe("one failing Steam row does not block the weekly re-check", () => {
  it("later refunded rows are still revoked", async () => {
    const cw = await world();
    const A = "76561198000000001";
    const B = "76561198000000002";
    for (const [token, steamid, ticket] of [
      [cw.tokenA, A, "14000000ab".repeat(8)],
      [cw.tokenB, B, "15000000cd".repeat(8)],
    ] as const) {
      cw.fakes.steam.tickets.set(ticket, {
        steamid,
        identity: await bindingOf(cw, token),
      });
      cw.fakes.steam.owns.set(`${steamid}:${STEAM_DLC}`, {
        ownsapp: true,
        ownersteamid: steamid,
      });
      const r = await route(cw, "POST", "/distribution/commerce/claim", {
        token,
        body: { store: "steam", ticket, dlcAppId: STEAM_DLC },
      });
      expect(r.status).toBe(200);
    }
    cw.fakes.steam.failFor.add(A);
    cw.fakes.steam.owns.set(`${B}:${STEAM_DLC}`, {
      ownsapp: false,
      ownersteamid: "0",
    });
    await tick(cw, NOW + 8 * 86_400);
    expect(await grants(cw, cw.licenseB)).toEqual([]);
    expect(await grants(cw, cw.licenseA)).toEqual([`steam:${FLAG}`]);
  });
});

describe("the weekly App Store re-read revokes a refund no notification delivered", () => {
  it("revokes an active purchase Apple now reports refunded", async () => {
    const cw = await world();
    const tx = {
      transactionId: "2000000333",
      appAccountToken: await bindingOf(cw, cw.tokenA),
    };
    cw.fakes.apple.transactions.set(tx.transactionId, tx);
    const jws = await cw.fakes.apple.signTransaction(tx, NOW - 60);
    const c = await route(cw, "POST", "/distribution/commerce/claim", {
      token: cw.tokenA,
      body: { store: "app-store", signedTransaction: jws },
    });
    expect(c.status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
    cw.fakes.apple.transactions.set(tx.transactionId, {
      ...tx,
      revocationDate: NOW * 1000,
    });
    await tick(cw, NOW + 86_400);
    expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
    cw.now = NOW + 8 * 86_400; // the fake Server API signs at the world's clock, as Apple does
    await tick(cw, NOW + 8 * 86_400);
    expect(await grants(cw, cw.licenseA)).toEqual([]);
  });
});
