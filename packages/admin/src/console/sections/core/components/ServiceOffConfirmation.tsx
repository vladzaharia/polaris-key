import * as React from "react";
import type { ServiceSlug, ServicesDryRun } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import {
  DISABLE_CONSEQUENCES,
  listOf,
  signedInConsequence,
} from "./serviceFeatures.js";

type Confirmation = {
  change: { label: string; requested: readonly ServiceSlug[] };
  dryRun: ServicesDryRun;
};

export function ServiceOffConfirmation({
  confirmation,
  onOpenChange,
  onConfirm,
}: {
  confirmation: Confirmation | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}): React.ReactElement {
  const change = confirmation?.change;
  const dryRun = confirmation?.dryRun;
  const cascaded = dryRun?.cascaded ?? [];
  const affected = [
    ...(change?.requested ?? []),
    ...cascaded.filter((slug) => !change?.requested.includes(slug)),
  ];
  const signedIn = signedInConsequence(dryRun?.signedInDevicesToClear ?? 0);
  return (
    <ConfirmDialog
      open={confirmation !== null}
      onOpenChange={onOpenChange}
      intent="caution"
      title={`Turn off ${change?.label ?? "this feature"}?`}
      consequences={[
        ...(cascaded.length
          ? [
              `Also turns off ${listOf(cascaded)} because ${cascaded.length === 1 ? "it requires" : "they require"} this service.`,
            ]
          : []),
        ...affected.map((service) => DISABLE_CONSEQUENCES[service]),
        ...(signedIn ? [signedIn] : []),
        "Settings are kept and return when the service is turned on again.",
      ]}
      confirmLabel={`Turn off ${change?.label ?? "feature"}`}
      describeError={errorCopy}
      onConfirm={onConfirm}
    />
  );
}
