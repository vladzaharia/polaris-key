import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Fingerprint, Mail, ShieldCheck } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { t, tParts } from "../../../lib/copy.js";
import { expiredCodeText, wrongCodeText } from "../../copy/codeEntry.js";
import {
  portalApi,
  HttpError,
  type PortalMethods,
  type PortalProvider,
} from "../../api.js";
import {
  capabilitiesOrNone,
  refreshSession,
  useCapabilities,
} from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import { PROVIDER_NAME, stepUpProviders } from "../../model/methods.js";
import {
  PasskeyError,
  passkeyAssertion,
  passkeysSupported,
} from "../../webauthn.js";
import { CODE_LENGTH, CodeCells } from "../../../ui/auth/CodeCells.js";
import { qk } from "../../queries.js";
import {
  mutate,
  refreshAfterAccountChange,
  refreshAfterStepUp,
} from "../../mutations.js";
import { markStepUpLeave } from "../../focus.js";

/**
 * "Confirm it's you first" (PORTAL.md §4.26; PX-W12's step-up rule): an account change needs a
 * sign-in from the last 5 minutes, so the person signs in again, here, with a method the account
 * already has. There is no separate assertion endpoint: confirming is signing in.
 *
 * - **A passkey** first, when the account has one and the browser can use it: "Use your passkey
 *   to disconnect". The browser is offered only this account's passkeys, so the sign-in cannot
 *   land on another account.
 * - **An email code** to one of the account's own email addresses otherwise (or as the other
 *   way): the code is typed here, in six cells. Not while the deploy has Turnstile on: the email
 *   start then wants a token this page has no widget for (PX-12 renders it on the login card), so
 *   the passkey or provider way shows instead, as it does after a `turnstile_failed`.
 * - **Sign in again with Apple, Google or Steam**, or single sign-on, for an account with neither:
 *   the page leaves for the provider and comes back to `returnTo`.
 *
 * A sign-in opens a new session for this browser (with a new CSRF token, which the page reads
 * at once); the one it replaced is ended, so Where you're signed in lists this browser once. A
 * provider sign-in leaves the page, so this code cannot end the old one: the Worker does, when the
 * provider's callback opens the new session for the same account (B-074, `card/finish.ts`).
 */
export interface StepUpProps {
  /** The verb the confirmation unlocks, in the passkey button: "Use your passkey to {verb}". */
  verb: string;
  view: PortalMethods;
  accountId: string;
  /** Where a provider sign-in returns to: an absolute URL on this origin. */
  returnTo: string;
  /** `danger` when what follows removes something (the panel's own primary). */
  tone?: "danger" | "primary";
  /** Focus the prompt as it appears: it replaced the control the person pressed. */
  autoFocus?: boolean;
  /**
   * A button that belongs beside the main action (Keep, Cancel), so the prompt is one action row
   * rather than the button on one line and its Cancel stranded on the next (B-068, B-073).
   */
  trailing?: React.ReactNode;
  onConfirmed: () => void;
}

type Way = "passkey" | "email";

/** The main action fills a phone's width and wraps rather than clipping its label. */
const MAIN_BUTTON =
  "h-auto min-h-11 w-full whitespace-normal py-2 text-center sm:w-auto";

/** One row for the main action and its sibling (Keep, Cancel); stacked on a phone. */
const ACTION_ROW =
  "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3";

