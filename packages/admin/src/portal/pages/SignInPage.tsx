import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Building2,
  KeyRound,
  Mail,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { t, tParts } from "../../lib/copy.js";
import { expiredCodeText, wrongCodeText } from "../copy/codeEntry.js";
import {
  portalApi,
  PortalApiError,
  type PortalCapabilities,
  type PortalConnection,
  type PortalEmailSent,
  type PortalSsoNext,
} from "../api.js";
import { CardHeader, LoginCard } from "../components/signin/LoginCard.js";
import { ProviderRow } from "../components/signin/ProviderRow.js";
import { CODE_LENGTH, CodeCells } from "../components/CodeCells.js";
import { KeyField } from "../components/KeyField.js";
import { portalKeys, useCapabilities } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import { checkKey, formatVerdict, productLabel } from "../model/key.js";
import { setParams, useDocumentTitle, useRoute } from "../router.js";
import { useSessionRecheck } from "../session.js";
import { returnUrl, stashCarriedKey } from "../carriedKey.js";

/**
 * Sign in (SIGN-IN.md §3.1–§3.4, §3.9; PORTAL.md §4.1): the login card's steps, replacing each
 * other in place.
 *
 * - **MethodsStep**: "Sign in to Polaris Key" (no lede) or, with product context, "Sign in" and
 *   "Use the email you bought <Product> with."; the email and **Continue**, "or", the logo-only
 *   provider row (when the Worker names providers), single sign-on, and under a rule the quiet,
 *   centred **Have a license key?** link.
 * - **CodeStep**: I-07's email carries a 6-digit code and a sign-in link. One input drawn as six
 *   cells, submitted on the sixth digit; the link still signs this tab in by itself
 *   (`useSessionRecheck`). **Send a new code** is PX-W4's resend for this sign-in, after the
 *   Worker's `resendIn` countdown; a sign-in that has expired goes back to the email step with
 *   the address kept. A right code whose account can't sign in (a disabled account, 403) ends
 *   the step: **RefusedStep** says so, with no Continue and no resend, and **Use a different
 *   email** is the way on (§3.13).
 * - **KeyStep** (the on-ramp): the key field; Continue keeps the key in `#/?activate=` and moves
 *   on to sign-in, after which the Activate dialog opens with it filled in (the same round trip
 *   as `/activate#key=…`).
 * - **SsoStep** (I-30, mockup `identity.sign-in-routes` pins 1 and 2): the address's domain is
 *   DNS-verified by a connection, so the email start sent nothing and answered `next`. The
 *   address as a chip with **Change** (back to the email step with the address kept and the field
 *   focused), "Sign in with <Organization>", **Continue** (`/login/sso/<id>` with the address as
 *   `login_hint`) and, unless the domain requires the connection ("Required for <domain>
 *   addresses."), **Email me a code instead** (the resend sends the first code; a 429 with a wait
 *   counts down on the button). An enforced refusal later (a code sent before the domain was
 *   enforced) lands here too.
 * - A card with no email field lists the Worker's platform connections (`auth.connections`) as
 *   "Continue with <label>" buttons; with the field, the address routes to its connection.
 *
 * Copy is the kit copy catalog's `signin.*` strings (§5.2) through `t()`; the few sentences it does
 * not word yet are written here under the key they will take.
 */
type Step =
  | {
      kind: "methods";
      email?: string;
      notice?: string;
      /** Change on a routed step: the typed address stays and the field takes focus. */
      focusEmail?: boolean;
    }
  | { kind: "code"; email: string; resendIn: number }
  /** The code was right but its account can't sign in (§3.13, Account disabled): a dead end
   *  for that address, so the step ends here (PS-05 review M3). */
  | { kind: "refused"; email: string }
  /** I-30: the address's domain routes to a connection (`next` from the start or a refusal). */
  | { kind: "sso"; email: string; next: PortalSsoNext }
  | { kind: "key" };

