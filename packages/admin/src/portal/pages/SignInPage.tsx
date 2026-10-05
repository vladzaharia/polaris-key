import * as React from "react";
import { ArrowRight, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { portalApi, PortalApiError, type PortalCapabilities } from "../api.js";
import { CardHeader, LoginCard } from "../components/signin/LoginCard.js";
import { ProviderRow } from "../components/signin/ProviderRow.js";
import { useCapabilities } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import { useDocumentTitle } from "../router.js";
import { useSessionRecheck } from "../session.js";

/**
 * Sign in, on today's auth (PORTAL.md §4.1, PX-05): the login card with the email link as the
 * identifier-first step, the provider row (only when the Worker names providers, G11), and the
 * single sign-on button. The sent screen is honest: it says how long the link works, offers
 * Resend and Use a different email, and signs this tab in by itself (`useSessionRecheck`).
 */
type Step = { kind: "methods" } | { kind: "sent"; email: string };

const RESEND_AFTER_S = 60;

function productFromUrl(): string | null {
  const search = new URLSearchParams(window.location.search).get("product");
  if (search) return search;
  const hashQuery = window.location.hash.split("?")[1];
  return hashQuery ? new URLSearchParams(hashQuery).get("product") : null;
}

function returnTo(): string {
  return window.location.href;
}

export function SignInPage(): React.ReactElement {
  const [product] = React.useState(productFromUrl);
  const caps = useCapabilities(product);
  const [step, setStep] = React.useState<Step>({ kind: "methods" });
  useSessionRecheck(step.kind === "sent");
  useDocumentTitle(step.kind === "sent" ? "Check your email" : "Sign in");

  const ctx = caps.data?.product;
  const header = ctx ? (
    <CardHeader
      variant="context"
      slug={ctx.slug}
      name={ctx.name}
      developer={ctx.developerName ?? null}
    />
  ) : undefined;

  return (
    <LoginCard header={header} stepKey={step.kind}>
      {caps.isPending ? (
        <>
          <h1 className="text-2xl font-bold text-fg-strong">
            Sign in to Polaris Key
          </h1>
          <p aria-busy className="text-fg-muted">
            Getting the ways you can sign in…
          </p>
        </>
      ) : caps.error ? (
        <Unreachable error={caps.error} onRetry={() => void caps.refetch()} />
      ) : step.kind === "sent" ? (
        <SentStep
          email={step.email}
          onChangeEmail={() => setStep({ kind: "methods" })}
        />
      ) : (
        <MethodsStep
          caps={caps.data}
          withContext={Boolean(ctx)}
          onSent={(email) => setStep({ kind: "sent", email })}
        />
      )}
    </LoginCard>
  );
}

function Unreachable({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const copy = portalErrorCopy(error);
  return (
    <>
      <h1
        tabIndex={-1}
        className="text-2xl font-bold text-fg-strong outline-none"
      >
        {copy.title}
      </h1>
      <p className="text-fg-muted">{copy.description}</p>
      <Button
        variant="outline"
        iconStart={<RefreshCw aria-hidden />}
        onClick={onRetry}
      >
        Try again
      </Button>
    </>
  );
}

function magicErrorText(err: unknown): string {
  if (err instanceof PortalApiError) {
    if (err.status === 429 || err.code === "rate_limited")
      return "Too many sign-in emails. Try again in a few minutes.";
    if (err.code === "email_not_configured")
      return "We can't send email right now. Try another way to sign in.";
    if (err.status === 422)
      return "Enter a full email address, like name@example.com.";
    if (err.code === "auth_method_disabled")
      return "Email sign-in is turned off.";
  }
  return portalErrorCopy(err).title + ". " + portalErrorCopy(err).description;
}

function MethodsStep({
  caps,
  withContext,
  onSent,
}: {
  caps: PortalCapabilities;
  withContext: boolean;
  onSent: (email: string) => void;
}): React.ReactElement {
  const [email, setEmail] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const errorId = React.useId();
  const providers = caps.auth.providers ?? [];
  const magic = caps.auth.magic;
  const oidc = caps.auth.oidc;
  const ssoLabel = `Continue with ${caps.auth.oidcName ?? "single sign-on"}`;
  const ssoHref = `/login?return_to=${encodeURIComponent(returnTo())}`;

  if (!magic && !oidc && providers.length === 0) {
    return (
      <>
        <h1
          tabIndex={-1}
          className="text-2xl font-bold text-fg-strong outline-none"
        >
          Sign-in is turned off
        </h1>
        <p className="text-fg-muted">
          {withContext
            ? "Sign-in is turned off for this product. Contact its developer."
            : "There's no way to sign in to Polaris Key here right now. Try again later."}
        </p>
      </>
    );
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setInvalid(true);
      setError("Enter a full email address, like name@example.com.");
      return;
    }
    setInvalid(false);
    setError(null);
    setSending(true);
    try {
      await portalApi.startMagic(value);
      onSent(value);
    } catch (err) {
      setError(magicErrorText(err));
      if (err instanceof PortalApiError && err.status === 422) setInvalid(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="space-y-2">
        <h1
          tabIndex={-1}
          className="text-2xl font-bold text-fg-strong outline-none"
        >
          {withContext
            ? "Sign in or create an account"
            : "Sign in to Polaris Key"}
        </h1>
        <p className="text-fg-muted">
          {withContext
            ? "Use the email you bought it with."
            : "Your library of games and apps from developers who use Polaris Key."}
        </p>
      </div>
      {magic ? (
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="pk-signin-email"
              className="text-sm font-bold text-fg-strong"
            >
              Email
            </label>
            <Input
              id="pk-signin-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onValueChange={(v) => {
                setEmail(v);
                if (invalid) setInvalid(false);
              }}
              aria-invalid={invalid || undefined}
              aria-describedby={error ? errorId : undefined}
              className="h-12 text-base"
            />
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            size="lg"
            className="h-12 w-full text-base font-bold"
            loading={sending}
            iconEnd={<ArrowRight aria-hidden />}
          >
            Continue
          </Button>
        </form>
      ) : null}
      {(providers.length > 0 || oidc) && magic ? <Divider /> : null}
      <ProviderRow
        providers={providers}
        // The provider start route arrives with G11 (S-16); the row renders only once the
        // Worker names providers.
        hrefFor={(p) =>
          `/login?provider=${p}&return_to=${encodeURIComponent(returnTo())}`
        }
      />
      {oidc ? (
        <Button
          asChild
          variant={magic || providers.length ? "secondary" : "primary"}
          size="lg"
          className="h-12 w-full"
        >
          <a href={ssoHref}>
            <ShieldCheck aria-hidden />
            {ssoLabel}
          </a>
        </Button>
      ) : null}
    </>
  );
}

function Divider(): React.ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm text-fg-muted" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function SentStep({
  email,
  onChangeEmail,
}: {
  email: string;
  onChangeEmail: () => void;
}): React.ReactElement {
  const [wait, setWait] = React.useState(RESEND_AFTER_S);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  React.useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);
  const resend = async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      await portalApi.startMagic(email);
      setStatus("We sent a new link. Either one works for 10 minutes.");
      setWait(RESEND_AFTER_S);
    } catch (err) {
      setError(magicErrorText(err));
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-accent-subtle text-accent-fg">
        <Mail aria-hidden className="size-6" />
      </span>
      <div className="space-y-2">
        <h1
          tabIndex={-1}
          className="text-2xl font-bold text-fg-strong outline-none"
        >
          Check your email
        </h1>
        <p className="text-fg">
          We sent a sign-in link to{" "}
          <span className="font-bold text-fg-strong">{email}</span>. It works
          for 10 minutes.
        </p>
        <p className="text-sm text-fg-muted">
          Open it on this device and this page signs you in by itself.
        </p>
      </div>
      <div role="status" className="text-sm text-success">
        {status}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          size="lg"
          className="h-12"
          loading={sending}
          disabled={wait > 0}
          onClick={() => void resend()}
        >
          {wait > 0 ? `Resend in ${wait} s` : "Resend the link"}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          className="h-12"
          onClick={onChangeEmail}
        >
          Use a different email
        </Button>
      </div>
    </>
  );
}
