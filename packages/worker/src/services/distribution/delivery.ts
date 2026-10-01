/**
 * Distribution's `delivery` descriptor hook (`core/hooks.ts`): how releases reach devices and
 * outlets, read-only.
 *
 *   - `defaultTransport`: `pkey-cdn`, our own CDN (P2b-01).
 *   - `availability`: empty until P2b-03 records it.
 *   - `rollout` (P2b-04): the outlet rollout for a deliverable on a channel (`dist_rollouts`),
 *     what P3-03 composes into the signed feed, P4-14 extends to packs, P5-02/P5-03 mirror into
 *     and P6-03 halts through.
 *   - `accessMode` (P2b-04): `dist_access` — the ONE delivery-access answer the byte routes, the
 *     appcast and the portal read.
 *   - `deliveryUrl` (P2b-04): the canonical byte URL of a release file or build, on the bytes host
 *     when `BLOB_ORIGIN` is set — what P2b-05's feeds, P2b-06's page, P3-09's updater feeds and
 *     P4-05's pack transports link to.
 *
 * Read-only by contract: a hook never writes.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import {
  DEFAULT_TRANSPORT,
  type AvailabilityRecord,
  type Delivery,
  type HookContext,
} from "../../core/hooks.js";
import { bytesHostname } from "../../core/bytesHost.js";
import { accessModeOf } from "./access.js";
import { getRollout, rolloutRecord } from "./rollouts.js";

/** The origin byte URLs are minted on: the bytes host when there is one, else none (a path). */
function bytesOrigin(ctx: HookContext): string {
  return bytesHostname(ctx.env) && ctx.env.BLOB_ORIGIN
    ? new URL(ctx.env.BLOB_ORIGIN).origin
    : "";
}

export function delivery(ctx: HookContext): Delivery {
  const { db, product } = ctx;
  const slug = product.slug;
  return {
    defaultTransport: DEFAULT_TRANSPORT,

    async availability(): Promise<AvailabilityRecord[]> {
      return [];
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
      const base = `${bytesOrigin(ctx)}/${slug}/distribution`;

      if (name !== undefined) {
        const file = await catalog.resolve({ kind: "file", releaseId, name });
        if (file?.kind !== "file" || !file.release || !file.artifact)
          return null;
        if (!(await transportIsOurs(ctx, file.release.deliverableId, outlet)))
          return null;
        return `${base}/files/${encodeURIComponent(releaseId)}/${encodeURIComponent(name)}`;
      }

      // A build is served pinned to its release's VERSION (an immutable URL), for the
      // deliverable that owns the release.
      const builds = await catalog.builds(releaseId);
      if (!builds.some((b) => b.buildId === buildId)) return null;
      for (const d of await catalog.deliverables()) {
        const release = (await catalog.releases(d.id)).find(
          (r) => r.releaseId === releaseId,
        );
        if (!release) continue;
        if (!(await transportIsOurs(ctx, d.id, outlet))) return null;
        const query =
          d.id === APP_DELIVERABLE_ID
            ? ""
            : `?deliverable=${encodeURIComponent(d.id)}`;
        return `${base}/builds/${encodeURIComponent(release.version)}/${encodeURIComponent(buildId as string)}${query}`;
      }
      return null;
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
