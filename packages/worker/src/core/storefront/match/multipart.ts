/**
 * The upload matcher for listing assets (multipart and raw blob bodies; notes/S-15 §6.2, owner
 * decision 2 of 2026-10-04: the Worker may push LISTING ASSETS from the blob store, and only those;
 * binaries stay in CI).
 *
 * The gate never sees the bytes. The client describes what it will send (`UploadDescriptor`) from
 * the blob store's own record, and the rule admits it only when its content type is one the slot
 * accepts and its size is within the slot's cap. Builds are never an upload rule: no adapter
 * declares `api` for `uploadBuild`, which the conformance suite asserts.
 */

import {
  isPlainObject,
  type DenyReason,
  type GateContext,
  type GateRule,
} from "../gate.js";

/** What an upload will carry, from the blob store's record (never from a request). */
export interface UploadDescriptor {
  contentType: string;
  size: number;
}

export interface UploadRule extends GateRule {
  /** The media types the slot accepts (`image/png`, `image/jpeg`). */
  contentTypes: readonly string[];
  /** The most bytes one object may have (Play: 15 MiB; Microsoft: 50 MB). */
  maxBytes: number;
  check?: (upload: UploadDescriptor, ctx: GateContext) => DenyReason | null;
}

/** The upload matcher. */
export function matchUpload(
  rule: UploadRule,
  _path: string,
  body: unknown,
  ctx: GateContext,
): DenyReason | null {
  if (
    !isPlainObject(body) ||
    Object.keys(body).some((k) => k !== "contentType" && k !== "size") ||
    typeof body.contentType !== "string" ||
    typeof body.size !== "number" ||
    !Number.isInteger(body.size) ||
    body.size < 1
  )
    return "invalid_body";
  // Parameters (`; charset=`) are not part of the type an image slot accepts.
  const type = body.contentType.split(";")[0]!.trim().toLowerCase();
  if (!rule.contentTypes.includes(type)) return "content_type_not_allowed";
  if (body.size > rule.maxBytes) return "too_large";
  const upload: UploadDescriptor = { contentType: type, size: body.size };
  return rule.check ? rule.check(upload, ctx) : null;
}
