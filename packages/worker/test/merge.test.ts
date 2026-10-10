import { describe, expect, it } from "vitest";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "../src/core/licensing/payload.js";
import { emptyPayload, mergePayloads } from "../src/core/licensing/merge.js";

const layer = (p: Partial<ManagedPayload>): string =>
  JSON.stringify({
    config: p.config ?? {},
    secrets: p.secrets ?? {},
    entitlements: p.entitlements ?? {},
  });
const ent = (
  value: ManagedEntry["value"],
  state: ManagedEntry["state"] = "enforced",
  updatedAt = 1_700_000_000,
): ManagedEntry => ({ state, value, updatedAt });

describe("emptyPayload", () => {
  it("is a fresh, empty triple each call", () => {
    const a = emptyPayload();
    const b = emptyPayload();
    expect(a).toEqual({ config: {}, secrets: {}, entitlements: {} });
    expect(a).not.toBe(b);
  });
});

describe("mergePayloads", () => {
  it("returns an empty payload with no layers", () => {
    expect(mergePayloads()).toEqual({
      config: {},
      secrets: {},
      entitlements: {},
    });
  });

  it("merges key-by-key across the three maps", () => {
    const out = mergePayloads(
      layer({ config: { a: ent(1) }, entitlements: { x: ent(true) } }),
      layer({ config: { b: ent(2) }, secrets: { s: ent("v", "hidden") } }),
    );
    expect(out.config).toEqual({ a: ent(1), b: ent(2) });
    expect(out.secrets).toEqual({ s: ent("v", "hidden") });
    expect(out.entitlements).toEqual({ x: ent(true) });
  });

  it("applies precedence tier -> license -> device (later wins per key)", () => {
    const tier = layer({ config: { theme: ent("light"), region: ent("us") } });
    const license = layer({ config: { theme: ent("dark") } });
    const device = layer({ config: { region: ent("eu") } });
    const out = mergePayloads(tier, license, device);
    expect(out.config.theme).toEqual(ent("dark")); // license over tier
    expect(out.config.region).toEqual(ent("eu")); // device over tier
  });

  it("the last layer fully overrides an earlier entry for the same key", () => {
    const out = mergePayloads(
      layer({ entitlements: { vpn: ent(false, "enforced", 100) } }),
      layer({ entitlements: { vpn: ent(true, "hidden", 200) } }),
    );
    // Value + state come from the highest-precedence layer; updatedAt = max across layers.
    expect(out.entitlements.vpn).toEqual(ent(true, "hidden", 200));
  });

  it("carries state from the highest-precedence layer but updatedAt = max across layers", () => {
    // The earlier (lower-precedence) layer has the NEWER updatedAt; it must win for updatedAt
    // even though value + state come from the later (higher-precedence) layer.
    const out = mergePayloads(
      layer({ config: { a: ent(1, "default", 900) } }),
      layer({ config: { a: ent(2, "enforced", 500) } }),
    );
    expect(out.config.a).toEqual(ent(2, "enforced", 900));
  });

  it("does not let a default layer override an enforced or hidden value", () => {
    const out = mergePayloads(
      layer({
        config: {
          locked: ent("server", "enforced", 100),
          concealed: ent("secret", "hidden", 100),
        },
      }),
      layer({
        config: {
          locked: ent("local", "default", 200),
          concealed: ent("visible", "default", 200),
        },
      }),
    );
    expect(out.config.locked).toEqual(ent("server", "enforced", 200));
    expect(out.config.concealed).toEqual(ent("secret", "hidden", 200));
  });

  it("tolerates malformed JSON layers (skips them as empty)", () => {
    const out = mergePayloads(
      "{not valid json",
      layer({ config: { a: ent(1) } }),
      "also bad }{",
    );
    expect(out.config).toEqual({ a: ent(1) });
  });

  it("tolerates null/undefined/empty-string layers", () => {
    const out = mergePayloads(
      null,
      undefined,
      "",
      layer({ config: { a: ent(1) } }),
    );
    expect(out.config).toEqual({ a: ent(1) });
  });

  it("tolerates a layer with missing sub-maps (partial payload JSON)", () => {
    const out = mergePayloads(
      JSON.stringify({ config: { a: ent(1) } }), // no secrets/entitlements keys
      JSON.stringify({ entitlements: { x: ent(true) } }),
    );
    expect(out.config).toEqual({ a: ent(1) });
    expect(out.secrets).toEqual({});
    expect(out.entitlements).toEqual({ x: ent(true) });
  });

  it("does not mutate inputs and returns independent maps", () => {
    const a = layer({ config: { a: ent(1) } });
    const out = mergePayloads(a);
    out.config.b = ent(2);
    // Re-merging the same string still yields only `a`.
    expect(mergePayloads(a).config).toEqual({ a: ent(1) });
  });
});
