/**
 * The device trust policy as the console edits it (ST-12). `relaxesTrustPolicy` mirrors the
 * Worker's rule (`core/trust/deviceTrust.ts`), which decides; the console uses it only to word
 * the confirmation and to send the L2 guard (step-up, reason, typed key) the Worker then checks.
 */

import type { TrustLevelDto, TrustPolicyDto } from "../../../../api.js";

export const TRUST_POLICY_KEY = "core.trustPolicy";

export const TRUST_OPERATIONS = [
  { id: "mint", label: "Device license and config" },
  { id: "gatedDelivery", label: "Gated downloads" },
  { id: "commerceClaim", label: "Store purchase claims" },
  { id: "cloudSyncWrite", label: "Cloud Sync writes" },
] as const;

/** Shown only while Cloud Sync is on (U-05 L11). */
export const SYNC_OPERATION = "cloudSyncWrite";

export const DEFAULT_POLICY: TrustPolicyDto = {
  mint: "basic",
  gatedDelivery: "basic",
  commerceClaim: "basic",
  cloudSyncWrite: "basic",
  enforce: false,
  appAttest: null,
  playIntegrity: null,
};

export function isDefaultPolicy(p: TrustPolicyDto): boolean {
  return samePolicy(p, DEFAULT_POLICY);
}

/** An operation's level. */
export function level(
  p: TrustPolicyDto,
  id: (typeof TRUST_OPERATIONS)[number]["id"],
): TrustLevelDto {
  return p[id];
}

export function samePolicy(a: TrustPolicyDto, b: TrustPolicyDto): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

function normalise(p: TrustPolicyDto): TrustPolicyDto {
  return {
    mint: p.mint,
    gatedDelivery: p.gatedDelivery,
    commerceClaim: p.commerceClaim,
    cloudSyncWrite: p.cloudSyncWrite,
    enforce: p.enforce,
    appAttest: p.appAttest
      ? { teamId: p.appAttest.teamId, environment: p.appAttest.environment }
      : null,
    playIntegrity: p.playIntegrity
      ? {
          cloudProjectNumber: p.playIntegrity.cloudProjectNumber,
          ...(p.playIntegrity.allowTestingResponses
            ? { allowTestingResponses: true as const }
            : {}),
        }
      : null,
  };
}

export function relaxesTrustPolicy(
  before: TrustPolicyDto,
  after: TrustPolicyDto,
): boolean {
  for (const op of TRUST_OPERATIONS)
    if (
      level(before, op.id) === "attested" &&
      level(after, op.id) !== "attested"
    )
      return true;
  if (before.enforce && !after.enforce) return true;
  const a = before.appAttest;
  if (a) {
    const b = after.appAttest;
    if (!b || b.teamId !== a.teamId) return true;
    if (a.environment === "production" && b.environment !== "production")
      return true;
  } else if (after.appAttest) {
    // Adding a block opens an attestation path; only the default shape is not a relaxation.
    if (
      after.appAttest.teamId !== null ||
      after.appAttest.environment !== "production"
    )
      return true;
  }
  const p = before.playIntegrity;
  const q = after.playIntegrity;
  if (p && (!q || q.cloudProjectNumber !== p.cloudProjectNumber)) return true;
  if (q?.allowTestingResponses && !p?.allowTestingResponses) return true;
  return false;
}

const LEVEL: Record<TrustLevelDto, string> = {
  basic: "any device",
  attested: "an attested device",
};

/** One line per change, in the operator's words: what a device now has to prove. */
export function changeLines(
  before: TrustPolicyDto,
  after: TrustPolicyDto,
): string[] {
  const out: string[] = [];
  for (const op of TRUST_OPERATIONS)
    if (level(before, op.id) !== level(after, op.id))
      out.push(
        `${op.label} now accepts ${LEVEL[level(after, op.id)]} (was ${LEVEL[level(before, op.id)]}).`,
      );
  if (before.enforce !== after.enforce)
    out.push(
      after.enforce
        ? "Devices that fall short are refused."
        : "Devices that fall short are logged and let through.",
    );
  if (JSON.stringify(before.appAttest) !== JSON.stringify(after.appAttest))
    out.push(
      after.appAttest
        ? `App Attest checks ${after.appAttest.teamId ?? "the platform's Apple Team ID"} (${after.appAttest.environment}).`
        : "App Attest is off.",
    );
  if (
    JSON.stringify(before.playIntegrity) !== JSON.stringify(after.playIntegrity)
  )
    out.push(
      after.playIntegrity
        ? `Play Integrity checks ${after.playIntegrity.cloudProjectNumber ?? "the platform's cloud project"}${after.playIntegrity.allowTestingResponses ? ", and accepts testing responses" : ""}.`
        : "Play Integrity is off.",
    );
  return out;
}

const TEAM_ID = /^[A-Z0-9]{10}$/;
const PROJECT_NUMBER = /^[0-9]{1,20}$/;

/** The first problem with a draft, per field, or null. */
export function policyProblems(p: TrustPolicyDto): {
  teamId?: string;
  cloudProjectNumber?: string;
} {
  const out: { teamId?: string; cloudProjectNumber?: string } = {};
  const t = p.appAttest?.teamId;
  if (t && !TEAM_ID.test(t))
    out.teamId =
      "The 10-character Apple Developer Team ID, capitals and digits.";
  const c = p.playIntegrity?.cloudProjectNumber;
  if (c && !PROJECT_NUMBER.test(c))
    out.cloudProjectNumber = "The Google Cloud project number: digits only.";
  return out;
}
