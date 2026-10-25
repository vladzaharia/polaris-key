/**
 * The package-feeds switch could not be read (F-34.8): the inline danger box with Copy details and
 * a Try again that refetches. Turn on and Turn off both wait for that read, so without this the
 * page and the dialog would sit disabled with no way out.
 */

import * as React from "react";
import { CircleAlert } from "lucide-react";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { CopyDetails } from "../../../../ui/CopyDetails.js";

export function SwitchReadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const copy = errorCopy(error, {
    area: "distribution",
    thing: "Package feeds",
    read: true,
  });
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="space-y-1">
        <p className="m-0 font-semibold text-fg-strong">{copy.title}</p>
        {copy.description ? (
          <p className="m-0 text-fg">{copy.description}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
          <CopyDetails copy={copy} />
        </div>
      </div>
    </div>
  );
}
