import { describe, expect, it } from "vitest";
import { FEATURES, SERVICE_SLUGS } from "../src/services.generated.js";
import type { ServiceFeatureFacts } from "../src/api.js";
import {
  COMMERCE_OFF_LIMITS,
  factFor,
  storeRefundsAttention,
  type Enabled,
} from "../src/console/sections/core/components/serviceFeatures.js";

const feature = FEATURES.find((f) => f.id === "commerce")!;
const facts = (
  storefronts: number,
  storeGrants: number,
): ServiceFeatureFacts => ({
  licensing: { tiers: 0, licenses: 0 },
  managedConfig: { catalogVersion: null },
  shipBuilds: { latest: null },
  commerce: { storefronts, storeGrants },
});
const enabled = (on: string[]): Enabled =>
  Object.fromEntries(SERVICE_SLUGS.map((s) => [s, on.includes(s)])) as Enabled;

describe("the Commerce feature row", () => {
  it("says how many storefronts are ready", () => {
    expect(factFor(feature, facts(0, 0))).toBe("Set up a storefront");
    expect(factFor(feature, facts(1, 0))).toBe("1 storefront ready");
    expect(factFor(feature, facts(2, 0))).toBe("2 storefronts ready");
  });

  it("needs Attention only with License on, Commerce off and a live store purchase", () => {
    const msg = "Store refunds are not landing while Commerce is off";
    expect(
      storeRefundsAttention(feature, enabled(["license"]), facts(1, 3)),
    ).toBe(msg);
    expect(
      storeRefundsAttention(feature, enabled(["license"]), facts(1, 0)),
    ).toBeNull();
    expect(
      storeRefundsAttention(
        feature,
        enabled(["license", "commerce"]),
        facts(1, 3),
      ),
    ).toBeNull();
    expect(storeRefundsAttention(feature, enabled([]), facts(1, 3))).toBeNull();
  });

  it("warns about Play's 7-day and 31-day limits on the way off", () => {
    expect(COMMERCE_OFF_LIMITS).toMatch(/7 days/);
    expect(COMMERCE_OFF_LIMITS).toMatch(/31/);
  });
});
