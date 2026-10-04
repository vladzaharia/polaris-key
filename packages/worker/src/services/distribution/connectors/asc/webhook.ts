/**
 * `POST /<product>/distribution/hooks/asc` — App Store Connect webhook notifications (P5-02;
 * notes/E1 §A1). The pattern is the GitHub webhook's (`src/githubWebhook.ts`): HMAC over the raw
 * body, constant-time compare, delivery dedupe in KV for 7 days.
 *
 * In order, and why:
 *
 *   1. **Configured?** The product must declare an `app-store`/`testflight` outlet with an
 *      `appleId`, hold an `asc-api-key` PINNED to that `appleId` (P5-02f: a manifest naming
 *      another app than the operator pinned mirrors nothing) and an `asc-webhook-secret`
 *      credential. Otherwise the
 *      route answers `null` — Core's service not-found shape — exactly as it does with
 *      Distribution off: a product without the connector looks like one without Distribution. (A
 *      product with it answers step 2's 401, so its existence is not hidden.)
 *   2. **Signature shape** — `x-apple-signature: hmacsha256=<64 hex>`. A missing header or another
 *      prefix is refused 401 BEFORE anything is opened or counted.
 *   3. **Body** read raw, at most 64 KiB (413 past it): the HMAC is over these exact bytes.
 *   4. **Rate limit** (`ascWebhook`, per product, fail closed) BEFORE the secret is opened: every
 *      open is an audit row and a D1 write (P5-01), so an unauthenticated flood must hit the
 *      limiter, not the vault.
 *   5. **Open `asc-webhook-secret`** (audited `asc:webhook`) and verify; a mismatch is 401.
 *   6. **Dedupe on `data.id`** — KV first (7 days), the events table second. A redelivery answers
 *      200 `{duplicate: true}` and changes nothing: no row, no audit, no API call.
 *   7. **Answer fast, then work.** The response goes back as soon as the event is stored; the
 *      follow-up GET and the writes run after it (`waitUntil` when the runtime gives one, inline
 *      otherwise — the tests). The webhook is a HINT: the instance is re-read from the API and
 *      only what the API says is written (`apply.ts`). A failure is recorded on the event row and
 *      the KV marker is dropped, so a manual redelivery can try again; the poll tick re-drives a
 *      `failed` row, and a `received` row whose follow-up was cut off, for 24 hours (`poll.ts`).
 *      A delivery refused before it was stored (401, 413, 429) is not re-driven: see
 *      THREAT-MODEL.md, the ASC section's Lost follow-ups and Residual.
 *
 * Unknown event types answer 204 and are stored with outcome `ignored` — this Worker writes no
 * runtime log (R12), so the events table is the log. Beta feedback, the three alternative-
 * distribution events and Apple's ping are stored raw with outcome `stored`, as is an event whose
 * object was read but writes nothing because a newer one speaks for its row (an older TestFlight
 * build of the same release).
 */

import type { ServiceContext } from "../../../../core/registry.js";
import { errorResponse, json } from "../../../../core/errors.js";
import { kvKey } from "../../../../core/platform.js";
import { rateLimitOk } from "../../../../core/rateLimit.js";
import { openOutletCredential } from "../../../../core/outletCredentials.js";
import {
  eventSeen,
  recordEvent,
  setEventOutcome,
  type ConnectorEventOutcome,
} from "../state.js";
import { eventOutcomeOf, syncEventInstance, type AscRun } from "./apply.js";
import type { FetchImpl } from "../../../../core/asc/client.js";
import {
  ASC_EVENT_EFFECTS,
  ASC_PING_TYPE,
  INSTANCE_TYPES,
  eventTypeOf,
  instanceOf,
  isBackgroundAssetInstanceType,
  type AscEventEffect,
} from "./map.js";
import { ascRun, finishRun } from "./run.js";
import { ASC_CONNECTOR, ascSetup } from "./setup.js";

/** How long a processed `data.id` is remembered (7 days, as for GitHub deliveries). */
export const ASC_DELIVERY_TTL_SECONDS = 604_800;
/** An ASC webhook body is a thin JSON:API envelope; 64 KiB is generous. */
export const MAX_WEBHOOK_BODY = 64 * 1024;
/** Deliveries per product per minute before the secret is even opened. */
export const ASC_WEBHOOK_RATE = { limit: 60, windowSec: 60 } as const;

const SIGNATURE = /^hmacsha256=([0-9a-fA-F]{64})$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** The presented MAC from `x-apple-signature`, or `null` when missing or not `hmacsha256=`. */
export function parseSignature(header: string | null): Uint8Array | null {
  const m = header?.trim().match(SIGNATURE);
  return m?.[1] ? hexToBytes(m[1]) : null;
}

/** HMAC-SHA256(secret, body) compared in constant time with the presented MAC. */
export async function signatureMatches(
  secret: string,
  body: Uint8Array,
  presented: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body as BufferSource),
  );
  return timingSafeEqual(mac, presented);
}

