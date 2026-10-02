/**
 * Distribution's `delivery` descriptor hook (`core/hooks.ts`): how releases reach devices and
 * outlets, read-only.
 *
 *   - `defaultTransport`: `pkey-cdn`, our own CDN (P2b-01).
 *   - `availability` (P2b-03, `availability.ts`): per release and live outlet, the stored CI (later
 *     connector) reports plus the derived `live` records of self-hosted outlets — what P2b-05
 *     (live releases per outlet), P2b-06 (matrix cells) and P3-03 (per-outlet feed entries) read.
 *   - `submissions` (P2b-03): where a release stands in each store's review lifecycle.
 *   - `keys` (P2b-03): the operator-owned signing-key inventory, by purpose — P2b-05's F-Droid
 *     fingerprint, P2b-06's download-page fingerprints, P3-03's release key.
 *   - `rollout` (P2b-04): the outlet rollout for a deliverable on a channel (`dist_rollouts`),
 *     what P3-03 composes into the signed feed, P4-14 extends to packs, P5-02/P5-03 mirror into
 *     and P6-03 halts through.
 *   - `accessMode` (P2b-04): `dist_access` — the ONE delivery-access answer the byte routes, the
 *     appcast and the portal read.
 *   - `outlets` (P3-03): the live outlets with kind, identity and whether an operator narrowed
 *     them — what the signed feed keys its per-outlet entries by.
 *   - `feedSelection` / `feedStamp` (P3-09): P2b-05's feed selection and its cache stamp, for
 *     Update's app-updater feeds (WinSparkle, Velopack, App Installer, zsync, the extended
 *     appcast and version check), which may not import this service.
 *   - `deliveryUrl` (P2b-04): the canonical, immutable byte URL of a release file or of a build's
 *     payload (both as `files/<releaseId>/<name>`), on the bytes host when `BLOB_ORIGIN` is set — what P2b-05's feeds, P2b-06's page, P3-09's updater feeds and
 *     P4-05's pack transports link to.
 *
 * Read-only by contract: a hook never writes.
 */

import {
  DEFAULT_TRANSPORT,
  type Delivery,
  type FeedSelection,
  type FeedSelectionQuery,
  type HookContext,
} from "../../core/hooks.js";
import { bytesHostname } from "../../core/bytesHost.js";
import type { Env } from "../../core/platform.js";
import { accessModeOf } from "./access.js";
import { getRollout, rolloutRecord } from "./rollouts.js";
import { availabilityFor, inventory, submissionsFor } from "./availability.js";
import { listOutlets, parseJsonColumn } from "./outlets.js";
import { selectFeedWith } from "./feeds/select.js";
import { feedStateStamp } from "./feeds/cache.js";

/** The origin byte URLs are minted on: the bytes host when there is one, else none (a path). */
function bytesOrigin(env: Env): string {
  return bytesHostname(env) && env.BLOB_ORIGIN
    ? new URL(env.BLOB_ORIGIN).origin
    : "";
}

/**
 * The immutable `files/<releaseId>/<name>` URL of one release file — on the bytes host when
 * there is one, else a path. `deliveryUrl` mints only this shape, and the storefront feeds
 * (`feeds/select.ts`, which apply the same conditions in bulk) call it directly.
 */
export function fileDeliveryUrl(
  env: Env,
  slug: string,
  releaseId: string,
  name: string,
): string {
  return `${bytesOrigin(env)}/${slug}/distribution/files/${encodeURIComponent(releaseId)}/${encodeURIComponent(name)}`;
}

