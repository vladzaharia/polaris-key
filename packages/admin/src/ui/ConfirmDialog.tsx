import * as React from "react";
import { AlertTriangle, CircleAlert, OctagonAlert } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button, type ButtonVariant } from "./Button.js";
import { CopyDetails } from "./CopyDetails.js";
import { Dialog, DialogBody, DialogFooter } from "./Dialog.js";

/**
 * A confirmation (components.md §4.2, ADMIN.md §5.2).
 *
 * - `intent` defaults to `neutral` (fixes UI-10). `caution` (L1) leads with a warning icon;
 *   `danger` (L2/L3) leads with a danger icon and a danger confirm button.
 * - `consequences` render as a list: one concrete effect per line.
 * - `typedConfirmation` (L3) keeps the confirm button `aria-disabled` until the labelled input
 *   matches exactly; paste is allowed. The typed value is what the caller sends where the API
 *   has a confirm field (product delete's `confirmSlug`).
 * - While `onConfirm`'s promise is pending the confirm button shows `loading` and the dialog
 *   cannot be dismissed. A rejection keeps the dialog open with the error inline under the
 *   consequences; pressing confirm again retries. On success the dialog closes.
 * - The confirm label repeats the verb ("Disable license"), never "Confirm".
 * - Focus lands on Cancel, the least destructive button.
 */
export type ConfirmIntent = "neutral" | "caution" | "danger";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intent?: ConfirmIntent;
  title: React.ReactNode;
  description?: React.ReactNode;
  consequences?: string[];
  /** Leads the body, before the consequences (what the action reaches). */
  lead?: React.ReactNode;
  /** Repeats the verb: "Yank 2.4.0". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `ignoreCase`: the match trims and ignores case (an email address). */
  typedConfirmation?: { value: string; label: string; ignoreCase?: boolean };
  onConfirm: () => void | Promise<void>;
  /**
   * An error the caller met outside `onConfirm` (a retry after a step-up prompt), shown inline like
   * a rejection. Pass `null` to clear it.
   */
  error?: unknown;
  /** Inputs the confirmation needs (a reason, a version), rendered under the consequences. */
  children?: React.ReactNode;
  /** Turns an error into the inline message, e.g. `errorCopy`. Default: its `message`. */
  describeError?: (error: unknown) => {
    title: string;
    description?: string;
    /** `copy-details` (an `errorCopy`): the dialog adds the Copy details button it promises. */
    action?: string;
    details?: Record<string, unknown>;
  } | null;
  /** Close after `onConfirm` resolves. Default true; the legacy views close it themselves. */
  closeOnSuccess?: boolean;
  /** Legacy: overrides the confirm button's variant. Prefer `intent`. */
  confirmVariant?: ButtonVariant | null;
  /** Legacy: the caller's own pending state, combined with the dialog's. */
  loading?: boolean;
  /** Legacy: keeps confirm disabled (an input in `children` is not valid yet). */
  confirmDisabled?: boolean;
}

/**
 * The default inline message: the error's own message. Callers with an `ApiError` pass
 * `describeError={(e) => errorCopy(e, context)}` (ADMIN.md §5.9).
 */
function defaultDescribe(error: unknown): {
  title: string;
  description?: string;
} {
  if (error instanceof Error && error.message) return { title: error.message };
  return { title: "Something went wrong. Try again." };
}

const ICON: Record<ConfirmIntent, React.ReactNode> = {
  neutral: null,
  caution: <AlertTriangle aria-hidden className="size-5 text-warning" />,
  danger: <OctagonAlert aria-hidden className="size-5 text-danger" />,
};

