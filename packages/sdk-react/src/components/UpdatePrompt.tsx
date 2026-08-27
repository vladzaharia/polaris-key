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

import { useState, type ReactNode } from "react";
import { usePolarisTheme } from "../react/hooks.js";
import {
  useLatestVersion,
  type UseLatestVersion,
  type UseLatestVersionOptions,
} from "../update/useLatestVersion.js";
import { Button } from "./primitives/buttons.js";
import { MessageScreen } from "./primitives/MessageScreen.js";
import { mutedText } from "./primitives/card.js";

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
      onUpdate(check);
      return;
    }
    if (check.latest?.url && typeof window !== "undefined") {
      window.open(check.latest.url, "_blank", "noopener,noreferrer");
    }
  };

  const body = check.latest
    ? `${theme.copy.updateBody} (${check.latest.version})`
    : theme.copy.updateBody;

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
