/**
 * What the feed settings sections share: the refusal a section shows, the notice for a version
 * conflict, and the focus after a save (split from `FeedSettings.tsx`, the page budget).
 */

import * as React from "react";
import type { FieldValues } from "react-hook-form";
import { ApiError } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import type { AdminForm } from "../../../../ui/form.js";
import { SubmitError } from "../../distribution/components/forms.js";

/**
 * A feed form's refusal. A version conflict has its own notice (`ConflictNotice`) and no error;
 * a cancelled confirm is no error at all.
 */
export function FeedSubmitError({
  error,
}: {
  error: unknown;
}): React.ReactElement | null {
  if (error instanceof ApiError && error.reason === "version_conflict")
    return null;
  return (
    <SubmitError
      error={error}
      context={{ area: "distribution", thing: "Feed" }}
    />
  );
}

/** The server's version arrived while this form held a draft: keep it or take theirs. */
export function ConflictNotice<T extends FieldValues>({
  form,
}: {
  form: AdminForm<T>;
}): React.ReactElement | null {
  const conflicted =
    form.serverChanged ||
    (form.submitError instanceof ApiError &&
      form.submitError.reason === "version_conflict");
  if (!conflicted) return null;
  return (
    <div className="px-5 pt-4">
      <Callout
        tone="warning"
        title="Someone saved this feed after you opened it"
        live
      >
        <p>Review their changes, then save again.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {form.serverChanged ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={form.keepMine}
            >
              Keep mine
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={form.acceptServer}
          >
            Discard mine
          </Button>
        </div>
      </Callout>
    </div>
  );
}

/** After a save the bar unmounts and takes focus with it: land on the section. */
export function focusSection(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}
