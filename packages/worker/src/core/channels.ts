// The channel vocabulary (WIRE-CONTRACT-V3 §5.1), once, for every enforcement point.
//
// Two parsers read channel names and they stay apart because their grammars differ (P0-04 D15):
// the licence build gate (`core/gate.ts`) reads the client-declared `X-PKey-Channel` header
// through `normalizeChannelHeader` below, and Release's `services/release/channels.ts` classifies
// URL selectors. Both reach the same entitlement predicate, `channelEntitled`, and the same alias
// table, `CHANNEL_ALIASES`, so a grant means one thing at the gate and on the `entitled` feed.

import {
  CHANNEL_ALIASES,
  CHANNEL_BETA,
  CHANNEL_DEV,
  CHANNEL_NAME_PATTERN,
  CHANNEL_PR,
  CHANNEL_STABLE,
  PR_CHANNEL_PATTERN,
  PR_NUMBER_MAX_DIGITS,
} from "@polaris-key/protocol";
import type { BuildChannel } from "@polaris-key/protocol";

export type { BuildChannel } from "@polaris-key/protocol";

const CHANNEL_NAME_RE = new RegExp(CHANNEL_NAME_PATTERN);
const PR_CHANNEL_RE = new RegExp(PR_CHANNEL_PATTERN);
/** The legacy spelling of `beta`: as a grant it also covers `beta`. */
const LEGACY_BETA: keyof typeof CHANNEL_ALIASES = "staging";
/** The canonical per-PR channel a `pr` grant covers. */
const PR_N_RE = /^pr-[0-9]+$/;
/** The PR number a `0.0.0-pr-<n>` build carries; the hyphen is optional (R3-07). */
const PR_BUILD_RE = /^0\.0\.0-pr-?([0-9]+)/;

/**
 * The coarse channel family a build's version implies, as an SDK sends it.
 *
 * Only the `0.0.0-<word>` sentinels carry a channel: `2.0.0-beta.1` is `stable`.
 */
export function channelForVersion(version: string): BuildChannel {
  if (version.startsWith("0.0.0-dev")) return CHANNEL_DEV;
  if (version.startsWith("0.0.0-beta") || version.startsWith("0.0.0-staging"))
    return CHANNEL_BETA;
  // R3-07 — the hyphen is OPTIONAL, matching `sdks/*` (`/^0\.0\.0-pr-?\d+/`, pinned by
  // `sdk-node/test/semver.test.ts:92`). A digit is still required, so `0.0.0-prfoo` stays
  // `stable`.
  if (/^0\.0\.0-pr-?\d+/.test(version)) return CHANNEL_PR;
  return CHANNEL_STABLE;
}

export function isDevBuild(version: string): boolean {
  return version.startsWith("0.0.0-dev");
}

/** True when `name` is in the channel alphabet (§5.1 rule 1). */
export function isChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name);
}

/** `pr-<digits>`, or the `pr` family when the number is longer than `PR_NUMBER_MAX_DIGITS`. */
function prChannel(digits: string): string {
  return digits.length > PR_NUMBER_MAX_DIGITS ? CHANNEL_PR : `pr-${digits}`;
}

/**
 * The channel a build's version implies (§5.1 rule 2): `channelForVersion`, with a PR build
 * narrowed to its own `pr-<n>` so per-PR grants behave as they do in Release (D7).
 */
export function impliedChannel(version: string): string {
  const family = channelForVersion(version);
  if (family !== CHANNEL_PR) return family;
  const digits = version.match(PR_BUILD_RE)?.[1];
  return digits ? prChannel(digits) : CHANNEL_PR;
}

/**
 * Map a client-declared `X-PKey-Channel` onto a canonical channel name (§5.1 rule 3), or
 * `null` when it is malformed, which the gate refuses.
 *
 * R3-01/R3-13 — an unknown but well-formed name is returned as itself, never as `stable`: it
 * must then be granted by name, so it is never a free pass.
 */
export function normalizeChannelHeader(
  header: string,
  version: string,
): string | null {
  // `Object.hasOwn`, not a bare index: `constructor` is a well-formed channel name.
  if (Object.hasOwn(CHANNEL_ALIASES, header))
    return CHANNEL_ALIASES[header as keyof typeof CHANNEL_ALIASES];
  if (header === CHANNEL_PR) {
    const implied = impliedChannel(version);
    return PR_N_RE.test(implied) ? implied : CHANNEL_PR;
  }
  const pr = header.match(PR_CHANNEL_RE);
  if (pr && pr[1] !== undefined) return prChannel(pr[1]);
  return isChannelName(header) ? header : null;
}

/**
 * Is `channel` covered by the `channels` grant (§5.1 rule 4)? `stable` is always granted;
 * otherwise the grant must name the channel exactly, with two widenings only: a `staging` grant
 * (the legacy spelling) also covers `beta`, and a `pr` grant covers every `pr-<n>`. Grants are
 * matched as stored and never rewritten; `dev` and manual names are granted only by name.
 */
export function channelEntitled(
  granted: readonly string[],
  channel: string,
): boolean {
  if (channel === CHANNEL_STABLE) return true;
  if (granted.includes(channel)) return true;
  if (channel === CHANNEL_BETA && granted.includes(LEGACY_BETA)) return true;
  if (PR_N_RE.test(channel) && granted.includes(CHANNEL_PR)) return true;
  return false;
}
