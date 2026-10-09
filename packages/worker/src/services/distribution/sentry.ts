/**
 * `POST /<product>/distribution/hooks/sentry` — a Sentry alert opens a HALT CANDIDATE that an
 * operator confirms (P6-03, README §3.9). Sentry never halts anything by itself.
 *
 * Sentry's internal integrations sign every webhook with the integration's client secret:
 * `Sentry-Hook-Signature` is the hex HMAC-SHA256 of the raw body. The secret is an outlet
 * credential of kind `sentry-integration` (P5-01 custody: sealed, platform-admin writes only,
 * every open audited). The pattern is the App Store Connect webhook's (`connectors/asc/
 * webhook.ts`), in the same order and for the same reasons:
 *
 *   1. **Configured?** The product must hold an active `sentry-integration` credential (the
 *      lowest id wins). Otherwise `null` — Core's service not-found shape, as with Distribution
 *      off.
 *   2. **Signature shape**: 64 hex characters, or 401 before anything is opened or counted.
 *   3. **Body** read raw, at most 64 KiB (413).
 *   4. **Rate limit** (`sentryWebhook`, per product, fail closed) BEFORE the secret is opened.
 *   5. **Open** the credential (audited `sentry:webhook`), verify in constant time; 401 on a
 *      mismatch.
 *   6. **Dedupe** on the body's SHA-256 (`dist_connector_events`, connector `sentry`): a
 *      redelivery answers 200 `{duplicate: true}` and changes nothing.
 *      What that table keeps of a delivery, whatever its outcome, is a REDUCED record —
 *      `{resource, action, rule, issueId, release, environment, outlet}` — never the body, which
 *      carries the crash message, exception, user and tags.
 *   7. **Map** an `event_alert` that `triggered` to rollouts: the event's `release` is
 *      `<deliverable>@<version>[+<build>]` (the SDK tagging convention, docs page
 *      `/docs/services/distribution/update-health/`), `environment` the channel, the
 *      `pkey.outlet` tag the outlet (optional: without it every self-hosted rollout of that
 *      release on that channel is a candidate). The version is resolved to a release id through
 *      Release's catalog hook. Each matching `active` or `paused`, NON-mirrored rollout gets one
 *      `halt-candidate` (a repeated alert bumps its count; a confirmed or dismissed candidate is
 *      not reopened). Any other resource (`issue`, `metric_alert`, `installation`, …) is stored
 *      as `ignored` and answered 204; an alert that maps to nothing is stored as `unresolved`.
 *
 * A candidate is confirmed or dismissed by a platform admin in the console
 * (`updateHealthAdmin.ts`); confirming halts through P2b-04's one implementation as that admin,
 * so the halt is audited with the operator's subject. What a candidate keeps of the alert is the
 * rule name and Sentry's numeric issue id — never the event's message, user or tags beyond the
 * mapping, so no crash payload is stored (docs/PRIVACY.md).
 */

import {
  constantTimeEqualBytes,
  hexDecode,
  hexEncode,
  hmacSha256,
  importHmacKey,
  sha256Hex,
  type Db,
} from "../../core/platform.js";
import type { ServiceContext } from "../../core/registry.js";
import type { ServiceHooks } from "../../core/hooks.js";
import type { AdminSession } from "../../core/adminApi.js";
import { audit } from "../../core/adminApi.js";
import { errorResponse, json } from "../../core/errors.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import {
  listOutletCredentials,
  openOutletCredential,
} from "../../core/outletCredentials.js";
import { applyRollout, listRollouts, type RolloutRefusal } from "./rollouts.js";
import {
  auditConnector,
  eventSeen,
  getObject,
  listObjects,
  objectView,
  recordEvent,
  upsertObject,
} from "./connectors/state.js";
import { BodyTooLargeError, readBodyBytes } from "../../core/cappedBody.js";

export const SENTRY_CONNECTOR = "sentry";
export const SENTRY_LABEL = "Sentry";
export const CANDIDATE_OBJECT = "halt-candidate";
export const SENTRY_CREDENTIAL_KIND = "sentry-integration" as const;

/** A Sentry webhook body is a few KiB; 64 KiB is generous. */
export const MAX_SENTRY_BODY = 64 * 1024;
/** Deliveries per product per minute before the secret is even opened. */
export const SENTRY_WEBHOOK_RATE = { limit: 60, windowSec: 60 } as const;

