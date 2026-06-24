/**
 * Tiers (`/api/products/<slug>/tiers/...`): named policy bundles (a profile + expiry/machine
 * limits) a license can be assigned. List/create, patch, and delete.
 */

import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { randomId } from "../../crypto.js";
import { deleteTier, listTiers, upsertTier } from "../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";

export async function handleTiers(
  req: Request,
  db: Db,
  session: AdminSession,
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (!id) {
    if (req.method === "GET") {
      const rows = await listTiers(db, slug);
      return adminJson({ tiers: rows.map((t) => ({ id: t.id, label: t.label, profile: t.profile_id, policyExpiryDays: t.policy_expiry_days, policyMachineLimit: t.policy_machine_limit })) });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const tierId = String(body.id ?? randomId("tier"));
      await upsertTier(db, {
        product: slug,
        id: tierId,
        label: String(body.label ?? tierId),
        profile_id: typeof body.profile === "string" ? body.profile : null,
        policy_expiry_days: typeof body.policyExpiryDays === "number" ? body.policyExpiryDays : null,
        policy_machine_limit: typeof body.policyMachineLimit === "number" ? body.policyMachineLimit : null,
        modified_by: session.sub,
        modified_at: now,
      });
      await audit(db, slug, session, now, "tier.create", { kind: "tier", id: tierId }, `Created tier ${tierId}`);
      return adminJson({ ok: true, id: tierId }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const row = await listTiers(db, slug).then((rows) => rows.find((t) => t.id === id) ?? null);
  if (!row) return notFound();
  if (req.method === "PATCH") {
    const body = await readBody(req);
    await upsertTier(db, {
      ...row,
      label: typeof body.label === "string" ? body.label : row.label,
      profile_id: typeof body.profile === "string" ? body.profile : row.profile_id,
      policy_expiry_days: typeof body.policyExpiryDays === "number" ? body.policyExpiryDays : row.policy_expiry_days,
      policy_machine_limit: typeof body.policyMachineLimit === "number" ? body.policyMachineLimit : row.policy_machine_limit,
      modified_by: session.sub,
      modified_at: now,
    });
    await audit(db, slug, session, now, "tier.update", { kind: "tier", id }, `Updated tier ${id}`);
    return adminJson({ ok: true, id });
  }
  if (req.method === "DELETE") {
    await deleteTier(db, slug, id);
    await audit(db, slug, session, now, "tier.delete", { kind: "tier", id }, `Deleted tier ${id}`);
    return adminJson({ ok: true, id });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}
