import { describe, expect, it } from "vitest";
import type { ManagedEntry, ManagedPayload } from "@polaris-key/protocol";
import { emptyPayload, mergePayloads } from "../src/merge.js";

const layer = (p: Partial<ManagedPayload>): string =>
  JSON.stringify({ config: p.config ?? {}, secrets: p.secrets ?? {}, entitlements: p.entitlements ?? {} });
const ent = (value: ManagedEntry["value"], state: ManagedEntry["state"] = "managed"): ManagedEntry => ({ state, value });

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
    expect(mergePayloads()).toEqual({ config: {}, secrets: {}, entitlements: {} });
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

  it("applies precedence tier -> license -> machine (later wins per key)", () => {
    const tier = layer({ config: { theme: ent("light"), region: ent("us") } });
    const license = layer({ config: { theme: ent("dark") } });
    const machine = layer({ config: { region: ent("eu") } });
    const out = mergePayloads(tier, license, machine);
    expect(out.config.theme).toEqual(ent("dark")); // license over tier
    expect(out.config.region).toEqual(ent("eu")); // machine over tier
  });

  it("the last layer fully overrides an earlier entry for the same key", () => {
    const out = mergePayloads(
      layer({ entitlements: { vpn: ent(false, "managed") } }),
      layer({ entitlements: { vpn: ent(true, "hidden") } }),
    );
    expect(out.entitlements.vpn).toEqual(ent(true, "hidden"));
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
    const out = mergePayloads(null, undefined, "", layer({ config: { a: ent(1) } }));
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
