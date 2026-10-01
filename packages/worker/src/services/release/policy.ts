/// <reference types="@cloudflare/workers-types" />

/**
 * Channel policy OPERATIONS (P2-05): promote, pin, unpin, yank, unyank, set a channel's floor
 * and critical flag, and hand a channel back to the manifest — one implementation, reached by
 * the console (`admin.ts`, a platform-admin session) and by CI (`routes.ts`, a `pkeyci_` token
 * with `release:promote` or `release:yank`).
 *
 * The rows and their source guard are P2-03's (`model.ts`); this module decides what an
 * operation MEANS, validates it against the truth store, writes it, audits it with its actor
 * (`admin:<sub>` or `ci:<subject>`), and invalidates the cached resolutions
 * (`ghCache.ts` `bumpReleaseGeneration`) so the next resolution sees the change. A public
 * product's edge-cached version check and appcasts lag by up to 120 s / 300 s per colo
 * (`gateway.ts` `releaseCacheKey`).
 *
 * ── NAMES ───────────────────────────────────────────────────────────────────────────────────
 *
 * Policy rows and operations use CANONICAL channel names only (P0-04 plan §10). A `staging`
 * route segment resolves to `beta` through the legacy alias table unless the product declares a
 * manual `staging` channel, and `staging` is never stored. A channel must be one the product can
 * actually serve — `stable`, `beta`, a declared manual channel, a `pr-<n>`, or a channel some
 * release of the product was published to — so a typo cannot mint a policy row nobody reads.
 *
 * ── WHAT EACH OPERATION DOES ────────────────────────────────────────────────────────────────
 *
 *   promote   pointer := release (the pin flag is left as it is, so promoting a pinned channel
 *             moves the pin). The release becomes a member of the channel (`resolve.ts` rule 1).
 *             A yanked release cannot be promoted: unyank it, or pin it explicitly.
 *   pin       pointer := release, pinned := 1. Yanked releases may be pinned (rule 2).
 *   unpin     pinned := 0; the pointer stays a member.
 *   yank      the release stops resolving on every moving selector, everywhere (rule 2).
 *   unyank    lifts the yank.
 *   update    the operator PUT: any of pointer, pinned, minSupported (the DEVICE floor, P2-03 —
 *             not P0-02's anti-rollback floor, which keeps its own `…/floor` endpoint) and
 *             critical.
 *   revert    hands the row back to the manifest; the next resync re-applies its declaration.
 *
 * Every write but `revert` claims the row for the operator (`source = 'admin'`), so a resync
 * never undoes it.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db, Env } from "../../core/platform.js";
import { randomId } from "../../core/platform.js";
import { appendAudit } from "../../core/data.js";
import { audit, type AdminSession } from "../../core/adminApi.js";
import { ciActor, type CiPrincipal } from "../../core/ciScope.js";
import { parseManualChannels } from "./channels.js";
import type { ReleaseConfigRow } from "./config.js";
import { bumpReleaseGeneration } from "./ghCache.js";
import {
  getChannelPolicy,
  getDeliverable,
  isYanked,
  revertChannelPolicyToManifest,
  setChannelPolicy,
  unyankRelease,
  yankRelease,
  type ChannelPolicyPatch,
  type ReleaseChannelPolicyRow,
  type ReleaseDeliverableRow,
} from "./model.js";
import {
  canonicalChannel,
  parsesInScheme,
  versionSchemeOf,
} from "./resolve.js";
import type { ReleaseMetadataRow } from "./store.js";

// ── Actors and results ───────────────────────────────────────────────────────────────────────

export type PolicyActor =
  | { kind: "admin"; session: AdminSession }
  | { kind: "ci"; principal: CiPrincipal };

/** `admin:<sub>` or `ci:<subject>` — what `modified_by` and the yank's `by` record. */
export function actorId(actor: PolicyActor): string {
  return actor.kind === "admin"
    ? `admin:${actor.session.sub}`
    : ciActor(actor.principal);
}

