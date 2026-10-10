// `<LicenseGate>` — the full-window drop-in gate. It renders `children` only when the
// license is usable (ok, grace, or NOT APPLICABLE); otherwise it renders the screen for the
// current status (loading / login / revoked / expired / version-block / error). Every screen is
// brandable via theme tokens + copy AND overridable via render-prop slots, so a product can
// keep the behavior while replacing any panel. The headless `useLicenseGate` powers it.
//
// `not-applicable` is the suite addition (D-08): a config-only or release-only product has no
// license to be missing, so the gate must get out of the way entirely rather than parking the
// app on a sign-in screen it can never satisfy.
//
// No screen dead-ends. Expired and revoked carry the sign-in methods under their title; a
// failure carries Try again (and "Replace a device" when the license is full); a version block
// offers the update when the product runs the Update service. Every string is catalog copy.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  useLicenseGate,
  type GateScreen,
  type UseLicenseGate,
} from "../react/hooks.js";
import { SPACE } from "@polaris-key/brand";
import { PolarisLogin, openManageUrl } from "./PolarisLogin.js";
import { HandoffHeader } from "./SignInHandoff.js";
import { Button } from "./primitives/buttons.js";
import { MessageScreen } from "./primitives/MessageScreen.js";
import {
  FullWindow,
  bannerStyle,
  dangerText,
  mutedText,
} from "./primitives/card.js";
import { REDUCED_MOTION, matches } from "./primitives/media.js";
import { screenLogo } from "./brand.js";
import { productLabel, type PolarisTheme } from "./theme.js";
import { formatCopy } from "./format.js";
import { openLink, safeLink } from "./links.js";
import { errorSentence, errorTitle, type ErrorLike } from "./errors.js";
import { activationTitle } from "../core/copy.js";
import { useLatestVersion } from "../update/useLatestVersion.js";

/** Render-prop slots — each receives the headless gate context so a product can fully
 *  replace any screen while keeping the gating logic. */
export interface LicenseGateSlots {
  loading?: (ctx: UseLicenseGate) => ReactNode;
  login?: (ctx: UseLicenseGate) => ReactNode;
  grace?: (ctx: UseLicenseGate) => ReactNode;
  revoked?: (ctx: UseLicenseGate) => ReactNode;
  expired?: (ctx: UseLicenseGate) => ReactNode;
  /** Covers version-too-old / version-too-new / channel-not-entitled. */
  versionBlock?: (ctx: UseLicenseGate) => ReactNode;
  error?: (ctx: UseLicenseGate) => ReactNode;
}

export interface LicenseGateProps {
  children?: ReactNode;
  /** Per-screen overrides. */
  slots?: LicenseGateSlots;
  /** In `grace`, render children under a banner that counts down to the end of grace (it has
   *  no dismiss control: the deadline stays in view) instead of blocking. */
  allowGrace?: boolean;
  className?: string;
  /** Passed to the "Replace a device" link (the sign-in card's, and the error screen's) as
   *  `return=` (PX-W8). */
  returnUrl?: string;
}

/** The product's name for copy that names it, or the theme's placeholder. */
function productOf(theme: PolarisTheme): string {
  return productLabel(theme);
}

function blockTitleBody(
  theme: PolarisTheme,
  status: string,
): { title: string; body: string } {
  switch (status) {
    case "version-too-new":
      return {
        title: theme.copy.versionTooNewTitle,
        body: theme.copy.versionTooNewBody,
      };
    case "channel-not-entitled":
      return {
        title: theme.copy.channelNotEntitledTitle,
        body: theme.copy.channelNotEntitledBody,
      };
    default:
      return {
        title: theme.copy.versionTooOldTitle,
        body: theme.copy.versionTooOldBody,
      };
  }
}

/** A Try again that shows its busy state and never lets the retry's rejection reach the page
 *  (the failure is the screen's to show, through the gate's state). */
