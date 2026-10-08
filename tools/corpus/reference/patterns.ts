// Reference: §2.3's patterns, restated as literals.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { utf8Bytes } from "../common.js";

export const REF_CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const REF_FEED_PLATFORM_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const REF_BUILD_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const REF_DELIVERABLE_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
export const REF_RECORD_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
export const REF_SHA256_RE = /^[0-9a-f]{64}$/;
export const REF_SALT_RE = /^[0-9a-f]{32}$/;

// §2.3's patterns, restated as literals (the generator imports nothing it checks).
export const REF_PACK_TYPE_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/;
export const REF_VOCAB_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const REF_OBJECT_FORMAT_RE = /^[a-z][a-z0-9-]{0,31}\/[1-9][0-9]{0,8}$/;
export const REF_HANDLER_PREFIX_RE =
  /^res:\/\/([A-Za-z0-9_][A-Za-z0-9 ._@+-]*\/)+$/;
export const REF_ENTITLEMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const REF_AXIS_RE = /^[a-z][a-z0-9-]{0,15}$/;
export const REF_AXIS_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,34}$/;
export const REF_ENGINE_RE = /^godot-[0-9]+\.[0-9]+$/;

/** A pack id: `DELIVERABLE_ID_PATTERN`, at most 64 bytes (`not-app` is its own check). */
export const refPackIdShape = (v: unknown): v is string =>
  typeof v === "string" &&
  utf8Bytes(v).length <= 64 &&
  REF_DELIVERABLE_RE.test(v);
export const refHex64 = (v: unknown): boolean =>
  typeof v === "string" && REF_SHA256_RE.test(v);
/** "absent or …": a present `null` is refused (V4 §3.3 rule 3). */
export const refVocab = (v: unknown): boolean =>
  typeof v === "string" && REF_VOCAB_RE.test(v);
