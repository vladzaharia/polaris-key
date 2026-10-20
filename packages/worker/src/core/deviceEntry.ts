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
import { callout, icon, note, renderAuthCard } from "./brandHtml.js";
import { brandedHtmlSecurityHeaders } from "./securityHeaders.js";

const MISS =
  "No device is waiting for that code. Check your device's screen: codes last 10 minutes.";
const LIMITED_TITLE = "Too many codes tried";
const LIMITED =
  "Wait a minute, then try again. The code on your device still works until it expires.";

/** Read for malformed input, so it costs the same store read as a real lookup. */
const DUMMY_CODE = "BBBBBBBB";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What a person typed, kept for the form when the code misses: code characters only. */
export function typedCode(raw: string | null | undefined): string {
  const t = (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 32);
  // Eight characters read as the code's own shape.
  return /^[A-Z0-9]{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4)}` : t;
}

/** The footer of every code-entry page. */
export const ENTRY_FOOTER = {
  icon: "lock",
  text: "Polaris Locker signs you in on the device that shows this code.",
} as const;

/**
 * The code form: one field, the anti-phishing line and **Continue**. A miss keeps the typed code
 * and puts the reason under the field (never an alert above the form). `hidden` are extra
 * fields the form posts back.
 */
export function codeEntryBody(opts: {
  action: string;
  method: "get" | "post";
  typed?: string;
  miss?: boolean;
}): string {
  return (
    `<form method="${opts.method}" action="${escapeHtml(opts.action)}"><div class="field">` +
    `<label for="user_code">Code</label>` +
    `<input id="user_code" name="user_code" type="text" required autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="XXXX-XXXX"${opts.typed ? ` value="${escapeHtml(opts.typed)}"` : ""}${opts.miss ? ` aria-invalid="true" aria-describedby="user_code-err"` : ""}>` +
    (opts.miss
      ? `<p class="field-err" id="user_code-err">${icon("x-circle", true)}<span>${escapeHtml(MISS)}</span></p>`
      : "") +
    `</div>` +
    note(
      "shield",
      "Only use a code your own device shows, not one somebody sent you.",
    ) +
    `<button class="button" type="submit">Continue${icon("arrow-right")}</button></form>`
  );
}

/** Too many tries: a neutral callout instead of the form (nothing to press that cannot work
 *  yet), and a way back. */
export function tooManyBody(retryHref: string): string {
  return (
    callout("clock", LIMITED_TITLE, LIMITED) +
    `<a class="button secondary" href="${escapeHtml(retryHref)}">Try again</a>`
  );
}

function page(
  tv: boolean,
  status: 200 | 404 | 429,
  typed: string | null = null,
  productOrigin: string | null = null,
): Response {
  const path = tv ? "/tv" : "/device";
  const html = renderAuthCard({
    title: "Enter your code",
    heading: "Enter the code from your device",
    ...(tv ? { variant: "tv" as const } : {}),
    body:
      status === 429
        ? tooManyBody(path)
        : codeEntryBody({
            action: path,
            method: "get",
            typed: typed ?? "",
            miss: status === 404,
          }),
    footer: ENTRY_FOOTER,
  });
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }),
  );
  // On the customer host a found code redirects to the API host's product page; browsers apply
  // `form-action` to every redirect a submission follows, so name that one origin (configuration,
  // never the request), as the product device page does for its IdP.
  if (productOrigin) {
    const csp = headers.get("content-security-policy");
    if (csp)
      headers.set(
        "content-security-policy",
        csp.replace(
          "form-action 'self'",
          `form-action 'self' ${productOrigin}`,
        ),
      );
  }
  if (status === 429) headers.set("retry-after", "60");
  return new Response(html, { status, headers });
}

export async function handleDeviceEntry(
  req: Request,
  env: Env,
  tv: boolean,
  now: number = Math.floor(Date.now() / 1000),
  productOrigin: string | null = null,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  const raw = new URL(req.url).searchParams.get("user_code");
  if (!raw?.trim()) return page(tv, 200, null, productOrigin);

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
  if (!ok) return page(tv, 429, null, productOrigin);

  const code = normalizeUserCode(raw);
  const slug = await lookupDeviceCode(env, code ?? DUMMY_CODE);
  if (!code || !slug || !SLUG.test(slug))
    return page(tv, 404, typedCode(raw), productOrigin);

  return new Response(null, {
    status: 302,
    headers: {
      // Relative: the same host the visitor is on, whatever it is called. On the customer host
      // the product's page is on the API host, so `productOrigin` (configuration, never the
      // request) names it (LK-03).
      location: `${productOrigin ?? ""}/${slug}/identity/auth/device?user_code=${formatUserCode(code)}${tv ? "&tv=1" : ""}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
