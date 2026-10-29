/// <reference types="@cloudflare/workers-types" />

import { activateFromIdentity } from "./activate.js";
import { platformOidcConfig } from "../../../platform/platformOidc.js";
import { type Env } from "../../../platform/env.js";
import { parseFlowRecord } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import { type Product } from "../../../core/products.js";
import { errorResponse, json, methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork } from "../../../core/rateLimit.js";
import { getLicense, getLicenseBySub } from "../../../core/licensing/store.js";
import { getDevice } from "../../../core/devices/store.js";
import { authorizeDevice } from "../../../core/licensing/authz.js";
import { noticeOrigin } from "../accounts/libraryNotice.js";
import { attachClaimedLicenses } from "../accounts/platformMigration.js";
import {
  consumeArtefact,
  deleteArtefact,
  getArtefact,
  putArtefact,
  updateArtefact,
} from "../../../core/singleUse.js";
import { readBodyJson } from "../../../core/cappedBody.js";
import { signInAccountRefused } from "./callback.js";
import { FLOW_DENIED } from "./deviceApproval.js";
import {
  DEVICE_POLL_DENIED,
  type DevicePollResponse,
  type DevicePollUnavailable,
} from "@polaris-key/protocol/identity";
import {
  DEVICE_MINT_RETRY_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  type DeviceFlowRecord,
  FLOW_TTL_SECONDS,
  type FlowRecord,
  deviceFlowKey,
  flowApproved,
  flowKey,
  rateLimited,
} from "./config.js";
import {
  type OidcIdentity,
  getOidcConfig,
} from "../../../core/licensing/issue.js";
import { deleteUserCodeIndex } from "./userCode.js";

/** The poll's `error` state (WIRE-CONTRACT-V4 §12.10). A person's refusal names itself with
 *  `reason: "access_denied"`; every other failure stays bare, so a poller never learns an
 *  account, provider or licence cause (D8). */
function errorState(
  flow: FlowRecord,
): Extract<DevicePollResponse, { status: "error" }> {
  return flow.error === FLOW_DENIED
    ? { status: "error", reason: DEVICE_POLL_DENIED }
    : { status: "error" };
}

/** I-37d: HTTP 503 `unavailable` with `Retry-After` (WIRE-CONTRACT-V4 §12.10 rule 5). Names no
 *  cause (rule 8). */
function unavailable(seconds: number): Response {
  const body = {
    error: "unavailable",
    message: "try again",
  } satisfies DevicePollUnavailable;
  return json(body, {
    status: 503,
    headers: { "retry-after": String(Math.max(1, Math.ceil(seconds))) },
  });
}

/** A mint the device was refused (seat, fingerprint, hardware, licence). Final: a retry fails
 *  the same way (I-37d, rule 6). The message is the refusal code. */
export class MintRefused extends Error {
  constructor(code: string) {
    super(code);
    this.name = "MintRefused";
  }
}

/** Authorize a device for a license and mint a per-device token. */
export async function authorizeAndMint(
  env: Env,
  db: Db,
  product: Product,
  licenseId: string,
  deviceId: string,
  now: number,
): Promise<string> {
  const row = await getLicense(db, product.slug, licenseId);
  if (!row) throw new MintRefused("license not found");
  // I-05: bound by a sign-in. The product-OIDC licence is `sub`-keyed and attached to no account
  // (plans/I-04.md §8 Q6), so no pairwise subject is set here; passthrough sign-in (I-08) does.
  const result = await authorizeDevice(env, db, product, row, deviceId, now, {
    boundBy: "signin",
    adoptAnonymousEnrolled: true,
  });
  if ("error" in result) throw new MintRefused(result.error);
  return result.token;
}

/** What a `/device/poll` asks for beyond "is it done yet". Both are absent on an ordinary poll,
 *  which then completes exactly as before: the identity's own licence, nothing merged.
 *
 *  I-37 retired P1-07's attach on a device-code flow: the person approving a sign-in on a
 *  device is never told that the starter's licence and devices would join their account, so
 *  `attachLicense: true` is read as `false` and `confirm` says `attachable: false`. */
