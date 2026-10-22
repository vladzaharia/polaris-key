import * as React from "react";
import type { TierSummary } from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { confirmFor } from "../../../../lib/actions.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";

export function DeleteTierDialog({
  slug,
  tier,
  onOpenChange,
  onDeleted,
}: {
  slug: string;
  tier: TierSummary | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}): React.ReactElement {
  return (
    <ConfirmDialog
      open={tier !== null}
      onOpenChange={onOpenChange}
      intent={confirmFor("tier.delete").intent as "danger"}
      title={`Delete tier “${tier?.label || tier?.id || ""}”?`}
      consequences={[
        "The tier is removed. No license is on it, so no device is affected.",
        "A tier the manifest declares comes back at the next resync.",
      ]}
      confirmLabel="Delete tier"
      describeError={(e) => {
        const status = (e as { status?: number })?.status;
        if (status === 409)
          return {
            title: "Licenses are on this tier",
            description: "Move them to another tier first.",
          };
        // LX-33.6/.7: the last tier, and the Default tier, stay.
        if (status === 422)
          return {
            title: "This tier stays",
            description:
              "The Default tier and a product's last tier can't be deleted.",
          };
        return errorCopy(e, { thing: "Tier" });
      }}
      onConfirm={async () => {
        if (!tier) return;
        await mutate("deleteTier", slug, tier.id);
        toast.success("Tier deleted");
        onDeleted?.();
      }}
    />
  );
}
