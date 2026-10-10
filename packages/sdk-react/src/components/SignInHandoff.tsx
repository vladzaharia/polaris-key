// The hand-off of a device-code sign-in (identity.devicecode): the person finishes signing in in
// a browser tab, and the card waits for it. It shows what that needs and nothing else.
//
// The card is two parts, so a phone can keep the code with the title and dock only the buttons
// (DL1): `HandoffCode` is the code well (the code, and Copy inside it as an icon button) with the
// line asking to compare codes; `HandoffActions` is Open browser (the one filled button), the
// address and the countdown on one muted line, and Cancel (a text action). `useHandoff` holds
// what both read: the countdown, the copy state and which links are usable.
//
// DL14: the web browses, so there is no QR. Links pass `safeLink` before they are shown or
// opened; a missing one hides its control, and when links were supplied but none is usable the
// card says sign-in is unavailable and offers Cancel, never a code with nowhere to type it. At
// 0:00 the card turns to "Code expired" locally, while the poll finishes in the adapter.
//
// Accessibility: focus goes to Open browser (the primary) on mount; Escape cancels from anywhere
// on the page while the hand-off is up; the countdown is `aria-live="off"` (the gate's own polite
// region would otherwise read it every second) and only the two outcomes are announced, each
// once: "Copied" and the expiry. The code is read once, under its label.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { FONT, SPACE, KIT_TOKENS } from "@polaris-key/brand";
import type { OidcSignInHandle } from "../core/index.js";
import { Button } from "./primitives/buttons.js";
import { actionPanel, mutedText, prettyText } from "./primitives/card.js";
import { ExternalGlyph } from "./primitives/glyphs.js";
import { FORCED_COLORS, useMediaQuery } from "./primitives/media.js";
import { useFocusRing } from "./primitives/focus.js";
import { screenLogo } from "./brand.js";
import { formatCopy } from "./format.js";
import { linkText, openLink, safeLink } from "./links.js";
import { knownProductName, type PolarisTheme } from "./theme.js";

/** m:ss for a whole number of seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What the hand-off's two parts read. */
export interface Handoff {
  handle: OidcSignInHandle;
  code: string | undefined;
  /** The sign-in page with the code in it, when it passed `safeLink`. */
  open: string | null;
  /** The bare page for typing the code, when it passed `safeLink`. */
  address: string | null;
  /** Links were supplied and none is usable: the card cannot do its job. */
  unusable: boolean;
  /** Seconds left, or null when the host reported no expiry. */
  left: number | null;
  expired: boolean;
  copied: boolean;
  copyCode: () => void;
}

export function useHandoff(handle: OidcSignInHandle | null): Handoff | null {
  const expiresAt = handle?.expiresAt;
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (expiresAt === undefined) {
      setLeft(null);
      return;
    }
    const tick = (): void => setLeft(expiresAt - Date.now() / 1000);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);
  const code = handle?.userCode;
  const copyCode = useCallback((): void => {
    if (!code) return;
    void Promise.resolve(navigator.clipboard?.writeText(code))
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [code]);

  if (!handle) return null;
  const open = safeLink(handle.verificationUrl);
  const address = safeLink(handle.verificationUri ?? handle.verificationUrl);
  const supplied = Boolean(handle.verificationUrl || handle.verificationUri);
  // The first render of a new handle has not ticked yet: read the clock directly.
  const remaining =
    expiresAt === undefined ? null : (left ?? expiresAt - Date.now() / 1000);
  return {
    handle,
    code,
    open,
    address,
    unusable: supplied && !open && !address,
    left: remaining,
    expired: remaining !== null && remaining <= 0,
    copied,
    copyCode,
  };
}

