// @pkey-feature core.sync license.entitlements
// LX-17 (S-19 §7.5, §10.1 risk 1, decision 10): does this SDK tolerate a `licenseId` that
// changes on a PLAIN REFRESH — no activation call, same device token — the way
// `licensing.reanchor: onRefresh` would deliver it?
//
// "Tolerate" is pinned on the three surfaces the audit names:
//   cache       the new document is applied, the accessors read it, and it is what a fresh
//               client restores from the same store while offline;
//   telemetry   the `/devices/report` after the refresh carries the NEW license's grants, and
//               the current device reports the new `licenseId`;
//   activation  the device stays activated on the SAME token: no re-activation, no wipe, and
//               the gate stays usable.
//
// Audit result for Node / client-core: PASS (the verifier only checks `licenseId` is a
// non-empty string, `client-core/src/verify.ts`; nothing caches or keys on it).

import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { LicenseState } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";
const PRODUCT = "djdl";
const TOKEN = "pkeyt_lx17";

const base = {
  productSlug: PRODUCT,
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
  license: { fingerprint: false },
  devices: { fingerprint: false },
  expectedServices: ["license" as const],
  trustRefresh: false,
};

function licenseDoc(
  deviceId: string,
  issuedAt: number,
  licenseId: string,
  tier: string,
): LicenseDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId,
    issuedAt,
    expiresAt: issuedAt + 3600,
    graceUntil: issuedAt + 30 * 86400,
    licenseId,
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: issuedAt,
    },
    entitlements: {
      "license.tier": { state: "enforced", value: tier, updatedAt: issuedAt },
      ...(tier === "pro"
        ? { pro: { state: "enforced", value: true, updatedAt: issuedAt } }
        : {}),
    },
  };
}

describe("LX-17: a licenseId change on a plain refresh", () => {
  it("is applied, reported and persisted, and keeps the device activated on the same token", async () => {
    const store = new InMemoryStore(PRODUCT);
    const deviceId = await store.getDeviceId();
    let licenseId = "lic_trial";
    let tier = "free";
    let etag = '"lic-1"';
    let issuedAt = Math.floor(Date.now() / 1000);
    const paths: string[] = [];
    const reports: Array<Record<string, unknown>> = [];
    const bearers = new Set<string>();

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const p = new URL(String(input)).pathname;
      paths.push(p);
      const headers = new Headers(init?.headers);
      if (p.endsWith("/license/activate"))
        return Response.json({ token: TOKEN, schemaVersion: 1 });
      if (p.endsWith("/devices/report")) {
        reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({});
      }
      if (p.endsWith("/license/document")) {
        bearers.add(headers.get("authorization") ?? "");
        if (headers.get("if-none-match") === etag)
          return new Response(null, { status: 304, headers: { etag } });
        const jws = await signJws(
          licenseDoc(deviceId, issuedAt, licenseId, tier),
          TEST_PEM,
          TEST_KID,
          "pkey-license+jws",
        );
        return new Response(jws, {
          status: 200,
          headers: { "content-type": "application/jwt", etag },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const changes: LicenseState[] = [];
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl,
      onChange: (s) => changes.push(s),
    });
    await client.license.activateWithKey("pkey_djdl_test");
    expect(client.license.getLicenseId()).toBe("lic_trial");
    expect(client.license.isEntitled("pro")).toBe(false);

    // The server re-anchors this device on another license. Nothing on the client asks for it:
    // the next plain sync just receives a document with a different licenseId.
    licenseId = "lic_pro";
    tier = "pro";
    etag = '"lic-2"';
    issuedAt += 60;
    changes.length = 0;
    paths.length = 0;
    reports.length = 0;

    const r = await client.sync();

    // cache
    expect(r.documents.license?.kind).toBe("applied");
    expect(client.license.getLicenseId()).toBe("lic_pro");
    expect(client.license.isEntitled("pro")).toBe(true);
    expect(client.license.getEntitlements()["license.tier"]).toBe("pro");
    expect(changes).toHaveLength(1);
    // activation state
    expect(paths.some((p) => p.endsWith("/license/activate"))).toBe(false);
    expect([...bearers]).toEqual([`Bearer ${TOKEN}`]);
    expect(client.license.activation()).toBe("token");
    expect(client.license.status().status).toBe("ok");
    expect(client.isLicensed()).toBe(true);
    // telemetry
    expect(reports).toHaveLength(1);
    expect(
      (reports[0]?.entitlements as Record<string, unknown>)["license.tier"],
    ).toBe("pro");
    expect(client.getCurrentDevice().licenseId).toBe("lic_pro");

    // The following refresh revalidates the new license's document normally.
    const again = await client.sync();
    expect(again.documents.license?.kind).toBe("unchanged");
    expect(client.license.getLicenseId()).toBe("lic_pro");
    client.close();

    // A fresh client on the same store, fully offline, restores the re-anchored document.
    const offline = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(offline.license.getLicenseId()).toBe("lic_pro");
    expect(offline.license.isEntitled("pro")).toBe(true);
    expect(offline.license.status().status).toBe("ok");
    offline.close();
  });
});