const unauthorized = () =>
  errorResponse(401, "unauthorized", "invalid webhook signature");

async function readBody(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY) return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  return buf.byteLength > MAX_WEBHOOK_BODY ? null : buf;
}

function deliveryKey(product: string, id: string): string {
  return kvKey(product, "asc-delivery", id);
}

export interface AscWebhookOptions {
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

export async function handleAscWebhook(
  ctx: ServiceContext,
  opts: AscWebhookOptions = {},
): Promise<Response | null> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "POST") return null;
  const slug = product.slug;
  const setup = await ascSetup(env, db, slug);
  if (!setup || !setup.webhookSecretId) return null;

  const presented = parseSignature(req.headers.get("x-apple-signature"));
  if (!presented) return unauthorized();
  const body = await readBody(req);
  if (!body)
    return errorResponse(413, "body_too_large", "webhook body too large");
  if (
    !(await rateLimitOk(
      env,
      slug,
      { bucket: "ascWebhook", id: "asc", ...ASC_WEBHOOK_RATE },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many webhook deliveries");

  const secret = await openOutletCredential(
    env,
    db,
    slug,
    setup.webhookSecretId,
    "asc:webhook",
    { kind: "asc-webhook-secret", now },
  );
  if (
    !secret ||
    !(await signatureMatches(secret.value.secret, body, presented))
  )
    return unauthorized();

  const raw = new TextDecoder().decode(body);
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (
      !parsed.data ||
      typeof parsed.data !== "object" ||
      Array.isArray(parsed.data)
    )
      throw new Error("no data");
    data = parsed.data as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_request", "body must be a webhook payload", {
      reason: "bad_body",
    });
  }
  const eventId = data.id;
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    eventId.length > 128
  )
    return errorResponse(400, "bad_request", "data.id is required", {
      reason: "bad_body",
    });

  // A delivery whose processing failed dropped its KV marker and may be redelivered by hand;
  // anything else seen before is a duplicate.
  const kvk = deliveryKey(slug, eventId);
  const seen = await eventSeen(db, slug, ASC_CONNECTOR, eventId);
  if (
    (await env.HOT.get(kvk)) !== null ||
    (seen !== null && seen.outcome !== "failed")
  )
    return json({ ok: true, duplicate: true });
  await env.HOT.put(kvk, "1", { expirationTtl: ASC_DELIVERY_TTL_SECONDS });

  const write = { db, product: slug, now };
  const dataType = typeof data.type === "string" ? data.type : "(none)";
  const instance = instanceOf(data);
  const eventType = eventTypeOf(data.type);
  const base = {
    id: eventId,
    type: eventType ?? dataType,
    instanceType: instance?.type ?? null,
    instanceId: instance?.id ?? null,
    raw,
  };

  if (!eventType) {
    const known = dataType === ASC_PING_TYPE;
    await recordEvent(write, ASC_CONNECTOR, {
      ...base,
      outcome: known ? "stored" : "ignored",
    });
    return known ? json({ ok: true }) : new Response(null, { status: 204 });
  }
  const effect = ASC_EVENT_EFFECTS[eventType];
  if (effect === "store-only") {
    await recordEvent(write, ASC_CONNECTOR, { ...base, outcome: "stored" });
    return json({ ok: true });
  }
  if (!instance || !INSTANCE_TYPES[effect].includes(instance.type)) {
    await recordEvent(write, ASC_CONNECTOR, { ...base, outcome: "unresolved" });
    return json({ ok: true });
  }

  await recordEvent(write, ASC_CONNECTOR, { ...base, outcome: "received" });
  const run = ascRun({
    env,
    db,
    product: slug,
    hooks: ctx.hooks,
    now,
    setup,
    use: "asc:webhook",
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  const work = processEvent(run, effect, instance, eventId, kvk);
  if (ctx.waitUntil) ctx.waitUntil(work);
  else await work;
  return json({ ok: true });
}

/** The follow-up: GET the instance, write state, record the outcome. Never throws. */
async function processEvent(
  run: AscRun,
  effect: Exclude<AscEventEffect, "store-only">,
  instance: { type: string; id: string },
  eventId: string,
  kvk: string,
): Promise<void> {
  const write = { db: run.db, product: run.product, now: run.now };
  let outcome: ConnectorEventOutcome;
  let error: unknown = null;
  try {
    const applied = await syncEventInstance(run, effect, instance);
    outcome = eventOutcomeOf(applied);
  } catch (e) {
    error = e;
    outcome = "failed";
  }
  try {
    await setEventOutcome(write, ASC_CONNECTOR, eventId, outcome);
    if (outcome === "failed") await run.env.HOT.delete(kvk);
    await finishRun(run, error);
  } catch {
    /* the event row still says `received`; the poller re-drives it (`poll.ts`) */
  }
}
