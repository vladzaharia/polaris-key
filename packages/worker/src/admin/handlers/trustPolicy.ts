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
 * basic devices are refused, so it is the operator's, never the repo's (`core/deviceTrust.ts`).
 * Every write is audited with the before and after.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  DEFAULT_TRUST_POLICY,
  parseTrustPolicy,
  validateTrustPolicy,
  type TrustPolicy,
} from "../../core/deviceTrust.js";
import { getProduct, setTrustPolicy } from "../../repo.js";
import { audit } from "../audit.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import {
  adminJson,
  err,
  forbidden,
  notFound,
  readBody,
} from "../lib/respond.js";

function describe(p: TrustPolicy): string {
  const ops = (["mint", "gatedDelivery", "commerceClaim"] as const)
    .map((op) => `${op}=${p[op]}`)
    .join(", ");
  return `${ops}; ${p.enforce ? "enforced" : "log-only"}; appAttest=${p.appAttest ? `${p.appAttest.teamId}/${p.appAttest.environment}` : "off"}; playIntegrity=${p.playIntegrity ? `${p.playIntegrity.cloudProjectNumber}${p.playIntegrity.allowTestingResponses ? " (testing responses allowed)" : ""}` : "off"}`;
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

  if (req.method === "DELETE") {
    await setTrustPolicy(db, slug, null, now);
    await audit(
      db,
      slug,
      session,
      now,
      "trust_policy.reset",
      { kind: "trust_policy", id: slug },
      `Reset the device-trust policy to the default (was: ${describe(current)})`,
    );
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
  await setTrustPolicy(db, slug, JSON.stringify(v.policy), now);
  await audit(
    db,
    slug,
    session,
    now,
    "trust_policy.set",
    { kind: "trust_policy", id: slug },
    `Set the device-trust policy: ${describe(v.policy)} (was: ${describe(current)})`,
  );
  return adminJson({ ok: true, policy: v.policy, source: "admin" });
}
