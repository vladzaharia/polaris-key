// `<UpdatePrompt>` — the slotted UI half of the Update service. `useLatestVersion` does the
// polling; this decides how to interrupt.
//
// Two presentations, because "there is a newer build" is not always the same urgency:
//
//   banner (default)  a `role="status"`, `aria-live="polite"` strip. It does NOT steal focus,
//                     because an available update is information, not a blocker, and yanking
//                     focus out of what the user is typing to announce one is hostile.
//   dialog            the blocking `MessageScreen` contract (alertdialog + focus move), for a
//                     host that genuinely cannot continue on the running build.
//
// It renders NOTHING when there is no update, when the product runs no Update service, or
// after the user dismisses it — an empty banner reserving layout for an event that has not
// happened is its own bug.
//
// ── THE DEFAULT ACTION IS A NAVIGATION ──────────────────────────────────────────────────────
//
// `latest.url` arrives from the Update service (browser: an HTTP response body; desktop: the
// privileged process's answer to `invoke("update", "check")`), and the default action hands it
// straight to `window.open`. That makes an update feed an open-redirect primitive unless the
// scheme is checked, and `javascript:` in particular is script execution in the host page. So
// the URL goes through `isSecureTransportUrl` — the SAME https-or-loopback rule `BrowserAdapter`
// applies to its `baseUrl` — and a refusal renders in place of the navigation rather than
// falling through to it.

import { useState, type ReactNode } from "react";
import { isSecureTransportUrl } from "../core/index.js";
import { usePolarisTheme } from "../react/hooks.js";
import {
  useLatestVersion,
  type UseLatestVersion,
  type UseLatestVersionOptions,
} from "../update/useLatestVersion.js";
import { Button } from "./primitives/buttons.js";
import { MessageScreen } from "./primitives/MessageScreen.js";
import { dangerText, mutedText } from "./primitives/card.js";

export interface UpdatePromptSlots {
  /** Replace the whole prompt. Receives the live check plus a dismiss callback. */
  prompt?: (ctx: UseLatestVersion & { dismiss: () => void }) => ReactNode;
}

export interface UpdatePromptProps extends UseLatestVersionOptions {
  /** `banner` (default, non-blocking) or `dialog` (blocking, focus-managed). */
  variant?: "banner" | "dialog";
  slots?: UpdatePromptSlots;
  className?: string;
  /** Invoked when the user takes the update action. Defaults to opening `latest.url`. */
  onUpdate?: (ctx: UseLatestVersion) => void;
  /** Render even when the running build is current (shows the "up to date" line). */
  showWhenCurrent?: boolean;
}

export function UpdatePrompt(props: UpdatePromptProps): JSX.Element | null {
  const theme = usePolarisTheme();
  const {
    variant = "banner",
    slots,
    className,
    onUpdate,
    showWhenCurrent,
    ...pollOptions
  } = props;
  const check = useLatestVersion(pollOptions);
  const [dismissed, setDismissed] = useState(false);
  const [refused, setRefused] = useState(false);

  if (!check.enabled || dismissed) return null;
  if (!check.updateAvailable && !showWhenCurrent) return null;

  const dismiss = (): void => setDismissed(true);

  if (slots?.prompt) return <>{slots.prompt({ ...check, dismiss })}</>;

  if (!check.updateAvailable) {
    return (
      <div
        className={className}
        role="status"
        aria-live="polite"
        style={{ ...mutedText, fontSize: "13px", padding: "8px 16px" }}
        data-polaris-update="current"
      >
        {theme.copy.updateUpToDateLabel}
      </div>
    );
  }

  const act = (): void => {
    if (onUpdate) {
      // The host took the action over; it owns the URL and any policy about it.
      onUpdate(check);
      return;
    }
    const url = check.latest?.url;
    // Fail safe: refuse first, navigate second. Nothing opens on a rejected URL.
    if (!url || !isSecureTransportUrl(url)) {
      setRefused(true);
      return;
    }
    setRefused(false);
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const body = check.latest
    ? `${theme.copy.updateBody} (${check.latest.version})`
    : theme.copy.updateBody;

  /** The refusal, rendered the way this suite renders every other failure a user can act on:
   *  `role="alert"` in the danger colour, alongside the control that produced it. */
  const refusal = refused ? (
    <p
      style={{ ...dangerText, margin: 0 }}
      role="alert"
      data-polaris-update-refused=""
    >
      {theme.copy.updateUnsafeUrlBody}
    </p>
  ) : null;

  if (variant === "dialog") {
    return (
      <MessageScreen
        className={className}
        title={theme.copy.updateTitle}
        body={body}
        logo={theme.logo}
        onRetry={act}
        retryLabel={theme.copy.updateActionLabel}
        extra={
          <div style={{ marginTop: "8px" }}>
            {refusal}
            <Button
              variant="ghost"
              style={{ fontSize: "13px" }}
              onClick={dismiss}
            >
              {theme.copy.updateDismissLabel}
            </Button>
          </div>
        }
        data-polaris-update="dialog"
      />
    );
  }

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label={theme.copy.updateTitle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 16px",
        background: "var(--pk-surface)",
        borderBottom: "1px solid var(--pk-border)",
        color: "var(--pk-text-muted)",
        fontFamily: "var(--pk-font-family)",
        fontSize: "13px",
      }}
      data-polaris-update="banner"
    >
      <span>
        {theme.copy.updateTitle} — {body}
      </span>
      {refusal}
      <Button
        variant="secondary"
        style={{ padding: "6px 12px", fontSize: "13px" }}
        onClick={act}
        data-polaris-update-action=""
      >
        {theme.copy.updateActionLabel}
      </Button>
      <Button
        variant="ghost"
        style={{ padding: "6px 12px", fontSize: "13px" }}
        onClick={dismiss}
        data-polaris-update-dismiss=""
      >
        {theme.copy.updateDismissLabel}
      </Button>
    </div>
  );
}
