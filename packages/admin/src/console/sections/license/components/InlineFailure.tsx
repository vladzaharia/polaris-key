import * as React from "react";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";

/** A lookup failure, said where the control would be (LIC-6). */
export function InlineFailure({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <Callout
      tone="warning"
      title={`Couldn't load ${what}`}
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {errorCopy(error).description}
    </Callout>
  );
}
