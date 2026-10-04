/// <reference types="@cloudflare/workers-types" />
// commerce-claim: the commerce bridge's device surface (P6-01, PARITY §5.7 `commerce.receipt`) —
// the purchase binding, a Steam DLC claim that grants the mapped licence flag, and a claim Steam
// does not vouch for.
//
// Steam is the store recorded here because its verification is two plain Web API reads the
// recording can fake at the global `fetch` (`test/commerceFake.ts`'s SteamFake), with no signed
// store artefact to regenerate: the App Store and Play paths are the same two routes with other
// payloads, and the Worker suites (`test/commerce.test.ts`) cover their verification. The
// publisher key is a placeholder sealed like an operator's; the settings and the product map are
// written as the admin API writes them.

import { expect, vi } from "vitest";
import { TranscriptRecorder } from "../recorder.js";
import type { JsonValue } from "../format.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  activated,
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  servicesOn,
  type Scenario,
} from "../world.js";
import { putOutletCredential } from "../../../src/core/outletCredentials.js";
import { writeCommerceSettings } from "../../../src/services/distribution/commerce/settings.js";
import { upsertStoreProduct } from "../../../src/services/distribution/commerce/state.js";
import {
  SteamFake,
  STEAM_APP,
  STEAM_DLC,
  STEAM_KEY,
} from "../../commerceFake.js";

const FLAG = "extras.diceSkins";
const OWNER = "76561198000000001";
const STRANGER = "76561198000000002";
const TICKET_OWNER = "14000000ab".repeat(8);
const TICKET_STRANGER = "15000000cd".repeat(8);

export const commerceClaim: Scenario = {
  id: "commerce-claim",
  record: () =>
    pinned("commerce-claim", async (pin) => {
      const world = await productWorld(
        servicesOn("license", "config", "release", "distribution"),
      );
      const { key } = await seedLicense(world);
      const token = await activated(world, key);
      const cred = await putOutletCredential(world.env, world.db, {
        product: PRODUCT,
        credentialId: "steam",
        kind: "steam-publisher-key",
        outletId: null,
        value: { key: STEAM_KEY },
        pin: STEAM_APP,
        expiresAt: null,
        actor: "admin-1",
        now: T0,
      });
      if (!cred.ok) throw new Error(cred.message);
      await writeCommerceSettings(
        world.db,
        PRODUCT,
        { appStore: null, play: null, steam: { appId: STEAM_APP } },
        "admin-1",
        T0,
      );
      await upsertStoreProduct(world.db, {
        product: PRODUCT,
        store: "steam",
        store_product_id: STEAM_DLC,
        deliverable_id: "app",
        flag: FLAG,
        modified_at: T0,
        modified_by: "admin-1",
      });

      const steam = new SteamFake();
      vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        return Promise.resolve(
          steam.handle({ method: "GET", url, authorization: null }),
        );
      });
      try {
        const r = new TranscriptRecorder({
          id: "commerce-claim",
          description:
            "The commerce bridge (P6-01). commerceBinding fetches the licence's opaque purchase binding and the store products the operator mapped; the host hands the binding to its store before buying (here as the identity of a Steam web-API ticket). commerceClaim forwards what the store handed the device: the Worker authenticates the ticket for that binding, checks DLC ownership with Steam, and grants the mapped licence flag (the next licence document carries it). A ticket from an account that does not own the DLC is refused 403 forbidden, reason not_owned, and the SDK reports the refusal's own code and reason.",
          features: ["commerce.receipt"],
          requires: [],
          product: PRODUCT,
          now: T0,
          world,
          pinned: pin,
          initial: {
            deviceId: DEVICE,
            version: VERSION,
            token,
            services: ["license", "config", "release", "distribution"],
          },
        });

        let binding = "";
        const products = [
          {
            store: "steam",
            productId: STEAM_DLC,
            flag: FLAG,
            deliverable: "app",
          },
        ];
        // The binding is the Worker's UUID (seeded per scenario, so stable across recordings); the
        // expectation is completed once the step has seen it.
        const bindingExpect: Record<string, JsonValue> = {
          result: "ok",
          products,
        };
        await r.step(
          { action: "commerceBinding" },
          async (s) => {
            const res = await s.send({
              method: "GET",
              path: `/${PRODUCT}/distribution/commerce/binding`,
              bearer: "token",
            });
            expect(res.status).toBe(200);
            const body = (await res.json()) as {
              bindingId: string;
              products: unknown;
            };
            expect(body.products).toEqual(products);
            binding = body.bindingId;
            bindingExpect.bindingId = binding;
          },
          bindingExpect,
        );

        steam.tickets.set(TICKET_OWNER, { steamid: OWNER, identity: binding });
        steam.tickets.set(TICKET_STRANGER, {
          steamid: STRANGER,
          identity: binding,
        });
        steam.owns.set(`${OWNER}:${STEAM_DLC}`, {
          ownsapp: true,
          ownersteamid: OWNER,
        });

        const claimStep = async (ticket: string) =>
          r.step(
            {
              action: "commerceClaim",
              args: {
                store: "steam",
                payload: { ticket, dlcAppId: STEAM_DLC },
              },
            },
            async (s) => {
              await s.send({
                method: "POST",
                path: `/${PRODUCT}/distribution/commerce/claim`,
                bearer: "token",
                body: { store: "steam", ticket, dlcAppId: STEAM_DLC },
                expectBody: {
                  json: { store: "steam", ticket, dlcAppId: STEAM_DLC },
                  match: "exact",
                },
              });
            },
            ticket === TICKET_OWNER
              ? {
                  result: "ok",
                  flag: FLAG,
                  state: "active",
                  granted: true,
                }
              : { result: "forbidden", reason: "not_owned" },
          );
        await claimStep(TICKET_OWNER);
        await claimStep(TICKET_STRANGER);

        const granted = await world.db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM license_store_grants WHERE product = ? AND state = 'active'",
          PRODUCT,
        );
        expect(granted!.n).toBe(1);
        return r.transcript();
      } finally {
        vi.unstubAllGlobals();
      }
    }),
};
