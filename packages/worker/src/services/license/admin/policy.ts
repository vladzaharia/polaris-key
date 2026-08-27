/// <reference types="@cloudflare/workers-types" />

/**
 * Enrollment & fingerprint policy — `GET|PATCH /manage/api/products/<slug>/license/policy` and
 * `POST …/license/policy/revert` (§R1).
 *
 * ── WHY LICENSE OWNS IT ─────────────────────────────────────────────────────────────────────
 *
 * It is two policies that answer one question: on what terms does a machine get a seat. The
 * fingerprint half decides how tightly a device is bound to the hardware it activated on and
 * how much drift is tolerated before the binding is refused; the auto-issue half decides whether
 * an unrecognised enrolment mints a licence on the spot and on which tier. Both are read on the
 * activation and enrolment paths, which are License's, and neither means anything to a product
 * that does not run the License service.
 *
 * ── WHY IT IS OPERATOR-CLAIMABLE ────────────────────────────────────────────────────────────
 *
 * It is declared in the product manifest but must also be changeable live — the drift lockout an
 * operator is paging about at 3am cannot wait for a pull request. That is only coherent if the
 * next resync cannot silently undo the change, so the row carries an owner: a PATCH marks it
 * `admin`, `revert` hands it back to `manifest` and the next resync re-applies the declaration.
 * Same machinery as `services_json` (`core/servicesAdmin.ts`) and for the same reason.
 */

import { ErrorCode } from "../../../core/errors.js";
import type { ProductRow } from "../../../core/data.js";
import {
  getProduct,
  getTier,
  revertAutoIssueToManifest,
  revertFingerprintPolicyToManifest,
  setAutoIssuePolicy,
  setFingerprintPolicy,
} from "../../../core/data.js";
import {
  isAutoIssueMode,
  isFingerprintMode,
  parseAutoIssue,
  parseFingerprintPolicy,
} from "../../../core/fingerprint.js";
import {
  adminJson,
  adminNotFound,
  audit,
  err,
  readBody,
} from "../../../core/adminApi.js";
import type { LicenseAdminContext } from "./index.js";

export async function handleFingerprintPolicy(
  ctx: LicenseAdminContext,
  action: string | undefined,
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;
  const row = await getProduct(db, slug);
  if (!row) return adminNotFound();

  if (action === "revert") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    await revertFingerprintPolicyToManifest(db, slug, now);
    await revertAutoIssueToManifest(db, slug, now);
    await audit(
      db,
      slug,
      session,
      now,
      "product.fingerprint.revert",
      { kind: "product", id: slug },
      `Returned the fingerprint policy for ${slug} to manifest control`,
    );
    const reverted = await getProduct(db, slug);
    return adminJson(policyView(reverted));
  }
  if (action !== undefined) return adminNotFound();

  if (req.method === "GET") return adminJson(policyView(row));
  if (req.method !== "PATCH")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const current = parseFingerprintPolicy(row.fingerprint_policy_json);
  const fields: string[] = [];

  let enabled = current.enabled;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") fields.push("enabled");
    else enabled = body.enabled;
  }

  let defaultMode = current.defaultMode;
  if (body.defaultMode !== undefined) {
    if (!isFingerprintMode(body.defaultMode)) fields.push("defaultMode");
    else defaultMode = body.defaultMode;
  }

  let probes = current.probes;
  if (body.probes !== undefined) {
    if (!Array.isArray(body.probes)) fields.push("probes");
    else {
      // Reuse the same parser the Worker reads policy through, so an admin cannot store a
      // shape the runtime would silently discard.
      probes = parseFingerprintPolicy(
        JSON.stringify({ probes: body.probes }),
      ).probes;
      if (probes.length !== body.probes.length) fields.push("probes");
    }
  }

  // ── auto-issue ──────────────────────────────────────────────────────────────
  const currentAuto = parseAutoIssue(row.auto_issue_json);
  const auto = { ...currentAuto };
  if (body.autoIssue !== undefined) {
    if (
      !body.autoIssue ||
      typeof body.autoIssue !== "object" ||
      Array.isArray(body.autoIssue)
    ) {
      fields.push("autoIssue");
    } else {
      const patch = body.autoIssue as Record<string, unknown>;
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== "boolean")
          fields.push("autoIssue.enabled");
        else auto.enabled = patch.enabled;
      }
      if (patch.tierId !== undefined) {
        if (patch.tierId !== null && typeof patch.tierId !== "string")
          fields.push("autoIssue.tierId");
        else auto.tierId = (patch.tierId as string | null) || null;
      }
      if (patch.mode !== undefined) {
        if (!isAutoIssueMode(patch.mode)) fields.push("autoIssue.mode");
        else auto.mode = patch.mode;
      }
      if (patch.rateLimitPerHour !== undefined) {
        if (
          typeof patch.rateLimitPerHour !== "number" ||
          !Number.isFinite(patch.rateLimitPerHour) ||
          patch.rateLimitPerHour < 0
        ) {
          fields.push("autoIssue.rateLimitPerHour");
        } else auto.rateLimitPerHour = Math.trunc(patch.rateLimitPerHour);
      }
      // Enabling with a tier that doesn't exist would mint licenses whose entitlements
      // nobody configured, so it is rejected here rather than failing silently at enroll.
      if (auto.enabled) {
        if (!auto.tierId) fields.push("autoIssue.tierId");
        else if (!(await getTier(db, slug, auto.tierId)))
          fields.push("autoIssue.tierId");
      }
    }
  }

  if (fields.length > 0)
    return err(422, ErrorCode.BadRequest, "invalid policy", { fields });

  const policy = { enabled, defaultMode, probes };
  await setFingerprintPolicy(db, slug, JSON.stringify(policy), "admin", now);
  if (body.autoIssue !== undefined) {
    await setAutoIssuePolicy(db, slug, JSON.stringify(auto), "admin", now);
  }
  await audit(
    db,
    slug,
    session,
    now,
    "product.policy.update",
    { kind: "product", id: slug },
    `Set the device policy for ${slug}: fingerprint ${enabled ? defaultMode : "disabled"}, ` +
      `auto-issue ${auto.enabled ? `${auto.mode} → ${auto.tierId}` : "disabled"}`,
  );
  return adminJson(await policyView(await getProduct(db, slug)));
}

/** One projection for both GET and the post-write echo, so they can't drift. */
function policyView(row: ProductRow | null): {
  policy: ReturnType<typeof parseFingerprintPolicy>;
  source: string;
  autoIssue: ReturnType<typeof parseAutoIssue>;
  autoIssueSource: string;
} {
  return {
    policy: parseFingerprintPolicy(row?.fingerprint_policy_json),
    source: row?.fingerprint_policy_source ?? "manifest",
    autoIssue: parseAutoIssue(row?.auto_issue_json),
    autoIssueSource: row?.auto_issue_source ?? "manifest",
  };
}
