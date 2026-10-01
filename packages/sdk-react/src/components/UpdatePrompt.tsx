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
// ── TWO SOURCES ─────────────────────────────────────────────────────────────────────────────
//
//   source="version" (default)   `useLatestVersion`: the unsigned `/update/version` check,
//                                unchanged.
//   source="decision"            `useUpdateDecision`: wire v4's signed decision. Each action
//                                renders its own state: `code-ready` (restart), `binary`
//                                (download), `store` (open the listing), `platform` (the store
//                                or platform installs it) and `blocked {app-floor}`. A
//                                mandatory offer and every `blocked` answer are prompts the
//                                player CANNOT dismiss (plans/P3-01.md §2.8): a persistent
//                                `role="alert"` banner with no dismiss control, whatever the
//                                variant. It never covers the app — no v4 answer stops play,
//                                so the full-window dialog is only for a dismissable
//                                decision with `variant="dialog"`. `none` renders nothing.

import { useState, type ReactNode } from "react";
import { useCtx, usePolarisTheme } from "../react/hooks.js";
import {
  useLatestVersion,
  type UseLatestVersion,
  type UseLatestVersionOptions,
} from "../update/useLatestVersion.js";
import {
  useUpdateDecision,
  type UseUpdateDecision,
  type UseUpdateDecisionOptions,
} from "../update/useUpdateDecision.js";
import { Button } from "./primitives/buttons.js";
import { MessageScreen } from "./primitives/MessageScreen.js";
import { mutedText } from "./primitives/card.js";

export interface UpdatePromptSlots {
  /** Replace the whole prompt. Receives the live check plus a dismiss callback. */
  prompt?: (ctx: UseLatestVersion & { dismiss: () => void }) => ReactNode;
  /** `source="decision"`: replace the whole prompt. `dismiss` does nothing while the decision
   *  is `undismissable`. */
  decision?: (ctx: UseUpdateDecision & { dismiss: () => void }) => ReactNode;
}

export interface UpdatePromptProps
  extends
    UseLatestVersionOptions,
    Omit<UseUpdateDecisionOptions, keyof UseLatestVersionOptions> {
  /** `version` (default): the unsigned `/update/version` check. `decision`: wire v4's signed
   *  update decision. */
  source?: "version" | "decision";
  /** `banner` (default, non-blocking) or `dialog` (blocking, focus-managed). A decision the
   *  player cannot dismiss is always a persistent banner with no dismiss control: it must
   *  never cover a game that keeps running. */
  variant?: "banner" | "dialog";
  slots?: UpdatePromptSlots;
  className?: string;
  /** Invoked when the user takes the update action. Defaults to opening `latest.url`. */
  onUpdate?: (ctx: UseLatestVersion) => void;
  /** `source="decision"`: invoked when the user takes the action. Defaults: `store` opens its
   *  `listingUrl`, `binary` opens the build's download URL (browser), `platform` reloads a
   *  browser page. `code-ready` and `blocked` have no default: without this, no action shows. */
  onAction?: (ctx: UseUpdateDecision) => void;
  /** Render even when the running build is current (shows the "up to date" line). */
  showWhenCurrent?: boolean;
}

export function UpdatePrompt(props: UpdatePromptProps): JSX.Element | null {
  const { source = "version", ...rest } = props;
  return source === "decision" ? (
    <DecisionPrompt {...rest} />
  ) : (
    <VersionPrompt {...rest} />
  );
}

