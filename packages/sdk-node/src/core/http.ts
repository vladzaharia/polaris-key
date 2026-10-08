// The one error taxonomy every Node network call reports in (SP-46).
//
//   no answer (DNS, refused, reset, the deadline)   network-error          cause chained
//   429                                             rate_limited           retryAfterSeconds
//   5xx                                             server-error           status, wireCode
//   any other non-2xx                               the server's own code, else the status's
//                                                   registry code (404 → not_found, 401 →
//                                                   unauthorized, 403 → forbidden, …)
//   2xx with a body the call cannot read            bad_response
//
// The server's message, when its body carries one, is the error's message: the code is for
// branching, the message for a log. Thrown calls throw `PolarisError` with those fields; the
// calls that answer a result instead (activation, registration, commerce, sync, discovery) put
// the same code in the result. The signed-document status ladder (§5: 401, 403 blocked, 429
// device cap) stays in `CoreContext.getDocument`; this module covers what is left after it.

import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";

/** Whole seconds from a `Retry-After` header: delay-seconds or an HTTP date, never negative.
 *  Undefined when the header is absent or unreadable. */
export function retryAfterSeconds(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const text = header.trim();
  if (text === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text));
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** The code and message a Worker error body names, read from the flat (`{"error":"code",
 *  "message":…}`) and the nested (`{"error":{"code":…,"message":…}}`) shapes alike. A body that
 *  is not JSON names no code, and its text, when there is any, is the message. */
export interface ErrorBody {
  code?: string;
  message?: string;
  /** The parsed body, `{}` when it was not a JSON object. */
  body: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

export function parseErrorBody(text: string): ErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const message = text.trim();
    return { ...(message !== "" ? { message } : {}), body: {} };
  }
  if (!isRecord(parsed)) return { body: {} };
  const nested = isRecord(parsed.error) ? parsed.error : undefined;
  const code = nonEmpty(parsed.error) ?? nonEmpty(nested?.code);
  const message = nonEmpty(nested?.message) ?? nonEmpty(parsed.message);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    body: parsed,
  };
}

/** The registry code a non-2xx answer without a code of its own is reported under. */
export function codeForStatus(status: number): string {
  if (status === 429) return ErrorCode.rateLimited;
  if (status >= 500) return ErrorCode.serverError;
  switch (status) {
    case 400:
      return ErrorCode.badRequest;
    case 401:
      return ErrorCode.unauthorized;
    case 403:
      return ErrorCode.forbidden;
    case 404:
      return ErrorCode.notFound;
    case 405:
      return ErrorCode.methodNotAllowed;
    case 413:
      return ErrorCode.bodyTooLarge;
    default:
      return ErrorCode.httpError;
  }
}

/** One non-2xx answer, classified: the code a caller branches on and the fields beside it. */
export interface Classified {
  code: string;
  status: number;
  message?: string;
  retryAfterSeconds?: number;
  /** The server's code, when `code` is the SDK's class for the answer and differs from it. */
  wireCode?: string;
  body: Record<string, unknown>;
}

/**
 * Classify a non-2xx answer. `fallback` replaces the status's registry code for a 4xx that names
 * no code of its own (identity's documented `sign-in-unavailable`); 429 and 5xx always take
 * their class.
 */
export function classify(
  status: number,
  text: string,
  retryAfter: string | null,
  fallback?: string,
): Classified {
  const parsed = parseErrorBody(text);
  const seconds = retryAfterSeconds(retryAfter);
  const cls =
    status === 429 || status >= 500
      ? codeForStatus(status)
      : (parsed.code ?? fallback ?? codeForStatus(status));
  return {
    code: cls,
    status,
    ...(parsed.message !== undefined ? { message: parsed.message } : {}),
    ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
    ...(parsed.code !== undefined && parsed.code !== cls
      ? { wireCode: parsed.code }
      : {}),
    body: parsed.body,
  };
}

/** `classify` over a `Response`, reading its body once (a body that cannot be read is empty). */
export async function classifyResponse(
  res: Response,
  fallback?: string,
): Promise<Classified> {
  const text = await res.text().catch(() => "");
  return classify(res.status, text, res.headers.get("retry-after"), fallback);
}

/** A classified answer as the `PolarisError` a thrown call raises. `what` names the call for the
 *  message used when the server sent none. */
export function errorFrom(c: Classified, what: string): PolarisError {
  return new PolarisError(
    c.code,
    c.message ?? `${what} failed with status ${c.status}.`,
    {
      status: c.status,
      ...(c.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: c.retryAfterSeconds }
        : {}),
      ...(c.wireCode !== undefined ? { wireCode: c.wireCode } : {}),
    },
  );
}

/** The `PolarisError` for a non-2xx `Response`. */
export async function responseError(
  res: Response,
  what: string,
  fallback?: string,
): Promise<PolarisError> {
  return errorFrom(await classifyResponse(res, fallback), what);
}

/** A request that got no answer, as `network-error` with the failure chained. A local-only
 *  refusal or an error that already is a `PolarisError` passes through untouched. */
export function transportError(e: unknown, what: string): PolarisError {
  if (e instanceof PolarisError) return e;
  const detail = e instanceof Error && e.message ? `: ${e.message}` : "";
  return new PolarisError(
    ErrorCode.networkError,
    `${what} got no answer${detail}`,
    {
      cause: e,
    },
  );
}

/** Read a 2xx body as JSON: `bad_response` when it is not JSON, `network-error` when the body
 *  could not be read to its end. */
export async function readJson<T = unknown>(
  res: Response,
  what: string,
): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw transportError(e, what);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PolarisError(
      ErrorCode.badResponse,
      `${what} answered with a body that is not JSON.`,
      { status: res.status },
    );
  }
}
