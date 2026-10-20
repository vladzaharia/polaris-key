/**
 * Passthrough sign-in request handles (WIRE-CONTRACT-V4 §12.7.2, plans/PX-W13.md §2.2; G28).
 *
 * The sign-in card shows "<App> wants you to sign in" and, on a device-code sign-in, the device's
 * label and the user code. None of that may come from a query parameter, so every app-initiated
 * sign-in that reaches the card carries one opaque handle instead: `rq_` and 16 random bytes in
 * base64url. The card reads the request back through `GET /api/signin/requests/:handle` and
 * nothing else.
 *
 * ── WHAT A HANDLE IS ────────────────────────────────────────────────────────────────────────
 *
 *   stored     in the single-use artefact store (`signin-request`), addressed by the handle's
 *              peppered hash, for `REQUEST_HANDLE_TTL_SECONDS` (600, the sign-in flow's own
 *              lifetime). A listing of the store yields nothing that can be presented.
 *   bound      to the browser that created it: a random binder lives in the `__Host-pk_req`
 *              cookie (HttpOnly, Secure, SameSite=Lax, Path=/) and its hash in the record. A
 *              browser without the binder gets `404 not_found`, exactly like an unknown handle.
 *              One browser keeps one binder for all its handles; I-08's callback binding
 *              (R1-07) reuses it instead of minting a second one.
 *   holds      the product, the client kind, the normalised device label, the user code, the
 *              origin and a reference to the flow. Nothing it holds is a credential: the device
 *              code and `state` stay in their own records.
 *
 * PX-W13 adds no public creation route. The device-code confirmation page creates handles
 * (`oidc.ts`); I-08's `authorize` creates them too, carrying the validated request in `authz`
 * (`authorize.ts`), and the I-13 and I-15 entries will. Continue and Cancel TAKE the record
 * (`takeSignInRequest`): one atomic consume, so a handle yields one code or one refusal.
 */

import {
  REQUEST_HANDLE_PATTERN,
  REQUEST_HANDLE_TTL_SECONDS,
  type ClientKind,
} from "@polaris-key/protocol/identity";
import { hashKey } from "../../../platform/crypto.js";
import { randomToken } from "../../../platform/random.js";
import type { Env } from "../../../platform/env.js";
import {
  REQUEST_BINDER_COOKIE,
  binderCookie as binderCookieOf,
  issueBindToken,
} from "../../../core/signInBind.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";

export { REQUEST_BINDER_COOKIE };

const HANDLE_RE = new RegExp(REQUEST_HANDLE_PATTERN);

/**
 * The validated `authorize` request a handle carries (WIRE-CONTRACT-V4 §12.4). Hints prefill the
 * card and verify nothing. `state` and the PKCE challenge live here, in the single-use store, and
 * come back only in the redirect to the registered URI.
 */
export interface AuthzRecord {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** The scope the app asked for, resolved against what the product grants. */
  scope: string[];
  nonce: string | null;
  licenseChoice: "card" | "app";
  purpose: "signin" | "attach";
  loginHint: string | null;
  nameHint: string | null;
}

/** What a handle's record holds. */
export interface SignInRequestRecord {
  product: string;
  kind: ClientKind;
  deviceLabel: string | null;
  userCode: string | null;
  origin: string | null;
  /** An opaque reference to the flow the request belongs to (the device flow's store id). */
  flowRef: string;
  /** The `authorize` request behind a web (or later native) sign-in; absent on a device-code request. */
  authz?: AuthzRecord;
  /** The binder's peppered hash. */
  binder: string;
  /** Epoch seconds. */
  expiresAt: number;
}

/** True for a string shaped like a handle. Anything else is never looked up. */
export function isRequestHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_RE.test(value);
}

async function requestRef(env: Env, handle: string): Promise<ArtefactRef> {
  return artefactRef(
    "signin-request",
    await hashKey(handle, env.KEY_HASH_PEPPER),
  );
}

