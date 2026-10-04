// `<MessageScreen>` — the full-window title/body panel every blocking or transient screen in
// the suite renders. Promoted out of `LicenseGate` into a primitive so `ConfigPanel`,
// `UpdatePrompt` and `DeviceManager` inherit the SAME accessibility contract instead of each
// re-deriving it. `test/a11y.test.tsx` asserts that contract through the gate, which is what
// keeps this file honest.
//
// ── THE PINNED CONTRACT ─────────────────────────────────────────────────────────────────────
//
//   blocking (default)          transient (`transient`)
//   ──────────────────          ───────────────────────
//   role="alertdialog"          role="status"
//   aria-modal="true"           aria-live="polite"
//   tabIndex={-1}               (not focusable)
//   focus moves in on mount     focus is NEVER stolen
//
// A blocking screen interrupts because the user cannot proceed; a transient one (loading)
// must not, because it will resolve on its own and stealing focus mid-task is hostile. Focus
// lands on the retry button when there is one and the panel itself otherwise, so a keyboard or
// screen-reader user starts on the actionable control rather than hunting for it (WCAG 2.4.3).
//
// `aria-describedby` is set ONLY when there is a body — pointing it at an element that does
// not exist makes some screen readers announce nothing at all.

import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button, type ButtonVariant } from "./buttons.js";
import { fullWindow, messageCard, mutedText, titleText } from "./card.js";

/** The centred, wrapping row a screen's actions sit in. */
const actionRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: "8px",
  marginTop: "20px",
};

export interface MessageScreenProps {
  title: string;
  /** Empty string ⇒ no body paragraph and no `aria-describedby`. */
  body?: string;
  /** A brand node rendered above the title. */
  logo?: ReactNode;
  /** Extra content between the body and the retry action. */
  extra?: ReactNode;
  /** A second action rendered after the retry action, in the same centred row (a dialog's
   *  "Not now"). */
  secondaryAction?: ReactNode;
  /** The retry action's weight: "quiet" (default) for a recovery, "primary" when it is the
   *  screen's main action (an update dialog's "Get the update"). */
  retryVariant?: ButtonVariant;
  /** Render a retry action wired to this handler. */
  onRetry?: () => void;
  /** The retry button's label (and its accessible name). */
  retryLabel?: string;
  /** `true` for transient/non-actionable screens (loading): polite `role="status"`, no focus
   *  steal, no modal semantics. */
  transient?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Escape hatch for the `data-polaris-*` markers the suite's tests query by. */
  [dataAttr: `data-${string}`]: unknown;
}

export function MessageScreen(props: MessageScreenProps): JSX.Element {
  const {
    title,
    body = "",
    logo,
    extra,
    secondaryAction,
    retryVariant = "quiet",
    onRetry,
    retryLabel = "Try again",
    transient,
    className,
    style,
    ...rest
  } = props;
  const titleId = useId();
  const bodyId = useId();
  const retryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus management (WCAG 2.4.3): move focus into the screen on mount so keyboard/SR users
  // land on the actionable control (retry) or, failing that, the panel itself.
  useEffect(() => {
    if (transient) return;
    const target = retryRef.current ?? dialogRef.current;
    target?.focus();
  }, [transient]);

  const hasBody = body.length > 0;
  return (
    <div className={className} style={{ ...fullWindow, ...style }} {...rest}>
      <div
        ref={dialogRef}
        style={messageCard}
        role={transient ? "status" : "alertdialog"}
        aria-modal={transient ? undefined : true}
        aria-live={transient ? "polite" : undefined}
        aria-labelledby={titleId}
        aria-describedby={hasBody ? bodyId : undefined}
        tabIndex={transient ? undefined : -1}
      >
        {logo ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              marginBottom: "12px",
            }}
          >
            {logo}
          </div>
        ) : null}
        <h2 id={titleId} style={{ ...titleText, margin: "0 0 8px" }}>
          {title}
        </h2>
        {hasBody ? (
          <p id={bodyId} style={mutedText}>
            {body}
          </p>
        ) : null}
        {extra}
        {onRetry || secondaryAction ? (
          <div style={actionRow}>
            {onRetry ? (
              <Button
                ref={retryRef}
                variant={retryVariant}
                label={retryLabel}
                onClick={onRetry}
                style={{ marginTop: 0 }}
              >
                {retryLabel}
              </Button>
            ) : null}
            {secondaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}