export interface DevicePollAsk {
  /** Hold the flow at the signed-in identity (`confirm`) instead of minting, so the device can
   *  show it first. */
  confirmIdentity: boolean;
  /** The decision sent after the device was shown the identity. Honoured as "do not attach"
   *  whatever it says; `null`: none sent. */
  attachLicense: boolean | null;
}

export const NO_ASK: DevicePollAsk = {
  confirmIdentity: false,
  attachLicense: null,
};

/** The name and verified e-mail of a signed-in identity, for the device to show. Never `sub`,
 *  groups or other claims. */
export function shownIdentity(identity: OidcIdentity): {
  name?: string;
  email?: string;
} {
  return {
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.email ? { email: identity.email } : {}),
  };
}

/** Does `deviceId` hold a live seat on a licence this identity's sign-in could not take over?
 *  Mirrors `provesOwnership` for a device-code flow (no fingerprint): the seat's licence belongs
 *  to the same subject or account, or is the machine's own anonymous enrolment. */
async function seatBlocksIdentity(
  db: Db,
  product: string,
  deviceId: string,
  sub: string,
): Promise<boolean> {
  const seat = await getDevice(db, product, deviceId);
  if (!seat || seat.status !== "authorized") return false;
  const held = await getLicense(db, product, seat.license_id);
  if (!held) return false;
  if (held.sub === sub) return false;
  if (held.origin === "enroll" && held.sub === null) return false;
  const own = await getLicenseBySub(db, product, sub);
  if (own && own.id === held.id) return false;
  if (own?.account_id && held.account_id === own.account_id) return false;
  return true;
}