function useRetry(
  retry: () => Promise<void>,
): [boolean, () => void, ErrorLike | null] {
  const [busy, setBusy] = useState(false);
  // What the last attempt failed with, until the next attempt starts.
  const [failure, setFailure] = useState<ErrorLike | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const run = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    void retry()
      .catch((e: unknown) => {
        if (alive.current)
          setFailure(
            e && typeof e === "object" ? (e as ErrorLike) : { code: "unknown" },
          );
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };
  return [busy, run, failure];
}

/**
 * Loading: nothing for the first 300 ms (a fast answer never flashes a screen), then the product
 * identity, "Checking your license…" in muted text and a 2 px indeterminate bar along the top
 * edge (still, under reduced motion).
 */
function LoadingScreen(props: { theme: PolarisTheme }): React.JSX.Element {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(id);
  }, []);
  return (
    <FullWindow data-polaris-loading="">
      {shown ? <LoadingCard theme={props.theme} /> : null}
    </FullWindow>
  );
}

function LoadingCard(props: { theme: PolarisTheme }): React.JSX.Element {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof el.animate !== "function" || matches(REDUCED_MOTION))
      return;
    const run = el.animate(
      [{ transform: "translateX(-100%)" }, { transform: "translateX(250%)" }],
      { duration: 1600, iterations: Infinity, easing: "ease-in-out" },
    );
    return () => run.cancel();
  }, []);
  const logo = screenLogo(props.theme, "4rem");
  return (
    <>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          insetInline: 0,
          top: 0,
          height: "2px",
          overflow: "hidden",
        }}
      >
        <span
          ref={bar}
          data-polaris-progress=""
          style={{
            display: "block",
            width: "40%",
            height: "100%",
            background: "var(--pk-accent)",
          }}
        />
      </span>
      <div
        role="status"
        aria-live="polite"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: SPACE["4"],
          margin: "auto",
          textAlign: "center",
        }}
      >
        {logo}
        <p style={mutedText}>{props.theme.copy.loadingLabel}</p>
      </div>
    </>
  );
}

/** The grace banner: days left to reconnect from `graceUntil`, neutral until 48 hours remain,
 *  then the warning callout with a status glyph. */
function GraceBanner(props: {
  theme: PolarisTheme;
  graceUntil: number | undefined;
}): React.JSX.Element {
  const { theme, graceUntil } = props;
  const c = theme.copy;
  let text = `${c.graceTitle} — ${c.graceBody}`;
  let warning = false;
  if (graceUntil !== undefined) {
    const left = graceUntil - Date.now() / 1000;
    warning = left <= 48 * 3600;
    text =
      left <= 24 * 3600
        ? formatCopy(c.graceLastDay, { product: productOf(theme) })
        : formatCopy(c.graceDaysLeft, { days: Math.ceil(left / 86400) });
  }
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={c.graceTitle}
      // The glyph stays beside the line, which wraps on its own.
      style={{
        ...bannerStyle(warning ? "warning" : "neutral"),
        flexWrap: "nowrap",
      }}
      data-polaris-grace={warning ? "warning" : "neutral"}
    >
      {warning ? (
        <svg
          aria-hidden="true"
          focusable="false"
          width="1rem"
          height="1rem"
          style={{ flex: "none" }}
          viewBox="0 0 16 16"
          fill="none"
          stroke="var(--pk-warning)"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M8 2.5 14 13H2L8 2.5Z" strokeLinejoin="round" />
          <path d="M8 6.5v3M8 11.5v.01" />
        </svg>
      ) : null}
      <span style={{ minWidth: 0 }}>{text}</span>
    </div>
  );
}

/** A version block. Too old, with the Update service on: "Get the update" first (the update
 *  prompt's action) and Try again second; otherwise Try again alone. */
