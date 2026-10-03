// The browser's native payload transport (P4-18; notes/A7 §9.1, §9.3; RFC 9842): how the web
// runs a container's `full` and a planned `zstd-patch-from` payload delta without WASM.
//
//   full   `GET` the payload URL (`…/distribution/packs/<pack>/<variant>/payload/<sha256>`): the
//          Worker sends the stored frame with `Content-Encoding: zstd`, the browser decodes it
//          natively and, for an ungated payload of at most 100 MiB, keeps the decoded body as a
//          dictionary for that (pack, variant);
//   delta  `GET` the TARGET's payload URL with `?via=dcz`: when the browser still holds the base as
//          a dictionary it offers it (`Available-Dictionary`), and the Worker answers
//          `Content-Encoding: dcz`, the 40-byte header and the stored artifact, which the browser
//          applies natively. Without the dictionary (evicted, never fetched whole, Firefox,
//          Safari) the guard makes it `409` with no body, never a silent full download.
//
// Either way the bytes arrive DECODED. They are written to the plan's output (through the OPFS
// worker when the store has one, else through the engine's sink) and measured; client-core
// compares size and SHA-256 with the record, and on a decline or a failure runs the same
// candidate itself (the WASM decoder over the blob route), then the plan's remaining ones.

import {
  variantKey,
  type NativePayloadPort,
  type NativePayloadRequest,
  type Sha256Port,
} from "@polaris-key/client-core";

/** Chromium never offers a dictionary over 100 MiB (`kDictionarySizeLimit`), and the Worker never
 *  advertises one; a base above it is never asked for by dcz. */
export const MAX_DICTIONARY_BYTES = 100 * 1024 * 1024;

const BLOB_SUFFIX = "/distribution/blobs/sha256/{sha256}";

/**
 * The payload URL template, derived from discovery's `distribution.endpoints.blobs`: the payload
 * URL is the blob route's documented sibling on the same host
 * (`…/distribution/packs/{pack}/{variant}/payload/{sha256}`). Null when the blob template does
 * not end in the canonical blob path (an alias, a custom host layout): the transport then
 * declines and the SDK takes the blob route.
 */
export function payloadUrlTemplate(blobs: string | null): string | null {
  if (blobs === null || !blobs.endsWith(BLOB_SUFFIX)) return null;
  return `${blobs.slice(0, -BLOB_SUFFIX.length)}/distribution/packs/{pack}/{variant}/payload/{sha256}`;
}

/** The variant segment: the variant key (`axis=value;…`), or `default` for an unvaried pack. */
export function variantSegment(
  variant: Readonly<Record<string, string>>,
): string {
  return variantKey(variant) || "default";
}

/** What happened on one native attempt (`onNativePayload`), for a host's diagnostics. */
export interface NativePayloadEvent {
  packId: string;
  /** `zstd` for a whole payload, `dcz` for a delta. */
  kind: "zstd" | "dcz";
  /** `used`: the bytes came this way; `declined`: the server or the browser could not (the
   *  status says which); `failed`: the transfer broke or the body was too long. */
  outcome: "used" | "declined" | "failed";
  status?: number;
  error?: string;
  /** Decoded bytes written. */
  bytes?: number;
}

export interface BrowserNativePayloadOptions {
  /** The payload URL template (`payloadUrlTemplate`), resolved against `baseUrl`; null when
   *  discovery names none (each call), so the transport declines. */
  template: () => string | null;
  baseUrl: string;
  fetchImpl: typeof fetch;
  headers?: Record<string, string>;
  sha256: Sha256Port;
  /** The OPFS worker's `fetchInto` for the plan's output, when the store has a worker. */
  fetchIntoOutput?: (
    planId: string,
    url: string,
    init: { headers: Record<string, string> },
    limit: number,
    onBytes: (n: number) => void,
  ) => Promise<
    | { status: number; size?: number; sha256?: string; error?: string }
    | undefined
  >;
  onEvent?: (e: NativePayloadEvent) => void;
}

