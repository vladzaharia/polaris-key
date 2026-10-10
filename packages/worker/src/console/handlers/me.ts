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
import {
  AREAS,
  can,
  canSeeProduct,
  PLATFORM,
  PRODUCT_AREAS,
  productScope,
  type AreaId,
  type Principal,
  type Scope,
} from "../authz.js";
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
  const principal = session.principal ?? null;
  const products = await listProducts(db);
  // Only the products the principal holds an area of; the rest are absent, not listed as locked.
  const visible = products.filter((p) => canSeeProduct(principal, p));
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
    // The Platform area (instance settings, deployment, store connections): Superadmin and
    // Platform admin. Kept for the screens that read it before `permissions` existed.
    platformAdmin: can(principal, PLATFORM, "platform", "view"),
    products: adminProducts,
    permissions: permissionsOf(principal, visible),
    environment: consoleEnvironment(env),
    sessionExpiresAt: session.exp,
    // I-12: when the operator last signed in interactively, for the relink tool's step-up (a
    // sign-in no older than `stepUpMaxAgeSeconds`). `null` for a session minted before I-12.
    authAt: session.stepUpAt ?? null,
    stepUpMaxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
  });
}

/** The areas `can()` allows at each level in one scope. */
export interface AreaLevels {
  view: AreaId[];
  edit: AreaId[];
}

/** `/me.permissions`: everything `useCan` reads. No account id: grants name roles and scopes. */
export interface MePermissions {
  roles: {
    role: string;
    scope: string;
    areas: readonly AreaId[] | null;
    source: string;
  }[];
  platform: AreaLevels;
  products: Record<string, AreaLevels>;
}

const PLATFORM_AREAS: readonly AreaId[] = AREAS.filter(
  (a) => a.scope === "membership" || a.scope === "platform" || a.scope === "both",
).map((a) => a.id);

function levels(
  p: Principal | null,
  scope: Scope,
  areas: readonly AreaId[],
): AreaLevels {
  return {
    view: areas.filter((a) => can(p, scope, a, "view")),
    edit: areas.filter((a) => can(p, scope, a, "edit")),
  };
}

export function permissionsOf(
  p: Principal | null,
  products: readonly { slug: string; system?: number | null }[],
): MePermissions {
  return {
    roles: (p?.grants ?? []).map((g) => ({
      role: g.role,
      scope: g.scope,
      areas: g.areas,
      source: g.source,
    })),
    platform: levels(p, PLATFORM, PLATFORM_AREAS),
    products: Object.fromEntries(
      products.map((row) => [
        row.slug,
        levels(p, productScope(row), PRODUCT_AREAS),
      ]),
    ),
  };
}
