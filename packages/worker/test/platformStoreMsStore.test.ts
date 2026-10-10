/**
 * A-16 — the platform's team-level Microsoft Store connection: the seller account's Partner
 * Center app (`microsoft-store.partner-center`, Worker secret `PLATFORM_MS_PARTNER_CENTER`).
 *
 * The ASC matrix again, against the fake Microsoft: platform admins only, metadata only (never
 * the client secret), console over secret, the listing (every app of the seller, the pending
 * submission's status), assignment conflicts, and the connector's fallback with the Store ID pin
 * as the boundary at setup, token and open; own credentials first.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import {
  platformPin,
  setPlatformPin,
} from "../src/core/platformCredentials.js";
import { runConnectorPolls } from "../src/scheduled.js";
import { resolveMsStoreSetup } from "../src/services/distribution/connectors/msstore/setup.js";
import { platformMsStoreToken } from "../src/services/distribution/connectors/msstore/token.js";
import { makeTestDb } from "./helpers.js";
import {
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW, seedProduct } from "./seed.js";
import { addOutlet } from "./ascWorld.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  MsStoreFake,
  SELLER_ID,
  STORE_ID,
  TENANT_ID,
  type StoreFixtures,
} from "./msstoreFake.js";
import { bodyOf, platformApi, productAudits } from "./platformApi.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(join(HERE, "fixtures", "msstore", "store.json"), "utf8"),
) as StoreFixtures;
const OTHER = "other";
const OTHER_ID = "9WZDNCRFJ3TJ";
const VALUE = {
  tenantId: TENANT_ID,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  sellerId: SELLER_ID,
};

interface World {
  env: Env;
  db: Db;
  fake: MsStoreFake;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
}

async function world(
  opts: { secret?: boolean; own?: boolean } = {},
): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  await addOutlet(db, "ms-store", "ms-store", { productId: STORE_ID });
  await seedProduct(db, OTHER);
  if (opts.secret !== false)
    (env as Record<string, unknown>).PLATFORM_MS_PARTNER_CENTER =
      JSON.stringify(VALUE);
  if (opts.own) {
    const r = await putOutletCredential(env, db, {
      product: SLUG,
      credentialId: "partner-center",
      kind: "ms-partner-center",
      outletId: null,
      value: VALUE,
      pin: STORE_ID,
      expiresAt: null,
      actor: "x",
      now: NOW,
    });
    if (!r.ok) throw new Error(r.message);
  }
  const fake = new MsStoreFake(FIXTURES);
  fake.extraApps.push({ id: OTHER_ID, primaryName: "Other" });
  const fetchImpl = (input: string, init?: RequestInit) => {
    const host = new URL(input).hostname;
    return host.endsWith("microsoft.com") ||
      host.endsWith("microsoftonline.com")
      ? fake.fetchImpl(input, init)
      : gh.fetchImpl(input, init);
  };
  return { env, db, fake, fetchImpl };
}

const api = (w: World, method: string, path: string, body?: unknown) =>
  platformApi(w, method, path, body);

const poll = async (w: World) => {
  const saved = globalThis.fetch;
  globalThis.fetch = w.fetchImpl as typeof fetch;
  try {
    return await runConnectorPolls(w.env, w.db, NOW);
  } finally {
    globalThis.fetch = saved;
  }
};

describe("platform Microsoft Store", () => {
  it("is platform-admin only and never shows the client secret", async () => {
    const w = await world();
    expect(
      (await platformApi(w, "GET", "/microsoft-store/apps", undefined, ["x"]))
        .status,
    ).toBe(403);
    const put = await api(w, "PUT", "/microsoft-store", { value: VALUE });
    expect(put.status).toBe(200);
    expect(await bodyOf(put)).toEqual({
      ok: true,
      id: "microsoft-store.partner-center",
      source: "console",
      meta: { tenantId: TENANT_ID, clientId: CLIENT_ID, sellerId: SELLER_ID },
    });
    const all = JSON.stringify(await bodyOf(await api(w, "GET", "")));
    expect(all).not.toContain(CLIENT_SECRET);
    expect(all).toContain("PLATFORM_MS_PARTNER_CENTER");
  });

  it("lists the seller's apps with the pending submission's status, GET only", async () => {
    const w = await world();
    const res = await api(w, "GET", "/microsoft-store/apps");
    expect(res.status).toBe(200);
    const body = (await bodyOf(res)) as {
      apps: Array<{
        appId: string;
        name: string;
        status: Record<string, unknown>;
      }>;
    };
    expect(body.apps.map((a) => a.appId).sort()).toEqual(
      [STORE_ID, OTHER_ID].sort(),
    );
    expect(body.apps.find((a) => a.appId === STORE_ID)!.status).toMatchObject({
      pendingSubmission: "1152921504621243487",
      pendingStatus: "Certification",
      lastPublishedSubmission: "1152921504621086517",
    });
    expect(w.fake.requests.every((r) => r.method === "GET")).toBe(true);
    expect(w.fake.foreignHost).toEqual([]);
  });

  it("falls back to the team app only for the assigned Store ID", async () => {
    const w = await world();
    expect((await resolveMsStoreSetup(w.env, w.db, SLUG)).inert).toMatchObject({
      reason: "pin_missing",
      credentialSource: "platform",
    });
    await poll(w);
    expect(w.fake.requests).toEqual([]);

    expect(
      (
        await api(w, "PUT", `/microsoft-store/apps/${STORE_ID}/product`, {
          product: SLUG,
        })
      ).status,
    ).toBe(200);
    expect(
      (await resolveMsStoreSetup(w.env, w.db, SLUG)).setup?.credentialId,
    ).toBe("platform:microsoft-store.partner-center");
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests.length).toBeGreaterThan(0);
    expect(w.fake.requests.every((r) => r.app === STORE_ID)).toBe(true);
    expect(
      (await productAudits(w.db, SLUG)).filter(
        (a) => a.target_id === "microsoft-store.partner-center",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("never serves another product's Store ID", async () => {
    const w = await world();
    await api(w, "PUT", `/microsoft-store/apps/${STORE_ID}/product`, {
      product: OTHER,
    });
    const taken = await api(
      w,
      "PUT",
      `/microsoft-store/apps/${STORE_ID}/product`,
      {
        product: SLUG,
      },
    );
    expect(taken.status).toBe(409);
    expect(
      await platformPin(w.db, "microsoft-store.partner-center", SLUG),
    ).toBeNull();
    expect(
      await platformMsStoreToken(
        w.env,
        w.db,
        { product: SLUG, pin: STORE_ID },
        "ms-store:poll",
        NOW,
        w.fake.fetchImpl,
      ),
    ).toBeNull();
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests).toEqual([]);
  });

  it("an assignment that disagrees with the manifest is inert; an own credential wins", async () => {
    const w = await world();
    await setPlatformPin(w.db, {
      id: "microsoft-store.partner-center",
      product: SLUG,
      pin: OTHER_ID,
      actor: "x",
      now: NOW,
    });
    expect((await resolveMsStoreSetup(w.env, w.db, SLUG)).inert).toMatchObject({
      reason: "pin_mismatch",
      pinnedProductId: OTHER_ID,
    });
    const own = await world({ own: true });
    await setPlatformPin(own.db, {
      id: "microsoft-store.partner-center",
      product: SLUG,
      pin: STORE_ID,
      actor: "x",
      now: NOW,
    });
    expect(
      (await resolveMsStoreSetup(own.env, own.db, SLUG)).setup?.credentialId,
    ).toBe("partner-center");
  });
});