/** A refusal, in terms both the console and the CI routes can render. */
export interface PolicyRefusal {
  ok: false;
  status: 400 | 404 | 409 | 422;
  /** `ErrorCode` value: `not_found` or `bad_request`. */
  code: "not_found" | "bad_request";
  /** Machine-readable reason for CI (`unknown_channel`, `release_yanked`, …). */
  reason: string;
  message: string;
  fields?: string[];
}

export type PolicyResult<T> = ({ ok: true } & T) | PolicyRefusal;

function refuse(
  status: PolicyRefusal["status"],
  reason: string,
  message: string,
  fields?: string[],
): PolicyRefusal {
  return {
    ok: false,
    status,
    code: status === 404 ? "not_found" : "bad_request",
    reason,
    message,
    ...(fields ? { fields } : {}),
  };
}

/** Append one audit row for a policy change, attributed to its actor. */
async function auditChange(
  db: Db,
  product: string,
  actor: PolicyActor,
  now: number,
  action: string,
  target: { kind: string; id: string },
  summary: string,
): Promise<void> {
  if (actor.kind === "admin") {
    await audit(db, product, actor.session, now, action, target, summary);
    return;
  }
  await appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: ciActor(actor.principal),
    actor_name: "CI",
    actor_email: null,
    action,
    target_kind: target.kind,
    target_id: target.id,
    parent_id: null,
    summary,
  });
}

// ── Views ────────────────────────────────────────────────────────────────────────────────────

export interface ChannelPolicyView {
  deliverable: string;
  channel: string;
  pointer: string | null;
  pinned: boolean;
  includes: string[] | null;
  /** The device floor (P2-03). Stored and returned; enforced by the signed feed (P3-03). */
  minSupported: string | null;
  critical: boolean;
  /** `manifest` until an operator or CI changes it; `admin` from then on. */
  source: "manifest" | "admin";
  modifiedAt: number | null;
  modifiedBy: string | null;
}

export function policyView(
  row: ReleaseChannelPolicyRow | null,
  deliverable: string,
  channel: string,
): ChannelPolicyView {
  let includes: string[] | null = null;
  if (row?.includes_json) {
    try {
      const parsed: unknown = JSON.parse(row.includes_json);
      if (Array.isArray(parsed))
        includes = parsed.filter((c): c is string => typeof c === "string");
    } catch {
      includes = null;
    }
  }
  return {
    deliverable,
    channel,
    pointer: row?.pointer_release_id ?? null,
    pinned: row?.pinned === 1,
    includes,
    minSupported: row?.min_supported ?? null,
    critical: row?.critical === 1,
    source: row?.source ?? "manifest",
    modifiedAt: row?.modified_at ?? null,
    modifiedBy: row?.modified_by ?? null,
  };
}

// ── Lookups ──────────────────────────────────────────────────────────────────────────────────

/** The channels a product can serve: the built-ins, its manual rules, and any channel a release
 *  of it was published to. */
export async function knownChannels(
  db: Db,
  product: string,
  cfg: Pick<ReleaseConfigRow, "manual_channels_json"> | null,
): Promise<string[]> {
  const manual = parseManualChannels(cfg?.manual_channels_json);
  const published = await db.all<{ channel: string }>(
    `SELECT DISTINCT channel FROM release_metadata
      WHERE product = ? AND channel IS NOT NULL ORDER BY channel ASC`,
    product,
  );
  const out = new Set<string>(["stable", "beta"]);
  for (const m of manual) out.add(m.name);
  for (const p of published) {
    const c = canonicalChannel(p.channel, manual);
    if (c) out.add(c);
  }
  return [...out];
}

/**
 * Resolve a route's channel segment to the canonical channel a policy row is keyed by, or a
 * refusal. `staging` → `beta` unless a manual `staging` exists; `latest` → `stable`.
 */
export async function resolvePolicyChannel(
  db: Db,
  product: string,
  cfg: Pick<ReleaseConfigRow, "manual_channels_json"> | null,
  raw: string,
): Promise<PolicyResult<{ channel: string }>> {
  const manual = parseManualChannels(cfg?.manual_channels_json);
  const channel = canonicalChannel(raw, manual);
  if (!channel) return refuse(404, "unknown_channel", "no such channel");
  if (/^pr-\d{1,7}$/.test(channel)) return { ok: true, channel };
  if (!(await knownChannels(db, product, cfg)).includes(channel))
    return refuse(404, "unknown_channel", "no such channel");
  return { ok: true, channel };
}

