/**
 * Device trust levels and the operator's trust policy (P6-02) — the Core accessor that edge-mint
 * (Config), gated delivery (Distribution's byte routes, through `core/entitledAccess.ts`) and,
 * once P6-01 lands, the commerce claim consult.
 *
 * ── VOCABULARY ──────────────────────────────────────────────────────────────────────────────
 *
 * "Trust level", never "tier": the glossary reserves tier for licence tiers. A device is `basic`
 * (every device, and the expected answer for web, desktop and sideloaded builds) or `attested`
 * (it proved a genuine store install with App Attest or Play Integrity against a fresh challenge;
 * `core/attestation.ts`). The level lives on the device row, never in a signed document.
 *
 * ── FAIL CLOSED ON VERIFICATION, FAIL OPEN ON POLICY ───────────────────────────────────────
 *
 * Verification only ever raises a device, and only on a verdict that passed every check. Policy
 * is the opposite: the default requires `basic` everywhere, a corrupt policy reads as the default,
 * and even a policy that requires `attested` only AUDITS a would-be refusal until the operator
 * sets `enforce: true`. Turning attestation on can therefore never lock real players out by
 * itself — the operator watches the audit trail, then enforces.
 *
 * ── WHO WRITES THE POLICY ───────────────────────────────────────────────────────────────────
 *
 * Only a platform admin, through `PUT /manage/api/products/<slug>/trust-policy`
 * (`admin/handlers/trustPolicy.ts`), which sets `trust_policy_source = 'admin'`. No manifest
 * field, ingest or resync writes it: a repo writer could otherwise point the App Attest Team ID
 * at an app they control or relax enforcement (THREAT-MODEL.md, "Device trust levels").
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { DeviceRow } from "../repo.js";
import { appendAudit } from "../repo.js";
import { randomId } from "../crypto.js";
import { pk } from "../kv.js";
import { errorResponse, wireError } from "./errors.js";
import type { ProductPublic } from "./products.js";

export type TrustLevel = "basic" | "attested";
export const TRUST_LEVELS: readonly TrustLevel[] = ["basic", "attested"];

/** The operations a policy can gate. */
export type TrustOperation = "mint" | "gatedDelivery" | "commerceClaim";
export const TRUST_OPERATIONS: readonly TrustOperation[] = [
  "mint",
  "gatedDelivery",
  "commerceClaim",
];

export interface TrustPolicy {
  mint: TrustLevel;
  gatedDelivery: TrustLevel;
  commerceClaim: TrustLevel;
  /** false (default): a would-be refusal is audited and the request proceeds. */
  enforce: boolean;
  /** App Attest: the Apple Developer Team ID and which aaguid the product's builds carry.
   *  `teamId: null` (omitted in the PUT) uses the platform's Apple Team ID (A-16,
   *  `platformAppleTeamId`); an explicit one wins. */
  appAttest: {
    teamId: string | null;
    environment: "production" | "development";
  } | null;
  /** Play Integrity: the Google Cloud project number the app's standard requests use. Handed to
   *  the client with the challenge; the verifier itself needs only the pinned Play credential. */
  playIntegrity: {
    /** `null` (omitted in the PUT): the platform's Play Integrity cloud project number (A-16,
     *  `platformPlayIntegrityProjectNumber`); an explicit one wins. */
    cloudProjectNumber: string | null;
    /** Accept a verdict Google marks `testingDetails.isTestingResponse` (a license tester's
     *  configured response, not a real device check). Off unless set: for internal testing only. */
    allowTestingResponses?: true;
  } | null;
}

export const DEFAULT_TRUST_POLICY: TrustPolicy = Object.freeze({
  mint: "basic",
  gatedDelivery: "basic",
  commerceClaim: "basic",
  enforce: false,
  appAttest: null,
  playIntegrity: null,
}) as TrustPolicy;

/** An Apple Developer Team ID: ten uppercase alphanumerics. */
export const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
/** A Google Cloud project number: digits only. */
export const CLOUD_PROJECT_NUMBER_RE = /^[0-9]{1,20}$/;

type Validation =
  | { ok: true; policy: TrustPolicy }
  | { ok: false; message: string; field: string };

