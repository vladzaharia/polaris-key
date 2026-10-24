import { describe, expect, it } from "vitest";
import {
  featureNeeds,
  servicesForFeatures,
  toggleFeature,
} from "../src/index.js";

describe("the features' rules", () => {
  it("Commerce needs Licensing; Licensing needs nothing", () => {
    expect(featureNeeds("commerce")).toEqual(["licensing"]);
    expect(featureNeeds("licensing")).toEqual([]);
  });

  it("a locked feature cannot be turned on", () => {
    expect(toggleFeature([], "commerce", true).features).toEqual([]);
    expect(toggleFeature(["licensing"], "commerce", true).features).toEqual([
      "licensing",
      "commerce",
    ]);
  });

  it("clearing Licensing clears Commerce and says so", () => {
    expect(
      toggleFeature(["licensing", "commerce"], "licensing", false),
    ).toEqual({ features: [], cleared: ["commerce"] });
  });

  it("maps features to services in canonical order", () => {
    expect(servicesForFeatures(["ship-builds", "licensing"]).services).toEqual([
      "license",
      "release",
      "distribution",
    ]);
  });
});
