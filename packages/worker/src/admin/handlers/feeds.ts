/**
 * The Feeds admin API (F-11, plans/F-01.md §6.9): one handler set, parameterised by scope, behind
 * both of the console's Feeds pages.
 *
 *   Platform  /manage/api/platform/feeds…                    the system product's feeds (our SDKs)
 *                                                            and the platform policy
 *   Product   /manage/api/products/:slug/distribution/feeds… the product's feeds
 *
 *   GET  <base>                                         overview: every ecosystem's feed, the
 *                                                       owner's packageFeeds switch, the summary
 *   GET  <base>/:eco                                    one feed: settings, policy, capabilities,
 *                                                       base URL, stats
 *   PUT  <base>/:eco/settings                           {expectedVersion, enabled?, accessMode?,
 *                                                       namespace?, maxPackageBytes?, upstream?,
 *                                                       ext?} — `feed.settings.update` (409 on a
 *                                                       stale version)
 *   PUT  /platform/feeds/:eco/policy                    {expectedVersion, enabled?,
 *                                                       maxPackageBytesCeiling?} — platform only,
 *                                                       `feed.policy.update` in platform_audit
 *   GET  <base>/:eco/packages?q=&owner=&cursor=         the packages (platform: every owner,
 *                                                       `owner` narrows; product: its own)
 *   GET  <base>/:eco/packages/:name                     product: one package and its versions
 *   GET  /platform/feeds/:eco/packages/:owner/:name     platform: the same, any owner
 *   POST …/packages/…/versions/:version/{yank,unyank,deprecate,undeprecate}
 *                                                       `package.version.*`; refused with
 *                                                       `unsupported_by_ecosystem` where the
 *                                                       protocol has no such state
 *   POST <base>/:eco/rebuild                            re-render the feed — `feed.rebuild`
 *   GET  <base>/retention                               feed retention: the owner's
 *                                                       `release.packages.prunePrereleases`
 *   PUT  <base>/retention                               {expectedVersion, prunePrereleases} —
 *                                                       `feed.retention.update` (409 stale; the
 *                                                       system product's is locked on)
 *   POST <base>/prune                                   {apply?, deliverable?} — the backfill:
 *                                                       each package's builds of main below its
 *                                                       newest stable; a dry run unless `apply`,
 *                                                       each deletion `package.version.prune`
 *   GET  <base>/:eco/activity                           the feed's audit trail
 *   …    <base>/tokens…                                 registry tokens (F-21,
 *                                                       `registryTokens.ts`)
 *
 * `POST /platform/feeds/bootstrap` (`feed.bootstrap`) stays in `platform.ts` (F-03).
 *
 * WHY THIS IS AN ADMIN-LAYER MODULE, not a Distribution `adminHandle` plus a `platformAdmin`
 * descriptor seam (the plan's sketch): a yank, an unyank and a deprecation write Release's
 * `release_packages` (with `release_yanks` and the pack-set invalidation), while the feed settings
 * are Distribution's tables. A service may not call another (rule 6), so the one place both can be
 * composed is the admin layer, which already composes them for the system-product bootstrap
 * (`../systemProduct.ts`). The access controls (session, CSRF, limiter, platform-admin gate) are
 * still the dispatcher's, in `../api.ts` and `platform.ts`, before this is reached.
 *
 * Narrative-only under rule 10 (`adminApi` is NARRATIVE_ONLY in routeCoverage); documented on
 * `/docs/admin/feeds/`. Every write is audited: product-scoped writes (settings, yanks, rebuilds)
 * under the owning product's `audit`, the platform policy in `platform_audit`.
 */

import {
  SYSTEM_PRODUCT_SLUG,
  isPackageEcosystem,
  packageNameNorm,
  type PackageEcosystem,
} from "@polaris-key/manifest";
import type { Env } from "../../env.js";
import type { Db, DbStatement } from "../../db/types.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";
import { audit, platformAudit } from "../audit.js";
import { getProduct, type ProductRow } from "../../repo.js";
import { parseServices } from "../../core/services.js";
import { registryOrigin } from "../../core/registryHostname.js";
import {
  RENDER_ALL,
  stmtEnqueuePackageRender,
} from "../../core/registryQueue.js";
import { packageFeedsOf } from "../../services/distribution/registryFeeds.js";
import { handleRegistryTokensAdmin } from "./registryTokens.js";
import { forgetRegistrySettings } from "../../services/distribution/registry/settings.js";
import { packageCatalog } from "../../services/release/packages/catalog.js";
import {
  pruneRetentionOf,
  prunePackages,
  setPruneRetention,
} from "../../services/release/packages/prune.js";
import {
  setPackageDeprecation,
  unyank,
  yank,
  type PolicyRefusal,
} from "../../services/release/policy.js";
import {
  ECOSYSTEM_LABELS,
  FEED_ACCESS_MODES,
  FEED_CAPABILITIES,
  FEED_EXTENSIONS,
  PACKAGE_ECOSYSTEMS,
  SETTABLE_ACCESS_MODES,
  applyExtPatch,
  feedBaseUrl,
  isVersionVerb,
  namespaceEmpty,
  parseExtPatch,
  parseNamespace,
  verbSupported,
  type FeedSettingsView,
  type VersionVerb,
} from "../lib/feedModel.js";

/** Which console scope a request is in. */
export type FeedScope =
  | { kind: "platform" }
  | { kind: "product"; slug: string };

/** The default page size of the packages list, and its ceiling. */
const PAGE = 50;
const MAX_PAGE = 100;
const MAX_QUERY = 200;

