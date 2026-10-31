/** Users → Data → Danger zone: delete everything Cloud Sync holds for the person. */

import * as React from "react";
import { confirmFor } from "../../../../lib/actions.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { mutate } from "../../../data/mutations.js";
import { DangerAction, DangerZone } from "../../../templates/Settings.js";

export function DeleteData({
  slug,
  subject,
}: {
  slug: string;
  subject: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <DangerZone id="sync-data-danger">
      <DangerAction
        title="Delete Cloud Sync data"
        consequence="Removes their settings, records, files, history and key ring. The user and their license stay."
        action={
          <Button variant="danger" onClick={() => setOpen(true)}>
            Delete Cloud Sync data
          </Button>
        }
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        intent="danger"
        title="Delete this user's Cloud Sync data?"
        stepUpKey={`sync-delete:${subject}`}
        consequences={[
          "Their synced settings, records, files, file history and key ring are removed from Polaris Key.",
          "Their devices keep their local copies. Syncing pauses for 24 hours.",
          "This can't be undone.",
        ]}
        typedConfirmation={
          confirmFor("sync.deleteData").typedConfirmation
            ? { value: "delete", label: "Type" }
            : undefined
        }
        confirmLabel="Delete data"
        describeError={(e) => errorCopy(e, { thing: "Cloud Sync data" })}
        onConfirm={async () => {
          await mutate("syncDeleteData", slug, subject);
          announce("Cloud Sync data deleted");
        }}
      />
    </DangerZone>
  );
}
