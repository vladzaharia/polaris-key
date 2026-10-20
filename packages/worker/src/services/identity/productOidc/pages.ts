/// <reference types="@cloudflare/workers-types" />

import { normalizeDeviceLabel } from "@polaris-key/client-core";
import { createSignInRequest } from "../passthrough/request.js";
import { type Env } from "../../../platform/env.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import { brandedHtmlSecurityHeaders } from "../../../core/securityHeaders.js";
import {
  // The product sign-in pages have always escaped `& < > "` and let an apostrophe through;
  // every sink is a text node or a double-quoted attribute (R9-12), and the bytes are kept.
  escapeHtmlKeepApostrophe as escapeHtml,
} from "../../../platform/html.js";
import { randomToken } from "../../../platform/random.js";
import { type Product } from "../../../core/products.js";
import {
  appHeader,
  callout,
  note,
  renderAuthCard,
  renderBrandPage,
} from "../../../core/brandHtml.js";
import { appForPage, pageApp } from "../../../core/brandPage.js";
import type { Db } from "../../../db/types.js";
import {
  ENTRY_FOOTER,
  codeEntryBody,
  tooManyBody,
  typedCode,
} from "../../../core/deviceEntry.js";
import { accountDisabledPage } from "../card/http.js";
import { PLATFORM_SIGNIN_ENDED } from "../accounts/platformMigration.js";
import { updateArtefact } from "../../../core/singleUse.js";
import {
  type DeviceFlowRecord,
  type FlowRecord,
  FLOW_TTL_SECONDS,
  deviceFlowKey,
} from "./config.js";