interface FeedRow {
  ecosystem: string;
  enabled: number;
  access_mode: string;
  namespace_json: string;
  max_package_bytes: number;
  upstream: string;
  ext_json: string;
  version: number;
  updated_at: number;
  updated_by: string | null;
}

interface PolicyRow {
  ecosystem: string;
  enabled: number;
  max_package_bytes_ceiling: number;
  version: number;
  updated_at: number;
  updated_by: string | null;
}

function parseObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseArray(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** A tagged version name: the feeds map `stable` to `latest`, every other channel to its name. */
function tagOf(channel: string): string {
  return channel === "stable" ? "latest" : channel;
}

/** Who owns the scope's feeds: the product, or the system product (`null` before the bootstrap). */
async function ownerOf(
  db: Db,
  scope: FeedScope,
): Promise<{ slug: string; row: ProductRow } | null> {
  const slug = scope.kind === "product" ? scope.slug : SYSTEM_PRODUCT_SLUG;
  const row = await getProduct(db, slug);
  if (!row) return null;
  if (scope.kind === "platform" && row.system !== 1) return null;
  return { slug, row };
}

async function feedRows(db: Db, owner: string): Promise<Map<string, FeedRow>> {
  const rows = await db.all<FeedRow>(
    `SELECT ecosystem, enabled, access_mode, namespace_json, max_package_bytes, upstream,
            ext_json, version, updated_at, updated_by
       FROM dist_registry_feeds WHERE product = ?`,
    owner,
  );
  return new Map(rows.map((r) => [r.ecosystem, r]));
}

async function policyRows(db: Db): Promise<Map<string, PolicyRow>> {
  const rows = await db.all<PolicyRow>(
    `SELECT ecosystem, enabled, max_package_bytes_ceiling, version, updated_at, updated_by
       FROM dist_registry_policy`,
  );
  return new Map(rows.map((r) => [r.ecosystem, r]));
}

interface EcoStats {
  packages: number;
  versions: number;
  lastPublishedAt: number | null;
}

async function statsOf(db: Db, owner: string): Promise<Map<string, EcoStats>> {
  const declared = await db.all<{ ecosystem: string; n: number }>(
    `SELECT ecosystem, COUNT(*) AS n FROM release_deliverables
      WHERE product = ? AND kind = 'package' AND ecosystem IS NOT NULL
      GROUP BY ecosystem`,
    owner,
  );
  const published = await db.all<{
    ecosystem: string;
    packages: number;
    versions: number;
    last: number | null;
  }>(
    `SELECT ecosystem, COUNT(DISTINCT deliverable_id) AS packages, COUNT(*) AS versions,
            MAX(published_at) AS last
       FROM release_packages WHERE product = ? GROUP BY ecosystem`,
    owner,
  );
  const out = new Map<string, EcoStats>();
  for (const eco of PACKAGE_ECOSYSTEMS)
    out.set(eco, { packages: 0, versions: 0, lastPublishedAt: null });
  for (const d of declared) {
    const s = out.get(d.ecosystem);
    if (s) s.packages = d.n;
  }
  for (const p of published) {
    const s = out.get(p.ecosystem);
    if (!s) continue;
    s.packages = Math.max(s.packages, p.packages);
    s.versions = p.versions;
    s.lastPublishedAt = p.last;
  }
  return out;
}

/** Why a feed does not answer, in the order the registry's access ladder checks it. */
type OffReason =
  | "platform-off"
  | "no-owner"
  | "distribution-off"
  | "package-feeds-off"
  | "not-set-up"
  | "feed-off";

function statusOf(
  policy: PolicyRow | undefined,
  owner: { distribution: boolean; packageFeeds: boolean } | null,
  feed: FeedRow | undefined,
): { status: "enabled" | "off" | "unavailable"; reason: OffReason | null } {
  if (!policy || policy.enabled !== 1)
    return { status: "unavailable", reason: "platform-off" };
  if (!owner) return { status: "off", reason: "no-owner" };
  if (!owner.distribution) return { status: "off", reason: "distribution-off" };
  if (!owner.packageFeeds)
    return { status: "off", reason: "package-feeds-off" };
  if (!feed) return { status: "off", reason: "not-set-up" };
  if (feed.enabled !== 1) return { status: "off", reason: "feed-off" };
  return { status: "enabled", reason: null };
}

function settingsView(
  feed: FeedRow | undefined,
  policy: PolicyRow | undefined,
): FeedSettingsView {
  if (!feed)
    return {
      enabled: false,
      accessMode: "public",
      namespace: {},
      maxPackageBytes: policy?.max_package_bytes_ceiling ?? 0,
      upstream: "none",
      ext: {},
      version: 0,
      updatedAt: null,
      updatedBy: null,
    };
  return {
    enabled: feed.enabled === 1,
    // Read fail-closed, as the registry does: a value outside the ladder is the strictest.
    accessMode: (FEED_ACCESS_MODES as readonly string[]).includes(
      feed.access_mode,
    )
      ? feed.access_mode
      : "entitled",
    namespace: parseObject(feed.namespace_json),
    maxPackageBytes: feed.max_package_bytes,
    upstream: "none",
    ext: parseObject(feed.ext_json),
    version: feed.version,
    updatedAt: feed.updated_at,
    updatedBy: feed.updated_by,
  };
}

function policyView(policy: PolicyRow | undefined) {
  return policy
    ? {
        enabled: policy.enabled === 1,
        maxPackageBytesCeiling: policy.max_package_bytes_ceiling,
        version: policy.version,
        updatedAt: policy.updated_at,
        updatedBy: policy.updated_by,
      }
    : null;
}

/** Everything the overview and a feed page share, read once. */
async function readContext(env: Env, db: Db, scope: FeedScope) {
  const owner = await ownerOf(db, scope);
  const policies = await policyRows(db);
  const feeds = owner ? await feedRows(db, owner.slug) : new Map();
  const stats = owner ? await statsOf(db, owner.slug) : null;
  const packageFeeds = owner ? await packageFeedsOf(db, owner.slug) : null;
  const distribution = owner
    ? parseServices(owner.row.services_json ?? null).services.distribution
        .enabled
    : false;
  const ownerState = owner
    ? { distribution, packageFeeds: packageFeeds?.enabled === true }
    : null;
  const origin = registryOrigin(env);
  const summary = (eco: PackageEcosystem) => {
    const feed = feeds.get(eco) as FeedRow | undefined;
    const policy = policies.get(eco);
    const s = stats?.get(eco) ?? {
      packages: 0,
      versions: 0,
      lastPublishedAt: null,
    };
    const { status, reason } = statusOf(policy, ownerState, feed);
    return {
      ecosystem: eco,
      label: ECOSYSTEM_LABELS[eco],
      configured: feed !== undefined,
      enabled: feed?.enabled === 1,
      accessMode: settingsView(feed, policy).accessMode,
      status,
      reason,
      packages: s.packages,
      versions: s.versions,
      lastPublishedAt: s.lastPublishedAt,
      baseUrl: owner ? feedBaseUrl(origin, eco, owner.slug) : null,
    };
  };
  return {
    owner,
    policies,
    feeds: feeds as Map<string, FeedRow>,
    packageFeeds,
    distribution,
    origin,
    summary,
    head: {
      scope: scope.kind,
      owner: owner?.slug ?? null,
      ownerName: owner?.row.name ?? null,
      distributionEnabled: distribution,
      packageFeeds,
      registryOrigin: origin,
    },
  };
}

async function overview(env: Env, db: Db, scope: FeedScope) {
  const ctx = await readContext(env, db, scope);
  const feeds = PACKAGE_ECOSYSTEMS.map(ctx.summary);
  const last = feeds
    .map((f) => f.lastPublishedAt)
    .filter((v): v is number => v !== null);
  const body: Record<string, unknown> = {
    ...ctx.head,
    feeds,
    summary: {
      feedsEnabled: feeds.filter((f) => f.status === "enabled").length,
      packages: feeds.reduce((n, f) => n + f.packages, 0),
      versions: feeds.reduce((n, f) => n + f.versions, 0),
      lastPublishedAt: last.length ? Math.max(...last) : null,
    },
  };
  if (scope.kind === "platform") {
    // Every owner with a packageFeeds row: the platform view of who runs feeds at all.
    body.owners = (
      await db.all<{
        product: string;
        enabled: number;
        name: string;
        system: number;
      }>(
        `SELECT o.product, o.enabled, p.name, p.system
           FROM dist_registry_owners o JOIN products p ON p.slug = o.product
          ORDER BY p.system DESC, o.product`,
      )
    ).map((o) => ({
      slug: o.product,
      name: o.name,
      system: o.system === 1,
      packageFeeds: o.enabled === 1,
    }));
  }
  return adminJson(body);
}

async function feedDetail(
  env: Env,
  db: Db,
  scope: FeedScope,
  eco: PackageEcosystem,
) {
  const ctx = await readContext(env, db, scope);
  const policy = ctx.policies.get(eco);
  return adminJson({
    ...ctx.head,
    feed: ctx.summary(eco),
    settings: settingsView(ctx.feeds.get(eco), policy),
    policy: policyView(policy),
    capabilities: FEED_CAPABILITIES[eco],
    extensions: FEED_EXTENSIONS[eco],
    accessModes: FEED_ACCESS_MODES.map((mode) => ({
      mode,
      available: SETTABLE_ACCESS_MODES.includes(mode),
    })),
    // F-21: under `entitled`, a licence token is refused every package with no delivery gate.
    ungatedPackages: ctx.head.owner
      ? await ungatedPackages(db, ctx.head.owner, eco)
      : [],
  });
}

/** The ecosystem's package deliverables with no delivery gate (`dist_access.entitlement`). */
async function ungatedPackages(
  db: Db,
  owner: string,
  eco: PackageEcosystem,
): Promise<{ id: string; name: string }[]> {
  return db.all<{ id: string; name: string }>(
    `SELECT d.deliverable_id AS id, COALESCE(d.package_name, d.deliverable_id) AS name
       FROM release_deliverables d
       LEFT JOIN dist_access a ON a.product = d.product AND a.deliverable_id = d.deliverable_id
      WHERE d.product = ? AND d.kind = 'package' AND d.ecosystem = ?
        AND (a.entitlement IS NULL OR a.entitlement = '')
      ORDER BY name`,
    owner,
    eco,
  );
}

function intOk(v: unknown, min: number, max: number): v is number {
  return (
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
  );
}

const SETTINGS_KEYS = [
  "expectedVersion",
  "enabled",
  "accessMode",
  "namespace",
  "maxPackageBytes",
  "upstream",
  "ext",
] as const;

async function putSettings(
  req: Request,
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  eco: PackageEcosystem,
  now: number,
): Promise<Response> {
  const owner = await ownerOf(db, scope);
  if (!owner)
    return err(
      409,
      "bad_request",
      "the platform's package feeds are not set up; run the bootstrap first",
      { reason: "system_product_missing" },
    );
  const body = await readBody(req);
  const unknown = Object.keys(body).filter(
    (k) => !(SETTINGS_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length)
    return err(422, "bad_request", "unknown settings field", {
      fields: unknown,
    });
  const policy = (await policyRows(db)).get(eco);
  const current = (await feedRows(db, owner.slug)).get(eco);
  const before = settingsView(current, policy);
  const fields: string[] = [];
  if (!intOk(body.expectedVersion, 0, Number.MAX_SAFE_INTEGER))
    fields.push("expectedVersion");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    fields.push("enabled");
  let namespace = before.namespace;
  if (body.namespace !== undefined) {
    const parsed = parseNamespace(eco, body.namespace);
    if (parsed === null) fields.push("namespace");
    else namespace = parsed;
  }
  let ext = before.ext;
  if (body.ext !== undefined) {
    const parsed = parseExtPatch(eco, body.ext);
    if (!parsed.ok) fields.push(`ext.${parsed.key}`);
    else ext = applyExtPatch(before.ext, parsed.patch);
  }
  const ceiling = policy?.max_package_bytes_ceiling ?? 0;
  if (
    body.maxPackageBytes !== undefined &&
    !intOk(body.maxPackageBytes, 1, ceiling)
  )
    fields.push("maxPackageBytes");
  if (body.upstream !== undefined && body.upstream !== "none")
    fields.push("upstream");
  if (fields.length)
    return err(422, "bad_request", "invalid feed settings", { fields });
  if (
    body.accessMode !== undefined &&
    !SETTABLE_ACCESS_MODES.includes(body.accessMode as string)
  )
    return err(
      422,
      "bad_request",
      "accessMode is one of public, authenticated, licensed, entitled",
      { fields: ["accessMode"], reason: "access_mode_unavailable" },
    );
  // The system product's feeds (our SDKs) change only from the platform scope (§6.5).
  if (
    scope.kind === "product" &&
    owner.row.system === 1 &&
    body.accessMode !== undefined &&
    body.accessMode !== before.accessMode
  )
    return err(
      403,
      "forbidden",
      "the platform's own feeds change only under Platform → Package feeds",
      { reason: "platform_scope_only" },
    );
  const enabled =
    body.enabled === undefined ? before.enabled : (body.enabled as boolean);
  if (enabled && namespaceEmpty(eco, namespace))
    return err(
      422,
      "bad_request",
      "a feed cannot be enabled without a namespace: it is the dependency-confusion rule ingest enforces",
      { fields: ["namespace"], reason: "namespace_required" },
    );
  const maxBytes =
    body.maxPackageBytes === undefined
      ? Math.min(before.maxPackageBytes || ceiling, ceiling) || ceiling
      : (body.maxPackageBytes as number);
  if (maxBytes < 1)
    return err(
      409,
      "bad_request",
      "the platform has no size ceiling for this ecosystem",
      { reason: "no_policy" },
    );
  const expected = body.expectedVersion as number;
  const accessMode = (body.accessMode as string | undefined) ?? "public";
  const write: DbStatement =
    expected === 0
      ? {
          sql: `INSERT INTO dist_registry_feeds
                  (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes,
                   upstream, claims_json, ext_json, version, updated_at, updated_by)
                SELECT ?, ?, ?, ?, ?, ?, 'none', '[]', ?, 1, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM dist_registry_feeds
                                    WHERE product = ? AND ecosystem = ?)`,
          params: [
            owner.slug,
            eco,
            enabled ? 1 : 0,
            accessMode,
            JSON.stringify(namespace),
            maxBytes,
            JSON.stringify(ext),
            now,
            session.sub,
            owner.slug,
            eco,
          ],
        }
      : {
          sql: `UPDATE dist_registry_feeds
                   SET enabled = ?, access_mode = ?, namespace_json = ?, max_package_bytes = ?,
                       ext_json = ?, version = version + 1, updated_at = ?, updated_by = ?
                 WHERE product = ? AND ecosystem = ? AND version = ?`,
          params: [
            enabled ? 1 : 0,
            body.accessMode === undefined ? before.accessMode : accessMode,
            JSON.stringify(namespace),
            maxBytes,
            JSON.stringify(ext),
            now,
            session.sub,
            owner.slug,
            eco,
            expected,
          ],
        };
  const changed = await db.runChanges(write.sql, ...write.params);
  if (changed === 0) {
    const fresh = settingsView(
      (await feedRows(db, owner.slug)).get(eco),
      policy,
    );
    return err(
      409,
      "bad_request",
      "the feed's settings changed since you read them",
      { reason: "version_conflict", settings: fresh },
    );
  }
  // A settings change re-renders the owner's documents (an index may name the namespace or hide
  // yanked versions), and drops this isolate's cached settings so the change answers at once.
  await db.batch([
    stmtEnqueuePackageRender(owner.slug, RENDER_ALL, "settings", now),
  ]);
  forgetRegistrySettings(owner.slug);
  const after = settingsView((await feedRows(db, owner.slug)).get(eco), policy);
  const changes = (
    ["enabled", "accessMode", "namespace", "maxPackageBytes", "ext"] as const
  ).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  await audit(
    db,
    owner.slug,
    session,
    now,
    "feed.settings.update",
    { kind: "feed", id: eco },
    expected === 0
      ? `Set up the ${ECOSYSTEM_LABELS[eco]} feed${enabled ? " (enabled)" : ""}`
      : `Updated the ${ECOSYSTEM_LABELS[eco]} feed's settings${changes.length ? `: ${changes.join(", ")}` : ""}`,
  );
  return adminJson({ ok: true, settings: after });
}

async function putPolicy(
  req: Request,
  db: Db,
  session: AdminSession,
  eco: PackageEcosystem,
  now: number,
): Promise<Response> {
  const body = await readBody(req);
  const unknown = Object.keys(body).filter(
    (k) =>
      !["expectedVersion", "enabled", "maxPackageBytesCeiling"].includes(k),
  );
  const fields = [...unknown];
  if (!intOk(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER))
    fields.push("expectedVersion");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    fields.push("enabled");
  // A ceiling is a byte count: at least 1 KiB, at most 5 GiB (OCI's blob ceiling).
  if (
    body.maxPackageBytesCeiling !== undefined &&
    !intOk(body.maxPackageBytesCeiling, 1024, 5 * 1024 ** 3)
  )
    fields.push("maxPackageBytesCeiling");
  if (body.enabled === undefined && body.maxPackageBytesCeiling === undefined)
    fields.push("enabled");
  if (fields.length)
    return err(422, "bad_request", "invalid platform policy", { fields });
  const before = (await policyRows(db)).get(eco);
  if (!before) return notFound();
  const enabled =
    body.enabled === undefined
      ? before.enabled === 1
      : (body.enabled as boolean);
  const ceiling =
    (body.maxPackageBytesCeiling as number | undefined) ??
    before.max_package_bytes_ceiling;
  const changed = await db.runChanges(
    `UPDATE dist_registry_policy
        SET enabled = ?, max_package_bytes_ceiling = ?, version = version + 1, updated_at = ?,
            updated_by = ?
      WHERE ecosystem = ? AND version = ?`,
    enabled ? 1 : 0,
    ceiling,
    now,
    session.sub,
    eco,
    body.expectedVersion as number,
  );
  if (changed === 0)
    return err(
      409,
      "bad_request",
      "the platform policy changed since you read it",
      {
        reason: "version_conflict",
        policy: policyView((await policyRows(db)).get(eco)),
      },
    );
  // The kill switch and the ceiling govern every owner: drop every cached answer here.
  forgetRegistrySettings();
  const after = (await policyRows(db)).get(eco);
  await platformAudit(
    db,
    session,
    now,
    "feed.policy.update",
    { kind: "feed", id: eco },
    `Updated the platform's ${ECOSYSTEM_LABELS[eco]} policy: ${enabled ? "on" : "off"}, ceiling ${ceiling} bytes`,
    {
      before: {
        enabled: before.enabled === 1,
        maxPackageBytesCeiling: before.max_package_bytes_ceiling,
      },
      after: { enabled, maxPackageBytesCeiling: ceiling },
    },
  );
  return adminJson({ ok: true, policy: policyView(after) });
}

interface PackageRow {
  owner: string;
  deliverable_id: string;
  name: string;
  versions: number;
  live: number;
  last: number | null;
  latest: string | null;
}

const PACKAGE_COLUMNS = `
  d.product AS owner, d.deliverable_id, d.package_name AS name,
  (SELECT COUNT(*) FROM release_packages p
    WHERE p.product = d.product AND p.deliverable_id = d.deliverable_id) AS versions,
  (SELECT COUNT(*) FROM release_packages p
    WHERE p.product = d.product AND p.deliverable_id = d.deliverable_id
      AND p.state != 'yanked') AS live,
  (SELECT MAX(published_at) FROM release_packages p
    WHERE p.product = d.product AND p.deliverable_id = d.deliverable_id) AS last,
  (SELECT version FROM release_packages p
    WHERE p.product = d.product AND p.deliverable_id = d.deliverable_id
      AND p.state != 'yanked'
    ORDER BY p.published_at DESC, p.version DESC LIMIT 1) AS latest`;

async function tagsOf(
  db: Db,
  owner: string,
  deliverableId: string,
): Promise<{ tag: string; channel: string; version: string }[]> {
  const heads = await packageCatalog({ db, slug: owner }).packageChannelHeads(
    deliverableId,
  );
  return heads.map((h) => ({
    tag: tagOf(h.channel),
    channel: h.channel,
    version: h.version,
  }));
}

async function listPackages(
  req: Request,
  db: Db,
  scope: FeedScope,
  eco: PackageEcosystem,
): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const ownerParam = url.searchParams.get("owner") ?? "";
  const cursor = Number(url.searchParams.get("cursor") ?? "0");
  const rawLimit = Math.trunc(Number(url.searchParams.get("limit")));
  const limit = rawLimit >= 1 ? Math.min(rawLimit, MAX_PAGE) : PAGE;
  if (
    q.length > MAX_QUERY ||
    ownerParam.length > MAX_QUERY ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0
  )
    return err(422, "bad_request", "invalid packages query", {
      fields: ["q", "owner", "cursor"].filter((k) =>
        k === "q"
          ? q.length > MAX_QUERY
          : k === "owner"
            ? ownerParam.length > MAX_QUERY
            : !Number.isSafeInteger(cursor) || cursor < 0,
      ),
    });
  const where = ["d.kind = 'package'", "d.ecosystem = ?"];
  const params: (string | number)[] = [eco];
  const owner =
    scope.kind === "product" ? scope.slug : ownerParam ? ownerParam : null;
  if (owner !== null) {
    where.push("d.product = ?");
    params.push(owner);
  }
  if (q) {
    where.push(
      "(lower(d.package_name) LIKE ? ESCAPE '\\' OR lower(d.deliverable_id) LIKE ? ESCAPE '\\')",
    );
    const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  const rows = await db.all<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS}
       FROM release_deliverables d
      WHERE ${where.join(" AND ")}
      ORDER BY d.product, lower(d.package_name), d.deliverable_id
      LIMIT ? OFFSET ?`,
    ...params,
    limit + 1,
    cursor,
  );
  const page = rows.slice(0, limit);
  const items = [];
  for (const r of page)
    items.push({
      owner: r.owner,
      deliverableId: r.deliverable_id,
      name: r.name,
      versions: r.versions,
      liveVersions: r.live,
      latestVersion: r.latest,
      lastPublishedAt: r.last,
      tags: await tagsOf(db, r.owner, r.deliverable_id),
    });
  return adminJson({
    items,
    nextCursor: rows.length > limit ? String(cursor + limit) : null,
  });
}

/** The package deliverable `name` names in `owner`'s `eco` feed (compared by its norm). */
async function findPackage(
  db: Db,
  owner: string,
  eco: PackageEcosystem,
  name: string,
): Promise<{ deliverableId: string; name: string } | null> {
  const rows = await db.all<{ deliverable_id: string; package_name: string }>(
    `SELECT deliverable_id, package_name FROM release_deliverables
      WHERE product = ? AND kind = 'package' AND ecosystem = ?`,
    owner,
    eco,
  );
  const norm = packageNameNorm(eco, name);
  const hit = rows.find(
    (r) => r.package_name && packageNameNorm(eco, r.package_name) === norm,
  );
  return hit
    ? { deliverableId: hit.deliverable_id, name: hit.package_name }
    : null;
}

interface VersionRow {
  release_id: string;
  version: string;
  state: "live" | "yanked" | "deprecated";
  state_message: string | null;
  files_json: string;
  source_json: string;
  published_at: number;
  channel: string | null;
}

function sourceView(json: string) {
  const s = parseObject(json);
  const kind =
    s.kind === "oidc" ||
    s.kind === "static" ||
    s.kind === "console" ||
    s.kind === "registry"
      ? s.kind
      : "unknown";
  const runUrl =
    typeof s.runUrl === "string" && /^https:\/\//.test(s.runUrl)
      ? s.runUrl
      : null;
  return {
    kind,
    publisher: typeof s.publisher === "string" ? s.publisher : null,
    runUrl,
    tokenId: typeof s.tokenId === "string" ? s.tokenId : null,
    // F-22: the native client that published (`npm`, `twine`, `swift`, `maven`), or null.
    client:
      typeof s.client === "string" && /^[a-z]{1,16}$/.test(s.client)
        ? s.client
        : null,
    // F-23: the version came through `docker push` rather than an upload ticket.
    via: s.via === "oci-push" ? ("oci-push" as const) : null,
  };
}

function fileView(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  if (
    typeof f.name !== "string" ||
    typeof f.type !== "string" ||
    typeof f.sha256 !== "string" ||
    typeof f.size !== "number"
  )
    return null;
  const out: Record<string, unknown> = {
    name: f.name,
    type: f.type,
    size: f.size,
    sha256: f.sha256,
  };
  for (const k of ["sha512", "sha1", "md5"] as const)
    if (typeof f[k] === "string") out[k] = f[k];
  return out;
}

async function packageRecord(
  env: Env,
  db: Db,
  owner: string,
  eco: PackageEcosystem,
  name: string,
): Promise<Response> {
  const pkg = await findPackage(db, owner, eco, name);
  if (!pkg) return notFound();
  const rows = await db.all<VersionRow>(
    `SELECT p.release_id, p.version, p.state, p.state_message, p.files_json, p.source_json,
            p.published_at, m.channel
       FROM release_packages p
       LEFT JOIN release_metadata m ON m.product = p.product AND m.release_id = p.release_id
      WHERE p.product = ? AND p.deliverable_id = ?
      ORDER BY p.published_at DESC, COALESCE(m.seq, 0) DESC, p.version DESC`,
    owner,
    pkg.deliverableId,
  );
  const tags = await tagsOf(db, owner, pkg.deliverableId);
  const ownerRow = await getProduct(db, owner);
  return adminJson({
    owner,
    ownerName: ownerRow?.name ?? owner,
    ecosystem: eco,
    deliverableId: pkg.deliverableId,
    name: pkg.name,
    baseUrl: feedBaseUrl(registryOrigin(env), eco, owner),
    capabilities: FEED_CAPABILITIES[eco],
    tags,
    versions: rows.map((r) => {
      const files = parseArray(r.files_json)
        .map(fileView)
        .filter((f): f is Record<string, unknown> => f !== null);
      return {
        version: r.version,
        releaseId: r.release_id,
        channel: r.channel,
        tags: tags.filter((t) => t.version === r.version).map((t) => t.tag),
        state: r.state,
        stateMessage: r.state_message,
        publishedAt: r.published_at,
        source: sourceView(r.source_json),
        size: files.reduce((n, f) => n + (f.size as number), 0),
        files,
      };
    }),
  });
}

function refusal(r: PolicyRefusal): Response {
  return err(
    r.status,
    r.code,
    r.message,
    r.fields ? { reason: r.reason, fields: r.fields } : { reason: r.reason },
  );
}

async function versionAction(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  owner: string,
  eco: PackageEcosystem,
  name: string,
  version: string,
  verb: VersionVerb,
  now: number,
): Promise<Response> {
  if (!verbSupported(eco, verb))
    return err(
      422,
      "bad_request",
      verb === "yank" || verb === "unyank"
        ? `${ECOSYSTEM_LABELS[eco]} has no yank that clients honour${FEED_CAPABILITIES[eco].deprecate ? "; deprecate the version instead" : ""}`
        : `${ECOSYSTEM_LABELS[eco]} has no deprecation state`,
      { reason: "unsupported_by_ecosystem" },
    );
  const pkg = await findPackage(db, owner, eco, name);
  if (!pkg) return notFound();
  const row = await db.first<{ release_id: string }>(
    `SELECT release_id FROM release_packages
      WHERE product = ? AND deliverable_id = ? AND version = ?`,
    owner,
    pkg.deliverableId,
    version,
  );
  if (!row) return notFound();
  const body =
    verb === "yank" || verb === "deprecate" ? await readBody(req) : {};
  const actor = { kind: "admin" as const, session };
  const auditAs = {
    action: `package.version.${verb}`,
    target: { kind: "package", id: `${eco}:${pkg.name}@${version}` },
  };
  if (verb === "yank") {
    const r = await yank(
      env,
      db,
      owner,
      row.release_id,
      body.reason,
      actor,
      now,
      auditAs,
    );
    return r.ok ? adminJson({ ok: true, state: "yanked" }) : refusal(r);
  }
  if (verb === "unyank") {
    const r = await unyank(env, db, owner, row.release_id, actor, now, auditAs);
    return r.ok ? adminJson({ ok: true, state: "live" }) : refusal(r);
  }
  const r = await setPackageDeprecation(
    env,
    db,
    owner,
    row.release_id,
    verb === "deprecate" ? (body.message ?? "") : null,
    actor,
    now,
    auditAs,
  );
  return r.ok
    ? adminJson({ ok: true, state: r.deprecation.state })
    : refusal(r);
}

async function rebuild(
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  eco: PackageEcosystem,
  now: number,
): Promise<Response> {
  const owner = await ownerOf(db, scope);
  if (!owner) return notFound();
  const ids = await db.all<{ deliverable_id: string }>(
    `SELECT deliverable_id FROM release_deliverables
      WHERE product = ? AND kind = 'package' AND ecosystem = ?`,
    owner.slug,
    eco,
  );
  if (ids.length)
    await db.batch(
      ids.map((d) =>
        stmtEnqueuePackageRender(owner.slug, d.deliverable_id, "rebuild", now),
      ),
    );
  await audit(
    db,
    owner.slug,
    session,
    now,
    "feed.rebuild",
    { kind: "feed", id: eco },
    `Queued a rebuild of the ${ECOSYSTEM_LABELS[eco]} feed (${ids.length} package${ids.length === 1 ? "" : "s"})`,
  );
  return adminJson({ ok: true, queued: ids.length });
}

async function activity(
  db: Db,
  scope: FeedScope,
  eco: PackageEcosystem,
): Promise<Response> {
  const owner = await ownerOf(db, scope);
  type Item = {
    id: string;
    at: number;
    actor: { sub: string; name: string; email: string };
    action: string;
    target: { kind: string; id: string } | null;
    summary: string;
  };
  const items: Item[] = [];
  const map = (r: {
    id: string;
    at: number;
    actor_sub: string | null;
    actor_name: string | null;
    actor_email: string | null;
    action: string;
    target_kind: string | null;
    target_id: string | null;
    summary: string | null;
  }): Item => ({
    id: r.id,
    at: r.at,
    actor: {
      sub: r.actor_sub ?? "",
      name: r.actor_name ?? "",
      email: r.actor_email ?? "",
    },
    action: r.action,
    target: r.target_kind
      ? { kind: r.target_kind, id: r.target_id ?? "" }
      : null,
    summary: r.summary ?? "",
  });
  const cols =
    "id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary";
  if (owner)
    items.push(
      ...(
        await db.all<Parameters<typeof map>[0]>(
          `SELECT ${cols} FROM audit
            WHERE product = ?
              AND ((target_kind = 'feed' AND target_id = ?)
                OR (target_kind = 'package' AND substr(target_id, 1, ?) = ?))
            ORDER BY at DESC, id DESC LIMIT 50`,
          owner.slug,
          eco,
          eco.length + 1,
          `${eco}:`,
        )
      ).map(map),
    );
  if (scope.kind === "platform")
    items.push(
      ...(
        await db.all<Parameters<typeof map>[0]>(
          `SELECT ${cols} FROM platform_audit
            WHERE action LIKE 'feed.%'
              AND ((target_kind = 'feed' AND target_id = ?) OR action = 'feed.bootstrap')
            ORDER BY at DESC, id DESC LIMIT 50`,
          eco,
        )
      ).map(map),
    );
  items.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return adminJson({ items: items.slice(0, 50) });
}

// ── Feed retention ───────────────────────────────────────────────────────────────────────────

/** `GET <base>/retention`: the owner's `release.packages.prunePrereleases`. */
async function getRetention(db: Db, scope: FeedScope): Promise<Response> {
  const owner = await ownerOf(db, scope);
  if (!owner) return notFound();
  return adminJson({
    product: owner.slug,
    ...(await pruneRetentionOf(db, owner.slug)),
  });
}

/** `PUT <base>/retention` `{expectedVersion, prunePrereleases}` — `feed.retention.update`. */
async function putRetention(
  req: Request,
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  now: number,
): Promise<Response> {
  const owner = await ownerOf(db, scope);
  if (!owner) return notFound();
  const body = await readBody(req);
  const fields: string[] = [];
  if (!intOk(body.expectedVersion, 0, Number.MAX_SAFE_INTEGER))
    fields.push("expectedVersion");
  if (typeof body.prunePrereleases !== "boolean")
    fields.push("prunePrereleases");
  if (fields.length)
    return err(422, "bad_request", "invalid retention setting", { fields });
  const enabled = body.prunePrereleases as boolean;
  const outcome = await setPruneRetention(
    db,
    owner.slug,
    enabled,
    body.expectedVersion as number,
    `admin:${session.sub}`,
    now,
  );
  if (outcome === "locked")
    return err(
      403,
      "forbidden",
      "the platform's own feeds always prune the builds of main once a version is released",
      { reason: "retention_locked" },
    );
  if (outcome === "stale")
    return err(
      409,
      "bad_request",
      "the retention setting changed since you read it",
      { reason: "version_conflict" },
    );
  await audit(
    db,
    owner.slug,
    session,
    now,
    "feed.retention.update",
    { kind: "feed", id: "retention" },
    enabled
      ? "Turned on pruning of the builds of main once a version is released"
      : "Turned off pruning of the builds of main once a version is released",
  );
  return adminJson({
    product: owner.slug,
    ...(await pruneRetentionOf(db, owner.slug)),
  });
}

/** `POST <base>/prune` `{apply?, deliverable?}`: the backfill, a dry run unless `apply`. */
async function prune(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  now: number,
): Promise<Response> {
  const owner = await ownerOf(db, scope);
  if (!owner) return notFound();
  const body = await readBody(req);
  const fields: string[] = [];
  if (body.apply !== undefined && typeof body.apply !== "boolean")
    fields.push("apply");
  if (body.deliverable !== undefined && typeof body.deliverable !== "string")
    fields.push("deliverable");
  if (fields.length)
    return err(422, "bad_request", "invalid prune request", { fields });
  const report = await prunePackages(db, env, owner.slug, {
    apply: body.apply === true,
    ...(typeof body.deliverable === "string"
      ? { deliverable: body.deliverable }
      : {}),
    actor: {
      sub: `admin:${session.sub}`,
      name: session.name,
      email: session.email,
    },
    now,
  });
  if (!report) return notFound();
  return adminJson(report);
}

/**
 * Route one Feeds request. `rest` is the path after `…/feeds`. The caller has already run the
 * session, CSRF, limiter and platform-admin gates; a product-scope caller has checked the product
 * exists.
 */
export async function handleFeedsAdmin(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  rest: string[],
  now: number,
): Promise<Response> {
  const method = req.method;
  const notAllowed = () => err(405, "method_not_allowed", "method not allowed");
  if (rest.length === 0) {
    if (method !== "GET") return notAllowed();
    return overview(env, db, scope);
  }
  if (rest[0] === "tokens")
    return handleRegistryTokensAdmin(
      req,
      env,
      db,
      session,
      scope,
      rest.slice(1),
      now,
    );
  if (rest.length === 1 && rest[0] === "retention") {
    if (method === "GET") return getRetention(db, scope);
    if (method === "PUT") return putRetention(req, db, session, scope, now);
    return notAllowed();
  }
  if (rest.length === 1 && rest[0] === "prune") {
    if (method !== "POST") return notAllowed();
    return prune(req, env, db, session, scope, now);
  }
  const eco = rest[0]!;
  if (!isPackageEcosystem(eco)) return notFound();
  if (rest.length === 1) {
    if (method !== "GET") return notAllowed();
    return feedDetail(env, db, scope, eco);
  }
  const [, sub, ...tail] = rest;
  if (tail.length === 0) {
    if (sub === "settings") {
      if (method !== "PUT") return notAllowed();
      return putSettings(req, db, session, scope, eco, now);
    }
    if (sub === "policy") {
      if (scope.kind !== "platform") return notFound();
      if (method !== "PUT") return notAllowed();
      return putPolicy(req, db, session, eco, now);
    }
    if (sub === "rebuild") {
      if (method !== "POST") return notAllowed();
      return rebuild(db, session, scope, eco, now);
    }
    if (sub === "activity") {
      if (method !== "GET") return notAllowed();
      return activity(db, scope, eco);
    }
    if (sub === "packages") {
      if (method !== "GET") return notAllowed();
      return listPackages(req, db, scope, eco);
    }
    return notFound();
  }
  if (sub !== "packages") return notFound();
  // The package: `:name` in product scope, `:owner/:name` in platform scope.
  const idLength = scope.kind === "platform" ? 2 : 1;
  const ids = tail.slice(0, idLength).map(decode);
  if (ids.length !== idLength || ids.some((s) => s === null || s === ""))
    return notFound();
  const owner = scope.kind === "platform" ? ids[0]! : scope.slug;
  const name = ids[idLength - 1]!;
  const after = tail.slice(idLength);
  if (after.length === 0) {
    if (method !== "GET") return notAllowed();
    if (!(await getProduct(db, owner))) return notFound();
    return packageRecord(env, db, owner, eco, name);
  }
  if (
    after.length === 3 &&
    after[0] === "versions" &&
    isVersionVerb(after[2]!)
  ) {
    if (method !== "POST") return notAllowed();
    const version = decode(after[1]!);
    if (!version) return notFound();
    if (!(await getProduct(db, owner))) return notFound();
    return versionAction(
      req,
      env,
      db,
      session,
      owner,
      eco,
      name,
      version,
      after[2] as VersionVerb,
      now,
    );
  }
  return notFound();
}
