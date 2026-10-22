import * as React from "react";
import {
  AlertTriangle,
  CircleAlert,
  Fingerprint,
  OctagonAlert,
} from "lucide-react";
import {
  hasSavedStepUp,
  readStash,
  stashStepUp,
  startStepUp,
} from "../lib/stepUp.js";
import { cn } from "../lib/cn.js";
import { formatRelative } from "../lib/format.js";
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
 * - Step-up (D11): any `step_up_required` answer (a 403 from `onConfirm`, or the caller's `error`)
 *   turns the dialog into its step-up state: "Sign in again to confirm it's you" under the
 *   unchanged consequences, the primary button reading "Sign in again", Cancel unchanged. The sign-in
 *   leaves the page, so a typed confirmation word is kept in `sessionStorage` (under `stepUpKey`,
 *   default the title when it is text) and put back when the dialog opens again after the return.
 *   The caller's own fields (a reason) ride along: `stepUpState` is saved with the word and handed
 *   back to `onRestore` when the dialog opens again. The dialog also opens itself on the page it
 *   left (same `#` route, within 15 minutes) when it holds a saved state for its `stepUpKey`.
 * - The confirm label repeats the verb ("Disable license"), never "Confirm".
 * - Focus lands on Cancel, the least destructive button (`focusTyped` puts it on the typed field).
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
  /** The title bar's close X. Off by default: the Cancel button is the one dismissal (UI-KITS §1.5 rule 10). */
  closeButton?: boolean;
  /** `ignoreCase`: the match trims and ignores case (an email address). */
  typedConfirmation?: { value: string; label: string; ignoreCase?: boolean };
  /**
   * With a `typedConfirmation`, open with focus on its field instead of Cancel: nothing can be
   * confirmed until it is typed, so Cancel's "least destructive" focus saves nothing (a Tab).
   */
  focusTyped?: boolean;
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
  /** Where the typed word waits while the operator signs in again. Default: the title, when text. */
  stepUpKey?: string;
  /** The caller's own fields (a required reason), saved with the typed word across the sign-in. */
  stepUpState?: Record<string, string>;
  /** Puts `stepUpState` back when the dialog opens again after the sign-in. */
  onRestore?: (state: Record<string, string>) => void;
  /** Sends the operator to sign in again. Default: the console's step-up sign-in. */
  onStepUp?: () => void;
  /** When they last signed in (epoch seconds, `Me.authAt`): the step-up state says how long ago. */
  signedInAt?: number | null;
  /** Close after `onConfirm` resolves. Default true; the legacy views close it themselves. */
  closeOnSuccess?: boolean;
  /** Legacy: overrides the confirm button's variant. Prefer `intent`. */
  confirmVariant?: ButtonVariant | null;
  /** Legacy: the caller's own pending state, combined with the dialog's. */
  loading?: boolean;
  /** Legacy: keeps confirm disabled (an input in `children` is not valid yet). */
  confirmDisabled?: boolean;
  /** Why `confirmDisabled` holds (a soft-disabled button names it: "Loading"). */
  confirmDisabledReason?: string;
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

/** The Worker's answer to a gated action whose sign-in is too old (D11). */
export function isStepUpRequired(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null;
  return !!e && e.status === 403 && e.code === "step_up_required";
}

export { hasSavedStepUp };

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
  closeButton = false,
  typedConfirmation,
  onConfirm,
  error: callerError = null,
  children,
  describeError = defaultDescribe,
  closeOnSuccess = true,
  stepUpKey,
  onStepUp,
  stepUpState,
  onRestore,
  signedInAt,
  confirmVariant,
  focusTyped = false,
  loading = false,
  confirmDisabled = false,
  confirmDisabledReason,
}: ConfirmDialogProps): React.ReactElement {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [typed, setTyped] = React.useState("");
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const typedRef = React.useRef<HTMLInputElement>(null);
  const typedId = React.useId();
  const errorId = React.useId();

  const storeKey = stepUpKey ?? (typeof title === "string" ? title : undefined);

  // A fresh dialog every time it opens; a word typed before a step-up sign-in comes back.
  React.useEffect(() => {
    if (open) {
      setError(null);
      const saved = readStash(storeKey, true);
      setTyped(typedConfirmation && saved ? saved.typed : "");
      if (saved && Object.keys(saved.fields).length > 0)
        onRestore?.(saved.fields);
      setPending(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page came back from the sign-in: show the dialog again, with what was typed.
  React.useEffect(() => {
    if (!open && storeKey && hasSavedStepUp(storeKey)) onOpenChange(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = pending || loading;
  const typedOk =
    !typedConfirmation ||
    (typedConfirmation.ignoreCase
      ? typed.trim().toLowerCase() === typedConfirmation.value.toLowerCase()
      : typed === typedConfirmation.value);
  // `null`: the caller shows this error itself (at a field), so no banner.
  const shown = error ?? callerError;
  const stepUp = isStepUpRequired(shown);
  // Signing in again is a request, not a danger: the ink primary whatever the intent.
  const variant: ButtonVariant = stepUp
    ? "primary"
    : (confirmVariant ?? (intent === "danger" ? "danger" : "primary"));

  const confirm = async (): Promise<void> => {
    if (busy) return;
    if (stepUp) {
      stashStepUp(storeKey, typed, stepUpState);
      (onStepUp ?? startStepUp)();
      return;
    }
    if (!typedOk || confirmDisabled) return;
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

  const err = shown && !stepUp ? describeError(shown) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      role="alertdialog"
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
      closeButton={closeButton}
      initialFocusRef={typedConfirmation && focusTyped ? typedRef : cancelRef}
    >
      {lead ||
      consequences?.length ||
      children ||
      err ||
      stepUp ||
      typedConfirmation ? (
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
          {stepUp ? (
            <div
              id={errorId}
              role="status"
              className="flex gap-2 rounded-md border border-border bg-surface-sunken p-3"
            >
              <Fingerprint
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-fg-muted"
              />
              <div className="space-y-0.5">
                <p className="font-semibold text-fg-strong">
                  Sign in again to confirm it&apos;s you
                </p>
                {typeof signedInAt === "number" ? (
                  <p className="text-fg">
                    You signed in {formatRelative(signedInAt * 1000)}.
                  </p>
                ) : null}
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
                ref={typedRef}
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
                  "h-9 pointer-coarse:h-11 w-full rounded-md border border-border-strong bg-surface-sunken px-3 font-mono text-sm text-fg",
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
          variant="ghost"
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
          disabled={confirmDisabled && !stepUp}
          disabledReason={
            !stepUp && !typedOk && typedConfirmation
              ? `Type ${typedConfirmation.value} to confirm`
              : !stepUp && confirmDisabled
                ? confirmDisabledReason
                : undefined
          }
          aria-describedby={err || stepUp ? errorId : undefined}
          onClick={() => void confirm()}
        >
          {stepUp ? "Sign in again" : confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
