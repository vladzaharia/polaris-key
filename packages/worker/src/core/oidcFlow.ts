/// <reference types="@cloudflare/workers-types" />

/**
 * Browser binding for an in-flight OIDC sign-in (A3-06).
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────────────────────
 *
 * None of the three redirect realms — product (`services/identity/oidc.ts`), customer portal
 * (`services/identity/portal/auth.ts`) and admin console (`admin/auth.ts`) — recorded ANYTHING
 * about the browser that started a flow. The flow record was therefore a bearer credential
 * keyed on `state`, and `state` travels in the clear on two URLs. An attacker starts a flow in
 * their own browser, completes the IdP leg under their own account, and hands the resulting
 * `…/callback?code=…&state=…` URL to a victim: the victim's browser presents it, the worker
 * finds the flow, and the victim is issued a session cookie for the ATTACKER's identity. That
 * is login CSRF / session fixation, and on the product realm it also silently binds the
 * victim's browser device row to the attacker's licence.
 *
 * ── THE BINDING ─────────────────────────────────────────────────────────────────────────────
 *
 * The start handler mints an opaque `flowId`, stores only `hashKey(flowId, pepper)` in the KV
 * flow record, and sets `flowId` as a `__Host-` cookie alongside the 302. The callback demands a
 * cookie that hashes to the stored value. The attacker can copy `state`, because `state` is on
 * the wire — they cannot put a cookie into the victim's browser for this origin, which is
 * precisely what `__Host-` guarantees (`Secure`, no `Domain`, `Path=/`, so not even a sibling
 * subdomain may write it).
 *
 * `SameSite=Lax` rather than `Strict`: the callback arrives as a top-level cross-site
 * navigation FROM THE IdP, and a `Strict` cookie is not sent on that navigation at all — the
 * binding would refuse every genuine sign-in. `Lax` is sent on exactly this shape and withheld
 * from the sub-resource shapes that make CSRF cheap.
 *
 * ── WHAT IS DELIBERATELY NOT BOUND ──────────────────────────────────────────────────────────
 *
 * The device-code / loopback flow is legitimately cross-browser: a CLI on one machine prints a
 * URL a human may open anywhere, including on their phone. Those flows carry no binding and are
 * not checked for one; they are protected instead by the device binding and the human
 * confirmation `pollAuthFlow` enforces (R8-01). The rule at the callback is therefore "a flow
 * that will end in a `Set-Cookie` MUST be bound", which is `requireFlowBinding` below.
 */

import type { Env } from "../env.js";
import { hashKey, mintOpaqueToken } from "../crypto.js";
import { readSingleCookie } from "../http.js";

/**
 * The binding cookie, shared by all three realms.
 *
 * `__Host-` is the entire point (see above), and it is why the name is not per-realm scoped by
 * `Path`: a `__Host-` cookie must be `Path=/`. One name is also correct on the merits — a
 * browser has at most one sign-in in flight, and a value minted for one realm is useless in
 * another, since the callback still has to find a flow record whose stored hash matches.
 */
export const FLOW_COOKIE = "__Host-pkey_flow";

/** Matches the KV `expirationTtl` every realm already uses for a flow record. */
export const FLOW_COOKIE_MAX_AGE = 600;

const FLOW_COOKIE_ATTRS = ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"];

export interface FlowBinding {
  /** Goes in the cookie, never into KV. */
  flowId: string;
  /** Goes into the KV flow record, never to the browser. */
  hash: string;
  /** The `Set-Cookie` value to send with the 302. */
  cookie: string;
}

/** Mint a fresh browser binding for a flow that is about to be stored. */
export async function mintFlowBinding(env: Env): Promise<FlowBinding> {
  const flowId = mintOpaqueToken();
  return {
    flowId,
    hash: await hashKey(flowId, env.KEY_HASH_PEPPER),
    cookie: [
      `${FLOW_COOKIE}=${flowId}`,
      ...FLOW_COOKIE_ATTRS,
      `Max-Age=${FLOW_COOKIE_MAX_AGE}`,
    ].join("; "),
  };
}

/** Clear the binding once a flow has been consumed. Attributes must match the mint, or the
 *  browser keeps the old value. */
export function clearFlowCookie(): string {
  return [`${FLOW_COOKIE}=`, ...FLOW_COOKIE_ATTRS, "Max-Age=0"].join("; ");
}

/**
 * Does this request carry the binding cookie for `expectedHash`?
 *
 * Fails CLOSED on every ambiguity: no cookie, a duplicate cookie with two different values
 * (`readSingleCookie` — the sibling-subdomain shadow of R1-08), and — critically — a flow record
 * that carries NO hash at all. The last one is what stops "the fix does not apply to records
 * written before the deploy" from becoming "the fix can be skipped by omitting a field".
 */
export async function flowBindingMatches(
  req: Request,
  env: Env,
  expectedHash: string | undefined | null,
): Promise<boolean> {
  if (!expectedHash) return false;
  const presented = readSingleCookie(req.headers.get("cookie"), FLOW_COOKIE);
  if (!presented) return false;
  const hash = await hashKey(presented, env.KEY_HASH_PEPPER);
  return hash === expectedHash;
}

/**
 * Parse a stored flow record, treating a corrupt value exactly like a missing one (R11-06).
 *
 * Every caller already has a well-defined answer for "this flow does not exist" — `expired`,
 * `unknown state`, `timeout`. A truncated or garbled KV value is indistinguishable from that
 * for every purpose the handler has, so it should take the same branch rather than escape as an
 * uncaught `SyntaxError` and 500 a sign-in path.
 *
 * This lives HERE, next to the binding, because A3-08 found the same three realms diverging
 * again: the product realm had this guard and the portal's OIDC-flow and magic-link readers and
 * the admin realm's flow reader each still called bare `JSON.parse`. A convention that only one
 * of three realms follows is not a convention, so the function moved out of `oidc.ts` and all
 * three import it — the identical fix, and the identical reason, as `identity/idToken.ts`.
 *
 * The `typeof parsed === "object"` check is load-bearing and not decoration: `JSON.parse("2")`
 * and `JSON.parse("null")` both succeed, and a caller that then reads `.email` off the result
 * gets `undefined` from a value that never came from this system rather than a rejection.
 */
export function parseFlowRecord<T>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}
