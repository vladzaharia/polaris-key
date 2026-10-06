/**
 * Column adapters for the settings stored in Release's tables (ST-04, notes/S-18 §4.3):
 * `release_config` and `release_package_retention`. Core's resolver decodes them and Core's
 * `writeSetting()` is the only caller of `set` / `reset`; the SQL lives here, with the tables'
 * owner (`release_config` is Release's, spec §5.2), never in Core.
 *
 * Contributed through the slices: Release's (`settings.ts`) for its own keys, and Update's for
 * `update.metadataAccess` / `update.operatorPolicy`, which Update owns but which live in
 * `release_config` (Update → Release is the one sanctioned cross-service edge, D-05).
 *
 * Every statement ANDs the write's guard into its `WHERE` (`ColumnWriteArgs.guard`).
 */

import type { DbStatement } from "../../db/types.js";
import type {
  ColumnWriteArgs,
  SettingColumnAdapter,
} from "../../core/settings/types.js";

/** `UPDATE release_config SET … WHERE product = ? AND <guard>` (the row must exist). */
function updateReleaseConfig(
  { product, guard }: ColumnWriteArgs,
  sets: readonly [column: string, value: string | number | null][],
): DbStatement[] {
  return [
    {
      sql: `UPDATE release_config SET ${sets.map(([c]) => `${c} = ?`).join(", ")}
             WHERE product = ? AND (${guard.sql})`,
      params: [...sets.map(([, v]) => v), product, ...guard.params],
    },
  ];
}

function parseObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Release's own keys. */
export const RELEASE_COLUMN_ADAPTERS: Readonly<
  Record<string, SettingColumnAdapter>
> = {
  // Manifest-only (`.pkey/release`): decoded for the resolver, never written from the console.
  "release.artifactPolicy": {
    table: "release_config",
    keyColumn: "product",
    columns: ["artifact_policy_json"],
    decode: (row) => parseObject(row?.artifact_policy_json),
  },
  "release.sparkleEd25519Pub": {
    table: "release_config",
    keyColumn: "product",
    columns: ["sparkle_ed25519_pub"],
    decode: (row) =>
      typeof row?.sparkle_ed25519_pub === "string" &&
      row.sparkle_ed25519_pub !== ""
        ? row.sparkle_ed25519_pub
        : undefined,
  },
  // The table keeps its own `version`/`updated_*` columns (the feed screen's history); the
  // write bumps them too, while `product_settings` carries the setting's version for the guard.
  "release.packages.prunePrereleases": {
    table: "release_package_retention",
    keyColumn: "product",
    columns: ["prune_prereleases"],
    decode: (row) => (row ? row.prune_prereleases === 1 : undefined),
    set: ({ product, at, by, guard, value }) => [
      {
        sql: `INSERT INTO release_package_retention
                (product, prune_prereleases, version, updated_at, updated_by)
              SELECT ?, ?, 1, ?, ? WHERE (${guard.sql})
              ON CONFLICT(product) DO UPDATE SET
                prune_prereleases = excluded.prune_prereleases,
                version = release_package_retention.version + 1,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        params: [product, value === true ? 1 : 0, at, by, ...guard.params],
      },
    ],
  },
};

/** Update's keys stored in `release_config`, handed to Update's slice. */
export const UPDATE_COLUMN_ADAPTERS: Readonly<
  Record<string, SettingColumnAdapter>
> = {
  // Claimable through the legacy `access_source` marker (`admin` = the console's): a console
  // write flips it, Revert flips it back and the next resync re-applies `.pkey/release`.
  "update.metadataAccess": {
    table: "release_config",
    keyColumn: "product",
    columns: ["metadata_access", "access_source"],
    decode: (row) =>
      typeof row?.metadata_access === "string"
        ? row.metadata_access
        : undefined,
    marker: (row) => (row?.access_source === "admin" ? "console" : "manifest"),
    set: (args) =>
      updateReleaseConfig(args, [
        ["metadata_access", args.value as string],
        ["access_source", "admin"],
      ]),
    reset: (args) => updateReleaseConfig(args, [["access_source", "manifest"]]),
  },
  // Operator-only (no manifest spelling): the whole object; an empty one is stored as NULL.
  "update.operatorPolicy": {
    table: "release_config",
    keyColumn: "product",
    columns: ["operator_policy_json"],
    decode: (row) => parseObject(row?.operator_policy_json),
    set: (args) => {
      const v = args.value as Record<string, unknown> | null;
      return updateReleaseConfig(args, [
        [
          "operator_policy_json",
          v && Object.keys(v).length > 0 ? JSON.stringify(v) : null,
        ],
      ]);
    },
    reset: (args) =>
      updateReleaseConfig(args, [["operator_policy_json", null]]),
  },
};
