/// <reference types="@cloudflare/workers-types" />

/**
 * The nearby-approval request (I-40.2; WIRE-CONTRACT-V5 §12.11.5): what `nearby/start` writes, what
 * `approve` decides and what `poll` reads, held in the single-use store as the `nearby-request` kind.
 *
 * Address: `<product>:<peppered hash of the nr_ handle>`; the handle itself is never stored. Lifetime:
 * 300 s from `start`, whatever happens after (the compare-and-set writes keep the expiry). A key
 * mismatch counts an attempt and the third ends the request.
 *
 * Privacy: no raw network address and no raw token is stored. `netHash` is the peppered hash of
 * `clientNetwork(start)`, and an approval keeps only `tokenHash`: D's token is minted at the poll.
 *
 * Decision state, every move a compare-and-set so two callers never both win:
 *   pending --claim(M)--> claimed --decide(M)--> approved | denied   (sticky once decided)
 *   claimed --release(M)--> pending      (a refusal M can retry)
 * An unreachable store throws; the handlers answer 503 and keep the request.
 * A claim older than {@link NEARBY_CLAIM_STALE_SECONDS} may be taken again, by anyone.
 */

import { NEARBY_REQUEST_PATTERN } from "@polaris-key/protocol/identity";
import type { DeviceMetadata } from "@polaris-key/protocol/core";
import type { Env } from "../../../platform/env.js";
import { hashKey } from "../../../platform/crypto.js";
import { clientNetwork } from "../../../core/rateLimit.js";
import {
  artefactRef,
  attemptArtefact,
  deleteArtefact,
  getArtefactStrict,
  putArtefact,
  updateArtefactStrict,
  type ArtefactRef,
} from "../../../core/singleUse.js";

/** Lifetime of a request, seconds (§12.11.5). */
export const NEARBY_TTL_SECONDS = 300;
/** Key mismatches that end a request. */
export const NEARBY_MAX_ATTEMPTS = 3;
/** A claim this old (seconds) may be taken again. */
export const NEARBY_CLAIM_STALE_SECONDS = 30;

export type NearbyState = "pending" | "claimed" | "approved" | "denied";

/** What the store holds for a live request. */
export interface NearbyRequestRecord {
  // From `start`.
  product: string;
  deviceId: string;
  signKey: string;
  agreeKey: string;
  /** The normalised device label, or null when D sent none. */
  label: string | null;
  meta: DeviceMetadata;
  /** Peppered hash of `clientNetwork(start)`. */
  netHash: string;
  startedAt: number;
  /** D proved a credential it already held on `start` (Q8). */
  proven: boolean;
  // The decision.
  state: NearbyState;
  claimedBy?: string;
  claimedAt?: number;
  // After an approval.
  approvedBy?: string;
  subject?: string;
  licenseId?: string | null;
  /** Hash of the token the poll mints; never the token. */
  tokenHash?: string;
  decidedAt?: number;
  // The poll interval.
  lastPollAt?: number;
}

/** The members `start` supplies; the store adds the decision state. */
export type NearbyStartMembers = Omit<
  NearbyRequestRecord,
  | "state"
  | "claimedBy"
  | "claimedAt"
  | "approvedBy"
  | "subject"
  | "licenseId"
  | "tokenHash"
  | "decidedAt"
  | "lastPollAt"
>;

/** What an approval records. */
export interface NearbyApproval {
  approvedBy: string;
  subject: string;
  licenseId: string | null;
  tokenHash: string;
}

const HANDLE_SHAPE = new RegExp(NEARBY_REQUEST_PATTERN);
const STATES: readonly string[] = ["pending", "claimed", "approved", "denied"];

/** The store address of a request; a handle of the wrong shape has none. */
export async function nearbyRef(
  env: Env,
  product: string,
  handle: string,
): Promise<ArtefactRef | null> {
  if (!HANDLE_SHAPE.test(handle)) return null;
  return artefactRef(
    "nearby-request",
    `${product}:${await hashKey(handle, env.KEY_HASH_PEPPER)}`,
  );
}

/** Whether the request carries a client network at all. Without one every caller would hash
 *  alike and read as "nearby", so start and approve refuse. */
export function hasClientNetwork(req: Request): boolean {
  return req.headers.get("cf-connecting-ip") !== null;
}

/** The peppered hash of the caller's network, for `netHash`. */
export function nearbyNetHash(env: Env, req: Request): Promise<string> {
  return hashKey(clientNetwork(req), env.KEY_HASH_PEPPER);
}

function parse(raw: string | null): NearbyRequestRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const rec = v as NearbyRequestRecord;
    return STATES.includes(rec.state) ? rec : null;
  } catch {
    return null;
  }
}

