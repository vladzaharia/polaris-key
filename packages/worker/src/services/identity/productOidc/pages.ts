/// <reference types="@cloudflare/workers-types" />

import { normalizeDeviceLabel } from "@polaris-key/client-core";
import { createSignInRequest } from "../passthrough/request.js";
import { type Env } from "../../../platform/env.js";
import { brandedHtmlSecurityHeaders } from "../../../core/securityHeaders.js";
import {
  // The product sign-in pages have always escaped `& < > "` and let an apostrophe through;
  // every sink is a text node or a double-quoted attribute (R9-12), and the bytes are kept.
  escapeHtmlKeepApostrophe as escapeHtml,
} from "../../../platform/html.js";
import { randomToken } from "../../../platform/random.js";
import { type Product } from "../../../core/products.js";
import { renderBrandPage } from "../../../core/brandHtml.js";
import { accountDisabledPage } from "../card/http.js";
import { errorResponse } from "../../../core/errors.js";
import { PLATFORM_SIGNIN_ENDED } from "../accounts/platformMigration.js";
import { updateArtefact } from "../../../core/singleUse.js";
import {
  type DeviceFlowRecord,
  type FlowRecord,
  deviceFlowKey,
} from "./config.js";

/** Headers for the device-flow HTML pages: the branded-page bundle, no Referer, no caching.
 *  `formTarget` widens `form-action` by exactly one origin — the IdP the confirmation POST
 *  303s to — because browsers apply `form-action` to every redirect a form submission follows,
 *  so `'self'` alone would block the hand-off the confirmation button exists to make. */
export function deviceHtmlHeaders(formTarget?: string): Headers {
  // R1-09: `index.ts`'s `secureResponse` backstop would supply this policy anyway, but a
  // handler that emits HTML should not depend on the dispatcher — a direct call (a test, or a
  // future internal caller) must be hardened too. `brandedHtmlSecurityHeaders` preserves the
  // `referrer-policy` set here.
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      // A device-flow URL can hold a device or user code: never let it ride along as a
      // Referer, and never let a shared cache keep the page (R8-02).
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    }),
  );
  let idp: string | null = null;
  try {
    if (formTarget) idp = new URL(formTarget).origin;
  } catch {
    idp = null;
  }
  if (idp && idp !== "null") {
    headers.set(
      "content-security-policy",
      headers
        .get("content-security-policy")!
        .replace("form-action 'self'", `form-action 'self' ${idp}`),
    );
  }
  return headers;
}

/** Mint a fresh single-use CSRF token onto the record and render the confirmation page: the
 *  product, the device label and the user code, and one button. `hidden` are the extra fields
 *  the form posts back alongside `csrf` — the user code on `/device`, nothing on `/verify`
 *  (whose action URL already carries the device code). */
export async function renderDeviceConfirmation(
  req: Request,
  env: Env,
  product: Product,
  deviceCode: string,
  record: DeviceFlowRecord,
  action: string,
  hidden: Record<string, string>,
  now: number,
): Promise<Response> {
  const csrf = randomToken(16);
  record.csrf = csrf;
  // An update, never a put: it cannot resurrect a record a poll redeemed meanwhile.
  const minted = await updateArtefact(
    env,
    await deviceFlowKey(env, product.slug, deviceCode),
    { set: { csrf } },
  );
  if (!minted.ok) return errorResponse(404, "not_found", "device code expired");
  // Never the raw device id: with `state` it was half of what the retired `/identity/auth/poll`
  // checked, and it is a device identifier the user-code holder has no need for (R8-02, P1-06).
  // §12.7.1: the label is stored normalised at `/device/start`; it is normalised again here so a
  // record written by an older Worker (sliced, not normalised) renders the same way.
  const deviceLabel =
    normalizeDeviceLabel(record.deviceName) ?? "Unnamed device";
  // PX-W13 (§12.7.2): the request handle the new sign-in card reads this request through, bound
  // to this browser. PX-14 turns this page into a 303 to `/signin?request=<handle>`; until then
  // the handle rides on the form, and the page keeps rendering the stored label itself.
  const signInRequest = await createSignInRequest(
    env,
    req,
    {
      product: product.slug,
      kind: "device",
      deviceLabel: normalizeDeviceLabel(record.deviceName),
      userCode: record.userCode,
      flowRef: (await deviceFlowKey(env, product.slug, deviceCode)).id,
    },
    now,
  );
  const hiddenInputs = Object.entries(hidden)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  const html = renderBrandPage({
    title: `Authorize ${product.name}`,
    heading: `Authorize ${product.name}`,
    body:
      `<p>An app is asking to activate this device. Check that the code and device match what the app shows before signing in.</p>` +
      `<dl><dt>Code</dt><dd class="code">${escapeHtml(record.userCode)}</dd>` +
      `<dt>Device</dt><dd>${escapeHtml(deviceLabel)}</dd>` +
      `<dt>Product</dt><dd>${escapeHtml(product.slug)}</dd></dl>` +
      `<form method="post" action="${escapeHtml(action)}" data-request="${escapeHtml(signInRequest.handle)}">${hiddenInputs}` +
      `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
      `<button class="button" type="submit">Continue to sign in</button></form>`,
  });
  const headers = deviceHtmlHeaders(record.authorizeUrl);
  if (signInRequest.setCookie)
    headers.append("set-cookie", signInRequest.setCookie);
  return new Response(html, { status: 200, headers });
}

/** The code-entry form: one text field, posted back to `/device`. `error` renders the single
 *  generic "not valid or expired" line — the page never says WHICH (RFC 8628 §5.1). */
export function renderDeviceEntry(
  product: Product,
  action: string,
  status: 200 | 404,
): Response {
  const error =
    status === 404
      ? `<p class="alert" role="alert">That code isn't valid or has expired. Check the code on your device.</p>` // SIGN-IN.md §3.13
      : "";
  const html = renderBrandPage({
    title: `Connect a device to ${product.name}`,
    heading: `Connect a device to ${product.name}`,
    body:
      `<p class="muted">Enter the code shown on your device.</p>${error}` +
      `<form method="post" action="${escapeHtml(action)}">` +
      `<label for="user_code">Code</label>` +
      `<input id="user_code" name="user_code" type="text" required autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="XXXX-XXXX">` +
      `<button class="button" type="submit">Continue</button></form>`,
  });
  return new Response(html, { status, headers: deviceHtmlHeaders() });
}

/** A branded 403 sign-in refusal page: no caching, no retry on this route. `body` is TRUSTED. */
export function signInRefusalPage(heading: string, body: string): Response {
  return new Response(renderBrandPage({ title: "Sign in", heading, body }), {
    status: 403,
    headers: brandedHtmlSecurityHeaders(
      new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      }),
    ),
  });
}

