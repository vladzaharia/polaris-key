/**
 * Ingest ceilings that exist for availability, not for tidiness.
 *
 * Every rule here guards a *cost*, and each is reachable from a `.pkey/` file in a third party's
 * repo (`githubWebhook.ts` → `release/resync.ts` → `validateManifestDocuments`), so none of them
 * may be treated as an authoring nicety:
 *
 *  - **Tag patterns** — `manualChannels[].regex` and `stableTagPattern` are matched against up to
 *    100 release tags per request. They are compiled by a backtracking-free matcher, so a pattern
 *    that used to be a CPU bomb is now a flat scan, and a pattern that *cannot* be matched
 *    linearly is refused rather than handed to an engine that would backtrack on it.
 *
 * `test/schema-parity.test.ts` pins the *codes* these rules emit against the published JSON
 * Schemas. This file pins the *behaviour*: that the accepted set is the one the runtime can
 * actually afford.
 */

import { describe, expect, it } from "vitest";
import {
  compileManualChannelRegex,
  DEFAULT_STABLE_TAG_PATTERN,
  MANUAL_CHANNEL_REGEX_MAX,
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

const provider = { type: "github", owner: "acme", repo: "desktop" };

/** `base()` plus a release document with the given members beside the provider. */
function withRelease(members: Record<string, unknown>): ManifestDocuments {
  return { ...base(), release: { release: { provider, ...members } } };
}

/** `base()` plus a release document carrying one manual channel. */
const withManualChannel = (regex: string): ManifestDocuments =>
  withRelease({ manualChannels: [{ name: "nightly", regex }] });

const codes = (docs: ManifestDocuments): string[] =>
  validateManifestDocuments(docs).errors.map((e) => e.code);

// ── Tag patterns ─────────────────────────────────────────────────────────────

describe("manualChannels[].regex is compiled by a matcher that cannot backtrack", () => {
  it("refuses the constructs that require backtracking, at both gates", () => {
    // Each of these is legal ECMAScript that `new RegExp` accepted before.
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

  it("says why, in the message a pusher reads", () => {
    const err = validateManifestDocuments(
      withManualChannel("(v\\d+)-\\1"),
    ).errors.find((e) => e.code === "invalid_manual_channel");
    expect(err?.path).toContain("/regex");
    expect(err?.message).toContain("backtracking-free");
    expect(err?.message).toContain("backreferences, lookaround and \\b");
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

    // Anchoring is what stops `beta` answering for `beta-old`; the linear matcher's own `test`
    // is an unanchored "contains a match", so the `^(?:…)$` wrapper carries it.
    const re = compileManualChannelRegex("v\\d+\\.\\d+\\.\\d+-nightly\\.\\d+");
    expect(re).not.toBeNull();
    expect(re!.test("v1.3.0-nightly.7")).toBe(true);
    expect(re!.test("prefix-v1.3.0-nightly.7")).toBe(false);
    expect(re!.test("v1.3.0-nightly.7-suffix")).toBe(false);
  });

  it("defuses the classic ReDoS pattern instead of paying for it", () => {
    // `(x+x+)+y` needs no backtracking to DECIDE: only V8's engine made it expensive. It is
    // therefore accepted, and it costs a linear scan. Rejecting it would mean a static
    // nested-quantifier heuristic, which leaks (`(a|a)*` is star height 1 and just as bad).
    const re = compileManualChannelRegex("(x+x+)+y");
    expect(re).not.toBeNull();
    // Not a native `RegExp`: that is what backtracked. Asserted first and structurally, so a
    // regression fails here instead of hanging on the 40-character input below.
    expect(re).not.toBeInstanceOf(RegExp);

    // 28 characters was seconds of worker CPU under `RegExp`; every extra character doubled it.
    expect(re!.test("x".repeat(28))).toBe(false);
    expect(re!.test("x".repeat(40))).toBe(false);
    expect(re!.test("x".repeat(4000))).toBe(false);
    expect(re!.test(`${"x".repeat(40)}y`)).toBe(true); // still correct
  });
});

describe("stableTagPattern goes through the same matcher", () => {
  it("compiles the default candidate pattern, which is what an undeclared pattern means", () => {
    expect(DEFAULT_STABLE_TAG_PATTERN.length).toBeLessThanOrEqual(
      MANUAL_CHANNEL_REGEX_MAX,
    );
    const re = compileManualChannelRegex(DEFAULT_STABLE_TAG_PATTERN);
    expect(re).not.toBeNull();
    expect(re).not.toBeInstanceOf(RegExp);
    for (const tag of ["v1.2.3", "1.2.3", "v2.0.0-rc.1", "v1.0.0+build.5"])
      expect(re!.test(tag), tag).toBe(true);
    for (const tag of ["channels", "packs", "v1.2", "v01.2.3", "1.2.3.4"])
      expect(re!.test(tag), tag).toBe(false);
  });

  it("refuses a backtracking construct at both places the pattern can be declared", () => {
    for (const regex of ["(v\\d+)-\\1", "\\bv\\d+", "(?=v)v\\d+"]) {
      const atRoot = validateManifestDocuments(
        withRelease({ stableTagPattern: regex }),
      ).errors;
      expect(
        atRoot.map((e) => e.code),
        regex,
      ).toContain("invalid_stable_tag_pattern");
      expect(
        atRoot.find((e) => e.code === "invalid_stable_tag_pattern")?.message,
      ).toContain("backtracking-free");

      const atVersioning = validateManifestDocuments(
        withRelease({
          deliverables: {
            app: { kind: "app", versioning: { stableTagPattern: regex } },
          },
        }),
      ).errors;
      expect(
        atVersioning.map((e) => e.code),
        regex,
      ).toContain("invalid_stable_tag_pattern");
    }
  });

  it("accepts a ReDoS-shaped pattern, which now costs a linear scan", () => {
    expect(
      codes(withRelease({ stableTagPattern: "(x+x+)+y" })),
      "root",
    ).toEqual([]);
    expect(
      codes(
        withRelease({
          deliverables: {
            app: { kind: "app", versioning: { stableTagPattern: "(x+x+)+y" } },
          },
        }),
      ),
      "versioning",
    ).toEqual([]);
  });
});
