// The options the licence and tier channel pickers offer (P0-04, WIRE-CONTRACT-V3 §5.1).
//
// A channel grant is not just a label: at the licence gate `pr` covers every PR build and `dev`
// switches on the dev-build bypass (R3-01), so the console never offers those meanings by
// accident. Built from the protocol's channel constants and the manifest's reserved-name rule,
// not from a list of its own.

import {
  CHANNEL_BETA,
  CHANNEL_DEV,
  CHANNEL_NAME_PATTERN,
  CHANNEL_PR,
  CHANNEL_STABLE,
} from "@polaris-key/protocol/core";
import { isReservedChannelName } from "@polaris-key/manifest";

/** One checkbox: the channel name, and an optional hint shown beside it. */
export interface ChannelOption {
  name: string;
  hint?: string;
}

const CANONICAL = new RegExp(CHANNEL_NAME_PATTERN);
/** The legacy spelling of `beta`; a grant of it also covers `beta`. */
const LEGACY_BETA = "staging";

export const HINT_PR = "Every PR build";
export const HINT_MANUAL_STAGING = "Manual; the grant also covers beta";
export const HINT_LEGACY_STAGING = "Legacy alias of beta";
export const HINT_DEV = "Skips the version window and channel checks";
export const HINT_NOT_OFFERED = "Not offered";

/**
 * The picker's options, each name once, in order:
 *
 * 1. the canonical `stable`, `beta`, `dev` and `pr` (`dev` is a built-in track; choosing it stores
 *    `beta` with it, applied by the Worker on write);
 * 2. the product's manual names, minus any that is non-canonical or that a built-in takes over
 *    (`isReservedChannelName`); a declared manual `staging` is listed here;
 * 3. `staging`, only when `held` has it and no manual `staging` is declared;
 * 4. any other value in `held`, a dropped manual name included.
 *
 * `held` is the value the licence or tier had when the dialog opened, so an option the operator
 * unticks stays on screen; a create dialog passes none.
 */
export function channelOptions(
  manual: readonly string[],
  held: readonly string[] = [],
): ChannelOption[] {
  const out: ChannelOption[] = [];
  const seen = new Set<string>();
  const push = (name: string, hint?: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(hint === undefined ? { name } : { name, hint });
  };

  push(CHANNEL_STABLE);
  push(CHANNEL_BETA);
  push(CHANNEL_DEV, HINT_DEV);
  push(CHANNEL_PR, HINT_PR);
  for (const name of manual) {
    if (!CANONICAL.test(name) || isReservedChannelName(name)) continue;
    push(name, name === LEGACY_BETA ? HINT_MANUAL_STAGING : undefined);
  }
  if (held.includes(LEGACY_BETA)) push(LEGACY_BETA, HINT_LEGACY_STAGING);
  for (const name of held) push(name, HINT_NOT_OFFERED);
  return out;
}