/** The platform IdP no longer signs this person in (I-17); 403, no retry on this route. */
export function platformSignInEndedPage(): Response {
  return signInRefusalPage(
    PLATFORM_SIGNIN_ENDED.heading,
    `<p>${escapeHtml(PLATFORM_SIGNIN_ENDED.body)}</p><p class="actions"><a class="button" href="/login">${escapeHtml(PLATFORM_SIGNIN_ENDED.action)}</a></p>`,
  );
}

/**
 * "This account can't sign in" (SIGN-IN.md §3.13, Account disabled): the page the portal and the
 * login card give a disabled account, on a product's sign-in (N9). 403, names nothing.
 *
 * **Sign in with another account** goes to Polaris Locker's sign-in (`/login`, which the API host
 * redirects to the customer host), not back into this product's sign-in: that would go straight
 * back to the platform IdP, whose own session (the authorize request asks for no `prompt`) signs
 * the same subject in again and is refused again. Polaris Locker's sign-in is where another
 * account can be chosen, as "Single sign-on ended" sends people there too. **Back to <Product>** returns to the app's page when the flow came from one
 * (`returnTo`, checked same-origin at the start); a device-code flow has none.
 */
export function productAccountDisabledPage(
  product: Product,
  flow: FlowRecord,
): Response {
  return accountDisabledPage({
    signInHref: "/login",
    back: flow.returnTo
      ? { href: flow.returnTo, productName: product.name }
      : null,
  });
}

/** The signed-in page's join offer (I-17): the address is the one the person's own IdP just
 *  asserted, so it names nothing they did not already prove. Nothing has joined. */
export function joinOfferNotice(email: string): string {
  return `<p>A Polaris Locker account already uses ${escapeHtml(email)}. To add this sign-in to it, <a href="/login">continue with single sign-on on Polaris Locker</a>, then sign in to that account when asked.</p>`;
}

/** The callback's "return to the app" page. `notice` is TRUSTED markup (I-17's join offer). */
export function signedInPage(
  cookies: string[] = [],
  notice: string | null = null,
): Response {
  // R1-09 — see the device-authorization page above: set the policy at the sink as well as in
  // the dispatcher backstop.
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(
    renderBrandPage({
      title: "Signed in",
      heading: "You're signed in",
      body: `<p class="muted">You can close this tab and return to the app.</p>${notice ?? ""}`,
    }),
    { status: 200, headers },
  );
}

// ── the licence chooser (I-26) ───────────────────────────────────────────────
//
// See `licenseChoice.ts` for the rule. The page is rendered only by `GET /identity/auth/choose`
// and changed only by its `POST` (post/redirect/get), so a reload never resubmits. Neither the
// page nor its URL names the flow: the browser binder (`__Host-pk_lcb`) finds it through the
// `oidc-choice` index, and each render carries a fresh single-use token stored (hashed) on the
// flow record.
