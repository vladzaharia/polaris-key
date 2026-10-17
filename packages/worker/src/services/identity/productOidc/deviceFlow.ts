/// <reference types="@cloudflare/workers-types" />

import { constantTimeEqual } from "../../../platform/compare.js";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { hashKey } from "../../../platform/crypto.js";
import { type Env } from "../../../platform/env.js";
import { randomToken } from "../../../platform/random.js";
import { parseFlowRecord, tryParseJson } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import { type Product } from "../../../core/products.js";
import { errorResponse, json, methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork } from "../../../core/rateLimit.js";
import { binderSetCookie } from "../licenseChoice.js";
import {
  getArtefact,
  putArtefact,
  updateArtefact,
} from "../../../core/singleUse.js";
import { readBodyText } from "../../../core/cappedBody.js";
import { beginAuthFlow } from "./browserFlow.js";
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  type DeviceFlowRecord,
  FLOW_TTL_SECONDS,
  type FlowRecord,
  deviceFlowKey,
  flowKey,
  rateLimited,
} from "./config.js";
import { renderDeviceConfirmation, renderDeviceEntry } from "./pages.js";
import {
  USER_CODE_ATTEMPTS,
  deleteUserCodeIndex,
  deviceUserKey,
  formatUserCode,
  generateUserCode,
  normalizeUserCode,
} from "./userCode.js";

