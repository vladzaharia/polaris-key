/**
 * The licence Config tab's inherited column (`resolveInherited`) agrees with the Worker's merge
 * (`packages/worker/src/merge.ts` `mergeMap`, pinned by `packages/worker/test/merge.test.ts`): a
 * lower `enforced`/`hidden` entry is not demoted by a higher `default` one, and it keeps its own
 * value and source (P0-47, the lock bug). Devices receive the locked value, so the console shows it.
 */

import { describe, expect, it } from "vitest";
import type {
  ManagedEntry,
  ManagementState,
  RedactedPayload,
} from "../src/api.js";
import {
  resolveInherited,
  type PayloadLayer,
} from "../src/console/sections/license/pages/LicenseConfig.js";
import { CATALOG } from "./licenseFixture.js";

const ent = (value: unknown, state: ManagementState): ManagedEntry => ({
  value,
  state,
  updatedAt: 1,
});

function layer(
  source: string,
  config: RedactedPayload["config"],
): PayloadLayer {
  return { source, payload: { config, secrets: {}, entitlements: {} } };
}

describe("resolveInherited (the licence Config tab)", () => {
  it("keeps a lower enforced value and its source under a higher default (merge.ts)", () => {
    const out = resolveInherited(CATALOG.entries, [
      layer("the tier's profile “studio”", {
        "feature.timeout": ent(6, "enforced"),
      }),
      layer("profile “trial”", { "feature.timeout": ent(3, "default") }),
    ]);
    expect(out["feature.timeout"]).toEqual({
      source: "the tier's profile “studio”",
      value: 6,
      state: "enforced",
    });
  });

  it("keeps a lower hidden value the same way", () => {
    const out = resolveInherited(CATALOG.entries, [
      layer("the tier's profile “studio”", {
        "feature.timeout": ent(9, "hidden"),
      }),
      layer("profile “trial”", { "feature.timeout": ent(3, "default") }),
    ]);
    expect(out["feature.timeout"]).toMatchObject({ value: 9, state: "hidden" });
  });

  it("lets the higher layer win otherwise: default over default, enforced over enforced", () => {
    // default under default: the higher layer wins.
    expect(
      resolveInherited(CATALOG.entries, [
        layer("a", { "feature.timeout": ent(6, "default") }),
        layer("b", { "feature.timeout": ent(3, "default") }),
      ])["feature.timeout"],
    ).toEqual({ source: "b", value: 3, state: "default" });
    // A higher enforced replaces a lower enforced, value and source.
    expect(
      resolveInherited(CATALOG.entries, [
        layer("a", { "feature.timeout": ent(6, "enforced") }),
        layer("b", { "feature.timeout": ent(3, "enforced") }),
      ])["feature.timeout"],
    ).toEqual({ source: "b", value: 3, state: "enforced" });
  });
});
