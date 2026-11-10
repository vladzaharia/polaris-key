/**
 * End-session handles (I-21.12; V5 §12.13.9; threat IS-13). `eo_` and 16 random bytes in base64url,
 * stored in the single-use artefact store (`signout-request`) under the handle's peppered hash for
 * `END_SESSION_HANDLE_TTL_SECONDS` (120), bound to the browser that `end-session` redirected: a
 * random binder lives in the `__Host-pk_req` cookie (or travels in a bind token to the customer
 * host) and its hash in the record. A browser without the binder gets the same `404` as an unknown
 * handle. Sign out and Stay signed in TAKE the record: one atomic consume, so a handle yields one
 * answer. The record holds the validated request and nothing a person typed: the return is a
 * string the client registered, and `state` is the relying party's own.
 */

import {
  END_SESSION_HANDLE_PATTERN,
  END_SESSION_HANDLE_TTL_SECONDS,
} from "@polaris-key/protocol/identity";
import { hashKey } from "../../../platform/crypto.js";
import type { Env } from "../../../platform/env.js";
import { randomToken } from "../../../platform/random.js";
import { issueBindToken } from "../../../core/signInBind.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { binderCookie, readBinder } from "../passthrough/request.js";

const HANDLE_RE = new RegExp(END_SESSION_HANDLE_PATTERN);

export interface EndSessionRecord {
  product: string;
  /** The client named by `client_id` or the hint's `aud`; `null` when the request named none. */
  clientId: string | null;
  /** The registered `post_logout_redirect_uri` the request matched; `null` with no return. */
  returnUri: string | null;
  /** The relying party's `state`, kept only with a return. */
  state: string | null;
  /** The `sub` of a verified `id_token_hint`; `null` without one. */
  hintSub: string | null;
  /** The binder's peppered hash. */
  binder: string;
  /** Epoch seconds. */
  expiresAt: number;
}

/** True for a string shaped like an end-session handle. Anything else is never looked up. */
export function isEndSessionHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_RE.test(value);
}

async function endSessionRef(env: Env, handle: string): Promise<ArtefactRef> {
  return artefactRef(
    "signout-request",
    await hashKey(handle, env.KEY_HASH_PEPPER),
  );
}

/**
 * Store a handle for `req`'s browser. Same host as the card: the browser's existing binder is
 * reused (one binder serves every handle it holds), else a new one is set. Another host: no
 * cookie is set here, and a fresh binder travels in a single-use bind token.
 */
export async function createEndSession(
  env: Env,
  req: Request,
  init: Omit<EndSessionRecord, "binder" | "expiresAt"> & { crossHost: boolean },
  now: number,
): Promise<{
  handle: string;
  setCookie: string | null;
  bindToken: string | null;
}> {
  const { crossHost, ...fields } = init;
  const existing = crossHost ? null : readBinder(req);
  const binder = existing ?? randomToken(32);
  const handle = `eo_${randomToken(16)}`;
  const record: EndSessionRecord = {
    ...fields,
    binder: await hashKey(binder, env.KEY_HASH_PEPPER),
    expiresAt: now + END_SESSION_HANDLE_TTL_SECONDS,
  };
  await putArtefact(
    env,
    await endSessionRef(env, handle),
    JSON.stringify(record),
    END_SESSION_HANDLE_TTL_SECONDS,
  );
  if (crossHost)
    return {
      handle,
      setCookie: null,
      bindToken: await issueBindToken(env, { kind: "signout", handle, binder }),
    };
  return {
    handle,
    setCookie: existing ? null : binderCookie(binder),
    bindToken: null,
  };
}

function parse(raw: string): EndSessionRecord | null {
  try {
    const r = JSON.parse(raw) as EndSessionRecord;
    return typeof r?.binder === "string" &&
      typeof r.product === "string" &&
      typeof r.expiresAt === "number"
      ? r
      : null;
  } catch {
    return null;
  }
}

/**
 * The record behind `handle`, or `null` when it is malformed, unknown, expired, or presented by a
 * browser that does not hold its binder. Every "no" looks the same.
 */
export async function readEndSession(
  env: Env,
  req: Request,
  handle: string,
  now: number,
): Promise<EndSessionRecord | null> {
  if (!isEndSessionHandle(handle)) return null;
  const binder = readBinder(req);
  if (!binder) return null;
  const raw = await getArtefact(env, await endSessionRef(env, handle));
  const record = raw ? parse(raw) : null;
  if (!record || record.expiresAt <= now) return null;
  if (record.binder !== (await hashKey(binder, env.KEY_HASH_PEPPER)))
    return null;
  return record;
}

/** Take the record: the checks of a read first (a stranger cannot burn a handle), then one atomic consume. */
export async function takeEndSession(
  env: Env,
  req: Request,
  handle: string,
  now: number,
): Promise<EndSessionRecord | null> {
  if (!(await readEndSession(env, req, handle, now))) return null;
  const raw = await consumeArtefact(env, await endSessionRef(env, handle));
  const record = raw ? parse(raw) : null;
  return record && record.expiresAt > now ? record : null;
}
