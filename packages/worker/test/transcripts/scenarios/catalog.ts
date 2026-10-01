/// <reference types="@cloudflare/workers-types" />
// config-schema-fetch: `GET /<p>/config/schema`, the product's active config catalog (P1b-07,
// PARITY §5.3 `config.schema`).
//
// The catalog is unsigned and unauthenticated, so every SDK treats it as DIAGNOSTIC: it hands
// back the parsed catalog, or null when the fetch failed, and never throws for a refusal or a
// network error. Nothing security-relevant is ever read from it — the config VALUES a client
// acts on arrive in the signed config document.

import { expect } from "vitest";
import { TranscriptRecorder, type StepRecorder } from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  CONFIG_ONLY,
  pinned,
  PRODUCT,
  productWorld,
  TRANSCRIPT_CATALOG,
  type Scenario,
} from "../world.js";

/** `GET /<p>/config/schema`. Public: no bearer, and the metadata headers are not required. */
function schema(s: StepRecorder): Promise<Response> {
  return s.send({
    method: "GET",
    path: `/${PRODUCT}/config/schema`,
    metadata: false,
  });
}

export const configSchemaFetch: Scenario = {
  id: "config-schema-fetch",
  record: () =>
    pinned("config-schema-fetch", async (pin) => {
      const world = await productWorld(CONFIG_ONLY);
      const r = new TranscriptRecorder({
        id: "config-schema-fetch",
        description:
          "The catalog fetch (GET /<p>/config/schema): unsigned, unauthenticated and diagnostic. fetchSchema() sends no credential and returns the product's active catalog parsed; when the fetch fails — here the operator has retired the active catalog, so the Worker answers 404 — it returns null and does not throw.",
        features: ["config.schema"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION, services: ["config"] },
      });
      await r.step(
        { action: "fetchSchema" },
        async (s) => {
          const res = await schema(s);
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({
            schemaVersion: TRANSCRIPT_CATALOG.schemaVersion,
          });
        },
        { catalog: TRANSCRIPT_CATALOG as never },
      );

      // The operator retires the active catalog: the Worker now has none to serve.
      await world.db.run(
        "UPDATE product_schema SET active = 0 WHERE product = ?",
        PRODUCT,
      );
      await r.step(
        {
          action: "fetchSchema",
          now: T0 + 60,
          note: "No active catalog: a 404, which the SDK reports as null rather than throwing.",
        },
        async (s) => {
          expect((await schema(s)).status).toBe(404);
        },
        { catalog: null },
      );
      return r.transcript();
    }),
};
