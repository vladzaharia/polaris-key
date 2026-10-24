/**
 * Hybrid logical clocks as the wire states them (§8): 48-bit milliseconds and a 16-bit counter in
 * lowercase hex, `"<12 hex>:<4 hex>"`. Fixed-width lowercase hex, so string order is clock order.
 */

import {
  SYNC_CLIENT_ID_PATTERN,
  SYNC_HLC_PATTERN,
  SYNC_MAX_CLOCK_SKEW_MS,
} from "@polaris-key/protocol/sync";
import type { Stamp } from "./types.js";

const HLC_RE = new RegExp(SYNC_HLC_PATTERN);
const CLIENT_ID_RE = new RegExp(SYNC_CLIENT_ID_PATTERN);

export const isHlc = (v: unknown): v is string =>
  typeof v === "string" && HLC_RE.test(v);

export const isClientId = (v: unknown): v is string =>
  typeof v === "string" && CLIENT_ID_RE.test(v);

/** The parts of a well-formed HLC; `null` for anything else. */
export function parseHlc(hlc: string): { ms: number; counter: number } | null {
  if (!HLC_RE.test(hlc)) return null;
  return {
    ms: Number.parseInt(hlc.slice(0, 12), 16),
    counter: Number.parseInt(hlc.slice(13), 16),
  };
}

export function formatHlc(ms: number, counter: number): string {
  return `${ms.toString(16).padStart(12, "0")}:${counter.toString(16).padStart(4, "0")}`;
}

/**
 * Clamps a stamp from the future (T-clock, §13.3): later than `serverNow` plus the allowed skew
 * becomes `serverNow` with a zero counter; every earlier stamp, the import floor included, is
 * accepted as sent. A client whose clock runs fast can therefore never pin a key beyond the skew.
 */
export function clampHlc(hlc: string, serverNow: number): string {
  const parts = parseHlc(hlc);
  if (!parts) return hlc;
  return parts.ms > serverNow + SYNC_MAX_CLOCK_SKEW_MS
    ? formatHlc(serverNow, 0)
    : hlc;
}

/** Total order of stamps: the HLC, then the clientId. Negative when `a` is older. */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1;
  return 0;
}
