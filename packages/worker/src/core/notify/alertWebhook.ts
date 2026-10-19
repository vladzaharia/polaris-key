/// <reference types="@cloudflare/workers-types" />

/**
 * Outbound alert webhooks (ST-27): the URL guard, the signature and the one POST.
 *
 * The URL is SSRF-shaped: an operator writes it and the Worker dials it with a signed body. Two
 * guards must both accept it (THREAT-MODEL, "Notification destinations"):
 *
 *   - `guardUrl` (`core/safeFetch.ts`, the hosted-assets guard): https only, no userinfo, port
 *     443, no IP literal, no single-label host, not `plrs.im` or any of the names that only
 *     resolve privately, at most 2048 characters;
 *   - `outboundUrlProblem` (`core/outboundGuard.ts`, the custom-OIDC guard): the manifest
 *     package's reserved-range check on the origin.
 *
 * REDIRECTS ARE REFUSED, not followed. A webhook endpoint that answers 3xx is a configuration
 * mistake, and following it would let a public host aim the signed request at an address the
 * guard never saw. The status is recorded as `refused`.
 *
 * ── THE SIGNATURE ───────────────────────────────────────────────────────────────────────────
 *
 * The Standard Webhooks scheme (SP-66 adopts it; ST-27 signs the same way until then):
 *
 *   webhook-id         msg_<random>, unique per delivery (a receiver dedupes on it)
 *   webhook-timestamp  seconds since the epoch (a receiver rejects a stale one)
 *   webhook-signature  v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">
 *
 * The key is the destination's secret, `whsec_<base64 of 24 random bytes>`; the HMAC key is the
 * decoded bytes. The secret is generated here, sealed with the URL (`alertDestinations.ts`),
 * shown to the operator once, at creation or rotation, and never again.
 */

import { outboundUrlProblem } from "../outboundGuard.js";
import { guardUrl } from "../safeFetch.js";
import {
  base64Decode,
  base64Encode,
  toArrayBuffer,
} from "../../platform/bytes.js";
import { randomBytes } from "../../platform/random.js";
import { randomId } from "../../platform/crypto.js";

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_SECRET_PREFIX = "whsec_";
const UA = "PolarisKey-Alerts/1";

/** Why `raw` may not be a webhook URL, or `null`. Both guards, on the whole URL. */
export function webhookUrlProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return "required";
  const url = raw.trim();
  const g = guardUrl(url);
  if (g) return g === "scheme" ? "https-only" : g;
  const o = outboundUrlProblem(url);
  return o ? "private-or-reserved" : null;
}

/** The URL as stored: parsed and re-serialised, fragment dropped. Call after `webhookUrlProblem`. */
export function normaliseWebhookUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = "";
  return u.toString();
}

/** What a list may show of a webhook URL: the origin. The path and query can hold a token. */
export function webhookDisplay(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return "";
  }
}

/** A fresh signing secret, `whsec_` + 24 random bytes in base64. */
export function newWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + base64Encode(randomBytes(24));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const raw = secret.startsWith(WEBHOOK_SECRET_PREFIX)
    ? secret.slice(WEBHOOK_SECRET_PREFIX.length)
    : secret;
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64Decode(raw)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** The `webhook-signature` value for one delivery. */
export async function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    toArrayBuffer(new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return `v1,${base64Encode(new Uint8Array(sig))}`;
}

export type WebhookOutcome = "ok" | "failed" | "refused";

export interface WebhookDeps {
  /** A test seam; the global `fetch` otherwise. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface WebhookResult {
  outcome: WebhookOutcome;
  /** What an operator can act on. Host and status only: never the path, a query or the secret. */
  detail: string | null;
}

/**
 * POST `payload` to `url`, signed with `secret`. The URL is re-checked on every delivery (a
 * stored URL is not trusted because it was valid once). Never throws. `refused`: the guard
 * refused the URL, or the endpoint redirected.
 */
export async function postWebhookResult(
  url: string,
  secret: string,
  payload: unknown,
  now: number,
  deps: WebhookDeps = {},
): Promise<WebhookResult> {
  if (webhookUrlProblem(url) !== null)
    return { outcome: "refused", detail: "Address not allowed" };
  const host = new URL(url).hostname;
  const body = JSON.stringify(payload);
  const id = randomId("msg");
  try {
    const res = await (deps.fetchImpl ?? ((i, n) => fetch(i, n)))(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": UA,
        "webhook-id": id,
        "webhook-timestamp": String(now),
        "webhook-signature": await signWebhook(secret, id, now, body),
      },
      body,
    });
    await res.body?.cancel().catch(() => undefined);
    if (
      (res.status >= 300 && res.status < 400) ||
      (res.type as string) === "opaqueredirect"
    )
      return { outcome: "refused", detail: `Redirect refused by ${host}` };
    if (res.status >= 200 && res.status < 300)
      return { outcome: "ok", detail: null };
    return { outcome: "failed", detail: `HTTP ${res.status} from ${host}` };
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    return {
      outcome: "failed",
      detail:
        name === "TimeoutError" || name === "AbortError"
          ? `Timed out after ${WEBHOOK_TIMEOUT_MS / 1000} s`
          : `Could not reach ${host}`,
    };
  }
}

export async function postWebhook(
  url: string,
  secret: string,
  payload: unknown,
  now: number,
  deps: WebhookDeps = {},
): Promise<WebhookOutcome> {
  return (await postWebhookResult(url, secret, payload, now, deps)).outcome;
}
