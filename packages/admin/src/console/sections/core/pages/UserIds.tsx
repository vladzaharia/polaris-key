import * as React from "react";
import type { ProductUserDetail } from "../../../../api.js";
import { IdChip, ValueCopyButton } from "../../../../ui/IdChip.js";

/**
 * The record header's ids (I-41): the readable support code a customer reads out (when they have
 * asked for one), then the user id. Both copy.
 */
export function UserIds({
  user,
}: {
  user: Pick<ProductUserDetail, "subject" | "supportCode">;
}): React.ReactElement {
  return (
    <>
      {user.supportCode ? (
        <span className="inline-flex items-center gap-1">
          Support code
          <span
            aria-label="Support code"
            className="rounded-sm bg-surface-sunken px-1.5 font-mono text-xs tracking-wider text-fg-strong"
          >
            {user.supportCode}
          </span>
          <ValueCopyButton value={user.supportCode} label="Copy support code" />
        </span>
      ) : null}
      <IdChip value={user.subject} noun="user id" />
    </>
  );
}
