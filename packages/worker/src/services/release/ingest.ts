/**
 * Release's contribution to the manifest ingest (P0-26): `release_config` (an insert at create,
 * an update at apply), the release keys (P3-03), the declared deliverables, the Sparkle and
 * binary-name refusals, and the release truth store; after the batch the generation bump, pack
 * sets and mirrors (apply) or the store seeding (create). Release is the GitHub source adapter's
 * home (`linkRepo.ts`, `resync.ts`); this module only reads what the adapter handed down.
 */

import type { DbStatement } from "../../db/types.js";
import {
  isJsonObject,
  parseJsonArray,
  parseJsonColumn,
} from "../../platform/json.js";
import {
  manifestOwned,
  settingAuditor,
  sparkleKeyRefusal,
  binaryNameRefusal,
} from "../../core/ingest/shared.js";
import type {
  IngestContext,
  ManifestContribution,
  ManifestContributor,
  ManifestRefused,
} from "../../core/ingest/types.js";
import { getReleaseConfig, type ReleaseConfigRow } from "./config.js";
import { releaseKeysForSync } from "./records.js";
import { manifestDeliverableStatements } from "./deliverables.js";
import { releaseStoreSync, syncReleaseStore } from "./sync.js";
import { bumpReleaseGeneration } from "./ghCache.js";
import { resolveAndStore, type StoreOutcome } from "./packs/sets.js";
import { enqueueReleaseMirrors } from "./mirror.js";

/** How an audit row shows a column's value: as stored, as parsed JSON, or only whether it is set
 *  (a trust-anchor key is never logged). */
type ColumnView = "text" | "json" | "presence";

/** The `release_config` columns a resync rewrites from `.pkey/release`, with the setting each is
 *  audited under (the registry key where one exists, else the manifest field's own name). */
type ReleaseBlockColumn =
  | "channel_workflow"
  | "beta_branch"
  | "binary_name"
  | "sparkle_ed25519_pub"
  | "summary_marker"
  | "manual_channels_json"
  | "artifact_policy_json"
  | "stable_tag_pattern"
  | "ignore_tags_json";
const RELEASE_BLOCK_AUDIT: readonly (readonly [
  key: string,
  column: ReleaseBlockColumn,
  view: ColumnView,
])[] = [
  ["release.channelWorkflow", "channel_workflow", "text"],
  ["release.betaBranch", "beta_branch", "text"],
  ["release.binaryName", "binary_name", "text"],
  ["release.sparkleEd25519Pub", "sparkle_ed25519_pub", "presence"],
  ["release.summaryMarker", "summary_marker", "text"],
  ["release.manualChannels", "manual_channels_json", "json"],
  ["release.artifactPolicy", "artifact_policy_json", "json"],
  ["release.stableTagPattern", "stable_tag_pattern", "text"],
  ["release.ignoreTags", "ignore_tags_json", "json"],
];

function columnView(view: ColumnView, raw: string | null | undefined): unknown {
  if (view === "presence") return { set: Boolean(raw) };
  if (view === "json") return parseJsonColumn(raw);
  return raw ?? null;
}

/** The kids of a stored `release_keys_json` (`[{kid, publicKey}]`); the keys themselves are not
 *  logged. */
function releaseKeyKids(json: string | null | undefined): string[] {
  return (parseJsonArray(json) ?? []).flatMap((k) =>
    isJsonObject(k) && typeof k.kid === "string" ? [k.kid] : [],
  );
}

/** The product's `release_config`, read once (the caller may have seeded it). */
const releaseConfig = (ctx: IngestContext): Promise<ReleaseConfigRow | null> =>
  ctx.read.memo("release.cfg", () => getReleaseConfig(ctx.db, ctx.slug));