function VersionBlock(props: { ctx: UseLicenseGate }): React.JSX.Element {
  const { ctx } = props;
  const { theme } = ctx;
  const { title, body } = blockTitleBody(theme, ctx.status);
  const latest = useLatestVersion();
  const [busy, retry] = useRetry(ctx.retry);
  const offerUpdate = ctx.status === "version-too-old" && latest.enabled;
  const update = (): void => {
    const url = safeLink(latest.latest?.url);
    if (url) openLink(url);
    else void latest.check().catch(() => undefined);
  };
  return offerUpdate ? (
    <MessageScreen
      title={title}
      body={body}
      logo={screenLogo(theme)}
      onRetry={update}
      retryLabel={theme.copy.updateActionLabel}
      secondaryAction={
        <Button
          variant="secondary"
          busy={busy}
          onClick={retry}
          data-polaris-gate-retry=""
        >
          {theme.copy.retryLabel}
        </Button>
      }
    />
  ) : (
    <MessageScreen
      title={title}
      body={body}
      logo={screenLogo(theme)}
      onRetry={retry}
      retryBusy={busy}
      retryLabel={theme.copy.retryLabel}
    />
  );
}

/**
 * The failure screen. Its title and sentence are the catalog's for the cause ("Can't connect"),
 * else "{product} couldn't start"; a retry that fails generically keeps the first cause's words.
 * A refusal that names the portal page leads with "Replace a device" beside Try again.
 */
function ErrorScreen(props: {
  ctx: UseLicenseGate;
  returnUrl?: string;
}): React.JSX.Element {
  const { ctx } = props;
  const { theme } = ctx;
  const [busy, retry] = useRetry(ctx.retry);
  // A generic refresh failure after a specific one keeps the specific words.
  const cause = useRef<ErrorLike | null>(null);
  const error = ctx.error;
  if (error && (error.code !== "refresh-failed" || !cause.current))
    cause.current = error;
  const shown = cause.current ?? error;

  const manageUrl = error?.manageUrl;
  if (manageUrl && error) {
    const a = error.activation;
    const counts =
      a?.deviceCount !== undefined && a.limit !== undefined
        ? { used: a.deviceCount, limit: a.limit }
        : null;
    const title = counts
      ? formatCopy(theme.copy.deviceLimitHeading, counts)
      : a
        ? activationTitle(a.kind)
        : (errorTitle(error) ??
          formatCopy(theme.copy.errorTitle, {
            product: productOf(theme),
          }));
    return (
      <MessageScreen
        title={title}
        body={formatCopy(theme.copy.deviceLimitBrowser, {
          product: productOf(theme),
        })}
        logo={screenLogo(theme)}
        onRetry={() => {
          openManageUrl(manageUrl, {
            ...(props.returnUrl ? { returnUrl: props.returnUrl } : {}),
          });
        }}
        retryLabel={theme.copy.freeDeviceLabel}
        secondaryAction={
          <Button
            variant="secondary"
            busy={busy}
            onClick={retry}
            data-polaris-gate-retry=""
          >
            {theme.copy.retryLabel}
          </Button>
        }
      />
    );
  }
  return (
    <MessageScreen
      title={
        errorTitle(shown) ??
        formatCopy(theme.copy.errorTitle, { product: productOf(theme) })
      }
      body={errorSentence(shown)}
      logo={screenLogo(theme)}
      onRetry={retry}
      retryBusy={busy}
      retryLabel={theme.copy.retryLabel}
    />
  );
}

/**
 * Revoked and expired: one title, then every way out. The sign-in methods are the action (Sign in
 * first and filled, then "Use a different key"), docked at the bottom on a phone exactly as on
 * the sign-in screen, and Try again re-reads the state for a licence that was restored since.
 */
