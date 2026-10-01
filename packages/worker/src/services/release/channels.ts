/// <reference types="@cloudflare/workers-types" />

/**
 * Channel classification + resolution.
 *
 * A "channel" is a moving selector that maps to a concrete tag:
 *  - `stable`       — a pinned `X.Y.Z` tag (or `latest`, the highest-precedence non-prerelease
 *                     candidate — see "Candidates and ordering" below).
 *  - `beta`         — the latest tag built from the configured `beta_branch` head via a
 *                     successful run of `channel_workflow`. `staging` is its legacy alias,
 *                     unless the product declares a manual channel of that name.
 *  - `pr-<n>`       — auto: the latest tag from PR #n's head SHA via `channel_workflow`.
 *  - manual         — manifest-declared `{name, regex}` rules in `manual_channels_json`
 *                     (`release.manualChannels`, persisted by linkRepo/resync); the newest
 *                     release whose tag matches the (anchored, capped) regex.
 *
 * Selector parsing is pure. Resolution takes the release list + (for beta/pr) workflow
 * runs, both supplied by the caller, so this module never touches the network itself.
 */

import {
  compileManualChannelRegex,
  DEFAULT_STABLE_TAG_PATTERN,
  isIgnoreTag,
} from "@polaris-key/manifest";
import { CHANNEL_ALIASES, CHANNEL_BETA } from "@polaris-key/protocol";
import { compareSemver, parseSemver } from "../../core/entitlements.js";
import type { Release } from "./github.js";

export type ChannelKind = "stable" | "beta" | "pr" | "manual";

export interface ManualChannel {
  name: string;
  regex: string;
}

export interface ChannelSelector {
  kind: ChannelKind;
  /** Original selector string (stable: the version; pr: `pr-<n>`; manual: the name). */
  raw: string;
  /** PR number (pr only). */
  pr?: number;
  /** The compiled rule (manual only). */
  manual?: ManualChannel;
}

/**
 * Classify a `:version`/channel segment. `stable`/`latest`/`X.Y.Z` → stable; `beta` →
 * beta; `pr-<n>` → pr; otherwise matched against the admin manual channels; then `staging`, the
 * legacy alias of `beta` (WIRE-CONTRACT-V3 §5.1 rule 6), looked up AFTER the manual names so a
 * product that declares a manual `staging` channel keeps it. Returns `null` for an unrecognized
 * selector.
 *
 * An aliased selector keeps the requested spelling in `raw` (P0-04 D8): the asset suffix, the
 * enclosure, the feed title and the edge-cache key all follow `raw`, while resolution, floors and
 * the `entitled` check go by `kind`.
 */
export function classifyChannel(
  selector: string | undefined,
  manualChannels: ManualChannel[] = [],
): ChannelSelector | null {
  if (!selector || selector === "latest")
    return { kind: "stable", raw: selector ?? "latest" };
  if (selector === "stable") return { kind: "stable", raw: "stable" };
  if (selector === "beta") return { kind: "beta", raw: "beta" };

  const prMatch = selector.match(/^pr-(\d{1,7})$/);
  if (prMatch && prMatch[1])
    return { kind: "pr", raw: selector, pr: Number(prMatch[1]) };

  const manual = manualChannels.find((c) => c.name === selector);
  if (manual) return { kind: "manual", raw: selector, manual };

  const aliased = (CHANNEL_ALIASES as Record<string, string>)[selector];
  if (aliased === CHANNEL_BETA) return { kind: "beta", raw: selector };

  // A bare X.Y.Z(-suffix) is a pinned stable tag.
  if (/^\d+\.\d+\.\d+/.test(selector)) return { kind: "stable", raw: selector };

  return null;
}

/** True for selectors whose target moves (short-cache); pinned `X.Y.Z` is immutable. */
export function isMovingSelector(sel: ChannelSelector): boolean {
  return !(
    sel.kind === "stable" &&
    sel.raw !== "latest" &&
    sel.raw !== "stable"
  );
}

// The anchored/capped/must-compile safety rule lives in @polaris-key/manifest
// (`compileManualChannelRegex`) so ingest validation and this runtime reader are one rule,
// not two copies — the validator refuses exactly what this parser would drop.