export function delivery(ctx: HookContext): Delivery {
  const { db, product } = ctx;
  const slug = product.slug;
  return {
    defaultTransport: DEFAULT_TRANSPORT,

    availability: (releaseId: string) =>
      availabilityFor({ db, product: slug, hooks: ctx.hooks }, releaseId),

    submissions: (releaseId: string) =>
      submissionsFor({ db, product: slug, hooks: ctx.hooks }, releaseId),

    keys: (q?: { purpose?: string }) => inventory(db, slug, q?.purpose),

    async outlets() {
      return (await listOutlets(db, slug))
        .filter((o) => o.removed_at === null)
        .map((o) => {
          const identity = parseJsonColumn(o.identity_json);
          return {
            outletId: o.outlet_id,
            kind: o.kind,
            identity:
              identity &&
              typeof identity === "object" &&
              !Array.isArray(identity)
                ? (identity as Record<string, unknown>)
                : {},
            narrowed: o.capabilities_source === "admin",
          };
        });
    },

    async rollout({ deliverable, outlet, channel }) {
      const row = await getRollout(db, slug, deliverable, outlet, channel);
      return row ? rolloutRecord(row) : null;
    },

    accessMode: (deliverable: string) => accessModeOf(db, slug, deliverable),

    async deliveryUrl({ releaseId, buildId, name, outlet }) {
      if ((buildId === undefined) === (name === undefined)) return null;
      const catalog = ctx.hooks.releaseCatalog();
      if (!catalog) return null;

      if (name !== undefined) {
        const file = await catalog.resolve({ kind: "file", releaseId, name });
        if (file?.kind !== "file" || !file.release || !file.artifact)
          return null;
        if (!(await transportIsOurs(ctx, file.release.deliverableId, outlet)))
          return null;
        return fileDeliveryUrl(ctx.env, slug, releaseId, name);
      }

      // A build's immutable URL is its PAYLOAD file's `files/<releaseId>/<name>` URL: pinned to
      // the release by id, never re-read as a selector. The release's stored version is NOT a
      // safe route selector — a GitHub-synced release takes its version from its tag, which can
      // be `latest`, `beta`, `pr-5` or a manual channel's name, and `builds/<that>/…` would
      // resolve the channel's CURRENT release, against P2-05's fixedVersion rule. So no
      // `builds/<version>/…` URL is ever minted here.
      const builds = await catalog.builds(releaseId);
      if (!builds.some((b) => b.buildId === buildId)) return null;
      for (const d of await catalog.deliverables()) {
        const release = (await catalog.releases(d.id)).find(
          (r) => r.releaseId === releaseId,
        );
        if (!release) continue;
        if (!(await transportIsOurs(ctx, d.id, outlet))) return null;
        const payload = (
          await catalog.artifacts(releaseId, buildId as string)
        ).find((a) => a.role === "payload");
        if (!payload) return null;
        // The `files` route serves the first artifact (by id) with that name in the release;
        // mint the URL only when that IS this build's payload, else there is no immutable URL.
        const served = await catalog.resolve({
          kind: "file",
          releaseId,
          name: payload.name,
        });
        if (
          served?.kind !== "file" ||
          served.artifact?.artifactId !== payload.artifactId
        )
          return null;
        return fileDeliveryUrl(ctx.env, slug, releaseId, payload.name);
      }
      return null;
    },

    async feedSelection(q: FeedSelectionQuery): Promise<FeedSelection | null> {
      const catalog = ctx.hooks.releaseCatalog();
      if (!catalog) return null;
      const metadata = await catalog.metadataAccess();
      if (metadata === null) return null;
      const sel = await selectFeedWith(
        {
          db,
          product: { slug, name: product.name },
          hooks: ctx.hooks,
          origin: q.origin,
          env: ctx.env,
        },
        { catalog, notesPublic: metadata === "public" },
        q.channel,
        {
          kinds: q.kinds,
          outletId: q.outletId ?? null,
          platform: q.platform,
          liveness: q.liveness,
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.allBuilds !== undefined ? { allBuilds: q.allBuilds } : {}),
          ...(q.arches ? { arches: q.arches } : {}),
          ...(q.buildIds ? { buildIds: q.buildIds } : {}),
          ...(q.payloadSuffixes ? { payloadSuffixes: q.payloadSuffixes } : {}),
          ...(q.releaseIds ? { releaseIds: q.releaseIds } : {}),
          ...(q.rollouts ? { rollouts: q.rollouts } : {}),
          ...(q.withArtifacts ? { withArtifacts: true } : {}),
        },
      );
      if (!sel) return null;
      return {
        channel: sel.channel,
        outlet: {
          id: sel.outlet.id,
          kind: sel.outlet.kind,
          identity: sel.outlet.identity,
          listing: sel.outlet.listing as Record<string, unknown> | null,
        },
        entries: sel.entries,
        notesPublic: sel.notesPublic,
      };
    },

    async feedStamp() {
      const catalog = ctx.hooks.releaseCatalog();
      if (!catalog) return null;
      const metadata = await catalog.metadataAccess();
      return feedStateStamp(db, slug, catalog, metadata === "public");
    },
  };
}

/**
 * Does `outlet` deliver `deliverable` by our own CDN? No outlet named = yes (the default
 * transport). A live outlet with no transport row for the deliverable uses the default too; a
 * removed or undeclared outlet delivers nothing.
 */
async function transportIsOurs(
  { db, product }: HookContext,
  deliverable: string,
  outlet: string | undefined,
): Promise<boolean> {
  if (outlet === undefined) return true;
  const live = await db.first<{ n: number }>(
    `SELECT 1 AS n FROM dist_outlets
      WHERE product = ? AND outlet_id = ? AND removed_at IS NULL`,
    product.slug,
    outlet,
  );
  if (!live) return false;
  const row = await db.first<{ transport: string }>(
    `SELECT transport FROM dist_transports
      WHERE product = ? AND deliverable_id = ? AND outlet_id = ?`,
    product.slug,
    deliverable,
    outlet,
  );
  return (row?.transport ?? DEFAULT_TRANSPORT) === DEFAULT_TRANSPORT;
}
