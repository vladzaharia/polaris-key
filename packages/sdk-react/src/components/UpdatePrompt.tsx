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
//                                variant. Floors never stop play, so a content floor is such
//                                a banner too. A CI revocation of REQUIRED content can stop
//                                play (plans/P4-13.md §2.6, decision 4): boot `required`
//                                renders a full-window hard stop with the revoked-content
//                                copy, with the offer's button when the answer is an offer
//                                and none for `blocked`. `packs` is applied by the boot's
//                                fetch and renders nothing, like `none`.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import { SPACE } from "@polaris-key/brand";
import { Button } from "./primitives/buttons.js";
import { MessageScreen } from "./primitives/MessageScreen.js";
import { bannerStyle } from "./primitives/card.js";
import { screenLogo } from "./brand.js";
import { knownProductName, type PolarisTheme } from "./theme.js";
import { formatCopy } from "./format.js";
import { openLink, safeLink } from "./links.js";
import type { ErrorLike } from "./errors.js";

/** "{product} {version}" once the product's name and the version are known (update.title),
 *  else "An update is available" (update.availableTitle). */
function updateTitleFor(theme: PolarisTheme, version: string | null): string {
  const product = knownProductName(theme);
  return product && version
    ? formatCopy(theme.copy.updateProductTitle, { product, version })
    : theme.copy.updateTitle;
}

/**
 * The banner: the title (and a line, when there is one) on the start side, the action and
 * Later on the end, on one line from about 40rem of width and wrapping below it. A notice the
 * player cannot dismiss is the warning callout, an alert with no Later.
 */
function UpdateBanner(props: {
  className?: string;
  title: string;
  body?: string;
  locked?: boolean;
  actionLabel?: string;
  onAction?: (() => void) | null;
  dismissLabel: string;
  onDismiss: () => void;
  marker: string;
  /** Put focus on the action when the banner appears (after a Try again that found an update). */
  focusAction?: boolean;
}): React.JSX.Element {
  const { locked } = props;
  const action = useRef<HTMLButtonElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The action, or, when its link failed the safety check and there is none, Later, or the
    // banner itself: focus never falls to the page.
    if (props.focusAction)
      (action.current ?? dismiss.current ?? root.current)?.focus();
    // Once, when it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={root}
      tabIndex={-1}
      className={props.className}
      {...(locked
        ? { role: "alert", "data-polaris-update-mandatory": "" }
        : { role: "status", "aria-live": "polite" as const })}
      aria-label={props.title}
      style={{
        ...bannerStyle(locked ? "warning" : "neutral"),
        justifyContent: "flex-start",
        textAlign: "start",
        outline: "none",
      }}
      data-polaris-update={props.marker}
    >
      <span style={{ flex: "1 1 24rem", minWidth: 0 }}>
        <strong
          style={{
            fontWeight: 500,
            color: "var(--pk-text-strong, var(--pk-text))",
          }}
        >
          {props.title}
        </strong>
        {props.body ? <> {props.body}</> : null}
      </span>
      <span style={{ display: "flex", flexWrap: "wrap", gap: SPACE["2"] }}>
        {props.onAction ? (
          <Button
            ref={action}
            variant="primary"
            size="compact"
            onClick={props.onAction}
            data-polaris-update-action=""
          >
            {props.actionLabel}
          </Button>
        ) : null}
        {locked ? null : (
          <Button
            ref={dismiss}
            variant="secondary"
            size="compact"
            onClick={props.onDismiss}
            data-polaris-update-dismiss=""
          >
            {props.dismissLabel}
          </Button>
        )}
      </span>
    </div>
  );
}

/** The "You're up to date." line, and the line a failed check leaves: the banner's strip, so the
 *  words sit on the kit's own surface and not on the host page's ground. */
const currentLine: CSSProperties = {
  ...bannerStyle("neutral"),
  justifyContent: "flex-start",
  textAlign: "start",
};

/** "You're up to date.": the status line. It takes focus when it replaces a failure the person
 *  just retried, so the button they pressed does not take focus with it. */
