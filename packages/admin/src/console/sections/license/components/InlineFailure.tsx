import * as React from "react";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyButton } from "../../../../ui/CopyButton.js";

/**
 * An error in the words of `errorCopy`: its title, its description and, when it offers one, the
 * Copy details button (a support report needs the status and code, which words never show).
 */
export function ErrorBlock({
  error,
  thing = "License",
  tone = "danger",
  title,
  action,
}: {
  error: unknown;
  thing?: string;
  tone?: "danger" | "warning";
  /** Replaces errorCopy's title ("Couldn't load tiers"). */
  title?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  const copy = errorCopy(error, { thing });
  return (
    <Callout tone={tone} title={title ?? copy.title} live action={action}>
      <div className="flex flex-col items-start gap-2">
        <span>{copy.description}</span>
        {copy.action === "copy-details" ? (
          <CopyButton
            value={JSON.stringify(copy.details, null, 2)}
            label="Copy details"
            showLabel
            text="Copy details"
          />
        ) : null}
      </div>
    </Callout>
  );
}

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
    <ErrorBlock
      error={error}
      tone="warning"
      title={`Couldn't load ${what}`}
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}
