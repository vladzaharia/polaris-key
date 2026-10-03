/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";
import { D1Db } from "./db/d1.js";
import { dispatch } from "./dispatch.js";
import { secureResponse } from "./securityHeaders.js";
import { handleScheduled } from "./scheduled.js";

export { RateLimitDO } from "./rateLimitDo.js";
export { UpdateHealthDO } from "./updateHealthDo.js";

/**
 * P4-18: the payload URL sends bytes that are ALREADY encoded (the stored zstd frame, or a dcz
 * stream), so the runtime must send them as they are rather than encode the body for the
 * `Content-Encoding` it sees. `encodeBody: "manual"` says so; the layers between the handler and
 * here rebuild the response and drop it, so it is set once, at the edge, for exactly those two
 * codings (nothing else here sets either).
 */
export function preEncoded(res: Response): Response {
  const coding = (res.headers.get("content-encoding") ?? "")
    .trim()
    .toLowerCase();
  if (coding !== "zstd" && coding !== "dcz") return res;
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    encodeBody: "manual",
  });
}

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    // R1-09: EVERY response leaving this worker goes through `secureResponse`, which adds
    // HSTS and — for any `text/html` body that did not set its own policy — the strict
    // script-free CSP. Handlers that set a policy themselves (the SPA shells) keep it. This
    // makes "there is no CSP-less HTML on this origin" a property of the dispatcher rather
    // than something each handler has to remember, and it is what currently covers the two
    // identity OIDC pages (device-authorization + "you're signed in"), which set no headers of
    // their own.
    // `ctx` lets a handler answer first and finish afterwards (P5-02: a store webhook's
    // follow-up API read), through `ServiceContext.waitUntil`.
    return preEncoded(
      secureResponse(await dispatch(req, env, new D1Db(env.DB), ctx)),
    );
  },

  /**
   * R11-09 / R12-10: for the whole life of this worker there was no `scheduled()` export, so
   * `audit`, `portal_audit` and `release_download_tokens` had no deleter, dormant device seats
   * were reclaimed only as a side effect of somebody else's activation, and the indexes the
   * security invariants rest on were checked by no running code. The schedule lives in
   * `wrangler.toml`'s `[triggers]` block; the work lives in `scheduled.ts`.
   *
   * `await`ed rather than handed to `ctx.waitUntil`: both keep the isolate alive for the sweep,
   * but only the awaited promise's rejection is the handler's own outcome, so a failed step (see
   * `handleScheduled`, which rethrows one aggregate) is recorded as a failed cron invocation
   * instead of arriving as a detached unhandled rejection.
   */
  async scheduled(
    event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Two crons (P5-02): the nightly maintenance sweep and the 15-minute store-connector poll.
    // `handleScheduled` dispatches on `event.cron`; anything that is not the connector cron is
    // the sweep, so a trigger added without code still runs maintenance, never a poll.
    await handleScheduled(env, undefined, event.cron);
  },
} satisfies ExportedHandler<Env>;
