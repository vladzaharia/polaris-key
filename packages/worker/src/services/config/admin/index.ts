/// <reference types="@cloudflare/workers-types" />

/**
 * Config's admin surface — `/manage/api/products/<slug>/config/{catalog,profiles,mint}` (§R1;
 * `mint` is the edge-mint recipe approval surface, P0-12).
 *
 * The catalog is the declaration of what a product's settings ARE; a profile is a named bundle
 * of values for them. Both used to hang off the admin dispatcher as top-level `schema` and
 * `profiles`, which put the two halves of one subject in different places and left neither
 * belonging to anything. They are Config's — a config-only product with no licence anywhere
 * (D-08) still has both, and a product that runs no Config service has neither.
 *
 * The pre-suite spellings are gone rather than aliased: pre-launch, the console is the only
 * consumer, and a permanent alias on an admin API is two paths that can drift.
 */

import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/adminApi.js";
import { handleCatalog } from "./catalog.js";
import { handleProfiles } from "./profiles.js";
import { handleMintAdmin } from "./mint.js";

/** What every handler under this directory is given. */
export type ConfigAdminContext = ServiceContext & { session: AdminSession };

export async function handleConfigAdmin(
  ctx: ConfigAdminContext,
): Promise<Response | null> {
  const [resource, ...rest] = ctx.rest;

  if (resource === "catalog" && rest.length === 0) return handleCatalog(ctx);
  if (resource === "profiles" && rest.length <= 1)
    return handleProfiles(ctx, rest[0]);
  if (resource === "mint") return handleMintAdmin(ctx, rest);

  return null;
}