export function ConfirmDialog({
  open,
  onOpenChange,
  intent = "neutral",
  title,
  description,
  consequences,
  lead,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  typedConfirmation,
  onConfirm,
  error: callerError = null,
  children,
  describeError = defaultDescribe,
  closeOnSuccess = true,
  confirmVariant,
  loading = false,
  confirmDisabled = false,
}: ConfirmDialogProps): React.ReactElement {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [typed, setTyped] = React.useState("");
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const typedId = React.useId();
  const errorId = React.useId();

  // A fresh dialog every time it opens.
  React.useEffect(() => {
    if (open) {
      setError(null);
      setTyped("");
      setPending(false);
    }
  }, [open]);

  const busy = pending || loading;
  const typedOk =
    !typedConfirmation ||
    (typedConfirmation.ignoreCase
      ? typed.trim().toLowerCase() === typedConfirmation.value.toLowerCase()
      : typed === typedConfirmation.value);
  const variant: ButtonVariant =
    confirmVariant ?? (intent === "danger" ? "danger" : "primary");

  const confirm = async (): Promise<void> => {
    if (busy || !typedOk || confirmDisabled) return;
    setError(null);
    setPending(true);
    try {
      await onConfirm();
      setPending(false);
      if (closeOnSuccess) onOpenChange(false);
    } catch (e) {
      setPending(false);
      setError(e ?? new Error("Something went wrong. Try again."));
    }
  };

  // `null`: the caller shows this error itself (at a field), so no banner.
  const shown = error ?? callerError;
  const err = shown ? describeError(shown) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      role="alertdialog"
      closeButton={false}
      tone={intent === "neutral" ? "default" : intent}
      title={
        <span className="flex items-start gap-2">
          {ICON[intent] ? (
            // The intent shows in the button too; a phone at large text needs the width.
            <span className="mt-0.5 max-sm:hidden">{ICON[intent]}</span>
          ) : null}
          <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
        </span>
      }
      description={description}
      className="max-sm:overflow-y-auto"
      dismissible={!busy}
      initialFocusRef={cancelRef}
    >
      {lead || consequences?.length || children || err || typedConfirmation ? (
        <DialogBody className="space-y-4 text-sm max-sm:flex-none max-sm:overflow-y-visible">
          {lead}
          {consequences?.length && lead ? (
            // After a lead, the lines are plain text, not a list of one.
            <div className="space-y-1 text-fg-muted">
              {consequences.map((c) => (
                <p key={c}>{c}</p>
              ))}
            </div>
          ) : consequences?.length ? (
            <ul className="list-disc space-y-1 ps-5 text-fg">
              {consequences.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          {err ? (
            <div
              id={errorId}
              role="alert"
              className="flex gap-2 rounded-md border border-danger-border bg-danger-subtle p-3"
            >
              <CircleAlert
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-danger"
              />
              <div className="space-y-0.5">
                <p className="font-semibold text-fg-strong">{err.title}</p>
                {err.description ? (
                  <p className="text-fg">{err.description}</p>
                ) : null}
                <CopyDetails copy={err} />
              </div>
            </div>
          ) : null}
          {children}
          {typedConfirmation ? (
            <div className="space-y-1.5">
              <label htmlFor={typedId} className="block text-sm text-fg">
                {typedConfirmation.label}{" "}
                <code className="rounded-xs bg-surface-sunken px-1 font-mono text-xs text-fg-strong">
                  {typedConfirmation.value}
                </code>
              </label>
              <input
                id={typedId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void confirm();
                  }
                }}
                className={cn(
                  "h-9 w-full rounded-md border border-border-strong bg-surface-sunken px-3 font-mono text-sm text-fg",
                  "focus-visible:outline-2 focus-visible:outline-focus",
                )}
              />
            </div>
          ) : null}
        </DialogBody>
      ) : null}
      <DialogFooter>
        <Button
          ref={cancelRef}
          variant="outline"
          disabled={busy}
          onClick={() => onOpenChange(false)}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={variant}
          // A long label (a count in it) wraps on a phone rather than spill out of the button.
          className="max-sm:h-auto max-sm:min-h-9 max-sm:whitespace-normal max-sm:py-2 max-sm:text-balance"
          loading={busy}
          disabled={confirmDisabled}
          disabledReason={
            !typedOk && typedConfirmation
              ? `Type ${typedConfirmation.value} to confirm`
              : undefined
          }
          aria-describedby={err ? errorId : undefined}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
