/**
 * The quiet foot card on Packages (F-34.8, mockup `packages.feeds`): the one place to turn the
 * feeds off. The button opens `TurnOffFeeds`, and Escape gives focus back to it.
 */

import * as React from "react";
import { Button } from "../../../../ui/Button.js";

export function PackagesFoot({
  onTurnOff,
  disabledReason,
}: {
  onTurnOff: () => void;
  /** A member without edit access to Ship builds: the button stays, soft-disabled. */
  disabledReason?: string;
}): React.ReactElement {
  return (
    <div
      data-feeds-foot=""
      className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border px-4 py-3 text-sm"
    >
      <div>
        <p className="m-0 font-medium">Package feeds</p>
        <p className="m-0 text-fg-muted">Stops every install and CI publish.</p>
      </div>
      <Button
        variant="outline"
        onClick={onTurnOff}
        disabledReason={disabledReason}
      >
        Turn off package feeds
      </Button>
    </div>
  );
}
