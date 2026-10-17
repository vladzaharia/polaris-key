// verifyLicenseDocument, moved from @polaris-key/node/server (SDK parity pass SP-N16).
import { describe, expect, it } from "vitest";
import { verifyLicenseDocument } from "../src/index.js";
import { createTestKit } from "../src/testing.js";

describe("verifyLicenseDocument", () => {
  it("verifies a presented license: binding, audience, gate, with no device state", async () => {
    const kit = await createTestKit({ product: "acme" });
    const at = kit.clock.now();
    const jws = await kit.sign({ entitlements: { pro: true, seats: 4 } });
    const base = {
      trust: kit.pinnedKeys,
      product: "acme",
      deviceId: kit.deviceId,
    };
    const ok = await verifyLicenseDocument(jws, { ...base, now: at + 10 });
    expect(ok.ok && ok.state.status).toBe("ok");
    expect(ok.ok && ok.isEntitled("pro")).toBe(true);
    expect(ok.ok && ok.entitlementValue("seats")).toBe(4);
    expect(ok.ok && ok.isEntitled("constructor")).toBe(false);
    const grace = await verifyLicenseDocument(jws, { ...base, now: at + 7200 });
    expect(grace.ok && grace.state.status).toBe("grace");
    const expired = await verifyLicenseDocument(jws, {
      ...base,
      now: at + 40 * 86400,
    });
    expect(expired.ok && expired.state.status).toBe("expired");
    expect(expired.ok && expired.isEntitled("pro")).toBe(false);
    for (const bad of [
      { deviceId: "other" },
      { product: "other" },
      { trust: {} },
    ])
      expect(
        (await verifyLicenseDocument(jws, { ...base, ...bad, now: at })).ok,
      ).toBe(false);
  });
});
