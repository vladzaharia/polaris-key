/**
 * A-28.4: a live store outlet's declared identity is checked against the product's store-app
 * binding (`outletIdentityMismatches`), surfaced as the `channel.identity_mismatch` attention item
 * (area `ship`, only while Distribution is on) and as `source` on the storefront view's
 * identifiers. Connectors are unchanged (CM-20 D15): the inert `pin_mismatch` still refuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../../src/core/rbac/can.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { syntheticKey } from "../../syntheticPrincipals.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { setServices } from "../../../src/core/products/store.js";
import { setPlatformPin } from "../../../src/core/platformCredentials.js";
import {
  parseServices,
  serializeServices,
} from "../../../src/core/services.js";
import { resolveAscSetup } from "../../../src/services/distribution/connectors/asc/setup.js";
import { outletIdentityMismatches } from "../../../src/services/distribution/public.js";
import { ASC_CONTROLS } from "../../../src/services/distribution/connectors/asc/controls.js";
import {
  addOutlet,
  admin,
  ascWorld,
  APPLE_ID,
  NOW,
  SLUG,
} from "../../ascWorld.js";
import type { AscWorld } from "../../ascWorld.js";

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
const grant = (sub: string, areas: string[]) =>
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const OTHER_APP = "5555555555";

async function pin(
  w: AscWorld,
  id:
    | "app-store.in-app-purchase-key"
    | "google-play.service-account"
    | "microsoft-store.partner-center"
    | "steam.publisher-key",
  value: string,
) {
  const r = await setPlatformPin(w.db, {
    id,
    product: SLUG,
    pin: value,
    actor: "admin-1",
    now: NOW,
  });
  if (!r.ok) throw new Error(r.message);
}

async function attention(w: AscWorld, sub = "u1") {
  const { token, session } = await consoleTestSession(
    w.env,
    w.db,
    { sub, name: sub, email: `${sub}@x.io`, groups: ["platform-admins"] },
    NOW,
  );
  const res = await handleAdmin(
    new Request("https://key.plrs.im/manage/api/attention", {
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
      },
    }),
    w.env,
    w.db,
    "/api/attention",
    { now: NOW },
  );
  const json = (await res.json()) as { items: any[] };
  return json.items.filter((i) => i.kind === "channel.identity_mismatch");
}

/** The store-app world: ids the platform pins assign to the product on every store. */
async function assigned(w: AscWorld) {
  await pin(w, "app-store.in-app-purchase-key", "gg.acme.djdl");
  await pin(w, "google-play.service-account", "gg.acme.djdl");
  await pin(w, "microsoft-store.partner-center", "9NBLGGH4NNS1");
  await pin(w, "steam.publisher-key", "480");
}

describe("outletIdentityMismatches", () => {
  it("reports one mismatch per store field, with both values", async () => {
    const w = await ascWorld();
    await assigned(w);
    await addOutlet(w.db, "play", "play", { packageName: "gg.other.play" });
    await addOutlet(w.db, "ms", "ms-store", { productId: "9NOTTHESAME" });
    await addOutlet(w.db, "steam", "steam", { appId: "999" });
    await w.db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ? AND outlet_id = 'app-store'",
      JSON.stringify({ appleId: APPLE_ID, bundleId: "gg.other.app" }),
      SLUG,
    );
    expect(
      (await outletIdentityMismatches(w.db, SLUG)).sort((a, b) =>
        a.kind.localeCompare(b.kind),
      ),
    ).toEqual([
      {
        kind: "app-store",
        outletId: "app-store",
        field: "bundleId",
        declared: "gg.other.app",
        assigned: "gg.acme.djdl",
      },
      {
        kind: "ms-store",
        outletId: "ms",
        field: "productId",
        declared: "9NOTTHESAME",
        assigned: "9NBLGGH4NNS1",
      },
      {
        kind: "play",
        outletId: "play",
        field: "packageName",
        declared: "gg.other.play",
        assigned: "gg.acme.djdl",
      },
      {
        kind: "steam",
        outletId: "steam",
        field: "appId",
        declared: "999",
        assigned: "480",
      },
    ]);
  });

  it("reports the appleId too, and nothing when the values are equal, a side is empty or the outlet is removed", async () => {
    const w = await ascWorld(); // own key pinned to APPLE_ID, outlets name APPLE_ID
    await assigned(w);
    await addOutlet(w.db, "play", "play", { packageName: "gg.acme.djdl" });
    await addOutlet(w.db, "ms", "ms-store", { productId: "9NBLGGH4NNS1" });
    await addOutlet(w.db, "steam", "steam", { appId: "480" });
    expect(await outletIdentityMismatches(w.db, SLUG)).toEqual([]);

    // A field the outlet leaves out, or a store with no assignment, is not a mismatch.
    await w.db.run(
      "UPDATE dist_outlets SET identity_json = '{}' WHERE product = ? AND outlet_id = 'steam'",
      SLUG,
    );
    await addOutlet(w.db, "dead", "steam", { appId: "1" });
    await w.db.run(
      "UPDATE dist_outlets SET removed_at = ? WHERE product = ? AND outlet_id = 'dead'",
      NOW,
      SLUG,
    );
    expect(await outletIdentityMismatches(w.db, SLUG)).toEqual([]);

    const bad = await ascWorld({ pin: OTHER_APP });
    expect(await outletIdentityMismatches(bad.db, SLUG)).toContainEqual({
      kind: "app-store",
      outletId: "app-store",
      field: "appleId",
      declared: APPLE_ID,
      assigned: OTHER_APP,
    });
  });
});

