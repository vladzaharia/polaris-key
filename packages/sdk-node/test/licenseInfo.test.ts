// @pkey-feature license.entitlements
// SDK parity pass §3.3: isEntitled answers false whenever the gate is not usable (S-19 G11), and
// licenseInfo()/entitlementValue() read the enforced entitlement names.

import { describe, expect, it } from "vitest";
import { seededClient, signedLicense } from "./parityFixtures.js";

const GRANTS = {
  pro: true,
  seats: 5,
  "license.tier": "pro",
  "license.tierLabel": "Pro",
  deviceLimit: 3,
  channels: ["stable", "beta"],
};

describe("license conveniences (§3.3)", () => {
  it("a usable license answers its grants", async () => {
    const { client } = await seededClient({
      license: await signedLicense(GRANTS),
    });
    expect(client.status().status).toBe("ok");
    expect(client.entitlements.has("pro")).toBe(true);
    expect(client.entitlements.value("seats")).toBe(5);
    expect(client.entitlements.value("missing")).toBeNull();
    expect(client.license.licenseInfo()).toEqual({
      licenseId: "lic_parity",
      tier: "pro",
      tierLabel: "Pro",
      deviceLimit: 3,
      profile: expect.objectContaining({ name: "Ada Lovelace" }),
      entitledChannels: ["stable", "beta"],
      status: "ok",
    });
  });

  it("G11: a revoked device (hard 401) holds the document but is entitled to nothing", async () => {
    const { client } = await seededClient({
      license: await signedLicense(GRANTS),
      lastSyncUnauthorized: true,
    });
    expect(client.status().status).toBe("revoked");
    expect(client.entitlements.has("pro")).toBe(false);
    expect(client.entitlements.value("seats")).toBeNull();
    expect(client.license.licenseInfo()?.status).toBe("revoked");
  });

  it("G11: no token and no bundle → needs-activation → not entitled", async () => {
    const { client } = await seededClient({
      license: await signedLicense(GRANTS),
      token: null,
    });
    expect(client.entitlements.has("pro")).toBe(false);
  });

  it("licenseInfo is null without a document", async () => {
    const { client } = await seededClient();
    expect(client.license.licenseInfo()).toBeNull();
  });
});
