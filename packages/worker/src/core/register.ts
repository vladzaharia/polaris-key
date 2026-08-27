/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<product>/devices/register` — the keyless mint path of the device principal
 * (WIRE-CONTRACT-V3 §6, design spec §2.3, plan §R4).
 *
 * ── WHAT THIS ENDPOINT IS FOR ───────────────────────────────────────────────────────────────
 *
 * Until wire v3 there was exactly one way to become a device: present a licence key. That made
 * "device" a licensing concept, which is precisely what D-08 undoes — a product may run Config
 * (signed settings distribution) with License disabled, and its installs still need an identity
 * to fetch a document as and a credential to fetch it with. This is where they get one.
 *
 * It is a CORE route, not a service route: `/devices/register` sits beside `/devices` and
 * `/devices/report` under every policy, and it must keep working for a product that has enabled
 * no services at all. Routing it through the registry would make the device principal a thing
 * some service owns, which is the coupling the suite exists to remove.
 *
 * ── THE POLICY ──────────────────────────────────────────────────────────────────────────────
 *
 * `product.registration` (resolved at load from `services_json` + the §6 derivation):
 *
 *   `open`              mint immediately. Rate-limited, fingerprint optional.
 *   `requires-identity` mint only for a caller Identity vouches for — see below.
 *   `requires-license`  refuse permanently: activation/enrolment ARE the mint path here, and
 *                       an open second door would hand a free token to anyone who can spell
 *                       the product slug.
 *
 * Every refusal shares one body. A caller learns that it may not register, and nothing about
 * WHY — telling `requires-license` from `requires-identity`, or an unauthenticated
 * `requires-identity` caller from one whose session has expired, would let a prober map which
 * products run which services, which is the same reconnaissance `core/registry.ts` refuses for
 * disabled services.
 *
 * ── THE IDENTITY EXCHANGE ───────────────────────────────────────────────────────────────────
 *
 * `requires-identity` is the one policy whose answer Core cannot compute: "is there a product
 * login behind this request" is a question about a session shape only Identity defines. Core
 * therefore asks the REGISTRY, through `ServiceDescriptor.authorizeRegistration` — a narrow
 * predicate declared in `core/registry.ts` — rather than importing the service. This file
 * learns nothing about cookies, and Identity decides nothing about rate limits, device-id
 * shape, seat rebinding or what a refusal looks like.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product } from "./products.js";
import { HEADER_DEVICE } from "@plrs/protocol/core";
import { getDevice } from "../repo.js";
import { ErrorCode, methodNotAllowed, wireError } from "./errors.js";
import { clientIp, rateLimitOk } from "./rateLimit.js";
import { authorizeRegistration, type ServiceRegistry } from "./registry.js";
import {
  deviceMetadata,
  NO_LICENSE_ID,
  readFingerprint,
  registerDeviceBinding,
} from "./devices.js";

/**
 * The device id a client may present.
 *
 * 32 base64url characters — the truncated SHA-256 every SDK derives (`pkey-device:<slug>:<raw>`,
 * pinned by the conformance corpus's `fingerprint.json`) and the shape wire v3 §6 states.
 * Activation accepts any non-empty string for compatibility with clients that shipped before the
 * formula was pinned; registration is NEW, has no such history, and takes the strict form.
 *
 * The value is client-chosen and this check does not make it trustworthy — it is a well-formedness
 * gate, not authentication. What it buys is that the id going into a primary key, a KV key and a
 * signed document's `deviceId` claim is bounded, opaque and free of separators, so a caller
 * cannot smuggle structure into any of the three.
 */
const DEVICE_ID = /^[A-Za-z0-9_-]{32}$/;

/**
 * The single refusal (§R4): `403 {"error":{"code":"registration_closed"}}`.
 *
 * One body for four different causes — `requires-license`, `requires-identity` with no session,
 * `requires-identity` on a product whose Identity service is off, and a device id already bound
 * to a real licence. A caller that could tell them apart could map a product's configuration
 * and probe whether a given device id is licensed, from an endpoint that takes no credential.
 */
function registrationClosed(): Response {
  return wireError(403, "registration_closed");
}

export async function handleRegister(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  /** The composition root's service table, for the `requires-identity` exchange. */
  registry: ServiceRegistry,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();

  // Policy BEFORE the limiter, for the policy that can never say yes: a `requires-license`
  // product must not be able to have its limiter budget consumed by requests it was never going
  // to answer, and refusing without a DO round-trip keeps that case cheap under exactly the
  // flood that would try it.
  if (product.registration === "requires-license") return registrationClosed();

  // Fail CLOSED (see `rateLimit.ts`'s bucket table): this endpoint mints a credential with no
  // key and no prior state, so it is the surface where losing the limiter is least tolerable.
  // Keyed by edge IP, which is the only client identity there is.
  //
  // It runs BEFORE the identity exchange rather than after, and that ordering is the point: the
  // exchange reads a cookie, hashes it and touches KV and D1, so gating it on an unauthenticated
  // budget is what stops a flood of forged cookies from turning a rate-limited endpoint into an
  // unmetered session-probing oracle.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "register", id: clientIp(req), limit: 10, windowSec: 60 },
      now,
    ))
  ) {
    return wireError(429, "rate_limited");
  }

  // `requires-identity`: mint only for a caller Identity vouches for. `authorizeRegistration`
  // checks the product's enablement flag before consulting the descriptor and fails closed on a
  // missing descriptor or a missing hook, so the only way past here is a real, live session.
  if (
    product.registration === "requires-identity" &&
    !(await authorizeRegistration(registry, "identity", product.services, {
      req,
      env,
      db,
      product,
      now,
    }))
  ) {
    return registrationClosed();
  }

  // Keyless means keyless: no Authorization header is read here, and presenting one is not an
  // error either — a client that sends a stale device token alongside a re-registration is
  // asking for a fresh credential, not authenticating with the old one.
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId || !DEVICE_ID.test(deviceId)) {
    return wireError(400, ErrorCode.BadRequest, {
      message: "missing or malformed device id",
    });
  }

  // Re-registering an id that is already REGISTERED rotates its token, which is what a client
  // that lost its credential needs — including one whose row was deauthorized, since an
  // unlicensed device holds no seat and its deauthorization killed a credential rather than a
  // grant. Re-registering an id bound to a real LICENCE must never work: `registerDeviceBinding`
  // rewrites `license_id`, so allowing it would let anyone who knows a licensed device's id
  // evict that device from its seat and drop it to an unlicensed principal — a keyless
  // deauthorize. Products where both paths can coexist are the reason this is a check and not an
  // assumption: an operator may set `registration: "open"` on a product that also runs License.
  const existing = await getDevice(db, product.slug, deviceId);
  if (existing && existing.license_id !== NO_LICENSE_ID) {
    return registrationClosed();
  }

  // Optional, exactly as §6 says. `readFingerprint` treats an absent, empty, oversized or
  // unparseable body as "no fingerprint" rather than an error, so a client that sends nothing at
  // all registers fine. There is no tier here to demand one.
  const presented = await readFingerprint(req);

  const { token, device } = await registerDeviceBinding(
    env,
    db,
    product,
    deviceId,
    now,
    { existing, presented, metadata: deviceMetadata(req) },
  );

  // `deviceId` is echoed even though the caller chose it: it is what the signed documents will
  // carry in their `deviceId` claim, so a client that echoes it back has server confirmation of
  // the binding rather than an assumption about it.
  return wireOk({ token, deviceId: device.device_id });
}

/** 200 with the wire-v3 `no-store` headers the credential surfaces use. */
function wireOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
