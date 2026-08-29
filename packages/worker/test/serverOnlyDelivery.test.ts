// `delivery: "serverOnly"` enforcement (the audit's B3).
//
// The catalog validates the field at ingest and stores it in `product_schema.catalog_json`,
// and until this suite nothing READ it at document build — a "server-only" secret was
// delivered to every device like any other. The prune in `validatePayload` is the last gate
// before signing on every document path (config document AND bundles, which reuse
// `buildConfigDoc`), so the rule lands there: a serverOnly secret never comes out of the
// device-facing prune. `clientScoped` (the default when the field is absent) and `edgeMint`
// are delivered unchanged — edgeMint's VALUE may still be needed by the mint recipe, but the
// managed payload entry rides to the client exactly as before.

import { describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleConfigDocument } from "../src/services/config/document.js";

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "srv.key",
      kind: "secret",
      secret: true,
      category: "Secrets",
      label: "Server-side key",
      description: "Consumed only by the worker; never leaves it.",
      schema: { type: "string" },
      delivery: "serverOnly",
    },
    {
      key: "cli.key",
      kind: "secret",
      secret: true,
      category: "Secrets",
      label: "Client key",
      description: "Delivered to the OS keyring.",
      schema: { type: "string" },
      delivery: "clientScoped",
    },
    {
      key: "def.key",
      kind: "secret",
      secret: true,
      category: "Secrets",
      label: "Default-delivery key",
      description: "No delivery declared — clientScoped by default.",
      schema: { type: "string" },
    },
  ],
};

describe("delivery: serverOnly", () => {
  it("a serverOnly secret never appears in the signed config document", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl", { catalog: CATALOG });
    const { key } = await seedLicenseWithKey(db, "djdl", {
      secrets: {
        "srv.key": { state: "hidden", value: "server-secret", updatedAt: NOW },
        "cli.key": { state: "hidden", value: "client-secret", updatedAt: NOW },
        "def.key": { state: "hidden", value: "default-secret", updatedAt: NOW },
      },
    });
    const product = (await loadProduct(env, db, "djdl"))!;

    const activated = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-b3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(activated.status).toBe(200);
    const { token } = (await activated.json()) as { token: string };

    const res = await handleConfigDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    const doc = await verifyJws<ConfigDoc>(await res.text(), {
      [TEST_KID]: TEST_PUB,
    });
    const secrets = doc!.payload.secrets;

    expect(secrets["cli.key"]?.value).toBe("client-secret");
    expect(secrets["def.key"]?.value).toBe("default-secret");
    expect(
      secrets["srv.key"],
      "a serverOnly secret must never be signed into a device document",
    ).toBeUndefined();
  });
});