/** Parse `manual_channels_json` into validated rules (drops malformed/unsafe entries). */
export function parseManualChannels(
  json: string | null | undefined,
): ManualChannel[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ManualChannel[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      "name" in entry &&
      "regex" in entry
    ) {
      const { name, regex } = entry as Record<string, unknown>;
      if (
        typeof name === "string" &&
        typeof regex === "string" &&
        compileManualChannelRegex(regex)
      ) {
        out.push({ name, regex });
      }
    }
  }
  return out;
}

// ── Candidates and ordering (P0-02) ─────────────────────────────────────────────────────────
//
// "Newest" used to mean "first in the GitHub list" — creation order — and any non-draft,
// non-prerelease tag qualified as stable, so a repo's rolling `channels` or `packs` release
// became `latest`, and `v1.4.0` created after `v1.10.0` beat it. Resolution is now two steps:
//
//   1. FILTER to candidates — non-draft, not in `ignoreTags`, matching `stableTagPattern`, and
//      with a version (`versionFromTag`) that parses as semver;
//   2. ORDER by semver precedence, ties (`v1.2.0` vs `1.2.0`) to the later `published_at`.
//
// Filtering first is what keeps `compareSemver`'s "unparseable compares equal" out of the
// picture: the comparator only ever sees parseable versions on the stable path.

/**
 * What a product's `release_config` says about which tags are real releases. Built once per
 * request from the row (`resolutionPolicy`) and passed IN, so this module stays pure and P2-05
 * can hand the same function a per-platform policy.
 */
export interface ResolutionPolicy {
  /** A candidate for stable/latest and the beta prerelease fallback. */
  isCandidate: (r: Release) => boolean;
  /** An `ignoreTags` entry: skipped by every moving channel, manual ones included. */
  isIgnored: (r: Release) => boolean;
  /** Precedence order: > 0 when `a` is newer than `b`. */
  compare: (a: Release, b: Release) => number;
}

/** The default candidate regex, compiled once (it is a constant, so this cannot be null). */
const DEFAULT_STABLE_RE = compileManualChannelRegex(
  DEFAULT_STABLE_TAG_PATTERN,
) as RegExp;

/** Epoch millis for a `published_at`, or -Infinity when absent/unparseable (never wins a tie). */
function publishedMs(r: Release): number {
  const ms = r.published_at ? Date.parse(r.published_at) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** The version a tag denotes, when it is semver; null otherwise. */
export function semverOfTag(tag: string): string | null {
  const v = versionFromTag(tag);
  return parseSemver(v) ? v : null;
}

/**
 * Semver precedence, then `published_at`. When either side is not semver (a manual channel
 * whose tags are dates, say) precedence is undefined and `published_at` alone decides. Callers
 * that need a TOTAL order over a mixed set use `newestOf`, which applies one rule to the whole
 * set rather than mixing the two pairwise.
 */
export function compareReleases(a: Release, b: Release): number {
  const va = semverOfTag(a.tag_name);
  const vb = semverOfTag(b.tag_name);
  if (va !== null && vb !== null) {
    const c = compareSemver(va, vb);
    if (c !== 0) return c;
  }
  return publishedMs(a) - publishedMs(b);
}

/** Compare by `published_at` alone (the order for a set that is not all semver). */
function comparePublished(a: Release, b: Release): number {
  return publishedMs(a) - publishedMs(b);
}

/** Parse `ignore_tags_json`; malformed JSON or entries are dropped, never thrown. */
export function parseIgnoreTags(json: string | null | undefined): Set<string> {
  if (!json) return new Set();
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(isIgnoreTag));
  } catch {
    return new Set();
  }
}

/**
 * Build the candidate policy from `release_config`'s two manifest-owned columns.
 *
 * An unsafe or uncompilable stored pattern (the validator refuses one, so only a hand-edited row
 * can hold it) falls back to the DEFAULT rather than to "match everything": a broken filter must
 * not re-open the hole it exists to close.
 */
export function resolutionPolicy(cfg: {
  stable_tag_pattern?: string | null;
  ignore_tags_json?: string | null;
}): ResolutionPolicy {
  const re =
    (cfg.stable_tag_pattern
      ? compileManualChannelRegex(cfg.stable_tag_pattern)
      : null) ?? DEFAULT_STABLE_RE;
  const ignore = parseIgnoreTags(cfg.ignore_tags_json);
  const isIgnored = (r: Release) => ignore.has(r.tag_name);
  return {
    isIgnored,
    // The operator regex runs LAST, after every linear check has had the chance to reject the tag
    // (R10-09: `stableTagPattern` is compiled under the same length-and-compile rule as a manual
    // channel, which is not a complexity guard).
    isCandidate: (r) =>
      !r.draft &&
      !isIgnored(r) &&
      semverOfTag(r.tag_name) !== null &&
      re.test(r.tag_name),
    compare: compareReleases,
  };
}

