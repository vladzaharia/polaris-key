/**
 * Identity's contribution to the manifest ingest (P0-26): `oidc_config` with the R9-01 issuer
 * gate, `provisioning_config`, the `identity:` row settings (I-09, LX-06) and `claimByKey` while
 * Identity is on. Written WHATEVER Identity's enablement except `claimByKey` (plans/P0-26.md D1).
 */

import type { DbParam, DbStatement } from "../../db/types.js";
import {
  issuerChangeRefusal,
  manifestIssuerRefusal,
  settingAuditor,
} from "../../core/ingest/shared.js";
import { parseJsonOr } from "../../platform/json.js";
import type {
  IngestContext,
  ManifestContribution,
  ManifestContributor,
} from "../../core/ingest/types.js";
import { reservedAudienceIn } from "./platformSignIn.js";
import { valueHeldByOtherProduct } from "../../core/settings/unique.js";
import { identityManifestIngest } from "./settings.js";
import { MAX_ISSUER_CLIENTS } from "@polaris-key/protocol/identity";
import { mintClientId } from "./issuer/clientsRepo.js";

/** A stored `oidc_config` row's columns (`stmtInsertOidcConfig`'s, after the product). */
interface OidcColumns {
  provider: string | null;
  issuer: string | null;
  client_id: string | null;
  client_secret_secret: string | null;
  redirect_uris_json: string | null;
  group_role_map_json: string | null;
}

/** A stored `provisioning_config` row's columns (`stmtInsertProvisioning`'s, after the product). */
interface ProvisioningColumns {
  claim: string;
  entitlement_key: string | null;
  entitlement_value_json: string | null;
  secret_key: string | null;
  secret_url_template: string | null;
  allowed_hosts_json: string | null;
}

/**
 * The OIDC row as an audit row shows it, from the six columns after the product in
 * `stmtInsertOidcConfig`'s order. The batch's own statement supplies the "after" side, so the
 * view cannot drift from what is written. The secret column is the NAME of a Worker secret.
 */
export function oidcView(columns: readonly DbParam[]): Record<string, unknown> {
  const [
    provider,
    issuer,
    clientId,
    clientSecretSecret,
    redirectUris,
    groupRoleMap,
  ] = columns;
  return {
    provider,
    issuer,
    clientId,
    clientSecretSecret,
    redirectUris: parseJsonOr(
      typeof redirectUris === "string" ? redirectUris : null,
      [],
    ),
    groupRoleMap: parseJsonOr(
      typeof groupRoleMap === "string" ? groupRoleMap : null,
      {},
    ),
  };
}

/** The provisioning hooks as an audit row shows them, from the columns after the product in
 *  `stmtInsertProvisioning`'s order, in claim order (the table's key). */
function provisioningView(
  rows: readonly (readonly DbParam[])[],
): Record<string, unknown>[] {
  return rows
    .map(
      ([
        claim,
        entitlementKey,
        entitlementValue,
        secretKey,
        secretUrlTemplate,
        allowedHosts,
      ]) => ({
        claim,
        entitlementKey,
        entitlementValue: parseJsonOr(
          typeof entitlementValue === "string" ? entitlementValue : null,
          null,
        ),
        secretKey,
        secretUrlTemplate,
        allowedHosts: parseJsonOr(
          typeof allowedHosts === "string" ? allowedHosts : null,
          null,
        ),
      }),
    )
    .sort((a, b) => (String(a.claim) < String(b.claim) ? -1 : 1));
}

/** The statements the old `manifestIngest` / `manifestIngestAlways` hooks returned. */
export function identityHookStatements(
  ctx: Pick<IngestContext, "manifest" | "slug" | "now" | "enabled">,
): DbStatement[] {
  return identityManifestIngest(ctx.manifest, ctx.slug, ctx.now, ctx.enabled);
}

