import * as React from "react";
import type { ErrorCopy } from "../lib/errorCopy.js";
import { CopyButton } from "./CopyButton.js";

/**
 * The "Copy details" button a refusal's words promise ("Copy the details for a report"), for a
 * callout that shows the copy itself. Renders only when the copy's action is `copy-details`.
 */
export function CopyDetails({
  copy,
}: {
  copy: Pick<ErrorCopy, "action" | "details">;
}): React.ReactElement | null {
  if (copy.action !== "copy-details") return null;
  return (
    <CopyButton
      value={JSON.stringify(copy.details, null, 2)}
      label="Copy details"
      showLabel
    />
  );
}
