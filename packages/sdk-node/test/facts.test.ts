// @pkey-feature devices.facts
// Device facts and the product-declared probes (wire contract v3 §6). Mirrors the Python SDK's
// facts tests in sdks/python/tests/test_coverage_gaps.py.
//
// Probes are the privacy-sensitive half of the feature (AGENTS rule 7): a probe answers only for a
// companion app the product declared, and a probe with no target for this platform is omitted —
// reporting it as `present: false` would be a lie an admin cannot tell from "not installed".

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFacts, runProbes } from "../src/devices/facts.js";

describe("collectFacts()", () => {
  it("reports the node runtime and no probes key when none are declared", () => {
    const facts = collectFacts();
    expect(facts.runtime?.name).toBe("node");
    expect(facts.os?.name).toBeTruthy();
    expect(facts.os?.version).toBeTruthy();
    expect("probes" in facts).toBe(false);
  });
});

describe("runProbes()", () => {
  let dir: string;
  let installed: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pkey-facts-"));
    installed = join(dir, "installed");
    writeFileSync(installed, "x");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a declared path that exists with present: true", () => {
    const results = runProbes([
      { id: "here", macos: installed, windows: installed, linux: installed },
    ]);
    expect(results).toEqual({ here: { present: true } });
  });

  it("answers a declared path that does not exist with present: false", () => {
    const missing = join(dir, "missing");
    const results = runProbes([
      { id: "gone", macos: missing, windows: missing, linux: missing },
    ]);
    expect(results).toEqual({ gone: { present: false } });
  });

  it("omits a probe with no target for this platform", () => {
    const results = runProbes([
      { id: "here", macos: installed, windows: installed, linux: installed },
      { id: "elsewhere" },
    ]);
    expect(results).toEqual({ here: { present: true } });
    expect("elsewhere" in results).toBe(false);
  });

  it("carries the declared probe results on collectFacts()", () => {
    const facts = collectFacts({
      probes: [
        { id: "here", macos: installed, windows: installed, linux: installed },
        { id: "elsewhere" },
      ],
    });
    expect(facts.probes).toEqual({ here: { present: true } });
  });
});
