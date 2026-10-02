// The pack claims shared by the release record (step 14) and the content stamp
// (plans/P4-01.md §2.3, §2.4, §2.8; WIRE-CONTRACT-V4 §2.5.1, §2.5.2). Pure, never throws.
//
// One `objectRef` checks every object ref (`full`, `files`, `gaps`, `patch`), so the corpus's
// object-ref cases on `full` stand for every site; `isPackId` is the one pack-id rule
// (`deliverable` of a pack record, `pins[].pack`, `expects[].pack`, `builds[].embeds[]`).

import type { NonWireIntegers } from "@polaris-key/jws";
import { MAX_CONTENT_PINS } from "@polaris-key/protocol/core";
import {
  VOCAB_TOKEN_PATTERN,
  type ContentHold,
} from "@polaris-key/protocol/packs";
import { NO_NON_WIRE_INTEGERS, isWireInteger } from "../claims.js";

/** `@polaris-key/manifest`'s `DELIVERABLE_ID_PATTERN`, restated (client-core does not depend
 *  on the manifest package). */
const DELIVERABLE_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
/** P2-04's `VERSION_RE`. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function has(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** UTF-8 length of a string, counted without allocating. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/**
 * A pack id (plans/P4-01.md §2.3): a string matching `DELIVERABLE_ID_PATTERN`
 * (`^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`), at most 64 bytes, and not `app`.
 */
export function isPackId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "app" &&
    utf8Length(value) <= 64 &&
    DELIVERABLE_RE.test(value)
  );
}

/**
 * An object ref `{sha256, bytes, size, codec}` at `pointer` (plans/P4-01.md §2.3): `sha256` 64
 * lowercase hex; `bytes` and `size` integer claims from `minBytes` and `minSize`; `codec` a
 * `VOCAB_TOKEN_PATTERN` string; `codec: "none"` only with `bytes === size`. An unknown codec
 * verifies (the object is unusable, never the record invalid).
 */
export function objectRef(
  value: unknown,
  pointer: string,
  minBytes: number,
  minSize: number,
  nonWire: NonWireIntegers = NO_NON_WIRE_INTEGERS,
): boolean {
  if (!isObject(value)) return false;
  if (typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256))
    return false;
  if (!isWireInteger(value.bytes, `${pointer}/bytes`, minBytes, nonWire))
    return false;
  if (!isWireInteger(value.size, `${pointer}/size`, minSize, nonWire))
    return false;
  if (typeof value.codec !== "string" || !VOCAB_TOKEN_PATTERN.test(value.codec))
    return false;
  if (value.codec === "none" && value.bytes !== value.size) return false;
  return true;
}

export interface ContentClaimsOptions {
  /** The verified payload's `nonWireIntegers`; omit when checking an object you built. */
  nonWire?: NonWireIntegers;
  /** Where the content object sits in its document: `/content` in an app record, `""` in a
   *  content stamp. */
  pointer?: string;
}

/**
 * The `content` claims (plans/P4-01.md §2.4): an object with an integer `contentApi` ≥ 1,
 * `pins` (0–256 objects, `pack` a unique pack id, `release {sha256, seq ≥ 1, version}`) and
 * `expects` (0–256 objects, `pack` a unique pack id, a boolean `required`, a
 * `VOCAB_TOKEN_PATTERN` `delivery`). Unknown members (`holds`, `packChannels`, …) are ignored.
 * Never throws.
 */
export function contentClaims(
  value: unknown,
  opts: ContentClaimsOptions = {},
): boolean {
  const nonWire = opts.nonWire ?? NO_NON_WIRE_INTEGERS;
  const at = opts.pointer ?? "/content";
  try {
    if (!isObject(value)) return false;
    if (!isWireInteger(value.contentApi, `${at}/contentApi`, 1, nonWire))
      return false;
    const pins = value.pins;
    if (!Array.isArray(pins) || pins.length > MAX_CONTENT_PINS) return false;
    const pinned = new Set<string>();
    for (const [i, pin] of pins.entries()) {
      if (!isObject(pin) || !isPackId(pin.pack)) return false;
      if (pinned.has(pin.pack)) return false;
      pinned.add(pin.pack);
      const r = pin.release;
      if (!isObject(r)) return false;
      if (typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256))
        return false;
      if (!isWireInteger(r.seq, `${at}/pins/${i}/release/seq`, 1, nonWire))
        return false;
      if (typeof r.version !== "string" || !VERSION_RE.test(r.version))
        return false;
    }
    const expects = value.expects;
    if (!Array.isArray(expects) || expects.length > MAX_CONTENT_PINS)
      return false;
    const expected = new Set<string>();
    for (const e of expects) {
      if (!isObject(e) || !isPackId(e.pack)) return false;
      if (expected.has(e.pack)) return false;
      expected.add(e.pack);
      if (typeof e.required !== "boolean") return false;
      if (
        typeof e.delivery !== "string" ||
        !VOCAB_TOKEN_PATTERN.test(e.delivery)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The holds of an app record's `content` or a content stamp (plans/P4-13.md §2.4), read beside
 * the claims: `holds` absent reads `[]`; otherwise it must be an array of 0–256 entries, each
 * `{pack: a pack id, unique and not pinned, release {sha256, seq ≥ 1 by token, version}, reason?:
 * string}`. Anything else reads null (unusable: the device then takes no feed target for any
 * unpinned pack, decision 9). `pointer` is where the content object sits: `/content` in a record,
 * `""` in a stamp, for the token rule over `nonWire`. The parsed holds carry the known members
 * only. Never throws.
 */
export function holdsOf(
  content: unknown,
  nonWire: NonWireIntegers = NO_NON_WIRE_INTEGERS,
  pointer = "/content",
): ContentHold[] | null {
  try {
    if (!isObject(content)) return null;
    if (!has(content, "holds")) return [];
    const holds = content.holds;
    if (!Array.isArray(holds) || holds.length > MAX_CONTENT_PINS) return null;
    const pinned = new Set<string>();
    if (Array.isArray(content.pins))
      for (const p of content.pins)
        if (isObject(p) && typeof p.pack === "string") pinned.add(p.pack);
    const seen = new Set<string>();
    const out: ContentHold[] = [];
    for (const [i, h] of holds.entries()) {
      if (!isObject(h) || !isPackId(h.pack)) return null;
      if (seen.has(h.pack) || pinned.has(h.pack)) return null;
      seen.add(h.pack);
      const r = h.release;
      if (!isObject(r)) return null;
      if (typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256))
        return null;
      if (
        !isWireInteger(r.seq, `${pointer}/holds/${i}/release/seq`, 1, nonWire)
      )
        return null;
      if (typeof r.version !== "string" || !VERSION_RE.test(r.version))
        return null;
      if (has(h, "reason") && typeof h.reason !== "string") return null;
      out.push({
        pack: h.pack,
        release: { sha256: r.sha256, seq: r.seq, version: r.version },
        ...(has(h, "reason") ? { reason: h.reason as string } : {}),
      });
    }
    return out;
  } catch {
    return null;
  }
}
