import * as React from "react";
import {
  hasSavedStepUp,
  readStash,
  stashStepUp,
  startStepUp,
} from "../lib/stepUp.js";
import { isStepUpRequired } from "./ConfirmDialog.js";
import { Callout } from "./Callout.js";

/**
 * The step-up for a form dialog or drawer (not a confirmation): the Worker refused its save with
 * 403 `step_up_required`, so the submit becomes "Sign in again". That click saves the entries
 * (`signIn`), leaves for the sign-in and returns to this page, where the form reopens (`requestOpen`
 * on mount) with the entries back (`take`, when it opens). `key` names the form on its page.
 */
export function useStepUpDraft(
  key: string,
  open: boolean,
  requestOpen: () => void,
): {
  needed: boolean;
  /** The entries a step-up sign-in saved, once; null when there are none. */
  take: () => Record<string, string> | null;
  /** True (and `needed`) when `err` is a refused-for-step-up answer. */
  check: (err: unknown) => boolean;
  signIn: (fields: Record<string, string>) => void;
} {
  const [needed, setNeeded] = React.useState(false);
  React.useEffect(() => {
    if (!open && hasSavedStepUp(key)) requestOpen();
    // On mount only: a saved form reopens once, after the sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    if (open) setNeeded(false);
  }, [open]);
  return {
    needed,
    take: () => readStash(key, true)?.fields ?? null,
    check: (err) => {
      const yes = isStepUpRequired(err);
      if (yes) setNeeded(true);
      return yes;
    },
    signIn: (fields) => {
      stashStepUp(key, "", fields);
      startStepUp();
    },
  };
}

/** The notice above a form whose save was refused for want of a fresh sign-in. */
export function StepUpNotice(): React.ReactElement {
  return (
    <Callout alert tone="warning" title="Sign in again to save">
      This needs a sign-in from the last 5 minutes. Your entries are kept.
    </Callout>
  );
}