/** The policy for a row that declares neither field. */
export const DEFAULT_RESOLUTION_POLICY: ResolutionPolicy = resolutionPolicy({});

/**
 * The highest-precedence non-draft release satisfying `pred`.
 *
 * When every match is semver, precedence (then `published_at`) orders them; when any is not, the
 * whole set is ordered by `published_at` (then list order), so the order is total and does not
 * depend on the API's page order. On a full tie the earlier list entry wins, which reproduces the
 * old behaviour for a list with no dates.
 */
export function newestOf(
  releases: Release[],
  pred: (r: Release) => boolean,
  compare: (a: Release, b: Release) => number = compareReleases,
): Release | null {
  const matches = releases.filter((r) => !r.draft && pred(r));
  if (matches.length === 0) return null;
  const allSemver = matches.every((r) => semverOfTag(r.tag_name) !== null);
  const cmp = allSemver ? compare : comparePublished;
  let best = matches[0] as Release;
  for (const r of matches.slice(1)) if (cmp(r, best) > 0) best = r;
  return best;
}

/**
 * Resolve a selector to a concrete release using the provided release list.
 * `beta`/`pr` resolution additionally needs the set of tags produced by the channel
 * workflow (caller supplies via `channelTags`); when omitted, beta falls back to the
 * highest-precedence prerelease CANDIDATE and pr resolution returns null.
 *
 * `policy` is the product's candidate filter (`resolutionPolicy(cfg)`); omitted, it is the
 * default — any semver tag, no ignore list.
 */
export function resolveChannel(
  sel: ChannelSelector,
  releases: Release[],
  channelTags?: Set<string>,
  policy: ResolutionPolicy = DEFAULT_RESOLUTION_POLICY,
): Release | null {
  const { compare, isCandidate, isIgnored } = policy;
  switch (sel.kind) {
    case "stable":
      if (sel.raw === "latest" || sel.raw === "stable")
        return newestOf(
          releases,
          (r) => !r.prerelease && isCandidate(r),
          compare,
        );
      // A pinned version names its tag exactly; `ignoreTags` does not hide it.
      return newestOf(
        releases,
        (r) => r.tag_name === `v${sel.raw}` || r.tag_name === sel.raw,
        compare,
      );
    case "beta":
      if (channelTags)
        return newestOf(
          releases,
          (r) => channelTags.has(r.tag_name) && !isIgnored(r),
          compare,
        );
      return newestOf(releases, (r) => r.prerelease && isCandidate(r), compare);
    case "pr":
      if (channelTags)
        return newestOf(
          releases,
          (r) => channelTags.has(r.tag_name) && !isIgnored(r),
          compare,
        );
      return null;
    case "manual": {
      const re = sel.manual
        ? compileManualChannelRegex(sel.manual.regex)
        : null;
      if (!re) return null;
      // Manual channels keep their own regex (not `stableTagPattern`) but skip `ignoreTags`.
      return newestOf(
        releases,
        (r) => !isIgnored(r) && re.test(r.tag_name),
        compare,
      );
    }
  }
}

/**
 * The truth-store channel name a selector's floor is kept under, or null when the selector is
 * never floored: a pinned version is immutable, `pr-<n>` is ephemeral, and `beta` with a channel
 * workflow resolves through the Actions API — which the sync (a pure pass over the list) cannot
 * reproduce, so a floor it raised would disagree with what the live route resolves.
 */
export function floorChannelOf(
  sel: ChannelSelector,
  cfg: { channel_workflow: string | null },
): string | null {
  switch (sel.kind) {
    case "stable":
      return sel.raw === "latest" || sel.raw === "stable" ? "stable" : null;
    case "beta":
      return cfg.channel_workflow ? null : "beta";
    case "manual":
      return sel.raw;
    case "pr":
      return null;
  }
}

/**
 * Parse `vX.Y.Z` / `X.Y.Z` to a bare semver string.
 *
 * Release's, not Update's: it is how a GitHub TAG becomes the version the truth store keys on
 * (`release_metadata.version`), which the feed then quotes as Sparkle's `shortVersionString`.
 * It lived beside the renderer until P2.T1 split the feed out.
 */
export function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}
