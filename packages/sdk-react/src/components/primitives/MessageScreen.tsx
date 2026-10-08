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
import { SPACE } from "@polaris-key/brand";
import { Button, type ButtonVariant } from "./buttons.js";
import {
  FullWindow,
  cardInWindow,
  messageCard,
  mutedText,
  titleText,
} from "./card.js";
import {
  WindowLayoutContext,
  useWindowLayout,
  type WindowLayout,
} from "./layout.js";

/**
 * The row a screen's actions sit in: equal widths, the main action first (on the start side, or
 * on top once they stack). Two actions share a row while each gets 9rem; on a full-bleed window
 * they need 12rem each, so a phone stacks them, and the row docks to the bottom of the screen,
 * where a thumb reaches it, staying in view while the text above scrolls.
 */
function actionRowStyle(layout: WindowLayout | null): CSSProperties {
  const bleed = layout?.bleed === true;
  return {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${bleed ? "12rem" : "9rem"}), 1fr))`,
    justifyItems: "stretch",
    gap: SPACE["2"],
    marginTop: SPACE["6"],
    ...(bleed
      ? {
          position: "sticky",
          bottom: 0,
          paddingTop: SPACE["4"],
          paddingBottom: `max(${SPACE["5"]}, env(safe-area-inset-bottom))`,
          background: "var(--pk-surface)",
        }
      : null),
  };
}

/** Every button in the row fills its cell, so a pair is the same width. */
const actionCell: CSSProperties = { width: "100%", margin: 0 };

export interface MessageScreenProps {
  title: string;
  /** Empty string ⇒ no body paragraph and no `aria-describedby`. */
  body?: string;
  /** A brand node rendered above the title. */
  logo?: ReactNode;
  /** Extra content between the body and the retry action. */
  extra?: ReactNode;
  /** A second action rendered after the retry action, in the same row and at the same width
   *  (a dialog's "Not now"). */
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
    body,
    logo,
    extra,
    secondaryAction,
    retryVariant,
    onRetry,
    retryLabel,
    transient,
    className,
    style,
    ...markers
  } = props;
  return (
    <FullWindow className={className} style={style} {...markers}>
      <MessageCard
        title={title}
        body={body}
        logo={logo}
        extra={extra}
        secondaryAction={secondaryAction}
        retryVariant={retryVariant}
        onRetry={onRetry}
        retryLabel={retryLabel}
        transient={transient}
      />
    </FullWindow>
  );
}

function MessageCard(props: MessageScreenProps): JSX.Element {
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
  } = props;
  const titleId = useId();
  const bodyId = useId();
  const retryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const layout = useWindowLayout();

  // Focus management (WCAG 2.4.3): move focus into the screen on mount so keyboard/SR users
  // land on the actionable control (retry) or, failing that, the panel itself.
  useEffect(() => {
    if (transient) return;
    const target = retryRef.current ?? dialogRef.current;
    target?.focus();
  }, [transient]);

  const hasBody = body.length > 0;
  const hasActions = Boolean(onRetry || secondaryAction);
  const bleed = layout?.bleed === true;
  return (
    <div
      ref={dialogRef}
      style={{
        ...messageCard,
        ...cardInWindow(layout),
        // A docked action row carries the bottom inset itself.
        ...(bleed && hasActions ? { paddingBlockEnd: 0 } : null),
      }}
      role={transient ? "status" : "alertdialog"}
      aria-modal={transient ? undefined : true}
      aria-live={transient ? "polite" : undefined}
      aria-labelledby={titleId}
      aria-describedby={hasBody ? bodyId : undefined}
      tabIndex={transient ? undefined : -1}
    >
      {/* On a full-bleed window the text centres in the space above the docked actions. */}
      <div style={bleed ? { marginBlock: "auto" } : undefined}>
        {logo ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              marginBottom: SPACE["3"],
            }}
          >
            {logo}
          </div>
        ) : null}
        <h2 id={titleId} style={{ ...titleText, margin: `0 0 ${SPACE["2"]}` }}>
          {title}
        </h2>
        {hasBody ? (
          <p id={bodyId} style={mutedText}>
            {body}
          </p>
        ) : null}
        {/* Content nested in the card is not the window's card. */}
        <WindowLayoutContext.Provider value={null}>
          {extra}
        </WindowLayoutContext.Provider>
      </div>
      {hasActions ? (
        <div style={actionRowStyle(layout)} data-polaris-actions="">
          {onRetry ? (
            <Button
              ref={retryRef}
              variant={retryVariant}
              label={retryLabel}
              onClick={onRetry}
              style={actionCell}
            >
              {retryLabel}
            </Button>
          ) : null}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
