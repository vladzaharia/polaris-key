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
// lands on the primary action when there is one, stays on a control the screen's own content
// already focused (the sign-in methods an expired screen embeds), and otherwise goes to the
// panel itself, so a keyboard or screen-reader user starts on the actionable control rather
// than hunting for it (WCAG 2.4.3). A blocking screen is modal: the page behind it is inert and
// Tab stays inside; a dismissible dialog (`scrim`) sits over the host app and closes on Escape.
//
// LAYOUT. Identity, title and body form the head; the content (`extra`) and the actions the
// tail. Actions stack full width, the primary first (UI-KITS §1.5 rule 10). On a narrow window
// the card is full-bleed with the head in the upper third of the space above the tail, which
// docks at the bottom; a short, wide window puts the head and the tail in two columns.
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
  prettyText,
  screenTitle,
  stickyColumn,
  twoColumnCard,
} from "./card.js";
import { useWindowLayout, type WindowLayout } from "./layout.js";

/** The actions: one column, full width, the primary first. Docked on a full-bleed window, where
 *  they stay in view while the text above scrolls. */
function actionStackStyle(layout: WindowLayout | null): CSSProperties {
  const docked = layout?.bleed === true;
  return {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    justifyItems: "stretch",
    gap: SPACE["2"],
    ...(docked
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

/** Every button in the stack fills it. */
const actionCell: CSSProperties = { width: "100%", margin: 0 };

/** A full-bleed card's spacer: grows 1 above the head and 2 below it, so the head sits in the
 *  upper third of the space above the docked tail, at the same height on every gate screen. */
const grow = (n: number): CSSProperties => ({ flexGrow: n, minHeight: 0 });

export interface MessageScreenProps {
  title: string;
  /** Empty string ⇒ no body paragraph and no `aria-describedby`. */
  body?: string;
  /** The product identity rendered above the title (`screenLogo`). */
  logo?: ReactNode;
  /** Content after the body: the sign-in methods an expired or revoked screen embeds. */
  extra?: ReactNode;
  /** A second action after the primary, in the same stack (a dialog's "Later"). */
  secondaryAction?: ReactNode;
  /** The primary action's weight: "primary" (default). "quiet" is for a tertiary action. */
  retryVariant?: ButtonVariant;
  /** Render the primary action wired to this handler. */
  onRetry?: () => void;
  /** The primary action's label (and its accessible name). */
  retryLabel?: string;
  /** The primary action is running (`aria-busy`, a ring beside the label). */
  retryBusy?: boolean;
  /** `true` for transient/non-actionable screens (loading): polite `role="status"`, no focus
   *  steal, no modal semantics. */
  transient?: boolean;
  /** A dismissible dialog over the host app in this scheme: a translucent scrim instead of the
   *  opaque window, a bottom sheet on a narrow window, Escape calls `onDismiss`. */
  scrim?: "dark" | "light";
  /** Escape on a dismissible dialog. */
  onDismiss?: () => void;
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
    retryBusy,
    transient,
    scrim,
    onDismiss,
    className,
    style,
    ...markers
  } = props;
  return (
    <FullWindow
      className={className}
      style={style}
      modal={!transient}
      scrim={scrim}
      onEscape={scrim ? onDismiss : undefined}
      {...markers}
    >
      <MessageCard
        title={title}
        body={body}
        logo={logo}
        extra={extra}
        secondaryAction={secondaryAction}
        retryVariant={retryVariant}
        onRetry={onRetry}
        retryLabel={retryLabel}
        retryBusy={retryBusy}
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
    retryVariant = "primary",
    onRetry,
    retryLabel = "Try again",
    retryBusy,
    transient,
  } = props;
  const titleId = useId();
  const bodyId = useId();
  const retryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const layout = useWindowLayout();

  // Focus management (WCAG 2.4.3): into the screen on mount, onto the primary action, unless the
  // screen's own content already took it (the embedded sign-in methods focus their first).
  useEffect(() => {
    if (transient) return;
    const card = dialogRef.current;
    if (
      card &&
      card.contains(document.activeElement) &&
      document.activeElement !== card
    )
      return;
    (retryRef.current ?? card)?.focus();
  }, [transient]);

  const hasBody = body.length > 0;
  const hasActions = Boolean(onRetry || secondaryAction);
  const hasTail = hasActions || Boolean(extra);
  const bleed = layout?.bleed === true;
  const twoColumn = layout?.twoColumn === true;
  return (
    <div
      ref={dialogRef}
      style={{
        ...messageCard,
        ...cardInWindow(layout),
        ...(twoColumn ? { ...twoColumnCard, textAlign: "start" } : null),
        // A docked action stack carries the bottom inset itself.
        ...(bleed && hasActions ? { paddingBlockEnd: 0 } : null),
      }}
      role={transient ? "status" : "alertdialog"}
      aria-modal={transient ? undefined : true}
      aria-live={transient ? "polite" : undefined}
      aria-labelledby={titleId}
      aria-describedby={hasBody ? bodyId : undefined}
      tabIndex={transient ? undefined : -1}
      data-polaris-card=""
    >
      {bleed && hasTail ? <div aria-hidden="true" style={grow(1)} /> : null}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: twoColumn ? "flex-start" : "center",
          gap: SPACE["2"],
          ...(twoColumn ? stickyColumn : null),
        }}
        data-polaris-head=""
      >
        {logo ? (
          <div style={{ display: "flex", marginBottom: SPACE["2"] }}>
            {logo}
          </div>
        ) : null}
        <h2 id={titleId} style={screenTitle} dir="auto">
          {title}
        </h2>
        {hasBody ? (
          <p id={bodyId} style={{ ...mutedText, ...prettyText }}>
            {body}
          </p>
        ) : null}
      </div>
      {bleed && hasTail ? <div aria-hidden="true" style={grow(2)} /> : null}
      {hasTail ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: SPACE["4"],
            textAlign: "start",
            ...(twoColumn || bleed ? null : { marginTop: SPACE["6"] }),
          }}
          data-polaris-tail=""
        >
          {extra}
          {hasActions ? (
            <div style={actionStackStyle(layout)} data-polaris-actions="">
              {onRetry ? (
                <Button
                  ref={retryRef}
                  variant={retryVariant}
                  label={retryLabel}
                  busy={retryBusy}
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
      ) : null}
    </div>
  );
}