async function prepare(ctx: IngestContext): Promise<ManifestContribution> {
  const { manifest, slug, now } = ctx;
  const statements: DbStatement[] = [];
  const updated: string[] = [];
  const { audits, auditSetting } = settingAuditor(slug, now, ctx.source.sha);

  if (ctx.scope === "system") {
    // The deploy hook's subset: the row settings only (never OIDC or provisioning).
  } else if (ctx.mode === "apply") {
    // The manifest-owned rows this apply replaces whole, as they stand now: the "before" of the
    // `identity.oidc` and `identity.provisioning` audit rows below.
    const storedOidc = await ctx.db.first<OidcColumns>(
      `SELECT provider, issuer, client_id, client_secret_secret, redirect_uris_json,
              group_role_map_json
         FROM oidc_config WHERE product = ?`,
      slug,
    );
    const storedProvisioning = await ctx.db.all<ProvisioningColumns>(
      `SELECT claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template,
              allowed_hosts_json
         FROM provisioning_config WHERE product = ? ORDER BY claim`,
      slug,
    );
    statements.push({
      sql: "DELETE FROM oidc_config WHERE product = ?",
      params: [slug],
    });
    const oidcInsert = oidcStatement(ctx);
    if (oidcInsert) statements.push(oidcInsert);
    {
      const before = storedOidc
        ? oidcView([
            storedOidc.provider,
            storedOidc.issuer,
            storedOidc.client_id,
            storedOidc.client_secret_secret,
            storedOidc.redirect_uris_json,
            storedOidc.group_role_map_json,
          ])
        : null;
      const after = oidcInsert ? oidcView(oidcInsert.params.slice(1)) : null;
      if (JSON.stringify(before) !== JSON.stringify(after))
        auditSetting("identity.oidc", before, after);
    }
    updated.push("oidc");

    statements.push({
      sql: "DELETE FROM provisioning_config WHERE product = ?",
      params: [slug],
    });
    const provisioningInserts = manifest.provisioning.map((h) =>
      stmtInsertProvisioning({ product: slug, ...h }),
    );
    statements.push(...provisioningInserts);
    {
      const before = provisioningView(
        storedProvisioning.map((r) => [
          r.claim,
          r.entitlement_key,
          r.entitlement_value_json,
          r.secret_key,
          r.secret_url_template,
          r.allowed_hosts_json,
        ]),
      );
      const after = provisioningView(
        provisioningInserts.map((s) => s.params.slice(1)),
      );
      if (JSON.stringify(before) !== JSON.stringify(after))
        auditSetting("identity.provisioning", before, after);
    }
    updated.push("provisioning");
  } else {
    const oidcInsert = oidcStatement(ctx);
    if (oidcInsert) statements.push(oidcInsert);
    for (const h of manifest.provisioning)
      statements.push(stmtInsertProvisioning({ product: slug, ...h }));
  }

  if (ctx.scope !== "system") statements.push(...issuerClientStatements(ctx));

  const rows = identityHookStatements(ctx);
  if (rows.length > 0) {
    statements.push(...rows);
    updated.push("identity");
  }
  return { statements, audits, updated };
}

/**
 * The manifest's registered clients (I-21.4; V5 §12.13.2), upserted by `(product, key)`: the
 * manifest owns what it declares, so an upsert rewrites the declared members and marks the row
 * `manifest`. The id is minted on first sight and kept. A manifest client the file no longer names is
 * disabled (never deleted) and its refresh families revoked; a client an operator disabled stays
 * disabled whatever the file says. Console-origin clients the manifest never names are untouched
 * (`origin = 'manifest'` guards the disable). Written whatever the toggles say: the rows are inert
 * until the issuer is served. The cap of 20 is inside the insert, as in `createClient`.
 */
export function issuerClientStatements(
  ctx: Pick<IngestContext, "manifest" | "slug" | "now">,
): DbStatement[] {
  const { slug, now } = ctx;
  const clients = ctx.manifest.identity?.clients ?? [];
  const out: DbStatement[] = clients.map((c) => ({
    sql: `INSERT INTO identity_clients
            (client_id, product, key, origin, name, developer_name, type, redirect_uris_json,
             post_logout_redirect_uris_json, scopes_json, claims_required_json, icon_url, status,
             created_at, updated_at)
          SELECT ?, ?, ?, 'manifest', ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?
          WHERE (SELECT COUNT(*) FROM identity_clients WHERE product = ?) < ?
             OR EXISTS (SELECT 1 FROM identity_clients WHERE product = ? AND key = ?)
          ON CONFLICT (product, key) DO UPDATE SET
            origin = 'manifest',
            name = excluded.name,
            developer_name = excluded.developer_name,
            type = excluded.type,
            redirect_uris_json = excluded.redirect_uris_json,
            post_logout_redirect_uris_json = excluded.post_logout_redirect_uris_json,
            scopes_json = excluded.scopes_json,
            claims_required_json = excluded.claims_required_json,
            status = CASE WHEN identity_clients.disabled_by = 'manifest'
                          THEN 'active' ELSE identity_clients.status END,
            disabled_by = CASE WHEN identity_clients.disabled_by = 'manifest'
                               THEN NULL ELSE identity_clients.disabled_by END,
            updated_at = excluded.updated_at`,
    params: [
      mintClientId(),
      slug,
      c.key,
      c.name,
      c.developerName ?? null,
      c.type,
      JSON.stringify(c.redirectUris),
      JSON.stringify(c.postLogoutRedirectUris),
      JSON.stringify(c.scopes),
      JSON.stringify(c.claimsRequired),
      now,
      now,
      slug,
      MAX_ISSUER_CLIENTS,
      slug,
      c.key,
    ],
  }));
  const keep = clients.map(() => "?").join(", ");
  out.push(
    {
      sql: `UPDATE identity_clients SET status = 'disabled', disabled_by = 'manifest', updated_at = ?
             WHERE product = ? AND origin = 'manifest' AND status = 'active'
               ${clients.length > 0 ? `AND key NOT IN (${keep})` : ""}`,
      params: [now, slug, ...clients.map((c) => c.key)],
    },
    {
      sql: `UPDATE identity_refresh_tokens SET revoked_at = ?
             WHERE product = ? AND revoked_at IS NULL
               AND client_id IN (SELECT client_id FROM identity_clients
                                  WHERE product = ? AND status = 'disabled')`,
      params: [now, slug, slug],
    },
  );
  return out;
}

