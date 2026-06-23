import { describe, expect, it } from "vitest";
import { channelForVersion, compareSemver, isDevBuild, parseSemver } from "../src/semver.js";

describe("parseSemver", () => {
  it("parses a plain version into its numeric parts", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });
  it("splits a dotted prerelease tag", () => {
    expect(parseSemver("1.0.0-beta.2")).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ["beta", "2"] });
  });
  it("ignores build metadata (after +)", () => {
    expect(parseSemver("1.2.3+build.99")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    // A prerelease AND build metadata together: the build part is still dropped.
    expect(parseSemver("1.0.0-rc.1+sha")).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ["rc", "1"] });
  });
  it("returns null for an unparseable version", () => {
    expect(parseSemver("weird")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("v1.2.3")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders by major/minor/patch", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("orders a prerelease below its release (SemVer rule 11)", () => {
    expect(compareSemver("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
  });

  it("orders prerelease identifiers numerically then lexically", () => {
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1); // numeric, not string
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1); // lexical
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.1")).toBe(0);
  });

  it("treats a shorter prerelease set as lower when a longer one is a superset", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
  });

  it("ignores build metadata entirely", () => {
    expect(compareSemver("1.2.3+a", "1.2.3+b")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.3+build")).toBe(0);
  });

  it("returns 0 (equal) when either side is unparseable", () => {
    expect(compareSemver("bogus", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "bogus")).toBe(0);
    expect(compareSemver("bogus", "alsobogus")).toBe(0);
  });
});

describe("channelForVersion", () => {
  it("derives the channel from the version-string encoding", () => {
    expect(channelForVersion("1.2.3")).toBe("stable");
    expect(channelForVersion("0.0.0-dev+abc")).toBe("dev");
    expect(channelForVersion("0.0.0-staging+abc")).toBe("staging");
    expect(channelForVersion("0.0.0-pr42+abc")).toBe("pr");
  });
  it("treats a bare release version as stable", () => {
    expect(channelForVersion("2.0.0")).toBe("stable");
  });
  it("treats unparseable/unknown as stable", () => {
    expect(channelForVersion("weird")).toBe("stable");
    expect(channelForVersion("0.0.0-prabc")).toBe("stable"); // pr without digits → not a pr channel
  });
});

describe("isDevBuild", () => {
  it("matches the dev marker with and without a sha suffix", () => {
    expect(isDevBuild("0.0.0-dev")).toBe(true);
    expect(isDevBuild("0.0.0-dev+abc")).toBe(true);
  });
  it("is false for any non-dev version", () => {
    expect(isDevBuild("1.0.0")).toBe(false);
    expect(isDevBuild("0.0.0-staging+abc")).toBe(false);
    expect(isDevBuild("0.0.0-pr1+abc")).toBe(false);
  });
});