/** The countdown when an answer carries no `resendIn` (a Worker from before PX-W4). */
const RESEND_FALLBACK_S = 60;

/** Seconds until "Send a new code", from the start's or the resend's answer. */
function resendDelay(out: PortalEmailSent | undefined): number {
  const n = out?.resendIn;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.ceil(n)
    : RESEND_FALLBACK_S;
}

function productFromUrl(): string | null {
  const search = new URLSearchParams(window.location.search).get("product");
  if (search) return search;
  const hashQuery = window.location.hash.split("?")[1];
  return hashQuery ? new URLSearchParams(hashQuery).get("product") : null;
}

/** The return URL every sign-in sends: never the carried license key (carriedKey.ts). */
function returnTo(): string {
  return returnUrl();
}

/** I-30: a connection's sign-in, with the typed address as the IdP's `login_hint` when there is one. */
function connectionHref(id: string, email?: string): string {
  const hint = email && EMAIL_RE.test(email) ? email : null;
  return `/login/sso/${encodeURIComponent(id)}?${
    hint ? `login_hint=${encodeURIComponent(hint)}&` : ""
  }return_to=${encodeURIComponent(returnTo())}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The key the on-ramp (or an `/activate#key=…` link) is carrying through sign-in, if valid. */
function useCarriedKey(): string | null {
  const route = useRoute();
  const key = "params" in route ? route.params.get("activate") : null;
  return key && checkKey(key).kind === "valid" ? key : null;
}

export function SignInPage(): React.ReactElement {
  const [product] = React.useState(productFromUrl);
  const caps = useCapabilities(product);
  const [step, setStep] = React.useState<Step>({ kind: "methods" });
  const [direction, setDirection] = React.useState<"forward" | "back">(
    "forward",
  );
  const go = (next: Step, dir: "forward" | "back" = "forward"): void => {
    setDirection(dir);
    setStep(next);
  };
  useSessionRecheck(step.kind === "code");
  useDocumentTitle(
    step.kind === "code"
      ? t("signin.code.title")
      : step.kind === "refused"
        ? "This account can't sign in"
        : step.kind === "key"
          ? t("signin.link.key")
          : step.kind === "sso"
            ? step.next.connection.label
            : t("signin.methods.titleApp"),
  );
  /** The card's step key: a connection step is keyed by its route, so a change re-announces. */
  const ssoKey =
    step.kind === "sso"
      ? `sso:${step.next.connection.id}:${step.next.enforced ? "only" : "first"}`
      : null;

  const ctx = caps.data?.product;
  const header = ctx ? (
    <CardHeader
      variant="context"
      slug={ctx.slug}
      name={ctx.name}
      developer={ctx.developerName ?? null}
    />
  ) : undefined;

  const stepKey = caps.isPending
    ? "loading"
    : caps.error
      ? "unreachable"
      : (ssoKey ?? step.kind);

  return (
    <LoginCard header={header} stepKey={stepKey} direction={direction}>
      {caps.isPending ? (
        <MethodsSkeleton />
      ) : caps.error ? (
        <Unreachable error={caps.error} onRetry={() => void caps.refetch()} />
      ) : step.kind === "code" ? (
        <CodeStep
          email={step.email}
          resendIn={step.resendIn}
          onChangeEmail={() => go({ kind: "methods" }, "back")}
          onRefused={() => go({ kind: "refused", email: step.email })}
          onRouted={(next) => go({ kind: "sso", email: step.email, next })}
          onExpired={() =>
            go(
              {
                kind: "methods",
                email: step.email,
                // signin.code.expiredRestart (PX-W4): no catalog key yet
                notice: "That sign-in has expired. Continue to get a new code.",
              },
              "back",
            )
          }
        />
      ) : step.kind === "sso" ? (
        <SsoStep
          email={step.email}
          next={step.next}
          onChangeEmail={() =>
            go({ kind: "methods", email: step.email, focusEmail: true }, "back")
          }
          onCode={(resendIn) =>
            go({ kind: "code", email: step.email, resendIn })
          }
          onRouted={(next) => go({ kind: "sso", email: step.email, next })}
          onExpired={() =>
            go(
              {
                kind: "methods",
                email: step.email,
                // signin.code.expiredRestart (PX-W4): no catalog key yet
                notice: "That sign-in has expired. Continue to get a new code.",
              },
              "back",
            )
          }
        />
      ) : step.kind === "refused" ? (
        <RefusedStep
          email={step.email}
          onChangeEmail={() => go({ kind: "methods" }, "back")}
        />
      ) : step.kind === "key" ? (
        <KeyStep
          onBack={() => go({ kind: "methods" }, "back")}
          onContinue={(key) => {
            setParams({ activate: key });
            go({ kind: "methods" });
          }}
        />
      ) : (
        <MethodsStep
          caps={caps.data}
          context={ctx ?? null}
          initialEmail={step.email}
          focusEmail={step.focusEmail}
          notice={step.notice}
          onSent={(email, sent) =>
            go(
              sent?.next
                ? { kind: "sso", email, next: sent.next }
                : { kind: "code", email, resendIn: resendDelay(sent) },
            )
          }
          onKey={() => go({ kind: "key" })}
        />
      )}
    </LoginCard>
  );
}

/** The card's loading state (§3.3): a skeleton at the final size, never a "Getting…" line. */
function MethodsSkeleton(): React.ReactElement {
  return (
    <div aria-busy className="space-y-5" data-testid="signin-skeleton">
      <span className="sr-only">Loading</span>
      <div aria-hidden className="h-8 w-2/3 rounded-md bg-hover" />
      <div aria-hidden className="space-y-1.5">
        <div className="h-4 w-12 rounded bg-hover" />
        <div className="h-12 rounded-md bg-hover" />
      </div>
      <div aria-hidden className="h-12 rounded-md bg-hover" />
    </div>
  );
}

function Title({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <h1
      tabIndex={-1}
      className="text-2xl font-semibold text-fg-strong outline-none"
    >
      {children}
    </h1>
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
      <Title>{copy.title}</Title>
      <p className="text-fg-muted">{copy.description}</p>
      <Button
        variant="outline"
        iconStart={<RefreshCw aria-hidden />}
        onClick={onRetry}
      >
        {t("signin.retry")}
      </Button>
    </>
  );
}

function startErrorText(err: unknown): string {
  if (err instanceof PortalApiError) {
    // The Worker's 429 carries no wait yet, so `{minutes}` reads "a few".
    if (err.status === 429 || err.code === "rate_limited")
      return t("signin.rateLimited", { minutes: "a few" });
    if (err.code === "email_unavailable" || err.code === "email_not_configured")
      return t("signin.emailDown");
    if (err.status === 422) return t("signin.email.invalid");
    if (err.code === "auth_method_disabled") return t("signin.off.any");
    if (err.code === "turnstile_failed")
      return "The security check did not pass. Try again.";
  }
  return portalErrorCopy(err).title + ". " + portalErrorCopy(err).description;
}

/**
 * The quiet links under a rule (§3.3), centred and evenly spaced: 24 px from the rule to the text
 * and 24 px from the text to the card's bottom edge. Each link is a 44 px target with its 20 px
 * line centred in it (12 px either side), so the row adds 12 px of padding above it and pulls the
 * body's bottom padding (24 px on phones, 32 px wide) in by 12 px or 20 px below it.
 */
function QuietLinks({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      data-quiet-links
      className="-mb-3 flex flex-wrap items-center justify-center gap-x-5 border-t border-border pt-3 text-sm text-fg-muted sm:-mb-5"
    >
      {children}
    </div>
  );
}

function QuietLink({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-sm px-1 transition-colors duration-(--pk-duration-fast) hover:text-fg-strong"
    >
      {icon}
      {children}
    </button>
  );
}

function MethodsStep({
  caps,
  context,
  initialEmail,
  focusEmail,
  notice,
  onSent,
  onKey,
}: {
  caps: PortalCapabilities;
  context: { slug: string; name: string; developerName?: string | null } | null;
  /** The address to start from: kept when an expired sign-in comes back here. */
  initialEmail?: string;
  /** Focus and select the address (Change on a routed step), not the heading. */
  focusEmail?: boolean;
  /** Why the card came back here (an expired sign-in), shown under the title. */
  notice?: string;
  /** The start's answer: a code was sent, or (`next`) the domain routes to a connection. */
  onSent: (email: string, sent: PortalEmailSent | undefined) => void;
  onKey: () => void;
}): React.ReactElement {
  const [email, setEmail] = React.useState(initialEmail ?? "");
  const [invalid, setInvalid] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const errorId = React.useId();
  // After the card's own heading focus (a layout effect), so the field wins.
  React.useEffect(() => {
    if (!focusEmail) return;
    const el = document.getElementById("pk-signin-email");
    if (el instanceof HTMLInputElement) {
      el.focus({ preventScroll: true });
      el.select();
    }
  }, [focusEmail]);
  const carried = useCarriedKey();
  const providers = caps.auth.providers ?? [];
  const magic = caps.auth.magic;
  // With the email field, the address routes to its connection (identifier-first); the buttons
  // are for a card with no field to route through.
  const connections = magic ? [] : (caps.auth.connections ?? []);
  const oidc = caps.auth.oidc;
  const ssoLabel = t("signin.provider.continue", {
    provider: caps.auth.oidcName ?? "single sign-on",
  });
  const ssoHref = `/login?return_to=${encodeURIComponent(returnTo())}`;

  if (!magic && !oidc && providers.length === 0 && connections.length === 0) {
    return (
      <>
        <Title>Sign-in is turned off</Title>
        <p className="text-fg-muted">
          {context
            ? t("signin.off.product", {
                product: context.name,
                developer: context.developerName ?? "its developer",
              })
            : t("signin.off.any")}
        </p>
      </>
    );
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setInvalid(true);
      setError(t("signin.email.invalid"));
      return;
    }
    setInvalid(false);
    setError(null);
    setSending(true);
    try {
      onSent(value, await portalApi.startEmailSignIn(value));
    } catch (err) {
      setError(startErrorText(err));
      if (err instanceof PortalApiError && err.status === 422) setInvalid(true);
    } finally {
      setSending(false);
    }
  };

  const carriedCheck = carried ? checkKey(carried) : null;
  const carriedName =
    carriedCheck?.kind === "valid" ? productLabel(carriedCheck.slug) : null;
  const title = carriedName
    ? `Sign in to add ${carriedName}` // signin.key.carriedTitle (no catalog key yet)
    : context
      ? t("signin.methods.titleApp")
      : t("signin.methods.title");
  const lede = carriedName
    ? `Your key is ready. Sign in or create an account, and ${carriedName} joins your library.` // signin.key.carriedLede
    : context
      ? t("signin.methods.ledeApp", { product: context.name })
      : null;

  return (
    <>
      <div className="space-y-2">
        <Title>{title}</Title>
        {lede ? <p className="text-fg-muted">{lede}</p> : null}
        {notice ? (
          // An alert, so the reason is announced along with the step change (WCAG 4.1.3).
          <p data-signin-notice role="alert" className="text-sm text-fg">
            {notice}
          </p>
        ) : null}
      </div>
      {magic ? (
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="pk-signin-email"
              className="text-sm font-medium text-fg-strong"
            >
              {t("signin.email.label")}
            </label>
            <Input
              id="pk-signin-email"
              type="email"
              inputMode="email"
              autoComplete="username webauthn"
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
            className="h-12 w-full text-base font-semibold"
            loading={sending}
            iconEnd={<ArrowRight aria-hidden />}
          >
            {t("signin.continue")}
          </Button>
        </form>
      ) : null}
      {(providers.length > 0 || oidc) && magic ? <Divider /> : null}
      <ProviderRow
        providers={providers}
        // I-06's start route is GET /login/<provider>; the row renders only once the Worker
        // names providers in its capabilities (PX-12). I-09: a card opened for a product (an
        // app's `signInUrl`) signs in through it, so the product's terms are asked.
        hrefFor={(p) =>
          `/login/${p}?return_to=${encodeURIComponent(returnTo())}${
            context ? `&product=${encodeURIComponent(context.slug)}` : ""
          }`
        }
        onNavigate={() => stashCarriedKey()}
      />
      {oidc ? (
        <Button
          asChild
          variant={magic || providers.length ? "secondary" : "primary"}
          size="lg"
          className="h-12 w-full"
        >
          <a href={ssoHref} onClick={() => stashCarriedKey()}>
            <ShieldCheck aria-hidden />
            {ssoLabel}
          </a>
        </Button>
      ) : null}
      {connections.map((c) => (
        <ConnectionButton
          key={c.id}
          connection={c}
          href={connectionHref(c.id)}
          primary={!oidc && providers.length === 0 && c === connections[0]}
        />
      ))}
      {carried ? (
        <QuietLinks>
          <QuietLink
            onClick={() => setParams({ activate: null })}
            icon={<KeyRound aria-hidden className="size-4" />}
          >
            {/* signin.key.withoutKey */}
            Sign in without the key
          </QuietLink>
        </QuietLinks>
      ) : caps.modules.claim ? (
        <QuietLinks>
          <QuietLink
            onClick={onKey}
            icon={<KeyRound aria-hidden className="size-4" />}
          >
            {t("signin.link.key")}
          </QuietLink>
        </QuietLinks>
      ) : null}
    </>
  );
}