function oidcStatement(ctx: IngestContext): DbStatement | null {
  const o = ctx.manifest.oidc;
  return o
    ? stmtInsertOidcConfig({
        product: ctx.slug,
        provider: o.provider,
        issuer: o.issuer,
        clientId: o.clientId,
        clientSecretSecret: o.clientSecretSecret,
        redirectUris: o.redirectUris ?? [],
        groupRoleMap: o.groupRoleMap ?? {},
      })
    : null;
}

export const identityManifest: ManifestContributor = {
  checks: (ctx) => [
    {
      check: "audience",
      run: async () => {
        // CC-01 D-A1: a product may not name the platform's own login-card client as its audience.
        const hit = reservedAudienceIn(ctx.manifest, ctx.env);
        if (hit)
          return {
            check: "audience",
            message: `identity.platformSignIn names ${hit}, which the platform reserves. Use your own client id.`,
            area: "identity",
            file: "product",
            path: "/identity/platformSignIn",
          };
        // A native link is scoped by the Google web client id or the Apple team id, so a value
        // another product already declares is refused at create, apply and resync alike.
        const ps = ctx.manifest.identity?.platformSignIn;
        const owned: [string, string | null | undefined, string][] = [
          [
            "identity.platformSignIn.google.serverClientId",
            ps?.google?.serverClientId,
            "/identity/platformSignIn/google/serverClientId",
          ],
          [
            "identity.platformSignIn.apple.teamId",
            ps?.apple?.teamId,
            "/identity/platformSignIn/apple/teamId",
          ],
          [
            "identity.platformSignIn.playGames.applicationId",
            ps?.playGames?.applicationId,
            "/identity/platformSignIn/playGames/applicationId",
          ],
          [
            "identity.platformSignIn.playGames.serverClientId",
            ps?.playGames?.serverClientId,
            "/identity/platformSignIn/playGames/serverClientId",
          ],
        ];
        for (const [key, value, path] of owned) {
          if (!value) continue;
          if (
            (await valueHeldByOtherProduct(ctx.db, ctx.slug, key, value)) !==
            null
          )
            return {
              check: "audience",
              message: `${key} is already declared by another product. Use your own client or team.`,
              area: "identity",
              file: "product",
              path,
            };
        }
        return null;
      },
    },
    {
      check: "issuer",
      run: async () => {
        // R9-01, at ingest. Create: fail-closed (a first write has no already-working row to
        // protect). Apply: only a NEW or CHANGED issuer is gated.
        const message =
          ctx.mode === "create"
            ? ctx.manifest.oidc?.provider === "custom"
              ? manifestIssuerRefusal(ctx.env, ctx.manifest.oidc.issuer)
              : null
            : await issuerChangeRefusal(
                ctx.env,
                ctx.db,
                ctx.slug,
                ctx.manifest,
              );
        return message
          ? {
              check: "issuer",
              message,
              area: "oidc",
              file: "product",
              path: "/oidc/issuer",
            }
          : null;
      },
    },
  ],
  prepare,
};

// ── statement builders (moved from core/products/store.ts, P0-26) ──────────────

export interface OidcConfigInput {
  product: string;
  provider?: "platform" | "custom";
  issuer?: string;
  clientId?: string;
  clientSecretSecret?: string;
  redirectUris: string[];
  groupRoleMap: Record<string, unknown>;
}

export function stmtInsertOidcConfig(o: OidcConfigInput): DbStatement {
  const provider = o.provider ?? "platform";
  return {
    sql: `INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      o.product,
      provider,
      provider === "custom" ? (o.issuer ?? "") : "",
      provider === "custom" ? (o.clientId ?? "") : "",
      provider === "custom" ? (o.clientSecretSecret ?? "") : "",
      JSON.stringify(o.redirectUris),
      JSON.stringify(o.groupRoleMap),
    ],
  };
}

export interface ProvisioningInput {
  product: string;
  claim: string;
  entitlementKey?: string;
  entitlementValue?: unknown;
  secretKey?: string;
  secretUrlTemplate?: string;
  allowedHosts?: string[];
}

export function stmtInsertProvisioning(h: ProvisioningInput): DbStatement {
  return {
    sql: `INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      h.product,
      h.claim,
      h.entitlementKey ?? null,
      h.entitlementValue !== undefined
        ? JSON.stringify(h.entitlementValue)
        : null,
      h.secretKey ?? null,
      h.secretUrlTemplate ?? null,
      h.allowedHosts ? JSON.stringify(h.allowedHosts) : null,
    ],
  };
}
