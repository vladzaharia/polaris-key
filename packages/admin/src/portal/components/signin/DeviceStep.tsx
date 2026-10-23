import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../ui/Button.js";
import { Spinner } from "../../../ui/Spinner.js";
import { AuthNotice, AuthTitle, useStepFocus } from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import {
  portalApi,
  PortalApiError,
  type PortalDeviceLoginStart,
} from "../../api.js";
import { portalErrorCopy } from "../../errors.js";
import { announceSignedIn } from "../../session.js";
import { qk } from "../../queries.js";
import { mutate } from "../../mutations.js";

/**
 * Sign in with another device (SIGN-IN.md §3.11; PX-W14's wire): this browser shows a QR and an
 * 8-character code, "Works for m:ss", and polls until a signed-in device approves or denies it.
 * Approved: the poll sets the session and the portal opens where the person was going. Denied and
 * expired replace the waiting line, each with its way on. The code's time left is announced once,
 * at one minute (WCAG 2.2.1). Nothing here loops after a failure.
 */
type State =
  | { kind: "starting" }
  | { kind: "waiting"; start: PortalDeviceLoginStart; endsAt: number }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "disabled" }
  | { kind: "error"; error: unknown };

function mmss(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function DeviceStep({
  onOther,
}: {
  /** Back to the methods: "Use another way to sign in". */
  onOther: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const [state, setState] = React.useState<State>({ kind: "starting" });
  const [round, setRound] = React.useState(0);
  const [left, setLeft] = React.useState(0);
  const [announce, setAnnounce] = React.useState("");

  // One request per round: start, then poll until it is decided or runs out.
  React.useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    setState({ kind: "starting" });
    setAnnounce("");
    const poll = (start: PortalDeviceLoginStart, endsAt: number): void => {
      timer = window.setTimeout(
        async () => {
          if (!alive) return;
          try {
            const out = await portalApi.deviceLoginPoll(start.id);
            if (!alive) return;
            if (out.status === "approved") {
              announceSignedIn();
              await qc.invalidateQueries({ queryKey: qk.me() });
              return;
            }
            if (out.status === "denied") return setState({ kind: "denied" });
            if (Date.now() >= endsAt) return setState({ kind: "expired" });
            poll(start, endsAt);
          } catch (err) {
            if (!alive) return;
            if (err instanceof PortalApiError) {
              if (err.status === 410) return setState({ kind: "expired" });
              if (err.status === 403) return setState({ kind: "disabled" });
              // Slow down, never stop: a 429 is the network's, not the request's.
              if (err.status === 429) return poll(start, endsAt);
            }
            // A dropped connection: keep asking while the code lives.
            if (Date.now() < endsAt) return poll(start, endsAt);
            setState({ kind: "expired" });
          }
        },
        Math.max(1, start.interval) * 1000,
      );
    };
    void (async () => {
      try {
        const start = await mutate("deviceLoginStart");
        if (!alive) return;
        const endsAt = Date.now() + start.expiresIn * 1000;
        setState({ kind: "waiting", start, endsAt });
        setLeft(start.expiresIn);
        poll(start, endsAt);
      } catch (err) {
        if (alive) setState({ kind: "error", error: err });
      }
    })();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [round, qc]);

  // The countdown, and the one-minute announcement.
  React.useEffect(() => {
    if (state.kind !== "waiting") return;
    const tick = window.setInterval(() => {
      const s = Math.round((state.endsAt - Date.now()) / 1000);
      setLeft(s);
      if (s === 60) setAnnounce(t("signin.approve.minuteLeft"));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [state]);

  const again = (): void => setRound((n) => n + 1);
  // A restarted code or a decided request replaces the button that was pressed: focus the h1.
  const { ref, live } = useStepFocus(state.kind);
  const asking = state.kind === "starting" || state.kind === "waiting";

  return (
    <div ref={ref} className="space-y-5">
      <div className="space-y-2">
        <AuthTitle>{t("signin.approve.title")}</AuthTitle>
        {asking ? (
          <p className="text-fg-muted">{t("signin.approve.lede")}</p>
        ) : null}
      </div>
      {state.kind === "starting" ? (
        <div
          aria-busy
          role="status"
          aria-label={t("signin.approve.starting")}
          className="flex flex-col items-center gap-4 sm:flex-row"
        >
          <div aria-hidden className="size-42 rounded-md bg-hover" />
          <div aria-hidden className="h-8 w-40 rounded-md bg-hover" />
        </div>
      ) : state.kind === "waiting" ? (
        <>
          <div className="flex flex-col items-center gap-4 sm:flex-row">
            <img
              src={state.start.qr}
              alt=""
              width={168}
              height={168}
              className="size-42 shrink-0 rounded-md bg-white p-2"
            />
            <div className="text-center sm:text-start">
              <p
                data-device-code
                className="font-mono text-3xl font-medium tracking-widest text-fg-strong"
              >
                {state.start.code}
              </p>
              <p className="text-sm text-fg-muted">
                {t("signin.approve.works", { time: mmss(left) })}
              </p>
            </div>
          </div>
          <div
            role="status"
            className="flex items-center gap-3 rounded-md border border-border-strong bg-hover px-4 py-3 text-sm text-fg"
          >
            <Spinner label="" className="text-fg-muted" />
            {t("signin.approve.waiting")}
          </div>
        </>
      ) : (
        <AuthNotice>
          {state.kind === "error"
            ? state.error instanceof PortalApiError &&
              (state.error.status === 429 ||
                state.error.code === "rate_limited")
              ? t("signin.rateLimitedFew")
              : portalErrorCopy(state.error, { account: true }).description
            : state.kind === "denied"
              ? t("signin.approve.denied")
              : state.kind === "disabled"
                ? t("signin.approve.disabled")
                : t("signin.approve.expired")}
        </AuthNotice>
      )}
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      {live}
      <div className="space-y-3">
        {state.kind === "expired" || state.kind === "error" ? (
          <Button
            variant="neutral"
            size="lg"
            className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
            onClick={again}
          >
            {state.kind === "error"
              ? t("signin.retry")
              : t("signInHandoff.newCode")}
          </Button>
        ) : null}
        <Button
          variant={
            state.kind === "denied" || state.kind === "disabled"
              ? "neutral"
              : "ghost"
          }
          size="lg"
          className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
          onClick={onOther}
        >
          {t("signin.approve.other")}
        </Button>
      </div>
    </div>
  );
}
