/**
 * A-16 — the platform's team-level Steam connection: the group's Steamworks Web API publisher key
 * (`steam.publisher-key`, Worker secret `PLATFORM_STEAM_PUBLISHER_KEY`, `{"key"}`), with
 * per-product pins to the game's app id.
 *
 * The ASC matrix against the fake Steam: platform admins only, metadata only (never the key),
 * the listing (`GetPartnerAppListForWebAPIKey` plus the operator-entered `steam.appIds`, which
 * alone serve a key without the listing permission), assignment conflicts, and the commerce
 * bridge's fallback with the app-id pin as the boundary (the open itself refuses another
 * product's game); own keys first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import {
  openPlatformCredential,
  setPlatformPin,
} from "../src/core/platformCredentials.js";
import { steamCredential } from "../src/services/distribution/commerce/steam.js";
import { seedProduct } from "./seed.js";
import { SLUG } from "./releaseRoutesFixture.js";
import { fakeFetch, STEAM_APP, STEAM_DLC, STEAM_KEY } from "./commerceFake.js";
import {
  bindingOf,
  commerceWorld,
  grants,
  route,
  type CommerceWorld,
} from "./commerceWorld.js";
import { bodyOf, platformApi, productAudits } from "./platformApi.js";
import { NOW } from "./seed.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});

const OTHER = "other";
const STEAMID = "76561198000000001";
const TICKET = "14000000ab".repeat(8);

let cw: CommerceWorld | null = null;
afterEach(() => {
  cw?.close();
  cw = null;
  vi.useRealTimers();
});

async function world(opts: { secret?: boolean } = {}) {
  cw = await commerceWorld({ credentials: false });
  if (opts.secret !== false)
    (cw.env as Record<string, unknown>).PLATFORM_STEAM_PUBLISHER_KEY =
      JSON.stringify({ key: STEAM_KEY });
  await seedProduct(cw.db, OTHER);
  return cw;
}

const api = (w: CommerceWorld, method: string, path: string, body?: unknown) =>
  platformApi(
    { env: w.env, db: w.db, fetchImpl: fakeFetch(w.fakes, () => w.now) },
    method,
    path,
    body,
  );

async function claimSteam(w: CommerceWorld) {
  w.fakes.steam.tickets.set(TICKET, {
    steamid: STEAMID,
    identity: await bindingOf(w, w.tokenA),
  });
  w.fakes.steam.owns.set(`${STEAMID}:${STEAM_DLC}`, {
    ownsapp: true,
    ownersteamid: STEAMID,
  });
  return route(w, "POST", "/distribution/commerce/claim", {
    token: w.tokenA,
    body: { store: "steam", ticket: TICKET, dlcAppId: STEAM_DLC },
  });
}

describe("platform Steam", () => {
  it("is platform-admin only and never shows the key", async () => {
    const w = await world();
    expect(
      (
        await platformApi(
          { env: w.env, db: w.db },
          "GET",
          "/steam/apps",
          undefined,
          ["x"],
        )
      ).status,
    ).toBe(403);
    const put = await api(w, "PUT", "/steam", { value: { key: STEAM_KEY } });
    expect(put.status).toBe(200);
    expect(JSON.stringify(await bodyOf(put))).not.toContain(STEAM_KEY);
    expect(JSON.stringify(await bodyOf(await api(w, "GET", "")))).not.toContain(
      STEAM_KEY,
    );
  });

  it("lists the group's apps plus the operator-entered ones; the operator list alone serves a key without the listing permission", async () => {
    const w = await world();
    await api(w, "PUT", "/steam/settings/appIds", { value: "1234560" });
    const res = await api(w, "GET", "/steam/apps");
    expect(res.status).toBe(200);
    const body = (await bodyOf(res)) as {
      apps: Array<{
        appId: string;
        name: string | null;
        status: { source: string };
      }>;
    };
    expect(body.apps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appId: STEAM_APP,
          name: "djdl",
          status: expect.objectContaining({ source: "steam" }),
        }),
        expect.objectContaining({
          appId: "1234560",
          status: { source: "operator" },
        }),
      ]),
    );
    // No request ever carried the key anywhere but partner.steam-api.com.
    expect(
      w.fakes.steam.requests.every(
        (r) => r.url.hostname === "partner.steam-api.com",
      ),
    ).toBe(true);

    const w2 = await world();
    w2.fakes.steam.partnerApps = null;
    await api(w2, "PUT", "/steam/settings/appIds", {
      value: `${STEAM_APP},777`,
    });
    const l2 = (await bodyOf(await api(w2, "GET", "/steam/apps"))) as {
      listed?: boolean;
      apps: Array<{ appId: string }>;
    };
    expect(l2.listed).toBe(false);
    expect(l2.apps.map((a) => a.appId)).toEqual([STEAM_APP, "777"]);
    expect(
      (await api(w2, "PUT", "/steam/settings/appIds", { value: "abc" })).status,
    ).toBe(422);
  });

  it("commerce falls back to the group key only for the assigned game, audited in the product's trail", async () => {
    const w = await world();
    expect((await claimSteam(w)).status).toBe(404);
    expect(w.fakes.steam.requests).toEqual([]);

    expect(
      (
        await api(w, "PUT", `/steam/apps/${STEAM_APP}/product`, {
          product: SLUG,
        })
      ).status,
    ).toBe(200);
    w.fakes.steam.requests.length = 0;
    const res = await claimSteam(w);
    expect(res.status).toBe(200);
    expect(await grants(w, w.licenseA)).toHaveLength(1);
    const opens = (await productAudits(w.db, SLUG)).filter(
      (a) => a.action === "platform_credential.use",
    );
    expect(opens.length).toBeGreaterThan(0);
    expect(opens[0]!.target_id).toBe("steam.publisher-key");
  });

  it("never serves another product's game: assignment refused, and the open refuses djdl", async () => {
    const w = await world();
    await api(w, "PUT", `/steam/apps/${STEAM_APP}/product`, { product: OTHER });
    const taken = await api(w, "PUT", `/steam/apps/${STEAM_APP}/product`, {
      product: SLUG,
    });
    expect(taken.status).toBe(409);
    expect(await steamCredential(w.env, w.db, SLUG, STEAM_APP)).toBeNull();
    expect(
      await openPlatformCredential(
        w.env,
        w.db,
        "steam.publisher-key",
        "commerce:steam",
        { product: SLUG, pin: STEAM_APP },
        NOW,
      ),
    ).toBeNull();
    expect((await claimSteam(w)).status).toBe(404);
  });

  it("a product's own key wins, and a mis-pinned own key never falls through", async () => {
    const w = await world();
    await setPlatformPin(w.db, {
      id: "steam.publisher-key",
      product: SLUG,
      pin: STEAM_APP,
      actor: "x",
      now: NOW,
    });
    await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "steam",
      kind: "steam-publisher-key",
      outletId: null,
      value: { key: STEAM_KEY },
      pin: STEAM_APP,
      expiresAt: null,
      actor: "x",
      now: NOW,
    });
    expect(await steamCredential(w.env, w.db, SLUG, STEAM_APP)).toBe("steam");
    await w.db.run(
      'UPDATE outlet_credentials SET meta_json = \'{"appId":"999"}\' WHERE product = ?',
      SLUG,
    );
    expect(await steamCredential(w.env, w.db, SLUG, STEAM_APP)).toBeNull();
  });
});