export async function pollAuthFlow(
  env: Env,
  db: Db,
  product: Product,
  state: string | null,
  deviceId: string | null,
  now: number,
  ask: DevicePollAsk = NO_ASK,
  /** The origin the library notice links to (the request's); `null`: no notice. */
  origin: string | null = null,
): Promise<Response> {
  if (!state || !deviceId)
    return errorResponse(400, "bad_request", "missing state/device");
  const stateKey = await flowKey(env, product.slug, state);
  const raw = await getArtefact(env, stateKey);
  if (!raw) return json({ status: "timeout" });
  const flow = parseFlowRecord<FlowRecord>(raw);
  if (!flow) return json({ status: "timeout" });
  // Only `/device/poll` gets here, with the secret device code: the `state`-keyed
  // `/identity/auth/poll` is retired. `state` rides on the authorize URL a user-code holder is
  // 303'd to, so a surface keyed by it alone (plus the device id) was a complete credential for
  // the victim's token (R8-02, P1-06).
  // Generic error only — never echo an IdP failure reason a poller could enumerate (D8).
  if (flow.error) return json(errorState(flow));
  // I-26: the person is choosing a licence in the browser. The poll waits, with the same body
  // it answers before the callback (no wire change).
  if (flow.choiceOpen) return json({ status: "pending" });
  if (!flow.licenseId && !flow.identity) return json({ status: "pending" });
  // `state` is a non-secret by construction (it rides on the authorize and callback URLs), so
  // it can never be the sole authorization input: the token is minted for the device that
  // STARTED the flow and only after the human confirmed it (R8-01). The answers are the
  // existing generic ones, so a prober learns nothing new.
  if (!flow.deviceId || flow.deviceId !== deviceId)
    return json({ status: "error" });
  if (!flow.confirmedAt) return json({ status: "pending" });
  // I-37: a device-code flow does nothing account-bound until the person approved it in the
  // browser that signed in. BEFORE the account check, the identity disclosure, `confirm`, the
  // activation and the mint, so the poll cannot tell a prober anything else. Unapproved is
  // anything but a numeric `approvedAt`: absent, malformed, or written by an older Worker.
  if (!flowApproved(flow)) return json({ status: "pending" });
  // I-37d: a transient failure is waiting out its backoff. The same 503, the seconds left, and
  // no database read: only the single-use store was touched to get here.
  if (typeof flow.mintRetryAt === "number" && flow.mintRetryAt > now)
    return unavailable(flow.mintRetryAt - now);

  // Everything from here to the mint is the post-approval work. A throw is transient unless it is
  // a `MintRefused` (I-37d): it keeps the flow and answers 503 within a budget, instead of the
  // runtime's bare 500 without CORS. `redeemed` is set once the flow has been taken (G15).
  let licenseId = flow.licenseId;
  let redeemed: string | null = null;
  let token: string;
  try {
    // N9: the callback refused a subject whose account can no longer sign in, but the account
    // can be disabled (or its deletion begun) while the flow waits for this poll. Checked again
    // before anything is shown, activated or minted; the flow is dropped and the answer is the
    // generic `error` (D8), with nothing written.
    if (
      flow.identity &&
      (await pollAccountRefused(env, db, product, flow.identity.sub, now))
    ) {
      await deleteArtefact(env, stateKey);
      return json({ status: "error" });
    }

    if (!licenseId) {
      // The deferred activation of a device-code flow (P1-07). Only `/device/poll` gets here,
      // so only the device-code holder, polling as the device the flow was started for, decides.
      const identity = flow.identity!;
      if (ask.confirmIdentity || ask.attachLicense !== null) {
        // The decision is honoured only once the device has been shown the identity; until then
        // it is (re)shown it, and nothing is minted. `attachable` is always false (I-37, D6).
        if (ask.attachLicense === null || !flow.identityShownAt) {
          if (!flow.identityShownAt) {
            flow.identityShownAt = now;
            await updateArtefact(env, stateKey, {
              expect: { identityShownAt: null },
              set: { identityShownAt: now },
            });
          }
          return json({
            status: "confirm",
            identity: shownIdentity(identity),
            attachable: false,
          });
        }
      }
      // The device may already hold a seat on a licence that is not this identity's and that this
      // flow cannot take over (the same rule `authorizeDevice` applies). Decided BEFORE the
      // activation, so a refused sign-in leaves no licence behind. Same generic answer (D8).
      if (await seatBlocksIdentity(db, product.slug, deviceId, identity.sub)) {
        await deleteArtefact(env, stateKey);
        return json({ status: "error" });
      }
      const result = await activateFromIdentity(db, product, identity, now, {
        env,
      });
      if ("error" in result) {
        // The callback checked this; it can still change underneath a waiting flow (the
        // identity's licence was disabled meanwhile). Same generic answer as every failure (D8).
        await deleteArtefact(env, stateKey);
        return json({ status: "error" });
      }
      licenseId = result.licenseId;
      // Recorded before minting, so a retried poll after a failed mint reuses this licence and
      // never runs the activation (or the merge) twice.
      flow.licenseId = licenseId;
      await updateArtefact(env, stateKey, { set: { licenseId } });
    }
    // I-17: the licence joins the account the callback's claim signed this subject in to. An
    // idempotent sync, so it runs on every attempt: a retry after it threw still joins them.
    if (flow.claimAccount)
      await attachClaimedLicenses(env, db, flow.claimAccount, now, origin);

    // Redeem the flow atomically BEFORE minting (G15): of two racing polls, exactly one takes the
    // record and mints; the other sees it gone and answers `timeout`, as it would a moment later.
    // A transiently failed mint puts the record back (with its `licenseId`), so a retried poll
    // reuses that licence and never runs the activation (or the merge) twice.
    redeemed = await consumeArtefact(env, stateKey);
    if (!redeemed) return json({ status: "timeout" });
    token = await authorizeAndMint(env, db, product, licenseId, deviceId, now);
  } catch (e) {
    // A refusal is final (rule 6): the bare `error` once, the flow dropped (or, past the
    // redemption, not put back), then `timeout`.
    if (e instanceof MintRefused) {
      if (!redeemed) await deleteArtefact(env, stateKey).catch(() => undefined);
      return json({ status: "error" });
    }
    return transientFailure(env, stateKey, flow, redeemed, licenseId, now);
  }
  return json({
    status: "ready",
    token,
    schemaVersion: product.schemaVersion,
    // Who the device is now signed in as, for it to show (P1-06's residual: a user-code holder
    // who confirmed and signed in as themselves binds the device to THEIR account, and the
    // player must be able to see that). Device-code flows only.
    ...(flow.identity ? { identity: shownIdentity(flow.identity) } : {}),
  });
}

