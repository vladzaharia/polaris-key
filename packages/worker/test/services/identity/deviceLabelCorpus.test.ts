// @pkey-feature identity.devicelabel
// The Worker's run of `conformance/corpus/v2/device-label.json` (WIRE-CONTRACT-V5 §12.7.1,
// plans/PX-W13.md §4, DEVICE-LABEL-STRIP): every row goes through `/device/start` as `deviceName`, and the echo is
// the row's `expect`, so the Worker normalises exactly as every SDK does. `helloCases` (§15.6) is
// the peer protocol's, which the Worker does not speak, so it is not run here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEVICE_LABEL_SPACE,
  DEVICE_LABEL_STRIP,
} from "@polaris-key/protocol/identity";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, seedProduct } from "../../seed.js";
import { loadProduct } from "../../../src/core/products.js";
import { handleAuthDeviceStart } from "../../../src/services/identity/oidc.js";
import { TEST_ROOT as HERE } from "../../paths.js";

interface Row {
  id: string;
  raw: string;
  expect: string | null;
}

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
) as {
  deviceLabelVersion: number;
  ranges: { space: [number, number][]; strip: [number, number][] };
  cases: Row[];
};

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

  it("is version 2", () => expect(corpus.deviceLabelVersion).toBe(2));

  it("normalises with the tables of ranges", () => {
    expect(DEVICE_LABEL_SPACE).toEqual(corpus.ranges.space);
    expect(DEVICE_LABEL_STRIP).toEqual(corpus.ranges.strip);
  });

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
