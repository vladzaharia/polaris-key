/**
 * What the feed settings sections share: the refusal a section shows, the notice for a version
 * conflict, and the focus after a save (split from `FeedSettings.tsx`, the page budget).
 */

import * as React from "react";
import type { FieldValues } from "react-hook-form";
import { HttpError } from "../../../../api.js";
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
  if (error instanceof HttpError && error.reason === "version_conflict")
    return null;
  return (
    <SubmitError
      error={error}
      context={{ area: "distribution", thing: "Feed" }}
    />
  );
}

/**
 * The versions this tab wrote itself. The sections save disjoint fields over one version counter,
 * so our own save moves the version under every sibling form that holds a draft: those take the
 * new baseline silently. Only a 409, or a version we did not write, is someone else's change.
 */
export interface FeedSync {
  own: React.RefObject<Set<number>>;
  /** Bumps when a version is recorded, so a form that saw the refetch first looks again. */
  tick: number;
}
export const FeedSyncContext = React.createContext<FeedSync>({
  own: { current: new Set() },
  tick: 0,
});

/**
 * The notice for a version conflict: keep the draft or take theirs. Shown after a 409, or when a
 * version this tab did not write arrives while the form holds a draft. A version this tab wrote
 * rebases the draft without a word.
 */
export function ConflictNotice<T extends FieldValues>({
  form,
  version,
}: {
  form: AdminForm<T>;
  /** The feed's settings version as the page now holds it. */
  version: number;
}): React.ReactElement | null {
  const sync = React.useContext(FeedSyncContext);
  const own = sync.own.current.has(version);
  const refused =
    form.submitError instanceof HttpError &&
    form.submitError.reason === "version_conflict";
  const [kept, setKept] = React.useState(false);
  React.useEffect(() => setKept(false), [form.submitError]);
  React.useEffect(() => {
    if (form.serverChanged && own && !refused) form.keepMine();
    // Rebase once per arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.serverChanged, own, refused, sync.tick]);
  const foreign = form.serverChanged && !own;
  if (kept || !(refused || foreign)) return null;
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
              onClick={() => {
                form.keepMine();
                setKept(true);
              }}
            >
              Keep mine
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={form.discard}
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
