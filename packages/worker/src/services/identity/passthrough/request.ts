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
 * (`oidc.ts`); I-08's `authorize` and the I-13 and I-15 entries will too.
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
  artefactRef,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";

/** The binder cookie (§12.7.2). `__Host-` pins it to this origin, `Path=/` and `Secure`. */
export const REQUEST_BINDER_COOKIE = "__Host-pk_req";

const HANDLE_RE = new RegExp(REQUEST_HANDLE_PATTERN);

/** What a handle's record holds. */
export interface SignInRequestRecord {
  product: string;
  kind: ClientKind;
  deviceLabel: string | null;
  userCode: string | null;
  origin: string | null;
  /** An opaque reference to the flow the request belongs to (the device flow's store id). */
  flowRef: string;
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
  return `${REQUEST_BINDER_COOKIE}=${binder}; Path=/; Max-Age=${REQUEST_HANDLE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
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
  },
  now: number,
): Promise<{ handle: string; setCookie: string | null }> {
  const existing = readBinder(req);
  const binder = existing ?? randomToken(32);
  const handle = `rq_${randomToken(16)}`;
  const record: SignInRequestRecord = {
    product: init.product,
    kind: init.kind,
    deviceLabel: init.deviceLabel ?? null,
    userCode: init.userCode ?? null,
    origin: init.origin ?? null,
    flowRef: init.flowRef,
    binder: await hashKey(binder, env.KEY_HASH_PEPPER),
    expiresAt: now + REQUEST_HANDLE_TTL_SECONDS,
  };
  await putArtefact(
    env,
    await requestRef(env, handle),
    JSON.stringify(record),
    REQUEST_HANDLE_TTL_SECONDS,
  );
  return { handle, setCookie: existing ? null : binderCookie(binder) };
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
