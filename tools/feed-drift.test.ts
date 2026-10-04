/**
 * F-10 automation — the feed drift check (tools/feed-drift.mjs): after a publish, every package of
 * the root `.pkey/release` is at the lockstep version, newest of its kind, on its channel tag.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDrift,
  checkListing,
  comparePep440,
  compareSemver,
  kindOf,
  packageDeliverables,
} from "./feed-drift.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = { version: "0.9.1-main.4", pep440: "0.9.1.dev4", channel: "main" };
const STABLE = { version: "0.9.1", pep440: "0.9.1", channel: "stable" };

describe("version ordering", () => {
  it("SemVer: a prerelease sorts below its release; numeric identifiers numerically", () => {
    expect(compareSemver("0.9.1-main.4", "0.9.1")).toBe(-1);
    expect(compareSemver("0.9.1-main.10", "0.9.1-main.9")).toBe(1);
    expect(compareSemver("0.9.1-main.4", "0.9.0")).toBe(1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-main.3")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("x", "1.0.0")).toBeNull();
  });

  it("PEP 440: dev < a < b < rc < final", () => {
    expect(comparePep440("0.9.1.dev4", "0.9.1")).toBe(-1);
    expect(comparePep440("0.9.1.dev10", "0.9.1.dev9")).toBe(1);
    expect(comparePep440("0.9.1.dev4", "0.9.0")).toBe(1);
    expect(comparePep440("1.0.0a1", "1.0.0.dev99")).toBe(1);
    expect(comparePep440("1.0.0rc1", "1.0.0b2")).toBe(1);
    expect(comparePep440("1.0.0", "1.0.0rc9")).toBe(1);
  });

  it("kinds", () => {
    expect(kindOf("0.9.1-main.4", "npm")).toBe("main");
    expect(kindOf("0.9.1-rc.1", "maven")).toBe("beta");
    expect(kindOf("0.9.1", "oci")).toBe("stable");
    expect(kindOf("0.9.1.dev4", "pypi")).toBe("main");
    expect(kindOf("0.9.1rc1", "pypi")).toBe("beta");
  });
});

describe("checkListing", () => {
  const npm = { id: "npm.node", ecosystem: "npm", name: "@polaris-key/node" };
  const pypi = {
    id: "pypi.polaris-key",
    ecosystem: "pypi",
    name: "polaris-key",
  };
  const oci = { id: "oci.pkey", ecosystem: "oci", name: "pkey" };

  it("passes a main build listed, newest of its kind, under dist-tag main", () => {
    expect(
      checkListing(
        npm,
        {
          versions: ["0.9.0", "0.9.1-main.3", "0.9.1-main.4"],
          tags: { latest: "0.9.0", main: "0.9.1-main.4" },
        },
        MAIN,
      ),
    ).toEqual([]);
  });

  it("fails a missing version, an older newest, and a wrong or missing tag", () => {
    expect(
      checkListing(
        npm,
        { versions: ["0.9.0"], tags: { latest: "0.9.0" } },
        MAIN,
      )[0],
    ).toMatch(/is not listed/);
    expect(
      checkListing(
        npm,
        {
          versions: ["0.9.1-main.4", "0.9.1-main.5"],
          tags: { main: "0.9.1-main.4" },
        },
        MAIN,
      ),
    ).toEqual(["the newest main version is 0.9.1-main.5, not 0.9.1-main.4"]);
    expect(
      checkListing(npm, { versions: ["0.9.1-main.4"], tags: {} }, MAIN),
    ).toContain("dist-tag main is unset, not 0.9.1-main.4");
  });

  it("fails a main build that npm's latest names", () => {
    expect(
      checkListing(
        npm,
        {
          versions: ["0.9.1-main.4"],
          tags: { latest: "0.9.1-main.4", main: "0.9.1-main.4" },
        },
        MAIN,
      ),
    ).toContain("dist-tag latest names the main build 0.9.1-main.4");
  });

  it("a release is judged among releases: a newer main build does not fail it", () => {
    expect(
      checkListing(
        npm,
        {
          versions: ["0.9.1", "0.9.2-main.1"],
          tags: { latest: "0.9.1", main: "0.9.2-main.1" },
        },
        STABLE,
      ),
    ).toEqual([]);
  });

  it("PyPI is checked in its PEP 440 spelling", () => {
    expect(
      checkListing(
        pypi,
        { versions: ["0.9.0", "0.9.1.dev4"], tags: null },
        MAIN,
      ),
    ).toEqual([]);
    expect(
      checkListing(pypi, { versions: ["0.9.1-main.4"], tags: null }, MAIN)[0],
    ).toMatch(/0\.9\.1\.dev4 is not listed/);
  });

  it("OCI needs the channel's tag", () => {
    expect(
      checkListing(
        oci,
        { versions: ["0.9.1"], tags: { latest: true } },
        STABLE,
      ),
    ).toEqual([]);
    expect(
      checkListing(oci, { versions: ["0.9.1-main.4"], tags: {} }, MAIN),
    ).toEqual(["the image has no main tag"]);
  });
});

describe("checkDrift", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("covers every package of the root .pkey/release", () => {
    const ids = packageDeliverables(ROOT).map((d) => d.id);
    expect(ids).toContain("npm.node");
    expect(ids).toContain("swift.polariskey");
    expect(ids).toContain("godot.polaris-key");
    expect(ids.length).toBeGreaterThan(20);
  });

  it("reads each feed's listing at its URL, retries a lagging feed, then reports what is left", async () => {
    const seen: string[] = [];
    let npmCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      const body = (v: unknown) =>
        new Response(typeof v === "string" ? v : JSON.stringify(v), {
          status: 200,
        });
      if (url.includes("/npm/")) {
        npmCalls++;
        // The first read lags (the render queue); the second is in step.
        return body(
          npmCalls === 1
            ? { versions: {}, "dist-tags": {} }
            : {
                versions: { "0.9.1-main.4": {} },
                "dist-tags": { main: "0.9.1-main.4" },
              },
        );
      }
      if (url.includes("/pypi/")) return body({ versions: ["0.9.1.dev4"] });
      if (url.includes("/swift/"))
        return body({ releases: { "0.9.1-main.4": {} } });
      if (url.includes("/maven/"))
        return body(
          "<metadata><versioning><versions><version>0.9.1-main.4</version></versions></versioning></metadata>",
        );
      if (url.includes("/godot/")) return body([{ version: "0.9.1-main.4" }]);
      if (url.includes("/v2/")) return body({ tags: ["0.9.1-main.3", "main"] });
      return new Response("", { status: 404 });
    });
    const problems = await checkDrift({
      origin: "https://pkg.example.test",
      owner: "polaris-key",
      root: ROOT,
      expected: MAIN,
      timeoutSec: 1,
      only: ["npm", "pypi", "swift", "godot", "oci"],
      sleep: async () => undefined,
    });
    expect([...problems.keys()]).toEqual(["oci.pkey"]);
    expect(seen).toContain(
      "https://pkg.example.test/npm/polaris-key/@polaris-key%2fnode",
    );
    expect(seen).toContain(
      "https://pkg.example.test/pypi/polaris-key/simple/polaris-key/",
    );
    expect(seen).toContain(
      "https://pkg.example.test/swift/polaris-key/polaris-key/PolarisKey",
    );
    expect(seen).toContain(
      "https://pkg.example.test/godot/polaris-key/store/api/v1/releases/polaris-key/polaris_key/",
    );
    expect(seen).toContain(
      "https://pkg.example.test/v2/polaris-key/pkey/tags/list?n=10000",
    );
  });
});
