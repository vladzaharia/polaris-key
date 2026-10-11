import * as React from "react";
import type { ServiceSlug, ServicesDryRun } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";

type Confirmation = {
  change: { label: string; requested: readonly ServiceSlug[] };
  dryRun: ServicesDryRun;
};

const DISABLE_CONSEQUENCES: Record<ServiceSlug, string> = {
  license:
    "Licensing endpoints answer not-configured: no activation, license documents, or new device seats.",
  config:
    "Managed config endpoints answer not-configured: no config documents or minted tokens.",
  release: "Release’s truth store stops answering clients.",
  distribution:
    "Distribution stops serving downloads and no longer manages channels.",
  update: "The update feed answers not-configured: clients see no updates.",
  identity:
    "Sign-in through this product stops. Licenses stay attached to their owners’ accounts.",
  sync: "Cloud Sync stops: settings stay on each device and nothing syncs.",
};

function listOf(slugs: readonly ServiceSlug[]): string {
  const names = slugs.map((slug) => slug[0]!.toUpperCase() + slug.slice(1));
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

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
  const signedIn = dryRun?.signedInDevicesToClear
    ? `${dryRun.signedInDevicesToClear} signed-in device${dryRun.signedInDevicesToClear === 1 ? "" : "s"} will be signed out; installs and licenses keep working.`
    : null;
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