/**
 * A platform connection on a card with no email field to route through (I-30): drawn like the
 * single sign-on button. With an email field, the address reaches its connection by itself.
 */
function ConnectionButton({
  connection,
  href,
  primary,
}: {
  connection: PortalConnection;
  href: string;
  primary: boolean;
}): React.ReactElement {
  return (
    <Button
      asChild
      variant={primary ? "primary" : "secondary"}
      size="lg"
      className="h-auto min-h-12 w-full whitespace-normal py-2 text-center"
    >
      <a
        href={href}
        onClick={() => stashCarriedKey()}
        data-connection={connection.id}
      >
        <Building2 aria-hidden />
        <span className="min-w-0 break-words">
          <bdi>
            {t("signin.provider.continue", { provider: connection.label })}
          </bdi>
        </span>
      </a>
    </Button>
  );
}

function Divider(): React.ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm text-fg-muted" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      {t("signin.or")}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function codeErrorText(err: unknown): string {
  if (err instanceof PortalApiError) {
    if (err.code === "invalid_code") {
      return wrongCodeText(err.triesLeft);
    }
    if (err.code === "signin_expired") return expiredCodeText();
    if (err.status === 429 || err.code === "rate_limited")
      return "Too many tries. Wait a minute, then try again.";
    if (err.code === "forbidden" || err.code === "email_in_use")
      return err.message;
  }
  return portalErrorCopy(err).title + ". " + portalErrorCopy(err).description;
}

