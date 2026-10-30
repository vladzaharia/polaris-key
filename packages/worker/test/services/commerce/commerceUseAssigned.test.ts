/**
 * A-28.3 (CM-20 D14): the mismatch between a typed commerce identity and the assigned app is
 * visible (`identity` on the view, the `storefront.identity_mismatch` attention item) and fixable
 * (`POST …/commerce/settings/<store>/use-assigned`, which the server works out).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../../src/core/rbac/can.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { syntheticKey } from "../../syntheticPrincipals.js";
import {
  consoleActor,
  consoleTestSession,
} from "../../consoleSessionHelper.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { effectiveCommerceSettings } from "../../../src/services/commerce/identity.js";
import {
  storefrontIdentityAmbiguities,
  storefrontIdentityMismatches,
} from "../../../src/services/commerce/public.js";
import { putOutletCredential } from "../../../src/core/outletCredentials.js";
import { generateKeyPairSync } from "node:crypto";
import { SLUG } from "../../releaseRoutesFixture.js";
import { NOW } from "../../seed.js";
import { BUNDLE_ID, PLAY_PACKAGE, STEAM_APP } from "../../commerceFake.js";
import {
  SETTINGS,
  commerceWorld,
  type CommerceWorld,
} from "../../commerceWorld.js";

const SYNTHETIC = new Map<string, Principal>();
vi.mock("../../../src/core/rbac/principal.js", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../../src/core/rbac/principal.js")
    >();
  return {
    ...real,
    resolvePrincipal: async (
      ...args: Parameters<typeof real.resolvePrincipal>
    ) =>
      SYNTHETIC.get(syntheticKey(args[2].sub)) ??
      real.resolvePrincipal(...args),
  };
});
const grant = (sub: string, areas: string[] | null) =>
  SYNTHETIC.set(sub, {
    memberId: sub,
    grants: [
      {
        role: "product_admin",
        scope: `product:${SLUG}`,
        areas,
        source: "grant",
      },
    ],
  } as Principal);
grant("m-commerce", ["commerce"]);
grant("m-ship", ["ship"]);
grant("m-license", ["license"]);

let w: CommerceWorld | null = null;
afterEach(() => {
  w?.close();
  w = null;
});

const allOn = (over: Record<string, { enabled: boolean }>) => ({
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: true },
  identity: { enabled: false },
  sync: { enabled: false },
  commerce: { enabled: true },
  connect: { enabled: false },
  ...over,
});

const OTHER = "gg.other.app";
const MISMATCHED = {
  appStore: { bundleId: OTHER, appAppleId: 1234567890, acceptSandbox: true },
  play: { ...SETTINGS.play, packageName: "gg.other.play" },
  steam: { appId: "999" },
};

async function world(opts: Parameters<typeof commerceWorld>[0] = {}) {
  w = await commerceWorld(opts);
  return w;
}

async function call(
  cw: CommerceWorld,
  method: string,
  path: string,
  sub = "u1",
): Promise<{ status: number; json: any }> {
  const { token, session } = await consoleTestSession(
    cw.env,
    cw.db,
    { sub, name: sub, email: `${sub}@x.io`, groups: ["platform-admins"] },
    NOW,
  );
  const res = await handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
      },
    }),
    cw.env,
    cw.db,
    path,
    { now: NOW },
  );
  return { status: res.status, json: await res.json().catch(() => null) };
}
const base = `/api/products/${SLUG}/commerce`;
const useAssigned = (cw: CommerceWorld, store: string, sub?: string) =>
  call(cw, "POST", `${base}/settings/${store}/use-assigned`, sub);
const attention = async (cw: CommerceWorld, sub?: string) =>
  (await call(cw, "GET", "/api/attention", sub)).json.items.filter(
    (i: { kind: string }) => i.kind === "storefront.identity_mismatch",
  );

describe("the view's identity", () => {
  it("carries value, source, assigned and mismatch per store", async () => {
    const cw = await world({ settings: MISMATCHED });
    const v = (await call(cw, "GET", base)).json;
    expect(v.identity["app-store"]).toEqual({
      value: OTHER,
      source: "typed",
      assigned: BUNDLE_ID,
      mismatch: true,
      ambiguous: false,
    });
    expect(v.identity.steam.assigned).toBe(STEAM_APP);
    expect(v.settings.appStore.bundleId).toBe(OTHER); // stored values, as typed
  });
});

describe("POST …/settings/<store>/use-assigned", () => {
  it("clears that store's typed identity only, audits before and after, and is idempotent", async () => {
    const cw = await world({ settings: MISMATCHED });
    const r = await useAssigned(cw, "app-store");
    expect(r.status).toBe(200);
    expect(r.json.settings.appStore).toEqual({
      bundleId: null,
      appAppleId: null,
      acceptSandbox: true, // other fields stay
    });
    expect(r.json.identity["app-store"]).toEqual({
      value: BUNDLE_ID,
      source: "assigned",
      assigned: BUNDLE_ID,
      mismatch: false,
      ambiguous: false,
    });
    // The other stores are untouched.
    expect(r.json.settings.play.packageName).toBe("gg.other.play");
    expect(r.json.settings.steam.appId).toBe("999");

    const rows = await cw.db.all<{
      action: string;
      actor_sub: string;
      before_json: string;
      after_json: string;
    }>(
      "SELECT action, actor_sub, before_json, after_json FROM audit WHERE product = ? AND action = 'commerce.binding.derived'",
      SLUG,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_sub).toBe(await consoleActor(cw.env, cw.db, "u1"));
    expect(JSON.parse(rows[0]!.before_json)).toEqual({
      store: "app-store",
      typed: { bundleId: OTHER, appAppleId: 1234567890 },
    });
    expect(JSON.parse(rows[0]!.after_json)).toEqual({
      store: "app-store",
      typed: {},
      assigned: BUNDLE_ID,
    });

    // Again: nothing typed, nothing written, nothing audited.
    expect((await useAssigned(cw, "app-store")).status).toBe(200);
    const again = await cw.db.all(
      "SELECT 1 FROM audit WHERE product = ? AND action = 'commerce.binding.derived'",
      SLUG,
    );
    expect(again).toHaveLength(1);
  });

  it("clears play's package name and steam's app id", async () => {
    const cw = await world({ settings: MISMATCHED });
    const p = await useAssigned(cw, "play");
    expect(p.json.settings.play.packageName).toBeNull();
    expect(p.json.settings.play.pushAudience).toBe(SETTINGS.play.pushAudience);
    expect(p.json.identity.play.value).toBe(PLAY_PACKAGE);
    const s = await useAssigned(cw, "steam");
    expect(s.json.settings.steam.appId).toBeNull();
    expect(s.json.identity.steam.value).toBe(STEAM_APP);
    expect(
      (await effectiveCommerceSettings(cw.db, SLUG)).settings.steam,
    ).toEqual({ appId: STEAM_APP });
  });

  it("answers 409 no_assigned_app when the store has no assigned app, and changes nothing", async () => {
    const cw = await world({ credentials: false, settings: MISMATCHED });
    const r = await useAssigned(cw, "steam");
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("no_assigned_app");
    expect(
      (await effectiveCommerceSettings(cw.db, SLUG)).stored.steam?.appId,
    ).toBe("999");
  });

  it("answers 409 commerce_requires_license while License is off", async () => {
    const cw = await world({ settings: MISMATCHED });
    await setServices(
      cw.db,
      SLUG,
      serializeServices({ services: allOn({ license: { enabled: false } }) }),
      "admin",
      NOW,
    );
    const r = await useAssigned(cw, "app-store");
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("commerce_requires_license");
  });

  it("writes nothing for a store with no block (D13: it stays off)", async () => {
    const cw = await world({ settings: { steam: { appId: "999" } } });
    const r = await useAssigned(cw, "play");
    expect(r.status).toBe(200);
    expect(r.json.settings.play).toBeNull();
    expect(r.json.identity.play.value).toBeNull();
  });

  it("is POST only, and an unknown store is not a route", async () => {
    const cw = await world({ settings: MISMATCHED });
    expect(
      (await call(cw, "GET", `${base}/settings/steam/use-assigned`)).status,
    ).toBe(405);
    expect((await useAssigned(cw, "nope")).status).not.toBe(200);
  });

  it("needs the commerce area: a member holding only ship gets 403 and nothing changes", async () => {
    const cw = await world({ settings: MISMATCHED });
    expect((await useAssigned(cw, "app-store", "m-ship")).status).toBe(403);
    expect(
      (await effectiveCommerceSettings(cw.db, SLUG)).stored.appStore?.bundleId,
    ).toBe(OTHER);
    expect((await useAssigned(cw, "app-store", "m-commerce")).status).toBe(200);
  });
});

describe("storefront.identity_mismatch", () => {
  it("lists a mismatched store, clears when fixed, and only commerce holders see it", async () => {
    const cw = await world({ settings: MISMATCHED });
    expect(await storefrontIdentityMismatches(cw.db, SLUG)).toEqual([
      { store: "app-store", typed: OTHER, assigned: BUNDLE_ID },
      { store: "play", typed: "gg.other.play", assigned: PLAY_PACKAGE },
      { store: "steam", typed: "999", assigned: STEAM_APP },
    ]);
    const items = await attention(cw);
    expect(items.map((i: { id: string }) => i.id)).toEqual([
      `${SLUG}:storefront.identity_mismatch:app-store`,
      `${SLUG}:storefront.identity_mismatch:play`,
      `${SLUG}:storefront.identity_mismatch:steam`,
    ]);
    expect(items[0]).toMatchObject({
      tone: "warning",
      area: "commerce",
      service: "commerce",
    });
    expect(items[0].lines[0]).toContain(OTHER);
    expect(items[0].lines[0]).toContain(BUNDLE_ID);
    // The fix is on the Commerce page, which a commerce-only member can open.
    expect(items[0].action.page).toBe("commerce-overview");

    expect(await attention(cw, "m-ship")).toEqual([]);
    expect(await attention(cw, "m-commerce")).toHaveLength(3);

    await useAssigned(cw, "app-store");
    await useAssigned(cw, "play");
    await useAssigned(cw, "steam");
    expect(await attention(cw)).toEqual([]);
    expect(await storefrontIdentityMismatches(cw.db, SLUG)).toEqual([]);
  });

  it("is absent when typed equals assigned, and when Commerce is off", async () => {
    const cw = await world({ settings: SETTINGS });
    expect(await attention(cw)).toEqual([]);
    // Commerce off: a block left over is not news.
    const m = await world({ settings: MISMATCHED });
    await setServices(
      m.db,
      SLUG,
      serializeServices({ services: allOn({ commerce: { enabled: false } }) }),
      "admin",
      NOW,
    );
    expect(await attention(m)).toEqual([]);
  });
});

const p8Pem = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

describe("storefront.identity_ambiguous (D15)", () => {
  const ambiguousItems = async (cw: CommerceWorld, sub?: string) =>
    (await call(cw, "GET", "/api/attention", sub)).json.items.filter(
      (i: { kind: string }) => i.kind === "storefront.identity_ambiguous",
    );

  it("is raised when a field is left out and two own keys name different apps", async () => {
    const cw = await world({
      settings: { appStore: {}, steam: {}, play: { ...SETTINGS.play } },
    });
    expect(await storefrontIdentityAmbiguities(cw.db, SLUG)).toEqual([]);
    expect(await ambiguousItems(cw)).toEqual([]);
    const r = await putOutletCredential(cw.env, cw.db, {
      product: SLUG,
      credentialId: "iap2",
      kind: "app-store-server-key",
      outletId: null,
      value: {
        keyId: "IAPKEY5678",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: p8Pem(),
      },
      pin: "gg.other.app",
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(await storefrontIdentityAmbiguities(cw.db, SLUG)).toEqual([
      { store: "app-store", value: BUNDLE_ID },
    ]);
    const items = await ambiguousItems(cw);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `${SLUG}:storefront.identity_ambiguous:app-store`,
      area: "commerce",
      service: "commerce",
      tone: "warning",
      action: { page: "commerce-overview" },
    });
    expect(items[0].lines.join(" ")).toContain(BUNDLE_ID);
    expect(await ambiguousItems(cw, "m-commerce")).toHaveLength(1);
    expect(await ambiguousItems(cw, "m-ship")).toEqual([]);
    expect(items[0].short).toBe("Keys disagree");
  });

  it("is not raised while a typed value is in force: a mismatched store shows one item", async () => {
    const cw = await world({
      settings: {
        appStore: { bundleId: "com.typo.app" },
        steam: {},
        play: { ...SETTINGS.play },
      },
    });
    const r = await putOutletCredential(cw.env, cw.db, {
      product: SLUG,
      credentialId: "iap2",
      kind: "app-store-server-key",
      outletId: null,
      value: {
        keyId: "IAPKEY5678",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: p8Pem(),
      },
      pin: "gg.other.app",
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    const e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.identity["app-store"]).toMatchObject({
      source: "typed",
      mismatch: true,
      ambiguous: false,
    });
    expect(await storefrontIdentityAmbiguities(cw.db, SLUG)).toEqual([]);
    expect(await ambiguousItems(cw)).toEqual([]);
    const all = (await call(cw, "GET", "/api/attention")).json.items;
    expect(
      all.filter((i: { kind: string }) =>
        i.kind.startsWith("storefront.identity"),
      ),
    ).toHaveLength(1);
  });
});

describe("attention reads follow the member's areas", () => {
  it("a license-only member triggers no binding reads; a commerce member does", async () => {
    const cw = await world({ settings: MISMATCHED });
    const reads: string[] = [];
    // Object.create keeps the rest of the Db (`run`, which the sign-in writes through).
    const counting = Object.assign(Object.create(cw.db), {
      all: (sql: string, ...p: unknown[]) => (
        reads.push(sql),
        (cw.db.all as any)(sql, ...p)
      ),
      first: (sql: string, ...p: unknown[]) => (
        reads.push(sql),
        (cw.db.first as any)(sql, ...p)
      ),
    });
    const binding = (sql: string) =>
      /platform_credentials|outlet_credentials|dist_connector_settings|dist_outlets/.test(
        sql,
      );
    const as = async (sub: string) => {
      reads.length = 0;
      const out = await call(
        { ...cw, db: counting } as CommerceWorld,
        "GET",
        "/api/attention",
        sub,
      );
      expect(out.status).toBe(200);
      return reads.filter(binding).length;
    };
    expect(await as("m-license")).toBe(0);
    expect(await as("m-commerce")).toBeGreaterThan(0);
  });
});
