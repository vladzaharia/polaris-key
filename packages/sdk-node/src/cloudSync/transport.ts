// The Cloud Sync host's transport (U-06.2): one bearer HTTP exchange per request the machine
// queued. It sends only what the machine produced, only to the product's own `/sync` routes, with
// the SDK's `X-PKey-*` headers and the device bearer. The host adds no request of its own
// (plan S3). Any failure to get an answer is `{ error: "transport" }`, which the machine reads as
// "nothing was processed" and retries on its next trigger.

import type {
  SyncRequest,
  SyncResponse,
} from "@polaris-key/client-core/cloud-sync";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";

/** The most response bytes the host reads (the contract's pull page is far smaller). */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const TRANSPORT: SyncResponse = { error: "transport" };

/** Whether `path` is one of the machine's two routes for `product` (a pull or a push). */
export function isSyncPath(product: string, path: string): boolean {
  const base = `/${product}/sync`;
  if (path === `${base}/ops`) return true;
  if (!path.startsWith(`${base}?`)) return false;
  return /^[A-Za-z0-9_=&.%-]*$/.test(path.slice(base.length + 1));
}

export async function sendSync(
  ctx: CoreContext,
  tokens: TokenManager,
  req: SyncRequest,
): Promise<SyncResponse> {
  const token = tokens.current;
  if (!token || !isSyncPath(ctx.product, req.path)) return TRANSPORT;
  const headers = ctx.headers({
    authorization: `Bearer ${token}`,
    accept: "application/json",
  });
  const init: RequestInit = { method: req.method, headers };
  if (req.method === "POST") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }
  try {
    const res = await ctx.request(`${ctx.baseUrl}${req.path}`, init, "sync");
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return TRANSPORT;
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
  }
}
