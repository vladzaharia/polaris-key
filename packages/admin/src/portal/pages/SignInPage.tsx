import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Building2,
  Fingerprint,
  KeyRound,
  Mail,
  ScanLine,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { t, tParts } from "../../lib/copy.js";
import { expiredCodeText, wrongCodeText } from "../copy/codeEntry.js";
import {
  portalApi,
  HttpError,
  type PortalCapabilities,
  type PortalConnection,
  type PortalEmailSent,
  type PortalSignInFlow,
  type PortalSsoNext,
} from "../api.js";
import {
  AuthCard,
  AuthTitle as Title,
  CardHeader,
  HeaderSkeleton,
  usePassport,
  CodeEntry,
  type CodeResendOutcome,
  type CodeVerifyOutcome,
  OrDivider as Divider,
  ProviderRow,
  QuietAnchor,
  QuietLink,
  QuietLinks,
} from "../../ui/auth/index.js";
import { HELP_LINKS } from "../helpLinks.js";
import { LegalNav } from "../components/signin/LegalNav.js";
import { AuthLockup } from "../components/Lockup.js";
import { ProductIcon } from "../components/ProductIcon.js";
import { KeyField } from "../components/KeyField.js";
import { useCapabilities, useStorefrontName } from "../data.js";
import { portalErrorCopy, ssoNextOf } from "../errors.js";
import {
  blocksResend,
  checkKey,
  claimVerdict,
  formatVerdict,
  previewVerdict,
  productLabel,
  type KeyVerdict,
} from "../model/key.js";
import { setParams, useDocumentTitle, useRoute } from "../router.js";
import { FinishStep } from "../components/signin/FinishStep.js";
import { DeviceStep } from "../components/signin/DeviceStep.js";
import { passkeysSupported } from "../webauthn.js";
import { rememberVia, readLastMethod, type LastMethod } from "../lastMethod.js";
import { usePasskeySignIn } from "../components/signin/usePasskeySignIn.js";
import { HintStep } from "../components/signin/HintStep.js";
import { useSessionRecheck } from "../session.js";
import { returnUrl, stashCarriedKey } from "../carriedKey.js";
import type { KeyPreview } from "../api.js";
import { AccountUpgrade } from "../components/signin/AccountUpgrade.js";
import {
  RequestFooter,
  RequestHeader,
} from "../components/signin/RequestHeader.js";
import { requestHandleFromUrl } from "../model/signInRequest.js";
import { useSignInRequest } from "../requestData.js";
import { qk } from "../queries.js";
import { mutate } from "../mutations.js";

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
  | {
      kind: "code";
      email: string;
      resendIn: number;
      /** The address is the Worker's mask (a resumed flow): it names the inbox, so it is never
       *  put back in the email field. */
      masked?: boolean;
    }
  /** The expired-link page's "Send a new code" landed here (`?signin=code`): the flow is read. */
  | { kind: "resume" }
  /** The code was right but its account can't sign in (§3.13, Account disabled): a dead end
   *  for that address, so the step ends here (PS-05 review M3). */
  | { kind: "refused"; email: string }
  /** I-30: the address's domain routes to a connection (`next` from the start or a refusal). */
  | { kind: "sso"; email: string; next: PortalSsoNext }
  | { kind: "key" }
  /** AccountUpgrade (§3.9, PX-12): what the previewed key leads to, before sign-in. */
  | { kind: "upgrade"; key: string; preview: KeyPreview }
  /** Sign in with another device (§3.11): this browser asks, a signed-in device approves. */
  | { kind: "device" }
  /** FinishStep (§3.5): a provider's first sign-in, or a new address's code, finishes here. */
  | { kind: "finish" }
  /** HintStep (§3.4): the typed address is the one this browser last signed in with. */
  | { kind: "hint"; email: string; last: LastMethod };

/** The countdown when an answer carries no `resendIn` (a Worker from before PX-W4). */
const RESEND_FALLBACK_S = 60;

/** Seconds until "Send a new code", from the start's or the resend's answer. */
function resendDelay(out: { resendIn?: number } | undefined): number {
  const n = out?.resendIn;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.ceil(n)
    : RESEND_FALLBACK_S;
}

