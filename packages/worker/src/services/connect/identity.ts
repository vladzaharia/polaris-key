/// <reference types="@cloudflare/workers-types" />

/**
 * The Cloud Connect device routes (CC-06.1; plans/CC-01-cloud-connect.md §2.3, §2.4, §2.9;
 * WIRE-CONTRACT-V5 §15):
 *
 *   GET /<p>/connect/identity   → {ring, certificate, discKeys}
 *   GET /<p>/connect/devices    → {devices: [{deviceId, label, platform, lastSeen, self}]}
 *
 * The caller is the device bearer, and `X-PKey-Device` must name the device the token belongs to.
 * The subject is the device's own principal (`resolveSyncPrincipal`): no route reads a subject or
 * an account id from the request, so a device only ever sees its own person's roster. Answers:
 * `401` for a bad token or a header naming another device, `400` for a missing or malformed
 * header, `403 account_required` for a device with no principal, `409 device_keys_required` for a
 * device that has registered no keys (it is not in its own roster until it does), `503
 * signing_unavailable` when the product has no signing key.
 *
 * `identity` signs a `pkey-ring+jws` at the ring's epoch and a `pkey-peer+jws` for the caller, and
 * delivers K_disc: the current key, and the one before it for 24 hours after a bump. Both answers
 * are `no-store`, because they hold the discovery key and a certificate. `devices` is display
 * data for a person's own devices and carries no key.
 */

import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import {
  isValidClientDeviceId,
  licenseUsable,
  validateDeviceToken,
} from "../../core/devices.js";
import {
  accountDeviceKeys,
  accountDeviceListing,
  getDeviceKeys,
  type AccountDeviceKeys,
} from "../../core/devices/keys.js";
import { knownPlatform } from "../../core/devices/platformFamily.js";
import { resolveSyncPrincipal } from "../../core/accounts/accountSubjects.js";
import { ErrorCode, json, wireError } from "../../core/errors.js";
import { buildSignInUrl } from "../../core/licensing/manageUrl.js";
import type { ServiceContext } from "../../core/registry.js";
import { isStrictJsonError } from "../../core/signing.js";
import { bearer } from "../../platform/http.js";
import { currentRing, discKeys, signPeerCert, signRoster } from "./ring.js";

interface Caller {
  deviceId: string;
  subject: string;
  /** The roster's members, sorted by device id. */
  members: AccountDeviceKeys[];
  seatsHeld: boolean;
}

/** `403 account_required` with the link that starts sign-in (V5 §15.9; as Cloud Sync's §13.1). */
async function signInRequired(ctx: ServiceContext): Promise<Response> {
  const signInUrl = await buildSignInUrl(ctx.env, ctx.db, ctx.req, ctx.product);
  const message = "Sign in to link this device.";
  const code = ErrorCode.AccountRequired;
  return json({ error: { code, message, signInUrl } }, { status: 403 });
}

async function authenticate(ctx: ServiceContext): Promise<Caller | Response> {
  const { req, env, db, product, now } = ctx;
  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  if ("error" in valid) return wireError(401, ErrorCode.Unauthorized);
  const seatsHeld = product.services.license.enabled;
  if (seatsHeld && !licenseUsable(valid.license, now))
    return wireError(401, ErrorCode.Unauthorized);
  const header = req.headers.get(HEADER_DEVICE) ?? "";
  if (!isValidClientDeviceId(header))
    return wireError(400, ErrorCode.BadRequest);
  const named = valid.device.device_id === header;
  if (!named) return wireError(401, ErrorCode.Unauthorized);
  const principal = await resolveSyncPrincipal(db, valid.device);
  if (!principal || principal.product !== product.slug)
    return signInRequired(ctx);
  if (!(await getDeviceKeys(db, product.slug, header)))
    return wireError(409, ErrorCode.DeviceKeysRequired);
  const members = await accountDeviceKeys(db, product.slug, principal.subject, {
    seatsHeld,
  });
  return { deviceId: header, subject: principal.subject, members, seatsHeld };
}

const NO_STORE = { "cache-control": "no-store" } as const;

export async function handleIdentity(
  ctx: ServiceContext,
): Promise<Response | null> {
  if (ctx.req.method !== "GET") return null;
  const { db, product, now } = ctx;
  const caller = await authenticate(ctx);
  if (caller instanceof Response) return caller;
  const self = caller.members.find((m) => m.deviceId === caller.deviceId);
  // Keys exist but the device is not a member (its seat was released): nothing to certify.
  if (!self) return wireError(409, ErrorCode.DeviceKeysRequired);
  const signingKey = await product.signingKey();
  if (!signingKey) return wireError(503, "signing_unavailable");
  const signer = { key: signingKey, kid: product.signingKid };
  const row = await currentRing(
    db,
    product.slug,
    caller.subject,
    caller.members,
    now,
  );
  try {
    const [ring, certificate] = await Promise.all([
      signRoster(
        signer,
        product.slug,
        caller.subject,
        row,
        caller.members,
        now,
      ),
      signPeerCert(signer, product.slug, caller.subject, self, row.epoch, now),
    ]);
    return json(
      { ring, certificate, discKeys: discKeys(row, now) },
      { headers: NO_STORE },
    );
  } catch (e) {
    // A roster no verifier would accept (more than 128 devices): refuse, never send it.
    if (!isStrictJsonError(e)) throw e;
    return wireError(500, ErrorCode.DocumentNotRepresentable);
  }
}

export async function handleDevices(
  ctx: ServiceContext,
): Promise<Response | null> {
  if (ctx.req.method !== "GET") return null;
  const { db, product } = ctx;
  const caller = await authenticate(ctx);
  if (caller instanceof Response) return caller;
  const rows = await accountDeviceListing(db, product.slug, caller.subject, {
    seatsHeld: caller.seatsHeld,
  });
  return json(
    {
      devices: rows.map((r) => ({
        deviceId: r.deviceId,
        label: r.label,
        platform: knownPlatform(r.platform),
        lastSeen: r.lastSeen,
        self: r.deviceId === caller.deviceId,
      })),
    },
    { headers: NO_STORE },
  );
}
