/// <reference types="@cloudflare/workers-types" />

/**
 * Channel classification + resolution.
 *
 * A "channel" is a moving selector that maps to a concrete tag:
 *  - `stable`       — a pinned `X.Y.Z` tag (or `latest`, the newest non-prerelease).
 *  - `beta`/`latest`— the latest tag built from the configured `beta_branch` head via a
 *                     successful run of `channel_workflow`.
 *  - `pr-<n>`       — auto: the latest tag from PR #n's head SHA via `channel_workflow`.
 *  - manual         — manifest-declared `{name, regex}` rules in `manual_channels_json`
 *                     (`release.manualChannels`, persisted by linkRepo/resync); the newest
 *                     release whose tag matches the (anchored, capped) regex.
 *
 * Selector parsing is pure. Resolution takes the release list + (for beta/pr) workflow
 * runs, both supplied by the caller, so this module never touches the network itself.
 */

import { compileManualChannelRegex } from "@polaris-key/manifest";
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
 * beta; `pr-<n>` → pr; otherwise matched against the admin manual channels. Returns
 * `null` for an unrecognized selector.
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

/** Newest published, non-draft release (releases are returned newest-first by the API). */
function newest(
  releases: Release[],
  pred: (r: Release) => boolean,
): Release | null {
  for (const r of releases) {
    if (r.draft) continue;
    if (pred(r)) return r;
  }
  return null;
}

/**
 * Resolve a selector to a concrete release using the provided release list.
 * `beta`/`pr` resolution additionally needs the set of tags produced by the channel
 * workflow (caller supplies via `channelTags`); when omitted, beta falls back to the
 * newest prerelease and pr resolution returns null.
 */
export function resolveChannel(
  sel: ChannelSelector,
  releases: Release[],
  channelTags?: Set<string>,
): Release | null {
  switch (sel.kind) {
    case "stable":
      if (sel.raw === "latest" || sel.raw === "stable")
        return newest(releases, (r) => !r.prerelease);
      return newest(
        releases,
        (r) => r.tag_name === `v${sel.raw}` || r.tag_name === sel.raw,
      );
    case "beta":
      if (channelTags)
        return newest(releases, (r) => channelTags.has(r.tag_name));
      return newest(releases, (r) => r.prerelease);
    case "pr":
      if (channelTags)
        return newest(releases, (r) => channelTags.has(r.tag_name));
      return null;
    case "manual": {
      const re = sel.manual
        ? compileManualChannelRegex(sel.manual.regex)
        : null;
      if (!re) return null;
      return newest(releases, (r) => re.test(r.tag_name));
    }
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