/** Write a new `pending` request. False when the handle's address is taken. Throws if the store
 *  is unreachable, so a request that was not recorded is never handed out. */
export function createNearby(
  env: Env,
  ref: ArtefactRef,
  start: NearbyStartMembers,
): Promise<boolean> {
  const rec: NearbyRequestRecord = { ...start, state: "pending" };
  return putArtefact(env, ref, JSON.stringify(rec), NEARBY_TTL_SECONDS, {
    ifAbsent: true,
    maxAttempts: NEARBY_MAX_ATTEMPTS,
  });
}

/** The live request, or null when absent, expired or ended. Throws `SingleUseUnavailableError`
 *  when the store cannot be reached (so a caller never reads an outage as "gone"); every
 *  compare-and-set below does the same. */
export async function readNearby(
  env: Env,
  ref: ArtefactRef,
): Promise<NearbyRequestRecord | null> {
  return parse(await getArtefactStrict(env, ref));
}

export type NearbyMove =
  | { ok: true; record: NearbyRequestRecord }
  | { ok: false; record: NearbyRequestRecord | null };

function moved(r: { ok: boolean; payload: string | null }): NearbyMove {
  const record = parse(r.payload);
  return r.ok && record ? { ok: true, record } : { ok: false, record };
}

/** `pending` to `claimed` by `by`. A `claimed` request whose claim is
 *  {@link NEARBY_CLAIM_STALE_SECONDS} old or more is taken over, the compare-and-set naming the
 *  claim it read so two takeovers cannot both win. Anything else (decided, claimed and fresh,
 *  gone) is `ok: false` with the current record. */
export async function claimNearby(
  env: Env,
  ref: ArtefactRef,
  by: string,
  now: number,
): Promise<NearbyMove> {
  const cur = await readNearby(env, ref);
  if (!cur) return { ok: false, record: null };
  const set = { state: "claimed", claimedBy: by, claimedAt: now };
  if (cur.state === "pending")
    return moved(
      await updateArtefactStrict(env, ref, {
        expect: { state: "pending" },
        set,
      }),
    );
  if (
    cur.state === "claimed" &&
    typeof cur.claimedAt === "number" &&
    now - cur.claimedAt >= NEARBY_CLAIM_STALE_SECONDS
  )
    return moved(
      await updateArtefactStrict(env, ref, {
        expect: {
          state: "claimed",
          claimedBy: cur.claimedBy ?? null,
          claimedAt: cur.claimedAt,
        },
        set,
      }),
    );
  return { ok: false, record: cur };
}

/** `claimed` by `by` to `approved` or `denied`. Sticky: once decided, or claimed by another
 *  caller, it answers `ok: false`. */
export async function decideNearby(
  env: Env,
  ref: ArtefactRef,
  by: string,
  decision: { approve: NearbyApproval } | { deny: true },
  now: number,
): Promise<NearbyMove> {
  const set =
    "approve" in decision
      ? { state: "approved", decidedAt: now, ...decision.approve }
      : { state: "denied", decidedAt: now };
  return moved(
    await updateArtefactStrict(env, ref, {
      expect: { state: "claimed", claimedBy: by },
      set,
    }),
  );
}

/** `claimed` by `by` back to `pending`, for a refusal M can retry. */
export async function releaseNearby(
  env: Env,
  ref: ArtefactRef,
  by: string,
): Promise<NearbyMove> {
  return moved(
    await updateArtefactStrict(env, ref, {
      expect: { state: "claimed", claimedBy: by },
      set: { state: "pending" },
      unset: ["claimedBy", "claimedAt"],
    }),
  );
}

/** Count one key mismatch. `alive: false` once the third has ended the request. */
export function mismatchNearby(
  env: Env,
  ref: ArtefactRef,
): Promise<{ alive: boolean }> {
  return attemptArtefact(env, ref);
}

/** Take the poll slot: a compare-and-set on the `lastPollAt` the caller read, so of two polls
 *  racing inside one interval one proceeds. `ok: false` with a record means too soon; with none,
 *  the request is gone. */
export async function takeNearbyPollSlot(
  env: Env,
  ref: ArtefactRef,
  seenLastPollAt: number | undefined,
  now: number,
): Promise<NearbyMove> {
  return moved(
    await updateArtefactStrict(env, ref, {
      expect: { lastPollAt: seenLastPollAt ?? null },
      set: { lastPollAt: now },
    }),
  );
}

/** Delete the request (idempotent): after the poll hands D its token, or on a decided deny. */
export function dropNearby(env: Env, ref: ArtefactRef): Promise<void> {
  return deleteArtefact(env, ref);
}
