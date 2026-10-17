/**
 * Config's contribution to the manifest ingest (P0-26): the catalog (screened, declassify-checked,
 * a new version unless the console claimed it), the profiles (secret values sealed, the stored
 * ones carried forward, R2) and the edge-mint recipes with their orphaned approvals (P0-12).
 * Written WHATEVER Config's enablement (plans/P0-26.md D1).
 */

import { Catalog } from "@polaris-key/catalog";
import { SYSTEM_ACTORS } from "../../core/audit.js";
import { declassifyRefusal } from "../../core/configDelivery.js";
import { listProfiles } from "../../core/licensing/store.js";
import type { DbStatement } from "../../db/types.js";
import {
  getActiveSchema,
  nextSchemaVersion,
  stmtDeleteManifestProfile,
  stmtDeleteOrphanEdgeMintApprovals,
  stmtInsertEdgeMint,
  stmtInsertProfile,
  stmtInsertSchema,
  stmtUpsertManifestProfile,
} from "../../core/products/store.js";
import {
  CLAIMED_SQL,
  claimGuardParams,
  stmtSettingAudit,
  unlessClaimed,
} from "../../core/settingsClaims.js";
import {
  countLicensesListingProfile,
  rowAudit,
  screenCatalog,
  withStoredSecrets,
} from "../../core/ingest/shared.js";
import {
  managedSecretKeyPredicate,
  parseStoredCatalog,
  sealedProfilePayload,
} from "../../core/ingest/manifestSecrets.js";
import type {
  IngestContext,
  IngestProblem,
  ManifestContribution,
  ManifestContributor,
} from "../../core/ingest/types.js";
import type { ManifestProfile } from "@polaris-key/manifest";

interface CatalogState {
  /** The refusal, when the catalog cannot be installed. */
  problem: IngestProblem | null;
  catalogChanged: boolean;
  catalogClaimed: boolean;
  activeJson: string | null | undefined;
  incoming: Catalog | null;
}

/** The catalog screen, once (a check and `prepare` both read it). */
function catalogState(ctx: IngestContext): Promise<CatalogState> {
  return ctx.read.memo("config.catalog", async () => {
    if (ctx.mode === "create") {
      // Screened as the admin API screens every catalog it accepts: the repo-sync path must not
      // install one the console would refuse (unsupported keywords, an uncompilable `pattern`).
      try {
        const catalog = new Catalog(ctx.manifest.catalog as never);
        catalog.compileAll();
        return {
          problem: null,
          catalogChanged: true,
          catalogClaimed: false,
          activeJson: null,
          incoming: catalog,
        };
      } catch (e) {
        return {
          problem: {
            check: "catalog",
            message: `invalid catalog in manifest: ${e instanceof Error ? e.message : "unknown error"}`,
          },
          catalogChanged: true,
          catalogClaimed: false,
          activeJson: null,
          incoming: null,
        };
      }
    }
    // ST-20: a break-glass claim whose field this manifest changes ended in this apply's batch,
    // so it is not in `claims` and the field applies like any other.
    const claims = (await ctx.claims()).claimed;
    const nextJson = JSON.stringify(ctx.manifest.catalog);
    const active = await getActiveSchema(ctx.db, ctx.slug);
    const catalogClaimed = claims.has("config.catalog");
    const catalogChanged = !catalogClaimed && active?.catalog_json !== nextJson;
    const screened = screenCatalog(ctx.manifest, catalogChanged);
    return {
      problem: screened.ok
        ? null
        : { check: "catalog", message: screened.error },
      catalogChanged,
      catalogClaimed,
      activeJson: active?.catalog_json,
      incoming: screened.ok ? screened.catalog : null,
    };
  });
}

/** Create: every manifest profile with its catalog-declared secrets sealed (no stored row yet). */
function createdProfiles(
  ctx: IngestContext,
): Promise<
  | {
      ok: true;
      rows: { profile: ManifestProfile; payload: Record<string, unknown> }[];
    }
  | { ok: false; error: string }
> {
  return ctx.read.memo("config.createdProfiles", async () => {
    // Catalog-declared secrets carried in a profile payload are sealed under `PLATFORM_KEK`
    // before they are serialised. There is no stored row to protect at link time, so only the
    // sealing half applies. A secret is never persisted unsealed: without a KEK the link is
    // refused.
    const isSecretKey = managedSecretKeyPredicate([
      new Catalog(ctx.manifest.catalog as never),
    ]);
    const rows: {
      profile: ManifestProfile;
      payload: Record<string, unknown>;
    }[] = [];
    for (const p of ctx.manifest.profiles) {
      const sealed = await sealedProfilePayload(
        ctx.env,
        ctx.slug,
        p.id,
        p.payload,
        isSecretKey,
        null,
      );
      if (!sealed.ok) return { ok: false, error: sealed.error } as const;
      rows.push({ profile: p, payload: sealed.payload });
    }
    return { ok: true, rows } as const;
  });
}

