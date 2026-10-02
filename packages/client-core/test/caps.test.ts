// @pkey-feature core.caps
// The supports() engine every JS SDK runs (P1b-10, PARITY §2.2): the fixed decision order, the
// detector cross-check, the caps list and the thrown form.

import { describe, expect, it } from "vitest";
import {
  PolarisError,
  UNSUPPORTED_CODE,
  UnsupportedError,
  detectorKey,
  detectorProblems,
  evaluateSupport,
  supportedFeatures,
  type CapabilityContext,
  type CapabilityRowLike,
} from "../src/index.js";

const TABLE: Record<string, CapabilityRowLike> = {
  "core.verify": { status: "implemented", service: "core", na: [] },
  "core.store": {
    status: "implemented",
    service: "core",
    na: [
      { runtime: "web", reason: "runtime" },
      { runtime: "node", reason: "dependency" },
    ],
  },
  "config.secret": {
    status: "na",
    service: "config",
    na: [
      { runtime: "web", reason: "runtime" },
      { runtime: "node", reason: "runtime" },
    ],
  },
  "update.decide": { status: "implemented", service: "update", na: [] },
  "update.driver": {
    status: "implemented",
    service: "update",
    na: [{ runtime: "ios", reason: "outlet" }],
  },
  "packs.plan": { status: "planned", service: "release", na: [] },
  "ui.kit": {
    status: "planned",
    service: "sdk",
    na: [{ runtime: "web", reason: "runtime" }],
  },
};

function ctx(over: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    table: TABLE,
    runtime: "node",
    sdkLabel: "@polaris-key/demo 1.0.0",
    serviceSlugs: ["license", "config", "release", "update"],
    serviceEnabled: () => true,
    detectors: { [detectorKey("core.store", "dependency")]: () => null },
    ...over,
  };
}

describe("evaluateSupport — the decision order", () => {
  it("an implemented feature with nothing against it is Supported", () => {
    expect(evaluateSupport(ctx(), "core.verify")).toEqual({
      supported: true,
      feature: "core.verify",
    });
  });

  it("an id the table does not know is version", () => {
    const r = evaluateSupport(ctx(), "future.feature");
    expect(r).toMatchObject({ supported: false, reason: "version" });
    expect(r.supported === false && r.detail).toContain(
      "@polaris-key/demo 1.0.0 does not know the feature future.feature",
    );
  });

  it("a runtime N/A on this runtime is runtime; elsewhere it does not apply", () => {
    expect(
      evaluateSupport(ctx({ runtime: "web" }), "core.store"),
    ).toMatchObject({ supported: false, reason: "runtime" });
    expect(evaluateSupport(ctx(), "core.store").supported).toBe(true);
  });

  it("an na row is unsupported on every runtime, with the declared reason", () => {
    for (const runtime of ["web", "node"])
      expect(evaluateSupport(ctx({ runtime }), "config.secret")).toMatchObject({
        supported: false,
        reason: "runtime",
      });
  });

  it("a runtime N/A outranks planned; planned is version", () => {
    expect(evaluateSupport(ctx({ runtime: "web" }), "ui.kit")).toMatchObject({
      reason: "runtime",
    });
    expect(evaluateSupport(ctx(), "ui.kit")).toMatchObject({
      reason: "version",
    });
    const r = evaluateSupport(ctx(), "packs.plan");
    expect(r).toMatchObject({ supported: false, reason: "version" });
    expect(r.supported === false && r.detail).toContain("does not implement");
  });

  it("an opt-in service that is off is product; core and sdk rows never are", () => {
    const off = ctx({ serviceEnabled: (slug) => slug !== "update" });
    expect(evaluateSupport(off, "update.decide")).toEqual({
      supported: false,
      feature: "update.decide",
      reason: "product",
      detail: "the product does not run the update service",
    });
    const allOff = ctx({ serviceEnabled: () => false });
    expect(evaluateSupport(allOff, "core.verify").supported).toBe(true);
    // A planned feature reports version before product.
    expect(evaluateSupport(allOff, "packs.plan")).toMatchObject({
      reason: "version",
    });
  });

  it("a conditional N/A asks its detector, on its runtime only", () => {
    const missing = ctx({
      detectors: {
        [detectorKey("core.store", "dependency")]: () =>
          "the keyring addon cannot load",
      },
    });
    expect(evaluateSupport(missing, "core.store")).toEqual({
      supported: false,
      feature: "core.store",
      reason: "dependency",
      detail: "the keyring addon cannot load",
    });
    let asked = 0;
    const ios = ctx({
      runtime: "node",
      detectors: {
        [detectorKey("core.store", "dependency")]: () => null,
        [detectorKey("update.driver", "outlet")]: () => {
          asked += 1;
          return "store link only";
        },
      },
    });
    expect(evaluateSupport(ios, "update.driver").supported).toBe(true);
    expect(asked).toBe(0);
    expect(
      evaluateSupport({ ...ios, runtime: "ios" }, "update.driver"),
    ).toMatchObject({ reason: "outlet", detail: "store link only" });
  });

  it("supportedFeatures lists the Supported ids in table order", () => {
    const off = ctx({ serviceEnabled: (slug) => slug !== "update" });
    expect(supportedFeatures(off)).toEqual(["core.verify", "core.store"]);
    expect(supportedFeatures(ctx())).toEqual([
      "core.verify",
      "core.store",
      "update.decide",
      "update.driver",
    ]);
  });
});

