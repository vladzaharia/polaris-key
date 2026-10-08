/**
 * The one S3 operation `pkey release publish` performs: a single-part `PutObject` of one staged
 * file into R2 with the upload ticket's temporary credentials (P2-02), signed with AWS
 * Signature Version 4 over `node:crypto` (no new dependency).
 *
 * ── WHAT THE PUT CARRIES ────────────────────────────────────────────────────────────────────
 *
 *   x-amz-content-sha256   the file's SHA-256 in hex — the signed payload hash. pkey has already
 *                          streamed the file once to compute it, so the PUT is fully signed and
 *                          the body can still be streamed (no second in-memory copy).
 *   x-amz-checksum-sha256  the same digest in base64. R2 checks it against the bytes it receives
 *                          and REFUSES a mismatch, and stores it — which is what lets the Worker's
 *                          `verifyStaged` trust the staged object without reading it.
 *   x-amz-security-token   the ticket's session token (temporary credentials).
 *   content-length         the exact size: R2 refuses chunked uploads without one.
 *
 * Multipart is not granted to the ticket (a multipart object's checksum is not the whole file's
 * SHA-256), so one object is one PUT, at most 5 GiB less 5 MiB.
 *
 * ── RETRIES ─────────────────────────────────────────────────────────────────────────────────
 *
 * A PUT of content-addressed bytes to a key named by those bytes is idempotent, so transient
 * failures ARE retried here: a dropped connection, 408, 429 and 5xx. Every other status is final
 * (403: the credentials expired or the key is outside the ticket's prefix; 400 BadDigest: the
 * file changed on disk since it was hashed).
 */

import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  BASE_BACKOFF_MS,
  MAX_ATTEMPTS,
  defaultSleep,
  type Out,
  type Sleep,
} from "./ci.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";

/** R2's single-part PutObject ceiling, as the Worker enforces it on a ticket (5 GiB − 5 MiB). */
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;

export interface S3Credentials {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: URL;
  /** Every header to sign, lower-case names. `host` is added from `url` when absent. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the payload (or `UNSIGNED-PAYLOAD`). */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** RFC 3986 percent-encoding of one path segment (what SigV4's canonical URI requires). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `YYYYMMDDTHHMMSSZ` for `date`. */
export function amzDateOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * The SigV4 `Authorization` header for a request with no query string (S3's canonical URI is
 * the path, each segment encoded once). Exported for the published-vector test.
 */
export function signV4(input: SignInput): string {
  const headers: Record<string, string> = { ...input.headers };
  if (headers.host === undefined) headers.host = input.url.host;
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const canonicalHeaders = names
    .map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalUri =
    input.url.pathname
      .split("/")
      .map((s) => encodeSegment(decodeURIComponent(s)))
      .join("/") || "/";
  const canonicalRequest = [
    input.method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** The path-style object URL: `<endpoint>/<bucket>/<key>`, each key segment encoded. */
export function objectUrl(creds: S3Credentials, key: string): URL {
  const base = creds.endpoint.replace(/\/+$/, "");
  const path = [creds.bucket, ...key.split("/")].map(encodeSegment).join("/");
  return new URL(`${base}/${path}`);
}

export interface PutFileOptions {
  creds: S3Credentials;
  key: string;
  /** The file to stream. */
  file: string;
  size: number;
  /** Lower-case hex SHA-256 of the file (already computed while hashing). */
  sha256: string;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  maxAttempts?: number;
  log?: Out;
  /** The job's environment, for `untrusted()`: the store's answer is quoted in the retry line. */
  env?: UntrustedEnv;
  /** Clock seam for the signature date. */
  now?: () => Date;
}

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

/** PUT one file, streamed, with retries on transient failures. */
export async function putFile(opts: PutFileOptions): Promise<void> {
  if (opts.size > MAX_SINGLE_PUT_BYTES)
    throw new Error(
      `${opts.file} is ${opts.size} bytes, over the ${MAX_SINGLE_PUT_BYTES}-byte single-PUT limit.`,
    );
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const url = objectUrl(opts.creds, opts.key);
  const checksum = Buffer.from(opts.sha256, "hex").toString("base64");
  for (let attempt = 1; ; attempt++) {
    const amzDate = amzDateOf((opts.now ?? (() => new Date()))());
    const headers: Record<string, string> = {
      "content-length": String(opts.size),
      "x-amz-checksum-sha256": checksum,
      "x-amz-content-sha256": opts.sha256,
      "x-amz-date": amzDate,
      ...(opts.creds.sessionToken
        ? { "x-amz-security-token": opts.creds.sessionToken }
        : {}),
    };
    const authorization = signV4({
      method: "PUT",
      url,
      headers,
      payloadHash: opts.sha256,
      accessKeyId: opts.creds.accessKeyId,
      secretAccessKey: opts.creds.secretAccessKey,
      region: "auto",
      service: "s3",
      amzDate,
    });
    let failure = "";
    let res: Response | null = null;
    try {
      res = await f(url, {
        method: "PUT",
        headers: { ...headers, authorization },
        // A fresh stream per attempt: a consumed stream cannot be resent.
        body: Readable.toWeb(createReadStream(opts.file)) as ReadableStream,
        duplex: "half",
      } as RequestInit);
    } catch (e) {
      failure = (e as Error).message;
    }
    if (res) {
      if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return;
      }
      const text = (await res.text().catch(() => "")).slice(0, 300);
      failure = `${res.status}${text ? ` ${text.replace(/\s+/g, " ")}` : ""}`;
      if (!TRANSIENT.has(res.status))
        throw new Error(
          `Uploading ${opts.file} to ${opts.key} failed: ${failure}`,
        );
    }
    if (attempt >= maxAttempts)
      throw new Error(
        `Uploading ${opts.file} to ${opts.key} failed after ${maxAttempts} attempts: ${failure}`,
      );
    const wait = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    // The key came in the ticket and the failure is the store's own text: both cleaned.
    opts.log?.write(
      `Uploading ${untrusted(opts.key, opts.env ?? {})}: ${untrusted(failure, opts.env ?? {})}; retrying (attempt ${attempt + 1} of ${maxAttempts})\n`,
    );
    await sleep(wait);
  }
}
