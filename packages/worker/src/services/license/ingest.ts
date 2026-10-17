/**
 * License's contribution to the manifest ingest (P0-26): the tiers, per row (S-18 §4.5 item 3),
 * and the `licensing.*` row settings (LX-06). Written WHATEVER License's enablement: turning a
 * service on runs no ingest, so its rows must already be current (plans/P0-26.md D1).
 */

import type { DbStatement } from "../../db/types.js";
import {
  countLicensesUsingTier,
  stmtDeleteManifestTier,
  stmtInsertTier,
  stmtUpsertManifestTier,
} from "../../core/licensing/store.js";
import { manifestRowSettingStatements } from "../../core/rowSettings.js";
import { rowAudit, tierShape } from "../../core/ingest/shared.js";
import type {
  IngestContext,
  ManifestContribution,
  ManifestContributor,
} from "../../core/ingest/types.js";
import { LICENSING_SETTINGS } from "./licensingSettings.js";

/** `.pkey/product`'s `licensing.*` settings → their claimable `product_settings` rows. */
export function licensingRowStatements(
  parsed: Parameters<typeof manifestRowSettingStatements>[2],
  product: string,
  now: number,
): DbStatement[] {
  return manifestRowSettingStatements(product, LICENSING_SETTINGS, parsed, now);
}

function tierInput(
  ctx: IngestContext,
  t: IngestContext["manifest"]["tiers"][number],
) {
  return {
    product: ctx.slug,
    id: t.id,
    label: t.label,
    profileId: t.profileId ?? null,
    policyExpiryDays: t.policyExpiryDays ?? null,
    policyDeviceLimit: t.policyDeviceLimit ?? null,
    policyFingerprint: t.policyFingerprint ?? null,
    channels: t.channels,
    minVersion: t.minVersion,
    maxVersion: t.maxVersion,
    rank: t.rank ?? 0,
    policyOfflineGraceDays: t.policyOfflineGraceDays ?? null,
    modifiedAt: ctx.now,
  };
}

async function prepare(ctx: IngestContext): Promise<ManifestContribution> {
  const { slug, now, manifest } = ctx;
  const statements: DbStatement[] = [];
  const audits: DbStatement[] = [];
  const updated: string[] = [];
  if (ctx.scope === "system") {
    // The deploy hook's subset: the row settings only (never tiers).
  } else if (ctx.mode === "create") {
    for (const t of manifest.tiers)
      statements.push(stmtInsertTier(tierInput(ctx, t)));
  } else {
    const { plan } = await ctx.rows();
    const storedTierById = new Map(plan.storedTiers.map((t) => [t.id, t]));
    for (const t of plan.dropTiers) {
      statements.push(stmtDeleteManifestTier(slug, t.id));
      audits.push(rowAudit(slug, now, "tier", t.id, "removed"));
    }
    for (const t of plan.applyTiers) {
      const input = tierInput(ctx, t);
      statements.push(stmtUpsertManifestTier(input));
      const stored = storedTierById.get(t.id);
      if (!stored) audits.push(rowAudit(slug, now, "tier", t.id, "added"));
      else if (tierShape(stored) !== tierShape(stmtInsertTier(input).params))
        audits.push(rowAudit(slug, now, "tier", t.id, "changed"));
    }
    updated.push("tiers");
  }
  const rows = licensingRowStatements(manifest, slug, now);
  if (rows.length > 0) {
    statements.push(...rows);
    updated.push("license");
  }
  return { statements, audits, updated };
}

export const licenseManifest: ManifestContributor = {
  checks: (ctx) =>
    ctx.mode === "apply"
      ? [
          {
            // The dry run words this conflict from its own plan (`core/ingest/plan.ts`).
            applyOnly: true,
            check: "tier-drop",
            run: async () => {
              const { plan } = await ctx.rows();
              for (const tier of plan.dropTiers) {
                const refs = await countLicensesUsingTier(
                  ctx.db,
                  ctx.slug,
                  tier.id,
                );
                if (refs > 0)
                  return {
                    check: "tier-drop",
                    message: `cannot remove tier ${tier.id}; ${refs} license(s) still reference it`,
                  };
              }
              return null;
            },
          },
        ]
      : [],
  prepare,
};
