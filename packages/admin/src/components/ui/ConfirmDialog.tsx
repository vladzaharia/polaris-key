import * as React from "react";
import { Button, type ButtonProps } from "./Button.js";
import {
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./Dialog.js";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonProps["variant"];
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * A focus-trapped confirmation modal (Radix Dialog with `role="alertdialog"` semantics via
 * the description wiring). Returns nothing — drive it with controlled `open` state and an
 * async `onConfirm`; the dialog stays mounted while `loading` so the spinner is visible.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
  loading = false,
  onConfirm,
}: ConfirmDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        role="alertdialog"
        onEscapeKeyDown={(e) => loading && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description ? (
          <DialogBody>
            <DialogDescription>{description}</DialogDescription>
          </DialogBody>
        ) : null}
        <DialogActionBar>
          <DialogClose asChild>
            <Button variant="outline" disabled={loading}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={confirmVariant}
            loading={loading}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogActionBar>
      </DialogContent>
    </Dialog>
  );
}