async function prepareCreate(
  ctx: IngestContext,
): Promise<ManifestContribution> {
  const { manifest, slug, now, db } = ctx;
  const gh = ctx.source.repo;
  const rel = manifest.release;
  const statements: DbStatement[] = [];
  // P3-03: a declared release key must never be a signing key of the product (the one minted by
  // Core included). Refused, the product starts with none, and the guidance says why.
  const releaseKeys = await releaseKeysForSync(
    db,
    slug,
    rel?.releaseKeys ?? [],
    ctx.shared.signingPublicKeys,
  );
  // A manifest supplied as documents with no repository has no coordinates to store.
  if (gh) {
    // release_config carries the GitHub coordinates discovered by the adapter.
    statements.push(
      stmtInsertReleaseConfig({
        product: slug,
        ghOwner: gh.owner,
        ghRepo: gh.name,
        ghInstallationId: gh.installId,
        channelWorkflow: rel?.channelWorkflow || null,
        betaBranch: rel?.betaBranch || "main",
        binaryName: rel?.binaryName || gh.name,
        sparkleEd25519Pub: rel?.sparkleEd25519Pub || null,
        summaryMarker: rel?.summaryMarker || "pkey:summary",
        manualChannelsJson: rel?.manualChannels.length
          ? JSON.stringify(rel.manualChannels)
          : null,
        artifactPolicyJson: rel?.artifactPolicy
          ? JSON.stringify(rel.artifactPolicy)
          : null,
        metadataAccess: rel?.access.metadata ?? "public",
        artifactsAccess: rel?.access.artifacts ?? "public",
        // Manifest-owned until an operator claims the modes. `operatorPolicyJson` is
        // deliberately absent: the operator-only artifact policy has no manifest spelling
        // (R6-03), so a freshly linked product starts on the fail-safe defaults.
        accessSource: "manifest",
        stableTagPattern: rel?.stableTagPattern ?? null,
        ignoreTagsJson: rel?.ignoreTags.length
          ? JSON.stringify(rel.ignoreTags)
          : null,
        releaseKeysJson: releaseKeys.ok ? releaseKeys.json : null,
      }),
    );
  }
  // The app deliverable's declaration (P2-04), read back by the truth-store sync below.
  if (rel)
    statements.push(
      ...manifestDeliverableStatements(
        slug,
        rel.app,
        now,
        rel.packDeliverables,
        rel.packageDeliverables,
      ),
    );
  return {
    statements,
    audits: [],
    updated: [],
    facts: {
      releaseKeysRefused: releaseKeys.ok
        ? []
        : releaseKeys.refused.map((r) => r.kid),
    },
    // The release truth store, seeded from the repo's current releases (P2.T2). AFTER the batch,
    // because `release_metadata.product` references `products(slug)`. Best-effort by
    // construction: a repo with no releases yet is the normal case at link time.
    afterCommit: async () => {
      if (gh)
        await syncReleaseStore(
          ctx.env,
          ctx.db,
          slug,
          now,
          ctx.source.fetchImpl,
        );
      return {};
    },
  };
}

