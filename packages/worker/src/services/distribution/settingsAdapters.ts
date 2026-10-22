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
import type { SettingAdapter } from "../../core/settings/types.js";
import {
  isAccessMode,
  ACCESS_MODES,
  listAccess,
  revertAccessStatements,
  setAccessStatements,
} from "./access.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export const DISTRIBUTION_ADAPTERS: Readonly<Record<string, SettingAdapter>> = {
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