describe("storefront view identifiers", () => {
  it("carry their source: the manifest's value, or the assignment for a field it leaves empty", async () => {
    const w = await ascWorld();
    await w.db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ?",
      JSON.stringify({ appleId: APPLE_ID }),
      SLUG,
    );
    await pin(w, "app-store.in-app-purchase-key", "gg.acme.djdl");
    const res = await admin(w, "GET", "/distribution/storefronts");
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      stores: { id: string; identifiers: Record<string, unknown> }[];
    };
    const apple = view.stores.find((s) => s.id === "app-store")!;
    expect(apple.identifiers).toEqual({
      appleId: { value: APPLE_ID, source: "manifest" },
      bundleId: { value: "gg.acme.djdl", source: "assigned" },
    });
  });
});

describe("connectors are unchanged (CM-20 D15)", () => {
  it("the inert pin_mismatch still refuses while the check reports the same difference", async () => {
    const w = await ascWorld({ pin: OTHER_APP });
    const { inert, setup } = await resolveAscSetup(w.env, w.db, SLUG);
    expect(setup).toBeNull();
    expect(inert?.reason).toBe("pin_mismatch");
    expect((await outletIdentityMismatches(w.db, SLUG)).length).toBeGreaterThan(
      0,
    );
    for (const control of Object.keys(ASC_CONTROLS)) {
      const res = await admin(
        w,
        "POST",
        `/distribution/connectors/asc/${control}`,
        { releaseId: "v1.1.0", betaGroupId: "bg-1", enabled: true },
      );
      expect(res.status, control).toBe(409);
      expect(((await res.json()) as { reason: string }).reason).toBe(
        "credential_pin_mismatch",
      );
    }
    expect(w.fake.requests).toEqual([]);
  });
});

describe("channel.identity_mismatch attention", () => {
  it("is area ship, seen by a ship member, hidden from a commerce-only member, and gone when fixed", async () => {
    const w = await ascWorld({ pin: OTHER_APP });
    const items = await attention(w);
    expect(items.map((i) => i.id)).toEqual([
      `${SLUG}:channel.identity_mismatch:app-store:appleId`,
    ]);
    expect(items[0]).toMatchObject({
      tone: "warning",
      area: "ship",
      service: "distribution",
      action: { page: "outlets", query: { outlet: "app-store" } },
    });
    expect(items[0].lines[0]).toContain(
      "The `app-store` channel declares Apple ID",
    );
    expect(items[0].lines[0]).not.toContain("appleId");
    expect(items[0].lines[0]).toContain(APPLE_ID);
    expect(items[0].lines[0]).toContain(OTHER_APP);
    expect(await attention(w, "m-ship")).toHaveLength(1);
    expect(await attention(w, "m-commerce")).toEqual([]);

    await w.db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ?",
      JSON.stringify({ appleId: OTHER_APP }),
      SLUG,
    );
    expect(await attention(w)).toEqual([]);
  });

  it("is absent while Distribution is off", async () => {
    const w = await ascWorld({ pin: OTHER_APP });
    const row = await w.db.first<{ services_json: string | null }>(
      "SELECT services_json FROM products WHERE slug = ?",
      SLUG,
    );
    const base = parseServices(row?.services_json ?? null).services;
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: { ...base, distribution: { enabled: false } },
      }),
      "admin",
      NOW,
    );
    expect(await attention(w)).toEqual([]);
  });
});