function checks(ctx: IngestContext) {
  const out: {
    check: string;
    run: () => Promise<IngestProblem | null>;
  }[] = [
    {
      check: "catalog",
      run: async () => (await catalogState(ctx)).problem,
    },
  ];
  if (ctx.mode === "create")
    out.push({
      check: "seal",
      run: async () => {
        const r = await createdProfiles(ctx);
        return r.ok ? null : { check: "seal", message: r.error };
      },
    });
  else
    out.push(
      {
        check: "declassify",
        run: async () => {
          const s = await catalogState(ctx);
          if (!s.catalogChanged || !s.incoming) return null;
          // A delivery downgrade of a stored serverOnly secret is not applied silently.
          const refusal = await declassifyRefusal(
            ctx.db,
            ctx.slug,
            s.activeJson,
            s.incoming.entries,
          );
          return refusal
            ? {
                check: "declassify",
                message: `invalid catalog in manifest: ${refusal}`,
              }
            : null;
        },
      },
      {
        check: "profile-drop",
        run: async () => {
          const { plan } = await ctx.rows();
          for (const profile of plan.dropProfiles) {
            const refs =
              (await countLicensesListingProfile(
                ctx.db,
                ctx.slug,
                profile.id,
              )) +
              plan.survivingTierProfiles.filter((p) => p === profile.id).length;
            if (refs > 0)
              return {
                check: "profile-drop",
                message: `cannot remove profile ${profile.id}; ${refs} license(s) or tier(s) still reference it`,
              };
          }
          return null;
        },
      },
    );
  return out;
}

function edgeMintStatements(ctx: IngestContext): DbStatement[] {
  return ctx.manifest.edgeMint.map((e) =>
    stmtInsertEdgeMint({
      product: ctx.slug,
      id: e.id,
      alg: e.alg,
      signingKeySecret: e.signingKeySecret,
      kid: e.kid,
      claimsTemplate: e.claimsTemplate ?? {},
      ttlSeconds: e.ttlSeconds,
      audience: e.audience ?? null,
      requires: e.requires,
      requiredEntitlement: e.requiredEntitlement ?? null,
    }),
  );
}

async function prepare(ctx: IngestContext): Promise<ManifestContribution> {
  const { slug, now, manifest, db } = ctx;
  const state = await catalogState(ctx);
  const statements: DbStatement[] = [];
  const audits: DbStatement[] = [];
  const updated: string[] = [];

  if (ctx.mode === "create") {
    statements.push(
      stmtInsertSchema({
        product: slug,
        catalog_version: 1,
        catalog_json: JSON.stringify(manifest.catalog),
        active: 1,
        created_at: now,
      }),
    );
    const profiles = await createdProfiles(ctx);
    if (profiles.ok)
      for (const { profile: p, payload } of profiles.rows)
        statements.push(
          stmtInsertProfile({
            product: slug,
            id: p.id,
            name: p.name,
            description: p.description ?? null,
            payloadJson: JSON.stringify(payload),
            modifiedAt: now,
          }),
        );
    statements.push(...edgeMintStatements(ctx));
    // P0-12: a freshly linked product's recipes are PENDING: a link never writes an approval,
    // because an approval is the operator's decision and the manifest is the repo's. So the
    // link deletes EVERY approval row under the slug, not only the orphans resync drops.
    statements.push({
      sql: "DELETE FROM edge_mint_approvals WHERE product = ?",
      params: [slug],
    });
    return { statements, audits, updated };
  }

  // ── apply ───────────────────────────────────────────────────────────────────
  const claimed: string[] = [];
  // Schema: publish a new active version only when the catalog changed and the console has not
  // claimed it (`config.catalog`, one claimable unit).
  if (state.catalogClaimed) claimed.push("config.catalog");
  if (state.catalogChanged) {
    const version = await nextSchemaVersion(db, slug);
    // Guarded in SQL as well: a console catalog publish that claims `config.catalog` after
    // `claims` was read must not be deactivated and replaced by this push.
    statements.push(
      {
        sql: `UPDATE product_schema SET active = 0
                WHERE product = ? AND NOT ${CLAIMED_SQL}`,
        params: [slug, ...claimGuardParams(slug, "config.catalog", now)],
      },
      unlessClaimed(
        stmtInsertSchema({
          product: slug,
          catalog_version: version,
          catalog_json: JSON.stringify(manifest.catalog),
          active: 1,
          created_at: now,
        }),
        slug,
        "config.catalog",
        now,
      ),
    );
    const sha = ctx.source.sha;
    audits.push(
      unlessClaimed(
        stmtSettingAudit(
          slug,
          now,
          SYSTEM_ACTORS.resync,
          "setting.resync",
          "setting",
          "config.catalog",
          `config.catalog published from the manifest as v${version}${sha ? ` at ${sha.slice(0, 12)}` : ""}`,
        ),
        slug,
        "config.catalog",
        now,
      ),
    );
    updated.push("schema");
  }
  updated.push("profiles");

  statements.push({
    sql: "DELETE FROM edge_mint_config WHERE product = ?",
    params: [slug],
  });
  statements.push(...edgeMintStatements(ctx));
  // P0-12: approvals are the operator's, so a resync never WRITES one: the re-inserted rows above
  // stay approved only where they are column-for-column what an operator approved. What a resync
  // does own is cleanup: a recipe id the manifest no longer declares takes its approval with it.
  statements.push(stmtDeleteOrphanEdgeMintApprovals(slug));
  updated.push("edgeMint");

  return {
    statements,
    audits,
    updated,
    ...(claimed.length > 0 ? { claimed } : {}),
    finalize: () => finalizeProfiles(ctx, state),
  };
}

