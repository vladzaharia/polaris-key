/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../env.js";
import { shardIndex } from "./rateLimit.js";

// The client half of the atomic single-use store (I-02). The object itself is
// `src/singleUseDo.ts`, re-exported by `src/index.ts` because wrangler binds a Durable Object
// class by its export name (`SINGLE_USE` → `SingleUseDO`), as for `RateLimitDO`.
//
// An artefact is addressed by `(kind, id)`: `kind` is one of the closed set below, `id` is a
// peppered hash of the secret that names it (`hashKey(secret, KEY_HASH_PEPPER)`), prefixed by
// the product where the artefact is product-scoped. The address picks one of
// `SINGLE_USE_SHARDS` objects, so related operations on one artefact always meet in one object
// and no object serialises the whole platform.
//
// Failure policy (fail closed): a read that cannot reach the store answers "absent" (`null`,
// `false`, not alive), which every caller already treats as "expired / refused"; a write that
// cannot reach the store throws, so a flow that could not be recorded is never handed out.

/** Every kind of single-use artefact. Adding one is adding a row here. */
export type SingleUseKind =
  /** Portal OIDC sign-in, by `state`. */
  | "portal-flow"
  /** Portal email magic link, by token. */
  | "portal-magic"
  /** A login-card provider sign-in (Google, Apple, Steam; I-06), by `state`. */
  | "provider-flow"
  /** Console (admin) OIDC sign-in, by `state`. */
  | "admin-flow"
  /** Product OIDC sign-in, by `state`. */
  | "oidc-flow"
  /** The legacy sign-in's licence chooser (I-26): the browser binder's hash → the flow's `state`. */
  | "oidc-choice"
  /** RFC 8628 device-code flow, by device code. */
  | "device-flow"
  /** RFC 8628 user-code index (user code → device code), by normalised user code. */
  | "device-user"
  /** A portal "sign in with another device" request (PX-W14, G29), by its poll handle. */
  | "device-login"
  /** Its code index (code → the request's address), by normalised code. */
  | "device-login-code"
  /** An email one-time code (I-07), by (recipient, flow). */
  | "email-code"
  /** A recipient's wrong-code strikes and lockout (I-07), by recipient. */
  | "email-strikes"
  /** The login card's pending email sign-in (I-07), by the browser's flow secret. */
  | "signin-flow"
  /** A first-provider-sign-in email gate (I-07's interstitial), by the browser's gate secret. */
  | "signin-gate"
  /** A WebAuthn challenge (I-14). */
  | "webauthn-challenge"
  /** An issuer authorization code (I-16). */
  | "auth-code"
  /** A passthrough sign-in request handle (PX-W13, WIRE-CONTRACT-V4 §12.7.2), by its hash. */
  | "signin-request";

/** The address of one artefact. */
export interface ArtefactRef {
  readonly kind: SingleUseKind;
  readonly id: string;
}

/** How many objects the store is spread over. Changing it strands every live artefact (they
 *  are at most minutes old), so it is a constant, not a setting. */
export const SINGLE_USE_SHARDS = 64;

export function artefactRef(kind: SingleUseKind, id: string): ArtefactRef {
  return { kind, id };
}

