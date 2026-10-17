/**
 * The pending sign-in grant (WIRE-CONTRACT-V4 §12.5.1; plans/I-04.md §G.6).
 *
 * `token` answers `{status: "choose", grant, …}` instead of binding when the app asked to run the
 * licence choice itself (`license_choice=app`) and a choice is due. The grant is the capability to
 * read the account's licence view for THIS product, to Replace, and to finish:
 *
 *   value    `sg_` and 32 random bytes in base64url. Only its peppered hash is an address in the
 *            store (`signin-grant`), so a listing yields nothing presentable. Never in a URL.
 *   life     300 s, inside the fresh sign-in that Replace treats as its step-up.
 *   bound    to the product, the account, the pairwise subject and the redeeming `X-PKey-Device`,
 *            and through `token` to the PKCE verifier (the grant exists only after the code was
 *            redeemed with it). Another device id is `invalid_grant` and is not counted.
 *   one      per flow: the code that earned it is already spent. `complete` and `cancel` consume it
 *            atomically; of any number of concurrent calls one wins.
 *   reads    30 views and device lists in all (and every key attempt), counted in the store by
 *            compare-and-set, so the budget is the grant's, not the network's.
 *
 * The grant carries no licence, key or token. What it unlocks is what the person already saw on the
 * card; what it cannot do is bind anything the offer does not list.
 */

import {
  CHOICE_GRANT_PATTERN,
  CHOICE_GRANT_READS,
  CHOICE_GRANT_TTL_SECONDS,
} from "@polaris-key/protocol/identity";
import { hashKey } from "../../../platform/crypto.js";
import { randomToken } from "../../../platform/random.js";
import type { Env } from "../../../platform/env.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";

const GRANT_RE = new RegExp(CHOICE_GRANT_PATTERN);

export interface GrantRecord {
  product: string;
  accountId: string;
  /** The account's pairwise subject for the product. */
  subject: string;
  /** The device that redeemed the code, the only one the grant answers. */
  deviceId: string;
  scope: string[];
  /** Reads spent so far. */
  reads: number;
  /** Epoch seconds the grant ends, for restoring it after a retryable refusal. */
  exp: number;
}

async function grantRef(
  env: Env,
  product: string,
  grant: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "signin-grant",
    `${product}:${await hashKey(grant, env.KEY_HASH_PEPPER)}`,
  );
}

/** A new grant for a device that just redeemed a code. Throws when the store is unreachable. */
export async function issueGrant(
  env: Env,
  record: Omit<GrantRecord, "reads" | "exp">,
  now: number,
): Promise<string> {
  const grant = `sg_${randomToken(32)}`;
  await putArtefact(
    env,
    await grantRef(env, record.product, grant),
    JSON.stringify({
      ...record,
      reads: 0,
      exp: now + CHOICE_GRANT_TTL_SECONDS,
    } satisfies GrantRecord),
    CHOICE_GRANT_TTL_SECONDS,
  );
  return grant;
}

/**
 * Put a taken grant back for the time it has left, after a refusal the person can retry
 * (`device_limit`, a lost race, `rate_limited`, a wrong key). Never extends it, never replaces a
 * live one.
 */
export async function restoreGrant(
  env: Env,
  grant: string,
  record: GrantRecord,
  now: number,
): Promise<void> {
  const left = record.exp - now;
  if (left <= 0) return;
  await putArtefact(
    env,
    await grantRef(env, record.product, grant),
    JSON.stringify(record),
    left,
    { ifAbsent: true },
  );
}

function parse(raw: string | null): GrantRecord | null {
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as GrantRecord;
    return typeof r?.accountId === "string" && typeof r.deviceId === "string"
      ? r
      : null;
  } catch {
    return null;
  }
}

export type GrantLookup =
  | { ok: true; record: GrantRecord }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "reads_exhausted" };

/**
 * The grant's record for the redeeming device, without consuming it. Every "no" (malformed,
 * unknown, expired, consumed, another product's, another device's) is the same `invalid`.
 */
export async function peekGrant(
  env: Env,
  product: string,
  grant: unknown,
  deviceId: string,
): Promise<GrantLookup> {
  if (typeof grant !== "string" || !GRANT_RE.test(grant))
    return { ok: false, reason: "invalid" };
  const record = parse(
    await getArtefact(env, await grantRef(env, product, grant)),
  );
  if (!record || record.product !== product || record.deviceId !== deviceId)
    return { ok: false, reason: "invalid" };
  return { ok: true, record };
}

/** Spend one read of the grant's budget (30 in all). */
export async function spendRead(
  env: Env,
  product: string,
  grant: string,
  deviceId: string,
): Promise<GrantLookup> {
  const ref = await grantRef(env, product, grant);
  // A few compare-and-set rounds: only a concurrent read of the same grant can make one fail.
  for (let attempt = 0; attempt < 6; attempt++) {
    const peek = await peekGrant(env, product, grant, deviceId);
    if (!peek.ok) return peek;
    if (peek.record.reads >= CHOICE_GRANT_READS)
      return { ok: false, reason: "reads_exhausted" };
    const done = await updateArtefact(env, ref, {
      expect: { reads: peek.record.reads },
      set: { reads: peek.record.reads + 1 },
    });
    if (done.ok) {
      const record = parse(done.payload);
      return record ? { ok: true, record } : { ok: false, reason: "invalid" };
    }
  }
  return { ok: false, reason: "reads_exhausted" };
}

/**
 * Take the grant (Complete and Cancel). The device is checked first and does not burn the grant
 * when it is wrong; the consume itself is atomic, so of any number of concurrent calls one gets
 * the record.
 */
export async function takeGrant(
  env: Env,
  product: string,
  grant: unknown,
  deviceId: string,
): Promise<GrantRecord | null> {
  const peek = await peekGrant(env, product, grant, deviceId);
  if (!peek.ok) return null;
  return parse(
    await consumeArtefact(env, await grantRef(env, product, grant as string)),
  );
}
