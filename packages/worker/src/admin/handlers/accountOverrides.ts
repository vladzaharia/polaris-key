/**
 * One user's account overrides on the console (U-03; notes/S-17 §5.12, plans/U-01.md §6.3):
 *
 *   GET users/<subject>/overrides   the subject's layer, redacted (secrets by name only)
 *   PUT users/<subject>/overrides   { updates: OverrideUpdate[] }, the batch editor's body
 *
 * Under I-12's Users routes, which are Core's and exist on every product whatever its Identity
 * toggle says: the account is platform-level, and the layer reaches licence-key devices of owned
 * licences through the owner line, so a product with Identity off needs the editor as much as one
 * with it on (owner clarification, 2026-10-04). Reachable while Config is off, like every service
 * admin route (configure, then turn on); the response says whether Config runs.
 *
 * The write is the licence editor's batch (`applyOverrides`): validated against the ACTIVE
 * catalog all-or-nothing, secrets sealed under PLATFORM_KEK before they are stored, never echoed.
 * Two differences: a `flag` key is refused (entitlement overrides stay on the licence, decision
 * 20), and the write is a compare-and-set on the row it was computed from, so an edit that lands
 * in between (another operator, the OIDC provisioning writer) is never silently overwritten.
 */

import type { ManagedEntry } from "@polaris-key/protocol";
import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  casAccountOverrides,
  getAccountOverrides,
  parseAccountOverridePayload,
} from "../../core/accountOverrides.js";
import { readOverrideMigrationState } from "../../core/overrideMigration.js";
import { applyOverrides, type OverrideUpdate } from "../lib/overrides.js";
import { redactPayload } from "../lib/redact.js";
import { loadCatalog } from "../../core/activeCatalog.js";
import { adminJson, err, readBody } from "../lib/respond.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";

/** The keys a batch names, for the audit summary (names only: never a value). */
function keyNames(updates: OverrideUpdate[]): string {
  const keys = [
    ...new Set(
      updates
        .map((u) => (u && typeof u.key === "string" ? u.key : null))
        .filter((k): k is string => k !== null),
    ),
  ];
  return keys.length > 8
    ? `${keys.slice(0, 8).join(", ")} and ${keys.length - 8} more`
    : keys.join(", ");
}

export async function handleUserOverrides(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  args: { slug: string; subject: string; configOn: boolean },
  now: number,
): Promise<Response> {
  const { slug, subject, configOn } = args;
  const catalog = await loadCatalog(db, slug);

  if (req.method === "GET") {
    const row = await getAccountOverrides(db, slug, subject);
    const payload = parseAccountOverridePayload(row?.payload_json ?? null);
    const redacted = redactPayload(
      { config: payload.config, secrets: payload.secrets, entitlements: {} },
      catalog,
    );
    const migration = await readOverrideMigrationState(db);
    return adminJson({
      subject,
      configOn,
      overrides: { config: redacted.config, secrets: redacted.secrets },
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
      // Whether licence config and secrets still reach devices (the migration's step 5): until
      // then the licence layer sits below this one, so a value here already wins.
      licenseLayerRetired: migration.runCompletedAt !== null,
    });
  }

  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  if (!catalog) return err(409, ErrorCode.BadRequest, "no active catalog");
  const body = await readBody(req);
  const updates = Array.isArray(body.updates)
    ? (body.updates as OverrideUpdate[])
    : [];
  // Decision 20: entitlements are what a licence sells, not config; they stay on the licence.
  const flags = updates.filter(
    (u) =>
      u &&
      typeof u.key === "string" &&
      catalog.entryByKey(u.key)?.kind === "flag",
  );
  if (flags.length > 0)
    return err(422, ErrorCode.BadRequest, "validation failed", {
      fields: flags.map(
        (u) =>
          `${u.key}: entitlement overrides stay on the license (PUT …/license/licenses/<id>/overrides)`,
      ),
    });

  const row = await getAccountOverrides(db, slug, subject);
  const current = parseAccountOverridePayload(row?.payload_json ?? null);
  const result = await applyOverrides(
    env,
    slug,
    { config: current.config, secrets: current.secrets, entitlements: {} },
    updates,
    catalog,
    now,
  );
  if (!result.ok)
    return err(422, result.code, "validation failed", {
      fields: result.fields,
    });
  const written = await casAccountOverrides(
    db,
    slug,
    subject,
    row?.payload_json ?? null,
    {
      config: result.payload.config as Record<string, ManagedEntry>,
      secrets: result.payload.secrets as Record<string, ManagedEntry>,
    },
    session.sub,
    now,
  );
  if (!written)
    return err(
      409,
      "conflict",
      "These account overrides changed in the meantime. Reload and try again.",
    );
  await audit(
    db,
    slug,
    session,
    now,
    "user.overrides",
    { kind: "subject", id: subject },
    `Updated ${subject}'s account overrides: ${keyNames(updates) || "no keys"}`,
  );
  return adminJson({ ok: true, subject });
}
