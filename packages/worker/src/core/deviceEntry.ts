/// <reference types="@cloudflare/workers-types" />

// `GET /device` and `GET /tv`: the platform-level device-code entry pages.
//
// The product-scoped page (`/<slug>/identity/auth/device`) needs the product in the URL. An app
// that cannot build that URL (a UI kit's fallback link, a TV) sends people here instead: they
// type the code, the Worker finds the product that issued it (`deviceCodeIndex.ts`) and 302s to
// that product's page, which owns every later state (identity off, product disabled, expired
// flow). This page decides nothing about the product, so it redirects whatever the product's
// state is.
//
// A miss never says anything about products: one generic line, and a hit costs the same one
// store read as a miss (a malformed code reads a fixed dummy key). Lookups are rate limited per
// client network. The code rides in the query string, so the page is never cached and never sent
// onward as a Referer, and no code is logged here.
//
// On the customer host (LK-04, plans/LK-00.md §7.9) the page does not hand the visitor on to the
// product's page on the API host: `serve` (the composition root) runs the product's own device
// handler on THIS host, so the confirmation, its CSRF token and the sign-in request binder all
// live on the customer host. A POST (the entry form's or the confirmation's) is accepted only
// there.

import type { Env } from "../platform/env.js";
import { escapeHtml } from "../platform/html.js";
import {
  formatUserCode,
  lookupDeviceCode,
  normalizeUserCode,
} from "./deviceCodeIndex.js";
import { errorResponse, methodNotAllowed } from "./errors.js";
import { readBodyText } from "./cappedBody.js";
import { clientNetwork, rateLimitOk } from "./rateLimit.js";
import { renderBrandPage } from "./brandHtml.js";
import { brandedHtmlSecurityHeaders } from "./securityHeaders.js";

const MISS = "That code didn't match or has expired. Check it and try again.";
const LIMITED = "Too many tries. Wait a minute and try again.";

/** Read for malformed input, so it costs the same store read as a real lookup. */
const DUMMY_CODE = "BBBBBBBB";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function page(
  tv: boolean,
  status: 200 | 404 | 429,
  note: string | null,
): Response {
  const path = tv ? "/tv" : "/device";
  const html = renderBrandPage({
    title: "Enter your code",
    heading: "Enter your code",
    surface: "device",
    ...(tv ? { variant: "tv" as const } : {}),
    body:
      `<p>Enter the code your app shows.</p>` +
      (note ? `<p class="alert" role="alert">${escapeHtml(note)}</p>` : "") +
      `<form method="get" action="${path}">` +
      `<label for="user_code">Code</label>` +
      `<input id="user_code" name="user_code" type="text" required autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="XXXX-XXXX">` +
      `<button class="button" type="submit">Continue</button></form>`,
  });
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }),
  );
  if (status === 429) headers.set("retry-after", "60");
  return new Response(html, { status, headers });
}

/** Run the product's device page for a live code on this host (the customer host's). `body` is
 *  the form of a POST, already read, else null. */
export type ServeDevicePage = (
  slug: string,
  userCode: string,
  body: string | null,
) => Promise<Response>;

export async function handleDeviceEntry(
  req: Request,
  env: Env,
  tv: boolean,
  now: number = Math.floor(Date.now() / 1000),
  serve: ServeDevicePage | null = null,
): Promise<Response> {
  const post = req.method === "POST" && serve !== null;
  if (req.method !== "GET" && req.method !== "HEAD" && !post)
    return methodNotAllowed();
  let body: string | null = null;
  let raw: string | null;
  if (post) {
    // The forms post `application/x-www-form-urlencoded`; anything else reads as no code.
    body = await readBodyText(req.clone(), 4096).catch(() => "");
    raw = new URLSearchParams(body).get("user_code");
    if (!raw?.trim()) return page(tv, 200, null);
  } else {
    raw = new URL(req.url).searchParams.get("user_code");
    if (!raw?.trim()) return page(tv, 200, null);
  }

  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "deviceEntry",
      id: clientNetwork(req),
      // 30 a minute per network: 20^8 codes over a ten-minute life is what bounds a blind guess.
      limit: 30,
      windowSec: 60,
    },
    now,
  );
  if (!ok) return page(tv, 429, LIMITED);

  const code = normalizeUserCode(raw);
  const slug = await lookupDeviceCode(env, code ?? DUMMY_CODE);
  if (!code || !slug || !SLUG.test(slug)) {
    // A confirmation POST for a code that has gone away is a refused confirmation, as on the
    // product's own page.
    if (post && new URLSearchParams(body ?? "").has("csrf"))
      return errorResponse(403, "forbidden", "confirmation failed");
    return page(tv, 404, MISS);
  }
  if (serve) return serve(slug, formatUserCode(code), body);

  return new Response(null, {
    status: 302,
    headers: {
      // Relative: the same host the visitor is on, whatever it is called.
      location: `/${slug}/identity/auth/device?user_code=${formatUserCode(code)}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