async function prepareApply(ctx: IngestContext): Promise<ManifestContribution> {
  const { manifest, slug, now, db, env } = ctx;
  const cfg = await releaseConfig(ctx);
  // Refused by the `sparkle` check before this runs; kept defensive rather than asserted.
  if (!cfg) throw new Error("release: no release_config for an apply");
  const rel = manifest.release;
  const appliedSha = ctx.source.sha;
  const repoName = ctx.source.repo?.name ?? cfg.gh_repo ?? "";
  const binaryName = rel ? rel.binaryName || repoName : null;
  const statements: DbStatement[] = [];
  const updated: string[] = [];
  const refused: ManifestRefused[] = [];
  const { audits, auditSetting } = settingAuditor(slug, now, appliedSha);

  // `releaseKeys` (P3-03): never a product signing key, current or retired. A refused set keeps
  // the previous value (a partial set would drop a key CI may already sign with) and is
  // reported, as the rest of the manifest is still applied.
  const releaseKeys = rel
    ? await releaseKeysForSync(db, slug, rel.releaseKeys)
    : null;
  if (releaseKeys && !releaseKeys.ok)
    for (const r of releaseKeys.refused)
      refused.push({
        code: r.code,
        path: "/release/releaseKeys",
        message: r.message,
      });

  // The row the truth store below reads is this batch's result, built here rather than re-read:
  // the batch has not run yet.
  let syncedCfg: ReleaseConfigRow = cfg;
  if (rel) {
    // `artifact_policy_json` is the MANIFEST half of the artifact policy only. The operator half
    // (requireSparkleSignature, minimumSystemVersion) lives in `operator_policy_json`, which
    // this function never names, so rewriting this blob whole can no longer drop an operator's
    // keys.
    const block = {
      channel_workflow: rel.channelWorkflow || null,
      beta_branch: rel.betaBranch || "main",
      binary_name: binaryName,
      sparkle_ed25519_pub: rel.sparkleEd25519Pub || null,
      summary_marker: rel.summaryMarker || "pkey:summary",
      manual_channels_json: rel.manualChannels.length
        ? JSON.stringify(rel.manualChannels)
        : null,
      artifact_policy_json: rel.artifactPolicy
        ? JSON.stringify(rel.artifactPolicy)
        : null,
      stable_tag_pattern: rel.stableTagPattern,
      ignore_tags_json: rel.ignoreTags.length
        ? JSON.stringify(rel.ignoreTags)
        : null,
    };
    statements.push({
      sql: `UPDATE release_config SET channel_workflow = ?, beta_branch = ?, binary_name = ?,
              sparkle_ed25519_pub = ?, summary_marker = ?, manual_channels_json = ?,
              artifact_policy_json = ?, stable_tag_pattern = ?, ignore_tags_json = ?
              WHERE product = ?`,
      params: [
        block.channel_workflow,
        block.beta_branch,
        block.binary_name,
        block.sparkle_ed25519_pub,
        block.summary_marker,
        block.manual_channels_json,
        block.artifact_policy_json,
        block.stable_tag_pattern,
        block.ignore_tags_json,
        slug,
      ],
    });
    syncedCfg = { ...syncedCfg, ...block };
    if (releaseKeys?.ok) {
      statements.push({
        sql: "UPDATE release_config SET release_keys_json = ? WHERE product = ?",
        params: [releaseKeys.json, slug],
      });
      syncedCfg = { ...syncedCfg, release_keys_json: releaseKeys.json };
    }
    // The two access modes share ONE owner (`access_source`, 0022_b). Once an operator claims
    // them, this matches no row: a manifest cannot express `entitled`, so without the guard every
    // push would silently downgrade an entitled product to the manifest's mode (default public).
    statements.push({
      sql: `UPDATE release_config SET metadata_access = ?, artifacts_access = ?
              WHERE product = ? AND COALESCE(access_source, 'manifest') = 'manifest'`,
      params: [rel.access.metadata, rel.access.artifacts, slug],
    });
    if ((cfg.access_source ?? "manifest") === "manifest")
      syncedCfg = {
        ...syncedCfg,
        metadata_access: rel.access.metadata,
        artifacts_access: rel.access.artifacts,
      };
    // One audit row per column this block actually changes: an unchanged manifest writes none,
    // and a push that swaps the binary name or sets, clears or replaces the update key leaves a
    // permanent row naming the field (the key itself is never logged, only whether it is set).
    for (const [key, column, view] of RELEASE_BLOCK_AUDIT)
      if ((cfg[column] ?? null) !== block[column])
        auditSetting(
          key,
          columnView(view, cfg[column]),
          columnView(view, block[column]),
        );
    if (releaseKeys?.ok && (cfg.release_keys_json ?? null) !== releaseKeys.json)
      auditSetting(
        "release.keys",
        releaseKeyKids(cfg.release_keys_json),
        releaseKeyKids(releaseKeys.json),
      );
    if ((cfg.access_source ?? "manifest") === "manifest") {
      const owned = manifestOwned(
        slug,
        "release_config",
        "product",
        "access_source",
      );
      if ((cfg.metadata_access ?? null) !== rel.access.metadata)
        auditSetting(
          "update.metadataAccess",
          cfg.metadata_access ?? null,
          rel.access.metadata,
          null,
          owned,
        );
      // The artifacts mode is audited where it is written: Distribution's `dist_access` ingest
      // emits `distribution.access` against the row it moves, not against the
      // `release_config.artifacts_access` column nothing reads.
    }
    updated.push("release");
  }

  // The app deliverable's declaration (P2-04): `release_deliverables.def_json` and the channels'
  // `includes`. Before the truth store below, which classifies by the same declaration.
  if (rel) {
    statements.push(
      ...manifestDeliverableStatements(
        slug,
        rel.app,
        now,
        rel.packDeliverables,
        rel.packageDeliverables,
      ),
    );
    updated.push("deliverables");
  }

  // ── release truth store: the same pass, one extra GitHub read (P2.T2) ───────
  //
  // `release_metadata`/`release_artifacts`/`release_channels`/`release_health` ride in the SAME
  // batch as the manifest-owned rows so a resync is one transaction: a truth store that landed
  // separately could survive a failure that rolled the rest back, and the portal would then list
  // releases for a product whose tiers had not been updated.
  const store = await releaseStoreSync(
    env,
    db,
    syncedCfg,
    now,
    ctx.source.fetchImpl,
    rel ? { app: rel.app } : {},
  );
  if (store.statements.length > 0) {
    statements.push(...store.statements);
    updated.push("releases");
  }
  // A GitHub release tagged with a pack release id (P4-02) is skipped, never merged.
  for (const tag of store.packTagConflicts)
    refused.push({
      code: "release_tag_is_pack_release",
      path: `releases/${tag}`,
      message: `GitHub release "${tag}" was not synced: a pack release already has that id`,
    });

  return {
    statements,
    audits,
    updated,
    ...(refused.length > 0 ? { refused } : {}),
    afterCommit: async () => {
      // A resync can change the tag filter, the manual channels and the store: drop every cached
      // resolution of this product (P2-05, `ghCache.ts`).
      await bumpReleaseGeneration(env, slug, now);
      // ...and may change a pack's binding or channels, or the store's app releases (P4-12). A
      // failed resolution clears the sets and is answered; it never fails the resync.
      let packSets: StoreOutcome | null = null;
      if (rel) packSets = await resolveAndStore(db, slug, now);
      // HA-08 (S-20 §6.3): the release files the store's rows left without a copy of ours,
      // queued after the batch and best-effort (`enqueueReleaseMirrors` never throws).
      if (rel) await enqueueReleaseMirrors(env, db, slug, now);
      return packSets && (!packSets.ok || packSets.sets > 0)
        ? { packSets }
        : {};
    },
  };
}

