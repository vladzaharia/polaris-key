/**
 * Apple's upload operations for a reserved App Store screenshot (A-18m; S-15 §7.5, owner decisions
 * 1 and 2 of 2026-10-04: the listing's screenshots go from the Worker out of the blob store;
 * binaries never).
 *
 * A screenshot is three requests: the reserve (`POST /v1/appScreenshots` with its file name and
 * size, through the gated `AscClient`), the PUT of its bytes to each upload operation Apple answers
 * the reserve with (this file), and the commit (`PATCH /v1/appScreenshots/{id}`, gated again).
 *
 *   - **Gated first.** Every operation is checked by `checkAscUpload` (`rules/appStore.ts`) before
 *     a byte is read: the method is `PUT`, the URL is `https` on an `apple.com` host with no
 *     credentials, and what it carries (the blob store's record: content type and size) is an
 *     image within the cap. The operations must cover the file exactly, in order.
 *   - **No credential.** The URL is presigned by Apple: the PUT carries no `Authorization` header,
 *     and Apple's own `requestHeaders` are passed only when they are plain headers (never
 *     `Authorization`, `Cookie`, `Host` or a `Proxy-` header) and a `Content-Type` names the
 *     file's own type.
 *   - **No redirects, no URL in a message.** `redirect: "manual"`, and a failure is an `AscError`
 *     that names "upload operation", never the presigned URL (it is a bearer of its own).
 */

import { isRedirect } from "../readCapped.js";
import { checkAscUpload } from "../storefront/rules/appStore.js";
import type { UploadDescriptor } from "../storefront/match/multipart.js";
import { AscError, AscWriteDenied, type FetchImpl } from "./client.js";

/** One upload operation as Apple answers it (`UploadOperation`). */
export interface AscUploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders: { name: string; value: string }[];
}

/** The most operations one screenshot may be split into. */
const MAX_OPERATIONS = 64;

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADER =
  /^(authorization|cookie|host|content-length|proxy-.*)$/i;
// Printable ASCII and spaces only: no CR or LF can split a header.
const HEADER_VALUE = /^[\x20-\x7e]{0,1024}$/;

/**
 * The upload operations of a reserve's answer for a file of `size` bytes, or null when they are
 * not a plain, ordered cover of exactly `[0, size)`.
 */
export function uploadOperations(
  value: unknown,
  size: number,
): AscUploadOperation[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_OPERATIONS) return null;
  const ops: AscUploadOperation[] = [];
  let next = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (
      typeof o.method !== "string" ||
      typeof o.url !== "string" ||
      typeof o.offset !== "number" ||
      typeof o.length !== "number" ||
      !Number.isSafeInteger(o.offset) ||
      !Number.isSafeInteger(o.length) ||
      o.offset !== next ||
      o.length < 1
    )
      return null;
    const headers: { name: string; value: string }[] = [];
    if (o.requestHeaders !== undefined && o.requestHeaders !== null) {
      if (!Array.isArray(o.requestHeaders) || o.requestHeaders.length > 16)
        return null;
      for (const h of o.requestHeaders) {
        const name = (h as { name?: unknown } | null)?.name;
        const v = (h as { value?: unknown } | null)?.value;
        if (
          typeof name !== "string" ||
          typeof v !== "string" ||
          !HEADER_NAME.test(name) ||
          !HEADER_VALUE.test(v)
        )
          return null;
        headers.push({ name, value: v });
      }
    }
    ops.push({
      method: o.method,
      url: o.url,
      offset: o.offset,
      length: o.length,
      requestHeaders: headers,
    });
    next = o.offset + o.length;
  }
  return next === size ? ops : null;
}

/** The headers one operation is sent with, or null when Apple asked for one the gate refuses. */
function operationHeaders(
  op: AscUploadOperation,
  upload: UploadDescriptor,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const h of op.requestHeaders) {
    if (FORBIDDEN_HEADER.test(h.name)) return null;
    if (
      h.name.toLowerCase() === "content-type" &&
      h.value.split(";")[0]!.trim().toLowerCase() !== upload.contentType
    )
      return null;
    out[h.name] = h.value;
  }
  return out;
}

export interface PutUploadOptions {
  operations: readonly AscUploadOperation[];
  /** What the upload carries, from the blob store's record (never from a request). */
  upload: UploadDescriptor;
  /** The bytes `[offset, offset + length)` of the file. */
  read: (offset: number, length: number) => Promise<ArrayBuffer>;
  /** Late-bound to the global `fetch` by default. */
  fetchImpl?: FetchImpl;
}

/**
 * Send every operation's bytes. Every operation is gated before the first byte is read, so a
 * refused one sends nothing at all. Throws `AscWriteDenied` (refused) or `AscError` (Apple's
 * answer, or a part of the wrong length).
 */
export async function putUploadOperations(o: PutUploadOptions): Promise<void> {
  const fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const plan: { op: AscUploadOperation; headers: Record<string, string> }[] =
    [];
  for (const op of o.operations) {
    checkAscUpload(op.method, op.url, o.upload);
    const headers = operationHeaders(op, o.upload);
    if (!headers)
      throw new AscWriteDenied("PUT", "upload operation", "invalid_body");
    plan.push({ op, headers });
  }
  for (const { op, headers } of plan) {
    const bytes = await o.read(op.offset, op.length);
    if (bytes.byteLength !== op.length)
      throw new AscError(502, "PUT", "upload operation");
    const res = await fetchImpl(op.url, {
      method: "PUT",
      redirect: "manual",
      headers,
      body: bytes,
    });
    await res.body?.cancel().catch(() => undefined);
    if (isRedirect(res) || !res.ok)
      throw new AscError(res.status || 502, "PUT", "upload operation");
  }
}