async function deliverableOf(
  db: Db,
  product: string,
  raw: unknown,
): Promise<PolicyResult<{ deliverable: ReleaseDeliverableRow }>> {
  const id = raw === undefined || raw === null ? APP_DELIVERABLE_ID : raw;
  if (typeof id !== "string")
    return refuse(422, "bad_deliverable", "deliverable must be a string", [
      "deliverable",
    ]);
  const deliverable = await getDeliverable(db, product, id);
  if (!deliverable)
    return refuse(404, "unknown_deliverable", "no such deliverable", [
      "deliverable",
    ]);
  return { ok: true, deliverable };
}

async function releaseOf(
  db: Db,
  product: string,
  deliverable: string,
  releaseId: unknown,
): Promise<PolicyResult<{ release: ReleaseMetadataRow }>> {
  if (typeof releaseId !== "string" || !releaseId)
    return refuse(422, "bad_release", "releaseId must be a non-empty string", [
      "releaseId",
    ]);
  const release = await db.first<ReleaseMetadataRow>(
    "SELECT * FROM release_metadata WHERE product = ? AND release_id = ?",
    product,
    releaseId,
  );
  if (!release || release.deliverable_id !== deliverable)
    return refuse(404, "unknown_release", "no such release", ["releaseId"]);
  return { ok: true, release };
}

// ── Pointer operations ───────────────────────────────────────────────────────────────────────

export interface PointerRequest {
  /** The route's channel segment (canonicalised here). */
  channel: string;
  /** Default `app`. */
  deliverable?: unknown;
  releaseId?: unknown;
}

export type PointerOp = "promote" | "pin" | "unpin";

/**
 * Promote, pin or unpin. Validates the deliverable, the channel and (for promote/pin) the
 * release, then writes the policy as an operator (`source = 'admin'`), audits it, and drops the
 * product's cached resolutions.
 */
export async function applyPointerOp(
  env: Env,
  db: Db,
  product: string,
  cfg: ReleaseConfigRow | null,
  op: PointerOp,
  input: PointerRequest,
  actor: PolicyActor,
  now: number,
): Promise<PolicyResult<{ policy: ChannelPolicyView }>> {
  const ch = await resolvePolicyChannel(db, product, cfg, input.channel);
  if (!ch.ok) return ch;
  const d = await deliverableOf(db, product, input.deliverable);
  if (!d.ok) return d;
  const deliverable = d.deliverable.deliverable_id;
  const key = { product, deliverableId: deliverable, channel: ch.channel };

  let patch: ChannelPolicyPatch;
  let summary: string;
  if (op === "unpin") {
    patch = { pinned: false };
    summary = `Unpinned ${deliverable} ${ch.channel}`;
  } else {
    const r = await releaseOf(db, product, deliverable, input.releaseId);
    if (!r.ok) return r;
    const releaseId = r.release.release_id;
    if (op === "promote" && (await isYanked(db, product, releaseId)))
      return refuse(
        409,
        "release_yanked",
        "a yanked release cannot be promoted; unyank it or pin it explicitly",
        ["releaseId"],
      );
    patch =
      op === "pin"
        ? { pointerReleaseId: releaseId, pinned: true }
        : { pointerReleaseId: releaseId };
    summary =
      op === "pin"
        ? `Pinned ${deliverable} ${ch.channel} to ${releaseId}`
        : `Promoted ${releaseId} to ${deliverable} ${ch.channel}`;
  }

  await setChannelPolicy(db, key, patch, {
    source: "admin",
    by: actorId(actor),
    now,
  });
  await auditChange(
    db,
    product,
    actor,
    now,
    `release.channel.${op}`,
    { kind: "channel", id: `${deliverable}/${ch.channel}` },
    summary,
  );
  await bumpReleaseGeneration(env, product, now);
  return {
    ok: true,
    policy: policyView(
      await getChannelPolicy(db, key),
      deliverable,
      ch.channel,
    ),
  };
}

