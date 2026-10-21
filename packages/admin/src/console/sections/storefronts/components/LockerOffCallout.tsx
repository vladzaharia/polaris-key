import * as React from "react";
import { Callout } from "../../../../ui/Callout.js";
import { Link } from "../../../router.js";
import { globalPage } from "../../../routes.js";
import { useCan } from "../../../access/useCan.js";

/**
 * "Off for this deployment" (B-227): the deployment switch is a platform setting, so a platform
 * admin gets the link to its row and everyone else is told who to ask.
 */
export function LockerOffCallout(): React.ReactElement {
  const canPlatform = useCan("platform", null, "view");
  return (
    <Callout tone="warning" title="Off for this deployment">
      A platform admin turned the Locker storefront off, so no product is shown
      on Discover. Licenses, sign-in and auto-issue keep working.{" "}
      {canPlatform ? (
        <>
          <Link
            className="py-1 font-medium text-accent-fg underline underline-offset-2"
            to={globalPage("platform-settings", {
              setting: "storefront.polarisKey.enabled",
            })}
          >
            Turn it on in Platform settings
          </Link>
          .
        </>
      ) : (
        "Ask a platform admin to turn it on."
      )}
    </Callout>
  );
}
