import * as React from "react";
import { type ProductDetail } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { SettingsRow } from "../../../templates/Settings.js";
import { intentOf } from "./confirmGate.js";

/**
 * ST-20: manifest-authoritative mode (S-18 §4.5 item 7, D14). A switch with an L1 confirm on a
 * repository-linked product; on and locked for the system product.
 */
export function ManifestAuthorityRow({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const system = product.system === true;
  const mode = product.manifestAuthoritative ?? {
    value: system,
    locked: system,
  };
  const [asking, setAsking] = React.useState<boolean | null>(null);
  return (
    <SettingsRow
      label="Manifest-authoritative"
      help={
        mode.locked
          ? "Always on for the system product: a console change to a license default is a break-glass claim with a reason, which ends within 7 days or at the first deploy that changes it."
          : "When on, .pkey/ is the only writer of the display name, license defaults, web origins and catalog: a console change to one is a break-glass claim with a reason, which ends after 7 days or at the first resync that changes it."
      }
    >
      {mode.locked ? (
        <StatusPill tone="info">On, locked</StatusPill>
      ) : (
        <Switch
          aria-label="Manifest-authoritative"
          checked={mode.value}
          onCheckedChange={(next) => setAsking(next)}
        />
      )}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        intent={intentOf("setting.manifestAuthoritative")}
        title={
          asking
            ? "Make .pkey/ the only writer?"
            : "Let the console claim settings again?"
        }
        description={
          asking
            ? `Console changes to ${product.name}'s display name, license defaults, web origins and catalog are refused, except as break-glass claims.`
            : `A console change to ${product.name}'s display name, license defaults, web origins or catalog claims it again, until it is reverted.`
        }
        consequences={
          asking
            ? [
                "A break-glass claim needs a reason and ends after 7 days, or at the first resync that changes the value.",
                "Settings already claimed in the console stay claimed until you revert them.",
                "Not covered yet: services, the fingerprint and auto-issue policies, the compatibility window, access modes, tiers, profiles and the trusted publisher still claim on a console edit.",
              ]
            : ["Live break-glass claims keep their expiry."]
        }
        confirmLabel={asking ? "Turn on" : "Turn off"}
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("updateProduct", slug, {
            manifestAuthoritative: asking === true,
          });
          toast.success(
            asking
              ? "Manifest-authoritative mode is on"
              : "Manifest-authoritative mode is off",
          );
        }}
      />
    </SettingsRow>
  );
}