/** The deploy hook's subset (plans/P0-26.md D3): `release_config` and the declared deliverables. */
async function prepareSystem(
  ctx: IngestContext,
): Promise<ManifestContribution> {
  const { manifest, slug, now } = ctx;
  const rel = manifest.release!;
  const repo = ctx.source.repo!;
  const binaryName = rel.binaryName || repo.name;
  const config = stmtInsertReleaseConfig({
    product: slug,
    ghOwner: repo.owner,
    ghRepo: repo.name,
    ghInstallationId: null,
    channelWorkflow: rel.channelWorkflow || null,
    betaBranch: rel.betaBranch || "main",
    binaryName,
    sparkleEd25519Pub: rel.sparkleEd25519Pub || null,
    summaryMarker: rel.summaryMarker || "pkey:summary",
    manualChannelsJson: rel.manualChannels.length
      ? JSON.stringify(rel.manualChannels)
      : null,
    artifactPolicyJson: rel.artifactPolicy
      ? JSON.stringify(rel.artifactPolicy)
      : null,
    metadataAccess: rel.access.metadata,
    artifactsAccess: rel.access.artifacts,
    accessSource: "manifest",
    stableTagPattern: rel.stableTagPattern,
    ignoreTagsJson: rel.ignoreTags.length
      ? JSON.stringify(rel.ignoreTags)
      : null,
  });
  // A first link inserts the row; a later one re-applies the manifest-owned columns exactly as a
  // resync does: the manual channels a package publish's `channel` is checked against among
  // them. The installation id, the operator-only policy, the release keys and the access modes
  // once an operator claimed them (`access_source = 'admin'`) are never touched.
  return {
    statements: [
      {
        sql: `${config.sql}
          ON CONFLICT(product) DO UPDATE SET
            gh_owner = excluded.gh_owner,
            gh_repo = excluded.gh_repo,
            channel_workflow = excluded.channel_workflow,
            beta_branch = excluded.beta_branch,
            binary_name = excluded.binary_name,
            sparkle_ed25519_pub = excluded.sparkle_ed25519_pub,
            summary_marker = excluded.summary_marker,
            manual_channels_json = excluded.manual_channels_json,
            artifact_policy_json = excluded.artifact_policy_json,
            stable_tag_pattern = excluded.stable_tag_pattern,
            ignore_tags_json = excluded.ignore_tags_json,
            metadata_access = CASE WHEN COALESCE(release_config.access_source, 'manifest') = 'manifest'
                                   THEN excluded.metadata_access ELSE release_config.metadata_access END,
            artifacts_access = CASE WHEN COALESCE(release_config.access_source, 'manifest') = 'manifest'
                                    THEN excluded.artifacts_access ELSE release_config.artifacts_access END`,
        params: config.params,
      },
      ...manifestDeliverableStatements(
        slug,
        rel.app,
        now,
        rel.packDeliverables,
        rel.packageDeliverables,
      ),
    ],
    audits: [],
    updated: [],
  };
}

