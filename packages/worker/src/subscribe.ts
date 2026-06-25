/// <reference types="@cloudflare/workers-types" />

// Hot-reload: authenticate the bearer token, resolve the license, and forward the
// WebSocket upgrade to the per-(product, license) HubDO shard. Admin writes call
// notifyHub() to broadcast a contentless `config-changed` signal.

import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { bearer, errorResponse } from "./http.js";
import { validateMachineToken } from "./licenseCore.js";

function hubStub(
  env: Env,
  product: string,
  licenseId: string,
): DurableObjectStub {
  const id = env.HUB.idFromName(`p:${product}:${licenseId}`);
  return env.HUB.get(id);
}

/** GET (WebSocket) /<product>/config/subscribe — upgrade + forward to the license's hub. */
export async function handleSubscribe(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const token = bearer(req) ?? req.headers.get("sec-websocket-protocol");
  if (!token) return errorResponse(401, "unauthorized");
  const valid = await validateMachineToken(env, db, product, token, now);
  if ("error" in valid) return errorResponse(401, "unauthorized");
  return hubStub(env, product.slug, valid.license.id).fetch(req);
}

/** Broadcast a config-changed signal to all live subscribers of a license. */
export async function notifyHub(
  env: Env,
  product: string,
  licenseId: string,
): Promise<void> {
  try {
    await hubStub(env, product, licenseId).fetch(
      new Request("https://hub.internal/notify"),
    );
  } catch {
    // best-effort: a dropped notify just means the client picks up the change on next poll.
  }
}
