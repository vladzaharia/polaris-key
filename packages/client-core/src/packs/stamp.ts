// The content stamp, `pkey-content/1` (plans/P4-01.md §2.6, §2.8): the app record's `content`,
// written by CI before the export and embedded in every build. Unsigned: it is exactly as
// trustworthy as the build that carries it, so a host loads it from the app's own read-only
// resources, never from a user-writable path.

import { scanStrictJson } from "@polaris-key/jws";
import { CONTENT_STAMP_FORMAT } from "@polaris-key/protocol/core";
import type {
  AppContent,
  ContentExpect,
  ContentPin,
} from "@polaris-key/protocol/packs";
import { contentClaims, isObject } from "./claims.js";

export type ParseContentStampResult =
  | { ok: true; content: AppContent }
  | { ok: false; error: "content-stamp-invalid" };

const invalid: ParseContentStampResult = {
  ok: false,
  error: "content-stamp-invalid",
};

/**
 * Parse a content stamp file's bytes (or its text): strict JSON (WIRE-CONTRACT-V4 §1.2),
 * `format === "pkey-content/1"`, and §2.4's `content` claims over `contentApi`, `pins` and
 * `expects` (pointers at the stamp's top level). Unknown members are ignored. Returns the
 * three members, or `content-stamp-invalid`. Never throws.
 */
export function parseContentStamp(
  input: Uint8Array | string,
): ParseContentStampResult {
  try {
    let text: string;
    if (typeof input === "string") text = input;
    else {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(input);
      } catch {
        return invalid;
      }
    }
    if (text.charCodeAt(0) === 0xfeff) return invalid;
    const scan = scanStrictJson(text);
    if (!scan.ok) return invalid;
    const doc = JSON.parse(text) as unknown;
    if (!isObject(doc) || doc.format !== CONTENT_STAMP_FORMAT) return invalid;
    if (!contentClaims(doc, { nonWire: scan.nonWireIntegers, pointer: "" }))
      return invalid;
    return {
      ok: true,
      content: {
        contentApi: doc.contentApi as number,
        pins: doc.pins as ContentPin[],
        expects: doc.expects as ContentExpect[],
      },
    };
  } catch {
    return invalid;
  }
}
