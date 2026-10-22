/// <reference types="@cloudflare/workers-types" />

import { constantTimeEqual } from "../../../platform/compare.js";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { hashKey } from "../../../platform/crypto.js";
import { type Env } from "../../../platform/env.js";
import { hostOrigin } from "../../../core/hosts.js";
import {
  DEVICE_ENTRY_WIDE_LIMIT,
  DEVICE_ENTRY_WIDE_WINDOW_SEC,
  typedCode,
} from "../../../core/deviceEntry.js";
import { appForPage } from "../../../core/brandPage.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import { randomToken } from "../../../platform/random.js";
import { parseFlowRecord, tryParseJson } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import { type Product } from "../../../core/products.js";
import { errorResponse, json, methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork, clientWideNetwork } from "../../../core/rateLimit.js";
import { binderSetCookie } from "../licenseChoice.js";
import { requestLocation } from "../place.js";
import {
  getArtefact,
  putArtefact,
  updateArtefact,
} from "../../../core/singleUse.js";
import { readBodyText } from "../../../core/cappedBody.js";
import { sameOriginPost } from "../../../core/accounts/browserRequestGuard.js";
import { beginAuthFlow } from "./browserFlow.js";
import { startAgainPage } from "./chooser.js";
import {
  denyChosenDeviceFlow,
  deniedPage,
  lostDenyPage,
} from "./deviceApproval.js";
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  type DeviceFlowRecord,
  FLOW_TTL_SECONDS,
  type FlowRecord,
  deviceFlowKey,
  flowKey,
  rateLimited,
} from "./config.js";
import {
  deviceDeniedPage,
  type PageView,
  listingDeveloper,
  deviceGonePage,
  renderDeviceConfirmation,
  renderDeviceEntry,
} from "./pages.js";
import {
  claimUserCode,
  deleteUserCodeIndex,
  deviceUserKey,
  formatUserCode,
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
    {
      deviceName,
      // I-37: shown on the DeviceConfirm page, set by the edge and never by the client.
      startedAt: Math.floor(Date.now() / 1000),
      startPlace: (({ country, label }) => ({ country, label }))(
        requestLocation(req),
      ),
    },
  );
  if (flow instanceof Response) return flow;
  const deviceCode = randomToken(16);
  // The user code is independent of the device code (RFC 8628 §6.1). A live collision would
  // point two flows at one code, so the index slot is claimed atomically (`ifAbsent`) and an
  // occupied one means "draw again". The device record is written right after; until then the
  // index resolves to nothing and the entry page answers "not valid or expired".
  const code = await claimUserCode(
    env,
    product.slug,
    deviceCode,
    FLOW_TTL_SECONDS,
  );
  if (!code) return errorResponse(503, "unavailable", "try again");
  const userCode = formatUserCode(code);
  await updateArtefact(env, await flowKey(env, product.slug, flow.state), {
    set: { userCode },
  });
  const deviceRecord: DeviceFlowRecord = {
    state: flow.state,
    deviceId,
    userCode,
    authorizeUrl: flow.authorizeUrl,
    deviceName,
    startedAt: Math.floor(Date.now() / 1000),
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
  // With a usable `CUSTOMER_ORIGIN`, the short customer-site page (`<customer>/device`, LK-00 §7.9):
  // the global index finds the product. Unset, it is the product's own page, exactly as before.
  const customer = hostOrigin("customer", env);
  const verificationUri = customer
    ? `${customer}/device`
    : `${new URL(req.url).origin}/${product.slug}/identity/auth/device`;
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

/** What the pages need to draw the app: its icon and the developer's name (display data). */
export interface DevicePageContext {
  db: Db;
  hooks?: ServiceHooks;
}

async function appFor(
  env: Env,
  product: Product,
  ctx: DevicePageContext | undefined,
): Promise<{ name: string; iconUrl: string | null; developer: string | null }> {
  if (!ctx) return { name: product.name, iconUrl: null, developer: null };
  const app = await appForPage({ product, env, db: ctx.db, hooks: ctx.hooks });
  return { ...app, developer: await listingDeveloper(ctx.hooks) };
}

/** The decision the confirmation form posts (`decision=approve|deny`). Absent or unknown reads
 *  as approve, as every form did before the Deny button existed: the CSRF token is what proves
 *  the press. */
export type DeviceDecision = "approve" | "deny";

/** The CSRF token and decision the confirmation form posts back, from either an HTML form body
 *  or JSON. */
export async function readConfirmForm(
  req: Request,
): Promise<{ token: string | null; decision: DeviceDecision }> {
  const text = await readBodyText(req).catch(() => "");
  if (!text) return { token: null, decision: "approve" };
  let token: string | null;
  let decision: unknown;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = tryParseJson(text) as Record<string, unknown> | undefined;
    token = typeof body?.csrf === "string" ? body.csrf : null;
    decision = body?.decision;
  } else {
    const form = new URLSearchParams(text);
    token = form.get("csrf") || null;
    decision = form.get("decision");
  }
  return { token, decision: decision === "deny" ? "deny" : "approve" };
}

