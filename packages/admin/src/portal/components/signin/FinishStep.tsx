import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, User } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Input } from "../../../ui/Input.js";
import {
  AuthTitle,
  CODE_LENGTH,
  CodeCells,
  QuietLink,
  useStepFocus,
} from "../../../ui/auth/index.js";
import { t, tParts } from "../../../lib/copy.js";
import {
  portalApi,
  PortalApiError,
  type PortalGate,
  type PortalGateChoice,
} from "../../api.js";
import { portalErrorCopy } from "../../errors.js";
import { portalKeys } from "../../data.js";
import { rememberNudge, rememberVia } from "../../lastMethod.js";
import { announceSignedIn } from "../../session.js";
import { wrongCodeText } from "../../copy/codeEntry.js";
import { initialsOf } from "../Avatar.js";
import {
  AppleGlyph,
  GoogleGlyph,
  SteamGlyph,
} from "../../../ui/auth/ProviderGlyphs.js";

/**
 * FinishStep (SIGN-IN.md §3.5, I-27 §2.4; API I-33): a new account finishes in one step that asks,
 * in this order, only what the account lacks: the email (a code unless the provider vouches for
 * it), the screen name with the provider's picture, a birth date only when a source offered one,
 * and the terms. **EmailGateStep** is a provider's first sign-in; **RegisterStep** is an email
 * code's ("Create your account", the address already proven). Nothing is issued before the gate
 * passes: Cancel sign-in abandons it. A proven address another account uses becomes the join
 * offer, never a silent join.
 */
type Phase =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "error"; error: unknown }
  | { kind: "gate"; gate: PortalGate };

