/**
 * License's adapters for the generic product settings routes (ST-05b): what the bespoke
 * `…/license/policy` route checked beyond routing, for the two policies that answer "on what terms
 * does a machine get a seat". `license.fingerprint` is how tightly a device is bound to the
 * hardware it activated on; `license.autoIssue` is whether an unrecognised enrolment mints a
 * licence on the spot, and on which tier.
 */

import { getTier } from "../../core/licensing/store.js";
import { invalidateWidenedEdgeMintApprovals } from "../../core/edgeMintApproval.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
  isAutoIssueMode,
  isFingerprintMode,
  parseFingerprintPolicy,
} from "../../core/fingerprint.js";
import type {
  SettingAdapter,
  SettingRefusal,
} from "../../core/settings/types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const refuse = (fields: string[]): SettingRefusal => ({
  message: "invalid policy",
  fields,
});

export const LICENSE_ADAPTERS: Readonly<Record<string, SettingAdapter>> = {
  "license.fingerprint": {
    inForce: (value) => value ?? DEFAULT_FINGERPRINT_POLICY,
    validate: (value) => {
      if (!isRecord(value)) return refuse(["policy"]);
      const fields: string[] = [];
      if (typeof value.enabled !== "boolean") fields.push("enabled");
      if (!isFingerprintMode(value.defaultMode)) fields.push("defaultMode");
      if (!Array.isArray(value.probes)) fields.push("probes");
      else if (
        // The parser the Worker reads policy through, so an admin cannot store a shape the
        // runtime would silently discard.
        parseFingerprintPolicy(JSON.stringify({ probes: value.probes })).probes
          .length !== value.probes.length
      )
        fields.push("probes");
      return fields.length > 0 ? refuse(fields) : null;
    },
    audit: ({ op, slug, after }) =>
      op === "set"
        ? {
            action: "product.policy.update",
            target: { kind: "product", id: slug },
            summary: `Set the device policy for ${slug}: fingerprint ${
              isRecord(after) && after.enabled === false
                ? "disabled"
                : String(isRecord(after) ? after.defaultMode : "")
            }`,
          }
        : {
            action: "product.fingerprint.revert",
            target: { kind: "product", id: slug },
            summary: `Returned the fingerprint policy for ${slug} to manifest control`,
          },
  },
  "license.autoIssue": {
    inForce: (value) => value ?? DEFAULT_AUTO_ISSUE,
    validate: async (value, { db, product }) => {
      if (!isRecord(value)) return refuse(["policy"]);
      const fields: string[] = [];
      if (typeof value.enabled !== "boolean") fields.push("enabled");
      if (
        value.tierId !== null &&
        value.tierId !== undefined &&
        typeof value.tierId !== "string"
      )
        fields.push("tierId");
      if (!isAutoIssueMode(value.mode)) fields.push("mode");
      if (
        typeof value.rateLimitPerHour !== "number" ||
        !Number.isFinite(value.rateLimitPerHour) ||
        value.rateLimitPerHour < 0
      )
        fields.push("rateLimitPerHour");
      // Enabling with a tier that doesn't exist would mint licenses whose entitlements nobody
      // configured, so it is rejected here rather than failing silently at enrol.
      if (value.enabled === true && fields.length === 0) {
        if (typeof value.tierId !== "string" || value.tierId === "")
          fields.push("tierId");
        else if (!(await getTier(db, product.slug, value.tierId)))
          fields.push("tierId");
      }
      return fields.length > 0 ? refuse(fields) : null;
    },
    // P0-12: the auto-issue policy decides whether the edge mint is public, so drop every
    // approval the product has ALREADY widened before writing it; otherwise turning anonymous
    // enrolment back off here, after a push that turned it on was killed before its own sweep,
    // would make the approval apply again for the strangers who enrolled meanwhile.
    beforeWrite: async ({ db, product, now }) => {
      await invalidateWidenedEdgeMintApprovals(
        db,
        product.slug,
        now,
        "found widened before a console edit",
      );
    },
    audit: ({ op, slug, after }) =>
      op === "set"
        ? {
            action: "product.policy.update",
            target: { kind: "product", id: slug },
            summary: `Set the device policy for ${slug}: auto-issue ${
              isRecord(after) && after.enabled === true
                ? `${String(after.mode)} → ${String(after.tierId)}`
                : "disabled"
            }`,
          }
        : {
            action: "product.fingerprint.revert",
            target: { kind: "product", id: slug },
            summary: `Returned the auto-issue policy for ${slug} to manifest control`,
          },
  },
};
