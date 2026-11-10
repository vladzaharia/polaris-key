/// <reference types="@cloudflare/workers-types" />

// `GET /signout` (I-21.12; V5 §12.13.9): the address `end-session` hands the browser, where Polaris
// Locker asks "Sign out of Polaris Locker too?". Like `/signin?request=`, it has two shapes:
//
//   - `?request=eo_…&bind=<token>` on the customer host: the bind hop (`signInBind.ts`, kind
//     `signout`). The token is redeemed once, the browser gets its `__Host-pk_req` binder, and the
//     303 goes to `/signout?request=<handle from the store>`: nothing in the query reaches the
//     `Location`. Any failure is the plain not-found an unknown handle gets.
//   - `?request=eo_…` for a browser that holds the binder: the dispatcher serves the portal shell
//     (`dispatch.ts`); the SPA reads the handle and the same-origin JSON routes answer only that
//     browser (`services/identity/issuer/signout.ts`). Any other visit is the not-found.

import { REQUEST_HANDLE_TTL_SECONDS } from "@polaris-key/protocol/identity";
import type { Env } from "../platform/env.js";
import { notFound } from "./errors.js";
import { binderCookie, consumeBindToken } from "./signInBind.js";

/** The hop itself; the caller only offers it on the customer host. */
export async function handleSignOutBind(
  req: Request,
  env: Env,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const handle = q.get("request") ?? "";
  const bind = q.get("bind");
  const bound = bind ? await consumeBindToken(env, bind) : null;
  // The token names its own handle: a token for another request is as good as none.
  if (!bound || bound.kind !== "signout" || bound.handle !== handle)
    return notFound();
  return new Response(null, {
    status: 303,
    headers: {
      location: `/signout?request=${bound.handle}`,
      "set-cookie": binderCookie(bound.binder, REQUEST_HANDLE_TTL_SECONDS),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