/** The storage key inside the object. */
function storageKey(ref: ArtefactRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** The object name an artefact lives in. Exported for tests. */
export function singleUseShard(ref: ArtefactRef): string {
  return `su:${shardIndex(storageKey(ref), SINGLE_USE_SHARDS)}`;
}

async function call(
  env: Env,
  ref: ArtefactRef,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ns = env.SINGLE_USE;
  if (!ns) throw new Error("single-use store is not bound");
  const stub = ns.get(ns.idFromName(singleUseShard(ref)));
  const res = await stub.fetch("https://single-use/op", {
    method: "POST",
    body: JSON.stringify({ ...body, key: storageKey(ref) }),
  });
  if (!res.ok) throw new Error(`single-use store answered ${res.status}`);
  const out: unknown = await res.json();
  if (out === null || typeof out !== "object")
    throw new Error("single-use store answered a malformed body");
  return out as Record<string, unknown>;
}

/** Run a read; any failure reads as `fallback`. */
async function read<T>(
  env: Env,
  ref: ArtefactRef,
  body: Record<string, unknown>,
  pick: (out: Record<string, unknown>) => T,
  fallback: T,
): Promise<T> {
  try {
    return pick(await call(env, ref, body));
  } catch {
    return fallback;
  }
}

const valueOf = (out: Record<string, unknown>): string | null =>
  typeof out.value === "string" ? out.value : null;

export interface PutOptions {
  /** Failed attempts (`attempt`, a wrong `redeem`) that kill the artefact. */
  maxAttempts?: number;
  /** A secret's hash for `redeem` to compare against. */
  proof?: string;
  /** Write only if no live artefact holds the address; answers false otherwise. */
  ifAbsent?: boolean;
}

/** Store `payload` at `ref` for `ttlSec` seconds, replacing any artefact there (so a new email
 *  code for the same recipient and flow invalidates the old one). Throws if the store is
 *  unreachable. Answers false only for an `ifAbsent` write that found the address taken. */
export async function putArtefact(
  env: Env,
  ref: ArtefactRef,
  payload: string,
  ttlSec: number,
  opts: PutOptions = {},
): Promise<boolean> {
  const out = await call(env, ref, {
    op: "put",
    value: payload,
    ttlSec,
    ...(opts.maxAttempts !== undefined
      ? { maxAttempts: opts.maxAttempts }
      : {}),
    ...(opts.proof !== undefined ? { proof: opts.proof } : {}),
    ...(opts.ifAbsent ? { ifAbsent: true } : {}),
  });
  return out.ok === true;
}

/** The live payload at `ref`, without consuming it; null when absent, expired or unreachable. */
export function getArtefact(
  env: Env,
  ref: ArtefactRef,
): Promise<string | null> {
  return read(env, ref, { op: "get" }, valueOf, null);
}

/** Atomically take the payload at `ref` and delete it: of any number of concurrent calls, at
 *  most one receives the payload. Null when absent, expired, already consumed or unreachable. */
export function consumeArtefact(
  env: Env,
  ref: ArtefactRef,
): Promise<string | null> {
  return read(env, ref, { op: "consume" }, valueOf, null);
}

/** Delete the artefact at `ref` (idempotent). Throws if the store is unreachable. */
export async function deleteArtefact(
  env: Env,
  ref: ArtefactRef,
): Promise<void> {
  await call(env, ref, { op: "delete" });
}

/** Count one failed attempt against `ref`; at the artefact's `maxAttempts` it is deleted.
 *  `alive: false` when it is (now) gone. */
export function attemptArtefact(
  env: Env,
  ref: ArtefactRef,
): Promise<{ alive: boolean }> {
  return read(
    env,
    ref,
    { op: "attempt" },
    (out) => ({ alive: out.alive === true }),
    { alive: false },
  );
}

/** Atomically redeem the artefact at `ref` with a secret's hash: a match consumes it and returns
 *  the payload; a mismatch counts an attempt (killing it at `maxAttempts`). Every "no" has the
 *  same shape, whatever the reason. */
export function redeemArtefact(
  env: Env,
  ref: ArtefactRef,
  proof: string,
): Promise<{ ok: true; payload: string } | { ok: false }> {
  return read<{ ok: true; payload: string } | { ok: false }>(
    env,
    ref,
    { op: "redeem", proof },
    (out) =>
      out.ok === true && typeof out.value === "string"
        ? { ok: true, payload: out.value }
        : { ok: false },
    { ok: false },
  );
}

export interface ArtefactUpdate {
  /** Top-level fields the stored JSON object must hold first; `null` means "absent". */
  expect?: Record<string, unknown>;
  /** Top-level fields to set. */
  set?: Record<string, unknown>;
  /** Top-level fields to remove. */
  unset?: string[];
}

/** Atomic compare-and-set on a JSON-object payload: applies `set`/`unset` only if the artefact
 *  is live and every `expect` field matches. Answers the payload after the change (`ok: true`),
 *  or the current payload, if any, when it did not apply. Never creates an artefact, so an
 *  update cannot resurrect one another caller consumed. */
export function updateArtefact(
  env: Env,
  ref: ArtefactRef,
  change: ArtefactUpdate,
): Promise<{ ok: boolean; payload: string | null }> {
  return read(
    env,
    ref,
    { op: "update", ...change },
    (out) => ({ ok: out.ok === true, payload: valueOf(out) }),
    { ok: false, payload: null },
  );
}

export interface StrikePolicy {
  /** The sliding window strikes are counted over. */
  windowSec: number;
  /** Strikes inside the window that lock the address. */
  threshold: number;
  /** How long a lock lasts from the strike that set it. */
  lockSec: number;
}

/** Record one strike against `ref` (a sliding-window counter); answers whether the address is
 *  now locked. Unreachable: reads as locked (fail closed). */
export function strikeArtefact(
  env: Env,
  ref: ArtefactRef,
  policy: StrikePolicy,
): Promise<{ locked: boolean }> {
  return read(
    env,
    ref,
    { op: "strike", ...policy },
    (out) => ({ locked: out.locked === true }),
    { locked: true },
  );
}

/** Whether `ref` is currently locked by `strikeArtefact`. Unreachable: reads as locked. */
export function artefactLocked(env: Env, ref: ArtefactRef): Promise<boolean> {
  return read(env, ref, { op: "locked" }, (out) => out.locked === true, true);
}