export const releaseManifest: ManifestContributor = {
  checks: (ctx) => [
    {
      check: "binary",
      run: async () => {
        const rel = ctx.manifest.release;
        // R6-01 defence in depth: the repo-name fallback bypasses the manifest boundary. With no
        // release block and no repository (documents only, D8) there is no binary to check.
        const name = rel?.binaryName || ctx.source.repo?.name;
        if (!name || (ctx.mode === "apply" && !rel)) return null;
        const message = binaryNameRefusal(name);
        return message ? { check: "binary", message } : null;
      },
    },
    ...(ctx.mode === "apply"
      ? [
          {
            check: "sparkle",
            run: async () => {
              const cfg = await releaseConfig(ctx);
              if (!cfg)
                return {
                  check: "sparkle",
                  message: "product has no linked repo coordinates",
                };
              const message = sparkleKeyRefusal(
                ctx.manifest,
                cfg?.sparkle_ed25519_pub,
                ctx.slug,
              );
              return message ? { check: "sparkle", message } : null;
            },
          },
        ]
      : []),
  ],
  prepare: (ctx) =>
    ctx.scope === "system"
      ? prepareSystem(ctx)
      : ctx.mode === "create"
        ? prepareCreate(ctx)
        : prepareApply(ctx),
};

// ── statement builders (moved from core/products/store.ts, P0-26) ──────────────

export interface ReleaseConfigInput {
  product: string;
  ghOwner: string;
  ghRepo: string;
  /** NULL for the system product, linked by the deploy hook rather than through the App. */
  ghInstallationId: number | null;
  channelWorkflow: string | null;
  betaBranch: string;
  binaryName: string;
  sparkleEd25519Pub: string | null;
  summaryMarker: string;
  manualChannelsJson?: string | null;
  artifactPolicyJson?: string | null;
  metadataAccess?: string;
  artifactsAccess?: string;
  /** Owner of the two access modes (0022_b). A freshly linked row is manifest-owned. */
  accessSource?: "manifest" | "admin" | null;
  /** The operator-only artifact policy (0022_c). No manifest path supplies it; link leaves it NULL. */
  operatorPolicyJson?: string | null;
  stableTagPattern?: string | null;
  ignoreTagsJson?: string | null;
  /** `release.releaseKeys` (0044, P3-03); NULL when none or refused at link. */
  releaseKeysJson?: string | null;
}

export function stmtInsertReleaseConfig(r: ReleaseConfigInput): DbStatement {
  return {
    sql: `INSERT INTO release_config (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
            manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker, artifact_policy_json,
            metadata_access, artifacts_access, access_source, operator_policy_json,
            stable_tag_pattern, ignore_tags_json, release_keys_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      r.product,
      r.ghOwner,
      r.ghRepo,
      r.ghInstallationId,
      r.channelWorkflow,
      r.betaBranch,
      r.manualChannelsJson ?? null,
      r.binaryName,
      r.sparkleEd25519Pub,
      r.summaryMarker,
      r.artifactPolicyJson ?? null,
      r.metadataAccess ?? "public",
      r.artifactsAccess ?? "public",
      r.accessSource ?? null,
      r.operatorPolicyJson ?? null,
      r.stableTagPattern ?? null,
      r.ignoreTagsJson ?? null,
      r.releaseKeysJson ?? null,
    ],
  };
}
