/**
 * `seed-platform-connection` (I-30; plans/I-27.md §2.3 "Pocket ID", §6 "Data migrations"): the
 * `PLATFORM_OIDC_*` trio becomes one platform connection row.
 *
 *   - **Dry run** (`planPlatformConnectionSeed`): the row the env trio becomes (no secret in the
 *     report), whether it already exists, the number of links already keyed by its issuer and the
 *     number still keyed by the pre-I-01 literal `oidc`. Writes nothing.
 *   - **Apply** (`applyPlatformConnectionSeed`): inserts the row with `source: env`, its client
 *     secret sealed under PLATFORM_KEK (`connectionSecretContext`). Idempotent: a second apply
 *     finds the row and changes nothing (`INSERT … ON CONFLICT DO NOTHING`), so the row, once
 *     written, is the connection's only source; a later env change does not rewrite it.
 *   - **Down** (`downPlatformConnectionSeed`): deletes the row (and its domains, by cascade).
 *
 * The row: id `platform-sso`, label "Single sign-on" (the card's word for the platform IdP),
 * audience `both` (owner Q3, 2026-10-08; see `seededAudience`), the `groups` claim mapped, no
 * domains. P0-49's runner (not built yet) will run these three steps and record the report in
 * P0-24's ledger; until it lands the maintenance cron applies the seed, and the sign-in paths
 * apply it on first need, both through the same idempotent apply.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { seal } from "../../../platform/keyvault.js";
import { platformOidcConfig } from "../../../platform/platformOidc.js";
import {
  connectionSecretContext,
  resolveConnection,
  type Connection,
  type ConnectionAudience,
} from "../../../core/oidc/connections.js";
import { isSafeIssuerUrl } from "@polaris-key/manifest";
import { LEGACY_OIDC_ISSUER } from "../accounts/repo.js";
import { portalIdentityIssuerKey } from "../portal/repo.js";
import { DEFAULT_PLATFORM_CLAIM_MAP } from "./claims.js";

/** The env seed's connection id. */
export const PLATFORM_ENV_CONNECTION_ID = "platform-sso";
/** What the card calls the platform IdP. */
export const PLATFORM_ENV_CONNECTION_LABEL = "Single sign-on";

export interface PlatformConnectionSeedPlan {
  /** `no-env`: the trio is unset or unusable; `exists`: the row is already there. */
  action: "insert" | "exists" | "no-env";
  row: {
    id: string;
    scope: "platform";
    label: string;
    issuer: string;
    clientId: string;
    hasSecret: boolean;
    audience: ConnectionAudience;
    claimMap: typeof DEFAULT_PLATFORM_CLAIM_MAP;
    source: "env";
  } | null;
  /** Links already keyed by the issuer (`portalIdentityIssuerKey`). */
  linksByIssuer: number;
  /** Links still keyed by the pre-I-01 literal `oidc`, re-keyed at their next sign-in. */
  linksLegacyOidc: number;
}

/**
 * The seeded row's audience: `both`. The owner's Q3 (2026-10-08) keeps Pocket ID a connection
 * with audience `both` and withdraws the I-17 sunset, so the seed no longer derives `operators`
 * from `PLATFORM_OIDC_MIGRATION`; while the switch is still read, I-17's policy applies at
 * `/login` and `/callback` instead (`ended` refuses, `operators-only` refuses an unknown subject).
 */
function seededAudience(): ConnectionAudience {
  return "both";
}

async function countLinks(db: Db, issuerKey: string): Promise<number> {
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM account_links WHERE issuer_key = ? AND tenant_scope = ''",
    issuerKey,
  );
  return row?.n ?? 0;
}

/** The dry run: what the apply would write. Writes nothing. */
export async function planPlatformConnectionSeed(
  env: Env,
  db: Db,
  now: number,
): Promise<PlatformConnectionSeedPlan> {
  const cfg = platformOidcConfig(env);
  const existing = await resolveConnection(db, PLATFORM_ENV_CONNECTION_ID);
  const usable = cfg && isSafeIssuerUrl(cfg.issuer.replace(/\/+$/, ""));
  const issuer = existing?.issuer ?? (usable ? cfg.issuer : null);
  return {
    action: existing ? "exists" : usable ? "insert" : "no-env",
    row:
      usable && cfg
        ? {
            id: PLATFORM_ENV_CONNECTION_ID,
            scope: "platform",
            label: PLATFORM_ENV_CONNECTION_LABEL,
            issuer: cfg.issuer,
            clientId: cfg.clientId,
            hasSecret: Boolean(cfg.clientSecret),
            audience: seededAudience(),
            claimMap: DEFAULT_PLATFORM_CLAIM_MAP,
            source: "env",
          }
        : null,
    linksByIssuer: issuer
      ? await countLinks(db, portalIdentityIssuerKey(issuer))
      : 0,
    linksLegacyOidc: await countLinks(db, LEGACY_OIDC_ISSUER),
  };
}

/**
 * The apply: insert the row when the trio is set and the row does not exist. Answers the row
 * (existing or new), or `null` when there is nothing to seed. Never overwrites an existing row.
 */
export async function applyPlatformConnectionSeed(
  env: Env,
  db: Db,
  now: number,
): Promise<{ connection: Connection | null; inserted: boolean }> {
  const existing = await resolveConnection(db, PLATFORM_ENV_CONNECTION_ID);
  if (existing) return { connection: existing, inserted: false };
  const plan = await planPlatformConnectionSeed(env, db, now);
  const cfg = platformOidcConfig(env);
  if (plan.action !== "insert" || !plan.row || !cfg) {
    return { connection: null, inserted: false };
  }
  let sealed: string | null = null;
  if (cfg.clientSecret) {
    try {
      sealed = await seal(
        env,
        cfg.clientSecret,
        connectionSecretContext(PLATFORM_ENV_CONNECTION_ID),
      );
    } catch {
      // No usable PLATFORM_KEK: nothing is seeded (fail closed), and the next attempt retries.
      return { connection: null, inserted: false };
    }
  }
  const changes = await db.runChanges(
    `INSERT INTO identity_connections
       (id, scope, label, issuer, client_id, client_secret_sealed, client_secret_ref, jwks_uri,
        audience, claim_map_json, exchange, status, source, created_at, modified_at)
     VALUES (?, 'platform', ?, ?, ?, ?, NULL, NULL, ?, ?, 0, 'active', 'env', ?, ?)
     ON CONFLICT DO NOTHING`,
    PLATFORM_ENV_CONNECTION_ID,
    plan.row.label,
    plan.row.issuer,
    plan.row.clientId,
    sealed,
    plan.row.audience,
    JSON.stringify(plan.row.claimMap),
    now,
    now,
  );
  return {
    connection: await resolveConnection(db, PLATFORM_ENV_CONNECTION_ID),
    inserted: changes > 0,
  };
}

/** The down path: delete the seeded row (its domains go by cascade). */
export async function downPlatformConnectionSeed(db: Db): Promise<number> {
  await db.run(
    "DELETE FROM identity_connection_domains WHERE connection_id = ?",
    PLATFORM_ENV_CONNECTION_ID,
  );
  return db.runChanges(
    "DELETE FROM identity_connections WHERE id = ? AND source = 'env'",
    PLATFORM_ENV_CONNECTION_ID,
  );
}

/** The seeded connection, applying the seed first when it is missing (the sign-in paths). */
export async function platformEnvConnection(
  env: Env,
  db: Db,
  now: number,
): Promise<Connection | null> {
  return (await applyPlatformConnectionSeed(env, db, now)).connection;
}
