import * as React from "react";
import { Callout } from "../../../../ui/Callout.js";

/**
 * I-09: shown under "Add by key without the purchase email" while it is on (Portal and Sign-in):
 * `identity.keyEntry.claimByKey` lets a leaked key claim an email-bound license.
 */
export function ClaimByKeyWarning(): React.ReactElement {
  return (
    <Callout tone="warning" live className="mt-3">
      Anyone with a leaked key can add an email-bound license to their own
      account.
    </Callout>
  );
}
