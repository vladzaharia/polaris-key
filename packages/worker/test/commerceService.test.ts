/**
 * CM-29 — Commerce is a service (`commerce`, requires License): its routes, the one spelling of
 * the store hooks, and what happens with Distribution or Commerce off.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { matchRoute } from "../src/router.js";
import { storeHookPath } from "../src/core/stores/hooks.js";
import { appStoreNotificationsUrl } from "../src/services/distribution/connectors/asc/provision.js";
import { parseServices, serializeServices } from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import { SLUG } from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";
import { STEAM_DLC } from "./commerceFake.js";
import {
  FLAG,
  bindingOf,
  commerceWorld,
  grants,
  route,
  type CommerceWorld,
} from "./commerceWorld.js";

const here = dirname(fileURLToPath(import.meta.url));

let w: CommerceWorld | null = null;
afterEach(() => {
  w?.close();
  w = null;
});

async function setEnabled(
  cw: CommerceWorld,
  patch: Partial<Record<string, boolean>>,
): Promise<void> {
  const row = await cw.db.first<{ services_json: string | null }>(
    "SELECT services_json FROM products WHERE slug = ?",
    SLUG,
  );
  const services = { ...parseServices(row?.services_json ?? null).services };
  for (const [slug, enabled] of Object.entries(patch))
    (services as Record<string, { enabled: boolean }>)[slug] = {
      enabled: !!enabled,
    };
  await setServices(cw.db, SLUG, serializeServices({ services }), "admin", NOW);
}

const text = async (r: Response) => ({
  status: r.status,
  body: await r.text(),
});

describe("the store hooks have one spelling", () => {
  it("the router, the URL builder and the ASC write gate all read storeHookPath", () => {
    expect(storeHookPath("app-store")).toBe("distribution/hooks/app-store");
    expect(storeHookPath("play")).toBe("distribution/hooks/play-rtdn");
    for (const store of ["app-store", "play"] as const) {
      const r = matchRoute(`/${SLUG}/${storeHookPath(store)}`);
      expect(r).toMatchObject({
        kind: "service",
        slug: "commerce",
        product: SLUG,
        storeHook: true,
      });
      expect((r as { alias?: true }).alias).toBeUndefined();
    }
    expect(appStoreNotificationsUrl("https://key.plrs.im", SLUG)).toBe(
      `https://key.plrs.im/${SLUG}/${storeHookPath("app-store")}`,
    );
    const gate = readFileSync(
      join(here, "..", "src", "core", "storefront", "rules", "appStore.ts"),
      "utf8",
    );
    expect(gate).toContain('storeHookPath("app-store")');
    expect(gate).not.toContain('"distribution/hooks/app-store"');
  });

  it("asc and sentry stay Distribution's; /commerce/hooks/* is not a route of Commerce's", () => {
    for (const hook of ["asc", "sentry"])
      expect(matchRoute(`/${SLUG}/distribution/hooks/${hook}`)).toMatchObject({
        kind: "service",
        slug: "distribution",
      });
    const r = matchRoute(`/${SLUG}/commerce/hooks/app-store`);
    expect(r).toMatchObject({ kind: "service", slug: "commerce" });
    expect((r as { storeHook?: true }).storeHook).toBeUndefined();
  });
});

describe("Commerce off", () => {
  it("answers the byte-identical not-found on both device routes and both hooks", async () => {
    w = await commerceWorld();
    const cw = w;
    await setEnabled(cw, { commerce: false });
    const unknown = await text(
      await route(cw, "GET", "/commerce/nope", { token: cw.tokenA }),
    );
    expect(unknown.status).toBe(404);
    for (const [method, path] of [
      ["GET", "/commerce/binding"],
      ["POST", "/commerce/claim"],
      ["POST", "/distribution/hooks/app-store"],
      ["POST", "/distribution/hooks/play-rtdn"],
    ] as const)
      expect(
        await text(
          await route(cw, method, path, {
            token: cw.tokenA,
            ...(method === "POST" ? { body: {} } : {}),
          }),
        ),
        `${method} ${path}`,
      ).toEqual(unknown);
  });

  it("/commerce/hooks/* and the old /distribution/commerce/* answer not-found even with Commerce on", async () => {
    w = await commerceWorld();
    const cw = w;
    const unknown = await text(
      await route(cw, "GET", "/commerce/nope", { token: cw.tokenA }),
    );
    for (const [method, path] of [
      ["POST", "/commerce/hooks/app-store"],
      ["POST", "/commerce/hooks/play-rtdn"],
      ["GET", "/distribution/commerce/binding"],
      ["POST", "/distribution/commerce/claim"],
    ] as const)
      expect(
        await text(
          await route(cw, method, path, {
            token: cw.tokenA,
            ...(method === "POST" ? { body: {} } : {}),
          }),
        ),
        `${method} ${path}`,
      ).toEqual({ status: 404, body: unknown.body });
  });

  it("discovery names Commerce's endpoints only while it runs", async () => {
    w = await commerceWorld();
    const cw = w;
    const on = (await (
      await route(cw, "GET", "/.well-known/polaris.json")
    ).json()) as { services: Record<string, unknown> };
    expect(on.services.commerce).toEqual({
      enabled: true,
      endpoints: {
        binding: expect.stringMatching(/\/commerce\/binding$/),
        claim: expect.stringMatching(/\/commerce\/claim$/),
      },
    });
    await setEnabled(cw, { commerce: false });
    const off = (await (
      await route(cw, "GET", "/.well-known/polaris.json")
    ).json()) as { services: Record<string, unknown> };
    expect(off.services.commerce).toEqual({ enabled: false });
  });
});

describe("Commerce on, Distribution off", () => {
  it("the hooks answer and a Steam claim verifies under the per-store gate", async () => {
    w = await commerceWorld();
    const cw = w;
    await setEnabled(cw, { update: false, distribution: false });
    // The hook answers (a bare 401 for an unsigned push), not the not-found.
    const hook = await route(cw, "POST", "/distribution/hooks/play-rtdn", {
      body: {},
    });
    expect(hook.status).not.toBe(404);
    const steamid = "76561198000000001";
    const ticket = "14000000ab".repeat(8);
    cw.fakes.steam.tickets.set(ticket, {
      steamid,
      identity: await bindingOf(cw, cw.tokenA),
    });
    cw.fakes.steam.owns.set(`${steamid}:${STEAM_DLC}`, {
      ownsapp: true,
      ownersteamid: steamid,
    });
    const res = await route(cw, "POST", "/commerce/claim", {
      token: cw.tokenA,
      body: { store: "steam", ticket, dlcAppId: STEAM_DLC },
    });
    expect(res.status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([`steam:${FLAG}`]);
  });
});
