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
 * ST-04: the policy is the registry setting `core.trustPolicy`, written through `writeSetting()`
 * (the one write path; its column adapter keeps `trust_policy_source`). A bespoke route with no
 * version in its contract, so it writes in compatibility mode (ST-05 makes it an alias).
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  DEFAULT_TRUST_POLICY,
  parseTrustPolicy,
  validateTrustPolicy,
  type TrustPolicy,
} from "../../core/trust/deviceTrust.js";
import { getProduct } from "../../core/repo.js";
import { SETTINGS } from "../../mount.js";
import {
  writeSetting,
  type SettingWrite,
  type WriteOptions,
} from "../../core/settings/write.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../../core/console/session.js";
import {
  adminJson,
  err,
  forbidden,
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
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbidden("platform admin only");
  if (id !== undefined) return notFound();
  const row = await getProduct(db, slug);
  if (!row) return notFound();
  const current = parseTrustPolicy(row.trust_policy_json);
  const source = row.trust_policy_source ?? "default";

  if (req.method === "GET")
    return adminJson({ ok: true, policy: current, source });

  const write = (w: SettingWrite) =>
    writeSetting({ env, db, registry: SETTINGS }, w, {
      actor: {
        sub: session.sub,
        name: session.name ?? null,
        email: session.email ?? null,
      },
      origin: "console",
      now,
      product: row,
      strict: false,
    } satisfies WriteOptions);

  if (req.method === "DELETE") {
    const reset = await write({
      key: "core.trustPolicy",
      op: "reset",
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
  const v = validateTrustPolicy(await readBody(req));
  if (!v.ok)
    return err(400, ErrorCode.BadRequest, v.message, { field: v.field });
  const set = await write({
    key: "core.trustPolicy",
    value: v.policy,
    audit: {
      action: "trust_policy.set",
      target: { kind: "trust_policy", id: slug },
      summary: `Set the device-trust policy: ${describe(v.policy)} (was: ${describe(current)})`,
    },
  });
  if (!set.ok) return settingRefused(set);
  return adminJson({ ok: true, policy: v.policy, source: "admin" });
}