function StatusScreen(props: {
  ctx: UseLicenseGate;
  revoked: boolean;
  returnUrl?: string;
}): React.JSX.Element {
  const { ctx, revoked } = props;
  const { theme } = ctx;
  const [busy, retry, failure] = useRetry(ctx.retry);
  // While a sign-in's hand-off is up the screen yields to it: its title, and no second button
  // that reads like Cancel (Try again returns with the methods).
  const [handoff, setHandoff] = useState<
    "waiting" | "expired" | "unavailable" | null
  >(null);
  // The head's slot for the code: it sits with the title, and only the buttons dock (DL1).
  const [codeSlot, setCodeSlot] = useState<HTMLElement | null>(null);
  const live = handoff === "waiting" || handoff === "expired";
  const failureId = useId();
  const title = live
    ? handoff === "expired"
      ? theme.copy.handoffExpiredTitle
      : theme.copy.handoffTitle
    : revoked
      ? theme.copy.revokedTitle
      : theme.copy.expiredTitle;
  return (
    <MessageScreen
      title={title}
      body={
        live ? "" : revoked ? theme.copy.revokedBody : theme.copy.expiredBody
      }
      logo={live ? <HandoffHeader theme={theme} /> : screenLogo(theme)}
      headExtra={
        live ? (
          <div
            ref={setCodeSlot}
            style={{ display: "contents" }}
            data-polaris-code-slot=""
          />
        ) : null
      }
      extra={
        <PolarisLogin
          heading={false}
          bare
          differentKey
          onHandoff={setHandoff}
          codeSlot={codeSlot}
          {...(props.returnUrl ? { returnUrl: props.returnUrl } : {})}
        />
      }
      {...(live
        ? {}
        : {
            onRetry: retry,
            retryBusy: busy,
            retryLabel: theme.copy.retryLabel,
            retryVariant: "quiet" as const,
            retryDescribedBy: failure ? failureId : undefined,
          })}
      notice={
        failure && !live ? (
          <p
            id={failureId}
            role="alert"
            style={dangerText}
            data-polaris-gate-retry-error=""
          >
            {errorSentence(failure)}
          </p>
        ) : null
      }
    />
  );
}

export function LicenseGate(props: LicenseGateProps): React.JSX.Element {
  const ctx = useLicenseGate();
  const { theme } = ctx;
  const slots = props.slots ?? {};

  // Usable → render the app. `not-applicable` joins `ok` here: the product runs no license
  // service, so there is nothing to gate and no chrome to wrap the children in.
  if (ctx.screen === "ok" || ctx.screen === "not-applicable") {
    return <>{props.children}</>;
  }
  // Grace (when allowed) → the app, under a banner counting down to the end of grace.
  if (ctx.screen === "grace" && props.allowGrace !== false) {
    return (
      <div className={props.className} data-polaris-gate="grace">
        {slots.grace ? (
          <>{slots.grace(ctx)}</>
        ) : (
          <GraceBanner theme={theme} graceUntil={ctx.gate.graceUntil} />
        )}
        {props.children}
      </div>
    );
  }

  const returnUrl = props.returnUrl ? { returnUrl: props.returnUrl } : {};
  const screen: GateScreen = ctx.screen;
  let content: ReactNode;
  switch (screen) {
    case "loading":
      content = slots.loading ? (
        slots.loading(ctx)
      ) : (
        <LoadingScreen theme={theme} />
      );
      break;
    case "grace": // allowGrace === false → block like a soft-expired screen.
    case "login":
      content = slots.login ? (
        slots.login(ctx)
      ) : (
        // The login card owns its focus (the first method) and is the accessible-named dialog
        // here. A refused key or sign-in stays on this card (see `screenFor`).
        <FullWindow
          modal
          data-polaris-gate="login"
          role="alertdialog"
          aria-modal
          aria-label={theme.copy.signInTitle}
        >
          <PolarisLogin {...returnUrl} />
        </FullWindow>
      );
      break;
    case "revoked":
    case "expired": {
      const revoked = screen === "revoked";
      const slot = revoked ? slots.revoked : slots.expired;
      content = slot ? (
        slot(ctx)
      ) : (
        <StatusScreen ctx={ctx} revoked={revoked} {...returnUrl} />
      );
      break;
    }
    case "version-block":
      content = slots.versionBlock ? (
        slots.versionBlock(ctx)
      ) : (
        <VersionBlock ctx={ctx} />
      );
      break;
    case "error":
    default:
      content = slots.error ? (
        slots.error(ctx)
      ) : (
        <ErrorScreen ctx={ctx} {...returnUrl} />
      );
      break;
  }

  // The root carries `aria-live="polite"` so a state transition (e.g. loading → revoked,
  // or an error appearing) is announced to assistive tech without stealing focus.
  return (
    <div
      className={props.className}
      data-polaris-gate={screen}
      aria-live="polite"
    >
      {content}
    </div>
  );
}
