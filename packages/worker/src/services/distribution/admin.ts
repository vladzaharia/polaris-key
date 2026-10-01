/// <reference types="@cloudflare/workers-types" />

/**
 * Distribution's admin surface — `/manage/api/products/<slug>/distribution/…`:
 *
 *     GET  …/distribution/outlets                              outlets, capabilities, transports
 *     PUT  …/distribution/outlets/<outletId>/capabilities      narrow (never widen) the default
 *     POST …/distribution/outlets/<outletId>/capabilities/revert   back to the kind's default
 *     GET  …/distribution/rollouts                             every outlet rollout (P2b-04)
 *     POST …/distribution/rollouts/<outlet>/<channel>          start / set the percentage
 *     POST …/distribution/rollouts/<outlet>/<channel>/{pause,resume,halt,complete}
 *     GET  …/distribution/access                               delivery access per deliverable
 *     PUT  …/distribution/access                               set (and claim) one deliverable's
 *     POST …/distribution/access/revert                        hand the `app` row back to the
 *                                                              manifest
 *
 * Narrative-only (the console's API is not in the wire spec). Every write is audited with the
 * session's subject. The session, CSRF, rate-limit and platform-admin gates run in
 * `admin/api.ts` before this is reached.
 *
 * The outlets themselves are manifest-owned (`.pkey/distribution`); only the capability override
 * is the operator's, and only in the narrowing direction — `capabilities.ts` explains why. The
 * rollout verbs are the same implementation CI reaches (`rollouts.ts`); delivery access is
 * `access.ts`.
 */

import { ErrorCode } from "../../core/errors.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/adminApi.js";
import {
  adminJson,
  adminNotFound,
  audit,
  err,
  readBody,
} from "../../core/adminApi.js";
import {
  CAPABILITY_KEYS,
  defaultCapabilities,
  effectiveCapabilities,
  overrideProblem,
} from "./capabilities.js";
import {
  getOutlet,
  listOutlets,
  listTransports,
  parseJsonColumn,
  setCapabilityOverride,
  type DistOutletRow,
  type DistTransportRow,
} from "./outlets.js";
import {
  ACCESS_MODES,
  accessModeOf,
  isAccessMode,
  listAccess,
  revertAccess,
  setAccess,
} from "./access.js";
import {
  applyRollout,
  isRolloutVerb,
  listRollouts,
  rolloutRecord,
  type RolloutVerb,
} from "./rollouts.js";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";

/** The console's view of one outlet. */
export function outletView(
  row: DistOutletRow,
  transports: readonly DistTransportRow[],
) {
  const defaults = defaultCapabilities(row.kind);
  const override =
    row.capabilities_source === "admin"
      ? parseJsonColumn(row.capabilities_json)
      : null;
  return {
    outletId: row.outlet_id,
    kind: row.kind,
    identity: parseJsonColumn(row.identity_json) ?? {},
    listing: parseJsonColumn(row.listing_json),
    capabilities: defaults ? effectiveCapabilities(defaults, override) : null,
    defaultCapabilities: defaults,
    capabilitiesSource: row.capabilities_source,
    capabilityOverride: override,
    transports: transports
      .filter((t) => t.outlet_id === row.outlet_id)
      .map((t) => ({
        deliverableId: t.deliverable_id,
        transport: t.transport,
      })),
    removedAt: row.removed_at,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

export async function handleDistributionAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, db, product, session, now, rest } = ctx;
  const slug = product.slug;
  if (rest[0] === "rollouts") return handleRolloutsAdmin(ctx);
  if (rest[0] === "access") return handleAccessAdmin(ctx);
  if (rest[0] !== "outlets") return null;

  if (rest.length === 1) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const transports = await listTransports(db, slug);
    return adminJson({
      capabilityKeys: CAPABILITY_KEYS,
      outlets: (await listOutlets(db, slug)).map((r) =>
        outletView(r, transports),
      ),
    });
  }

  const outletId = rest[1]!;
  if (rest[2] !== "capabilities") return null;
  const revert = rest.length === 4 && rest[3] === "revert";
  if (rest.length !== 3 && !revert) return null;

  const row = await getOutlet(db, slug, outletId);
  // A removed outlet is history, not configuration: it cannot be narrowed or reverted.
  if (!row || row.removed_at !== null) return adminNotFound();
  const defaults = defaultCapabilities(row.kind);
  if (!defaults) return adminNotFound();

  if (revert) {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    await setCapabilityOverride(db, slug, outletId, null, now);
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.outlet.capabilities.revert",
      { kind: "outlet", id: outletId },
      `Reverted the ${outletId} outlet's capabilities to the ${row.kind} default`,
    );
  } else {
    if (req.method !== "PUT")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const body = await readBody(req);
    const override = body.capabilities;
    const problem = overrideProblem(defaults, override);
    if (problem)
      return err(422, ErrorCode.BadRequest, problem.message, {
        fields: problem.fields,
      });
    const narrowed: Record<string, unknown> = {};
    for (const key of CAPABILITY_KEYS) {
      const value = (override as Record<string, unknown>)[key];
      if (value !== undefined) narrowed[key] = value;
    }
    await setCapabilityOverride(db, slug, outletId, narrowed, now);
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.outlet.capabilities",
      { kind: "outlet", id: outletId },
      `Narrowed the ${outletId} outlet's capabilities: ${Object.entries(
        narrowed,
      )
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ")}`,
    );
  }

  const updated = (await getOutlet(db, slug, outletId))!;
  return adminJson({
    outlet: outletView(updated, await listTransports(db, slug)),
  });
}

