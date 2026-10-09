// @pkey-feature commerce.receipt
// SDK parity pass §3.9: the commerce client's refusal kinds and the helpers' sync.

import { describe, expect, it } from "vitest";
import { json, nowSec, seededClient, signedLicense } from "./parityFixtures.js";

const services = { expectedServices: ["license", "distribution"] as never };

describe("commerce", () => {
  it("refuses without a token, naming no_license, and sends nothing", async () => {
    const { client, seen } = await seededClient({
      token: null,
      extra: services,
    });
    const r = await client.commerce.binding();
    expect(r).toMatchObject({
      kind: "refused",
      code: "not_entitled",
      reason: "no_license",
    });
    expect(seen).toEqual([]);
  });

  it("maps not_owned, attestation_required and other codes", async () => {
    const answers = [
      json({ error: { code: "forbidden" }, reason: "not_owned" }, 403),
      json({ error: { code: "attestation_required" } }, 403),
      json({ error: { code: "not_found" }, reason: "unmapped_product" }, 404),
      json(
        { error: { code: "unavailable" }, reason: "store_unavailable" },
        503,
      ),
    ];
    const { client } = await seededClient({
      extra: services,
      routes: {
        "POST /djdl/distribution/commerce/claim": () => answers.shift()!,
      },
    });
    const kinds = [];
    for (let i = 0; i < 4; i += 1)
      kinds.push(
        await client.commerce.claim("play", {
          productId: "p",
          purchaseToken: "t",
        }),
      );
    expect(kinds.map((k) => [k.kind, k.kind === "ok" ? "" : k.code])).toEqual([
      ["not-owned", "forbidden"],
      ["attestation-required", "attestation_required"],
      ["refused", "not_found"],
      // A 5xx is the one taxonomy's server-error (SP-46); the store's own code is kept.
      ["error", "server-error"],
    ]);
    expect(kinds[3]).toMatchObject({
      status: 503,
      wireCode: "unavailable",
      reason: "store_unavailable",
    });
  });

  it("claimSteam posts the ticket and syncs so the flag is readable", async () => {
    let bodies: unknown[] = [];
    let license = await signedLicense({});
    const { client, seen } = await seededClient({
      license: license,
      extra: services,
      routes: {
        "POST /djdl/distribution/commerce/claim": async (req) => {
          bodies.push(JSON.parse(req.body!));
          license = await signedLicense({ "extras.skins": true }, nowSec() + 1);
          return json({
            ok: true,
            store: "steam",
            productId: "1",
            flag: "extras.skins",
            state: "active",
            granted: true,
            changed: true,
          });
        },
        "GET /djdl/license/document": () =>
          new Response(license, { status: 200 }),
        "GET /djdl/config/document": () => new Response("", { status: 404 }),
        "POST /djdl/devices/report": () => json({}),
      },
    });
    expect(client.license.isEntitled("extras.skins")).toBe(false);
    const r = await client.commerce.claimSteam("abcd", "1");
    expect(r).toMatchObject({
      kind: "ok",
      flag: "extras.skins",
      granted: true,
    });
    expect(bodies).toEqual([{ store: "steam", ticket: "abcd", dlcAppId: "1" }]);
    expect(seen.map((s) => s.path)).toContain("/djdl/license/document");
    expect(client.license.isEntitled("extras.skins")).toBe(true);
  });
});