/** The one-line identity header: the product's icon and its name (DL5). */
export function HandoffHeader(props: {
  theme: PolarisTheme;
}): React.JSX.Element {
  const name = knownProductName(props.theme);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: SPACE["3"] }}
      data-polaris-handoff-header=""
    >
      {screenLogo(props.theme, "2rem")}
      {name ? (
        <span
          dir="auto"
          style={{
            fontWeight: 500,
            color: "var(--pk-text-strong, var(--pk-text))",
          }}
        >
          {name}
        </span>
      ) : null}
    </div>
  );
}

/** The code well: as large as the title beside it or larger (DL10), in the kit mono, never cut
 *  inside a group (it breaks at its hyphen), Copy at its inline end. */
const wellStyle: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: SPACE["2"],
  width: "100%",
  padding: `${SPACE["3"]} ${SPACE["3"]} ${SPACE["3"]} ${SPACE["4"]}`,
  background: "var(--pk-surface-sunken, var(--pk-surface))",
  borderRadius: "var(--pk-control-radius, var(--pk-radius))",
};

const codeStyle: CSSProperties = {
  margin: 0,
  flex: "1 1 auto",
  minWidth: 0,
  textAlign: "center",
  fontFamily: FONT.mono,
  // The title is clamp(1.625rem, 1rem + 2.4cqi, 2.125rem); this is never below it.
  fontSize: "clamp(1.75rem, 1rem + 3cqi, 2.5rem)",
  lineHeight: 1.2,
  fontWeight: KIT_TOKENS.typeScale.web.code.weight,
  letterSpacing: `${KIT_TOKENS.typeScale.web.code.tracking}em`,
  color: "var(--pk-text-strong, var(--pk-text))",
  overflowWrap: "normal",
  wordBreak: "keep-all",
  userSelect: "all",
};

function CopyGlyph(props: { done: boolean }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="1.25em"
      height="1.25em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.done ? (
        <path d="M3 8.5 6.5 12 13 4.5" />
      ) : (
        <>
          <rect x="5.5" y="5.5" width="7.5" height="8" rx="1.5" />
          <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v6A1.5 1.5 0 0 0 4 10.5h1" />
        </>
      )}
    </svg>
  );
}

/** The code, Copy inside its well, and the line asking to compare. Renders nothing while the
 *  card cannot do its job (no usable link) or after the code ran out. */
export function HandoffCode(props: {
  theme: PolarisTheme;
  hand: Handoff;
}): React.JSX.Element | null {
  const { theme, hand } = props;
  const copy = theme.copy;
  const forced = useMediaQuery(FORCED_COLORS);
  const ring = useFocusRing();
  if (!hand.code || hand.unusable || hand.expired) return null;
  return (
    <>
      <div
        style={{
          ...wellStyle,
          ...(forced ? { border: "1px solid CanvasText" } : null),
        }}
        role="group"
        aria-label={copy.handoffCodeLabel}
        data-polaris-code-well=""
      >
        <p style={codeStyle} data-polaris-code="">
          {hand.code}
        </p>
        <button
          type="button"
          onClick={hand.copyCode}
          aria-label={copy.handoffCopyLabel}
          title={hand.copied ? copy.handoffCopiedLabel : copy.handoffCopyLabel}
          onFocus={ring.onFocus}
          onBlur={ring.onBlur}
          style={{
            appearance: "none",
            flex: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            // A 44 px target, even in a well.
            width: "2.75rem",
            height: "2.75rem",
            padding: 0,
            cursor: "pointer",
            color: "var(--pk-text-strong, var(--pk-text))",
            background: "transparent",
            border: "1px solid transparent",
            borderRadius: "var(--pk-control-radius, var(--pk-radius))",
            fontSize: "1rem",
            ...ring.style,
          }}
          data-polaris-handoff-copy=""
        >
          <CopyGlyph done={hand.copied} />
        </button>
      </div>
      <p style={{ ...mutedText, ...prettyText }} data-polaris-handoff-check="">
        {copy.handoffCheck}
      </p>
    </>
  );
}

