/**
 * Adapters for the generic product settings routes (ST-05b) over the settings the bespoke
 * `…/update/settings` route used to write: the compatibility window (Release's), and, handed to
 * Update's slice, the metadata access mode and the operator-only artifact policy. They are the
 * validation and the audit rows of that route, so the one generic write path keeps them.
 */

import type {
  SettingAdapter,
  SettingAdapterContext,
} from "../../core/settings/types.js";
import {
  getReleaseConfig,
  MINIMUM_SYSTEM_VERSION_RE,
  operatorPolicy,
} from "./config.js";

/** A semver bound the window may name. Same shape the manifest validator accepts. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `release_config` holds the access mode and the artifact policy's anchor: none, nothing to write. */
async function noReleaseConfig(ctx: {
  db: SettingAdapterContext["db"];
  product: { slug: string };
}): Promise<string | null> {
  return (await getReleaseConfig(ctx.db, ctx.product.slug))
    ? null
    : "This product has no release configuration yet";
}

export const RELEASE_ADAPTERS: Readonly<Record<string, SettingAdapter>> = {
  "release.compatWindow": {
    validate: (value) => {
      if (!isRecord(value))
        return { message: "invalid update settings", fields: ["compatWindow"] };
      const fields = (["min", "max"] as const).filter(
        (k) => typeof value[k] !== "string" || !SEMVER.test(value[k]),
      );
      return fields.length > 0
        ? {
            message: "invalid update settings",
            fields: fields.map((f) =>
              f === "min" ? "compatMin" : "compatMax",
            ),
          }
        : null;
    },
    audit: ({ op, slug, after }) =>
      op === "set"
        ? {
            action: "update.settings.update",
            target: { kind: "product", id: slug },
            summary: `Updated update settings for ${slug}: compatibility window ${String(
              isRecord(after) ? after.min : "",
            )} – ${String(isRecord(after) ? after.max : "")}`,
          }
        : {
            action: "update.settings.revert",
            target: { kind: "product", id: slug },
            summary: `Returned compat settings for ${slug} to manifest control`,
          },
  },
};

/** Update's keys, handed to its slice. The columns are Release's (`release_config`). */
export const UPDATE_ADAPTERS: Readonly<Record<string, SettingAdapter>> = {
  "update.metadataAccess": {
    // 422 rather than a silent no-op: `release_config`'s UPDATE would match no row, and the
    // console would show a saved value the next read does not return.
    blocked: noReleaseConfig,
    validate: async (_value, ctx) => {
      const message = await noReleaseConfig(ctx);
      return message ? { message, fields: ["metadataAccess"] } : null;
    },
    audit: ({ op, slug, after }) =>
      op === "set"
        ? {
            action: "update.settings.update",
            target: { kind: "product", id: slug },
            summary: `Updated update settings for ${slug}: metadata access ${String(after)}`,
          }
        : {
            action: "update.settings.revert",
            target: { kind: "product", id: slug },
            summary: `Returned access settings for ${slug} to manifest control`,
          },
  },
  "update.operatorPolicy": {
    // Fail-safe in both directions: none stored means signature required, no minimum.
    inForce: (value) => ({
      requireSparkleSignature: true,
      ...(isRecord(value) ? value : {}),
    }),
    blocked: noReleaseConfig,
    validate: async (value, { db, product }) => {
      if (!isRecord(value))
        return { message: "invalid update settings", fields: ["policy"] };
      const fields: string[] = [];
      if (
        value.requireSparkleSignature !== undefined &&
        typeof value.requireSparkleSignature !== "boolean"
      )
        fields.push("requireSparkleSignature");
      // Same shape check the feed applies before rendering, so a value this accepts is a value
      // the appcast will actually carry.
      if (
        value.minimumSystemVersion !== undefined &&
        (typeof value.minimumSystemVersion !== "string" ||
          !MINIMUM_SYSTEM_VERSION_RE.test(value.minimumSystemVersion))
      )
        fields.push("minimumSystemVersion");
      if (fields.length > 0)
        return { message: "invalid update settings", fields };
      const message = await noReleaseConfig({ db, product } as never);
      return message ? { message, fields: Object.keys(value) } : null;
    },
    // Its own event, not folded into `update.settings.update`: the signature requirement is a
    // security control, and switching it off must be findable in the audit log by action alone.
    audit: ({ op, slug, before, after }) => {
      const stored = (v: unknown) =>
        operatorPolicy({
          operator_policy_json: isRecord(v) ? JSON.stringify(v) : null,
        });
      const was = stored(before);
      const now = stored(after);
      const changes: string[] = [];
      if (now.requireSparkleSignature !== was.requireSparkleSignature)
        changes.push(
          now.requireSparkleSignature
            ? "required Sparkle signatures"
            : "DISABLED the Sparkle signature requirement",
        );
      if (now.minimumSystemVersion !== was.minimumSystemVersion)
        changes.push(
          now.minimumSystemVersion === undefined
            ? "cleared minimumSystemVersion"
            : `set minimumSystemVersion to ${now.minimumSystemVersion}`,
        );
      return {
        action: "release.policy.update",
        target: { kind: "product", id: slug },
        summary:
          op === "reset"
            ? `Artifact policy for ${slug} reset to its defaults`
            : changes.length > 0
              ? `Artifact policy for ${slug}: ${changes.join("; ")}`
              : `Artifact policy for ${slug} saved unchanged`,
      };
    },
  },
};
