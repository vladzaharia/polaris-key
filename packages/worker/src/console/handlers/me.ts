/**
 * `/api/me` — the signed-in identity plus the CSRF token and the set of products this
 * session may administer (with each product's active catalog version).
 *
 * Also (ADMIN.md A-1): which deployment this is (`environment`, from the `PKEY_ENVIRONMENT`
 * `[vars]` value; `null` when unset or unrecognised, so the console's badge stays hidden as it
 * does in production) and when the session ends (`sessionExpiresAt`, epoch seconds — the
 * session's own signed `exp`, a hard 8 h after sign-in).
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { listProducts, getActiveSchema } from "../../core/repo.js";
import { isPlatformAdmin } from "../authz.js";
import {
  STEP_UP_MAX_AGE_SECONDS,
  type AdminSession,
} from "../../core/console/session.js";
import { adminJson } from "../../core/console/respond.js";

/** The deployments the console can name. */
export const CONSOLE_ENVIRONMENTS = ["prod", "staging", "dev"] as const;
export type ConsoleEnvironment = (typeof CONSOLE_ENVIRONMENTS)[number];

/** `PKEY_ENVIRONMENT`, validated: an unknown value is `null`, never echoed back. */
export function consoleEnvironment(env: Env): ConsoleEnvironment | null {
  const value = env.PKEY_ENVIRONMENT?.trim().toLowerCase();
  return (CONSOLE_ENVIRONMENTS as readonly string[]).includes(value ?? "")
    ? (value as ConsoleEnvironment)
    : null;
}

export async function handleMe(
  env: Env,
  db: Db,
  session: AdminSession,
): Promise<Response> {
  const products = await listProducts(db);
  const platform = isPlatformAdmin(env, session);
  // Admin authority is platform-wide: `hasAnyAdminGrant` (the login gate) and
  // `isPlatformAdmin` (the product gate) are the SAME predicate, so a session that exists at
  // all administers every product. The old `p.admin_group != null && groups.includes(...)`
  // arm was unreachable dead code — it made `/api/me` look like it reported a per-product
  // grant that no longer exists anywhere in the system. A non-platform session sees nothing.
  const visible = platform ? products : [];
  const adminProducts = await Promise.all(
    visible.map(async (p) => {
      const schema = await getActiveSchema(db, p.slug);
      return {
        slug: p.slug,
        name: p.name,
        schemaVersion: schema?.catalog_version ?? 0,
      };
    }),
  );
  return adminJson({
    sub: session.sub,
    name: session.name,
    email: session.email,
    csrf: session.csrf,
    platformAdmin: platform,
    products: adminProducts,
    environment: consoleEnvironment(env),
    sessionExpiresAt: session.exp,
    // I-12: when the operator last signed in interactively, for the relink tool's step-up (a
    // sign-in no older than `stepUpMaxAgeSeconds`). `null` for a session minted before I-12.
    authAt: session.stepUpAt ?? null,
    stepUpMaxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
  });
}
