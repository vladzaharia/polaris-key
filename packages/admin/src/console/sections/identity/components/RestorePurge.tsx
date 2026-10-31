/**
 * App sign-in → Platform sign-in: "Purge restore keys" (I-49.5). Deletes every silent-restore key
 * of the product (WIRE-CONTRACT-V5 §12.11.8, "Revocation"): the response to a suspected leak. It
 * works whether or not silent restore is on. Nobody is signed out; each app enrols a new key at
 * its next check. A step-up route, with the product slug typed to confirm.
 */

import * as React from "react";
import { KeyRound } from "lucide-react";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { mutate } from "../../../data/mutations.js";

export function RestorePurge({ slug }: { slug: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const gate = useWriteGate("signin", slug);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
      <Button
        variant="secondary"
        size="sm"
        iconStart={<KeyRound aria-hidden />}
        disabledReason={gate.disabledReason}
        onClick={() => setOpen(true)}
      >
        Purge restore keys…
      </Button>
      <span className="text-sm text-fg-muted">
        Retires every key apps saved in a backup.
      </span>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        intent="danger"
        title="Purge restore keys?"
        consequences={[
          "Every restore key of this product is deleted. A backup can no longer sign a new device in.",
          "Nobody is signed out. Each app saves a new key on its next check.",
          "This works whether or not silent restore is on.",
        ]}
        typedConfirmation={{ value: slug, label: "Type the product slug" }}
        focusTyped
        confirmLabel="Purge restore keys"
        describeError={(e) => errorCopy(e, { thing: "Restore keys" })}
        onConfirm={async () => {
          const res = await mutate("purgeRestoreKeys", slug, slug);
          toast.success(
            res.purged > 0
              ? `Deleted ${res.purged} restore ${res.purged === 1 ? "key" : "keys"}`
              : "There were no restore keys to delete",
          );
        }}
      />
    </div>
  );
}
