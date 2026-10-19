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

import type { Env } from "../platform/env.js";
import { escapeHtml } from "../platform/html.js";
import {
  formatUserCode,
  lookupDeviceCode,
  normalizeUserCode,
} from "./deviceCodeIndex.js";
import { methodNotAllowed } from "./errors.js";
import { clientNetwork, rateLimitOk } from "./rateLimit.js";
import { renderBrandPage } from "./brandHtml.js";
import { brandedHtmlSecurityHeaders } from "./securityHeaders.js";

/** Lookups per client network per minute. 20^8 codes over a ten-minute life is what bounds a blind guess. */
export const DEVICE_ENTRY_LIMIT = 30;

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

export async function handleDeviceEntry(
  req: Request,
  env: Env,
  tv: boolean,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  const raw = new URL(req.url).searchParams.get("user_code");
  if (!raw?.trim()) return page(tv, 200, null);

  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "deviceEntry",
      id: clientNetwork(req),
      limit: DEVICE_ENTRY_LIMIT,
      windowSec: 60,
    },
    now,
  );
  if (!ok) return page(tv, 429, LIMITED);

  const code = normalizeUserCode(raw);
  const slug = await lookupDeviceCode(env, code ?? DUMMY_CODE);
  if (!code || !slug || !SLUG.test(slug)) return page(tv, 404, MISS);

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