/** The URL for one request, or null when this transport does not run it. */
function urlFor(
  o: BrowserNativePayloadOptions,
  req: NativePayloadRequest,
): string | null {
  const t = o.template();
  if (t === null) return null;
  if (req.delta) {
    // A gated payload is never a dictionary (`private, no-store`), and Chromium never offers one
    // over 100 MiB: dcz cannot happen, so do not spend the request.
    if (req.gated || req.base === null || req.base.size > MAX_DICTIONARY_BYTES)
      return null;
    if (req.delta.method !== "zstd-patch-from") return null;
  }
  const path = t
    .split("{pack}")
    .join(encodeURIComponent(req.packId))
    .split("{variant}")
    .join(variantSegment(req.variant.variant))
    .split("{sha256}")
    .join(req.variant.payload.sha256);
  const url = new URL(path, `${o.baseUrl}/`);
  if (req.delta) url.searchParams.set("via", "dcz");
  return url.toString();
}

/** The browser's native payload transport, as client-core's `NativePayloadPort`. */
export function browserNativePayload(
  o: BrowserNativePayloadOptions,
): NativePayloadPort {
  return async (req) => {
    const url = urlFor(o, req);
    if (url === null) return null;
    const kind = req.delta ? "dcz" : "zstd";
    const limit = req.variant.payload.size;
    // The page sees decoded bytes only, so progress is the decoded fraction of the wire bytes
    // the plan counted (the artifact plus the 40-byte dcz header, or the stored frame).
    const wire = req.delta
      ? req.delta.artifact.bytes + 40
      : req.variant.full.bytes;
    const onBytes = (n: number) =>
      req.onBytes(limit > 0 ? Math.floor((n * wire) / limit) : 0);
    const headers = { ...(o.headers ?? {}) };
    const emit = (e: Omit<NativePayloadEvent, "packId" | "kind">) => {
      try {
        o.onEvent?.({ packId: req.packId, kind, ...e });
      } catch {
        // A listener never fails an install.
      }
    };

    if (o.fetchIntoOutput) {
      let r: Awaited<ReturnType<NonNullable<typeof o.fetchIntoOutput>>>;
      try {
        r = await o.fetchIntoOutput(
          req.planId,
          url,
          { headers },
          limit,
          onBytes,
        );
      } catch (e) {
        emit({ outcome: "failed", error: (e as Error).message });
        return { ok: false, error: "network-error" };
      }
      if (r === undefined) return null;
      if (r.status !== 200) {
        emit({ outcome: "declined", status: r.status });
        return null;
      }
      if (r.error !== undefined || r.size === undefined || !r.sha256) {
        emit({ outcome: "failed", status: 200, error: r.error ?? "unknown" });
        return { ok: false, error: r.error?.split(":")[0] ?? "network-error" };
      }
      emit({ outcome: "used", status: 200, bytes: r.size });
      return { ok: true, size: r.size, sha256: r.sha256 };
    }

    let res: Response;
    try {
      res = await o.fetchImpl(url, { credentials: "include", headers });
    } catch (e) {
      emit({ outcome: "failed", error: (e as Error).message });
      return { ok: false, error: "network-error" };
    }
    if (res.status !== 200 || res.body === null) {
      await res.body?.cancel().catch(() => undefined);
      emit({ outcome: "declined", status: res.status });
      return null;
    }
    const hasher = o.sha256();
    const reader = res.body.getReader();
    let at = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.byteLength > limit) {
          await reader.cancel().catch(() => undefined);
          emit({ outcome: "failed", status: 200, error: "too-large" });
          return { ok: false, error: "too-large" };
        }
        await req.sink.write(at, value);
        hasher.update(value);
        at += value.byteLength;
        onBytes(at);
      }
    } catch (e) {
      emit({ outcome: "failed", status: 200, error: (e as Error).message });
      return { ok: false, error: "network-error" };
    }
    const sha256 = await hasher.digest();
    emit({ outcome: "used", status: 200, bytes: at });
    return { ok: true, size: at, sha256 };
  };
}
