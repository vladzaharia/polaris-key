import * as React from "react";
import type { ServiceSlug, ServicesDryRun } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import {
  COMMERCE_OFF_LIMITS,
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
      intent={cascaded.length ? "danger" : "caution"}
      title={`Turn off ${change?.label ?? "this feature"}?`}
      consequences={[
        ...(cascaded.length
          ? [
              `Also turns off ${listOf(cascaded)} because ${cascaded.length === 1 ? "it needs" : "they need"} ${change?.label ?? "this feature"}.`,
            ]
          : []),
        ...affected.map((service) => DISABLE_CONSEQUENCES[service]),
        ...(affected.includes("commerce") ? [COMMERCE_OFF_LIMITS] : []),
        ...(signedIn ? [signedIn] : []),
        cascaded.length
          ? "Settings are kept. Turning it back on does not turn the others on."
          : "Settings are kept and return when it is turned on again.",
      ]}
      confirmLabel={`Turn off ${[change?.label ?? "feature", ...(cascaded.length ? [listOf(cascaded)] : [])].join(" and ")}`}
      describeError={errorCopy}
      onConfirm={onConfirm}
    />
  );
}
