import * as React from "react";
import type { ServiceSlug, ServicesDryRun } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import {
  featureWord,
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
  productName,
}: {
  confirmation: Confirmation | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
  /** Names the product in the title and draws one row per feature ("identity.sign-in-off"). */
  productName?: string;
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
      title={`Turn off ${change?.label ?? "this feature"}${productName ? ` for ${productName}` : ""}?`}
      lead={
        productName ? (
          <div className="space-y-3">
            {cascaded.length ? (
              <p>
                {listOf(cascaded)} needs {change?.label}, so{" "}
                {cascaded.length === 1 ? "it turns" : "they turn"} off too.
              </p>
            ) : null}
            <ul className="divide-y divide-border rounded-md border border-border">
              {affected.map((service) => (
                <li
                  key={service}
                  className="flex items-start gap-3 px-3 py-2.5 text-sm"
                >
                  <ServiceGlyph id={service} size={16} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-fg-strong">
                      {featureWord(service)}{" "}
                      <span className="font-normal text-fg-muted">
                        On → Off
                      </span>
                    </p>
                    <p className="text-fg-muted">
                      {DISABLE_CONSEQUENCES[service]}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : undefined
      }
      consequences={
        productName
          ? [
              ...(signedIn ? [signedIn] : []),
              "Accounts, their links, consents and synced saves are kept; licenses stay in their owners’ libraries.",
              "Recorded in Activity as one change. Undo turns it back on.",
            ]
          : [
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
            ]
      }
      confirmLabel={`Turn off ${[change?.label ?? "feature", ...(cascaded.length ? [listOf(cascaded)] : [])].join(" and ")}`}
      describeError={errorCopy}
      onConfirm={onConfirm}
    />
  );
}
