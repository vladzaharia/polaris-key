import * as React from "react";
import type { ProductUserDetail } from "../../../../api.js";
import { IdChip } from "../../../../ui/IdChip.js";
import { SpellOut } from "../../../../ui/SpellOut.js";
import { CopyButton } from "../../../../ui/CopyButton.js";

/**
 * The record header's ids (I-41): the readable support code a customer reads out (when they have
 * asked for one), then the user id, in one chip style. Both copy. The code sits in a labelled
 * group so a screen reader hears "Support code, K7M-4QX-9TZ".
 */
export function UserIds({
  user,
}: {
  user: Pick<ProductUserDetail, "subject" | "supportCode">;
}): React.ReactElement {
  return (
    <>
      {user.supportCode ? (
        <span className="inline-flex max-w-full items-center gap-1.5">
          <span>Support code</span>
          <span
            role="group"
            aria-label="Support code"
            className="inline-flex max-w-full items-center gap-1 rounded-sm bg-surface-sunken ps-1.5 font-mono text-xs text-fg"
          >
            <span>{user.supportCode}</span>
            <CopyButton
              value={user.supportCode}
              label="Copy support code"
              size="xs"
            />
          </span>
        </span>
      ) : null}
      <IdChip value={user.subject} noun="user id" />
      {user.supportCode ? <SpellOut code={user.supportCode} inline /> : null}
    </>
  );
}
