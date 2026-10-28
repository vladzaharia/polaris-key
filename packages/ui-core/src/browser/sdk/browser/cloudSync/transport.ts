// The browser Cloud Sync host's transport (U-20.2), as sdk-node's: one bearer HTTP exchange per
// request the machine queued, to the product's own `/sync` routes only, with the SDK's `X-PKey-*`
// headers and the device bearer (the I-08 redirect token or any device token; never a cookie).
// The host adds no request of its own (plan S3). Any failure to get an answer is
// `{ error: "transport" }`, which the machine reads as "nothing was processed".

import type {
  SyncRequest,
  SyncResponse,
} from "@polaris-key/client-core/cloud-sync";
import { MAX_BODY_BYTES, readCappedText } from "../boundedBody.js";

export const MAX_RESPONSE_BYTES = MAX_BODY_BYTES;

const TRANSPORT: SyncResponse = { error: "transport" };

/** How long one exchange may take before it counts as no answer. */
export const SYNC_REQUEST_MS = 15_000;

/** One authenticated request under `/<product>/` (`BearerSession.ringRequest`); the path is
 *  relative to the product. */
export type ProductRequest = (
  path: string,
  init: { method: string; body?: string; keepalive?: boolean },
) => Promise<Response>;

/** Whether `path` is one of the machine's two routes for `product` (a pull or a push). */
export function isSyncPath(product: string, path: string): boolean {
  const base = `/${product}/sync`;
  if (path === `${base}/ops`) return true;
  if (!path.startsWith(`${base}?`)) return false;
  return /^[A-Za-z0-9_=&.%-]*$/.test(path.slice(base.length + 1));
}

export async function sendSync(
  product: string,
  request: ProductRequest,
  req: SyncRequest,
  keepalive = false,
  timeoutMs = SYNC_REQUEST_MS,
): Promise<SyncResponse> {
  if (!isSyncPath(product, req.path)) return TRANSPORT;
  const rel = req.path.slice(product.length + 2);
  let cut: ReturnType<typeof setTimeout> | undefined;
  try {
    // A request that never answers is no answer: a hung one must not hold a sign-out (S-2).
    const timeout = new Promise<null>((resolve) => {
      cut = setTimeout(() => resolve(null), timeoutMs);
    });
    const res = await Promise.race([
      request(rel, {
        method: req.method,
        ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}),
        ...(keepalive ? { keepalive: true } : {}),
      }),
      timeout,
    ]);
    if (res === null) return TRANSPORT;
    const text = await Promise.race([
      readCappedText(res, MAX_RESPONSE_BYTES),
      timeout,
    ]);
    if (text === null) return TRANSPORT;
    if (text === "") return { status: res.status };
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      // A 2xx the machine cannot read is not an answer; an error page keeps its status.
      return res.status >= 200 && res.status < 300
        ? TRANSPORT
        : { status: res.status };
    }
  } catch {
    return TRANSPORT;
  } finally {
    clearTimeout(cut);
  }
}
