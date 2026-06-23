// `<LicenseGate>` — the full-window drop-in gate. It renders `children` only when the
// license is usable (ok or grace); otherwise it renders the screen for the current status
// (loading / login / revoked / expired / version-block / error). Every screen is brandable
// via theme tokens + copy AND overridable via render-prop slots, so a product can keep the
// behavior while replacing any panel. The headless `useLicenseGate` powers it.

import { type CSSProperties, type ReactNode } from "react";
import { useLicenseGate, type GateScreen, type UseLicenseGate } from "../react/hooks.js";
import { PolarisLogin } from "./PolarisLogin.js";
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
}

const fullWindow: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "var(--pk-background)",
  color: "var(--pk-text)",
  fontFamily: "var(--pk-font-family)",
};

const messageCard: CSSProperties = {
  width: "min(420px, 100%)",
  padding: "28px",
  textAlign: "center",
  background: "var(--pk-surface)",
  border: "1px solid var(--pk-border)",
  borderRadius: "var(--pk-radius)",
};

const retryBtn: CSSProperties = {
  marginTop: "16px",
  appearance: "none",
  cursor: "pointer",
  border: "1px solid var(--pk-border)",
  padding: "10px 16px",
  borderRadius: "var(--pk-radius)",
  background: "transparent",
  color: "var(--pk-text)",
  fontSize: "14px",
};

function blockTitleBody(theme: PolarisTheme, status: string): { title: string; body: string } {
  switch (status) {
    case "version-too-new":
      return { title: theme.copy.versionTooNewTitle, body: theme.copy.versionTooNewBody };
    case "channel-not-entitled":
      return { title: theme.copy.channelNotEntitledTitle, body: theme.copy.channelNotEntitledBody };
    default:
      return { title: theme.copy.versionTooOldTitle, body: theme.copy.versionTooOldBody };
  }
}

function MessageScreen(props: {
  title: string;
  body: string;
  ctx: UseLicenseGate;
  showRetry?: boolean;
  extra?: ReactNode;
}): JSX.Element {
  const { theme } = props.ctx;
  return (
    <div style={fullWindow}>
      <div style={messageCard}>
        {theme.logo ? <div style={{ marginBottom: "12px" }}>{theme.logo}</div> : null}
        <h2 style={{ margin: "0 0 8px", fontSize: "20px" }}>{props.title}</h2>
        <p style={{ margin: 0, color: "var(--pk-text-muted)", fontSize: "14px" }}>{props.body}</p>
        {props.extra}
        {props.showRetry ? (
          <button type="button" style={retryBtn} onClick={() => void props.ctx.retry()}>
            {theme.copy.retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LicenseGate(props: LicenseGateProps): JSX.Element {
  const ctx = useLicenseGate();
  const { theme } = ctx;
  const slots = props.slots ?? {};

  // Usable (ok always; grace when allowed) → render the app, with a grace banner if applicable.
  if (ctx.screen === "ok") {
    return <>{props.children}</>;
  }
  if (ctx.screen === "grace" && props.allowGrace !== false) {
    return (
      <div className={props.className} data-polaris-gate="grace">
        {slots.grace ? (
          <>{slots.grace(ctx)}</>
        ) : (
          <div
            style={{
              padding: "8px 16px",
              background: "var(--pk-surface)",
              borderBottom: "1px solid var(--pk-border)",
              color: "var(--pk-text-muted)",
              fontFamily: "var(--pk-font-family)",
              fontSize: "13px",
            }}
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
        <MessageScreen title={theme.copy.loadingLabel} body="" ctx={ctx} />
      );
      break;
    case "grace": // allowGrace === false → block like a soft-expired screen.
    case "login":
      content = slots.login ? (
        slots.login(ctx)
      ) : (
        <div style={fullWindow} data-polaris-gate="login">
          <PolarisLogin />
        </div>
      );
      break;
    case "revoked":
      content = slots.revoked ? (
        slots.revoked(ctx)
      ) : (
        <MessageScreen title={theme.copy.revokedTitle} body={theme.copy.revokedBody} ctx={ctx} />
      );
      break;
    case "expired":
      content = slots.expired ? (
        slots.expired(ctx)
      ) : (
        <MessageScreen
          title={theme.copy.expiredTitle}
          body={theme.copy.expiredBody}
          ctx={ctx}
          extra={<div style={{ marginTop: "16px" }}><PolarisLogin /></div>}
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
          body={range?.min || range?.max ? `${body} (allowed: ${range?.min ?? "*"} – ${range?.max ?? "*"})` : body}
          ctx={ctx}
          showRetry
        />
      );
      break;
    }
    case "error":
    default:
      content = slots.error ? (
        slots.error(ctx)
      ) : (
        <MessageScreen
          title="Something went wrong"
          body={ctx.state.error?.message ?? "Unable to verify your license."}
          ctx={ctx}
          showRetry
        />
      );
      break;
  }

  return (
    <div className={props.className} data-polaris-gate={screen}>
      {content}
    </div>
  );
}
