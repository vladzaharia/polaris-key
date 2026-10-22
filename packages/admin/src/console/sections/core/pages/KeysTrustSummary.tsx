/** The Device trust summary and the editor's per-operation help (split from KeysTrust.tsx). */

import * as React from "react";
import type { TrustPolicyDto } from "../../../../api.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { TRUST_OPERATIONS, level, operationRow } from "../model/trustPolicy.js";

export type Services =
  | Record<string, { enabled: boolean } | undefined>
  | undefined;

export function PolicySummary({
  policy,
  services,
}: {
  policy: TrustPolicyDto;
  services: Services;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      <DescriptionList
        columns={4}
        items={TRUST_OPERATIONS.flatMap((op) => {
          const row = operationRow(op.id, policy, services);
          return row.show
            ? [
                {
                  term: op.label,
                  detail: `${levelLabel(level(policy, op.id))}${row.off ? ` (${row.off} off)` : ""}`,
                },
              ]
            : [];
        })}
      />
      <DescriptionList
        columns={4}
        className="border-t border-border pt-4 sm:grid-cols-3"
        items={[
          {
            term: "A miss",
            detail: policy.enforce ? "Refused" : "Logged, let through",
          },
          {
            term: "App Attest",
            detail: policy.appAttest
              ? `${policy.appAttest.teamId ?? "Platform Team ID"}, ${policy.appAttest.environment}`
              : "Off",
          },
          {
            term: "Play Integrity",
            detail: policy.playIntegrity
              ? `${policy.playIntegrity.cloudProjectNumber ?? "Platform project"}${policy.playIntegrity.allowTestingResponses ? ", testing responses allowed" : ""}`
              : "Off",
          },
        ]}
      />
    </div>
  );
}

function levelLabel(l: string): string {
  return l === "attested" ? "Attested device" : "Any device";
}

export function helpFor(id: string, off: string | null): string | undefined {
  const parts = [
    off ? `${off} off.` : "",
    id === "cloudSyncWrite"
      ? "Web and desktop builds can't attest. A refused change stays on the device."
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}