/** The binder the request's browser already holds (one `__Host-pk_req`, else none). */
export function readBinder(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const values = new Set<string>();
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === REQUEST_BINDER_COOKIE) values.add(rest.join("="));
  }
  // A duplicate is refused rather than guessed at (as the session cookies do, R1-08).
  if (values.size !== 1) return null;
  const v = values.values().next().value ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
}

/** The `Set-Cookie` value that hands a browser its binder. */
export function binderCookie(binder: string): string {
  return binderCookieOf(binder, REQUEST_HANDLE_TTL_SECONDS);
}

/**
 * Create a handle for one sign-in request, bound to the browser of `req`. Returns the handle and,
 * when the browser had no binder yet, the cookie to set on the response.
 */
export async function createSignInRequest(
  env: Env,
  req: Request,
  init: {
    product: string;
    kind: ClientKind;
    deviceLabel?: string | null;
    userCode?: string | null;
    origin?: string | null;
    flowRef: string;
    authz?: AuthzRecord;
    /**
     * The card is on another host (LK-04): no cookie is set here. A fresh binder is bound to the
     * request and travels in a single-use bind token to the customer host.
     */
    crossHost?: boolean;
  },
  now: number,
): Promise<{
  handle: string;
  setCookie: string | null;
  bindToken: string | null;
}> {
  const existing = init.crossHost ? null : readBinder(req);
  const binder = existing ?? randomToken(32);
  const handle = `rq_${randomToken(16)}`;
  const record: SignInRequestRecord = {
    product: init.product,
    kind: init.kind,
    deviceLabel: init.deviceLabel ?? null,
    userCode: init.userCode ?? null,
    origin: init.origin ?? null,
    flowRef: init.flowRef,
    ...(init.authz ? { authz: init.authz } : {}),
    binder: await hashKey(binder, env.KEY_HASH_PEPPER),
    expiresAt: now + REQUEST_HANDLE_TTL_SECONDS,
  };
  await putArtefact(
    env,
    await requestRef(env, handle),
    JSON.stringify(record),
    REQUEST_HANDLE_TTL_SECONDS,
  );
  if (init.crossHost)
    return {
      handle,
      setCookie: null,
      bindToken: await issueBindToken(env, { kind: "request", handle, binder }),
    };
  return {
    handle,
    setCookie: existing ? null : binderCookie(binder),
    bindToken: null,
  };
}

/**
 * The record behind `handle`, or `null` when the handle is malformed, unknown, expired, or
 * presented by a browser that does not hold its binder. Every "no" looks the same.
 */
export async function readSignInRequest(
  env: Env,
  req: Request,
  handle: string,
  now: number,
): Promise<SignInRequestRecord | null> {
  if (!isRequestHandle(handle)) return null;
  const binder = readBinder(req);
  if (!binder) return null;
  const raw = await getArtefact(env, await requestRef(env, handle));
  if (!raw) return null;
  let record: SignInRequestRecord;
  try {
    record = JSON.parse(raw) as SignInRequestRecord;
  } catch {
    return null;
  }
  if (typeof record?.binder !== "string" || typeof record.product !== "string")
    return null;
  if (record.expiresAt <= now) return null;
  if (record.binder !== (await hashKey(binder, env.KEY_HASH_PEPPER)))
    return null;
  return record;
}

/**
 * Take the request out of the store (Continue and Cancel): the record behind `handle` for the
 * browser holding its binder, removed in one atomic consume so two presses cannot both succeed.
 * `null` when it is unknown, expired, bound to another browser, or already taken.
 */
export async function takeSignInRequest(
  env: Env,
  req: Request,
  handle: string,
  now: number,
): Promise<SignInRequestRecord | null> {
  // The same checks as a read, before anything is removed: a stranger cannot burn a handle.
  if (!(await readSignInRequest(env, req, handle, now))) return null;
  const raw = await consumeArtefact(env, await requestRef(env, handle));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as SignInRequestRecord;
    return record.expiresAt > now ? record : null;
  } catch {
    return null;
  }
}
