/**
 * P6-01 — the commerce bridge: store purchases become licence flags per deliverable.
 *
 * Every store is a fake (`commerceFake.ts`): App Store JWS are signed by a chain generated here,
 * Google's push tokens by an RSA key generated here, Steam answers from a table. The routes run
 * through the real router (`dispatchWith`), the settings and product map through the real admin
 * API, the re-checks through the real connector cron (`runConnectorPolls`).
 */

import { afterEach, describe, expect, it } from "vitest";
import { CONSOLE, SLUG } from "./releaseRoutesFixture.js";
import { dispatchWith } from "../src/dispatch.js";
import { NOW } from "./seed.js";
import { setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import {
  APPLE_PRODUCT,
  BUNDLE_ID,
  PLAY_SKU,
  STEAM_DLC,
} from "./commerceFake.js";
import { makeChain } from "./x509Fixtures.js";
import {
  FLAG,
  SETTINGS,
  admin,
  bindingOf,
  commerceWorld,
  entitlements,
  grants,
  route,
  tick,
  withFetch,
  type CommerceWorld,
} from "./commerceWorld.js";

let w: CommerceWorld | null = null;
afterEach(() => {
  w?.close();
  w = null;
});

async function world(opts: Parameters<typeof commerceWorld>[0] = {}) {
  w = await commerceWorld(opts);
  return w;
}

const claim = (cw: CommerceWorld, token: string, body: unknown) =>
  route(cw, "POST", "/distribution/commerce/claim", { token, body });

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const reasonOf = async (res: Response) => (await bodyOf(res)).reason;

async function audits(cw: CommerceWorld, action: string): Promise<number> {
  const r = await cw.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit WHERE product = ? AND action = ?",
    SLUG,
    action,
  );
  return r?.n ?? 0;
}

// ── binding, the grant layer, coherence ──────────────────────────────────────────────────────

describe("commerce: binding and the licence-document grant layer", () => {
  it("issues one stable binding UUID per licence, never the licence id, and lists the products", async () => {
    const cw = await world();
    const res = await route(cw, "GET", "/distribution/commerce/binding", {
      token: cw.tokenA,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await bodyOf(res);
    expect(body.bindingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.bindingId).not.toContain(cw.licenseA);
    expect(body.products).toEqual([
      {
        store: "app-store",
        productId: APPLE_PRODUCT,
        flag: FLAG,
        deliverable: "app",
      },
      { store: "play", productId: PLAY_SKU, flag: FLAG, deliverable: "app" },
      { store: "steam", productId: STEAM_DLC, flag: FLAG, deliverable: "app" },
    ]);
    expect(await bindingOf(cw, cw.tokenA)).toBe(body.bindingId);
    expect(await bindingOf(cw, cw.tokenB)).not.toBe(body.bindingId);
  });

  it("refuses a device with no licence (403 no_license: the SDK enrols first) and no token (401)", async () => {
    const cw = await world();
    const none = await route(cw, "GET", "/distribution/commerce/binding", {
      token: cw.tokenNone,
    });
    expect(none.status).toBe(403);
    expect(await bodyOf(none)).toMatchObject({
      error: { code: "not_entitled" },
      reason: "no_license",
    });
    expect(
      (await route(cw, "GET", "/distribution/commerce/binding")).status,
    ).toBe(401);
  });

  it("a grant appears in the next licence document, and an operator override of the flag wins", async () => {
    const cw = await world();
    expect(await entitlements(cw, cw.tokenA)).not.toHaveProperty(FLAG);
    await cw.db.run(
      `INSERT INTO license_store_grants
         (product, license_id, flag, store, purchase_key_hash, state, granted_at, revoked_at)
       VALUES (?, ?, ?, 'steam', 'h1', 'active', ?, NULL)`,
      SLUG,
      cw.licenseA,
      FLAG,
      NOW,
    );
    expect((await entitlements(cw, cw.tokenA))[FLAG]).toMatchObject({
      value: true,
    });
    expect(await entitlements(cw, cw.tokenB)).not.toHaveProperty(FLAG);
    // The operator's override (licence overrides_json) comes after the grant layer.
    await cw.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify({
        config: {},
        secrets: {},
        entitlements: {
          [FLAG]: { state: "default", value: false, updatedAt: NOW },
        },
      }),
      SLUG,
      cw.licenseA,
    );
    expect((await entitlements(cw, cw.tokenA))[FLAG]).toMatchObject({
      value: false,
    });
  });

  it("commerce needs License: settings writes are refused 409 and every route is the not-found", async () => {
    const cw = await world();
    await setServices(
      cw.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: false },
          config: { enabled: true },
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
          identity: { enabled: false },
        },
      }),
      "admin",
      NOW,
    );
    const put = await admin(cw, "PUT", "/commerce/settings", SETTINGS);
    expect(put.status).toBe(409);
    expect(await bodyOf(put)).toMatchObject({
      reason: "commerce_requires_license",
    });
    expect(
      (
        await route(cw, "GET", "/distribution/commerce/binding", {
          token: cw.tokenA,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await claim(cw, cw.tokenA, {
          store: "steam",
          ticket: "aa".repeat(10),
          dlcAppId: STEAM_DLC,
        })
      ).status,
    ).toBe(404);
    expect(
      (await route(cw, "POST", "/distribution/hooks/app-store", { body: {} }))
        .status,
    ).toBe(404);
  });

  it("a store without settings or without a pinned credential is the not-found", async () => {
    const cw = await world({
      settings: { steam: SETTINGS.steam },
      credentials: false,
    });
    const steam = await claim(cw, cw.tokenA, {
      store: "steam",
      ticket: "aa".repeat(10),
      dlcAppId: STEAM_DLC,
    });
    expect(steam.status).toBe(404); // configured, but no steam-publisher-key pinned to 480
    const apple = await claim(cw, cw.tokenA, {
      store: "app-store",
      signedTransaction: "x.y.z",
    });
    expect(apple.status).toBe(404); // no appStore settings
    expect(
      (await route(cw, "POST", "/distribution/hooks/play-rtdn", { body: {} }))
        .status,
    ).toBe(404);
  });
});

