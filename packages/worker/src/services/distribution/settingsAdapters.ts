/**
 * Distribution's adapters for the generic product settings routes (ST-05b): what the bespoke
 * `…/distribution/access` route did beyond routing. `distribution.access` is a RICH setting, one
 * `dist_access` row per deliverable (access.ts), so its adapter reads the rows and writes them
 * through the generic write's guard.
 *
 * The value is a map from deliverable id to `{ mode, entitlement }`. A write names the
 * deliverables it sets and leaves every other row alone; a reset hands the `app` row back to the
 * manifest (only that row has a manifest spelling). A read also carries each row's `source` and
 * `modifiedAt`, which a write ignores.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { ENTITLEMENT_PATTERN } from "@polaris-key/protocol/packs";
import {
  RENDER_ALL,
  stmtEnqueuePackageRender,
} from "../../core/registry/registryQueue.js";
import type { SqlGuard, SettingAdapter } from "../../core/settings/types.js";
import type { DbStatement } from "../../db/types.js";
import {
  isAccessMode,
  ACCESS_MODES,
  listAccess,
  revertAccessStatements,
  setAccessStatements,
} from "./access.js";
import {
  FEED_PROVISION_ACTOR,
  packageFeedsOf,
  stmtWritePackageFeeds,
} from "./registryFeeds.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The statements of a `distribution.packageFeeds` write; also the `PUT …/package-feeds` route's. */
export function packageFeedsStatements(
  slug: string,
  enabled: boolean,
  by: string,
  now: number,
  guard: SqlGuard,
): DbStatement[] {
  return [
    stmtWritePackageFeeds(slug, enabled, by, now, guard),
    // On: render every package feed of the product now.
    ...(enabled
      ? [stmtEnqueuePackageRender(slug, RENDER_ALL, "package-feeds", now)]
      : []),
  ];
}

export function packageFeedsAudit(slug: string, enabled: boolean) {
  return {
    action: "distribution.package_feeds.update",
    target: { kind: "package-feeds", id: slug },
    summary: `${enabled ? "Turned on" : "Turned off"} package feeds for ${slug}`,
  };
}

export const DISTRIBUTION_ADAPTERS: Readonly<Record<string, SettingAdapter>> = {
  // F-34.3: the owner's `packageFeeds` switch, the off switch of every feed of the product
  // (reads, publishes, renders). An adapter over `dist_registry_owners`; the manifest only ever
  // INSERTS the row (F-34.2), so what the operator turned off stays off.
  "distribution.packageFeeds": {
    read: async ({ db, product }) => {
      const owner = await packageFeedsOf(db, product.slug);
      return {
        value: owner.enabled,
        source:
          owner.updatedAt === null
            ? "default"
            : owner.updatedBy === FEED_PROVISION_ACTOR
              ? "manifest"
              : "console",
      };
    },
    set: ({ value, ctx, guard, by }) =>
      packageFeedsStatements(
        ctx.product.slug,
        value === true,
        by ?? "system",
        ctx.now,
        guard,
      ),
    audit: ({ slug, after }) => packageFeedsAudit(slug, after === true),
  },
  "distribution.access": {
    read: async ({ db, product }) => {
      const rows = await listAccess(db, product.slug);
      return {
        value: Object.fromEntries(
          rows.map((r) => [
            r.deliverable_id,
            {
              mode: r.mode,
              entitlement: r.entitlement,
              source: r.source,
              modifiedAt: r.modified_at,
            },
          ]),
        ),
        source:
          rows.find((r) => r.deliverable_id === APP_DELIVERABLE_ID)?.source ===
          "admin"
            ? "console"
            : "manifest",
      };
    },
    validate: async (value, { hooks }) => {
      if (!isRecord(value) || Object.keys(value).length === 0)
        return {
          message: "name at least one deliverable",
          fields: ["deliverable"],
        };
      // A mode for a deliverable Release does not know would gate nothing, and mislead the operator.
      const known = (await hooks.releaseCatalog()?.deliverables()) ?? [];
      for (const [id, entry] of Object.entries(value)) {
        if (id !== APP_DELIVERABLE_ID && !known.some((d) => d.id === id))
          return { message: `no deliverable ${id}`, fields: ["deliverable"] };
        if (!isRecord(entry) || !isAccessMode(entry.mode))
          return {
            message: `mode must be one of ${ACCESS_MODES.join(", ")}`,
            fields: ["mode"],
          };
        if (
          entry.entitlement !== undefined &&
          entry.entitlement !== null &&
          !(
            typeof entry.entitlement === "string" &&
            ENTITLEMENT_PATTERN.test(entry.entitlement)
          )
        )
          return {
            message: "entitlement must be a short identifier or null",
            fields: ["entitlement"],
          };
      }
      return null;
    },
    set: ({ value, ctx, guard }) =>
      Object.entries(value as Record<string, Record<string, unknown>>).flatMap(
        ([id, entry]) =>
          setAccessStatements(
            ctx.product.slug,
            id,
            entry.mode as never,
            entry.entitlement as string | null | undefined,
            ctx.now,
            guard,
          ),
      ),
    reset: ({ ctx, guard }) =>
      revertAccessStatements(ctx.product.slug, ctx.now, guard),
    audit: ({ op, slug, after }) =>
      op === "set"
        ? {
            action: "distribution.access.update",
            target: { kind: "product", id: slug },
            summary: `Set the delivery access of ${slug}: ${Object.entries(
              isRecord(after) ? after : {},
            )
              .map(([id, e]) => `${id} ${String(isRecord(e) ? e.mode : "")}`)
              .join(", ")}`,
          }
        : {
            action: "distribution.access.revert",
            target: { kind: "deliverable", id: APP_DELIVERABLE_ID },
            summary: `Returned the ${APP_DELIVERABLE_ID} delivery access of ${slug} to manifest control`,
          },
  },
};
