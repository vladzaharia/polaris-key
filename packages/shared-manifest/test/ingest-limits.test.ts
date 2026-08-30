/**
 * Ingest ceilings that exist for availability, not for tidiness.
 *
 * Both rules here guard a *cost*, and both are reachable from a `.pkey/` file in a third
 * party's repo (`githubWebhook.ts` → `release/resync.ts` → `validateManifestDocuments`), so
 * neither may be treated as an authoring nicety:
 *
 *  - **B7-04 / A5-04** — `manualChannels[].regex` is matched against up to 100 release tags
 *    per request. It is compiled by a backtracking-free matcher, so a pattern that used to be
 *    a CPU bomb is now a flat scan, and a pattern that *cannot* be matched linearly is
 *    refused rather than handed to an engine that would backtrack on it.
 *  - **A7-05** — a device seat cap becomes `claimDeviceSeat`'s `limit`, which materialises one
 *    row per seat inside a single D1 statement. `MAX_DEVICE_LIMIT` bounds that statement.
 *
 * `test/schema-parity.test.ts` pins the *codes* these rules emit against the published JSON
 * Schemas. This file pins the *behaviour* — that the accepted set is the one the runtime can
 * actually afford.
 */

import { describe, expect, it } from "vitest";
import {
  compileManualChannelRegex,
  MANUAL_CHANNEL_REGEX_MAX,
  MAX_DEVICE_LIMIT,
  validateManifestDocuments,
  type ManifestDocuments,
} from "../src/index.js";

/** The smallest fully-valid manifest: default modules are license + config, so a catalog
 *  document is required and a release document is not. */
function base(): ManifestDocuments {
  return {
    product: { slug: "acme", name: "Acme", compatMin: "1.0.0" },
    schema: { schemaVersion: 1, catalog: [] },
  };
}

/** `base()` plus a release document carrying one manual channel. */
function withManualChannel(regex: string): ManifestDocuments {
  return {
    ...base(),
    release: {
      release: {
        provider: { type: "github", owner: "acme", repo: "desktop" },
        manualChannels: [{ name: "nightly", regex }],
      },
    },
  };
}

const codes = (docs: ManifestDocuments): string[] =>
  validateManifestDocuments(docs).errors.map((e) => e.code);

// ── B7-04 / A5-04: manual-channel patterns ───────────────────────────────────

