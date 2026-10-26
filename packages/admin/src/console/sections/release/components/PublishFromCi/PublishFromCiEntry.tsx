import * as React from "react";
import { Button } from "../../../../../ui/Button.js";
import { PublishFromCiDrawer } from "./PublishFromCiDrawer.js";

/** "Publish from CI…" and the drawer it opens, for a row's aside (Keys → CI publishing). */
export function PublishFromCiEntry({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Publish from CI…
      </Button>
      <PublishFromCiDrawer slug={slug} open={open} onOpenChange={setOpen} />
    </>
  );
}
