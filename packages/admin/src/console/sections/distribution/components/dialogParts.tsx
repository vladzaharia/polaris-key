/**
 * The parts a distribution dialog repeats: its submit state, the failure callout and the
 * Cancel / submit footer.
 */

import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { DialogFooter } from "../../../../ui/Dialog.js";

/** The error, failure and busy state of a dialog that submits one form. */
export function useSubmitState(): {
  error: string | undefined;
  setError: (e: string | undefined) => void;
  failure: unknown;
  setFailure: (e: unknown) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
} {
  const [error, setError] = React.useState<string | undefined>();
  const [failure, setFailure] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  return { error, setError, failure, setFailure, busy, setBusy };
}

/** The refusal a submit ended in, or nothing. */
export function FailureCallout({
  copy,
}: {
  copy: { title: string; description?: string } | null;
}): React.ReactElement | null {
  return copy ? (
    <Callout tone="danger" title={copy.title} live>
      {copy.description}
    </Callout>
  ) : null;
}

/** Cancel and the submit button. */
export function SubmitFooter({
  busy,
  onClose,
  children,
}: {
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <DialogFooter>
      <Button variant="outline" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" loading={busy}>
        {children}
      </Button>
    </DialogFooter>
  );
}
