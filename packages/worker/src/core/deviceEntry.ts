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
import { clientNetwork, clientWideNetwork, rateLimitOk } from "./rateLimit.js";
import {
  callout,
  icon,
  note,
  renderAuthCard,
  DEVICE_CARD_LINKS,
} from "./brandHtml.js";
import { brandedHtmlSecurityHeaders } from "./securityHeaders.js";

const MISS =
  "No device is waiting for that code. Check your device's screen: codes last 10 minutes.";
const LIMITED = "The code on your device still works until it expires.";

/** How long the 429 tells the person to wait: the `retry-after` the page sends. */
const ENTRY_RETRY_SECONDS = 60;

/** "1 minute", "2 minutes", or seconds under a minute. */
function waitText(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const m = Math.ceil(seconds / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

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

/** Too many tries: a neutral callout that gives the time to try again, and nothing to press (a
 *  button could only reload into the same 429). */
export function tooManyBody(seconds: number = ENTRY_RETRY_SECONDS): string {
  // The catalog's `signin.rateLimited` with the time the page's `retry-after` states, said once.
  return callout(
    "clock",
    `Too many codes. Try again in ${waitText(seconds)}.`,
    LIMITED,
  );
}

function page(
  tv: boolean,
  status: 200 | 404 | 429,
  typed: string | null = null,
): Response {
  const path = tv ? "/tv" : "/device";
  const html = renderAuthCard({
    links: DEVICE_CARD_LINKS,
    title: "Enter your code",
    heading: "Enter the code from your device",
    ...(tv ? { variant: "tv" as const } : {}),
    body:
      status === 429
        ? tooManyBody()
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
  if (status === 429) headers.set("retry-after", String(ENTRY_RETRY_SECONDS));
  return new Response(html, { status, headers });
}

/**
 * The coarser ceiling beside each device-code entry bucket: the per-network bucket (IPv4 address
 * or IPv6 /64) is cheap to spread across a site's addresses, so every entry path also counts the
 * IPv4 /24 or IPv6 /48. Generous enough that a shared network of real players never meets it.
 */
export const DEVICE_ENTRY_WIDE_LIMIT = 300;
export const DEVICE_ENTRY_WIDE_WINDOW_SEC = 60;

/** A live code, found on the customer host: serve the rest of the sign-in there. `code` is the
 *  formatted user code. */
export type DeviceEntryHit = (slug: string, code: string) => Promise<Response>;

/**
 * Only a person's own navigation starts a sign-in: Fetch Metadata that says so (`same-origin`: the
 * code form; `none`: the device's link, a typed address, a bookmark), a `navigate` of a `document`,
 * and no speculative purpose. Anything else (no metadata at all, a link scanner or unfurler, a
 * cross-site or same-site link, a prefetch) gets the form with the code filled in, unspent.
 * Residual: a sandbox that drives a real browser sends `none` like a person does.
 */
function startsSignIn(req: Request): boolean {
  const h = req.headers;
  const site = h.get("sec-fetch-site");
  if (site !== "same-origin" && site !== "none") return false;
  if (h.get("sec-fetch-mode") !== "navigate") return false;
  if (h.get("sec-fetch-dest") !== "document") return false;
  if (h.has("sec-purpose") || h.has("purpose")) return false;
  if (/preview/i.test(h.get("x-purpose") ?? "")) return false;
  if (h.has("x-moz")) return false;
  return true;
}

export async function handleDeviceEntry(
  req: Request,
  env: Env,
  tv: boolean,
  now: number = Math.floor(Date.now() / 1000),
  onHit: DeviceEntryHit | null = null,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  const raw = new URL(req.url).searchParams.get("user_code");
  if (!raw?.trim()) return page(tv, 200);
  // Where a hit starts the sign-in itself (the customer host), a request that did not come from
  // this page or the device's own link gets the form instead: a state change never rides a
  // cross-site navigation or a prefetch.
  if (onHit && (req.method === "HEAD" || !startsSignIn(req)))
    return page(tv, 200, typedCode(raw));

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
  if (!ok) return page(tv, 429);
  const wideOk = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "deviceEntryWide",
      id: clientWideNetwork(req),
      limit: DEVICE_ENTRY_WIDE_LIMIT,
      windowSec: DEVICE_ENTRY_WIDE_WINDOW_SEC,
    },
    now,
  );
  if (!wideOk) return page(tv, 429);

  const code = normalizeUserCode(raw);
  const slug = await lookupDeviceCode(env, code ?? DUMMY_CODE);
  if (!code || !slug || !SLUG.test(slug)) return page(tv, 404, typedCode(raw));

  // The customer host carries on here: the product's page runs on this host, so the person never
  // leaves it (the dispatcher builds that request from the slug, never from the query).
  if (onHit) return onHit(slug, formatUserCode(code));

  return new Response(null, {
    status: 302,
    headers: {
      // Relative: the same host the visitor is on, whatever it is called.
      location: `/${slug}/identity/auth/device?user_code=${formatUserCode(code)}${tv ? "&tv=1" : ""}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