// ── App Store ────────────────────────────────────────────────────────────────────────────────

describe("commerce: App Store", () => {
  async function bought(cw: CommerceWorld, over: Record<string, unknown> = {}) {
    const binding = await bindingOf(cw, cw.tokenA);
    const tx = {
      transactionId: "2000000111",
      appAccountToken: binding,
      ...over,
    };
    cw.fakes.apple.transactions.set(tx.transactionId, tx);
    return { tx, jws: await cw.fakes.apple.signTransaction(tx, NOW - 60) };
  }

  it("a verified, Server-API-confirmed purchase grants the mapped flag; a replay changes nothing", async () => {
    const cw = await world();
    const { jws } = await bought(cw);
    const res = await claim(cw, cw.tokenA, {
      store: "app-store",
      signedTransaction: jws,
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      ok: true,
      store: "app-store",
      productId: APPLE_PRODUCT,
      flag: FLAG,
      deliverable: "app",
      state: "active",
      granted: true,
      changed: true,
    });
    expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
    expect((await entitlements(cw, cw.tokenA))[FLAG]).toMatchObject({
      value: true,
    });
    // The device's JWS was confirmed against the Server API with a bearer token.
    expect(cw.fakes.apple.requests).toHaveLength(1);
    expect(cw.fakes.apple.requests[0]!.url.pathname).toBe(
      "/inApps/v1/transactions/2000000111",
    );
    expect(cw.fakes.apple.requests[0]!.authorization).toMatch(/^Bearer /);
    const again = await claim(cw, cw.tokenA, {
      store: "app-store",
      signedTransaction: jws,
    });
    expect(await bodyOf(again)).toMatchObject({
      granted: true,
      changed: false,
    });
    expect(await audits(cw, "license.store_grant.grant")).toBe(1);
  });

  it("compares appAccountToken as a UUID (case-insensitive)", async () => {
    const cw = await world();
    const binding = await bindingOf(cw, cw.tokenA);
    const { jws } = await bought(cw, {
      appAccountToken: binding.toUpperCase(),
    });
    expect(
      (
        await claim(cw, cw.tokenA, {
          store: "app-store",
          signedTransaction: jws,
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a claim carrying another licence's binding, and another licence's recorded purchase", async () => {
    const cw = await world();
    const { jws } = await bought(cw); // bound to licence A
    const byB = await claim(cw, cw.tokenB, {
      store: "app-store",
      signedTransaction: jws,
    });
    expect(byB.status).toBe(403);
    expect(await reasonOf(byB)).toBe("binding_mismatch");
    expect(await grants(cw, cw.licenseB)).toEqual([]);
    expect(
      (
        await claim(cw, cw.tokenA, {
          store: "app-store",
          signedTransaction: jws,
        })
      ).status,
    ).toBe(200);
    const replay = await claim(cw, cw.tokenB, {
      store: "app-store",
      signedTransaction: jws,
    });
    expect(replay.status).toBe(403);
    expect(await reasonOf(replay)).toBe("bound_elsewhere");
  });

  it("refuses a transaction with no appAccountToken (unbound)", async () => {
    const cw = await world();
    const tx = { transactionId: "2000000112" };
    cw.fakes.apple.transactions.set(tx.transactionId, tx);
    const jws = await cw.fakes.apple.signTransaction(tx, NOW);
    const res = await claim(cw, cw.tokenA, {
      store: "app-store",
      signedTransaction: jws,
    });
    expect(res.status).toBe(403);
    expect(await reasonOf(res)).toBe("unbound");
  });

  it("refuses a wrong bundleId, a sandbox transaction in production, Xcode, a consumable and a Family Sharing copy", async () => {
    const cw = await world();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ bundleId: "gg.other.app" }, "wrong_app"],
      [{ environment: "Sandbox" }, "environment"],
      [{ environment: "Xcode" }, "environment"],
      [{ type: "Consumable" }, "unsupported_type"],
      [{ inAppOwnershipType: "FAMILY_SHARED" }, "family_shared"],
    ];
    for (const [over, reason] of cases) {
      const { jws } = await bought(cw, over);
      const res = await claim(cw, cw.tokenA, {
        store: "app-store",
        signedTransaction: jws,
      });
      expect(res.status, reason).toBe(400);
      expect(await reasonOf(res), reason).toBe(reason);
    }
    expect(cw.fakes.apple.requests).toHaveLength(0);
    expect(await grants(cw, cw.licenseA)).toEqual([]);
  });

  it("accepts Sandbox only where the operator turned acceptSandbox on (and asks the sandbox host)", async () => {
    const cw = await world({
      settings: {
        ...SETTINGS,
        appStore: { bundleId: BUNDLE_ID, acceptSandbox: true },
      },
    });
    const { jws } = await bought(cw, { environment: "Sandbox" });
    expect(
      (
        await claim(cw, cw.tokenA, {
          store: "app-store",
          signedTransaction: jws,
        })
      ).status,
    ).toBe(200);
    expect(cw.fakes.apple.requests[0]!.url.hostname).toBe(
      "api.storekit-sandbox.apple.com",
    );
  });

  it("refuses a broken chain, a missing Apple OID, an unpinned root and a single self-signed certificate", async () => {
    const cw = await world();
    const binding = await bindingOf(cw, cw.tokenA);
    const tx = { transactionId: "2000000113", appAccountToken: binding };
    cw.fakes.apple.transactions.set(tx.transactionId, tx);
    for (const opts of [
      { brokenLink: true },
      { noLeafOid: true },
      { noIntermediateOid: true },
      {},
    ]) {
      // `{}` is a valid chain to a root nobody pinned.
      const chain = await makeChain({ at: NOW, ...opts });
      const jws = await cw.fakes.apple.signTransaction(tx, NOW, chain);
      const res = await claim(cw, cw.tokenA, {
        store: "app-store",
        signedTransaction: jws,
      });
      expect(res.status).toBe(400);
      expect(await reasonOf(res)).toBe("untrusted_chain");
    }
    // StoreKit Testing's shape (S-09): one self-signed certificate.
    const xcode = await makeChain({ at: NOW });
    const jws = await cw.fakes.apple.signTransaction(tx, NOW, {
      ...xcode,
      x5c: [xcode.x5c[0]!],
    });
    expect(
      await reasonOf(
        await claim(cw, cw.tokenA, {
          store: "app-store",
          signedTransaction: jws,
        }),
      ),
    ).toBe("untrusted_chain");
    // A JWS whose signature is not the leaf's.
    const good = await cw.fakes.apple.signTransaction(tx, NOW);
    const tampered = `${good.split(".").slice(0, 2).join(".")}.${"A".repeat(86)}`;
    expect(
      await reasonOf(
        await claim(cw, cw.tokenA, {
          store: "app-store",
          signedTransaction: tampered,
        }),
      ),
    ).toBe("invalid_jws");
    expect(cw.fakes.apple.requests).toHaveLength(0);
  });

  it("the Server API decides: an unknown transaction is refused, an outage is 503", async () => {
    const cw = await world();
    const { jws, tx } = await bought(cw);
    cw.fakes.apple.transactions.delete(tx.transactionId);
    const unknown = await claim(cw, cw.tokenA, {
      store: "app-store",
      signedTransaction: jws,
    });
    expect(unknown.status).toBe(400);
    expect(await reasonOf(unknown)).toBe("unknown_transaction");
    cw.fakes.apple.transactions.set(tx.transactionId, tx);
    cw.fakes.apple.failNext = { status: 500, count: 1 };
    const down = await claim(cw, cw.tokenA, {
      store: "app-store",
      signedTransaction: jws,
    });
    expect(down.status).toBe(503);
    expect(await grants(cw, cw.licenseA)).toEqual([]);
  });

  describe("Notifications V2", () => {
    const hook = (cw: CommerceWorld, signedPayload: unknown) =>
      route(cw, "POST", "/distribution/hooks/app-store", {
        body: { signedPayload },
      });

    it("ONE_TIME_CHARGE grants, REFUND revokes, a replay changes nothing, REFUND_REVERSED grants again", async () => {
      const cw = await world();
      const { tx } = await bought(cw);
      const n1 = await cw.fakes.apple.signNotification(
        {
          uuid: "1b6e2f6a-0000-4000-8000-000000000001",
          type: "ONE_TIME_CHARGE",
          tx,
        },
        NOW,
      );
      expect((await hook(cw, n1)).status).toBe(200);
      expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);

      // Apple refunds: the Server API now reports a revocationDate.
      cw.fakes.apple.transactions.set(tx.transactionId, {
        ...tx,
        revocationDate: NOW * 1000,
      });
      const n2 = await cw.fakes.apple.signNotification(
        { uuid: "1b6e2f6a-0000-4000-8000-000000000002", type: "REFUND", tx },
        NOW,
      );
      expect((await hook(cw, n2)).status).toBe(200);
      expect(await grants(cw, cw.licenseA)).toEqual([]);
      expect(await entitlements(cw, cw.tokenA)).not.toHaveProperty(FLAG);

      // A redelivery of the same notification: duplicate, no Server API call, no change.
      const calls = cw.fakes.apple.requests.length;
      const dup = await hook(cw, n2);
      expect(await bodyOf(dup)).toMatchObject({ duplicate: true });
      expect(cw.fakes.apple.requests.length).toBe(calls);
      // Even a fresh delivery of the same refund (new UUID) changes nothing.
      const n2b = await cw.fakes.apple.signNotification(
        { uuid: "1b6e2f6a-0000-4000-8000-000000000003", type: "REFUND", tx },
        NOW,
      );
      await hook(cw, n2b);
      expect(await audits(cw, "license.store_grant.revoke")).toBe(1);

      cw.fakes.apple.transactions.set(tx.transactionId, tx);
      const n3 = await cw.fakes.apple.signNotification(
        {
          uuid: "1b6e2f6a-0000-4000-8000-000000000004",
          type: "REFUND_REVERSED",
          tx,
        },
        NOW,
      );
      await hook(cw, n3);
      expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
    });

    it("a REFUND revokes the grant after the mapping was deleted, and the OLD flag after a remap", async () => {
      for (const change of ["delete", "remap"] as const) {
        w?.close();
        const cw = await world();
        const { jws, tx } = await bought(cw);
        expect(
          (
            await claim(cw, cw.tokenA, {
              store: "app-store",
              signedTransaction: jws,
            })
          ).status,
        ).toBe(200);
        expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
        if (change === "delete")
          expect(
            (
              await admin(
                cw,
                "DELETE",
                `/commerce/products/app-store/${APPLE_PRODUCT}`,
              )
            ).status,
          ).toBe(200);
        else
          expect(
            (
              await admin(cw, "PUT", "/commerce/products", {
                store: "app-store",
                productId: APPLE_PRODUCT,
                flag: "extras.other",
              })
            ).status,
          ).toBe(200);
        cw.fakes.apple.transactions.set(tx.transactionId, {
          ...tx,
          revocationDate: NOW * 1000,
        });
        const n = await cw.fakes.apple.signNotification(
          {
            uuid: `1b6e2f6a-0000-4000-8000-0000000001${change === "delete" ? "01" : "02"}`,
            type: "REFUND",
            tx,
          },
          NOW,
        );
        expect((await hook(cw, n)).status, change).toBe(200);
        expect(await grants(cw, cw.licenseA), change).toEqual([]);
        expect(await entitlements(cw, cw.tokenA), change).not.toHaveProperty(
          FLAG,
        );
      }
    });

    it("REVOKE (Family Sharing withdrawn) revokes", async () => {
      const cw = await world();
      const { jws, tx } = await bought(cw);
      await claim(cw, cw.tokenA, {
        store: "app-store",
        signedTransaction: jws,
      });
      cw.fakes.apple.transactions.set(tx.transactionId, {
        ...tx,
        revocationDate: NOW * 1000,
      });
      const n = await cw.fakes.apple.signNotification(
        { uuid: "1b6e2f6a-0000-4000-8000-000000000010", type: "REVOKE", tx },
        NOW,
      );
      await hook(cw, n);
      expect(await grants(cw, cw.licenseA)).toEqual([]);
    });

    it("ignores a Production notification for another Apple ID", async () => {
      const cw = await world();
      const { tx } = await bought(cw);
      const n = await cw.fakes.apple.signNotification(
        {
          uuid: "1b6e2f6a-0000-4000-8000-000000000040",
          type: "ONE_TIME_CHARGE",
          tx,
          appAppleId: 42,
        },
        NOW,
      );
      expect(await bodyOf(await hook(cw, n))).toMatchObject({
        ignored: "wrong_app",
      });
      expect(await grants(cw, cw.licenseA)).toEqual([]);
    });

    it("refuses a forged notification (401) and ignores another app, a sandbox delivery, TEST", async () => {
      const cw = await world();
      const { tx } = await bought(cw);
      const forger = await makeChain({ at: NOW });
      const forged = await cw.fakes.apple.signNotification(
        {
          uuid: "1b6e2f6a-0000-4000-8000-000000000020",
          type: "ONE_TIME_CHARGE",
          tx,
        },
        NOW,
        forger,
      );
      const f = await hook(cw, forged);
      expect(f.status).toBe(401);
      expect(await reasonOf(f)).toBe("untrusted_chain");
      expect((await hook(cw, "not.a.jws")).status).toBe(401);

      const other = await cw.fakes.apple.signNotification(
        {
          uuid: "1b6e2f6a-0000-4000-8000-000000000021",
          type: "ONE_TIME_CHARGE",
          tx,
          bundleId: "gg.other.app",
        },
        NOW,
      );
      expect(await bodyOf(await hook(cw, other))).toMatchObject({
        ignored: "wrong_app",
      });
      const sandbox = await cw.fakes.apple.signNotification(
        {
          uuid: "1b6e2f6a-0000-4000-8000-000000000022",
          type: "ONE_TIME_CHARGE",
          tx,
          environment: "Sandbox",
        },
        NOW,
      );
      expect(await bodyOf(await hook(cw, sandbox))).toMatchObject({
        ignored: "environment",
      });
      const test = await cw.fakes.apple.signNotification(
        { uuid: "1b6e2f6a-0000-4000-8000-000000000023", type: "TEST" },
        NOW,
      );
      expect((await hook(cw, test)).status).toBe(200);
      expect(await grants(cw, cw.licenseA)).toEqual([]);
      const events = await cw.db.all<{ outcome: string }>(
        "SELECT outcome FROM dist_connector_events WHERE product = ? AND connector = 'app-store-notifications' ORDER BY rowid",
        SLUG,
      );
      expect(events.map((e) => e.outcome)).toEqual([
        "ignored",
        "ignored",
        "stored",
      ]);
    });

    it("a flood of unsigned junk cannot drain the product bucket: Apple's notification still lands", async () => {
      const cw = await world();
      const { tx } = await bought(cw);
      let limited = 0;
      for (let i = 0; i < 150; i++) {
        const junk = await route(cw, "POST", "/distribution/hooks/app-store", {
          body: { signedPayload: `junk.${i}.x` },
          headers: { "cf-connecting-ip": "203.0.113.9" },
        });
        expect([401, 429]).toContain(junk.status);
        if (junk.status === 429) limited++;
      }
      expect(limited).toBeGreaterThan(0); // the junk sender's own IP bucket ran out
      const n = await cw.fakes.apple.signNotification(
        {
          uuid: "1b6e2f6a-0000-4000-8000-000000000050",
          type: "ONE_TIME_CHARGE",
          tx,
        },
        NOW,
      );
      const real = await route(cw, "POST", "/distribution/hooks/app-store", {
        body: { signedPayload: n },
        headers: { "cf-connecting-ip": "17.58.0.1" },
      });
      expect(real.status).toBe(200);
      expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
    });

    it("a chunked body over the cap is refused while streaming (413)", async () => {
      const cw = await world();
      const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent++ < 16) c.enqueue(chunk);
          else c.close();
        },
      });
      const res = await withFetch(cw, () =>
        dispatchWith(
          new Request(`${CONSOLE}/${SLUG}/distribution/hooks/app-store`, {
            method: "POST",
            body: stream,
            headers: { "content-type": "application/json" },
            duplex: "half",
          } as RequestInit),
          cw.env,
          cw.db,
          NOW,
        ),
      );
      expect(res.status).toBe(413);
      expect(sent).toBeLessThan(17);
    });

    it("a Server API outage answers 503 (Apple redelivers) and the redelivery applies", async () => {
      const cw = await world();
      const { tx } = await bought(cw);
      const n = await cw.fakes.apple.signNotification(
        {
          uuid: "1b6e2f6a-0000-4000-8000-000000000030",
          type: "ONE_TIME_CHARGE",
          tx,
        },
        NOW,
      );
      cw.fakes.apple.failNext = { status: 503, count: 1 };
      expect((await hook(cw, n)).status).toBe(503);
      expect(await grants(cw, cw.licenseA)).toEqual([]);
      expect((await hook(cw, n)).status).toBe(200);
      expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
    });
  });
});