/** Validate an operator's policy body (the admin PUT). Unknown members are refused. */
export function validateTrustPolicy(input: unknown): Validation {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, message: "policy must be an object", field: "" };
  const o = input as Record<string, unknown>;
  const known = new Set<string>([
    ...TRUST_OPERATIONS,
    "enforce",
    "appAttest",
    "playIntegrity",
  ]);
  for (const k of Object.keys(o))
    if (!known.has(k))
      return { ok: false, message: `unknown member ${k}`, field: k };
  const policy: TrustPolicy = { ...DEFAULT_TRUST_POLICY };
  for (const op of TRUST_OPERATIONS) {
    const v = o[op];
    if (v === undefined) continue;
    if (v !== "basic" && v !== "attested")
      return {
        ok: false,
        message: `${op} must be "basic" or "attested"`,
        field: op,
      };
    policy[op] = v;
  }
  if (o.enforce !== undefined) {
    if (typeof o.enforce !== "boolean")
      return {
        ok: false,
        message: "enforce must be a boolean",
        field: "enforce",
      };
    policy.enforce = o.enforce;
  }
  if (o.appAttest !== undefined && o.appAttest !== null) {
    const a = o.appAttest as Record<string, unknown>;
    if (typeof a !== "object" || Array.isArray(a))
      return {
        ok: false,
        message: "appAttest must be an object",
        field: "appAttest",
      };
    for (const k of Object.keys(a))
      if (k !== "teamId" && k !== "environment")
        return {
          ok: false,
          message: `unknown member appAttest.${k}`,
          field: "appAttest",
        };
    const teamId = a.teamId ?? null;
    if (
      teamId !== null &&
      (typeof teamId !== "string" || !TEAM_ID_RE.test(teamId))
    )
      return {
        ok: false,
        message:
          "appAttest.teamId must be the 10-character Apple Developer Team ID",
        field: "appAttest.teamId",
      };
    const env = a.environment ?? "production";
    if (env !== "production" && env !== "development")
      return {
        ok: false,
        message: 'appAttest.environment must be "production" or "development"',
        field: "appAttest.environment",
      };
    policy.appAttest = { teamId, environment: env };
  }
  if (o.playIntegrity !== undefined && o.playIntegrity !== null) {
    const p = o.playIntegrity as Record<string, unknown>;
    if (typeof p !== "object" || Array.isArray(p))
      return {
        ok: false,
        message: "playIntegrity must be an object",
        field: "playIntegrity",
      };
    for (const k of Object.keys(p))
      if (k !== "cloudProjectNumber" && k !== "allowTestingResponses")
        return {
          ok: false,
          message: `unknown member playIntegrity.${k}`,
          field: "playIntegrity",
        };
    const cloudProjectNumber = p.cloudProjectNumber ?? null;
    if (
      cloudProjectNumber !== null &&
      (typeof cloudProjectNumber !== "string" ||
        !CLOUD_PROJECT_NUMBER_RE.test(cloudProjectNumber))
    )
      return {
        ok: false,
        message:
          "playIntegrity.cloudProjectNumber must be the Google Cloud project number (digits)",
        field: "playIntegrity.cloudProjectNumber",
      };
    if (
      p.allowTestingResponses !== undefined &&
      typeof p.allowTestingResponses !== "boolean"
    )
      return {
        ok: false,
        message: "playIntegrity.allowTestingResponses must be a boolean",
        field: "playIntegrity.allowTestingResponses",
      };
    policy.playIntegrity = {
      cloudProjectNumber,
      ...(p.allowTestingResponses === true
        ? { allowTestingResponses: true as const }
        : {}),
    };
  }
  return { ok: true, policy };
}

/** The stored policy, or the default for NULL and for anything that no longer validates. */
export function parseTrustPolicy(json: string | null | undefined): TrustPolicy {
  if (!json) return DEFAULT_TRUST_POLICY;
  try {
    const v = validateTrustPolicy(JSON.parse(json) as unknown);
    return v.ok ? v.policy : DEFAULT_TRUST_POLICY;
  } catch {
    return DEFAULT_TRUST_POLICY;
  }
}

/** The product's policy (loaded with the product; a hand-built product reads as the default). */
export function trustPolicyOf(
  product: Pick<ProductPublic, "trustPolicy">,
): TrustPolicy {
  return product.trustPolicy ?? DEFAULT_TRUST_POLICY;
}

/** A device row's trust level. Anything but `attested` is `basic`. */
export function deviceTrustLevel(
  device: Pick<DeviceRow, "trust_level">,
): TrustLevel {
  return device.trust_level === "attested" ? "attested" : "basic";
}

/** Would-be refusals are audited at most once per device, operation and window. */
export const TRUST_AUDIT_WINDOW = 60 * 60;

/**
 * The trust gate for one operation: `null` to proceed, or the refusal to answer.
 *
 * A device that meets the policy, or a policy that requires `basic`, proceeds with no I/O at all,
 * which is every request under the default policy. Otherwise the would-be refusal is audited
 * (`device.trust.refused` when enforced, `device.trust.would_refuse` in log-only mode, at most
 * once per device and operation per `TRUST_AUDIT_WINDOW`, so a byte route under a download loop
 * cannot flood the audit table) and, only with `enforce: true`, refused with
 * `403 attestation_required` in the caller's body shape (`flat` for surfaces that answer
 * `errorResponse`, `wire` for the nested v3 shape).
 */
export async function trustRefusal(
  env: Env,
  db: Db,
  product: ProductPublic,
  device: DeviceRow,
  op: TrustOperation,
  now: number,
  shape: "flat" | "wire",
): Promise<Response | null> {
  const policy = trustPolicyOf(product);
  if (policy[op] !== "attested" || deviceTrustLevel(device) === "attested")
    return null;

  const dedupeKey = pk(
    product.slug,
    "trust-audit",
    `${op}:${device.device_id}`,
  );
  let seen = false;
  try {
    seen = (await env.HOT.get(dedupeKey)) !== null;
  } catch {
    seen = false;
  }
  if (!seen) {
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: "system:trust",
      actor_name: "Device trust policy",
      actor_email: null,
      action: policy.enforce
        ? "device.trust.refused"
        : "device.trust.would_refuse",
      target_kind: "device",
      target_id: device.device_id,
      parent_id: null,
      summary: `${op} requires an attested device; this device is basic${policy.enforce ? " (refused)" : " (log-only: allowed)"}`,
    });
    try {
      await env.HOT.put(dedupeKey, "1", { expirationTtl: TRUST_AUDIT_WINDOW });
    } catch {
      // The dedupe marker is an optimisation; losing it costs another audit row, nothing more.
    }
  }
  if (!policy.enforce) return null;
  const message = "this operation requires an attested device";
  return shape === "flat"
    ? errorResponse(403, "attestation_required", message)
    : wireError(403, "attestation_required", { message });
}
