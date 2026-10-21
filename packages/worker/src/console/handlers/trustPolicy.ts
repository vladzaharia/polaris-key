/**
 * The Core admin handler for a product's device-trust policy (P6-02), beside `ci-publisher`.
 * Narrative-only (no OpenAPI entry, like every admin route):
 *
 *   GET    /api/products/<slug>/trust-policy   — `{policy, source}` (the default when unset)
 *   PUT    /api/products/<slug>/trust-policy   — set it (`source = 'admin'`); the body is the
 *                                                whole policy, unknown members refused
 *   DELETE /api/products/<slug>/trust-policy   — back to the default (`source = 'default'`)
 *
 * Platform admins only: the policy names the Apple Team ID App Attest binds to and decides whether
 * basic devices are refused, so it is the operator's, never the repo's (`core/trust/deviceTrust.ts`).
 * Every write is audited with the before and after.
 *
 * ST-12, the guarded write path (S-18 §2.2, §4.15 item 8). The body is the whole policy, or an
 * envelope `{ policy, expectedVersion, reason, confirm }` (the console's); GET answers the
 * `version` to send back. A change that only TIGHTENS the policy (L1) needs nothing more than the
 * area. A change that RELAXES it (L2, `relaxesTrustPolicy`; a reset of a non-default policy is
 * one) also needs a step-up proved in the last five minutes, `expectedVersion`, a `reason` and
 * `confirm: "core.trustPolicy"` typed. A version that moved answers 409 `version_conflict`.
 *
 * ST-04: the policy is the registry setting `core.trustPolicy`, written through `writeSetting()`
 * (the one write path; its column adapter keeps `trust_policy_source`). A bespoke route with no
 * version in its contract, so it writes in compatibility mode (ST-05 makes it an alias).
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  DEFAULT_TRUST_POLICY,
  TRUST_POLICY_CONFIRM,
  parseTrustPolicy,
  relaxesTrustPolicy,
  validateTrustPolicy,
  type TrustPolicy,
} from "../../core/trust/deviceTrust.js";
import { resolveProductSetting } from "../../core/settings/resolve.js";
import { requireStepUp } from "../stepUp.js";
import type { ProductRow } from "../../core/repo.js";
import { SETTINGS } from "../../mount.js";
import {
  writeSetting,
  type SettingWrite,
  type WriteOptions,
} from "../../core/settings/write.js";
import type { AdminSession } from "../../core/console/session.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
  settingRefused,
} from "../../core/console/respond.js";

function describe(p: TrustPolicy): string {
  const ops = (["mint", "gatedDelivery", "commerceClaim"] as const)
    .map((op) => `${op}=${p[op]}`)
    .join(", ");
  return `${ops}; ${p.enforce ? "enforced" : "log-only"}; appAttest=${p.appAttest ? `${p.appAttest.teamId ?? "(platform team id)"}/${p.appAttest.environment}` : "off"}; playIntegrity=${p.playIntegrity ? `${p.playIntegrity.cloudProjectNumber ?? "(platform project)"}${p.playIntegrity.allowTestingResponses ? " (testing responses allowed)" : ""}` : "off"}`;
}

export async function handleTrustPolicy(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  row: ProductRow,
  id: string | undefined,
  now: number,
): Promise<Response> {
  // ST-29: the dispatcher checked the `keys` area on this product before routing here.
  if (id !== undefined) return notFound();
  const slug = row.slug;
  const current = parseTrustPolicy(row.trust_policy_json);
  const source = row.trust_policy_source ?? "default";

  const version = async (): Promise<number> =>
    (
      await resolveProductSetting(
        { env, db, registry: SETTINGS },
        row,
        "core.trustPolicy",
      )
    )?.version ?? 0;

  if (req.method === "GET")
    return adminJson({
      ok: true,
      policy: current,
      source,
      version: await version(),
    });

  /** The L2 gate of a relaxing change: step-up, version, reason and the typed key. */
  const relaxGate = (g: Record<string, unknown>): Response | null => {
    const denied = requireStepUp(session, now);
    if (denied) return denied;
    if (
      typeof g.expectedVersion !== "number" ||
      !Number.isSafeInteger(g.expectedVersion) ||
      g.expectedVersion < 0
    )
      return err(
        400,
        ErrorCode.BadRequest,
        "expectedVersion is required: the version the policy was read at",
        { reason: "expected_version_required" },
      );
    if (typeof g.reason !== "string" || g.reason.trim() === "")
      return err(400, ErrorCode.BadRequest, "a reason is required", {
        reason: "reason_required",
      });
    if (g.confirm !== TRUST_POLICY_CONFIRM)
      return err(
        400,
        ErrorCode.BadRequest,
        `type ${TRUST_POLICY_CONFIRM} to confirm`,
        { reason: "confirm_required", level: "L2" },
      );
    return null;
  };
  const named = (b: Record<string, unknown>) => ({
    ...(b.expectedVersion !== undefined
      ? { expectedVersion: b.expectedVersion as number }
      : {}),
    ...(typeof b.reason === "string" && b.reason.trim() !== ""
      ? { reason: b.reason }
      : {}),
  });

  const write = (w: SettingWrite) =>
    writeSetting({ env, db, registry: SETTINGS }, w, {
      actor: {
        sub: session.sub,
        name: session.name ?? null,
        email: session.email ?? null,
      },
      origin: "console",
      principal: session.principal,
      now,
      product: row,
      strict: false,
    } satisfies WriteOptions);

  if (req.method === "DELETE") {
    const body = await readBody(req);
    if (relaxesTrustPolicy(current, DEFAULT_TRUST_POLICY)) {
      const gate = relaxGate(body);
      if (gate) return gate;
    }
    const reset = await write({
      key: "core.trustPolicy",
      op: "reset",
      ...named(body),
      audit: {
        action: "trust_policy.reset",
        target: { kind: "trust_policy", id: slug },
        summary: `Reset the device-trust policy to the default (was: ${describe(current)})`,
      },
    });
    if (!reset.ok) return settingRefused(reset);
    return adminJson({
      ok: true,
      policy: DEFAULT_TRUST_POLICY,
      source: "default",
    });
  }

  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const raw = await readBody(req);
  const enveloped =
    typeof raw.policy === "object" &&
    raw.policy !== null &&
    !Array.isArray(raw.policy);
  const meta = enveloped ? raw : {};
  const v = validateTrustPolicy(enveloped ? raw.policy : raw);
  if (!v.ok)
    return err(400, ErrorCode.BadRequest, v.message, { field: v.field });
  if (relaxesTrustPolicy(current, v.policy)) {
    const gate = relaxGate(meta);
    if (gate) return gate;
  }
  const set = await write({
    key: "core.trustPolicy",
    value: v.policy,
    ...named(meta),
    audit: {
      action: "trust_policy.set",
      target: { kind: "trust_policy", id: slug },
      summary: `Set the device-trust policy: ${describe(v.policy)} (was: ${describe(current)})`,
    },
  });
  if (!set.ok) return settingRefused(set);
  return adminJson({ ok: true, policy: v.policy, source: "admin" });
}