/** The CSRF token the confirmation form posts back, from either an HTML form body or JSON. */
export async function readConfirmToken(req: Request): Promise<string | null> {
  return (await readConfirmForm(req)).token;
}

/** A JSON client (not a browser form): it keeps getting JSON errors. Everyone else is a person
 *  who pressed a button, and gets a page. */
function wantsJson(req: Request): boolean {
  if ((req.headers.get("content-type") ?? "").includes("application/json"))
    return true;
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

/** The end of a device flow that cannot go on: a Locker page for a browser, the JSON `fallback`
 *  for a JSON client. */
function gone(
  req: Request,
  product: Product,
  status: 403 | 404,
  kind: "expired" | "stale",
  fallback: Response,
  view: PageView = {},
): Response {
  return wantsJson(req)
    ? fallback
    : deviceGonePage(product, status, kind, view);
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
  decision: DeviceDecision = "approve",
  view: PageView = {},
  db?: Db,
): Promise<Response> {
  if (!sameOriginPost(req))
    return errorResponse(403, "forbidden", "confirmation failed");
  const refused = errorResponse(403, "forbidden", "confirmation failed");
  if (!record.csrf || !token || !constantTimeEqual(token, record.csrf))
    return gone(req, product, 403, "stale", refused, view);

  // Before sign-in. "Continue" approves nothing (I-37): `approvedAt` is set only on the approval
  // page after sign-in. Deny here spends the code, so nothing starts.
  if (decision === "deny") {
    // Spend the token and the user code: the code stops resolving, and nothing is signed in.
    const spentDeny = await updateArtefact(
      env,
      await deviceFlowKey(env, product.slug, deviceCode),
      { expect: { csrf: token }, unset: ["csrf"] },
    );
    if (!spentDeny.ok) return gone(req, product, 403, "stale", refused, view);
    await deleteUserCodeIndex(env, product.slug, record.userCode);
    // B-096: the device is polling the flow, not the device record. Mark the flow denied (the
    // one writer, with its audit row) so the poll answers `error` now and not `pending` until
    // the code expires. A flow already gone has nothing to mark.
    const denyRaw = await getArtefact(
      env,
      await flowKey(env, product.slug, record.state),
    );
    const denyFlow = denyRaw ? parseFlowRecord<FlowRecord>(denyRaw) : null;
    if (!denyFlow) return deviceDeniedPage(product, view);
    const denyKey = await flowKey(env, product.slug, record.state);
    const denied = await denyChosenDeviceFlow(
      env,
      db,
      product,
      denyKey,
      denyFlow,
      now,
    );
    if (!denied) return lostDenyPage(env, denyKey, denyFlow, view, []);
    return deniedPage(denyFlow, view, []);
  }

  // The confirmation is an authorization input for the poll, so it is recorded on
  // the flow the pollers actually read, not only on the device record (R8-01). The flow must
  // still exist (checked first, so an expired flow spends nothing).
  const stateKey = await flowKey(env, product.slug, record.state);
  const deviceKey = await deviceFlowKey(env, product.slug, deviceCode);
  const flowRaw = await getArtefact(env, stateKey);
  const flowRecord = flowRaw ? parseFlowRecord<FlowRecord>(flowRaw) : null;
  if (!flowRecord)
    return gone(
      req,
      product,
      404,
      "expired",
      errorResponse(404, "not_found", "device code expired"),
      view,
    );
  // Spend the CSRF token atomically (single-use): of two racing POSTs carrying it, one
  // confirms and the other is refused like any stale token.
  const spent = await updateArtefact(env, deviceKey, {
    expect: { csrf: token },
    set: { confirmedAt: now },
    unset: ["csrf"],
  });
  if (!spent.ok) return gone(req, product, 403, "stale", refused, view);
  // I-26: the confirming browser is the one the licence chooser will answer (delegated decision
  // 13). Minted here, never at `/device/start`: that request comes from the device, not from
  // the browser that signs in.
  // Every device-code flow is bound to its confirming browser, so the IdP leg can
  // only finish where the human confirmed, not in a victim's browser the starter phished.
  const binder = randomToken(32);
  const stamped = await updateArtefact(env, stateKey, {
    set: {
      confirmedAt: now,
      // The large-type variant follows the person through the IdP and the chooser.
      ...(view.tv ? { tv: true } : {}),
      ...(binder ? { binder: await hashKey(binder, env.KEY_HASH_PEPPER) } : {}),
    },
  });
  if (!stamped.ok)
    return gone(
      req,
      product,
      404,
      "expired",
      errorResponse(404, "not_found", "device code expired"),
      view,
    );
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

// `sameOriginPost` (Fetch Metadata, then `Origin`, `"null"` allowed under no-referrer) lives in Core,
// next to the other browser request guards. With the single-use CSRF token minted on the page's
// render it guards only against cross-site forgery of SOMEONE ELSE'S flow. It does not stop a
// flow's starter, who can mint the token for their own code and POST it with no `Origin` (curl):
// that is the open R1-07 / R8-03 residual (no binding between the confirming browser and the IdP
// callback), see THREAT-MODEL.md "Remote phishing".
/** The user code and CSRF token from an entry-route POST. `csrf` is `undefined` when the field
 *  is ABSENT (the entry form: look the code up and render the confirmation) and a string —
 *  possibly empty — when present (the confirmation form: confirm, and 403 unless it matches). */
export async function readEntryForm(req: Request): Promise<{
  userCode: string | null;
  csrf: string | undefined;
  decision: DeviceDecision;
}> {
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
      decision: body.decision === "deny" ? "deny" : "approve",
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
    decision: form.get("decision") === "deny" ? "deny" : "approve",
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
  ctx?: DevicePageContext,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const now = Math.floor(Date.now() / 1000);
  // Per client network only: the IPv4 address, or the IPv6 /64 (one host holds a whole /64, so
  // a per-address key would be free to rotate — R10-04b). A product-wide bucket would let one
  // attacker exhaust it and lock every player out of sign-in; 20^8 codes over a 600 s lifetime
  // is what bounds blind guessing (THREAT-MODEL.md, "Brute force").
  const limited = await rateLimited(
    env,
    product,
    now,
    {
      bucket: "authDeviceEntry",
      id: clientNetwork(req),
      limit: 30,
      windowSec: 60,
    },
    {
      bucket: "authDeviceEntryWide",
      id: clientWideNetwork(req),
      limit: DEVICE_ENTRY_WIDE_LIMIT,
      windowSec: DEVICE_ENTRY_WIDE_WINDOW_SEC,
    },
  );
  const url = new URL(req.url);
  // `/tv` carries its large-type variant through the redirect and every step after it.
  const tv = url.searchParams.get("tv") === "1";
  const action = `${url.origin}/${product.slug}/identity/auth/device${tv ? "?tv=1" : ""}`;
  if (limited)
    return wantsJson(req)
      ? limited
      : renderDeviceEntry(product, action, 429, null, undefined, tv);

  let rawCode: string | null;
  let csrf: string | undefined;
  let decision: DeviceDecision = "approve";
  if (req.method === "POST") {
    if (!sameOriginPost(req))
      return errorResponse(403, "forbidden", "confirmation failed");
    const form = await readEntryForm(req);
    rawCode = form.userCode ?? url.searchParams.get("user_code");
    csrf = form.csrf;
    decision = form.decision;
  } else {
    rawCode = url.searchParams.get("user_code");
  }
  const app = await appFor(env, product, ctx);
  const view: PageView = { tv, app };
  if (!rawCode?.trim() && csrf === undefined)
    return renderDeviceEntry(product, action, 200, null, app, tv);

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
      return gone(
        req,
        product,
        403,
        "expired",
        errorResponse(403, "forbidden", "confirmation failed"),
        view,
      );
    return renderDeviceEntry(product, action, 404, typedCode(rawCode), app, tv);
  }

  if (csrf !== undefined)
    return confirmDeviceFlow(
      req,
      env,
      product,
      deviceCode,
      record,
      csrf,
      now,
      decision,
      view,
      ctx?.db,
    );
  return renderDeviceConfirmation(
    req,
    env,
    product,
    deviceCode,
    record,
    action,
    { user_code: formatUserCode(userCode) },
    now,
    app,
    tv,
  );
}

/**
 * `GET`/`POST /<product>/identity/auth/device/verify`: retired (I-37 D5). It confirmed a flow by
 * the secret device code in the URL, which a forwarded link could carry. `/device/start` has not
 * handed it out since `/device` shipped, so it answers the generic start-again page for everyone
 * and reads nothing from the store. The route and discovery's `authDeviceVerify` stay until the
 * next `PROTOCOL_VERSION`.
 */
export async function handleAuthDeviceVerify(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  return startAgainPage();
}