function CodeStep({
  email,
  resendIn,
  onChangeEmail,
  onRefused,
  onRouted,
  onExpired,
}: {
  email: string;
  /** Seconds before the first "Send a new code" (the start's `resendIn`). */
  resendIn: number;
  onChangeEmail: () => void;
  /** The code was right, but its account can't sign in (the verify answered 403). */
  onRefused: () => void;
  /** I-30: the address's domain now requires its connection (a refusal carried `next`). */
  onRouted: (next: PortalSsoNext) => void;
  /** The sign-in itself is gone (the resend answered `signin_expired`): back to the email. */
  onExpired: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const [code, setCode] = React.useState("");
  const [wait, setWait] = React.useState(resendIn);
  const [status, setStatus] = React.useState<{
    text: string;
    tone: "success" | "muted";
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  /** This sign-in sent every code it may (the Worker's per-flow cap): no more resends. */
  const [capped, setCapped] = React.useState(false);
  const errorId = React.useId();
  const inputId = React.useId();
  React.useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);

  const verify = async (value: string): Promise<void> => {
    if (value.length !== CODE_LENGTH || verifying) return;
    setVerifying(true);
    setError(null);
    setStatus(null);
    try {
      await portalApi.verifySignInCode(value);
      await qc.invalidateQueries({ queryKey: portalKeys.me });
    } catch (err) {
      // I-30: the domain requires its connection now (enforced after this code was sent).
      if (err instanceof PortalApiError && err.next) {
        onRouted(err.next);
        return;
      }
      // The verify's other 403: a right code for an account that can't sign in (the Worker's
      // `forbidden`, §3.13). Another code or a resend would end the same way.
      if (err instanceof PortalApiError && err.status === 403) {
        onRefused();
        return;
      }
      setError(codeErrorText(err));
      setCode("");
      // Out of tries, or the code expired: "Send a new code" is the way on, at once.
      if (
        err instanceof PortalApiError &&
        ((err.code === "invalid_code" && err.triesLeft === 0) ||
          err.code === "signin_expired")
      )
        setWait(0);
    } finally {
      setVerifying(false);
    }
  };

  /**
   * The resend's button goes away (a countdown, or nothing at the cap) while this step stays, so
   * focus moves to the code, the next thing to do, rather than falling to the page (§9 item 9).
   */
  const focusCode = (): void => {
    document.getElementById(inputId)?.focus();
  };

  const resend = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    setError(null);
    setStatus(null);
    try {
      const out = await portalApi.resendSignInCode();
      setStatus({
        text: t("signin.code.resent", { email }),
        tone: "success",
      });
      setCode("");
      setWait(resendDelay(out));
      focusCode();
    } catch (err) {
      if (err instanceof PortalApiError && err.next) {
        onRouted(err.next);
        return;
      }
      if (err instanceof PortalApiError && err.code === "signin_expired") {
        onExpired();
        return;
      }
      if (
        err instanceof PortalApiError &&
        err.status === 429 &&
        err.retryAfter !== undefined
      ) {
        // Too soon (or this address's minute is spent): the countdown says when.
        setWait(Math.max(1, Math.ceil(err.retryAfter)));
        focusCode();
        return;
      }
      if (
        err instanceof PortalApiError &&
        err.status === 429 &&
        err.code === "rate_limited"
      ) {
        // The Worker's per-flow cap (its only 429 without a wait): the code already sent is the
        // one to use.
        setCapped(true);
        setStatus({
          // signin.code.noMore (PX-W4): no catalog key yet
          text: "No more codes can be sent for this sign-in. The latest code still works.",
          tone: "muted",
        });
        focusCode();
        return;
      }
      // Anything else, a bare 429 from the edge included: retry later, the link stays.
      setError(startErrorText(err));
    } finally {
      setSending(false);
    }
  };

  const clock = `${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}`;

  return (
    <>
      <div className="space-y-2">
        <Title>{t("signin.code.title")}</Title>
        <p className="text-fg">
          {tParts("signin.code.sent", ["email"]).map((part, i) =>
            typeof part === "string" ? (
              part
            ) : (
              <span key={i} className="font-medium text-fg-strong">
                {email}
              </span>
            ),
          )}
        </p>
      </div>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
      >
        <div className="space-y-1.5">
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-fg-strong"
          >
            Code
          </label>
          <CodeCells
            id={inputId}
            value={code}
            invalid={Boolean(error)}
            describedBy={error ? errorId : undefined}
            onChange={(v) => {
              setCode(v);
              if (error) setError(null);
              if (v.length === CODE_LENGTH) void verify(v);
            }}
          />
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <p className="text-sm text-fg-muted">{t("signin.code.link")}</p>
        <Button
          type="submit"
          size="lg"
          className="h-12 w-full text-base font-semibold"
          disabled={code.length !== CODE_LENGTH}
          loading={verifying}
        >
          {t("signin.continue")}
        </Button>
      </form>
      {/* Always in the tree so the resend is announced; visually hidden while empty. */}
      <div
        role="status"
        className={
          status
            ? status.tone === "success"
              ? "text-sm text-success"
              : "text-sm text-fg-muted"
            : "sr-only"
        }
      >
        {status?.text}
      </div>
      <QuietLinks>
        {capped ? null : wait > 0 ? (
          <span className="inline-flex min-h-11 items-center px-1 text-fg-muted">
            {t("signin.code.resendIn", { time: clock })}
          </span>
        ) : (
          <QuietLink onClick={() => void resend()}>
            {sending ? "Sending…" : t("signin.code.resend")}
          </QuietLink>
        )}
        <QuietLink onClick={onChangeEmail}>
          {t("signin.code.differentEmail")}
        </QuietLink>
      </QuietLinks>
    </>
  );
}

