// Reading `account_required` off a key-ring or file answer (WIRE-CONTRACT-V5 §11.5). Those routes
// are not the machine's, so the host's wiring watches their answers and tells Cloud Sync.
import { fromWorkerOrigin } from "../../core/signInUrl.js";

/** The most of an error body that is read to look for the code. */
const MAX_BYTES = 16 * 1024;

/**
 * `undefined` unless `res` is a 403 `account_required`; then the answer's `signInUrl` (unvetted),
 * or null when it names none. Reads a clone, so the caller still has the body.
 */
export async function accountRequiredUrl(
  res: Response,
): Promise<string | null | undefined> {
  if (res.status !== 403) return undefined;
  let text: string;
  try {
    text = await res.clone().text();
  } catch {
    return undefined;
  }
  if (text.length > MAX_BYTES) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const o = (x: unknown): Record<string, unknown> | null =>
    typeof x === "object" && x !== null && !Array.isArray(x)
      ? (x as Record<string, unknown>)
      : null;
  const body = o(v);
  const nested = o(body?.["error"]);
  const code =
    typeof body?.["error"] === "string" ? body["error"] : nested?.["code"];
  if (code !== "account_required") return undefined;
  const url = nested?.["signInUrl"] ?? body?.["signInUrl"];
  return typeof url === "string" ? url : null;
}

/**
 * `request` whose 403 is the Worker's own: a 403 that was redirected, is opaque or ended on another
 * origin loses its body, so `account_required` (or any other code) cannot be read from it; it is an
 * ordinary 403. Anything else passes through unchanged.
 */
export function workerOnly<A extends unknown[]>(
  request: (...args: A) => Promise<Response>,
  origin: string | undefined,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    const res = await request(...args);
    if (res.status !== 403 || fromWorkerOrigin(res, origin)) return res;
    await res.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 403 });
  };
}

/**
 * `request` that tells `onAccountRequired` about an `account_required` answer before returning it,
 * with the person signed in when the call started (`subject`, read before the call goes out). Only
 * the Worker's own answer counts (`workerOnly`).
 */
export function watchingAccountRequired<A extends unknown[]>(
  request: (...args: A) => Promise<Response>,
  onAccountRequired:
    | ((signInUrl: string | null, forSubject: string | null) => void)
    | undefined,
  opts: { origin: string | undefined; subject: () => string | null },
): (...args: A) => Promise<Response> {
  const trusted = workerOnly(request, opts.origin);
  if (onAccountRequired === undefined) return trusted;
  return async (...args) => {
    const forSubject = opts.subject();
    const res = await trusted(...args);
    const url = await accountRequiredUrl(res);
    if (url !== undefined) onAccountRequired(url, forSubject);
    return res;
  };
}
