/// <reference types="@cloudflare/workers-types" />

/**
 * The identity-derived half of "who can obtain a device token here" (P0-12), read for services
 * that must bind a decision to it.
 *
 * A device token comes from one of three places: an operator-issued licence key, open
 * registration or anonymous enrolment (product policy), or signing in with the product's
 * identity provider. The last one is decided by Identity's `oidc_config` row — the provider,
 * the issuer, the client id, and the group → role/tier map that `activateFromIdentity` reads to
 * hand a signed-in user a licence — and by whether the Identity service is on at all. Every one
 * of those is written from a linked repo's `.pkey/product` manifest on link and resync, so a
 * push can point sign-in at an issuer the pusher controls, or map a group they belong to onto a
 * tier, without touching anything else.
 *
 * The edge-mint approval (`services/config/mint.ts`) records these values when an operator
 * approves a recipe and stops matching when they change. Config may not read Identity's table
 * directly (suite spec §5.2: cross-service data goes through a Core-mediated seam), so the read
 * lives here. It is read-only, and it returns the raw column values: comparison, not
 * interpretation, is the caller's job.
 */

import type { Db } from "../db/types.js";
import type { ServicesMap } from "./services.js";

export interface IdentityIssuance {
  /** The Identity service is on, so sign-in can issue licences and register devices. */
  enabled: boolean;
  /** `oidc_config` as stored; all null when the product has no row. */
  provider: string | null;
  issuer: string | null;
  clientId: string | null;
  groupRoleMapJson: string | null;
}

interface OidcTrustRow {
  provider: string | null;
  issuer: string | null;
  client_id: string | null;
  group_role_map_json: string | null;
}

/** The product's current identity issuance inputs. */
export async function readIdentityIssuance(
  db: Db,
  product: { slug: string; services: ServicesMap },
): Promise<IdentityIssuance> {
  const row = await db.first<OidcTrustRow>(
    "SELECT provider, issuer, client_id, group_role_map_json FROM oidc_config WHERE product = ?",
    product.slug,
  );
  return {
    enabled: product.services.identity.enabled,
    provider: row?.provider ?? null,
    issuer: row?.issuer ?? null,
    clientId: row?.client_id ?? null,
    groupRoleMapJson: row?.group_role_map_json ?? null,
  };
}

/** A JSON value with object keys sorted, so key order in a manifest is not a change. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/**
 * Whether two stored `group_role_map_json` values grant the same thing. Structural when both
 * parse (a resync that reorders keys is not a change); otherwise the raw text must be equal, so
 * a column that does not parse can only ever match itself.
 */
export function sameGroupRoleMap(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  try {
    return (
      JSON.stringify(canonical(JSON.parse(a))) ===
      JSON.stringify(canonical(JSON.parse(b)))
    );
  } catch {
    return false;
  }
}