// ── Rollouts (P2b-04) ────────────────────────────────────────────────────────────────────────

/**
 * What a halt does TODAY, carried in every rollout answer so the console can say it next to
 * the control: until P3-03 composes the signed feed from these rows, a halt (and a percentage)
 * is recorded, audited and shown, but the legacy feeds keep serving. A yank or a channel pin
 * (Release) is today's emergency stop.
 */
const ROLLOUT_EFFECT = {
  reachesDevices: false,
  note: "Rollouts and halts are recorded and audited, but the legacy feeds (appcast, /update/version, downloads) keep serving until the signed feed carries them (P3-03). To stop a release reaching devices now, yank it or pin the channel.",
} as const;

async function handleRolloutsAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, db, product, session, now, rest, hooks } = ctx;
  if (rest.length === 1) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({
      rollouts: (await listRollouts(db, product.slug)).map(rolloutRecord),
      effect: ROLLOUT_EFFECT,
    });
  }
  const verb: RolloutVerb | null =
    rest.length === 3
      ? "set"
      : rest.length === 4 && isRolloutVerb(rest[3] as string)
        ? (rest[3] as RolloutVerb)
        : null;
  if (!verb) return null;
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  const result = await applyRollout(
    { db, product: product.slug, hooks, now },
    verb,
    {
      outlet: rest[1] as string,
      channel: rest[2] as string,
      deliverable: body.deliverable,
      releaseId: body.releaseId,
      bp: body.bp,
    },
    { kind: "admin", session },
  );
  if (!result.ok) {
    if (result.status === 404) return adminNotFound();
    return err(result.status, ErrorCode.BadRequest, result.message, {
      reason: result.reason,
      ...(result.fields ? { fields: result.fields } : {}),
    });
  }
  return adminJson({ rollout: result.rollout, effect: ROLLOUT_EFFECT });
}

// ── Delivery access (P2b-04) ─────────────────────────────────────────────────────────────────

async function accessView(
  ctx: Pick<ServiceContext, "db" | "product">,
): Promise<Record<string, unknown>> {
  const slug = ctx.product.slug;
  const rows = await listAccess(ctx.db, slug);
  return {
    modes: ACCESS_MODES,
    /** The `app` deliverable's mode in force, row or not (`public` with none). */
    app: {
      deliverableId: APP_DELIVERABLE_ID,
      mode: await accessModeOf(ctx.db, slug, APP_DELIVERABLE_ID),
      source:
        rows.find((r) => r.deliverable_id === APP_DELIVERABLE_ID)?.source ??
        "manifest",
    },
    deliverables: rows.map((r) => ({
      deliverableId: r.deliverable_id,
      mode: r.mode,
      entitlement: r.entitlement,
      source: r.source,
      modifiedAt: r.modified_at,
    })),
  };
}

async function handleAccessAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, db, product, session, now, rest, hooks } = ctx;
  const slug = product.slug;
  const revert = rest.length === 2 && rest[1] === "revert";
  if (rest.length !== 1 && !revert) return null;

  if (!revert && req.method === "GET") return adminJson(await accessView(ctx));
  if (revert ? req.method !== "POST" : req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const deliverable =
    body.deliverable === undefined ? APP_DELIVERABLE_ID : body.deliverable;
  if (typeof deliverable !== "string")
    return err(422, ErrorCode.BadRequest, "deliverable must be a string", {
      fields: ["deliverable"],
    });
  // A mode for a deliverable Release does not know would gate nothing, and mislead the operator.
  const known = (await hooks.releaseCatalog()?.deliverables()) ?? [];
  if (
    deliverable !== APP_DELIVERABLE_ID &&
    !known.some((d) => d.id === deliverable)
  )
    return err(422, ErrorCode.BadRequest, `no deliverable ${deliverable}`, {
      fields: ["deliverable"],
    });

  if (revert) {
    if (deliverable !== APP_DELIVERABLE_ID)
      return err(
        422,
        ErrorCode.BadRequest,
        "only the app deliverable's access has a manifest spelling to return to",
        { fields: ["deliverable"] },
      );
    await revertAccess(db, slug, deliverable, now);
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.access.revert",
      { kind: "deliverable", id: deliverable },
      `Returned the ${deliverable} delivery access of ${slug} to manifest control`,
    );
    return adminJson(await accessView(ctx));
  }

  if (!isAccessMode(body.mode))
    return err(
      422,
      ErrorCode.BadRequest,
      `mode must be one of ${ACCESS_MODES.join(", ")}`,
      { fields: ["mode"] },
    );
  let entitlement: string | null | undefined;
  if (body.entitlement !== undefined) {
    if (
      body.entitlement === null ||
      (typeof body.entitlement === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(body.entitlement))
    )
      entitlement = body.entitlement as string | null;
    else
      return err(
        422,
        ErrorCode.BadRequest,
        "entitlement must be a short identifier or null",
        { fields: ["entitlement"] },
      );
  }
  const before = await accessModeOf(db, slug, deliverable);
  await setAccess(db, slug, deliverable, body.mode, entitlement, now);
  await audit(
    db,
    slug,
    session,
    now,
    "distribution.access.update",
    { kind: "deliverable", id: deliverable },
    before === body.mode
      ? `Claimed the ${deliverable} delivery access of ${slug} (${body.mode})`
      : `Set the ${deliverable} delivery access of ${slug} from ${before} to ${body.mode}`,
  );
  return adminJson(await accessView(ctx));
}
