/// <reference types="@cloudflare/workers-types" />
// edge-mint: minting a third-party token through an approved recipe (Config, P0-12) as a client
// drives it — a success, the same recipe again inside its lifetime (served from the client's
// in-memory cache, so no request), an unknown recipe, the per-device budget, and a device the
// owner has deauthorized.
//
// The recipe signs EdDSA with a fixed key, so the minted token is byte-stable between two
// recordings (an ES256 or RS256 recipe would not be: ECDSA signatures are randomized).

import { expect } from "vitest";
import { TranscriptRecorder, type World } from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  activated,
  LICENSED,
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  setup,
  type Scenario,
} from "../world.js";
import { approveEdgeMintRecipe, seedProductSecret } from "../../seed.js";
import { ed25519Pem } from "../idp.js";
import { retireDeviceBinding } from "../../../src/core/devices.js";
import { hashKey } from "../../../src/crypto.js";

const RECIPE = "transcript-token";
const TTL = 600;

/** One approved EdDSA recipe whose key is an operator-marked `edge-mint` secret (P0-12). */
async function seedRecipe(w: World): Promise<void> {
  await seedProductSecret(
    w.db,
    PRODUCT,
    "transcript_mint_key",
    ed25519Pem("pkey-transcripts:edge-mint"),
    "edge-mint",
  );
  await w.db.run(
    "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
    PRODUCT,
    RECIPE,
    "EdDSA",
    "transcript_mint_key",
    "transcript-mint",
    JSON.stringify({ iss: "transcript-team" }),
    TTL,
    "https://api.example",
    null,
  );
  await approveEdgeMintRecipe(w.db, PRODUCT, RECIPE);
}

const mintPath = (recipe: string) => `/${PRODUCT}/config/mint/${recipe}/token`;

export const edgeMint: Scenario = {
  id: "edge-mint",
  record: () =>
    pinned("edge-mint", async (pin) => {
      const world = await productWorld(LICENSED);
      const { key } = await seedLicense(world);
      const token = await activated(world, key);
      await seedRecipe(world);
      const r = new TranscriptRecorder({
        id: "edge-mint",
        description:
          "Edge-mint (Config). mintToken() GETs the recipe's token route with the device bearer and returns { token, expiresAt }. A second call for the same recipe inside its lifetime makes no request: minted tokens are cached in memory until expiresAt minus 30 seconds (never on disk). An unknown recipe is 404 not_found. Past the cache window, a device that has spent its per-device budget (30 a minute) gets 429 rate_limited. After the owner deauthorizes the device, the mint 401s; the client makes its one re-acquire (POST /license/token), which also 401s, and reports unauthorized.",
        features: ["config.mint"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, token, version: VERSION },
      });

      let minted = "";
      const first: Record<string, string | number> = {};
      await r.step(
        { action: "mintToken", args: { recipeId: RECIPE } },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: mintPath(RECIPE),
            bearer: "token",
          });
          expect(res.status).toBe(200);
          expect(res.headers.get("cache-control")).toBe("no-store");
          const body = (await res.json()) as {
            token: string;
            expiresAt: number;
          };
          expect(body.expiresAt).toBe(T0 + TTL);
          minted = body.token;
          Object.assign(first, {
            result: "ok",
            token: body.token,
            expiresAt: body.expiresAt,
          });
        },
        first,
      );
      await r.step(
        {
          action: "mintToken",
          args: { recipeId: RECIPE },
          now: T0 + 60,
          note: "Inside the lifetime: served from memory, no request.",
        },
        async () => {},
        { result: "ok", token: minted, expiresAt: T0 + TTL },
      );
      await r.step(
        {
          action: "mintToken",
          args: { recipeId: "no-such-recipe" },
          now: T0 + 60,
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: mintPath("no-such-recipe"),
            bearer: "token",
          });
          expect(res.status).toBe(404);
        },
        { result: "not_found" },
      );

      // The device spends its per-device budget (P0-12: 30 a minute) outside the recording.
      const later = T0 + TTL;
      for (let i = 0; i < 30; i += 1) {
        const res = await setup(
          world,
          "GET",
          mintPath(RECIPE),
          {
            authorization: `Bearer ${token}`,
          },
          later,
        );
        expect(res.status).toBe(200);
      }
      await r.step(
        {
          action: "mintToken",
          args: { recipeId: RECIPE },
          now: later,
          note: "Past expiresAt - 30, so the cache no longer answers; the budget is spent.",
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: mintPath(RECIPE),
            bearer: "token",
          });
          expect(res.status).toBe(429);
        },
        { result: "rate_limited" },
      );

      await retireDeviceBinding(
        world.env,
        world.db,
        PRODUCT,
        DEVICE,
        await hashKey(token, world.env.KEY_HASH_PEPPER),
      );
      await r.step(
        {
          action: "mintToken",
          args: { recipeId: RECIPE },
          now: later + 120,
          note: "Deauthorized: the mint 401s, the one re-acquire 401s, and the call fails.",
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: mintPath(RECIPE),
            bearer: "token",
          });
          expect(res.status).toBe(401);
          const re = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/token`,
            bearer: "token",
          });
          expect(re.status).toBe(401);
        },
        { result: "unauthorized", tokenHeld: true },
      );
      return r.transcript();
    }),
};
