// Reading `account_required` off a key-ring or file answer (WIRE-CONTRACT-V5 §11.5). Those routes
// are not the machine's, so the host's wiring watches their answers and tells Cloud Sync.

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

/** `request` that tells `onAccountRequired` about an `account_required` answer before returning it. */
export function watchingAccountRequired<A extends unknown[]>(
  request: (...args: A) => Promise<Response>,
  onAccountRequired: ((signInUrl: string | null) => void) | undefined,
): (...args: A) => Promise<Response> {
  if (onAccountRequired === undefined) return request;
  return async (...args) => {
    const res = await request(...args);
    const url = await accountRequiredUrl(res);
    if (url !== undefined) onAccountRequired(url);
    return res;
  };
}