function CurrentLine(props: {
  className?: string;
  text: string;
  focusOnMount: boolean;
}): React.JSX.Element {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.focusOnMount) line.current?.focus();
    // Once, when it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={line}
      tabIndex={-1}
      className={props.className}
      role="status"
      aria-live="polite"
      style={{ ...currentLine, outline: "none" }}
      data-polaris-update="current"
    >
      {props.text}
    </div>
  );
}

/** What a failed check leaves: that the check failed, why when it can say (without naming the
 *  vendor), and Try again, which is withheld when nothing a retry does could change the answer
 *  (the product publishes no updates). */
function FailedLine(props: {
  className?: string;
  theme: PolarisTheme;
  error: ErrorLike;
  busy: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  const { theme, error } = props;
  const c = theme.copy;
  const unavailable = error.code === "not_found";
  const cause =
    error.code === "network-error"
      ? c.updateCheckOffline
      : unavailable
        ? c.updateCheckUnavailable
        : "";
  return (
    <div
      className={props.className}
      role="status"
      aria-live="polite"
      style={currentLine}
      data-polaris-update="failed"
    >
      <span style={{ flex: "1 1 auto", minWidth: 0 }}>
        {c.updateCheckFailed}
        {cause ? ` ${cause}` : ""}
      </span>
      {unavailable ? null : (
        <Button
          variant="secondary"
          size="compact"
          busy={props.busy}
          onClick={props.onRetry}
          data-polaris-update-retry=""
        >
          {c.retryLabel}
        </Button>
      )}
    </div>
  );
}

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

export function UpdatePrompt(
  props: UpdatePromptProps,
): React.JSX.Element | null {
  const { source = "version", ...rest } = props;
  return source === "decision" ? (
    <DecisionPrompt {...rest} />
  ) : (
    <VersionPrompt {...rest} />
  );
}

function VersionPrompt(
  props: Omit<UpdatePromptProps, "source">,
): React.JSX.Element | null {
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
  // A Try again was pressed: where it lands, focus follows (DL9).
  const [retried, setRetried] = useState(false);

  if (!check.enabled || dismissed) return null;
  if (!check.updateAvailable && !showWhenCurrent) return null;

  const dismiss = (): void => setDismissed(true);

  if (slots?.prompt) return <>{slots.prompt({ ...check, dismiss })}</>;

  if (!check.updateAvailable) {
    // "Up to date" is an answer, not an absence: a check that failed, or has not answered yet,
    // never says it.
    if (check.error)
      return (
        <FailedLine
          className={className}
          theme={theme}
          error={check.error as ErrorLike}
          busy={check.busy}
          onRetry={() => {
            setRetried(true);
            void check.check();
          }}
        />
      );
    if (!check.latest) return null;
    return (
      <CurrentLine
        className={className}
        text={theme.copy.updateUpToDateLabel}
        focusOnMount={retried}
      />
    );
  }

  // A link is shown and opened only when it is https (DL14); a build the feed pointed at with
  // anything else has no action.
  const link = safeLink(check.latest?.url);
  const act: (() => void) | null = onUpdate
    ? () => onUpdate(check)
    : link
      ? () => openLink(link)
      : null;

  const title = updateTitleFor(theme, check.latest?.version ?? null);
  const body = theme.copy.updateBody;

  if (variant === "dialog") {
    // A dismissible dialog: a card over a scrim, the app visible behind it; a bottom sheet on
    // a phone; Escape is Later, and focus goes back where it was when it closes.
    return (
      <MessageScreen
        className={className}
        title={title}
        body={body}
        logo={screenLogo(theme, "3.5rem")}
        {...(act
          ? { onRetry: act, retryLabel: theme.copy.updateActionLabel }
          : {})}
        scrim={theme.scheme ?? "dark"}
        onDismiss={dismiss}
        secondaryAction={
          <Button
            variant="secondary"
            onClick={dismiss}
            data-polaris-update-dismiss=""
          >
            {theme.copy.updateDismissLabel}
          </Button>
        }
        data-polaris-update="dialog"
      />
    );
  }

  return (
    <UpdateBanner
      className={className}
      title={title}
      body={body}
      actionLabel={theme.copy.updateActionLabel}
      onAction={act}
      dismissLabel={theme.copy.updateDismissLabel}
      onDismiss={dismiss}
      marker="banner"
      focusAction={retried}
    />
  );
}

function DecisionPrompt(
  props: Omit<UpdatePromptProps, "source">,
): React.JSX.Element | null {
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

  // `packs` is applied silently by the boot's fetch.
  if (decision.action === "packs") return null;

  if (decision.action === "none") {
    if (!showWhenCurrent || decision.reason !== "up-to-date") return null;
    return (
      <div
        className={className}
        role="status"
        aria-live="polite"
        style={currentLine}
        data-polaris-update="current"
      >
        {theme.copy.updateUpToDateLabel}
      </div>
    );
  }

  const c = theme.copy;
  const version =
    decision.action === "blocked" ? null : decision.release.version;
  const mandatory =
    decision.action !== "code-ready" &&
    decision.action !== "blocked" &&
    decision.mandatory;

  let title = updateTitleFor(theme, version);
  let body = c.updateBody;
  let label = c.updateActionLabel;
  let fallback: (() => void) | null = null;
  switch (decision.action) {
    case "code-ready": {
      const product = knownProductName(theme);
      title =
        product && version
          ? formatCopy(c.updateReadyProductTitle, { product, version })
          : c.updateReadyTitle;
      body = c.updateReadyBody;
      label = c.updateRestartLabel;
      break;
    }
    case "binary": {
      const build = decision.build;
      const v = decision.release.version;
      if (adapter.buildUrl)
        fallback = () => {
          void adapter.buildUrl?.(v, build).then((url) => {
            const link = safeLink(url);
            if (link) openLink(link);
          });
        };
      break;
    }
    case "store": {
      label = c.updateStoreLabel;
      const url = safeLink(decision.listingUrl);
      if (url) fallback = () => openLink(url);
      break;
    }
    case "platform":
      body = c.updatePlatformBody;
      if (adapter.mode === "browser")
        fallback = () => {
          if (typeof window !== "undefined") window.location.reload();
        };
      break;
    case "blocked":
      title = c.updateBlockedTitle;
      body =
        decision.reason === "content-floor"
          ? c.updateContentFloorBody
          : c.updateBlockedBody;
      break;
  }
  if (mandatory)
    body =
      ctx.reason === "content-floor"
        ? c.updateContentFloorBody
        : c.updateMandatoryBody;
  const act = onAction ? () => onAction(ctx) : fallback;

  // Revoked required content stops the boot (boot `required`): a full-window hard stop with no
  // dismiss control, the offer's button when there is an offer and none for `blocked`.
  if (ctx.boot === "required") {
    const offer = decision.action !== "blocked" && act !== null;
    return (
      <MessageScreen
        className={className}
        title={c.updateRevokedContentTitle}
        body={c.updateRevokedContentBody}
        logo={screenLogo(theme)}
        {...(offer ? { onRetry: act, retryLabel: label } : {})}
        data-polaris-update={decision.action}
        data-polaris-update-required=""
      />
    );
  }

  if (!locked && variant === "dialog") {
    return (
      <MessageScreen
        className={className}
        title={title}
        body={body}
        logo={screenLogo(theme, "3.5rem")}
        {...(act ? { onRetry: act, retryLabel: label } : {})}
        scrim={theme.scheme ?? "dark"}
        onDismiss={dismiss}
        secondaryAction={
          <Button
            variant="secondary"
            onClick={dismiss}
            data-polaris-update-dismiss=""
          >
            {c.updateDismissLabel}
          </Button>
        }
        data-polaris-update={decision.action}
      />
    );
  }

  // The banner. A decision the player cannot dismiss stays here too, as a persistent alert
  // with no dismiss control: it sits in the layout and never covers the running app.
  return (
    <UpdateBanner
      className={className}
      title={title}
      body={body}
      locked={locked}
      actionLabel={label}
      onAction={act}
      dismissLabel={c.updateDismissLabel}
      onDismiss={dismiss}
      marker={decision.action}
    />
  );
}