const SIGNATURE = /^[0-9a-fA-F]{64}$/;
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OUTLET = /^[a-z][a-z0-9-]{0,63}$/;
const DELIVERABLE = /^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const ISSUE_ID = /^[0-9]{1,20}$/;

// ── Setup ────────────────────────────────────────────────────────────────────────────────────

/** The product's `sentry-integration` credential id, or `null`: the hook does not run. Only
 *  metadata is read; nothing is opened. */
export async function sentryCredentialId(
  db: Db,
  product: string,
): Promise<string | null> {
  const creds = (await listOutletCredentials(db, product)).filter(
    (c) => c.kind === SENTRY_CREDENTIAL_KIND && c.status === "active",
  );
  return creds[0]?.id ?? null;
}

// ── Signature ────────────────────────────────────────────────────────────────────────────────

/** The presented MAC, or `null` when the header is missing or not 64 hex characters. */
export function parseSentrySignature(header: string | null): Uint8Array | null {
  const v = header?.trim();
  return v && SIGNATURE.test(v) ? hexDecode(v) : null;
}

/** HMAC-SHA256(secret, body), hex — what Sentry sends. Exported for the tests' signer. */
export async function sentrySignature(
  secret: string,
  body: Uint8Array,
): Promise<string> {
  return hexEncode(await sentryMac(secret, body));
}

/** The raw HMAC-SHA256(secret, body). */
async function sentryMac(
  secret: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  return hmacSha256(await importHmacKey(secret), body);
}

// ── Mapping ──────────────────────────────────────────────────────────────────────────────────

/** `<deliverable>@<version>[+<build>]` → its parts, or `null`. */
export function parseSentryRelease(
  release: unknown,
): { deliverable: string; version: string; build: string | null } | null {
  if (typeof release !== "string" || release.length > 200) return null;
  const at = release.indexOf("@");
  if (at <= 0) return null;
  const deliverable = release.slice(0, at);
  const rest = release.slice(at + 1);
  if (!DELIVERABLE.test(deliverable) || rest.length === 0) return null;
  const plus = rest.indexOf("+");
  const version = plus === -1 ? rest : rest.slice(0, plus);
  const build = plus === -1 ? null : rest.slice(plus + 1) || null;
  if (!version) return null;
  return { deliverable, version, build };
}

/** A tag's value from Sentry's event `tags` — `[[key, value], …]` or `[{key, value}, …]`. */
export function tagValue(tags: unknown, key: string): string | null {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === key && typeof t[1] === "string")
      return t[1];
    if (
      t &&
      typeof t === "object" &&
      !Array.isArray(t) &&
      (t as { key?: unknown }).key === key &&
      typeof (t as { value?: unknown }).value === "string"
    )
      return (t as { value: string }).value;
  }
  return null;
}

/** The release id a Sentry release names, through Release's catalog, or `null`. A version is
 *  matched exactly with its build first (`1.4.0+12`), then without it (`1.4.0`), then as a
 *  `v`-prefixed tag. */
async function resolveReleaseId(
  hooks: ServiceHooks,
  parsed: { deliverable: string; version: string; build: string | null },
): Promise<string | null> {
  const catalog = hooks.releaseCatalog();
  if (!catalog) return null;
  const releases = await catalog.releases(parsed.deliverable);
  const wanted = [
    ...(parsed.build ? [`${parsed.version}+${parsed.build}`] : []),
    parsed.version,
    `v${parsed.version}`,
  ];
  for (const w of wanted) {
    const hit = releases.find((r) => r.version === w || r.releaseId === w);
    if (hit) return hit.releaseId;
  }
  return null;
}

export async function candidateId(target: {
  deliverable: string;
  outlet: string;
  channel: string;
  releaseId: string;
}): Promise<string> {
  const key = `${target.deliverable}|${target.outlet}|${target.channel}|${target.releaseId}`;
  return `cand_${(await sha256Hex(key)).slice(0, 24)}`;
}

// ── The webhook ──────────────────────────────────────────────────────────────────────────────

const unauthorized = () =>
  errorResponse(401, "unauthorized", "invalid webhook signature");