// ── The operator PUT ─────────────────────────────────────────────────────────────────────────

/**
 * `PUT …/release/channels/{channel}`: set any of `pointer` (a release id, or null to follow the
 * newest eligible release), `pinned`, `minSupported` (a version in the deliverable's scheme, or
 * null) and `critical`. Unknown fields are refused rather than ignored, so a typo is visible.
 */
export async function updateChannelPolicy(
  env: Env,
  db: Db,
  product: string,
  cfg: ReleaseConfigRow | null,
  rawChannel: string,
  body: Record<string, unknown>,
  actor: PolicyActor,
  now: number,
): Promise<PolicyResult<{ policy: ChannelPolicyView }>> {
  const allowed = new Set([
    "deliverable",
    "pointer",
    "pinned",
    "minSupported",
    "critical",
  ]);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0)
    return refuse(
      422,
      "unknown_field",
      `unknown field: ${unknown.join(", ")}`,
      unknown,
    );

  const ch = await resolvePolicyChannel(db, product, cfg, rawChannel);
  if (!ch.ok) return ch;
  const d = await deliverableOf(db, product, body.deliverable);
  if (!d.ok) return d;
  const deliverable = d.deliverable.deliverable_id;
  const key = { product, deliverableId: deliverable, channel: ch.channel };
  const existing = await getChannelPolicy(db, key);

  const patch: ChannelPolicyPatch = {};
  const changed: string[] = [];
  if (body.pointer !== undefined) {
    if (body.pointer === null) {
      patch.pointerReleaseId = null;
    } else {
      const r = await releaseOf(db, product, deliverable, body.pointer);
      if (!r.ok) return { ...r, fields: ["pointer"] };
      patch.pointerReleaseId = r.release.release_id;
    }
    changed.push(`pointer=${patch.pointerReleaseId ?? "none"}`);
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean")
      return refuse(422, "bad_pinned", "pinned must be a boolean", ["pinned"]);
    patch.pinned = body.pinned;
    changed.push(`pinned=${body.pinned}`);
  }
  if (body.minSupported !== undefined) {
    if (body.minSupported === null) {
      patch.minSupported = null;
    } else if (
      typeof body.minSupported !== "string" ||
      !parsesInScheme(versionSchemeOf(d.deliverable), body.minSupported)
    ) {
      return refuse(
        422,
        "bad_min_supported",
        `minSupported must be a ${versionSchemeOf(d.deliverable)} version or null`,
        ["minSupported"],
      );
    } else {
      patch.minSupported = body.minSupported;
    }
    changed.push(`minSupported=${patch.minSupported ?? "none"}`);
  }
  if (body.critical !== undefined) {
    if (typeof body.critical !== "boolean")
      return refuse(422, "bad_critical", "critical must be a boolean", [
        "critical",
      ]);
    patch.critical = body.critical;
    changed.push(`critical=${body.critical}`);
  }
  if (changed.length === 0)
    return refuse(422, "empty_update", "nothing to change", [...allowed]);

  // A pin needs a pointer (the table's CHECK); refuse it here with a field, not a D1 error.
  const pointerAfter =
    patch.pointerReleaseId !== undefined
      ? patch.pointerReleaseId
      : (existing?.pointer_release_id ?? null);
  const pinnedAfter =
    patch.pinned !== undefined ? patch.pinned : existing?.pinned === 1;
  if (pinnedAfter && pointerAfter === null)
    return refuse(
      422,
      "pin_without_pointer",
      "a pinned channel needs a pointer",
      ["pointer", "pinned"],
    );

  await setChannelPolicy(db, key, patch, {
    source: "admin",
    by: actorId(actor),
    now,
  });
  await auditChange(
    db,
    product,
    actor,
    now,
    "release.channel.update",
    { kind: "channel", id: `${deliverable}/${ch.channel}` },
    `Set ${deliverable} ${ch.channel}: ${changed.join(", ")}`,
  );
  await bumpReleaseGeneration(env, product, now);
  return {
    ok: true,
    policy: policyView(
      await getChannelPolicy(db, key),
      deliverable,
      ch.channel,
    ),
  };
}