/** POST /<product>/identity/auth/device/start — begin desktop/CLI sign-in, return a poll handle. */
export async function handleAuthDeviceStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const limited = await rateLimited(
    env,
    product,
    Math.floor(Date.now() / 1000),
    {
      bucket: "authDeviceStart",
      id: clientNetwork(req),
      limit: 60,
      windowSec: 60,
    },
  );
  if (limited) return limited;
  let body: Record<string, unknown> = {};
  try {
    const text = await readBodyText(req);
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return errorResponse(400, "bad_request", "invalid json");
  }
  const url = new URL(req.url);
  const deviceId =
    (typeof body.deviceId === "string" && body.deviceId) ||
    req.headers.get(HEADER_DEVICE) ||
    url.searchParams.get("device");
  if (!deviceId) return errorResponse(400, "bad_request", "missing device id");
  // WIRE-CONTRACT-V4 §12.7.1 (PX-W13): display data only, normalised exactly as the SDK
  // normalised it, never rejected. Absent when nothing is left.
  const deviceName = normalizeDeviceLabel(body.deviceName) ?? undefined;
  const flow = await beginAuthFlow(
    req,
    env,
    db,
    product,
    undefined,
    deviceId,
    true,
    { deviceName },
  );
  if (flow instanceof Response) return flow;
  const deviceCode = randomToken(16);
  // The user code is independent of the device code (RFC 8628 §6.1). A live collision would
  // point two flows at one code, so the index slot is claimed atomically (`ifAbsent`) and an
  // occupied one means "draw again". The device record is written right after; until then the
  // index resolves to nothing and the entry page answers "not valid or expired".
  let claimed = false;
  let code = "";
  for (let i = 0; i < USER_CODE_ATTEMPTS && !claimed; i++) {
    code = generateUserCode();
    claimed = await putArtefact(
      env,
      await deviceUserKey(env, product.slug, code),
      deviceCode,
      FLOW_TTL_SECONDS,
      { ifAbsent: true },
    );
  }
  if (!claimed) return errorResponse(503, "unavailable", "try again");
  const userCode = formatUserCode(code);
  const deviceRecord: DeviceFlowRecord = {
    state: flow.state,
    deviceId,
    userCode,
    authorizeUrl: flow.authorizeUrl,
    deviceName,
  };
  await putArtefact(
    env,
    await deviceFlowKey(env, product.slug, deviceCode),
    JSON.stringify(deviceRecord),
    FLOW_TTL_SECONDS,
  );
  // The page a human types the code into, and the same page with the code pre-filled for a QR
  // code or a clickable link (RFC 8628 §3.2, §3.3.1). Neither carries the device code: that is
  // the poll credential and stays between this server and the polling client.
  const verificationUri = `${new URL(req.url).origin}/${product.slug}/identity/auth/device`;
  return json({
    status: "pending",
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?user_code=${userCode}`,
    expiresIn: FLOW_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
    pollUrl: `${new URL(req.url).origin}/${product.slug}/identity/auth/device/poll`,
    // §12.7.1: the label as stored, so a UI kit shows exactly what the sign-in page will.
    deviceName: deviceName ?? null,
  });
}

/** The CSRF token the confirmation form posts back, from either an HTML form body or JSON. */
export async function readConfirmToken(req: Request): Promise<string | null> {
  const text = await readBodyText(req).catch(() => "");
  if (!text) return null;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = tryParseJson(text) as Record<string, unknown> | undefined;
    return typeof body?.csrf === "string" ? body.csrf : null;
  }
  return new URLSearchParams(text).get("csrf") || null;
}

/** POST half of device verification: mark the flow user-confirmed and hand the browser on to
 *  the IdP. Requires the CSRF token minted on the confirmation page's render, so neither a
 *  prefetch nor a cross-site form can confirm a flow (or read `state`/`nonce`) on the visitor's
 *  behalf. Shared by `/device/verify` (device code in the URL) and `/device` (user code). */
export async function confirmDeviceFlow(
  req: Request,
  env: Env,
  product: Product,
  deviceCode: string,
  record: DeviceFlowRecord,
  token: string | null,
  now: number,
): Promise<Response> {
  if (!sameOriginPost(req))
    return errorResponse(403, "forbidden", "confirmation failed");
  if (!record.csrf || !token || !constantTimeEqual(token, record.csrf))
    return errorResponse(403, "forbidden", "confirmation failed");

  // The confirmation is an authorization input for the poll, so it is recorded on
  // the flow the pollers actually read, not only on the device record (R8-01). The flow must
  // still exist (checked first, so an expired flow spends nothing).
  const stateKey = await flowKey(env, product.slug, record.state);
  const deviceKey = await deviceFlowKey(env, product.slug, deviceCode);
  const flowRaw = await getArtefact(env, stateKey);
  const flowRecord = flowRaw ? parseFlowRecord<FlowRecord>(flowRaw) : null;
  if (!flowRecord)
    return errorResponse(404, "not_found", "device code expired");
  // Spend the CSRF token atomically (single-use): of two racing POSTs carrying it, one
  // confirms and the other is refused like any stale token.
  const spent = await updateArtefact(env, deviceKey, {
    expect: { csrf: token },
    set: { confirmedAt: now },
    unset: ["csrf"],
  });
  if (!spent.ok) return errorResponse(403, "forbidden", "confirmation failed");
  // I-26: the confirming browser is the one the licence chooser will answer (delegated decision
  // 13). Minted here, never at `/device/start`: that request comes from the device, not from
  // the browser that signs in.
  // Every device-code flow is bound to its confirming browser, so the IdP leg can
  // only finish where the human confirmed, not in a victim's browser the starter phished.
  const binder = randomToken(32);
  const stamped = await updateArtefact(env, stateKey, {
    set: {
      confirmedAt: now,
      ...(binder ? { binder: await hashKey(binder, env.KEY_HASH_PEPPER) } : {}),
    },
  });
  if (!stamped.ok)
    return errorResponse(404, "not_found", "device code expired");
  // A confirmed flow is done with its user code: nobody else who learns the code (a stream, a
  // photographed QR code, a guess) can re-render the page, re-mint the CSRF token or read the
  // authorize URL after the human has confirmed.
  await deleteUserCodeIndex(env, product.slug, record.userCode);
  const headers = new Headers({
    location: record.authorizeUrl,
    // The authorize URL carries `state` and `nonce`: keep it out of the Referer chain and
    // out of every cache (R8-02).
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  if (binder)
    headers.append("set-cookie", binderSetCookie(binder, FLOW_TTL_SECONDS));
  return new Response(null, { status: 303, headers });
}

/** Refuse a cross-site POST to a device-flow page.
 *
 *  Fetch Metadata decides when the browser sends it: only `same-origin` passes. Without it, an
 *  absent `Origin`, this origin, or the literal `"null"` pass. `"null"` is not optional: both
 *  device pages are served with `referrer-policy: no-referrer`, and under that policy the Fetch
 *  standard serialises a same-origin form POST's `Origin` as `null`. With the single-use CSRF
 *  token minted on the page's render, this guards only against cross-site forgery of SOMEONE
 *  ELSE'S flow. It does not stop a flow's starter, who can mint the token for their own code
 *  and POST it with no `Origin` (curl): that is the open R1-07 / R8-03 residual (no binding
 *  between the confirming browser and the IdP callback) — see THREAT-MODEL.md "Remote
 *  phishing". */
export function sameOriginPost(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  return !origin || origin === "null" || origin === new URL(req.url).origin;
}

/** The user code and CSRF token from an entry-route POST. `csrf` is `undefined` when the field
 *  is ABSENT (the entry form: look the code up and render the confirmation) and a string —
 *  possibly empty — when present (the confirmation form: confirm, and 403 unless it matches). */
export async function readEntryForm(
  req: Request,
): Promise<{ userCode: string | null; csrf: string | undefined }> {
  const text = await readBodyText(req).catch(() => "");
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    // Only a JSON object is a form: `1`, `"x"`, `true` or `null` would make the `in` below throw
    // (an uncaught 500 on an unauthenticated route), so any other shape reads as an empty form.
    const parsed = tryParseJson(text);
    const body = (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {}
    ) as Record<string, unknown>;
    return {
      userCode: typeof body.user_code === "string" ? body.user_code : null,
      csrf: Object.hasOwn(body, "csrf")
        ? typeof body.csrf === "string"
          ? body.csrf
          : ""
        : undefined,
    };
  }
  const form = new URLSearchParams(text);
  return {
    userCode: form.get("user_code"),
    csrf: form.has("csrf") ? (form.get("csrf") ?? "") : undefined,
  };
}

/**
 * `GET`/`POST /<product>/identity/auth/device` — the RFC 8628 user-code page, the
 * `verificationUri` a device-code client shows (`verificationUriComplete` adds `?user_code=`).
 *
 *   - `GET` with no `user_code`: the entry form (one field, POSTs back here).
 *   - `GET ?user_code=`, or a `POST` with `user_code` and NO `csrf` field: look the code up and
 *     render the confirmation page with a fresh single-use CSRF token. Its form posts
 *     `user_code` + `csrf` back here — never the device code.
 *   - `POST` with `user_code` and a `csrf` field: `confirmDeviceFlow` (Origin check, CSRF check,
 *     stamp `confirmedAt`, 303 to the IdP).
 *   - an unknown, expired or malformed code: the entry form again with one generic line, 404.
 *
 * The secret device code never appears in a URL, a page or a form on this path: anyone holding
 * it plus the device id could race the real device for the token once the user confirms. The
 * code → device-code lookup stays server-side, through the peppered `deviceUserKey` index.
 * What a user-code holder DOES get — `state`, in the authorize URL the confirmation 303s to —
 * redeems nothing: the only poll is `/device/poll`, keyed by the device code (the `state`-keyed
 * `/identity/auth/poll` is retired). Once the flow is confirmed the code stops resolving here at
 * all.
 */
export async function handleAuthDeviceEntry(
  req: Request,
  env: Env,
  product: Product,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const now = Math.floor(Date.now() / 1000);
  // Per client network only: the IPv4 address, or the IPv6 /64 (one host holds a whole /64, so
  // a per-address key would be free to rotate — R10-04b). A product-wide bucket would let one
  // attacker exhaust it and lock every player out of sign-in; 20^8 codes over a 600 s lifetime
  // is what bounds blind guessing (THREAT-MODEL.md, "Brute force").
  const limited = await rateLimited(env, product, now, {
    bucket: "authDeviceEntry",
    id: clientNetwork(req),
    limit: 30,
    windowSec: 60,
  });
  if (limited) return limited;
  const url = new URL(req.url);
  const action = `${url.origin}/${product.slug}/identity/auth/device`;

  let rawCode: string | null;
  let csrf: string | undefined;
  if (req.method === "POST") {
    if (!sameOriginPost(req))
      return errorResponse(403, "forbidden", "confirmation failed");
    const form = await readEntryForm(req);
    rawCode = form.userCode ?? url.searchParams.get("user_code");
    csrf = form.csrf;
  } else {
    rawCode = url.searchParams.get("user_code");
  }
  if (!rawCode?.trim() && csrf === undefined)
    return renderDeviceEntry(product, action, 200);

  const userCode = normalizeUserCode(rawCode);
  const deviceCode = userCode
    ? await getArtefact(env, await deviceUserKey(env, product.slug, userCode))
    : null;
  const raw = deviceCode
    ? await getArtefact(env, await deviceFlowKey(env, product.slug, deviceCode))
    : null;
  const parsed = raw ? parseFlowRecord<DeviceFlowRecord>(raw) : null;
  // A confirmed flow no longer answers to its user code (the index is deleted on confirmation;
  // this also covers a request that read the index just before that delete).
  const record = parsed && !parsed.confirmedAt ? parsed : null;
  if (!userCode || !deviceCode || !record) {
    // A confirmation POST for a code that has gone away is still a refused confirmation.
    if (csrf !== undefined)
      return errorResponse(403, "forbidden", "confirmation failed");
    return renderDeviceEntry(product, action, 404);
  }

  if (csrf !== undefined)
    return confirmDeviceFlow(req, env, product, deviceCode, record, csrf, now);
  return renderDeviceConfirmation(
    req,
    env,
    product,
    deviceCode,
    record,
    action,
    { user_code: formatUserCode(userCode) },
    now,
  );
}

/** GET /<product>/identity/auth/device/verify — render the confirmation page.
 *  POST /<product>/identity/auth/device/verify — confirm it. The GET is deliberately side-effect free:
 *  it used to accept `?confirm=1`, which made an `<img src>` enough to confirm a flow AND
 *  handed the caller `state` + `nonce` in the 302 (R8-02).
 *
 *  Kept for flows started before `/device` existed and for any client that builds this URL;
 *  `/device/start` no longer hands it out. */
export async function handleAuthDeviceVerify(
  req: Request,
  env: Env,
  product: Product,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const now = Math.floor(Date.now() / 1000);
  const limited = await rateLimited(env, product, now, {
    bucket: "authDeviceVerify",
    id: clientNetwork(req),
    limit: 60,
    windowSec: 60,
  });
  if (limited) return limited;
  const url = new URL(req.url);
  const deviceCode = url.searchParams.get("device_code");
  if (!deviceCode) return errorResponse(400, "bad_request", "missing code");
  const deviceKey = await deviceFlowKey(env, product.slug, deviceCode);
  const raw = await getArtefact(env, deviceKey);
  if (!raw) return errorResponse(404, "not_found", "device code expired");
  const record = parseFlowRecord<DeviceFlowRecord>(raw);
  if (!record) return errorResponse(404, "not_found", "device code expired");

  if (req.method === "POST") {
    const token = await readConfirmToken(req);
    return confirmDeviceFlow(req, env, product, deviceCode, record, token, now);
  }
  return renderDeviceConfirmation(
    req,
    env,
    product,
    deviceCode,
    record,
    url.toString(),
    {},
    now,
  );
}
