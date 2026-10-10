import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Fingerprint, Mail, ShieldCheck } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { t } from "../../../lib/copy.js";
import { expiredCodeText, wrongCodeText } from "../../copy/codeEntry.js";
import {
  portalApi,
  PortalApiError,
  type PortalMethods,
  type PortalProvider,
} from "../../api.js";
import {
  capabilitiesOrNone,
  portalKeys,
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
import { CODE_LENGTH, CodeCells } from "../CodeCells.js";

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
 * provider sign-in leaves the page, so it cannot end the old one: that row stays until it expires.
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
  onConfirmed: () => void;
}

type Way = "passkey" | "email";

export function StepUp({
  verb,
  view,
  accountId,
  returnTo,
  tone = "primary",
  autoFocus = false,
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
      const { options } = await portalApi.passkeySignInOptions();
      const response = await passkeyAssertion(
        options,
        view.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      );
      await portalApi.passkeySignInVerify(response);
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
      if (sent) await portalApi.resendSignInCode();
      else await portalApi.startEmailSignIn(email);
      setSent(true);
      setCode("");
      requestAnimationFrame(() => document.getElementById(codeId)?.focus());
    } catch (err) {
      if (err instanceof PortalApiError && err.code === "turnstile_failed")
        setTurnstileFailed(true);
      // The sign-in itself expired: the next send starts a new one.
      if (err instanceof PortalApiError && err.code === "signin_expired")
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
      await portalApi.verifySignInCode(value);
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
        className="text-sm font-medium"
        onClick={() => {
          setWay("email");
          setError(null);
        }}
      >
        Use an email code instead
      </Button>,
    );
  if (way === "email" && passkey)
    otherWays.push(
      <Button
        key="passkey"
        variant="link"
        className="text-sm font-medium"
        onClick={() => {
          setWay("passkey");
          setSent(false);
          setError(null);
        }}
      >
        Use your passkey instead
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
        Confirm it's you first
      </p>
      {way === "passkey" ? (
        <Button
          variant={tone}
          loading={busy}
          iconStart={<Fingerprint aria-hidden />}
          onClick={() => void withPasskey()}
          aria-describedby={error ? errorId : undefined}
        >
          Use your passkey to {verb}
        </Button>
      ) : way === "email" && email && !sent ? (
        <Button
          variant={tone}
          loading={busy}
          iconStart={<Mail aria-hidden />}
          onClick={() => void sendCode()}
          aria-describedby={error ? errorId : undefined}
        >
          Email a code to {email}
        </Button>
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
            We sent a 6-digit code to{" "}
            <span className="font-medium text-fg-strong">{email}</span>. It
            works for 10 minutes.
          </p>
          <label
            htmlFor={codeId}
            className="text-sm font-medium text-fg-strong"
          >
            Code
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              type="submit"
              variant={tone}
              loading={busy}
              disabled={code.length !== CODE_LENGTH}
            >
              Confirm and {verb}
            </Button>
            <Button
              variant="link"
              className="text-sm font-medium"
              onClick={() => void sendCode()}
            >
              {t("signin.code.resend")}
            </Button>
          </div>
        </form>
      ) : (
        providerWays
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
    return (
      <p className="text-sm text-fg">
        Sign out, then sign in again. You can make the change for 5 minutes
        after.
      </p>
    );
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((p) => (
        <Button key={p} asChild variant="outline">
          <a href={hrefFor(p)}>Sign in again with {PROVIDER_NAME[p]}</a>
        </Button>
      ))}
      {sso ? (
        <Button asChild variant="outline">
          <a href={hrefFor("sso")}>Sign in again with single sign-on</a>
        </Button>
      ) : null}
    </div>
  );
}

/** This browser's session row, before a step-up replaces it. */
async function currentSessionId(qc: QueryClient): Promise<string | null> {
  const cached = qc.getQueryData<{ id: string; current: boolean }[] | null>(
    portalKeys.sessions,
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
  if (!me) throw new PortalApiError(401, "unauthorized");
  if (me.account.id !== accountId) {
    // Signed in to another account after all: everything on the page belongs to it now.
    void qc.invalidateQueries();
    throw new PortalApiError(409, "other_account");
  }
  if (replaced) {
    try {
      const { sessions } = await portalApi.sessions();
      const old = sessions.find((s) => s.id === replaced);
      if (old && !old.current) await portalApi.endSession(replaced);
    } catch {
      // Best effort: the old session expires by itself.
    }
  }
  void qc.invalidateQueries({ queryKey: portalKeys.sessions });
  await qc.invalidateQueries({ queryKey: portalKeys.methods });
}

function passkeyErrorText(err: unknown): string {
  if (err instanceof PasskeyError) {
    if (err.reason === "cancelled")
      return "Your passkey wasn't used. Try again, or use another way.";
    if (err.reason === "unsupported")
      return "This browser can't use your passkey here. Use another way.";
    return "Your passkey didn't work. Try again, or use another way.";
  }
  return commonErrorText(err);
}

function sendErrorText(err: unknown): string {
  if (err instanceof PortalApiError) {
    if (err.code === "turnstile_failed")
      return "The security check didn't run here. Confirm it's you another way.";
    if (err.code === "signin_expired") return expiredCodeText();
    if (err.status === 429 && err.retryAfter !== undefined)
      return `Wait ${Math.max(1, Math.ceil(err.retryAfter))} seconds, then send a new code.`;
    if (err.status === 429)
      return t("signin.rateLimited", { minutes: "a few" });
    if (err.code === "email_unavailable" || err.code === "auth_method_disabled")
      return "We can't send email right now. Try again later.";
  }
  return commonErrorText(err);
}

function codeErrorText(err: unknown): string {
  if (err instanceof PortalApiError) {
    if (err.code === "invalid_code") {
      return wrongCodeText(err.triesLeft);
    }
    if (err.code === "signin_expired") return expiredCodeText();
  }
  return commonErrorText(err);
}

function commonErrorText(err: unknown): string {
  if (err instanceof PortalApiError) {
    if (err.code === "other_account")
      return "That signed you in to a different Polaris Key account. Nothing was changed.";
    if (err.status === 401 && err.code === "unauthorized")
      return "That didn't confirm it's you. Try again, or use another way.";
    if (err.status === 429)
      return "Too many tries. Wait a minute, then try again.";
  }
  const copy = portalErrorCopy(err);
  return `${copy.title}. ${copy.description}`;
}
