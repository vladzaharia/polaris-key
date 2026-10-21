/// <reference types="@cloudflare/workers-types" />

import { activateFromIdentity } from "./activate.js";
import { platformOidcConfig } from "../../../platform/platformOidc.js";
import { type Env } from "../../../platform/env.js";
import { parseFlowRecord } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import { type Product } from "../../../core/products.js";
import { errorResponse, json, methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork } from "../../../core/rateLimit.js";
import { getLicense } from "../../../core/licensing/store.js";
import { authorizeDevice } from "../../../core/licensing/authz.js";
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
import {
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
  if (!row) throw new Error("license not found");
  // I-05: bound by a sign-in. The product-OIDC licence is `sub`-keyed and attached to no account
  // (plans/I-04.md §8 Q6), so no pairwise subject is set here; passthrough sign-in (I-08) does.
  const result = await authorizeDevice(env, db, product, row, deviceId, now, {
    boundBy: "signin",
    adoptAnonymousEnrolled: true,
  });
  if ("error" in result) throw new Error(result.error);
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

export async function pollAuthFlow(
  env: Env,
  db: Db,
  product: Product,
  state: string | null,
  deviceId: string | null,
  now: number,
  ask: DevicePollAsk = NO_ASK,
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
  if (flow.error) return json({ status: "error" });
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
  // N9: the callback refused a subject whose account can no longer sign in, but the account can
  // be disabled (or its deletion begun) while the flow waits for this poll. Checked again before
  // anything is shown, activated or minted; the flow is dropped and the answer is the generic
  // `error` (D8), with nothing written.
  if (
    flow.identity &&
    (await pollAccountRefused(env, db, product, flow.identity.sub, now))
  ) {
    await deleteArtefact(env, stateKey);
    return json({ status: "error" });
  }

  let licenseId = flow.licenseId;
  if (!licenseId) {
    // The deferred activation of a device-code flow (P1-07). Only `/device/poll` gets here, so
    // only the device-code holder, polling as the device the flow was started for, decides.
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
    // I-17: the licence joins the account the callback's claim signed this subject in to.
    if (flow.claimAccount)
      await attachClaimedLicenses(db, flow.claimAccount, now);
  }

  // Redeem the flow atomically BEFORE minting (G15): of two racing polls, exactly one takes the
  // record and mints; the other sees it gone and answers `timeout`, as it would a moment later.
  // A mint that then fails puts the record back (with its `licenseId`), so a retried poll
  // reuses that licence and never runs the activation (or the merge) twice.
  const redeemed = await consumeArtefact(env, stateKey);
  if (!redeemed) return json({ status: "timeout" });
  let token: string;
  try {
    token = await authorizeAndMint(env, db, product, licenseId, deviceId, now);
  } catch {
    const back = parseFlowRecord<FlowRecord>(redeemed) ?? flow;
    back.licenseId = licenseId;
    await putArtefact(
      env,
      stateKey,
      JSON.stringify(back),
      FLOW_TTL_SECONDS,
    ).catch(() => undefined);
    return json({ status: "error" });
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
    return json({ status: flow?.error ? "error" : "pending" });
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