/** I-37d: a failure after approval that is not a refusal. Within the budget the flow is kept
 *  with its counter and deadline and the answer is the 503; the failure after the last retry
 *  drops the flow and answers the bare `error`. If the flow cannot be kept, no retry can happen,
 *  so that is the bare `error` too (a 503 would promise one). */
async function transientFailure(
  env: Env,
  stateKey: Parameters<typeof deleteArtefact>[1],
  flow: FlowRecord,
  redeemed: string | null,
  licenseId: string | undefined,
  now: number,
): Promise<Response> {
  const failures = (flow.mintFailures ?? 0) + 1;
  if (failures > DEVICE_MINT_RETRY_SECONDS.length) {
    if (!redeemed) await deleteArtefact(env, stateKey).catch(() => undefined);
    return json({ status: "error" });
  }
  let wait = DEVICE_MINT_RETRY_SECONDS[failures - 1]!;
  const mintRetryAt = now + wait;
  let kept: boolean;
  if (redeemed) {
    // The put-back keeps the `licenseId` the activation recorded.
    const back = parseFlowRecord<FlowRecord>(redeemed) ?? flow;
    if (licenseId) back.licenseId = licenseId;
    back.mintFailures = failures;
    back.mintRetryAt = mintRetryAt;
    // The put-back keeps the device code's original expiry, so an orphaned record can't outlive it.
    const ttl =
      typeof flow.startedAt === "number"
        ? Math.max(1, FLOW_TTL_SECONDS - Math.max(0, now - flow.startedAt))
        : FLOW_TTL_SECONDS;
    kept = await putArtefact(env, stateKey, JSON.stringify(back), ttl).catch(
      () => false,
    );
  } else {
    // A compare-and-set on the count last read, retried on the winner's value: every failed
    // attempt is counted, so overlapping polls can't lose an increment and run an extra attempt.
    let seen = flow.mintFailures ?? 0;
    let count = failures;
    kept = false;
    for (let i = 0; i < 4; i++) {
      if (count > DEVICE_MINT_RETRY_SECONDS.length) {
        // The overlapping failures spent the budget: this one ends the flow.
        await deleteArtefact(env, stateKey).catch(() => undefined);
        return json({ status: "error" });
      }
      const set = await updateArtefact(env, stateKey, {
        expect: { mintFailures: seen === 0 ? null : seen },
        set: {
          mintFailures: count,
          mintRetryAt: now + DEVICE_MINT_RETRY_SECONDS[count - 1]!,
        },
      }).catch(() => ({ ok: false, payload: null as string | null }));
      if (set.ok) {
        kept = true;
        wait = DEVICE_MINT_RETRY_SECONDS[count - 1]!;
        break;
      }
      if (set.payload === null) break;
      seen = parseFlowRecord<FlowRecord>(set.payload)?.mintFailures ?? 0;
      count = seen + 1;
    }
  }
  return kept ? unavailable(wait) : json({ status: "error" });
}

/** {@link signInAccountRefused} at the poll, which has no resolved OIDC config: the product's
 *  provider from its row, and the platform issuer from the Worker's secrets. Read-only; no
 *  client secret is opened. */