/**
 * R2: the profiles' carried secret values, read as late as possible: after every GitHub read,
 * with nothing but this one D1 read between the snapshot and the batch. A console edit landing
 * inside that single round trip is the only one a push can still overwrite. Also writes the
 * dropped profiles' deletes: a dropped manifest profile goes, secrets and all.
 */
async function finalizeProfiles(ctx: IngestContext, state: CatalogState) {
  const { slug, now, manifest } = ctx;
  const { plan } = await ctx.rows();
  const statements: DbStatement[] = [];
  const audits: DbStatement[] = [];
  for (const p of plan.dropProfiles) {
    statements.push(stmtDeleteManifestProfile(slug, p.id));
    audits.push(rowAudit(slug, now, "profile", p.id, "removed"));
  }
  if (plan.applyProfiles.length > 0 && state.incoming) {
    // Sealing a value the manifest declares, and refusing to overwrite a sealed one, go by BOTH
    // the incoming and the stored catalog, so a push that demotes a secret and writes its value
    // in the same commit cannot slip past; the carry-forward goes by the one that stays
    // installed (with `config.catalog` claimed that is the console's catalog).
    const storedCatalog = parseStoredCatalog(state.activeJson);
    const carryCatalog =
      state.catalogClaimed && storedCatalog ? storedCatalog : state.incoming;
    const isSecretKey = managedSecretKeyPredicate(
      storedCatalog ? [state.incoming, storedCatalog] : [state.incoming],
    );
    const storedById = new Map(plan.storedProfiles.map((p) => [p.id, p]));
    const stored = new Map(
      (await listProfiles(ctx.db, slug)).map((p) => [p.id, p.payload_json]),
    );
    for (const profile of plan.applyProfiles) {
      const sealed = await sealedProfilePayload(
        ctx.env,
        slug,
        profile.id,
        profile.payload,
        isSecretKey,
        stored.get(profile.id),
      );
      if (!sealed.ok)
        return { refusal: { check: "seal", message: sealed.error } };
      const payload = withStoredSecrets(
        sealed.payload,
        stored.get(profile.id),
        carryCatalog,
      );
      statements.push(
        stmtUpsertManifestProfile({
          product: slug,
          id: profile.id,
          name: profile.name,
          description: profile.description ?? null,
          payloadJson: JSON.stringify(payload),
          modifiedAt: now,
        }),
      );
      const before = storedById.get(profile.id);
      if (!before)
        audits.push(rowAudit(slug, now, "profile", profile.id, "added"));
      else if (
        before.name !== profile.name ||
        (before.description ?? null) !== (profile.description ?? null) ||
        before.payload_json !== JSON.stringify(payload)
      )
        audits.push(rowAudit(slug, now, "profile", profile.id, "changed"));
    }
  }
  void manifest;
  return { statements, audits };
}

export const configManifest: ManifestContributor = { checks, prepare };
