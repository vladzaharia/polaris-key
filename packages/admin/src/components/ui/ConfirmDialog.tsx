import * as React from "react";
import {
  ConfirmDialog as BaseConfirmDialog,
  type ConfirmDialogProps as BaseProps,
} from "../../ui/ConfirmDialog.js";

/**
 * Re-export (ADMIN.md §7.2 chunk 3): the confirmation lives in `src/ui/ConfirmDialog.tsx`.
 *
 * The legacy views were written against a dialog whose confirm button was destructive by default
 * and which they close themselves, so this layer keeps those two defaults (`confirmVariant`
 * "destructive", no close on success). Everything else (the inline error, the busy guard against
 * outside clicks) is the new component's. Deleted in chunk 11, as each area chunk moves its
 * confirmations onto `intent`.
 */
export type ConfirmDialogProps = BaseProps;

export function ConfirmDialog({
  confirmVariant,
  intent,
  closeOnSuccess = false,
  ...props
}: ConfirmDialogProps): React.ReactElement {
  return (
    <BaseConfirmDialog
      {...props}
      intent={intent}
      confirmVariant={confirmVariant ?? (intent ? undefined : "destructive")}
      closeOnSuccess={closeOnSuccess}
    />
  );
}
