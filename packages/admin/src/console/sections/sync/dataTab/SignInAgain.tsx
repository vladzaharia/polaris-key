/** Users → Data: the notice a read refused for a stale sign-in shows, with the way to renew it. */

import * as React from "react";
import { isStepUpRequired } from "../../../../ui/ConfirmDialog.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { startStepUp, stashStepUp } from "../../../../lib/stepUp.js";

/** True when `error` is the Worker asking for a sign-in from the last 5 minutes. */
export const needsSignIn = isStepUpRequired;

/**
 * "Sign in again": the click saves where the operator was (`stashKey`, read back on return) and
 * leaves for the sign-in. The words follow what was refused ("Sign in again to show values").
 */
export function SignInAgain({
  what,
  stashKey,
}: {
  /** The action, as a verb phrase: "show values", "download this file". */
  what: string;
  stashKey: string;
}): React.ReactElement {
  return (
    <Callout
      alert
      tone="warning"
      title={`Sign in again to ${what}`}
      action={
        <Button
          size="sm"
          onClick={() => {
            stashStepUp(stashKey, "");
            startStepUp();
          }}
        >
          Sign in again
        </Button>
      }
    >
      This needs a sign-in from the last 5 minutes.
    </Callout>
  );
}
