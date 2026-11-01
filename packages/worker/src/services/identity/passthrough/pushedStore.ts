/**
 * The pushed native sign-in request's store (WIRE-CONTRACT-V5 §12.12; plans/I-15.md §2).
 *
 * `POST /<p>/identity/request` validates an `authorize` request once and keeps it under a
 * `request_uri` for `PUSHED_REQUEST_TTL_SECONDS` (600). The record is kept in the single-use store
 * as kind `signin-par`, addressed by the product and the peppered hash of the URI, so a listing of
 * the store yields nothing that can be presented. `authorize` READS it (a plain reopen of the same
 * sign-in); Continue and Cancel TAKE it (I-15.6), after which the URI answers `invalid_request_uri`.
 */

import {
  PUSHED_REQUEST_TTL_SECONDS,
  REQUEST_URI_PATTERN,
  type NativeRedirectClass,
} from "@polaris-key/protocol/identity";
import { hashKey } from "../../../platform/crypto.js";
import { randomToken } from "../../../platform/random.js";
import type { Env } from "../../../platform/env.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
} from "../../../core/singleUse.js";
import type { AuthzRecord } from "./request.js";

const URI_RE = new RegExp(REQUEST_URI_PATTERN);
const URI_PREFIX = "urn:ietf:params:oauth:request_uri:";

/** What a pushed request holds. */
export interface PushedRecord {
  authz: AuthzRecord;
  redirect: NativeRedirectClass;
  /** The pusher's device id: the code is bound to it at `token`. */
  deviceId: string;
  /** The normalised device label, or null. */
  deviceLabel: string | null;
  returnUri: string | null;
  /** Epoch seconds. */
  expiresAt: number;
}

/** True for a string shaped like a `request_uri`. Anything else is never looked up. */
export function isRequestUri(value: unknown): value is string {
  return typeof value === "string" && URI_RE.test(value);
}

/** The artefact id of a `request_uri` for `product` (also stored on the handle, for I-15.6). */
export async function pushedId(
  env: Env,
  product: string,
  uri: string,
): Promise<string> {
  return `${product}:${await hashKey(uri, env.KEY_HASH_PEPPER)}`;
}

/** Store a validated request and answer its new `request_uri`. Throws if the store is unreachable. */
export async function putPushed(
  env: Env,
  product: string,
  record: Omit<PushedRecord, "expiresAt">,
  now: number,
): Promise<string> {
  const uri = `${URI_PREFIX}${randomToken(16)}`;
  const full: PushedRecord = {
    ...record,
    expiresAt: now + PUSHED_REQUEST_TTL_SECONDS,
  };
  await putArtefact(
    env,
    artefactRef("signin-par", await pushedId(env, product, uri)),
    JSON.stringify(full),
    PUSHED_REQUEST_TTL_SECONDS,
  );
  return uri;
}

function parse(raw: string | null, now: number): PushedRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as PushedRecord;
    return r?.authz && r.expiresAt > now ? r : null;
  } catch {
    return null;
  }
}

/** The record behind `uri` without consuming it; null when malformed, unknown, expired or taken. */
export async function readPushed(
  env: Env,
  product: string,
  uri: string,
  now: number,
): Promise<{ record: PushedRecord; id: string } | null> {
  if (!isRequestUri(uri)) return null;
  const id = await pushedId(env, product, uri);
  const record = parse(
    await getArtefact(env, artefactRef("signin-par", id)),
    now,
  );
  return record ? { record, id } : null;
}

/** Take the record by its artefact id (Continue and Cancel; I-15.6): at most one caller gets it. */
export async function takePushed(
  env: Env,
  id: string,
  now: number,
): Promise<PushedRecord | null> {
  return parse(await consumeArtefact(env, artefactRef("signin-par", id)), now);
}

/**
 * Continue, Cancel and the key return call this right after taking the request handle (§12.12 rule
 * 3): for a request that came through a pushed `request_uri` it takes the pushed record in one
 * atomic consume, so a URI reopened into several handles yields at most one code or refusal. False
 * means another press won (answer `404`); true for every other request.
 */
export async function takeNativeOnce(
  env: Env,
  record: { native?: { par: string } },
  now: number,
): Promise<boolean> {
  if (!record.native) return true;
  return (await takePushed(env, record.native.par, now)) !== null;
}

/** A loopback redirect carries the request handle so the app can hand it to `/signin/return`. */
export function withLoopbackRequest(
  redirect: string,
  record: { native?: { redirect: string } },
  handle: string,
): string {
  if (record.native?.redirect !== "loopback") return redirect;
  const url = new URL(redirect);
  url.searchParams.set("request", handle);
  return url.toString();
}