/**
 * The brand row (SIGN-IN.md §3.1): the Locker lockup, 23 px on a phone and 26 px from `sm` (BRAND.md §1.4), the same as
 * the Worker's pages; muted in an app or product context so the product reads first. The size
 * never changes between steps.
 */
function AuthBrand({ muted }: { muted: boolean }): React.ReactElement {
  return (
    <span className={muted ? "text-fg-muted opacity-80" : undefined}>
      <AuthLockup />
    </span>
  );
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
function connectionHref(id: string, email?: string, product?: string): string {
  const hint = email && EMAIL_RE.test(email) ? email : null;
  // B-063: a card opened for a product signs in through it, so its terms are asked.
  return `/login/sso/${encodeURIComponent(id)}?${
    hint ? `login_hint=${encodeURIComponent(hint)}&` : ""
  }return_to=${encodeURIComponent(returnTo())}${
    product ? `&product=${encodeURIComponent(product)}` : ""
  }`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The key the on-ramp (or an `/activate#key=…` link) is carrying through sign-in, if valid. */
function useCarriedKey(): string | null {
  const route = useRoute();
  const key = "params" in route ? route.params.get("activate") : null;
  return key && checkKey(key).kind === "valid" ? key : null;
}

export function SignInPage({
  other,
}: {
  /** The join's second proof (linkSecond.ts): signed in already, signing in to the other account. */
  other?: { onCancel: () => void; email?: string };
} = {}): React.ReactElement {
  const [urlProduct] = React.useState(productFromUrl);
  // An app's sign-in (`/signin?request=rq_…`, PX-14a): the header is the request's data, and the
  // product is the request's, never a query value.
  const [handle] = React.useState(requestHandleFromUrl);
  const request = useSignInRequest(handle);
  const product = urlProduct ?? request.data?.client.product ?? null;
  const caps = useCapabilities(product);
  const identityOff =
    new URLSearchParams(window.location.search).get("error") ===
    "identity_disabled";
  const [step, setStep] = React.useState<Step>(() => {
    const signin = new URLSearchParams(window.location.search).get("signin");
    // A front door's redirect (`/?signin=confirm-email`) opens the finish step; the Worker's
    // expired-link page (`?signin=code`) lands on the code step it just sent.
    return signin === "confirm-email"
      ? { kind: "finish" }
      : signin === "code" && !other
        ? { kind: "resume" }
        : { kind: "methods", email: other?.email };
  });
  const [direction, setDirection] = React.useState<"forward" | "back">(
    "forward",
  );
  const go = (next: Step, dir: "forward" | "back" = "forward"): void => {
    setDirection(dir);
    setStep(next);
  };
  useSessionRecheck(step.kind === "code");
  /** Bumped by Try again: the heading that follows the reload takes focus. */
  const [focusTick, setFocusTick] = React.useState(0);
  /** The finish step's own title (it differs per view). */
  const [finishTitle, setFinishTitle] = React.useState<string>(
    t("signin.register.title"),
  );
  // Escape backs out of the steps that have somewhere to go back to.
  React.useEffect(() => {
    if (!["key", "upgrade", "code", "device", "hint"].includes(step.kind))
      return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      go(
        step.kind === "code" || step.kind === "hint"
          ? {
              kind: "methods",
              email:
                step.kind === "code" && step.masked ? undefined : step.email,
              focusEmail: true,
            }
          : step.kind === "upgrade"
            ? { kind: "key" }
            : { kind: "methods" },
        "back",
      );
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  // A request that is gone (expired, unknown, Identity off, no binder) has nothing to sign in to.
  const requestGone =
    handle !== null &&
    request.error instanceof HttpError &&
    request.error.status === 404;
  useDocumentTitle(
    requestGone
      ? t("signin.request.goneTitle")
      : step.kind === "code"
        ? t("signin.code.title")
        : step.kind === "refused"
          ? t("signin.refused.title")
          : step.kind === "hint"
            ? t("signin.hint.welcomeNoName")
            : step.kind === "finish"
              ? finishTitle
              : step.kind === "device"
                ? t("signin.approve.title")
                : step.kind === "key"
                  ? t("signin.link.key")
                  : step.kind === "upgrade"
                    ? t(
                        step.preview.upgrade === "forced"
                          ? "signin.key.noEntriesTitle"
                          : "signin.key.upgradeTitle",
                        { product: step.preview.product.name },
                      )
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
  const passport = usePassport();
  // The key on-ramp works without an account: it keeps the product header, not "wants you to sign
  // in" (§3.1). Every other step of an app's request keeps the request's header and footer.
  const onRamp = step.kind === "key" || step.kind === "upgrade";
  // While an app's request loads the card already has the passport's width (no jump when the
  // header arrives); a loaded request builds the header, on-ramp included, from the request alone.
  const header = requestGone ? undefined : handle !== null &&
    request.isPending ? (
    <HeaderSkeleton />
  ) : handle !== null && request.data ? (
    <RequestHeader view={request.data} onRamp={onRamp} />
  ) : ctx ? (
    <CardHeader
      variant="context"
      icon={
        <ProductIcon
          slug={ctx.slug}
          name={ctx.name}
          tint={null}
          size={passport ? 56 : 48}
          neutral
        />
      }
      art={ctx.artUrl ?? null}
      name={ctx.name}
      developer={ctx.developerName ?? null}
    />
  ) : undefined;

  const requestFailed =
    handle !== null && request.error !== null && !requestGone;
  const stepKey =
    handle !== null && request.isPending
      ? "loading"
      : requestGone
        ? "gone"
        : caps.isPending
          ? "loading"
          : caps.error || requestFailed
            ? "unreachable"
            : (ssoKey ?? step.kind);

  const legalNav = <LegalNav />;

  return (
    <AuthCard
      brand={<AuthBrand muted={Boolean(ctx) || handle !== null} />}
      focusKey={focusTick}
      header={header}
      receipt={
        !other && handle !== null && Boolean(request.data) && !requestGone
      }
      footer={
        other ? (
          <Button
            variant="outline"
            className="w-full max-sm:min-h-11"
            onClick={other.onCancel}
          >
            {t("common.cancel")}
          </Button>
        ) : handle !== null && request.data && !requestGone ? (
          <RequestFooter view={request.data} />
        ) : undefined
      }
      after={
        !other && !(handle !== null && request.isPending) ? legalNav : undefined
      }
      stepKey={stepKey}
      direction={direction}
    >
      {(handle !== null && request.isPending) || caps.isPending ? (
        <MethodsSkeleton />
      ) : requestGone ? (
        <>
          <div className="space-y-2">
            <Title>{t("signin.request.goneTitle")}</Title>
            <p className="text-fg-muted">{t("signin.request.gone")}</p>
          </div>
          <Button
            asChild
            variant="neutral"
            size="lg"
            className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
          >
            <a href="/">{t("signin.return.library")}</a>
          </Button>
        </>
      ) : caps.error || requestFailed ? (
        <Unreachable
          error={caps.error ?? request.error}
          onRetry={() => {
            setFocusTick((n) => n + 1);
            void caps.refetch();
            void request.refetch();
          }}
        />
      ) : step.kind === "resume" ? (
        <ResumeStep
          onFlow={(flow) =>
            go(
              flow.next
                ? { kind: "sso", email: flow.email, next: flow.next }
                : {
                    kind: "code",
                    email: flow.email,
                    resendIn: resendDelay(flow),
                    masked: true,
                  },
            )
          }
          onGone={(notice) => go({ kind: "methods", notice }, "back")}
        />
      ) : step.kind === "code" ? (
        <CodeStep
          email={step.email}
          resendIn={step.resendIn}
          onChangeEmail={() =>
            go(
              {
                kind: "methods",
                email: step.masked ? undefined : step.email,
                focusEmail: true,
              },
              "back",
            )
          }
          onRefused={() => go({ kind: "refused", email: step.email })}
          onRouted={(next) => go({ kind: "sso", email: step.email, next })}
          onFinish={() => go({ kind: "finish" })}
          onExpired={() =>
            go(
              {
                kind: "methods",
                email: step.masked ? undefined : step.email,
                notice: t("signin.code.expiredRestart"),
              },
              "back",
            )
          }
        />
      ) : step.kind === "sso" ? (
        <SsoStep
          email={step.email}
          product={ctx?.slug}
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
                notice: t("signin.sso.expiredRestart"),
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
      ) : step.kind === "hint" ? (
        <HintStep
          email={step.email}
          last={step.last}
          passkeyAvailable={
            caps.data?.auth.passkey === true && passkeysSupported()
          }
          hrefFor={(p) =>
            `/login/${p}?return_to=${encodeURIComponent(returnTo())}${
              ctx ? `&product=${encodeURIComponent(ctx.slug)}` : ""
            }`
          }
          onProvider={(p) => {
            rememberVia(p);
            stashCarriedKey();
          }}
          onSent={(email, sent) =>
            go(
              sent?.next
                ? { kind: "sso", email, next: sent.next }
                : { kind: "code", email, resendIn: resendDelay(sent) },
            )
          }
          onOther={() =>
            go({ kind: "methods", email: step.email, focusEmail: true }, "back")
          }
          returnTo={returnTo}
        />
      ) : step.kind === "finish" ? (
        <FinishStep
          onTitle={setFinishTitle}
          nameHint={request.data?.nameHint}
          onLeave={() => {
            window.history.replaceState(null, "", "/");
            go({ kind: "methods" }, "back");
          }}
          onExpired={() => {
            window.history.replaceState(null, "", "/");
            go({ kind: "methods", notice: t("signin.gate.expired") }, "back");
          }}
        />
      ) : step.kind === "device" ? (
        <DeviceStep onOther={() => go({ kind: "methods" }, "back")} />
      ) : step.kind === "upgrade" ? (
        <AccountUpgrade
          preview={step.preview}
          cloudSync={request.data?.client.services.cloudSync === true}
          onCreate={() => {
            setParams({ activate: step.key });
            go({ kind: "methods" });
          }}
          onSignIn={() => {
            setParams({ activate: step.key });
            go({ kind: "methods" });
          }}
        />
      ) : step.kind === "key" ? (
        <KeyStep
          onBack={() => go({ kind: "methods" }, "back")}
          onContinue={(key) => {
            setParams({ activate: key });
            go({ kind: "methods" });
          }}
          onPreview={(key, preview) => go({ kind: "upgrade", key, preview })}
        />
      ) : (
        <MethodsStep
          caps={caps.data}
          context={ctx ?? null}
          initialEmail={step.email ?? request.data?.loginHint ?? undefined}
          focusEmail={step.focusEmail}
          notice={
            step.notice ??
            (identityOff && ctx
              ? t("signin.identityOff.notice", { product: ctx.name })
              : undefined)
          }
          onSent={(email, sent) =>
            go(
              sent?.next
                ? { kind: "sso", email, next: sent.next }
                : { kind: "code", email, resendIn: resendDelay(sent) },
            )
          }
          onKey={() => go({ kind: "key" })}
          onDevice={() => go({ kind: "device" })}
          onHint={(email, last) => go({ kind: "hint", email, last })}
          other={other ? { email: other.email } : undefined}
        />
      )}
    </AuthCard>
  );
}

/**
 * The expired-link page's "Send a new code" is a plain form POST; its answer lands here with
 * `?signin=code`. The flow is read (`GET /api/signin/flow`), the marker leaves the URL (so no
 * later return URL carries it), and the card moves to the code step with the masked address and
 * the Worker's `resendIn`. `returnTo` and the request handle are the page's own URL and the
 * flow's record. No live flow: the email step, with the reason.
 */
function ResumeStep({
  onFlow,
  onGone,
}: {
  onFlow: (flow: PortalSignInFlow) => void;
  onGone: (notice: string) => void;
}): React.ReactElement {
  const done = React.useRef(false);
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("signin")) {
      url.searchParams.delete("signin");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    let live = true;
    portalApi
      .readSignInFlow()
      .then((flow) => {
        if (live && !done.current) {
          done.current = true;
          onFlow(flow);
        }
      })
      .catch((err: unknown) => {
        if (!live || done.current) return;
        done.current = true;
        onGone(
          err instanceof HttpError && err.code === "signin_expired"
            ? t("signin.code.expiredRestart")
            : startErrorText(err),
        );
      });
    return () => {
      live = false;
    };
    // The read runs once, on landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <MethodsSkeleton />;
}

/** The card's loading state (§3.3): a skeleton at the final size, never a "Getting…" line. */
function MethodsSkeleton(): React.ReactElement {
  return (
    <div aria-busy className="space-y-5" data-testid="signin-skeleton">
      <span className="sr-only">{t("common.loading")}</span>
      <div aria-hidden className="h-8 w-2/3 rounded-md bg-hover" />
      <div aria-hidden className="space-y-1.5">
        <div className="h-4 w-12 rounded bg-hover" />
        <div className="h-12 rounded-md bg-hover" />
      </div>
      <div aria-hidden className="h-12 rounded-md bg-hover" />
    </div>
  );
}

function Unreachable({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const copy = portalErrorCopy(error, { account: true });
  return (
    <>
      <div className="space-y-2">
        <Title>{copy.title}</Title>
        <p className="text-fg-muted">{copy.description}</p>
      </div>
      <Button
        variant="neutral"
        size="lg"
        className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
        iconStart={<RefreshCw aria-hidden />}
        onClick={onRetry}
      >
        {t("signin.retry")}
      </Button>
    </>
  );
}

function startErrorText(err: unknown): string {
  if (err instanceof HttpError) {
    // The Worker's 429 carries no wait yet.
    if (err.status === 429 || err.code === "rate_limited")
      return t("signin.rateLimitedFew");
    if (err.code === "email_unavailable" || err.code === "email_not_configured")
      return t("signin.emailDown");
    if (err.status === 422) return t("signin.email.invalid");
    if (err.code === "auth_method_disabled") return t("signin.off.any");
    if (err.code === "turnstile_failed") return t("signin.turnstile.failed");
  }
  return portalErrorCopy(err).line;
}

/**
 * The storefront link's slug (`#/discover/<slug>`), from the URL only. The card names the product
 * only when `GET /api/storefront/<slug>` answers (LK-12d: a product Discover offers a new
 * account); a refusal or an error leaves the generic title, never a name made from the slug.
 */
const STOREFRONT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/i;
export function storefrontSlug(
  route: ReturnType<typeof useRoute>,
): string | null {
  return route.kind === "storefront" && STOREFRONT_SLUG.test(route.product)
    ? route.product
    : null;
}

function MethodsStep({
  caps,
  context,
  initialEmail,
  focusEmail,
  notice,
  onSent,
  onKey,
  onDevice,
  onHint,
  other,
}: {
  /** The join's second sign-in: its own title, and no way out to a key or a device. */
  other?: { email?: string };
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
  onDevice: () => void;
  /** The address matches this browser's last sign-in with a method the card still offers. */
  onHint: (email: string, last: LastMethod) => void;
}): React.ReactElement {
  /** The usual method is only a hint while this card still offers it. */
  const offers = (last: LastMethod): boolean =>
    last.kind === "passkey"
      ? caps.auth.passkey === true && passkeysSupported()
      : last.kind === "email"
        ? true
        : (caps.auth.providers ?? []).includes(last.kind);
  const pk = usePasskeySignIn(returnTo);
  const passkeyBusy = pk.busy;
  const passkeyError = pk.error;
  const withPasskey = pk.run;
  const startConditional = pk.conditional;
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
  const passkey = caps.auth.passkey === true && passkeysSupported();
  // Conditional UI: the email field's autofill offers this browser's passkeys.
  React.useEffect(
    () => (passkey ? startConditional() : undefined),
    [passkey, startConditional],
  );
  const providers = caps.auth.providers ?? [];
  const magic = caps.auth.magic;
  // With the email field, the address routes to its connection (identifier-first); the buttons
  // are for a card with no field to route through.
  const connections = magic ? [] : (caps.auth.connections ?? []);
  const oidc = caps.auth.oidc;
  const ssoLabel = t("signin.provider.continue", {
    provider: caps.auth.oidcName ?? t("signin.sso.name"),
  });
  const ssoHref = `/login?return_to=${encodeURIComponent(returnTo())}${
    context ? `&product=${encodeURIComponent(context.slug)}` : ""
  }`;

  if (!magic && !oidc && providers.length === 0 && connections.length === 0) {
    return (
      <>
        <Title>{t("signin.off.title")}</Title>
        <p className="text-fg-muted">
          {context
            ? t("signin.off.product", {
                product: context.name,
                developer: context.developerName ?? t("signin.off.developer"),
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
      // The usual way first, when this browser knows one for this address (never a server lookup).
      const last = await readLastMethod(value);
      if (last && last.kind !== "email" && offers(last)) {
        setSending(false);
        onHint(value, last);
        return;
      }
      onSent(value, await mutate("startEmailSignIn", value));
    } catch (err) {
      setError(startErrorText(err));
      if (err instanceof HttpError && err.status === 422) setInvalid(true);
    } finally {
      setSending(false);
    }
  };

  const carriedCheck = carried ? checkKey(carried) : null;
  const carriedName =
    carriedCheck?.kind === "valid" ? productLabel(carriedCheck.slug) : null;
  const storefront = useStorefrontName(
    context ? null : storefrontSlug(useRoute()),
  );
  const title = other
    ? other.email
      ? t("signin.join.again", { email: other.email })
      : t("signin.join.otherTitle")
    : carriedName
      ? t("signin.key.carriedTitle", { product: carriedName })
      : storefront
        ? t("signin.key.carriedTitle", { product: storefront.name })
        : context
          ? t("signin.methods.titleApp")
          : t("signin.methods.title");
  const lede = other
    ? t("signin.join.otherLede")
    : carriedName
      ? t("signin.key.carriedLede", { product: carriedName })
      : context
        ? t("signin.methods.ledeApp", { product: context.name })
        : null;

  return (
    <>
      <div className="space-y-2">
        {storefront && !carriedName && !other ? (
          <ProductIcon
            slug={storefront.name}
            name={storefront.name}
            tint={null}
            src={storefront.iconUrl}
            size={48}
            neutral
          />
        ) : null}
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
              placeholder={t("signin.email.placeholder")}
              autoFocus
              value={email}
              onValueChange={(v) => {
                setEmail(v);
                if (invalid) setInvalid(false);
              }}
              aria-invalid={invalid || undefined}
              aria-describedby={error ? errorId : undefined}
              className="h-12 text-base"
            />
            {/* B-067: no reserved line; it opens a 48 px gap above Continue. */}
            {error ? (
              <p id={errorId} role="alert" className="pt-1 text-sm text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            variant="neutral"
            size="lg"
            className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
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
        onNavigate={(p) => {
          rememberVia(p);
          stashCarriedKey();
        }}
      />
      {oidc ? (
        <Button
          asChild
          variant={magic || providers.length ? "secondary" : "neutral"}
          size="lg"
          className="h-auto min-h-12 w-full whitespace-normal py-2 text-center"
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
          href={connectionHref(c.id, undefined, context?.slug)}
          primary={!oidc && providers.length === 0 && c === connections[0]}
        />
      ))}
      {passkey ? (
        <div className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-medium"
            loading={passkeyBusy}
            onClick={() => void withPasskey()}
            iconStart={<Fingerprint aria-hidden />}
          >
            {t("signin.passkey")}
          </Button>
          {passkeyError ? (
            <p role="alert" className="text-center text-sm text-danger">
              {passkeyError}
            </p>
          ) : null}
        </div>
      ) : null}
      {!other && (carried || caps.modules.claim || magic) ? (
        <QuietLinks stacked>
          {carried ? (
            <QuietLink
              onClick={() => setParams({ activate: null })}
              icon={<KeyRound aria-hidden className="size-4" />}
            >
              {t("signin.key.withoutKey")}
            </QuietLink>
          ) : caps.modules.claim ? (
            <QuietLink
              onClick={onKey}
              icon={<KeyRound aria-hidden className="size-4" />}
            >
              {t("signin.link.key")}
            </QuietLink>
          ) : null}
          {magic ? (
            <QuietLink
              onClick={onDevice}
              icon={<ScanLine aria-hidden className="size-4" />}
            >
              {t("signin.link.anotherDevice")}
            </QuietLink>
          ) : null}
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
      variant={primary ? "neutral" : "secondary"}
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

function codeErrorText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.code === "invalid_code") {
      return wrongCodeText(err.triesLeft);
    }
    if (err.code === "signin_expired") return expiredCodeText();
    if (err.status === 429 || err.code === "rate_limited")
      return t("signin.code.rateLimited");
    // Worded here, from the catalog: the Worker's prose never reaches the page.
    if (err.code === "forbidden") return t("signin.refused.title");
    if (err.code === "email_in_use") return t("signin.code.emailInUse");
  }
  return portalErrorCopy(err).line;
}

function CodeStep({
  email,
  resendIn,
  onChangeEmail,
  onRefused,
  onRouted,
  onExpired,
  onFinish,
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
  /** A new address: the account is created in FinishStep (the verify answered `finish`). */
  onFinish: () => void;
}): React.ReactElement {
  const qc = useQueryClient();

  const verify = async (value: string): Promise<CodeVerifyOutcome | void> => {
    try {
      const out = await mutate("verifySignInCode", value);
      rememberVia("email");
      // A new address finishes first (I-33): the account is created there.
      if (out?.status === "finish") return void onFinish();
      await qc.invalidateQueries({ queryKey: qk.me() });
    } catch (err) {
      // I-30: the domain requires its connection now (enforced after this code was sent).
      const routed = ssoNextOf(err);
      if (routed) return void onRouted(routed);
      // The verify's other 403: a right code for an account that can't sign in (the Worker's
      // `forbidden`, §3.13). Another code or a resend would end the same way.
      if (err instanceof HttpError && err.status === 403)
        return void onRefused();
      return {
        error: codeErrorText(err),
        // Out of tries, or the code expired: "Send a new code" is the way on, at once.
        resendNow:
          err instanceof HttpError &&
          ((err.code === "invalid_code" && err.triesLeft === 0) ||
            err.code === "signin_expired"),
      };
    }
  };

  const resend = async (): Promise<CodeResendOutcome | void> => {
    try {
      const out = await mutate("resendSignInCode");
      return {
        status: { text: t("signin.code.resent", { email }), tone: "success" },
        wait: resendDelay(out),
      };
    } catch (err) {
      const routed = ssoNextOf(err);
      if (routed) return void onRouted(routed);
      if (err instanceof HttpError && err.code === "signin_expired")
        return void onExpired();
      if (
        err instanceof HttpError &&
        err.status === 429 &&
        err.retryAfter !== undefined
      )
        // Too soon (or this address's minute is spent): the countdown says when.
        return { wait: Math.max(1, Math.ceil(err.retryAfter)) };
      if (
        err instanceof HttpError &&
        err.status === 429 &&
        err.code === "rate_limited"
      )
        // The Worker's per-flow cap (its only 429 without a wait): the code already sent is the
        // one to use.
        return {
          capped: true,
          status: { text: t("signin.code.noMore"), tone: "muted" },
        };
      // Anything else, a bare 429 from the edge included: retry later, the link stays.
      return { error: startErrorText(err) };
    }
  };

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
      <CodeEntry
        resendIn={resendIn}
        submitLabel={t("signin.continue")}
        verify={verify}
        resend={resend}
        hint={t("signin.code.link")}
      >
        <QuietLink onClick={onChangeEmail}>
          {t("signin.code.differentEmail")}
        </QuietLink>
        <QuietAnchor href={HELP_LINKS.codeDidntArrive}>
          {t("signin.code.missing")}
        </QuietAnchor>
      </CodeEntry>
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
      <div className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border py-0.5 ps-3 pe-1 text-sm text-fg">
        <span className="flex min-w-0 max-w-full" title={email}>
          <bdi className="min-w-0 truncate">{local}</bdi>
          <bdi className="shrink-0">{host}</bdi>
        </span>
        <button
          type="button"
          onClick={onChange}
          aria-label={t("signin.code.changeEmail")}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full px-2 font-medium text-fg-strong underline decoration-2 underline-offset-4"
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
  product,
  onChangeEmail,
  onCode,
  onRouted,
  onExpired,
}: {
  email: string;
  next: PortalSsoNext;
  /** B-063: the product the card was opened for; the connection's sign-in carries it. */
  product?: string;
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
      onCode(resendDelay(await mutate("resendSignInCode")));
    } catch (err) {
      const routed = ssoNextOf(err);
      if (routed) {
        onRouted(routed);
        return;
      }
      if (err instanceof HttpError && err.code === "signin_expired") {
        onExpired();
        return;
      }
      if (
        err instanceof HttpError &&
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
          <Title>{t("signin.sso.title", { org: connection.label })}</Title>
        </div>
        {enforced ? (
          <p className="text-fg-muted">
            {t("signin.sso.required", { host: domain })}
          </p>
        ) : null}
      </div>
      <div className="space-y-3">
        <Button
          asChild
          variant="neutral"
          size="lg"
          className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
        >
          <a
            href={connectionHref(connection.id, email, product)}
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
            className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
            loading={sending}
            disabledReason={
              wait > 0 ? t("signin.sso.wait", { time: clock }) : undefined
            }
            aria-describedby={error ? errorId : undefined}
            iconStart={<Mail aria-hidden />}
            onClick={() => void sendCode()}
          >
            {wait > 0
              ? t("signin.sso.codeIn", { time: clock })
              : t("signin.sso.code")}
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
        <Title>{t("signin.refused.title")}</Title>
        <p className="text-fg">{t("signin.refused.lede", { email })}</p>
      </div>
      <Button
        variant="neutral"
        size="lg"
        className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
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
  onPreview,
}: {
  onBack: () => void;
  onContinue: (key: string) => void;
  /** The signed-out preview (PX-W9) found an addable key: AccountUpgrade says what it leads to. */
  onPreview: (key: string, preview: KeyPreview) => void;
}): React.ReactElement {
  const [key, setKey] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  /** A refusal from the preview, until the key changes (a retry-able one clears on the next send). */
  const [refused, setRefused] = React.useState<KeyVerdict | null>(null);
  const check = checkKey(key);
  const verdict =
    refused ??
    (touched
      ? key.trim() === ""
        ? { message: t("signin.key.empty") }
        : formatVerdict(check)
      : null);

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (check.kind !== "valid") {
      document.getElementById("pk-signin-key")?.focus();
      return;
    }
    if (refused && blocksResend(refused)) return;
    setChecking(true);
    setRefused(null);
    try {
      const preview = await mutate("previewKeySignedOut", key);
      if (preview.verdict === "addable") return onPreview(key, preview);
      if (preview.verdict === "portal_off") return onContinue(key);
      setRefused(
        previewVerdict(
          { verdict: preview.verdict, product: preview.product },
          preview.product.name,
        ),
      );
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      // A refusal the key itself earned (unknown, not a key, too many tries) is said under the
      // field. Anything else (offline, a Worker error) must
      // not strand the on-ramp: the key is carried through sign-in as it always was.
      if (status === 401 || status === 422 || status === 429)
        setRefused(claimVerdict({ status }, productLabel(check.slug)));
      else onContinue(key);
    } finally {
      setChecking(false);
    }
    document.getElementById("pk-signin-key")?.focus();
  };
  return (
    <>
      <div className="space-y-2">
        {/* The on-ramp keeps the link's words as its title. */}
        <Title>{t("signin.link.key")}</Title>
        <p className="text-fg-muted">{t("signin.key.onrampLede")}</p>
      </div>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
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
            setRefused(null);
            if (how === "paste") setTouched(true);
          }}
          hint={
            check.kind === "valid" ? (
              <p className="text-sm text-fg-muted">
                {t("signin.key.keyFor", { product: productLabel(check.slug) })}
              </p>
            ) : null
          }
          help={t("signin.key.help")}
        />
        <Button
          type="submit"
          variant="neutral"
          size="lg"
          loading={checking}
          className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
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
