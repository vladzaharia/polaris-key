// The hand-off of a device-code sign-in (identity.devicecode): the person finishes signing in in
// a browser tab, and this card waits for it. It shows what that needs and nothing else: the
// code, to compare with the one the page shows; "Open browser", which opens the sign-in page with
// the code in it; the address, for typing by hand; Copy for the code; and how long the code
// lasts. Cancel stops the wait and gives the sign-in methods back.
//
// DL14: the web browses, so there is no QR. Links pass `safeLink` before they are shown or
// opened; a missing or invalid one hides its control and leaves the rest working. At 0:00 the
// card turns to "expired" locally, while the poll finishes in the adapter.
//
// Accessibility: focus goes to Open browser (the one primary) on mount; Escape cancels; the
// countdown is not a live region (a per-second announcement would drown the page), only the two
// outcomes are announced, politely, once each: "Copied" and the expiry.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { SPACE, KIT_TOKENS } from "@polaris-key/brand";
import type { OidcSignInHandle } from "../core/index.js";
import { Button } from "./primitives/buttons.js";
import { actionPanel, mutedText, prettyText } from "./primitives/card.js";
import { ExternalGlyph } from "./primitives/glyphs.js";
import { formatCopy } from "./format.js";
import { linkText, openLink, safeLink } from "./links.js";
import type { PolarisTheme } from "./theme.js";

/** m:ss for a whole number of seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The code: as large as the title beside it (DL10), in a monospace face, never cut inside a
 *  group (it breaks at its hyphen). */
const codeStyle: CSSProperties = {
  margin: 0,
  padding: `${SPACE["3"]} ${SPACE["4"]}`,
  textAlign: "center",
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: KIT_TOKENS.typeScale.web.title.size,
  lineHeight: KIT_TOKENS.typeScale.web.title.lineHeight,
  fontWeight: 500,
  letterSpacing: "0.06em",
  color: "var(--pk-text-strong, var(--pk-text))",
  background: "var(--pk-surface-sunken, var(--pk-surface))",
  borderRadius: "var(--pk-control-radius, var(--pk-radius))",
  overflowWrap: "normal",
  wordBreak: "keep-all",
  userSelect: "all",
};

export interface SignInHandoffProps {
  theme: PolarisTheme;
  handle: OidcSignInHandle;
  /** Cancel was chosen (the button or Escape): the wait has been stopped. */
  onCancel: () => void;
  /** "Sign in again" on the expired card. */
  onAgain: () => void;
  /** Called once with whether the card is showing the expired view, so the card can name it. */
  onExpired?: (expired: boolean) => void;
}

export function SignInHandoff(props: SignInHandoffProps): React.JSX.Element {
  const { theme, handle } = props;
  const copy = theme.copy;
  const open = safeLink(handle.verificationUrl);
  const address = safeLink(handle.verificationUri ?? handle.verificationUrl);
  const code = handle.userCode;

  const expiresAt = handle.expiresAt;
  const [left, setLeft] = useState<number | null>(() =>
    expiresAt === undefined ? null : expiresAt - Date.now() / 1000,
  );
  useEffect(() => {
    if (expiresAt === undefined) return;
    const tick = (): void => setLeft(expiresAt - Date.now() / 1000);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  const expired = left !== null && left <= 0;
  const { onExpired } = props;
  useEffect(() => {
    onExpired?.(expired);
  }, [expired, onExpired]);

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);
  const copyCode = useCallback((): void => {
    if (!code) return;
    void Promise.resolve(navigator.clipboard?.writeText(code))
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [code]);

  // Focus the one primary on mount: Open browser, else Copy, else Cancel.
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus();
  }, [expired]);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onCancel();
    }
  };

  if (expired)
    return (
      <div
        style={{ ...actionPanel, gap: SPACE["3"] }}
        onKeyDown={onKeyDown}
        data-polaris-handoff="expired"
      >
        <p role="status" style={{ ...mutedText, ...prettyText }}>
          <strong
            style={{
              display: "block",
              fontWeight: 500,
              color: "var(--pk-text-strong, var(--pk-text))",
            }}
          >
            {copy.handoffExpiredTitle}
          </strong>
          {copy.handoffExpiredBody}
        </p>
        <Button
          ref={primary}
          variant="primary"
          onClick={props.onAgain}
          data-polaris-handoff-again=""
        >
          {copy.handoffAgainLabel}
        </Button>
        <Button
          variant="secondary"
          onClick={props.onCancel}
          data-polaris-handoff-cancel=""
        >
          {copy.handoffCancelLabel}
        </Button>
      </div>
    );

  return (
    <div
      style={{ ...actionPanel, gap: SPACE["3"] }}
      onKeyDown={onKeyDown}
      data-polaris-handoff="waiting"
    >
      {code ? (
        <>
          <p
            style={codeStyle}
            role="group"
            aria-label={`${copy.handoffCodeLabel} ${code}`}
            data-polaris-code=""
          >
            {code}
          </p>
          <p style={{ ...mutedText, ...prettyText }}>{copy.handoffCheck}</p>
        </>
      ) : null}
      {open ? (
        <Button
          ref={primary}
          variant="primary"
          label={copy.handoffOpenLabel}
          onClick={() => openLink(open)}
          data-polaris-handoff-open=""
        >
          {copy.handoffOpenLabel}
          <ExternalGlyph />
        </Button>
      ) : null}
      {code ? (
        <Button
          ref={open ? undefined : primary}
          variant="secondary"
          label={copy.handoffCopyLabel}
          onClick={copyCode}
          data-polaris-handoff-copy=""
        >
          {copied ? copy.handoffCopiedLabel : copy.handoffCopyLabel}
        </Button>
      ) : null}
      {address ? (
        <p style={{ ...mutedText, ...prettyText }} data-polaris-handoff-url="">
          {formatCopy(copy.handoffUrl, { url: linkText(address) })}
        </p>
      ) : null}
      {left !== null ? (
        <p style={mutedText} data-polaris-handoff-expires="">
          {formatCopy(copy.handoffExpires, { time: clock(left) })}
        </p>
      ) : null}
      <Button
        ref={open || code ? undefined : primary}
        variant="quiet"
        onClick={props.onCancel}
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
        {copied ? copy.handoffCopiedLabel : ""}
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
