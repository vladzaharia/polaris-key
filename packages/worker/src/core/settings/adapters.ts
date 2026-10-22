/**
 * Core's per-key adapters for the generic product settings routes (ST-05b; the type is
 * `SettingAdapter`, `types.ts`). The device trust policy was the bespoke `…/trust-policy` route;
 * what that route checked beyond routing lives here, so the one generic write path enforces it.
 * A service's adapters ride on its slice (`ServiceSettingsSlice.adapters`), never in this file.
 */

import {
  DEFAULT_TRUST_POLICY,
  parseTrustPolicy,
  relaxesTrustPolicy,
  validateTrustPolicy,
  type TrustPolicy,
} from "../trust/deviceTrust.js";
import type { SettingAdapter } from "./types.js";

/** A trust policy as a sentence, for the audit row. */
function describe(p: TrustPolicy): string {
  const ops = (["mint", "gatedDelivery", "commerceClaim"] as const)
    .map((op) => `${op}=${p[op]}`)
    .join(", ");
  return `${ops}; ${p.enforce ? "enforced" : "log-only"}; appAttest=${p.appAttest ? `${p.appAttest.teamId ?? "(platform team id)"}/${p.appAttest.environment}` : "off"}; playIntegrity=${p.playIntegrity ? `${p.playIntegrity.cloudProjectNumber ?? "(platform project)"}${p.playIntegrity.allowTestingResponses ? " (testing responses allowed)" : ""}` : "off"}`;
}

/** The policy in force for a stored value: none stored reads as the default. */
function policyOf(value: unknown): TrustPolicy {
  return value === null || value === undefined
    ? DEFAULT_TRUST_POLICY
    : parseTrustPolicy(JSON.stringify(value));
}

export const CORE_ADAPTERS: Readonly<Record<string, SettingAdapter>> = {
  "core.trustPolicy": {
    inForce: (value) => policyOf(value),
    // The body is the whole policy; unknown members are refused.
    validate: (value) => {
      const v = validateTrustPolicy(value);
      return v.ok ? null : { message: v.message, fields: [v.field] };
    },
    // A change that only tightens the policy needs nothing more than the area; one that relaxes
    // it (a reset of a non-default policy is one) is L2.
    relaxes: (current, next) =>
      relaxesTrustPolicy(
        policyOf(current),
        next === undefined ? DEFAULT_TRUST_POLICY : policyOf(next),
      ),
    audit: ({ op, slug, before, after }) =>
      op === "set"
        ? {
            action: "trust_policy.set",
            target: { kind: "trust_policy", id: slug },
            summary: `Set the device-trust policy: ${describe(policyOf(after))} (was: ${describe(policyOf(before))})`,
          }
        : {
            action: "trust_policy.reset",
            target: { kind: "trust_policy", id: slug },
            summary: `Reset the device-trust policy to the default (was: ${describe(policyOf(before))})`,
          },
  },
};