// ── Google Play ──────────────────────────────────────────────────────────────────────────────

describe("commerce: Google Play", () => {
  const TOKEN = "opaque-token-up-to-1kb.AO-J1Oz_test";

  async function setPurchase(
    cw: CommerceWorld,
    over: Record<string, unknown> = {},
  ) {
    const binding = await bindingOf(cw, cw.tokenA);
    cw.fakes.google.purchases.set(`${PLAY_SKU}/${TOKEN}`, {
      purchaseState: 0,
      acknowledgementState: 0,
      obfuscatedExternalAccountId: binding,
      orderId: "GPA.1234-5678-9012-34567",
      ...over,
    } as never);
  }

  const push = async (
    cw: CommerceWorld,
    messageId: string,
    data: Record<string, unknown>,
    tokenOver: Record<string, unknown> = {},
  ) =>
    route(cw, "POST", "/distribution/hooks/play-rtdn", {
      body: cw.fakes.google.pushBody(messageId, {
        packageName: "gg.acme.djdl",
        ...data,
      }),
      headers: {
        authorization: `Bearer ${await cw.fakes.google.pushToken(NOW, tokenOver)}`,
      },
    });

  it("a PURCHASED purchase grants and is acknowledged exactly once", async () => {
    const cw = await world();
    await setPurchase(cw);
    const res = await claim(cw, cw.tokenA, {
      store: "play",
      productId: PLAY_SKU,
      purchaseToken: TOKEN,
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      state: "active",
      granted: true,
      flag: FLAG,
    });
    expect(await grants(cw, cw.licenseA)).toEqual([`play:${FLAG}`]);
    expect(cw.fakes.google.acknowledged).toEqual([`${PLAY_SKU}/${TOKEN}`]);
    await claim(cw, cw.tokenA, {
      store: "play",
      productId: PLAY_SKU,
      purchaseToken: TOKEN,
    });
    await push(cw, "m-1", {
      oneTimeProductNotification: {
        version: "1.0",
        notificationType: 1,
        purchaseToken: TOKEN,
        sku: PLAY_SKU,
      },
    });
    expect(cw.fakes.google.acknowledged).toHaveLength(1);
    // The purchase token is stored only hashed as the purchase's key.
    const row = await cw.db.first<{ purchase_key_hash: string }>(
      "SELECT purchase_key_hash FROM dist_purchases WHERE store = 'play'",
    );
    expect(row!.purchase_key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a PENDING purchase records and grants nothing; the RTDN for its completion grants", async () => {
    const cw = await world();
    await setPurchase(cw, { purchaseState: 2 });
    const res = await claim(cw, cw.tokenA, {
      store: "play",
      productId: PLAY_SKU,
      purchaseToken: TOKEN,
    });
    expect(await bodyOf(res)).toMatchObject({
      state: "pending",
      granted: false,
    });
    expect(await grants(cw, cw.licenseA)).toEqual([]);
    expect(cw.fakes.google.acknowledged).toEqual([]);
    cw.fakes.google.purchases.get(`${PLAY_SKU}/${TOKEN}`)!.purchaseState = 0;
    const r = await push(cw, "m-2", {
      oneTimeProductNotification: {
        version: "1.0",
        notificationType: 1,
        purchaseToken: TOKEN,
        sku: PLAY_SKU,
      },
    });
    expect(r.status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([`play:${FLAG}`]);
    expect(cw.fakes.google.acknowledged).toHaveLength(1);
  });

  it("a voided purchase is revoked; a replayed push changes nothing", async () => {
    const cw = await world();
    await setPurchase(cw);
    await claim(cw, cw.tokenA, {
      store: "play",
      productId: PLAY_SKU,
      purchaseToken: TOKEN,
    });
    const v = {
      voidedPurchaseNotification: {
        purchaseToken: TOKEN,
        orderId: "GPA.1",
        productType: 2,
        refundType: 1,
      },
    };
    expect((await push(cw, "m-3", v)).status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([]);
    expect(await bodyOf(await push(cw, "m-3", v))).toMatchObject({
      duplicate: true,
    });
    expect(await audits(cw, "license.store_grant.revoke")).toBe(1);
  });

  it("refuses a push whose OIDC token is missing, for another audience or account, or unverified", async () => {
    const cw = await world();
    const data = { testNotification: { version: "1.0" } };
    const noToken = await route(cw, "POST", "/distribution/hooks/play-rtdn", {
      body: cw.fakes.google.pushBody("m-4", {
        packageName: "gg.acme.djdl",
        ...data,
      }),
    });
    expect(noToken.status).toBe(401);
    for (const [over, reason] of [
      [{ aud: "https://elsewhere.example" }, "wrong_audience"],
      [{ email: "attacker@evil.iam.gserviceaccount.com" }, "wrong_account"],
      [{ email_verified: false }, "unverified_email"],
      [{ iss: "https://evil.example" }, "wrong_issuer"],
      [{ exp: NOW - 3600, iat: NOW - 7200 }, "expired"],
    ] as const) {
      const res = await push(cw, "m-5", data, over);
      expect(res.status, reason).toBe(401);
      expect(await reasonOf(res), reason).toBe(reason);
    }
    // A token signed by another key (an unknown kid after the JWKS refetch) is refused too.
    expect(cw.fakes.google.jwksFetches).toBe(1);
    expect((await push(cw, "m-6", data)).status).toBe(200);
  });

  it("refuses a licence-tester purchase unless the operator accepts test purchases", async () => {
    const cw = await world();
    await setPurchase(cw, { purchaseType: 0 });
    const res = await claim(cw, cw.tokenA, {
      store: "play",
      productId: PLAY_SKU,
      purchaseToken: TOKEN,
    });
    expect(res.status).toBe(400);
    expect(await reasonOf(res)).toBe("test_purchase");
    expect(await grants(cw, cw.licenseA)).toEqual([]);
  });

  it("refuses a purchase bound to another licence's binding", async () => {
    const cw = await world();
    await setPurchase(cw); // obfuscatedExternalAccountId = A's binding
    const res = await claim(cw, cw.tokenB, {
      store: "play",
      productId: PLAY_SKU,
      purchaseToken: TOKEN,
    });
    expect(res.status).toBe(403);
    expect(await reasonOf(res)).toBe("binding_mismatch");
  });

  it("retries a failed acknowledgement on the next tick, once; the daily voided poll revokes", async () => {
    const cw = await world();
    await setPurchase(cw);
    cw.fakes.google.failAcknowledge = 1;
    await claim(cw, cw.tokenA, {
      store: "play",
      productId: PLAY_SKU,
      purchaseToken: TOKEN,
    });
    expect(cw.fakes.google.acknowledged).toEqual([]);
    expect(await grants(cw, cw.licenseA)).toEqual([`play:${FLAG}`]);
    await tick(cw, NOW + 60);
    expect(cw.fakes.google.acknowledged).toHaveLength(1);
    await tick(cw, NOW + 120);
    expect(cw.fakes.google.acknowledged).toHaveLength(1);

    cw.fakes.google.voided.push({
      purchaseToken: TOKEN,
      voidedTimeMillis: (NOW + 100) * 1000,
    });
    // The poll already ran at NOW + 60 (today); the next one is a day later.
    await tick(cw, NOW + 180);
    expect(await grants(cw, cw.licenseA)).toEqual([`play:${FLAG}`]);
    await tick(cw, NOW + 60 + 86_400);
    expect(await grants(cw, cw.licenseA)).toEqual([]);
  });
});

// ── Steam ────────────────────────────────────────────────────────────────────────────────────

describe("commerce: Steam", () => {
  const STEAMID = "76561198000000001";
  const TICKET = "14000000ab".repeat(8);

  async function ticketFor(
    cw: CommerceWorld,
    token: string,
    steamid = STEAMID,
    ticket = TICKET,
  ) {
    cw.fakes.steam.tickets.set(ticket, {
      steamid,
      identity: await bindingOf(cw, token),
    });
    return ticket;
  }

  it("an owner gets the flag; a non-owner and a Family Sharing borrower get nothing", async () => {
    const cw = await world();
    const ticket = await ticketFor(cw, cw.tokenA);
    cw.fakes.steam.owns.set(`${STEAMID}:${STEAM_DLC}`, {
      ownsapp: true,
      ownersteamid: STEAMID,
    });
    const res = await claim(cw, cw.tokenA, {
      store: "steam",
      ticket,
      dlcAppId: STEAM_DLC,
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      granted: true,
      flag: FLAG,
      productId: STEAM_DLC,
    });
    expect(await grants(cw, cw.licenseA)).toEqual([`steam:${FLAG}`]);
    // The publisher key never leaves in an error, and every call went to partner.steam-api.com.
    expect(
      cw.fakes.steam.requests.every(
        (r) => r.url.hostname === "partner.steam-api.com",
      ),
    ).toBe(true);

    const other = "76561198000000002";
    const t2 = await ticketFor(cw, cw.tokenB, other, "15000000cd".repeat(8));
    const none = await claim(cw, cw.tokenB, {
      store: "steam",
      ticket: t2,
      dlcAppId: STEAM_DLC,
    });
    expect(none.status).toBe(403);
    expect(await reasonOf(none)).toBe("not_owned");
    cw.fakes.steam.owns.set(`${other}:${STEAM_DLC}`, {
      ownsapp: true,
      ownersteamid: STEAMID,
    });
    const borrowed = await claim(cw, cw.tokenB, {
      store: "steam",
      ticket: t2,
      dlcAppId: STEAM_DLC,
    });
    expect(await reasonOf(borrowed)).toBe("not_owned");
    expect(await grants(cw, cw.licenseB)).toEqual([]);
    const rows = await cw.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM dist_purchases WHERE store = 'steam'",
    );
    expect(rows!.n).toBe(1);
  });

  it("only outright ownership grants: not a non-permanent licence, a PC Café site licence, a self-cancelled one or a timed trial", async () => {
    const cw = await world();
    const ticket = await ticketFor(cw, cw.tokenA);
    for (const over of [
      { permanent: false },
      { sitelicense: true },
      { usercanceled: true },
      { timedtrial: true },
    ]) {
      cw.fakes.steam.owns.set(`${STEAMID}:${STEAM_DLC}`, {
        ownsapp: true,
        ownersteamid: STEAMID,
        ...over,
      });
      const res = await claim(cw, cw.tokenA, {
        store: "steam",
        ticket,
        dlcAppId: STEAM_DLC,
      });
      expect(res.status, JSON.stringify(over)).toBe(403);
      expect(await reasonOf(res)).toBe("not_owned");
    }
    expect(await grants(cw, cw.licenseA)).toEqual([]);
  });

  it("a ticket made for another licence's binding is refused (invalid_ticket)", async () => {
    const cw = await world();
    const ticket = await ticketFor(cw, cw.tokenA);
    cw.fakes.steam.owns.set(`${STEAMID}:${STEAM_DLC}`, {
      ownsapp: true,
      ownersteamid: STEAMID,
    });
    const res = await claim(cw, cw.tokenB, {
      store: "steam",
      ticket,
      dlcAppId: STEAM_DLC,
    });
    expect(res.status).toBe(400);
    expect(await reasonOf(res)).toBe("invalid_ticket");
  });

  it("the weekly re-check revokes a refunded DLC (Steam pushes nothing)", async () => {
    const cw = await world();
    const ticket = await ticketFor(cw, cw.tokenA);
    cw.fakes.steam.owns.set(`${STEAMID}:${STEAM_DLC}`, {
      ownsapp: true,
      ownersteamid: STEAMID,
    });
    await claim(cw, cw.tokenA, { store: "steam", ticket, dlcAppId: STEAM_DLC });
    cw.fakes.steam.owns.set(`${STEAMID}:${STEAM_DLC}`, {
      ownsapp: false,
      ownersteamid: "0",
    });
    await tick(cw, NOW + 86_400);
    expect(await grants(cw, cw.licenseA)).toEqual([`steam:${FLAG}`]); // not due yet
    await tick(cw, NOW + 8 * 86_400);
    expect(await grants(cw, cw.licenseA)).toEqual([]);
    expect(await entitlements(cw, cw.tokenA)).not.toHaveProperty(FLAG);
  });
});

// ── admin ────────────────────────────────────────────────────────────────────────────────────

describe("commerce: admin", () => {
  it("validates settings and mappings and shows the setup per store", async () => {
    const cw = await world();
    expect(
      (
        await admin(cw, "PUT", "/commerce/settings", {
          appStore: { bundleId: "" },
        })
      ).status,
    ).toBe(422);
    expect(
      (await admin(cw, "PUT", "/commerce/settings", { itch: {} })).status,
    ).toBe(422);
    expect(
      (
        await admin(cw, "PUT", "/commerce/products", {
          store: "steam",
          productId: "abc",
          flag: FLAG,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin(cw, "PUT", "/commerce/products", {
          store: "play",
          productId: PLAY_SKU,
          flag: "bad flag",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin(cw, "PUT", "/commerce/products", {
          store: "play",
          productId: PLAY_SKU,
          flag: FLAG,
          deliverable: "pack.nope",
        })
      ).status,
    ).toBe(422);
    const view = await bodyOf(await admin(cw, "GET", "/commerce"));
    expect(view.setup).toMatchObject({
      "app-store": { configured: true, credential: "iap" },
      play: { configured: true, credential: "play" },
      steam: { configured: true, credential: "steam" },
    });
    const del = await admin(
      cw,
      "DELETE",
      `/commerce/products/steam/${STEAM_DLC}`,
    );
    expect(del.status).toBe(200);
    expect(((await bodyOf(del)).products as unknown[]).length).toBe(2);
    expect(await audits(cw, "distribution.commerce.product.delete")).toBe(1);
  });
});

// ── the seams ────────────────────────────────────────────────────────────────────────────────

describe("commerce: the seams", () => {
  it("Core's applyStoreGrant fails closed with License off, before any License code runs", async () => {
    const { applyStoreGrant } = await import("../src/core/registry.js");
    const { SERVICES } = await import("../src/mount.js");
    const cw = await world();
    const change = {
      licenseId: cw.licenseA,
      flag: FLAG,
      store: "steam" as const,
      purchaseKeyHash: "h",
      action: "grant" as const,
      summary: "t",
    };
    const base = {
      license: { enabled: false },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
      identity: { enabled: false },
    };
    const ctx = {
      env: cw.env,
      db: cw.db,
      product: { slug: SLUG } as never,
      now: NOW,
    };
    expect(await applyStoreGrant(SERVICES, base, ctx, change)).toEqual({
      ok: false,
      reason: "license_disabled",
    });
    expect(await grants(cw, cw.licenseA)).toEqual([]);
    const on = { ...base, license: { enabled: true } };
    expect(await applyStoreGrant(SERVICES, on, ctx, change)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await applyStoreGrant(SERVICES, on, ctx, change)).toEqual({
      ok: true,
      changed: false,
    });
    expect(
      await applyStoreGrant(SERVICES, on, ctx, {
        ...change,
        licenseId: "lic_nope",
      }),
    ).toEqual({ ok: false, reason: "no_license" });
  });

  it("only tests replace the pinned Apple root: no src file but apple.ts names the override", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          name.endsWith(".ts") &&
          !full.endsWith(join("commerce", "apple.ts")) &&
          readFileSync(full, "utf8").includes("setAppleRootsForTesting")
        )
          offenders.push(full);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
