import * as React from "react";
import type { ClaimKey } from "../../api.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { toast } from "../../ui/toast.js";
import { mutate } from "../data/mutations.js";
import { intentOf } from "../pages/core/confirmGate.js";

/** The claimable settings by registry key (worker `core/settingsClaims.ts` `CLAIM_KEYS`). */
export const CLAIM_LABELS: Record<ClaimKey, string> = {
  "core.name": "Display name",
  "license.defaults.maxOfflineDays": "Default max offline days",
  "license.defaults.deviceLimit": "Default device limit",
  "core.web.origins": "Web origins",
  "config.catalog": "Catalog",
};

/** The manifest file each claimable setting comes from. */
const MANIFEST_FILE: Record<ClaimKey, string> = {
  "core.name": ".pkey/product",
  "license.defaults.maxOfflineDays": ".pkey/product",
  "license.defaults.deviceLimit": ".pkey/product",
  "core.web.origins": ".pkey/product",
  "config.catalog": ".pkey/schema",
};

/**
 * Revert to manifest for one claimed setting (ST-01b, notes/S-18 §4.5 item 2; L1). The Worker
 * drops the claim and restores the last applied manifest's value at once, or, for a product with
 * no manifest snapshot yet, leaves it to the next resync; the toast says which happened.
 */
export function RevertClaimDialog({
  slug,
  claim,
  onOpenChange,
}: {
  slug: string;
  claim: ClaimKey;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const label = CLAIM_LABELS[claim];
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      intent={intentOf("manifest.revert")}
      title={`Return ${label.toLowerCase()} to the manifest?`}
      consequences={[
        `The value from the last applied ${MANIFEST_FILE[claim]} replaces the console value now. A product not resynced since claims arrived gets it at the next resync.`,
        "Later resyncs keep it in line with the manifest.",
      ]}
      confirmLabel="Revert to manifest"
      describeError={(e) => errorCopy(e)}
      onConfirm={async () => {
        const res = await mutate("revertClaim", slug, claim);
        toast.success(
          res.applied
            ? `${label} restored from the manifest`
            : `${label} returns to the manifest at the next resync`,
        );
      }}
    />
  );
}