function VersionPrompt(
  props: Omit<UpdatePromptProps, "source">,
): JSX.Element | null {
  const theme = usePolarisTheme();
  const {
    variant = "banner",
    slots,
    className,
    onUpdate,
    showWhenCurrent,
    channel,
    intervalSeconds,
    immediate,
    fetcher,
  } = props;
  const check = useLatestVersion({
    channel,
    intervalSeconds,
    immediate,
    fetcher,
  });
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

function DecisionPrompt(
  props: Omit<UpdatePromptProps, "source">,
): JSX.Element | null {
  const theme = usePolarisTheme();
  const { adapter } = useCtx();
  const {
    variant = "banner",
    slots,
    className,
    onAction,
    showWhenCurrent,
    channel,
    staged,
    skipVersion,
    intervalSeconds,
    immediate,
    decider,
  } = props;
  const ctx = useUpdateDecision({
    channel,
    staged,
    skipVersion,
    intervalSeconds,
    immediate,
    decider,
  });
  const [dismissed, setDismissed] = useState(false);
  const decision = ctx.decision;
  const locked = ctx.undismissable;

  if (!ctx.enabled || !decision) return null;
  if (dismissed && !locked) return null;
  const dismiss = (): void => {
    if (!locked) setDismissed(true);
  };
  if (slots?.decision) return <>{slots.decision({ ...ctx, dismiss })}</>;

  if (decision.action === "none") {
    if (!showWhenCurrent || decision.reason !== "up-to-date") return null;
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

  const c = theme.copy;
  const version =
    decision.action === "blocked" ? null : decision.release.version;
  const withVersion = (text: string): string =>
    version ? `${text} (${version})` : text;
  const mandatory =
    decision.action !== "code-ready" &&
    decision.action !== "blocked" &&
    decision.mandatory;

  let title = c.updateTitle;
  let body = withVersion(c.updateBody);
  let label = c.updateActionLabel;
  let fallback: (() => void) | null = null;
  switch (decision.action) {
    case "code-ready":
      title = c.updateReadyTitle;
      body = withVersion(c.updateReadyBody);
      label = c.updateRestartLabel;
      break;
    case "binary": {
      const build = decision.build;
      const v = decision.release.version;
      if (adapter.buildUrl)
        fallback = () => {
          void adapter.buildUrl?.(v, build).then((url) => {
            if (url && typeof window !== "undefined")
              window.open(url, "_blank", "noopener,noreferrer");
          });
        };
      break;
    }
    case "store": {
      label = c.updateStoreLabel;
      const url = decision.listingUrl;
      if (url)
        fallback = () => {
          if (typeof window !== "undefined")
            window.open(url, "_blank", "noopener,noreferrer");
        };
      break;
    }
    case "platform":
      body = withVersion(c.updatePlatformBody);
      if (adapter.mode === "browser")
        fallback = () => {
          if (typeof window !== "undefined") window.location.reload();
        };
      break;
    case "blocked":
      title = c.updateBlockedTitle;
      body = c.updateBlockedBody;
      break;
  }
  if (mandatory) body = withVersion(c.updateMandatoryBody);
  const act = onAction ? () => onAction(ctx) : fallback;

  if (!locked && variant === "dialog") {
    return (
      <MessageScreen
        className={className}
        title={title}
        body={body}
        logo={theme.logo}
        {...(act ? { onRetry: act, retryLabel: label } : {})}
        extra={
          <div style={{ marginTop: "8px" }}>
            <Button
              variant="ghost"
              style={{ fontSize: "13px" }}
              onClick={dismiss}
              data-polaris-update-dismiss=""
            >
              {c.updateDismissLabel}
            </Button>
          </div>
        }
        data-polaris-update={decision.action}
      />
    );
  }

  // The banner. A decision the player cannot dismiss stays here too, as a persistent alert
  // with no dismiss control: it sits in the layout and never covers the running app.
  return (
    <div
      className={className}
      {...(locked
        ? { role: "alert", "data-polaris-update-mandatory": "" }
        : { role: "status", "aria-live": "polite" as const })}
      aria-label={title}
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
      data-polaris-update={decision.action}
    >
      <span>
        {title} — {body}
      </span>
      {act ? (
        <Button
          variant="secondary"
          style={{ padding: "6px 12px", fontSize: "13px" }}
          onClick={act}
          data-polaris-update-action=""
        >
          {label}
        </Button>
      ) : null}
      {locked ? null : (
        <Button
          variant="ghost"
          style={{ padding: "6px 12px", fontSize: "13px" }}
          onClick={dismiss}
          data-polaris-update-dismiss=""
        >
          {c.updateDismissLabel}
        </Button>
      )}
    </div>
  );
}
