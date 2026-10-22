/**
 * Distribution's contribution to the manifest ingest (P0-26): `.pkey/distribution` (outlets and
 * transports) and the declared release keys as key-inventory observations (P3-03) while
 * Distribution is on, and the `app` row of `dist_access` WHATEVER its enablement (P2b-04: the row
 * must already hold the manifest's answer when an operator turns Distribution on).
 *
 * It also PROVISIONS package feeds (F-34.2): for each ecosystem the manifest declares a package
 * in, one insert-only feed row at Customers with the exact namespace derived from the declared
 * names, and the owner row when the product has neither an owner nor a feed row. Written whether
 * Distribution is on or off (F-34 decision F1; the ladder refuses reads while it is off) and
 * never for the system product (F14: its bootstrap is the one writer). An ecosystem whose names
 * have no one namespace (`ambiguous`) or whose namespace would be empty provisions nothing, and
 * the ingest answer's `facts.feedProvision.skipped` says why. One audit row per created feed.
 */

import {
  deriveFeedNamespace,
  packageNamespaceEmpty,
  PACKAGE_ECOSYSTEMS,
  SYSTEM_PRODUCT_SLUG,
  type PackageEcosystem,
} from "@polaris-key/manifest";
import {
  SYSTEM_ACTORS,
  actorColumns,
  auditStatement,
  sql,
} from "../../core/audit.js";
import type { DbStatement } from "../../db/types.js";
import type {
  IngestContext,
  ManifestContribution,
  ManifestContributor,
} from "../../core/ingest/types.js";
import { accessIngestStatements } from "./access.js";
import { releaseKeyObservationStatements } from "./availability.js";
import {
  FEED_PROVISION_ACTOR,
  stmtProvisionFeed,
  stmtProvisionOwner,
} from "./registryFeeds.js";
import { manifestIngestStatements as outletIngestStatements } from "./outlets.js";

/** Distribution's ingest rows: outlets and key observations while on, the access row always. */
export function distributionStatements(
  ctx: Pick<IngestContext, "manifest" | "slug" | "now" | "enabled">,
): DbStatement[] {
  const { manifest, slug, now } = ctx;
  return [
    ...(ctx.enabled
      ? [
          ...outletIngestStatements(manifest, slug, now),
          ...releaseKeyObservationStatements(manifest, slug, now),
        ]
      : []),
    ...accessIngestStatements(manifest, slug, now),
  ];
}

export const FEED_PROVISION_ACTION = "distribution.feed.provision";

/** One ecosystem the manifest declares packages in, and what provisioning does about it. */
interface FeedPlan {
  ecosystem: PackageEcosystem;
  namespace: Record<string, unknown>;
}

/** Why an ecosystem's feed was not provisioned, for the ingest answer. */
export interface FeedProvisionSkip {
  ecosystem: PackageEcosystem;
  reason: string;
}

/** The feeds a manifest provisions, and the ecosystems it leaves to an operator. */
export function feedProvisionPlan(
  manifest: IngestContext["manifest"],
  slug: string,
): { feeds: FeedPlan[]; skipped: FeedProvisionSkip[] } {
  const feeds: FeedPlan[] = [];
  const skipped: FeedProvisionSkip[] = [];
  if (slug === SYSTEM_PRODUCT_SLUG) return { feeds, skipped };
  const declared = manifest.release?.packageDeliverables ?? [];
  for (const ecosystem of PACKAGE_ECOSYSTEMS) {
    const names = declared
      .filter((d) => d.ecosystem === ecosystem)
      .map((d) => d.name);
    if (names.length === 0) continue;
    const { namespace, ambiguous } = deriveFeedNamespace(
      ecosystem,
      names,
      slug,
    );
    if (ambiguous !== null) {
      skipped.push({ ecosystem, reason: ambiguous });
    } else if (packageNamespaceEmpty(ecosystem, namespace)) {
      skipped.push({ ecosystem, reason: "no namespace can be derived" });
    } else {
      feeds.push({ ecosystem, namespace });
    }
  }
  return { feeds, skipped };
}

/** The provisioning rows (owner, then feeds), and one audit row per feed this batch creates. */
export function feedProvisionStatements(
  ctx: Pick<IngestContext, "manifest" | "slug" | "now">,
): {
  statements: DbStatement[];
  audits: DbStatement[];
  skipped: FeedProvisionSkip[];
} {
  const { feeds, skipped } = feedProvisionPlan(ctx.manifest, ctx.slug);
  if (feeds.length === 0) return { statements: [], audits: [], skipped };
  const { slug, now } = ctx;
  return {
    statements: [
      stmtProvisionOwner(slug, now),
      ...feeds.map((f) =>
        stmtProvisionFeed(slug, f.ecosystem, f.namespace, now),
      ),
    ],
    // Audits run after the statements, so the guard is the row this very batch just inserted
    // (its provisioning actor, this timestamp, version 1); a feed that already existed has
    // neither this `updated_at` nor, for an operator's, this `updated_by`.
    audits: feeds.map((f) =>
      auditStatement(
        {
          product: slug,
          at: now,
          ...actorColumns(SYSTEM_ACTORS.resync),
          action: FEED_PROVISION_ACTION,
          target_kind: "registry-feed",
          target_id: f.ecosystem,
          summary: `Provisioned the ${f.ecosystem} package feed from the manifest (Customers)`,
          after_json: JSON.stringify({
            ecosystem: f.ecosystem,
            access: "licensed",
            namespace: f.namespace,
          }),
          origin: "resync",
        },
        sql(
          `WHERE EXISTS (SELECT 1 FROM dist_registry_feeds
                          WHERE product = ? AND ecosystem = ? AND version = 1
                            AND updated_at = ? AND updated_by = ?)`,
          slug,
          f.ecosystem,
          now,
          FEED_PROVISION_ACTOR,
        ),
      ),
    ),
    skipped,
  };
}

async function prepare(ctx: IngestContext): Promise<ManifestContribution> {
  const provision = feedProvisionStatements(ctx);
  const statements = [...distributionStatements(ctx), ...provision.statements];
  return {
    statements,
    audits: provision.audits,
    updated: statements.length > 0 ? ["distribution"] : [],
    ...(provision.skipped.length > 0
      ? { facts: { feedProvision: { skipped: provision.skipped } } }
      : {}),
  };
}

export const distributionManifest: ManifestContributor = { prepare };