export interface HandoffActionsProps {
  theme: PolarisTheme;
  hand: Handoff;
  /** Cancel was chosen (the button, or Escape anywhere): the wait has been stopped. */
  onCancel: () => void;
  /** "Sign in again" on the expired card. */
  onAgain: () => void;
}

/** Open browser, the address and countdown line, Cancel; or, once the code ran out, the
 *  message and Sign in again. */
export function HandoffActions(props: HandoffActionsProps): React.JSX.Element {
  const { theme, hand, onCancel, onAgain } = props;
  const copy = theme.copy;
  const primary = useRef<HTMLButtonElement>(null);
  const expiredId = useId();

  // Focus the one primary: Open browser; Sign in again when the code ran out; else Cancel.
  const view = hand.expired
    ? "expired"
    : hand.unusable
      ? "unusable"
      : "waiting";
  useEffect(() => {
    primary.current?.focus();
  }, [view]);

  // Escape backs out from wherever focus is on the page, not only from inside the card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  if (hand.expired)
    return (
      <div
        style={{ ...actionPanel, gap: SPACE["3"] }}
        data-polaris-handoff="expired"
      >
        <p
          id={expiredId}
          role="status"
          style={{ ...mutedText, ...prettyText }}
          data-polaris-handoff-expired=""
        >
          {copy.handoffExpiredBody}
        </p>
        <Button
          ref={primary}
          variant="primary"
          describedBy={expiredId}
          onClick={onAgain}
          data-polaris-handoff-again=""
        >
          {copy.handoffAgainLabel}
        </Button>
        <Button
          variant="ghost"
          onClick={onCancel}
          data-polaris-handoff-cancel=""
        >
          {copy.handoffCancelLabel}
        </Button>
      </div>
    );

  if (hand.unusable)
    return (
      <div
        style={{ ...actionPanel, gap: SPACE["3"] }}
        data-polaris-handoff="unusable"
      >
        <p role="status" style={{ ...mutedText, ...prettyText }}>
          {copy.noMethodsLabel}
        </p>
        <Button
          ref={primary}
          variant="primary"
          onClick={onCancel}
          data-polaris-handoff-cancel=""
        >
          {copy.handoffCancelLabel}
        </Button>
      </div>
    );

  return (
    <div
      style={{ ...actionPanel, gap: SPACE["3"] }}
      data-polaris-handoff="waiting"
    >
      {hand.open ? (
        <Button
          ref={primary}
          variant="primary"
          label={copy.handoffOpenLabel}
          onClick={() => hand.open && openLink(hand.open)}
          data-polaris-handoff-open=""
        >
          {copy.handoffOpenLabel}
          <ExternalGlyph />
        </Button>
      ) : null}
      {hand.address || hand.left !== null ? (
        <p
          // The nearest live region wins: the gate's is polite, and a countdown in it would be
          // read every second.
          aria-live="off"
          style={{
            ...mutedText,
            ...prettyText,
            display: "flex",
            flexWrap: "wrap",
            columnGap: SPACE["3"],
          }}
          data-polaris-handoff-meta=""
        >
          {hand.address ? (
            <span data-polaris-handoff-url="">
              {formatCopy(copy.handoffUrl, { url: linkText(hand.address) })}
            </span>
          ) : null}
          {hand.left !== null ? (
            <span data-polaris-handoff-expires="">
              {formatCopy(copy.handoffExpires, { time: clock(hand.left) })}
            </span>
          ) : null}
        </p>
      ) : null}
      <Button
        ref={hand.open ? undefined : primary}
        variant="ghost"
        onClick={onCancel}
        data-polaris-handoff-cancel=""
      >
        {copy.handoffCancelLabel}
      </Button>
      <span
        role="status"
        aria-live="polite"
        style={visuallyHidden}
        data-polaris-handoff-status=""
      >
        {hand.copied ? copy.handoffCopiedLabel : ""}
      </span>
    </div>
  );
}

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};
