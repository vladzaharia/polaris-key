import * as React from "react";
import { CircleCheck } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { AUTH_LINK_CLASS, AuthTitle } from "../../../ui/auth/index.js";
import { cn } from "../../../lib/cn.js";
import { t } from "../../../lib/copy.js";
import { PRIMARY_CLASS } from "./requestParts.js";

/** Seconds before the card hands the person back to the native app by itself. */
export const RETURN_SECONDS = 3;

/**
 * ReturnStep, native passthrough (SIGN-IN.md §3.10): "<Product> is yours" when a license was
 * added or issued now, otherwise "You're signed in to <App>"; **Return to <App>**, and a timer
 * that returns by itself after three seconds. The timer pauses while focus is inside the card and
 * **Stay here** stops it (WCAG 2.2.1); a stopped timer never restarts.
 */
export function ReturnStep({
  app,
  product,
  yours,
  tier = null,
  onReturn,
}: {
  app: string;
  product: string;
  /** A license was added or issued by this sign-in: the one celebration. */
  yours: boolean;
  /** The new license's tier, for the product row under "<Product> is yours". */
  tier?: string | null;
  onReturn: () => void;
}): React.ReactElement {
  // The timer is the phone's (§3.10): on a desktop window the person returns when ready.
  const [stopped, setStopped] = React.useState(
    () => window.matchMedia?.("(min-width: 40rem)").matches === true,
  );
  const timerShown = !stopped;
  const [inside, setInside] = React.useState(false);
  const fired = React.useRef(false);
  // The countdown is a budget and the moment it last started running, read against the clock, not
  // a count of timer ticks: a late tick cannot make it drift, and a pinned clock holds it still.
  const [timer, setTimer] = React.useState<{
    budget: number;
    since: number | null;
  }>(() => ({
    budget: RETURN_SECONDS * 1000,
    since: stopped ? null : Date.now(),
  }));
  const [now, setNow] = React.useState(() => Date.now());
  const running = !stopped && !inside && !fired.current;
  const left = Math.max(
    0,
    Math.ceil(
      (timer.since === null
        ? timer.budget
        : timer.budget - (now - timer.since)) / 1000,
    ),
  );

  React.useEffect(() => {
    const at = Date.now();
    setNow(at);
    setTimer((t) =>
      running
        ? t.since === null
          ? { budget: t.budget, since: at }
          : t
        : t.since === null
          ? t
          : { budget: Math.max(0, t.budget - (at - t.since)), since: null },
    );
  }, [running]);

  React.useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  React.useEffect(() => {
    if (left > 0 || stopped || fired.current) return;
    fired.current = true;
    onReturn();
  }, [left, stopped, onReturn]);

  const timing = !stopped && !inside && left > 0;
  return (
    <div
      className="space-y-6"
      onFocus={(e) => {
        // The card moves focus to the h1 on arrival; that is not the person acting.
        if (e.target.tagName !== "H1") setInside(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setInside(false);
      }}
    >
      <div className="space-y-2">
        {yours ? (
          <CircleCheck aria-hidden className="size-8 text-fg-strong" />
        ) : null}
        <AuthTitle>
          {yours
            ? t("signin.return.yours", { product })
            : t("signin.return.signedIn", { app })}
        </AuthTitle>
        {yours && tier ? (
          <p className="text-fg-muted">
            {t("signin.return.product", { tier })}
          </p>
        ) : null}
      </div>
      <Button
        variant="neutral"
        size="xl"
        className={PRIMARY_CLASS}
        onClick={() => {
          fired.current = true;
          onReturn();
        }}
      >
        {t("signin.return.button", { app })}
      </Button>
      <div className="space-y-1 text-center text-sm/5 text-fg-muted">
        {timerShown ? (
          <p>
            <span role="timer" aria-live="off">
              {t("signin.return.timer", { s: Math.max(left, 0) })}
            </span>
            {" · "}
            <button
              type="button"
              onClick={() => setStopped(true)}
              className={AUTH_LINK_CLASS}
            >
              {t("signin.return.stay")}
            </button>
          </p>
        ) : null}
        {!yours || stopped || !timing ? (
          <p>
            <a href="/" className={AUTH_LINK_CLASS}>
              {t("signin.return.library")}
            </a>
          </p>
        ) : null}
      </div>
    </div>
  );
}
