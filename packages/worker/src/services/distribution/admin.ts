/// <reference types="@cloudflare/workers-types" />

/**
 * Distribution's admin surface (P2b-02) — `/manage/api/products/<slug>/distribution/…`:
 *
 *     GET  …/distribution/outlets                              outlets, capabilities, transports
 *     PUT  …/distribution/outlets/<outletId>/capabilities      narrow (never widen) the default
 *     POST …/distribution/outlets/<outletId>/capabilities/revert   back to the kind's default
 *
 * Narrative-only (the console's API is not in the wire spec). The two writes are audited with the
 * session's subject (`distribution.outlet.capabilities`, `…capabilities.revert`). The session,
 * CSRF, rate-limit and platform-admin gates run in `admin/api.ts` before this is reached.
 *
 * The outlets themselves are manifest-owned (`.pkey/distribution`); only the capability override
 * is the operator's, and only in the narrowing direction — `capabilities.ts` explains why.
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
