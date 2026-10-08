// `<LicenseGate>` — the full-window drop-in gate. It renders `children` only when the
// license is usable (ok, grace, or NOT APPLICABLE); otherwise it renders the screen for the
// current status (loading / login / revoked / expired / version-block / error). Every screen is
// brandable via theme tokens + copy AND overridable via render-prop slots, so a product can
// keep the behavior while replacing any panel. The headless `useLicenseGate` powers it.
//
// `not-applicable` is the suite addition (D-08): a config-only or release-only product has no
// license to be missing, so the gate must get out of the way entirely rather than parking the
// app on a sign-in screen it can never satisfy.

import type { ReactNode } from "react";
import {
  useLicenseGate,
  type GateScreen,
  type UseLicenseGate,
} from "../react/hooks.js";
import { SPACE } from "@polaris-key/brand";
import { PolarisLogin, openManageUrl } from "./PolarisLogin.js";
import { Button } from "./primitives/buttons.js";
import { MessageScreen } from "./primitives/MessageScreen.js";
import { FullWindow, bannerStyle } from "./primitives/card.js";
import { screenLogo } from "./brand.js";
import { copyTitle, describeError } from "../core/copy.js";
import type { PolarisTheme } from "./theme.js";

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
  /** When in `grace`, render children behind a dismissible banner instead of blocking. */
  allowGrace?: boolean;
  className?: string;
  /** Passed to the "Replace a device" link (the sign-in card's, and the error screen's) as
   *  `return=` (PX-W8). */
  returnUrl?: string;
}

/** Surface a clearer, remediation-oriented message for the error screen, keyed off the
 *  adapter's stable `PolarisError.code` when present (falls back to the raw message). */
function describeGateError(error: UseLicenseGate["error"]): string {
  if (!error) return "Unable to verify your license.";
  switch (error.code) {
    case "network":
      return "We couldn't reach the licensing service. Check your connection and try again.";
    case "bridge-missing":
      return "The licensing service isn't available in this app. Please reinstall or contact support.";
    case "refresh-failed":
      return "We couldn't refresh your license. Try again in a moment.";
    case "sign-in-failed":
      // The adapter already humanizes device-limit / unauthorized into this message.
      return error.message || "Sign-in failed. Please try again.";
    default:
      return error.message || "Unable to verify your license.";
  }
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

export function LicenseGate(props: LicenseGateProps): JSX.Element {
  const ctx = useLicenseGate();
  const { theme } = ctx;
  const slots = props.slots ?? {};

  // Usable → render the app. `not-applicable` joins `ok` here: the product runs no license
  // service, so there is nothing to gate and no chrome to wrap the children in.
  if (ctx.screen === "ok" || ctx.screen === "not-applicable") {
    return <>{props.children}</>;
  }
  // Grace (when allowed) → the app, behind a non-blocking banner.
  if (ctx.screen === "grace" && props.allowGrace !== false) {
    return (
      <div className={props.className} data-polaris-gate="grace">
        {slots.grace ? (
          <>{slots.grace(ctx)}</>
        ) : (
          <div
            role="status"
            aria-live="polite"
            aria-label={theme.copy.graceTitle}
            style={bannerStyle()}
          >
            {theme.copy.graceTitle} — {theme.copy.graceBody}
          </div>
        )}
        {props.children}
      </div>
    );
  }

  const screen: GateScreen = ctx.screen;
  let content: ReactNode;
  switch (screen) {
    case "loading":
      content = slots.loading ? (
        slots.loading(ctx)
      ) : (
        // Loading is transient + non-actionable → polite `role="status"`, no focus steal.
        <MessageScreen title={theme.copy.loadingLabel} transient />
      );
      break;
    case "grace": // allowGrace === false → block like a soft-expired screen.
    case "login":
      content = slots.login ? (
        slots.login(ctx)
      ) : (
        // The login card owns its own focus (auto-focuses the OIDC button) and is the
        // accessible-named dialog here. A refused key or sign-in stays on this card (see
        // `screenFor`): the error shows under the field the person just used, with "Replace a
        // device" when the refusal was the device limit.
        <FullWindow
          data-polaris-gate="login"
          role="alertdialog"
          aria-modal
          aria-label={theme.copy.signInTitle}
        >
          <PolarisLogin
            {...(props.returnUrl ? { returnUrl: props.returnUrl } : {})}
          />
        </FullWindow>
      );
      break;
    case "revoked":
      content = slots.revoked ? (
        slots.revoked(ctx)
      ) : (
        <MessageScreen
          title={theme.copy.revokedTitle}
          body={theme.copy.revokedBody}
          logo={screenLogo(theme)}
        />
      );
      break;
    case "expired":
      content = slots.expired ? (
        slots.expired(ctx)
      ) : (
        <MessageScreen
          title={theme.copy.expiredTitle}
          body={theme.copy.expiredBody}
          logo={screenLogo(theme)}
          // The dialog manages focus → don't let the embedded login card steal it.
          extra={
            <div style={{ marginTop: SPACE["6"] }}>
              <PolarisLogin
                autoFocus={false}
                logo={null}
                bare
                {...(props.returnUrl ? { returnUrl: props.returnUrl } : {})}
              />
            </div>
          }
        />
      );
      break;
    case "version-block": {
      const { title, body } = blockTitleBody(theme, ctx.status);
      const range = ctx.gate.allowedRange;
      content = slots.versionBlock ? (
        slots.versionBlock(ctx)
      ) : (
        <MessageScreen
          title={title}
          body={
            range?.min || range?.max
              ? `${body} (allowed: ${range?.min ?? "*"} – ${range?.max ?? "*"})`
              : body
          }
          logo={screenLogo(theme)}
          onRetry={() => void ctx.retry()}
          retryLabel={theme.copy.retryLabel}
        />
      );
      break;
    }
    case "error":
    default: {
      // PX-W8: a refusal that names the portal page freeing a seat gets "Replace a device" as
      // the screen's main action, beside Try again, so a full device limit never dead-ends.
      const manageUrl = ctx.error?.manageUrl;
      content = slots.error ? (
        slots.error(ctx)
      ) : manageUrl && ctx.error ? (
        // The copy catalog's title and sentence for the refusal ("Device limit reached").
        <MessageScreen
          title={copyTitle(ctx.error.wireCode ?? ctx.error.code)}
          body={describeError(ctx.error)}
          logo={screenLogo(theme)}
          onRetry={() => {
            openManageUrl(manageUrl, {
              ...(props.returnUrl ? { returnUrl: props.returnUrl } : {}),
            });
          }}
          retryLabel={theme.copy.freeDeviceLabel}
          retryVariant="primary"
          secondaryAction={
            <Button
              variant="secondary"
              label={theme.copy.retryLabel}
              onClick={() => void ctx.retry()}
              data-polaris-gate-retry=""
            >
              {theme.copy.retryLabel}
            </Button>
          }
        />
      ) : (
        <MessageScreen
          title="Something went wrong"
          body={describeGateError(ctx.error)}
          logo={screenLogo(theme)}
          onRetry={() => void ctx.retry()}
          retryLabel={theme.copy.retryLabel}
        />
      );
      break;
    }
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