describe("manualChannels[].regex is compiled by a matcher that cannot backtrack", () => {
  it("refuses the constructs that require backtracking, at both gates", () => {
    // Each of these is legal ECMAScript that `new RegExp` accepted before B7-04.
    for (const regex of [
      "(v\\d+)-\\1", // backreference
      "(?=(a+)+b)a", // lookahead
      "(?<=aa)b", // lookbehind
      "\\bnightly", // word boundary
      "\\p{L}+", // unicode property escape
    ]) {
      expect(compileManualChannelRegex(regex), regex).toBeNull();
      expect(codes(withManualChannel(regex)), regex).toContain(
        "invalid_manual_channel",
      );
    }
  });

  it("still refuses a pattern that does not parse, and one over the length cap", () => {
    expect(compileManualChannelRegex("(unclosed")).toBeNull();
    expect(codes(withManualChannel("(unclosed"))).toContain(
      "invalid_manual_channel",
    );

    const long = "a".repeat(MANUAL_CHANNEL_REGEX_MAX + 1);
    expect(compileManualChannelRegex(long)).toBeNull();
    expect(codes(withManualChannel(long))).toContain("invalid_manual_channel");
    // The cap is the binding one: the anchored form stays well inside the catalog engine's
    // own 300-character source limit, so this is the rule that reports.
    expect(
      compileManualChannelRegex("a".repeat(MANUAL_CHANNEL_REGEX_MAX)),
    ).not.toBeNull();
  });

  it("accepts real channel rules and matches them ANCHORED", () => {
    for (const regex of [
      "v.*-nightly\\..*",
      "v\\d+\\.\\d+\\.\\d+-nightly\\.\\d+",
      "v.*-canary",
    ]) {
      expect(codes(withManualChannel(regex)), regex).toEqual([]);
    }

    // Anchoring is what stops `beta` answering for `beta-old`; the linear matcher's own
    // `test` is an unanchored "contains a match", so the `^(?:…)$` wrapper carries it.
    const re = compileManualChannelRegex("v\\d+\\.\\d+\\.\\d+-nightly\\.\\d+");
    expect(re).not.toBeNull();
    expect(re!.test("v1.3.0-nightly.7")).toBe(true);
    expect(re!.test("prefix-v1.3.0-nightly.7")).toBe(false);
    expect(re!.test("v1.3.0-nightly.7-suffix")).toBe(false);
  });

  it("defuses the classic ReDoS pattern instead of paying for it", () => {
    // `(x+x+)+y` needs no backtracking to DECIDE — only V8's engine made it expensive. It is
    // therefore accepted, and it costs a linear scan. Rejecting it would mean a static
    // nested-quantifier heuristic, which leaks (`(a|a)*` is star height 1 and just as bad).
    const re = compileManualChannelRegex("(x+x+)+y");
    expect(re).not.toBeNull();

    const t0 = Date.now();
    // 28 characters was ~2.6 s of worker CPU before; every extra character doubled it.
    expect(re!.test("x".repeat(28))).toBe(false);
    expect(re!.test("x".repeat(40))).toBe(false);
    expect(re!.test("x".repeat(4000))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(250);

    expect(re!.test(`${"x".repeat(40)}y`)).toBe(true); // still correct
  }, 20_000);
});

// ── A7-05: device seat caps ──────────────────────────────────────────────────

describe("device limits are bounded at the manifest write path", () => {
  const withDefaultLimit = (value: unknown): ManifestDocuments => {
    const docs = base();
    (docs.product as Record<string, unknown>).defaultDeviceLimit = value;
    return docs;
  };
  const withTierLimit = (value: unknown): ManifestDocuments => {
    const docs = base();
    (docs.product as Record<string, unknown>).tiers = [
      { id: "pro", policyDeviceLimit: value },
    ];
    return docs;
  };

  it("MAX_DEVICE_LIMIT is 1000 — the value the admin write path also enforces", () => {
    expect(MAX_DEVICE_LIMIT).toBe(1000);
  });

  it("rejects a defaultDeviceLimit past the ceiling", () => {
    // The shape from the finding: one line in a `.pkey/product` turns every activation into a
    // recursive CTE that materialises a hundred million rows in one statement.
    expect(codes(withDefaultLimit(100_000_000))).toContain(
      "invalid_device_limit",
    );
    expect(codes(withDefaultLimit(MAX_DEVICE_LIMIT + 1))).toContain(
      "invalid_device_limit",
    );
  });

  it("rejects a tier policyDeviceLimit past the ceiling", () => {
    expect(codes(withTierLimit(100_000_000))).toContain("invalid_device_limit");
    expect(codes(withTierLimit(MAX_DEVICE_LIMIT + 1))).toContain(
      "invalid_device_limit",
    );
  });

  it("accepts legal caps, including exactly the ceiling and zero", () => {
    for (const value of [0, 1, 5, MAX_DEVICE_LIMIT]) {
      expect(codes(withDefaultLimit(value)), `default ${value}`).toEqual([]);
      expect(codes(withTierLimit(value)), `tier ${value}`).toEqual([]);
    }
  });

  it("rejects rather than clamps — an over-ceiling manifest is not applied at all", () => {
    // The file's convention throughout: a failing rule means the whole manifest is refused,
    // so nothing silently ships with a limit the author did not write.
    const res = validateManifestDocuments(withDefaultLimit(100_000_000));
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.code === "invalid_device_limit");
    expect(err?.path).toBe("/licensing/defaultDeviceLimit");
    expect(err?.message).toContain(String(MAX_DEVICE_LIMIT));
  });

  it("still rejects the non-integer and negative cases the ceiling did not replace", () => {
    expect(codes(withDefaultLimit(-1))).toContain("invalid_number");
    expect(codes(withTierLimit(1.5))).toContain("invalid_device_limit");
  });

  it("leaves defaultMaxOfflineDays uncapped — it is compared against, never counted through", () => {
    const docs = base();
    (docs.product as Record<string, unknown>).defaultMaxOfflineDays = 100_000;
    expect(codes(docs)).toEqual([]);
  });
});
