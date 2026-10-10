/**
 * Form helpers shared by the chunk 9 settings pages (Access, Health, Feed).
 *
 * `SaveBar` lists field errors; a refusal the server attributes to no field (a 500, a dropped
 * connection, a coherence refusal) is shown by `SubmitError` inside the section that saved.
 */

import * as React from "react";
import { ApiError } from "../../../../api.js";
import { errorCopy, type ErrorContext } from "../../../../lib/errorCopy.js";
import { Callout } from "../../../../ui/Callout.js";
import type { FieldErrorMap } from "../../../../ui/form.js";

/** Thrown by an `onSubmit` the operator cancelled at a confirmation: not an error to show. */
export class SubmitCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "SubmitCancelled";
  }
}

/** A 422's named fields, each with the server's own sentence when it sent one. */
export function serverFieldErrors(error: unknown): FieldErrorMap | null {
  if (!(error instanceof ApiError) || !error.fields?.length) return null;
  const message =
    error.message && error.message !== `api ${error.status}`
      ? error.message
      : "The server rejected this value.";
  return Object.fromEntries(error.fields.map((f) => [f, message]));
}

export function SubmitError({
  error,
  context,
}: {
  error: unknown;
  context?: ErrorContext;
}): React.ReactElement | null {
  if (!error || error instanceof SubmitCancelled) return null;
  if (error instanceof ApiError && error.fields?.length) return null;
  const copy = errorCopy(error, context);
  return (
    <div className="px-5 py-3">
      <Callout tone="danger" title={copy.title} live>
        {copy.description}
      </Callout>
    </div>
  );
}
