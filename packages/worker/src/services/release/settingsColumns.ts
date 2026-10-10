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

import { parseJsonObject, tryParseJson } from "../../platform/json.js";
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

/** A `release_config` text column, decoded as the setting's value (NULL or empty: unset). */
function releaseText(column: string): SettingColumnAdapter {
  return {
    table: "release_config",
    keyColumn: "product",
    columns: [column],
    decode: (row) =>
      typeof row?.[column] === "string" && row[column] !== ""
        ? row[column]
        : undefined,
  };
}

/** A `release_config` JSON column, decoded as the setting's value. */
function releaseJson(column: string): SettingColumnAdapter {
  return {
    table: "release_config",
    keyColumn: "product",
    columns: [column],
    decode: (row) => {
      const raw = row?.[column];
      return typeof raw === "string" ? tryParseJson(raw) : undefined;
    },
  };
}

/** Release's own keys. */
export const RELEASE_COLUMN_ADAPTERS: Readonly<
  Record<string, SettingColumnAdapter>
> = {
  // ST-19b's `.pkey/release` block: manifest-only, written by link and resync (the manifest
  // writer), decoded here for the resolver. No console writer, so a write is refused.
  "release.github": {
    table: "release_config",
    keyColumn: "product",
    columns: ["gh_owner", "gh_repo"],
    decode: (row) =>
      typeof row?.gh_owner === "string" &&
      row.gh_owner !== "" &&
      typeof row.gh_repo === "string" &&
      row.gh_repo !== ""
        ? { type: "github", owner: row.gh_owner, repo: row.gh_repo }
        : undefined,
  },
  "release.binaryName": releaseText("binary_name"),
  "release.channelWorkflow": releaseText("channel_workflow"),
  "release.betaBranch": releaseText("beta_branch"),
  "release.summaryMarker": releaseText("summary_marker"),
  "release.manualChannels": releaseJson("manual_channels_json"),
  "release.keys": releaseJson("release_keys_json"),
  // Manifest-only (`.pkey/release`): decoded for the resolver; no console write reaches them.
  "release.artifactPolicy": {
    table: "release_config",
    keyColumn: "product",
    columns: ["artifact_policy_json"],
    decode: (row) => parseJsonObject(row?.artifact_policy_json) ?? undefined,
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
    decode: (row) => parseJsonObject(row?.operator_policy_json) ?? undefined,
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
