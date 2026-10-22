import * as React from "react";
import { CopyButton } from "./CopyButton.js";

/**
 * The "Copy details" button a refusal's words promise ("Copy the details for a report"), for a
 * callout that shows the copy itself. Renders only when the copy's action is `copy-details`, or
 * when `always` is set by a callout that promises it whatever the cause (a failed publish).
 */
export function CopyDetails({
  copy,
  always = false,
}: {
  copy: { action?: string; details?: Record<string, unknown> };
  always?: boolean;
}): React.ReactElement | null {
  if (!always && copy.action !== "copy-details") return null;
  return (
    <CopyButton
      value={JSON.stringify(copy.details ?? {}, null, 2)}
      label="Copy details"
      showLabel
      text="Copy details"
    />
  );
}

/** A refusal's description with its Copy details button after it, for a callout body. */
export function ErrorDescription({
  copy,
}: {
  copy: {
    description?: string;
    action?: string;
    details?: Record<string, unknown>;
  };
}): React.ReactElement {
  return (
    <>
      {copy.description} <CopyDetails copy={copy} />
    </>
  );
}