/** `POST …/release/channels/{channel}/revert`: hand the row back to the manifest. */
export async function revertChannelPolicy(
  env: Env,
  db: Db,
  product: string,
  cfg: ReleaseConfigRow | null,
  rawChannel: string,
  body: Record<string, unknown>,
  actor: PolicyActor,
  now: number,
): Promise<PolicyResult<{ policy: ChannelPolicyView }>> {
  const ch = await resolvePolicyChannel(db, product, cfg, rawChannel);
  if (!ch.ok) return ch;
  const d = await deliverableOf(db, product, body.deliverable);
  if (!d.ok) return d;
  const deliverable = d.deliverable.deliverable_id;
  const key = { product, deliverableId: deliverable, channel: ch.channel };
  if (!(await revertChannelPolicyToManifest(db, key, actorId(actor), now)))
    return refuse(404, "no_policy", "this channel has no policy to revert");
  await auditChange(
    db,
    product,
    actor,
    now,
    "release.channel.revert",
    { kind: "channel", id: `${deliverable}/${ch.channel}` },
    `Handed ${deliverable} ${ch.channel} back to the manifest`,
  );
  await bumpReleaseGeneration(env, product, now);
  return {
    ok: true,
    policy: policyView(
      await getChannelPolicy(db, key),
      deliverable,
      ch.channel,
    ),
  };
}

// ── Yanks ────────────────────────────────────────────────────────────────────────────────────

/** A yank reason is free text an operator or CI wrote; bounded so it cannot bloat the row. */
export const MAX_YANK_REASON = 500;

export interface YankView {
  releaseId: string;
  yanked: boolean;
  reason: string | null;
  at: number | null;
  by: string | null;
}

/** `POST …/releases/{releaseId}/yank` (admin and CI). Re-yanking updates the reason. */
export async function yank(
  env: Env,
  db: Db,
  product: string,
  releaseId: string,
  reason: unknown,
  actor: PolicyActor,
  now: number,
): Promise<PolicyResult<{ yank: YankView }>> {
  if (typeof reason !== "string" || !reason.trim())
    return refuse(422, "bad_reason", "a yank needs a reason", ["reason"]);
  if (reason.length > MAX_YANK_REASON)
    return refuse(
      422,
      "bad_reason",
      `reason is limited to ${MAX_YANK_REASON} characters`,
      ["reason"],
    );
  const release = await db.first<ReleaseMetadataRow>(
    "SELECT * FROM release_metadata WHERE product = ? AND release_id = ?",
    product,
    releaseId,
  );
  if (!release) return refuse(404, "unknown_release", "no such release");
  const by = actorId(actor);
  await yankRelease(db, product, releaseId, reason.trim(), by, now);
  await auditChange(
    db,
    product,
    actor,
    now,
    "release.yank",
    { kind: "release", id: releaseId },
    `Yanked ${releaseId}: ${reason.trim()}`,
  );
  await bumpReleaseGeneration(env, product, now);
  return {
    ok: true,
    yank: { releaseId, yanked: true, reason: reason.trim(), at: now, by },
  };
}

/** `DELETE …/releases/{releaseId}/yank` (admin). */
export async function unyank(
  env: Env,
  db: Db,
  product: string,
  releaseId: string,
  actor: PolicyActor,
  now: number,
): Promise<PolicyResult<{ yank: YankView }>> {
  if (!(await unyankRelease(db, product, releaseId)))
    return refuse(404, "not_yanked", "this release is not yanked");
  await auditChange(
    db,
    product,
    actor,
    now,
    "release.unyank",
    { kind: "release", id: releaseId },
    `Lifted the yank on ${releaseId}`,
  );
  await bumpReleaseGeneration(env, product, now);
  return {
    ok: true,
    yank: { releaseId, yanked: false, reason: null, at: null, by: null },
  };
}
