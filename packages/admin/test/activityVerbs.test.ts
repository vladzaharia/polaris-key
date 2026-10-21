import { describe, expect, it } from "vitest";
import {
  ACTION_GROUPS,
  verbFor,
} from "../src/console/sections/core/model/activityVerbs.js";

/** B-214: the Polaris Locker listing's writes and the legacy Commerce rows read as phrases. */
describe("activity verbs for store writes", () => {
  it("words a Polaris Locker listing write, not 'distribution polaris-key …'", () => {
    expect(verbFor("distribution.polaris-key.writeListingText")).toBe(
      "changed the Polaris Locker listing text of",
    );
    expect(verbFor("distribution.polaris-key.writeListingAssets")).toBe(
      "changed the Polaris Locker listing images of",
    );
    expect(verbFor("distribution.polaris-key.somethingNew")).toBe(
      "changed the Polaris Locker listing of",
    );
  });

  it("keeps the legacy distribution.commerce.* rows worded as Commerce", () => {
    expect(verbFor("distribution.commerce.settings")).toBe(
      "changed store settings",
    );
  });

  it("offers a filter for each prefix those rows were written under", () => {
    const values = ACTION_GROUPS.map((g) => g.value);
    expect(values).toContain("distribution.polaris-key.");
    expect(values).toContain("distribution.commerce.");
  });
});