const NAME: Record<string, string> = {
  apple: "Apple",
  google: "Google",
  steam: "Steam",
  email: "email",
};
function providerName(kind: string): string {
  return NAME[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

function safeHref(url: string): string | null {
  return /^https:\/\//.test(url) || url.startsWith("/") ? url : null;
}

function ProviderMark({ kind }: { kind: string }): React.ReactElement | null {
  const c = "size-5 shrink-0";
  return kind === "apple" ? (
    <AppleGlyph className={c} />
  ) : kind === "google" ? (
    <GoogleGlyph className={c} />
  ) : kind === "steam" ? (
    <SteamGlyph className={c} />
  ) : null;
}

/** A terms link that opens in a new tab: a 44 px target, named for what it opens. */
function TermsLink({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}): React.ReactElement {
  const href = safeHref(url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex min-h-11 items-center underline decoration-2 underline-offset-4"
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

/** "I agree to the {term}" with the link filling the slot (a catalog sentence, a real link). */
function TermsSentence({
  sentence,
  url,
  label,
}: {
  sentence: "signin.gate.productTerms" | "signin.gate.platformTerms";
  url: string;
  label: string;
}): React.ReactElement {
  return (
    <>
      {tParts(sentence, ["term"]).map((part, i) =>
        typeof part === "string" ? (
          <React.Fragment key={i}>{part}</React.Fragment>
        ) : (
          <TermsLink key={i} url={url}>
            {label}
          </TermsLink>
        ),
      )}
    </>
  );
}

export function FinishStep({
  onLeave,
  onExpired,
  onTitle,
}: {
  /** Cancel sign-in: back to the methods. */
  onLeave: () => void;
  /** The gate is gone (15 minutes, or never opened): back to the methods with a notice. */
  onExpired: () => void;
  /** The page's document title for the view on screen. */
  onTitle?: (title: string) => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const [phase, setPhase] = React.useState<Phase>({ kind: "loading" });

  const load = React.useCallback(async (): Promise<void> => {
    try {
      setPhase({ kind: "gate", gate: await portalApi.gate() });
    } catch (err) {
      if (
        err instanceof PortalApiError &&
        (err.status === 400 || err.status === 404)
      )
        return setPhase({ kind: "gone" });
      setPhase({ kind: "error", error: err });
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);
  React.useEffect(() => {
    if (phase.kind === "gone") onExpired();
  }, [phase.kind, onExpired]);

  /** The gate passed: the session is set; open where the person was going. */
  const passed = async (next: string, nudge?: boolean): Promise<void> => {
    const via = phase.kind === "gate" ? phase.gate.provider : null;
    if (
      via === "apple" ||
      via === "google" ||
      via === "steam" ||
      via === "email"
    )
      rememberVia(via);
    // "Add another way to sign in" (PX-15 shows it): kept, never dropped.
    if (nudge) rememberNudge();
    announceSignedIn();
    // The finish landing is a query on the root; go to where the sign-in began.
    const target = next && next !== "/?signin=confirm-email" ? next : "/";
    try {
      const url = new URL(target, window.location.origin);
      if (url.origin === window.location.origin)
        window.history.replaceState(
          null,
          "",
          url.pathname + url.search + url.hash,
        );
    } catch {
      window.history.replaceState(null, "", "/");
    }
    await qc.invalidateQueries({ queryKey: portalKeys.me });
  };

  const cancel = async (): Promise<void> => {
    try {
      await portalApi.gateCancel();
    } catch {
      // Already gone: the same end.
    }
    onLeave();
  };

  if (phase.kind === "loading" || phase.kind === "gone")
    return (
      <div
        aria-busy
        role="status"
        aria-label={t("common.loading")}
        className="space-y-5"
      >
        <div aria-hidden className="h-8 w-2/3 rounded-md bg-hover" />
        <div aria-hidden className="h-24 rounded-md bg-hover" />
        <div aria-hidden className="h-12 rounded-md bg-hover" />
      </div>
    );
  if (phase.kind === "error")
    return <GateUnreachable error={phase.error} onRetry={() => void load()} />;
  return (
    <FinishForm
      gate={phase.gate}
      reload={load}
      onPassed={passed}
      onCancel={() => void cancel()}
      onTitle={onTitle}
    />
  );
}

/** The gate could not be read: what happened, and one ink primary to ask again. */
function GateUnreachable({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const copy = portalErrorCopy(error, { account: true });
  const { ref, live } = useStepFocus("error");
  return (
    <div ref={ref} className="space-y-5">
      <div className="space-y-2">
        <AuthTitle>{copy.title}</AuthTitle>
        <p className="text-fg-muted">{copy.description}</p>
      </div>
      <Button
        variant="neutral"
        size="lg"
        className="h-12 w-full text-base font-semibold"
        onClick={onRetry}
      >
        {t("signin.retry")}
      </Button>
      {live}
    </div>
  );
}

type FieldError = { field: "email" | "terms" | "code" | "form"; text: string };

function FinishForm({
  gate,
  reload,
  onPassed,
  onCancel,
  onTitle,
}: {
  gate: PortalGate;
  reload: () => Promise<void>;
  onPassed: (next: string, nudge?: boolean) => Promise<void>;
  onCancel: () => void;
  onTitle?: (title: string) => void;
}): React.ReactElement {
  const provider = providerName(gate.provider);
  const register = gate.provider === "email";
  const providerEmail = gate.email.provider;
  const vouched = Boolean(providerEmail && gate.email.providerVerified);
  const [way, setWay] = React.useState<"provider" | "typed">(
    providerEmail ? "provider" : "typed",
  );
  const [typed, setTyped] = React.useState("");
  /** Back from the code or the join offer to the email choice (the next choose replaces it). */
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(gate.profile.name ?? "");
  const [initials, setInitials] = React.useState(
    gate.profile.initials === true,
  );
  const [birth, setBirth] = React.useState(false);
  const [product, setProduct] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<FieldError | null>(null);
  const errorId = React.useId();
  const nameId = React.useId();
  const emailId = React.useId();
  const codeId = React.useId();
  const emailRef = React.useRef<HTMLInputElement>(null);
  const termsRef = React.useRef<HTMLButtonElement>(null);

  const emailAsked = gate.emailRequired;
  const productTerms = gate.terms;
  const platformTerms = gate.platformTerms ?? null;
  const needsCode = emailAsked && !(way === "provider" && vouched);
  // The strip names who signed in once: the address is the radio's job when there is one.
  const identity = providerEmail
    ? null
    : (gate.email.confirmed ?? gate.profile.name ?? null);
  const view =
    editing && gate.stage !== "choose"
      ? "choose"
      : gate.stage === "join_offer"
        ? "join"
        : gate.stage === "code_sent"
          ? "code"
          : "choose";
  const { ref, live } = useStepFocus(`${view}:${gate.stage}`);

  const title =
    view === "join"
      ? t("signin.gate.joinTitle")
      : view === "code"
        ? t("signin.code.title")
        : register
          ? t("signin.register.title")
          : emailAsked
            ? t("signin.gate.title")
            : t("signin.gate.termsTitle");
  React.useEffect(() => {
    onTitle?.(view === "join" ? t("signin.register.title") : title);
  }, [title, view, onTitle]);

  // The first arrival takes focus on the heading, like a step change.
  React.useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>("h1")
      ?.focus({ preventScroll: true });
  }, [ref]);

  /** Show `text` under its field and move focus there. */
  const fail = (field: FieldError["field"], text: string): void => {
    setError({ field, text });
    requestAnimationFrame(() => {
      if (field === "email") emailRef.current?.focus();
      else if (field === "terms") termsRef.current?.focus();
    });
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      // Every refusal is worded here, from the catalog; the Worker's prose never reaches the page.
      if (err instanceof PortalApiError) {
        if (err.status === 409 || err.code === "email_in_use") {
          setEditing(false);
          return void (await reload());
        }
        if (err.code === "terms_required")
          return fail("terms", t("core.codes.terms_required.message"));
        if (err.code === "invalid_code")
          return fail("code", wrongCodeText(err.triesLeft));
        if (err.status === 422) return fail("email", t("signin.email.invalid"));
        if (err.status === 429) return fail("form", t("signin.rateLimitedFew"));
        if (err.status === 400) return void (await reload());
      }
      fail("form", t("signin.approve.failed"));
    } finally {
      setBusy(false);
    }
  };

  const body = (): PortalGateChoice => {
    const out: PortalGateChoice = {};
    if (emailAsked) {
      out.choice = way;
      if (way === "typed") out.email = typed.trim();
    }
    const n = name.trim();
    if (n) out.name = n;
    if (gate.profile.picture) out.picture = initials ? "initials" : "provider";
    if (gate.profile.birthdate && birth)
      out.birthdate = gate.profile.birthdate.value;
    if (productTerms) out.termsVersion = productTerms.version;
    if (platformTerms) out.platformTermsVersion = platformTerms.version;
    return out;
  };

  /** Back to the email choice with "a different email" selected and the address kept. */
  const editEmail = (from: string | null): void => {
    setWay("typed");
    setTyped(from ?? "");
    setCode("");
    setError(null);
    setEditing(true);
  };

  const pending = gate.email.pending ?? gate.join?.email ?? null;
  const primaryClass = "h-12 w-full text-base font-semibold";

  // The join offer replaces the step (§3.5).
  if (view === "join") {
    const email = gate.join?.email ?? "";
    return (
      <div ref={ref} className="space-y-5">
        <div className="space-y-2">
          <AuthTitle>{title}</AuthTitle>
          <p className="text-fg-muted [overflow-wrap:anywhere]">
            {t("signin.gate.joinLede", { email })}
          </p>
          {gate.join?.proven ? null : (
            <p className="text-sm text-fg-muted">
              {t("signin.gate.joinProve")}
            </p>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error.text}
          </p>
        ) : null}
        <div className="space-y-3">
          {gate.join?.proven ? (
            <Button
              variant="neutral"
              size="lg"
              className={primaryClass}
              loading={busy}
              onClick={() =>
                void run(async () => {
                  const out = await portalApi.gateJoin();
                  await onPassed(out.next, out.nudge);
                })
              }
            >
              {t("signin.gate.join")}
            </Button>
          ) : null}
          <Button
            variant={gate.join?.proven ? "ghost" : "neutral"}
            size="lg"
            className={primaryClass}
            disabled={busy}
            onClick={emailAsked ? () => editEmail(pending) : onCancel}
          >
            {emailAsked
              ? t("signin.code.differentEmail")
              : t("signin.gate.cancel")}
          </Button>
        </div>
        {live}
      </div>
    );
  }

  const lede =
    gate.product?.name && !register
      ? t("signin.gate.ledeApp", { app: gate.product.name })
      : null;

  // The code for a typed or unvouched address.
  if (view === "code") {
    const to = gate.email.pending ?? "";
    return (
      <div ref={ref} className="space-y-5">
        <div className="space-y-2">
          <AuthTitle>{title}</AuthTitle>
          <p className="text-fg-muted [overflow-wrap:anywhere]">
            {t("signin.gate.codeSent", { email: to })}
          </p>
        </div>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === CODE_LENGTH)
              void run(async () => {
                const out = await portalApi.gateVerify(code);
                await onPassed(out.next, out.nudge);
              });
          }}
        >
          <CodeCells
            id={codeId}
            value={code}
            invalid={error?.field === "code"}
            describedBy={error ? errorId : undefined}
            onChange={(v) => {
              setCode(v);
              setError(null);
            }}
          />
          <div className="min-h-5">
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-danger">
                {error.text}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            variant="neutral"
            size="lg"
            className={primaryClass}
            disabled={code.length !== CODE_LENGTH}
            loading={busy}
          >
            {t("signin.gate.verify")}
          </Button>
        </form>
        <div className="flex flex-wrap items-center justify-center gap-x-5">
          <QuietLink
            onClick={() =>
              void run(
                async () =>
                  void (await portalApi.gateChoose({
                    ...body(),
                    choice: "typed",
                    email: to,
                  })),
              )
            }
          >
            {t("signin.code.resend")}
          </QuietLink>
          <QuietLink onClick={() => editEmail(to)}>
            {t("signin.code.differentEmail")}
          </QuietLink>
          <QuietLink onClick={onCancel}>{t("signin.gate.cancel")}</QuietLink>
        </div>
        {live}
      </div>
    );
  }

  const primary = register
    ? t("signin.register.submit")
    : !emailAsked
      ? t("signin.continue")
      : needsCode
        ? t("signin.gate.sendCode")
        : t("signin.continue");
  const suggestions = (gate.profile.suggestions ?? []).filter(
    (s) => s.name !== name,
  );
  const initialsText = name.trim() ? initialsOf(name, null) : null;
  const radio =
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border-strong px-3 py-2 text-sm has-[:checked]:border-fg-strong";
  const emailInvalid = error?.field === "email";

  return (
    <div ref={ref} className="space-y-5">
      {register ? null : (
        <div
          data-gate-strip
          className="flex items-center gap-3 rounded-md border border-success-border bg-success-subtle px-3 py-2.5 text-sm text-fg"
        >
          <ProviderMark kind={gate.provider} />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {identity
              ? t("signin.gate.strip", { provider, identity })
              : t("signin.gate.stripNoIdentity", { provider })}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-success">
            <Check aria-hidden className="size-4" />
            {t("common.done")}
          </span>
        </div>
      )}
      <div className="space-y-2">
        <AuthTitle>{title}</AuthTitle>
        {register ? (
          <p role="status" className="text-fg-muted [overflow-wrap:anywhere]">
            {t("signin.register.verified", {
              email: gate.email.confirmed ?? "",
            })}
          </p>
        ) : lede ? (
          <p className="text-fg-muted">{lede}</p>
        ) : null}
      </div>
      <form
        noValidate
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            emailAsked &&
            way === "typed" &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed.trim())
          )
            return fail("email", t("signin.email.invalid"));
          if (productTerms && !product)
            return fail("terms", t("core.codes.terms_required.message"));
          void run(async () => {
            const out = await portalApi.gateChoose(body());
            if (out.status === "signed_in")
              return onPassed(out.next, out.nudge);
            setEditing(false);
            await reload();
          });
        }}
      >
        <div className="rounded-lg border border-border bg-surface-sunken p-3">
          <div className="flex items-start gap-3">
            {gate.profile.picture && !initials ? (
              <img
                src={gate.profile.picture}
                alt=""
                width={40}
                height={40}
                className="mt-6 size-10 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="mt-6 inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-raised text-sm font-medium text-fg-strong"
              >
                {initialsText ?? <User className="size-5 text-fg-muted" />}
              </span>
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <label
                htmlFor={nameId}
                className="text-sm font-medium text-fg-strong"
              >
                {t("signin.gate.name")}
              </label>
              <Input
                id={nameId}
                value={name}
                onValueChange={setName}
                maxLength={64}
                autoComplete="name"
                className="h-12 text-base"
              />
              {suggestions.length > 0 ? (
                <ul
                  className="flex flex-wrap gap-2"
                  aria-label={t("signin.gate.name")}
                >
                  {suggestions.map((s) => (
                    <li key={s.name}>
                      <button
                        type="button"
                        onClick={() => setName(s.name)}
                        className="min-h-11 rounded-full border border-border-strong px-3 text-sm text-fg-strong hover:bg-hover"
                      >
                        {s.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-sm text-fg-muted">
                {gate.profile.picture
                  ? t("signin.profile.source", { provider })
                  : gate.provider === "apple"
                    ? t("signin.profile.applePicture")
                    : null}{" "}
                {gate.profile.picture ? (
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center font-medium text-fg-strong underline decoration-2 underline-offset-4"
                    onClick={() => setInitials(!initials)}
                  >
                    {initials
                      ? t("signin.gate.pictureProvider", { provider })
                      : t("signin.gate.pictureInitials")}
                  </button>
                ) : null}
              </p>
            </div>
          </div>
        </div>
        {emailAsked ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-fg-strong">
              {t("signin.email.label")}
            </legend>
            {providerEmail ? (
              <>
                <label className={radio}>
                  <input
                    type="radio"
                    name="pk-gate-email"
                    className="accent-action"
                    checked={way === "provider"}
                    onChange={() => {
                      setWay("provider");
                      setError(null);
                    }}
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <bdi>
                      {t("signin.gate.useEmail", { email: providerEmail })}
                    </bdi>
                    {gate.email.relay ? (
                      <span className="block text-fg-muted">
                        {t("signin.gate.relay")}
                      </span>
                    ) : null}
                  </span>
                </label>
                <label className={radio}>
                  <input
                    type="radio"
                    name="pk-gate-email"
                    className="accent-action"
                    checked={way === "typed"}
                    onChange={() => setWay("typed")}
                  />
                  {t("signin.code.differentEmail")}
                </label>
              </>
            ) : null}
            {way === "typed" ? (
              <div className="space-y-1.5">
                {providerEmail ? null : (
                  <label htmlFor={emailId} className="sr-only">
                    {t("signin.email.label")}
                  </label>
                )}
                <Input
                  id={emailId}
                  ref={emailRef}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder={t("signin.email.placeholder")}
                  value={typed}
                  onValueChange={(v) => {
                    setTyped(v);
                    if (emailInvalid) setError(null);
                  }}
                  className="h-12 text-base"
                  aria-invalid={emailInvalid || undefined}
                  aria-describedby={
                    [
                      gate.provider === "steam" ? `${emailId}-help` : null,
                      emailInvalid ? errorId : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                />
                {gate.provider === "steam" ? (
                  <p id={`${emailId}-help`} className="text-sm text-fg-muted">
                    {t("signin.gate.steam")}
                  </p>
                ) : null}
                <div className="min-h-5">
                  {emailInvalid ? (
                    <p
                      id={errorId}
                      role="alert"
                      className="text-sm text-danger"
                    >
                      {error?.text}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </fieldset>
        ) : null}
        {gate.profile.birthdate ? (
          <Checkbox
            checked={birth}
            onCheckedChange={setBirth}
            label={t("signin.gate.birthdate", {
              org: gate.profile.birthdate.from,
            })}
            description={t("signin.gate.birthdateHelp")}
          />
        ) : null}
        {productTerms ? (
          <div>
            <Checkbox
              ref={termsRef}
              checked={product}
              onCheckedChange={(v) => {
                setProduct(v);
                if (error?.field === "terms") setError(null);
              }}
              aria-invalid={error?.field === "terms" || undefined}
              aria-describedby={error?.field === "terms" ? errorId : undefined}
              label={
                <TermsSentence
                  sentence="signin.gate.productTerms"
                  url={productTerms.url}
                  label={t("signin.gate.termsLinkProduct", {
                    product: gate.product?.name ?? "",
                  })}
                />
              }
            />
            <div className="min-h-5">
              {error?.field === "terms" ? (
                <p id={errorId} role="alert" className="text-sm text-danger">
                  {error.text}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {platformTerms ? (
          <p className="text-sm text-fg-muted">
            <TermsSentence
              sentence="signin.gate.platformTerms"
              url={platformTerms.url}
              label={t("signin.gate.termsLinkPlatform")}
            />
          </p>
        ) : null}
        <div className="min-h-5">
          {error?.field === "form" ? (
            <p role="alert" className="text-sm text-danger">
              {error.text}
            </p>
          ) : null}
        </div>
        <Button
          type="submit"
          variant="neutral"
          size="lg"
          className={primaryClass}
          loading={busy}
        >
          {primary}
        </Button>
        <div className="flex justify-center">
          <QuietLink onClick={onCancel}>{t("signin.gate.cancel")}</QuietLink>
        </div>
      </form>
      {live}
    </div>
  );
}