async function readBody(req: Request): Promise<Uint8Array | null> {
  try {
    return await readBodyBytes(req, MAX_SENTRY_BODY);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return null;
    throw e;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function handleSentryWebhook(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, now, hooks } = ctx;
  if (req.method !== "POST") return null;
  const slug = product.slug;
  const credentialId = await sentryCredentialId(db, slug);
  if (!credentialId) return null;

  const presented = parseSentrySignature(
    req.headers.get("sentry-hook-signature"),
  );
  if (!presented) return unauthorized();
  const body = await readBody(req);
  if (!body)
    return errorResponse(413, "body_too_large", "webhook body too large");
  if (
    !(await rateLimitOk(
      env,
      slug,
      { bucket: "sentryWebhook", id: "sentry", ...SENTRY_WEBHOOK_RATE },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many webhook deliveries");

  const secret = await openOutletCredential(
    env,
    db,
    slug,
    credentialId,
    "sentry:webhook",
    { kind: SENTRY_CREDENTIAL_KIND, now },
  );
  if (!secret) return unauthorized();
  const expected = await sentryMac(secret.value.clientSecret, body);
  if (!constantTimeEqualBytes(expected, presented)) return unauthorized();

  const raw = new TextDecoder().decode(body);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObj(parsed)) throw new Error("not an object");
    payload = parsed;
  } catch {
    return errorResponse(400, "bad_request", "body must be a webhook payload", {
      reason: "bad_body",
    });
  }

  const eventId = `sha256:${(await sha256Hex(body)).slice(0, 48)}`;
  if (await eventSeen(db, slug, SENTRY_CONNECTOR, eventId))
    return json({ ok: true, duplicate: true });

  const write = { db, product: slug, now };
  const resource = (req.headers.get("sentry-hook-resource") ?? "")
    .trim()
    .slice(0, 64);
  const action =
    typeof payload.action === "string" ? payload.action.slice(0, 64) : "";
  const data = isObj(payload.data) ? payload.data : {};
  const event = isObj(data.event) ? data.event : {};
  const parsed = parseSentryRelease(event.release);
  const channel =
    typeof event.environment === "string" && CHANNEL.test(event.environment)
      ? event.environment
      : null;
  const outletTag = tagValue(event.tags, "pkey.outlet");
  const outlet = outletTag && OUTLET.test(outletTag) ? outletTag : null;
  const rule =
    typeof data.triggered_rule === "string"
      ? data.triggered_rule.slice(0, 200)
      : null;
  const issueId =
    typeof event.issue_id === "string" && ISSUE_ID.test(event.issue_id)
      ? event.issue_id
      : null;
  // What is STORED of a delivery, whatever its outcome: the mapping inputs, never the body. A
  // Sentry event carries the crash message, the exception, the user and every tag; none of it
  // is kept (docs/PRIVACY.md). The dedupe key is the body's hash, computed above.
  const reduced = JSON.stringify({
    resource: resource || null,
    action: action || null,
    rule,
    issueId,
    release: parsed
      ? `${parsed.deliverable}@${parsed.version}${parsed.build ? `+${parsed.build}` : ""}`
      : null,
    environment: channel,
    outlet,
  });
  const base = {
    id: eventId,
    type: `${resource || "(none)"}.${action || "(none)"}`,
    instanceType: null,
    instanceId: null,
    raw: reduced,
  };
  if (resource !== "event_alert" || action !== "triggered") {
    await recordEvent(write, SENTRY_CONNECTOR, { ...base, outcome: "ignored" });
    return new Response(null, { status: 204 });
  }

  const releaseId =
    parsed && channel ? await resolveReleaseId(hooks, parsed) : null;
  const targets =
    parsed && channel && releaseId
      ? (await listRollouts(db, slug)).filter(
          (r) =>
            r.deliverable_id === parsed.deliverable &&
            r.channel === channel &&
            r.release_id === releaseId &&
            (outlet === null || r.outlet_id === outlet) &&
            r.mirrored === 0 &&
            (r.state === "active" || r.state === "paused"),
        )
      : [];
  if (targets.length === 0) {
    await recordEvent(write, SENTRY_CONNECTOR, {
      ...base,
      outcome: "unresolved",
    });
    return json({ ok: true, candidates: 0 });
  }

  let opened = 0;
  for (const r of targets) {
    const target = {
      deliverable: r.deliverable_id,
      outlet: r.outlet_id,
      channel: r.channel,
      releaseId: r.release_id,
    };
    const id = await candidateId(target);
    const existing = await getObject(
      db,
      slug,
      SENTRY_CONNECTOR,
      CANDIDATE_OBJECT,
      id,
    );
    if (existing && existing.state !== "open") continue;
    const prior = existing ? objectView(existing).detail : {};
    const alerts = typeof prior.alerts === "number" ? prior.alerts + 1 : 1;
    await upsertObject(write, SENTRY_CONNECTOR, {
      type: CANDIDATE_OBJECT,
      id,
      outletId: r.outlet_id,
      releaseId: r.release_id,
      buildId: "",
      storeState: null,
      state: "open",
      ref: target,
      detail: {
        openedAt: typeof prior.openedAt === "number" ? prior.openedAt : now,
        lastAlertAt: now,
        alerts,
        rule,
        issueId,
      },
      terminal: false,
    });
    if (!existing) {
      opened++;
      await auditConnector(
        write,
        SENTRY_CONNECTOR,
        SENTRY_LABEL,
        "distribution.sentry.candidate",
        {
          kind: "rollout",
          id: `${r.deliverable_id}:${r.outlet_id}:${r.channel}`,
        },
        `Sentry alert${rule ? ` "${rule}"` : ""} opened a halt candidate for the ${r.outlet_id} rollout of ${r.release_id} on ${r.channel}; an operator must confirm it`,
      );
    }
  }
  await recordEvent(write, SENTRY_CONNECTOR, { ...base, outcome: "applied" });
  return json({ ok: true, candidates: opened });
}

// ── Candidates (the console) ─────────────────────────────────────────────────────────────────

export async function listCandidates(db: Db, product: string, limit = 50) {
  return (
    await listObjects(db, product, SENTRY_CONNECTOR, {
      types: [CANDIDATE_OBJECT],
      limit,
    })
  ).map(objectView);
}

export type CandidateResult =
  | { ok: true; candidate: ReturnType<typeof objectView> }
  | RolloutRefusal;

/**
 * Confirm (halt) or dismiss an open candidate, as a platform admin. Confirming halts through
 * `applyRollout` with the admin's session and the candidate's release pinned (`stale_release`
 * if the rollout moved on), so the halt's audit row carries the operator's subject; a refused
 * halt leaves the candidate open. Either decision is its own audit row.
 */
export async function decideCandidate(
  ctx: { db: Db; product: string; hooks: ServiceHooks; now: number },
  id: string,
  decision: "confirm" | "dismiss",
  session: AdminSession,
): Promise<CandidateResult> {
  const { db, product, now } = ctx;
  const row = await getObject(
    db,
    product,
    SENTRY_CONNECTOR,
    CANDIDATE_OBJECT,
    id,
  );
  if (!row)
    return {
      ok: false,
      status: 404,
      code: "not_found",
      reason: "unknown_candidate",
      message: "no such candidate",
    };
  const view = objectView(row);
  if (view.state !== "open")
    return {
      ok: false,
      status: 409,
      code: "bad_request",
      reason: "candidate_closed",
      message: `the candidate is already ${view.state}`,
    };
  const ref = view.ref as {
    deliverable: string;
    outlet: string;
    channel: string;
    releaseId: string;
  };
  if (decision === "confirm") {
    const result = await applyRollout(
      { db, product, hooks: ctx.hooks, now },
      "halt",
      {
        outlet: ref.outlet,
        channel: ref.channel,
        deliverable: ref.deliverable,
        releaseId: ref.releaseId,
      },
      { kind: "admin", session },
    );
    if (!result.ok) return result;
  }
  const state = decision === "confirm" ? "confirmed" : "dismissed";
  const { row: updated } = await upsertObject(
    { db, product, now },
    SENTRY_CONNECTOR,
    {
      type: CANDIDATE_OBJECT,
      id,
      outletId: view.outletId,
      releaseId: view.releaseId,
      buildId: "",
      storeState: null,
      state,
      ref: view.ref,
      detail: { ...view.detail, decidedAt: now, decidedBy: session.sub },
      terminal: true,
    },
  );
  await audit(
    db,
    product,
    session,
    now,
    `distribution.sentry.candidate.${decision}`,
    { kind: "rollout", id: `${ref.deliverable}:${ref.outlet}:${ref.channel}` },
    decision === "confirm"
      ? `Confirmed the Sentry halt candidate for the ${ref.outlet} rollout of ${ref.releaseId} on ${ref.channel}: halted`
      : `Dismissed the Sentry halt candidate for the ${ref.outlet} rollout of ${ref.releaseId} on ${ref.channel}`,
  );
  return { ok: true, candidate: objectView(updated) };
}
