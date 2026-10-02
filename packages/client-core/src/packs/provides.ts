// Save compatibility on the device (P4-20, CONTENT §6.7 item 8, PARITY `packs.provides`): which
// content ids a pack release provides, read from its signed record's record-level `provides`.
//
// `provides` is a member WIRE-CONTRACT-V4 §2.5.1 reserves on the pack record ("ignored by v1"):
// it is never a claim, so a record that carries a malformed list still verifies. This reader is
// the one interpretation every SDK shares, beside the claims and never inside them:
//
//   - absent                        → provides nothing;
//   - an array of 0–`MAX_PROVIDES` unique strings, each matching `CONTENT_ID_PATTERN`
//                                   → those ids;
//   - anything else                 → provides nothing (an unusable list answers no id).
//
// Content ids are opaque. The pattern (printable ASCII without the space, 1–128 characters) is
// the shape the publish rules enforce (`.pkey/provides.json`, the Worker's `pack-provides`), so a
// record that reaches a device has it; the reader re-checks it so no SDK trusts a list another
// would refuse. Python (`update/packs/provides.py`), Swift (`PolarisKeyPacks/Provides.swift`) and
// Godot (`packs/provides.gd`) port this file.

import { base64UrlDecode } from "@polaris-key/jws";

/** One content id: printable ASCII without the space, 1–128 characters. */
export const CONTENT_ID_PATTERN = /^[!-~]{1,128}$/;
/** The most ids one `provides` (or `removes`) list may hold. */
export const MAX_PROVIDES = 4096;

const NONE: ReadonlySet<string> = new Set();

/** A record payload's `provides`, as a set (empty when absent or unusable). */
export function providesOf(record: unknown): ReadonlySet<string> {
  if (typeof record !== "object" || record === null || Array.isArray(record))
    return NONE;
  const list = (record as { provides?: unknown }).provides;
  if (!Array.isArray(list) || list.length > MAX_PROVIDES) return NONE;
  const out = new Set<string>();
  for (const id of list) {
    if (typeof id !== "string" || !CONTENT_ID_PATTERN.test(id) || out.has(id))
      return NONE;
    out.add(id);
  }
  return out;
}

/**
 * The payload of a compact JWS the engine has ALREADY verified (a stored install, an embedded
 * baseline), decoded and never re-verified here; null when it does not decode.
 */
export function verifiedPayloadOf(jws: string): unknown {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!)));
  } catch {
    return null;
  }
}

/** What save compatibility reads from one verified pack record. */
export interface ProvidesFacts {
  provides: ReadonlySet<string>;
  /** The record's `entitlement`, or null: a licence without it hides the pack (CONTENT §6.7
   *  item 9), so it never answers. */
  entitlement: string | null;
}

/** `providesOf` and the entitlement of a verified record payload. */
export function providesFacts(record: unknown): ProvidesFacts {
  const e = (record as { entitlement?: unknown } | null)?.entitlement;
  return {
    provides: providesOf(record),
    entitlement: typeof e === "string" ? e : null,
  };
}

/** What `packFor` answers: the pack whose target release provides the id. */
export interface PackProvider {
  packId: string;
  release: { sha256: string; seq: number; version: string };
}