export function StepUp({
  verb,
  view,
  accountId,
  returnTo,
  tone = "primary",
  autoFocus = false,
  trailing,
  onConfirmed,
}: StepUpProps): React.ReactElement {
  const qc = useQueryClient();
  const caps = capabilitiesOrNone(useCapabilities());
  const labelId = React.useId();
  const errorId = React.useId();
  const codeId = React.useId();
  const labelRef = React.useRef<HTMLParagraphElement>(null);
  const passkey = view.passkeys.length > 0 && passkeysSupported();
  /** The email start refused its security check: this prompt stops offering the email way. */
  const [turnstileFailed, setTurnstileFailed] = React.useState(false);
  const email =
    caps.auth.magic && !caps.turnstileSiteKey && !turnstileFailed
      ? (view.emails[0]?.email ?? null)
      : null;
  const providers = stepUpProviders(view);
  const sso = caps.auth.oidc && view.methods.some((m) => m.kind === "oidc");
  // The person's pick, else the first way this account has (the capabilities may still be on
  // their way as the prompt appears, so this follows them rather than freezing the first guess).
  const [picked, setWay] = React.useState<Way | null>(null);
  const way: Way | null =
    picked === "passkey" && passkey
      ? "passkey"
      : picked === "email" && email
        ? "email"
        : passkey
          ? "passkey"
          : email
            ? "email"
            : null;
  const [sent, setSent] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (autoFocus) labelRef.current?.focus({ preventScroll: true });
    // Once, as it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmed = async (replaced: string | null): Promise<void> => {
    await afterStepUp(qc, accountId, replaced);
    onConfirmed();
  };

  const withPasskey = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const replaced = await currentSessionId(qc);
      const { options } = await mutate("passkeySignInOptions");
      const response = await passkeyAssertion(
        options,
        view.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      );
      await mutate("passkeySignInVerify", response);
      await confirmed(replaced);
    } catch (err) {
      setError(passkeyErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async (): Promise<void> => {
    if (!email) return;
    setBusy(true);
    setError(null);
    try {
      // A code already went out: "Send a new code" is PX-W4's resend for this sign-in, which
      // retires the old code and link and asks for no new security check.
      if (sent) await mutate("resendSignInCode");
      else await mutate("startEmailSignIn", email);
      setSent(true);
      setCode("");
      requestAnimationFrame(() => document.getElementById(codeId)?.focus());
    } catch (err) {
      if (err instanceof HttpError && err.code === "turnstile_failed")
        setTurnstileFailed(true);
      // The sign-in itself expired: the next send starts a new one.
      if (err instanceof HttpError && err.code === "signin_expired")
        setSent(false);
      setError(sendErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string): Promise<void> => {
    if (value.length !== CODE_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      const replaced = await currentSessionId(qc);
      await mutate("verifySignInCode", value);
      await confirmed(replaced);
    } catch (err) {
      setError(codeErrorText(err));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const signInAgain = (path: string): string =>
    `${path}?return_to=${encodeURIComponent(returnTo)}`;
  const providerWays = (
    <SignInAgain
      key="again"
      providers={providers}
      sso={sso}
      hrefFor={(p) => signInAgain(p === "sso" ? "/login" : `/login/${p}`)}
    />
  );
  const otherWays: React.ReactNode[] = [];
  if (way === "passkey" && email)
    otherWays.push(
      <Button
        key="email"
        variant="link"
        className="text-sm font-medium max-sm:min-h-11"
        onClick={() => {
          setWay("email");
          setError(null);
        }}
      >
        {t("locker.stepUp.emailInstead")}
      </Button>,
    );
  if (way === "email" && passkey)
    otherWays.push(
      <Button
        key="passkey"
        variant="link"
        className="text-sm font-medium max-sm:min-h-11"
        onClick={() => {
          setWay("passkey");
          setSent(false);
          setError(null);
        }}
      >
        {t("locker.stepUp.passkeyInstead")}
      </Button>,
    );
  // The email way was refused its security check while a passkey remains the main way: the
  // providers this account has are offered under it too.
  if (turnstileFailed && way !== null && (providers.length > 0 || sso))
    otherWays.push(providerWays);

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-3">
      <p
        id={labelId}
        ref={labelRef}
        tabIndex={-1}
        className="flex items-center gap-2 text-sm font-medium text-fg-strong outline-none"
      >
        <ShieldCheck aria-hidden className="size-4 shrink-0" />
        {t("locker.stepUp.title")}
      </p>
      {way === "passkey" ? (
        <div className={ACTION_ROW}>
          {/* The visible label is the accessible name: it says what the passkey will do (B-064,
              B-068; WCAG 2.5.3). */}
          <Button
            variant={tone}
            loading={busy}
            iconStart={<Fingerprint aria-hidden />}
            className={MAIN_BUTTON}
            onClick={() => void withPasskey()}
            aria-describedby={error ? errorId : undefined}
          >
            {t("locker.stepUp.passkeyTo", { verb })}
          </Button>
          {trailing}
        </div>
      ) : way === "email" && email && !sent ? (
        <div className={ACTION_ROW}>
          <Button
            variant={tone}
            loading={busy}
            iconStart={<Mail aria-hidden />}
            className={MAIN_BUTTON}
            onClick={() => void sendCode()}
            aria-describedby={error ? errorId : undefined}
          >
            {t("locker.stepUp.emailTo", { email })}
          </Button>
          {trailing}
        </div>
      ) : way === "email" && email ? (
        <form
          noValidate
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
        >
          <p role="status" className="text-sm text-fg">
            {tParts("locker.stepUp.sent", ["email"]).map((part, i) =>
              typeof part === "string" ? (
                part
              ) : (
                <span key={i} className="font-medium text-fg-strong">
                  {email}
                </span>
              ),
            )}
          </p>
          <label
            htmlFor={codeId}
            className="text-sm font-medium text-fg-strong"
          >
            {t("signin.approve.codeLabel")}
          </label>
          <div className="max-w-xs">
            <CodeCells
              id={codeId}
              value={code}
              invalid={Boolean(error)}
              describedBy={error ? errorId : undefined}
              onChange={(v) => {
                setCode(v);
                if (error) setError(null);
                if (v.length === CODE_LENGTH) void verify(v);
              }}
            />
          </div>
          <div className={ACTION_ROW}>
            <Button
              type="submit"
              variant={tone}
              loading={busy}
              disabled={code.length !== CODE_LENGTH}
              className={MAIN_BUTTON}
              aria-label={t("locker.stepUp.confirmTo", { verb })}
            >
              {t("locker.stepUp.confirm")}
            </Button>
            {trailing}
            <Button
              variant="link"
              className="text-sm font-medium max-sm:min-h-11"
              onClick={() => void sendCode()}
            >
              {t("signin.code.resend")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          {providerWays}
          {/* No main action here: the sibling (Keep, Cancel) still has to be reachable. */}
          {trailing ? <div className={ACTION_ROW}>{trailing}</div> : null}
        </>
      )}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {otherWays.length ? (
        <div className="flex flex-wrap gap-x-4">{otherWays}</div>
      ) : null}
    </div>
  );
}

/** For an account with no passkey or email: sign in again with a provider it has. */
function SignInAgain({
  providers,
  sso,
  hrefFor,
}: {
  providers: PortalProvider[];
  sso: boolean;
  hrefFor: (p: PortalProvider | "sso") => string;
}): React.ReactElement {
  if (providers.length === 0 && !sso)
    return <p className="text-sm text-fg">{t("locker.stepUp.signOutFirst")}</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((p) => (
        <Button key={p} asChild variant="outline">
          <a href={hrefFor(p)} onClick={markStepUpLeave}>
            {t("locker.stepUp.again", { provider: PROVIDER_NAME[p] })}
          </a>
        </Button>
      ))}
      {sso ? (
        <Button asChild variant="outline">
          <a href={hrefFor("sso")} onClick={markStepUpLeave}>
            {t("locker.stepUp.againSso")}
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/** This browser's session row, before a step-up replaces it. */
async function currentSessionId(qc: QueryClient): Promise<string | null> {
  const cached = qc.getQueryData<{ id: string; current: boolean }[] | null>(
    qk.sessions(),
  );
  const found = cached?.find((s) => s.current)?.id;
  if (found) return found;
  try {
    return (
      (await portalApi.sessions()).sessions.find((s) => s.current)?.id ?? null
    );
  } catch {
    return null;
  }
}

/**
 * After the sign-in: read the new session (and its CSRF token), end the session it replaced
 * (never this one), and re-read what depends on how recently the person signed in.
 */
async function afterStepUp(
  qc: QueryClient,
  accountId: string,
  replaced: string | null,
): Promise<void> {
  const me = await refreshSession(qc);
  if (!me) throw new HttpError(401, { code: "unauthorized" });
  if (me.account.id !== accountId) {
    // Signed in to another account after all: everything on the page belongs to it now.
    await refreshAfterAccountChange(qc);
    throw new HttpError(409, { code: "other_account" });
  }
  if (replaced) {
    try {
      const { sessions } = await portalApi.sessions();
      const old = sessions.find((s) => s.id === replaced);
      if (old && !old.current) await mutate("endSession", replaced);
    } catch {
      // Best effort: the old session expires by itself.
    }
  }
  await refreshAfterStepUp(qc);
}

function passkeyErrorText(err: unknown): string {
  if (err instanceof PasskeyError) {
    if (err.reason === "cancelled") return t("signin.passkey.cancelled");
    if (err.reason === "unsupported") return t("signin.passkey.unsupported");
    return t("signin.passkey.failed");
  }
  return commonErrorText(err);
}

function sendErrorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.code === "turnstile_failed") return t("locker.stepUp.noCheck");
    if (err.code === "signin_expired") return expiredCodeText();
    if (err.status === 429 && err.retryAfter !== undefined)
      return t("locker.stepUp.wait", {
        seconds: Math.max(1, Math.ceil(err.retryAfter)),
      });
    if (err.status === 429)
      return t("signin.rateLimited", { minutes: "a few" });
    if (err.code === "email_unavailable" || err.code === "auth_method_disabled")
      return t("locker.stepUp.noEmail");
  }
  return commonErrorText(err);
}

function codeErrorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.code === "invalid_code") {
      return wrongCodeText(err.triesLeft);
    }
    if (err.code === "signin_expired") return expiredCodeText();
  }
  return commonErrorText(err);
}

function commonErrorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.code === "other_account") return t("locker.stepUp.otherAccount");
    if (err.status === 401 && err.code === "unauthorized")
      return t("locker.stepUp.notYou");
    if (err.status === 429) return t("signin.code.rateLimited");
  }
  return portalErrorCopy(err).line;
}