/**
 * The typed address above a step that depends on it (mockup `identity.sign-in-routes`), with
 * **Change** back to the email step. A long address truncates; the full one is its title.
 */
function IdChip({
  email,
  onChange,
}: {
  email: string;
  onChange: () => void;
}): React.ReactElement {
  // The domain decided the route, so it never truncates; the local part gives way.
  const at = email.lastIndexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  const host = at > 0 ? email.slice(at) : "";
  return (
    <div className="flex">
      <div className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border py-0.5 pl-3 pr-1 text-sm text-fg">
        <span className="flex min-w-0 max-w-full" title={email}>
          <bdi className="min-w-0 truncate">{local}</bdi>
          <bdi className="shrink-0">{host}</bdi>
        </span>
        <button
          type="button"
          onClick={onChange}
          aria-label="Change email"
          className="inline-flex min-h-8 shrink-0 items-center rounded-full px-2 font-medium text-accent-fg hover:underline"
        >
          {t("signin.consent.change")}
        </button>
      </div>
    </div>
  );
}

/**
 * I-30's routed step (see the module comment): the connection first, the email code second
 * unless the domain requires the connection.
 */
function SsoStep({
  email,
  next,
  onChangeEmail,
  onCode,
  onRouted,
  onExpired,
}: {
  email: string;
  next: PortalSsoNext;
  onChangeEmail: () => void;
  /** The first code went out (the resend's answer): on to the code step. */
  onCode: (resendIn: number) => void;
  /** The domain became enforced while the card was open. */
  onRouted: (next: PortalSsoNext) => void;
  onExpired: () => void;
}): React.ReactElement {
  const { connection, enforced } = next;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** Seconds before another code may be asked for (the Worker's 429 `retryAfter`). */
  const [wait, setWait] = React.useState(0);
  const errorId = React.useId();
  const codeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);
  const clock = `${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}`;

  const sendCode = async (): Promise<void> => {
    if (sending || wait > 0) return;
    setSending(true);
    setError(null);
    try {
      onCode(resendDelay(await portalApi.resendSignInCode()));
    } catch (err) {
      if (err instanceof PortalApiError && err.next) {
        onRouted(err.next);
        return;
      }
      if (err instanceof PortalApiError && err.code === "signin_expired") {
        onExpired();
        return;
      }
      if (
        err instanceof PortalApiError &&
        err.status === 429 &&
        err.retryAfter !== undefined
      ) {
        // Too soon: the button counts down, no error line.
        setWait(Math.max(1, Math.ceil(err.retryAfter)));
      } else {
        setError(startErrorText(err));
      }
    } finally {
      setSending(false);
      // The button was disabled while the request ran: put the place back.
      window.requestAnimationFrame(() => codeRef.current?.focus());
    }
  };

  return (
    <>
      <IdChip email={email} onChange={onChangeEmail} />
      <div className="space-y-2">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-md bg-hover text-fg-muted"
          >
            <Building2 className="size-5" />
          </span>
          <Title>
            {/* signin.sso.title (I-30): no catalog key yet */}
            Sign in with <bdi>{connection.label}</bdi>
          </Title>
        </div>
        {enforced ? (
          <p className="text-fg-muted">
            {/* signin.sso.required (I-30): no catalog key yet */}
            Required for <bdi>{domain}</bdi> addresses.
          </p>
        ) : null}
      </div>
      <div className="space-y-3">
        <Button
          asChild
          size="lg"
          className="h-12 w-full text-base font-semibold"
        >
          <a
            href={connectionHref(connection.id, email)}
            onClick={() => stashCarriedKey()}
          >
            {t("signin.continue")}
            <ArrowRight aria-hidden />
          </a>
        </Button>
        {enforced ? null : (
          <Button
            ref={codeRef}
            variant="outline"
            size="lg"
            className="h-12 w-full text-base font-semibold"
            loading={sending}
            disabledReason={wait > 0 ? `Wait ${clock}` : undefined}
            aria-describedby={error ? errorId : undefined}
            iconStart={<Mail aria-hidden />}
            onClick={() => void sendCode()}
          >
            {wait > 0
              ? // signin.sso.codeIn (I-30): no catalog key yet
                `Email me a code in ${clock}`
              : // signin.sso.code (I-30): no catalog key yet
                "Email me a code instead"}
          </Button>
        )}
        {error ? (
          <p id={errorId} role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * "This account can't sign in" (SIGN-IN.md §3.13, Account disabled), where the code step ends
 * for a disabled account: the address names the account, so only another address (or another way
 * to sign in) goes anywhere. No Continue, no resend.
 */
function RefusedStep({
  email,
  onChangeEmail,
}: {
  email: string;
  onChangeEmail: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="space-y-2">
        {/* signin.disabled.title */}
        <Title>This account can't sign in</Title>
        <p className="text-fg">
          {/* signin.disabled.lede */}
          <span className="font-medium text-fg-strong">{email}</span> belongs to
          an account that can't sign in. Try a different email or another way to
          sign in.
        </p>
      </div>
      <Button
        size="lg"
        className="h-12 w-full text-base font-semibold"
        onClick={onChangeEmail}
      >
        {t("signin.code.differentEmail")}
      </Button>
    </>
  );
}

function KeyStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: (key: string) => void;
}): React.ReactElement {
  const [key, setKey] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const check = checkKey(key);
  const verdict = touched ? formatVerdict(check) : null;
  return (
    <>
      <div className="space-y-2">
        {/* The on-ramp keeps the link's words as its title. */}
        <Title>{t("signin.link.key")}</Title>
        <p className="text-fg-muted">
          {/* signin.key.onrampLede */}
          Paste the key from your receipt email. Sign in next, and it joins your
          library.
        </p>
      </div>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (check.kind === "valid") onContinue(key);
        }}
      >
        <KeyField
          id="pk-signin-key"
          value={key}
          valid={check.kind === "valid"}
          verdict={
            verdict ? { tone: "danger", message: verdict.message } : null
          }
          onBlur={() => setTouched(true)}
          onChange={(v, how) => {
            setKey(v);
            if (how === "paste") setTouched(true);
          }}
          hint={
            check.kind === "valid" ? (
              <p className="text-sm text-fg-muted">
                Key for{" "}
                <span className="font-medium text-fg-strong">
                  {productLabel(check.slug)}
                </span>
              </p>
            ) : null
          }
          help="Starts with pkey_. Case-sensitive."
        />
        <Button
          type="submit"
          size="lg"
          className="h-12 w-full text-base font-semibold"
          iconEnd={<ArrowRight aria-hidden />}
        >
          {t("signin.continue")}
        </Button>
      </form>
      <QuietLinks>
        <QuietLink onClick={onBack}>{t("signin.replace.back")}</QuietLink>
      </QuietLinks>
    </>
  );
}