describe("detectorProblems — detectors and table agree", () => {
  const runtimes = ["node", "web", "ios"];

  it("a declared conditional N/A on this runtime needs a detector", () => {
    expect(detectorProblems(TABLE, "node", runtimes, {})).toEqual([
      "core.store: the manifest declares a dependency N/A on node, but no detector decides it",
    ]);
    expect(
      detectorProblems(TABLE, "node", runtimes, {
        [detectorKey("core.store", "dependency")]: () => null,
      }),
    ).toEqual([]);
  });

  it("a detector for an N/A the manifest does not declare is refused", () => {
    expect(
      detectorProblems(TABLE, "web", runtimes, {
        [detectorKey("core.verify", "dependency")]: () => null,
      }),
    ).toEqual([
      "core.verify: a dependency detector exists, but the manifest declares no such N/A",
    ]);
  });

  it("a detector for another of the SDK's runtimes is allowed", () => {
    expect(
      detectorProblems(TABLE, "web", runtimes, {
        [detectorKey("update.driver", "outlet")]: () => null,
        [detectorKey("core.store", "dependency")]: () => null,
      }),
    ).toEqual([]);
  });
});

describe("UnsupportedError", () => {
  it("is a PolarisError with code unsupported and the result's fields", () => {
    const e = new UnsupportedError({
      supported: false,
      feature: "config.secret",
      reason: "runtime",
      detail: "no secrets in a browser",
    });
    expect(e).toBeInstanceOf(PolarisError);
    expect(e.code).toBe(UNSUPPORTED_CODE);
    expect(UNSUPPORTED_CODE).toBe("unsupported");
    expect(e.feature).toBe("config.secret");
    expect(e.reason).toBe("runtime");
    expect(e.detail).toBe("no secrets in a browser");
    expect(e.unsupported).toEqual({
      supported: false,
      feature: "config.secret",
      reason: "runtime",
      detail: "no secrets in a browser",
    });
    expect(e.message).toContain(
      "config.secret is not supported here (runtime)",
    );
  });

  it("can keep an older, more specific code", () => {
    const e = new UnsupportedError(
      {
        supported: false,
        feature: "devices.report",
        reason: "runtime",
        detail: "no device bearer",
      },
      "report-unsupported",
    );
    expect(e.code).toBe("report-unsupported");
    expect(e.reason).toBe("runtime");
  });
});