export async function pollAccountRefused(
  env: Env,
  db: Db,
  product: Product,
  sub: string,
  now: number,
): Promise<boolean> {
  // A row removed while the flow waited reads as the platform default, as the callback reads
  // `provider`: the check then still runs (fail closed) rather than being skipped.
  const row = await getOidcConfig(db, product.slug);
  const platform = platformOidcConfig(env);
  // No platform secrets while a platform-provider flow waits: refuse (fail closed).
  if (!platform) return (row?.provider ?? "platform") === "platform";
  return signInAccountRefused(
    env,
    db,
    row?.provider ?? null,
    platform.issuer,
    sub,
    now,
  );
}

/** POST /<product>/identity/auth/device/poll — poll a confirmed device sign-in flow. */
export async function handleAuthDevicePoll(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  let body: Record<string, unknown>;
  try {
    body = (await readBodyJson(req)) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_request", "invalid json");
  }
  const state =
    typeof body.deviceCode === "string"
      ? body.deviceCode
      : typeof body.state === "string"
        ? body.state
        : null;
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;
  if (!state || !deviceId)
    return errorResponse(400, "bad_request", "missing deviceCode/deviceId");
  const limited = await rateLimited(
    env,
    product,
    now,
    {
      bucket: "authDevicePoll",
      id: clientNetwork(req),
      limit: 120,
      windowSec: 60,
    },
    { bucket: "authDevicePollCode", id: state, limit: 40, windowSec: 60 },
  );
  if (limited) return limited;
  const deviceKey = await deviceFlowKey(env, product.slug, state);
  const raw = await getArtefact(env, deviceKey);
  if (!raw) return json({ status: "timeout" });
  const deviceFlow = parseFlowRecord<DeviceFlowRecord>(raw);
  if (!deviceFlow) return json({ status: "timeout" });
  if (deviceFlow.deviceId !== deviceId)
    return errorResponse(401, "unauthorized", "device mismatch");
  // The `interval` we advertise at /identity/auth/device/start is enforced, not decorative: a client
  // polling faster than the contract is told to slow down instead of being served (R8-02).
  if (
    deviceFlow.lastPollAt !== undefined &&
    now - deviceFlow.lastPollAt < DEVICE_POLL_INTERVAL_SECONDS
  ) {
    return json(
      { status: "slow_down", interval: DEVICE_POLL_INTERVAL_SECONDS },
      { status: 429 },
    );
  }
  // Taking the poll slot is a compare-and-set on the `lastPollAt` this poll read: of two polls
  // racing inside one interval, one proceeds and the other is told to slow down, so the
  // deferred activation below can never run twice side by side.
  const slot = await updateArtefact(env, deviceKey, {
    expect: { lastPollAt: deviceFlow.lastPollAt ?? null },
    set: { lastPollAt: now },
  });
  if (!slot.ok) {
    if (!slot.payload) return json({ status: "timeout" });
    return json(
      { status: "slow_down", interval: DEVICE_POLL_INTERVAL_SECONDS },
      { status: 429 },
    );
  }
  deviceFlow.lastPollAt = now;
  if (!deviceFlow.confirmedAt) {
    // B-096: Deny before sign-in marks the flow record with an error, not this one. The generic
    // `error` is all the poll ever says; anything else stays pending until the code expires.
    const raw = await getArtefact(
      env,
      await flowKey(env, product.slug, deviceFlow.state),
    );
    const flow = raw ? parseFlowRecord<FlowRecord>(raw) : null;
    return json(flow?.error ? errorState(flow) : { status: "pending" });
  }
  const res = await pollAuthFlow(
    env,
    db,
    product,
    deviceFlow.state,
    deviceFlow.deviceId,
    now,
    {
      confirmIdentity: body.confirmIdentity === true,
      attachLicense:
        typeof body.attachLicense === "boolean" ? body.attachLicense : null,
    },
    noticeOrigin(env, req),
  );
  const bodyOut = (await res
    .clone()
    .json()
    .catch(() => null)) as { status?: string } | null;
  if (bodyOut?.status === "ready" || bodyOut?.status === "timeout") {
    await deleteArtefact(env, deviceKey);
    await deleteUserCodeIndex(env, product.slug, deviceFlow.userCode);
  }
  return res;
}
