import * as React from "react";
import { Button } from "../../../../../ui/Button.js";
import { PublishFromCiDrawer } from "./PublishFromCiDrawer.js";
import { usePublishFromCiRoute } from "./useCiRoute.js";

/** The drawer's button for a row's aside (Keys → CI publishing); `?setup=ci` opens it. */
export function PublishFromCiEntry({
  slug,
  label = "Publish from CI…",
}: {
  slug: string;
  label?: string;
}): React.ReactElement {
  const [open, setOpen] = usePublishFromCiRoute();
  // Reads start with the first open and stay for the close animation.
  const [opened, setOpened] = React.useState(open);
  if (open && !opened) setOpened(true);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {opened ? (
        <PublishFromCiDrawer slug={slug} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}