/** The developer's name from the product's listing (Distribution's hook), or null. */
export async function listingDeveloper(
  hooks: ServiceHooks | undefined,
): Promise<string | null> {
  try {
    const listing = (await hooks?.delivery()?.listing()) as
      | Record<string, unknown>
      | null
      | undefined;
    const name = listing?.developerName;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** What every step after the confirm shares: the TV variant and the app the confirm drew. */
export interface PageView {
  tv?: boolean;
  app?: { name: string; iconUrl?: string | null } | undefined;
}

/** The view for a flow that is already confirmed (`tv` is stored on the flow at confirm). */
export async function flowView(
  env: Env,
  db: Db,
  product: Product,
  flow: { tv?: boolean },
): Promise<PageView> {
  const app = await appForPage({ product, env, db }).catch(() => undefined);
  return { tv: flow.tv === true, app };
}

/** Headers for the device-flow HTML pages: the branded-page bundle, no Referer, no caching.
 *  `formTarget` widens `form-action` by exactly one origin — the IdP the confirmation POST
 *  303s to — because browsers apply `form-action` to every redirect a form submission follows,
 *  so `'self'` alone would block the hand-off the confirmation button exists to make. */
export function deviceHtmlHeaders(
  formTarget?: string,
  imgOrigin?: string | null,
): Headers {
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
    { imgOrigin: imgOrigin ?? null },
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
/** A name inside a sentence, isolated so a right-to-left label cannot scramble the line. */
function isolate(name: string): string {
  return `\u2068${name}\u2069`;
}

export async function renderDeviceConfirmation(
  req: Request,
  env: Env,
  product: Product,
  deviceCode: string,
  record: DeviceFlowRecord,
  action: string,
  hidden: Record<string, string>,
  now: number,
  /** The app's display data (`appForPage`): its icon and the developer's name. */
  app?: { name: string; iconUrl?: string | null; developer?: string | null },
  tv = false,
): Promise<Response> {
  const shown = pageApp(app ?? { name: product.name });
  const csrf = randomToken(16);
  record.csrf = csrf;
  // An update, never a put: it cannot resurrect a record a poll redeemed meanwhile.
  const minted = await updateArtefact(
    env,
    await deviceFlowKey(env, product.slug, deviceCode),
    { set: { csrf } },
  );
  if (!minted.ok) return deviceGonePage(product, 404, "expired", { tv, app });
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
  // A static expiry, never a ticking countdown (the page has no script): "Expires 14:32 UTC".
  const expiry =
    typeof record.startedAt === "number"
      ? ` Expires ${new Date((record.startedAt + FLOW_TTL_SECONDS) * 1000).toISOString().slice(11, 16)} UTC.`
      : "";
  // Before sign-in: this page approves NOTHING (I-37). "Continue" only hands the browser to the
  // IdP; the explicit step is the approval page after sign-in (`deviceApproval.ts`), the only
  // thing that sets `approvedAt`.
  const who = app?.developer?.trim() || product.name;
  const html = renderAuthCard({
    title: "Continue to sign in?",
    heading: "Continue to sign in?",
    ...(tv ? { variant: "tv" as const } : {}),
    passport: {
      name: product.name,
      iconUrl: shown.app.iconUrl,
      developer: app?.developer ?? null,
      device: deviceLabel,
      action: "wants you to sign in",
    },
    body:
      `<p>It showed the code <span class="code">${escapeHtml(record.userCode)}</span>.${expiry}</p>` +
      `<form method="post" action="${escapeHtml(action)}" data-request="${escapeHtml(signInRequest.handle)}">${hiddenInputs}` +
      `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
      `<div class="stack"><button class="button" type="submit" name="decision" value="approve" autofocus><span>Continue to sign in</span></button>` +
      `<button class="button secondary" type="submit" name="decision" value="deny">Deny</button></div></form>` +
      note("info", "Didn't start this? Deny, and nothing signs in."),
    footer: {
      icon: "lock",
      text: `Polaris Locker signs you in for ${isolate(product.name)}. ${isolate(who)} never sees your codes or passkeys.`,
    },
  });
  const headers = deviceHtmlHeaders(record.authorizeUrl, shown.imgOrigin);
  if (signInRequest.setCookie)
    headers.append("set-cookie", signInRequest.setCookie);
  return new Response(html, { status: 200, headers });
}

/** The code-entry form: one text field, posted back to `/device`. A miss keeps the typed code
 *  and renders the single generic "no device is waiting" line under the field: the page never
 *  says WHICH reason (RFC 8628 §5.1). `status` 429 is the neutral too-many-tries card. */
export function renderDeviceEntry(
  _product: Product,
  action: string,
  status: 200 | 404 | 429,
  typed?: string | null,
  _app?: { name: string; iconUrl?: string | null },
  tv = false,
): Response {
  const html = renderAuthCard({
    title: "Enter your code",
    heading: "Enter the code from your device",
    ...(tv ? { variant: "tv" as const } : {}),
    // B9.3: no product name before the code resolves. A forwarded link must not borrow one.
    body:
      status === 429
        ? tooManyBody(action)
        : codeEntryBody({
            action,
            method: "post",
            typed: typedCode(typed),
            miss: status === 404,
          }),
    footer: ENTRY_FOOTER,
  });
  const headers = deviceHtmlHeaders();
  if (status === 429) headers.set("retry-after", "60");
  return new Response(html, { status, headers });
}

/** The code has gone: expired, already used, or the page is out of date. A Locker page with the
 *  way on (type the code the device shows now), never a bare JSON error: the people who reach it
 *  pressed a button in a browser. `status` is the refusal's own (404 gone, 403 stale form). */
export function deviceGonePage(
  product: Product | null,
  status: 403 | 404,
  kind: "expired" | "stale" = "expired",
  view: PageView = {},
): Response {
  const expired = kind === "expired";
  const shown = pageApp(view.app ?? { name: product?.name ?? "" });
  const html = renderAuthCard({
    ...(view.tv ? { variant: "tv" as const } : {}),
    title: expired ? "That code expired" : "This page is out of date",
    heading: expired ? "That code expired" : "This page is out of date",
    ...(product
      ? {
          header: appHeader({
            name: product.name,
            iconUrl: shown.app.iconUrl,
          }),
        }
      : {}),
    body:
      (expired
        ? callout(
            "clock",
            "Your device shows a new code",
            "Codes last 10 minutes.",
          )
        : callout("info", "Enter the code again", "Nothing was signed in.")) +
      `<a class="button" href="/device">${expired ? "Enter the new code" : "Enter the code"}</a>`,
    footer: ENTRY_FOOTER,
  });
  return new Response(html, {
    status,
    headers: deviceHtmlHeaders(undefined, shown.imgOrigin),
  });
}

/** Deny: the code no longer works here and nothing signed in. */
export function deviceDeniedPage(
  product: Product,
  view: PageView = {},
): Response {
  const shown = pageApp(view.app ?? { name: product.name });
  const html = renderAuthCard({
    ...(view.tv ? { variant: "tv" as const } : {}),
    title: "Nothing was signed in",
    heading: "Nothing was signed in",
    header: appHeader({ name: product.name, iconUrl: shown.app.iconUrl }),
    body: callout(
      "check-circle",
      "You denied the request",
      "That code no longer works. You can close this page.",
    ),
  });
  return new Response(html, {
    status: 200,
    headers: deviceHtmlHeaders(undefined, shown.imgOrigin),
  });
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
  view: PageView = {},
): Response {
  return accountDisabledPage({
    app: view.app ?? { name: product.name },
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

/** The callback's "return to the app" page. `notice` is TRUSTED markup (I-17's join offer).
 *  `done` names the devices after a Replace: "Signed in on <this>. <replaced> was signed out." */
export function signedInPage(
  cookies: string[] = [],
  notice: string | null = null,
  view: PageView = {},
  done?: { thisDevice: string; replaced: string },
): Response {
  const shown = pageApp(view.app ?? { name: "" });
  // R1-09 — see the device-authorization page above: set the policy at the sink as well as in
  // the dispatcher backstop.
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
    { imgOrigin: shown.imgOrigin },
  );
  for (const c of cookies) headers.append("set-cookie", c);
  const lede = done
    ? `<p>Signed in on ${escapeHtml(isolate(done.thisDevice))}. ${escapeHtml(isolate(done.replaced))} was signed out.</p>`
    : "";
  return new Response(
    renderAuthCard({
      title: "Signed in",
      heading: "You're signed in",
      ...(view.tv ? { variant: "tv" as const } : {}),
      ...(view.app?.name
        ? {
            header: appHeader({
              name: view.app.name,
              iconUrl: shown.app.iconUrl,
            }),
          }
        : {}),
      body: `${lede}<p class="muted">You can close this tab and return to the app.</p>${notice ?? ""}`,
    }),
    { status: 200, headers },
  );
}
