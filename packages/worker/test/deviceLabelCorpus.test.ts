// @pkey-feature identity.devicelabel
// The Worker's run of `conformance/corpus/v2/device-label.json` (WIRE-CONTRACT-V4 §12.7.1,
// plans/PX-W13.md §4): every row goes through `/device/start` as `deviceName`, and the echo is
// the row's `expect`, so the Worker normalises exactly as every SDK does.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, seedProduct } from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { handleAuthDeviceStart } from "../src/services/identity/oidc.js";

interface Row {
  id: string;
  raw: string;
  expect: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(
      HERE,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "device-label.json",
    ),
    "utf8",
  ),
) as { deviceLabelVersion: number; cases: Row[] };

describe("device-label.json through /device/start", async () => {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "custom",
    "https://id.example",
    "client-djdl",
    null,
    JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
    JSON.stringify({}),
  );
  const product = (await loadProduct(env, db, "djdl"))!;

  it("is version 1", () => expect(corpus.deviceLabelVersion).toBe(1));

  corpus.cases.forEach((row, i) =>
    it(row.id, async () => {
      const res = await handleAuthDeviceStart(
        new Request("https://key.plrs.im/djdl/identity/auth/device/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // One client per row, so the start rate limit never interferes.
            "cf-connecting-ip": `198.51.100.${i + 1}`,
          },
          body: JSON.stringify({ deviceId: `dev-${i}`, deviceName: row.raw }),
        }),
        env,
        db,
        product,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { deviceName: unknown }).deviceName).toBe(
        row.expect,
      );
    }),
  );
});
