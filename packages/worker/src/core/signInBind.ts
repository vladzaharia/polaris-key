/// <reference types="@cloudflare/workers-types" />

// The bind hop (LK-04, plans/LK-00.md §7.8). With the customer host on, `authorize` runs on the API
// host but the sign-in card lives on the customer host, and `__Host-` cookies are host-only. So
// `authorize` sets no cookie: it stores a request handle bound to a fresh binder and a single-use
// BIND TOKEN (32 random bytes, 120 s), and 303s to `<customer>/signin?request=rq_…&bind=<token>`.
// The customer host consumes the token atomically, sets `__Host-pk_req` itself, and 303s to
// `/signin?request=rq_…`.
//
//   - The token is the address of an artefact (its peppered hash), never a binder: the binder is
//     a second random value that only ever travels in the artefact and the `Set-Cookie`.
//   - The `Location` after the hop is built from the stored handle, never from the query: no
//     request-supplied host or path reaches it (open redirect).
//   - A bind URL is worth what the `authorize` URL is worth: whoever opens it binds their browser
//     to that request. It works once, for 120 s, and holds neither `state`, the challenge nor the
//     redirect URI (R1-07).

import { REQUEST_HANDLE_PATTERN } from "@polaris-key/protocol/identity";
import { hashKey } from "../platform/crypto.js";
import type { Env } from "../platform/env.js";
import { randomToken } from "../platform/random.js";
import { artefactRef, consumeArtefact, putArtefact } from "./singleUse.js";

export const BIND_TTL_SECONDS = 120;

/** 32 random bytes, base64url. */
export const BIND_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The binder cookie (§12.7.2). `__Host-` pins it to this origin, `Path=/` and `Secure`. */
export const REQUEST_BINDER_COOKIE = "__Host-pk_req";

/** The `Set-Cookie` value that hands a browser its binder. */
export function binderCookie(binder: string, maxAgeSeconds: number): string {
  return `${REQUEST_BINDER_COOKIE}=${binder}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

const HANDLE_RE = new RegExp(REQUEST_HANDLE_PATTERN);

async function bindRef(env: Env, token: string) {
  return artefactRef("signin-bind", await hashKey(token, env.KEY_HASH_PEPPER));
}

/**
 * What a token carries. `request`: the card's binder, redeemed on the customer host. `device`:
 * the device-code flow's binder and the IdP address to continue to, redeemed on the API host (the
 * IdP calls back there, so the flow's cookie must live there; LK-04). `to` is a value this Worker
 * stored itself, never one a request supplied.
 */
export type BindPayload =
  | { kind: "request"; handle: string; binder: string }
  | { kind: "device"; binder: string; to: string };

/** Store a bind token, to be redeemed once. */
export async function issueBindToken(
  env: Env,
  payload: BindPayload,
): Promise<string> {
  const token = randomToken(32);
  await putArtefact(
    env,
    await bindRef(env, token),
    JSON.stringify(payload),
    BIND_TTL_SECONDS,
  );
  return token;
}

/** Redeem a token: one atomic consume. `null` when it is malformed, unknown, used or expired. */
export async function consumeBindToken(
  env: Env,
  token: string,
): Promise<BindPayload | null> {
  if (!BIND_TOKEN_PATTERN.test(token)) return null;
  const raw = await consumeArtefact(env, await bindRef(env, token));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.binder !== "string" || !BIND_TOKEN_PATTERN.test(v.binder))
      return null;
    if (
      v.kind === "request" &&
      typeof v.handle === "string" &&
      HANDLE_RE.test(v.handle)
    )
      return { kind: "request", handle: v.handle, binder: v.binder };
    if (v.kind === "device" && typeof v.to === "string")
      return { kind: "device", binder: v.binder, to: v.to };
  } catch {
    /* fall through */
  }
  return null;
}
