import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, Lock, Mail, Upload } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Input } from "../../../ui/Input.js";
import {
  AuthTitle,
  CodeEntry,
  type CodeResendOutcome,
  type CodeVerifyOutcome,
  useStepFocus,
} from "../../../ui/auth/index.js";
import { cn } from "../../../lib/cn.js";
import { t, tParts } from "../../../lib/copy.js";
import {
  portalApi,
  PortalApiError,
  setPortalCsrf,
  type PortalGate,
  type PortalGateChoice,
} from "../../api.js";
import { portalErrorCopy } from "../../errors.js";
import { portalKeys } from "../../data.js";
import { rememberNudge, rememberVia } from "../../lastMethod.js";
import { announceSignedIn } from "../../session.js";
import { wrongCodeText } from "../../copy/codeEntry.js";
import { initialsOf } from "../Avatar.js";
import { createPasskey, passkeysSupported } from "../../webauthn.js";
import {
  AppleGlyph,
  GoogleGlyph,
  SteamGlyph,
} from "../../../ui/auth/ProviderGlyphs.js";

/**
 * FinishStep (identity.finish, SIGN-IN.md §3.5, I-27 §2.4; API I-33): every new account finishes
 * in this one step, "Create your account": the email (a code unless the provider vouches for it),
 * the screen name with a chip per source, the picture, a birth date only when a source offered
 * one, the explicit terms checks and the passkey opt-in. Nothing is issued before the gate
 * passes: Cancel sign-in abandons it. A proven address another account uses becomes the join
 * offer, never a silent join. The primary is never disabled: a missing agreement is named at its
 * checkbox.
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

function ProviderMark({
  kind,
  className = "size-4 shrink-0",
}: {
  kind: string;
  className?: string;
}): React.ReactElement | null {
  const c = className;
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
      className="-my-3 inline-block py-3 underline decoration-2 underline-offset-4"
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
        className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
        onClick={onRetry}
      >
        {t("signin.retry")}
      </Button>
      {live}
    </div>
  );
}

/** The gate answers no `resendIn`: a fixed pause between codes. */
const RESEND_S = 30;

type FieldError = { field: "email" | "code" | "form"; text: string };
type Pick = "provider" | "initials" | "upload";

/** What the screen asks of a picture file: a PNG or JPEG the Worker then judges by its bytes. */
function pictureOk(file: File): boolean {
  return file.type === "image/png" || file.type === "image/jpeg";
}

/**
 * The account exists and the session is set: the choices the gate could not carry (an uploaded
 * picture, a passkey) are made now. Best effort, never in the way: a refusal leaves the account
 * with its initials and no passkey, both one tap away in Account.
 */
async function afterFinish(opts: {
  upload: File | null;
  passkey: boolean;
}): Promise<void> {
  if (!opts.upload && !opts.passkey) return;
  try {
    setPortalCsrf((await portalApi.me()).csrf);
  } catch {
    return;
  }
  if (opts.upload) {
    try {
      const { upload } = await portalApi.uploadPicture(opts.upload);
      await portalApi.updateProfile({ picture: { upload: upload.asset } });
    } catch {
      // Initials stay.
    }
  }
  if (opts.passkey) {
    try {
      const { options } = await portalApi.passkeyRegistrationOptions();
      await portalApi.addPasskey(await createPasskey(options));
    } catch {
      // Cancelled or refused: Account → Sign-in methods adds one later.
    }
  }
}

/** A field label row with a status word at its end ("Confirmed by Google"). */
function EmailConfirmed({
  status,
  value,
}: {
  status: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-fg-strong">
          {t("signin.email.label")}
        </span>
        <span className="inline-flex items-center gap-1 text-sm text-success">
          <CircleCheck aria-hidden className="size-4" />
          {status}
        </span>
      </div>
      <div className="flex min-h-11 items-center gap-2 text-fg">
        <Lock aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
      </div>
    </div>
  );
}

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
  const hasPicture = Boolean(gate.profile.picture);
  const [pick, setPick] = React.useState<Pick>(
    hasPicture && gate.profile.initials !== true ? "provider" : "initials",
  );
  const [upload, setUpload] = React.useState<File | null>(null);
  const [uploadUrl, setUploadUrl] = React.useState<string | null>(null);
  const [pictureError, setPictureError] = React.useState<string | null>(null);
  const [birth, setBirth] = React.useState(false);
  const [platformOk, setPlatformOk] = React.useState(false);
  const [productOk, setProductOk] = React.useState(false);
  const [termsError, setTermsError] = React.useState({
    platform: false,
    product: false,
  });
  const [passkey, setPasskey] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<FieldError | null>(null);
  const errorId = React.useId();
  const nameId = React.useId();
  const emailId = React.useId();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const emailRef = React.useRef<HTMLInputElement>(null);
  const platformRef = React.useRef<HTMLButtonElement>(null);
  const productRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(
    () => () => {
      if (uploadUrl) URL.revokeObjectURL(uploadUrl);
    },
    [uploadUrl],
  );

  const emailAsked = gate.emailRequired;
  const existing = !emailAsked && !register;
  const productTerms = gate.terms;
  const platformTerms = gate.platformTerms ?? null;
  const needsCode = emailAsked && !(way === "provider" && vouched);
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
        : existing
          ? t("signin.gate.termsTitle")
          : t("signin.register.title");
  React.useEffect(() => {
    onTitle?.(title);
  }, [title, onTitle]);

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
    });
  };

  /** Name the unticked agreements at their checkboxes and focus the first. */
  const failTerms = (): void => {
    const next = {
      platform: Boolean(platformTerms) && !platformOk,
      product: Boolean(productTerms) && !productOk,
    };
    setTermsError(next);
    requestAnimationFrame(() =>
      (next.platform ? platformRef : productRef).current?.focus(),
    );
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
        if (err.code === "terms_required") return failTerms();
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
    if (hasPicture) out.picture = pick === "provider" ? "provider" : "initials";
    if (gate.profile.birthdate && birth)
      out.birthdate = gate.profile.birthdate.value;
    if (productTerms && productOk) out.termsVersion = productTerms.version;
    if (platformTerms && platformOk)
      out.platformTermsVersion = platformTerms.version;
    return out;
  };

  /** The gate passed: the choices the gate could not carry, then onward. */
  const done = async (next: string, nudge?: boolean): Promise<void> => {
    await afterFinish({
      upload: pick === "upload" ? upload : null,
      passkey: passkey && passkeysSupported(),
    });
    await onPassed(next, nudge);
  };

  /** Back to the email choice with "a different email" selected and the address kept. */
  const editEmail = (from: string | null): void => {
    setWay("typed");
    setTyped(from ?? "");
    setError(null);
    setEditing(true);
    requestAnimationFrame(() => emailRef.current?.focus());
  };

  const pending = gate.email.pending ?? gate.join?.email ?? null;
  const primaryClass =
    "h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold";

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

  // The code for a typed or unvouched address: the same control the sign-in's code step uses.
  if (view === "code") {
    const to = gate.email.pending ?? "";
    const verify = async (value: string): Promise<CodeVerifyOutcome | void> => {
      setBusy(true);
      try {
        const out = await portalApi.gateVerify(value);
        await done(out.next, out.nudge);
      } catch (err) {
        if (err instanceof PortalApiError) {
          if (err.status === 409 || err.code === "email_in_use") {
            setEditing(false);
            return void (await reload());
          }
          if (err.code === "invalid_code")
            return {
              error: wrongCodeText(err.triesLeft),
              resendNow: err.triesLeft === 0,
            };
          if (err.status === 429) return { error: t("signin.rateLimitedFew") };
          if (err.status === 400) return void (await reload());
        }
        return { error: t("signin.approve.failed") };
      } finally {
        setBusy(false);
      }
    };
    const resend = async (): Promise<CodeResendOutcome | void> => {
      try {
        await portalApi.gateChoose({ ...body(), choice: "typed", email: to });
        return {
          wait: RESEND_S,
          status: {
            text: t("signin.code.resent", { email: to }),
            tone: "success",
          },
        };
      } catch (err) {
        if (err instanceof PortalApiError && err.status === 429)
          return { error: t("signin.rateLimitedFew") };
        return { error: t("signin.approve.failed") };
      }
    };
    return (
      <div ref={ref} className="space-y-5">
        <div className="space-y-2">
          <AuthTitle>{title}</AuthTitle>
          <p className="text-fg-muted [overflow-wrap:anywhere]">
            {t("signin.gate.codeSent", { email: to })}
          </p>
        </div>
        <CodeEntry
          resendIn={RESEND_S}
          submitLabel={t("signin.gate.verify")}
          verify={verify}
          resend={resend}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => editEmail(to)}
            className="inline-flex min-h-11 items-center rounded-sm px-1 underline decoration-2 underline-offset-4 hover:text-fg-strong"
          >
            {t("signin.code.differentEmail")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-11 items-center rounded-sm px-1 underline decoration-2 underline-offset-4 hover:text-fg-strong"
          >
            {t("signin.gate.cancel")}
          </button>
        </CodeEntry>
        {live}
      </div>
    );
  }

  const primary = existing
    ? t("signin.continue")
    : needsCode
      ? t("signin.gate.sendCode")
      : t("signin.register.submit");
  const suggestions = gate.profile.suggestions ?? [];
  const initialsText = name.trim() ? initialsOf(name, null) : "";
  const radio =
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border-strong px-3 py-2 text-sm has-[:checked]:border-fg-strong";
  const emailInvalid = error?.field === "email";
  const tile =
    "relative flex min-h-24 cursor-pointer flex-col items-center gap-1 rounded-lg border border-border-strong bg-surface-sunken px-1 py-2 text-center text-sm text-fg-strong has-[:checked]:border-fg-strong has-[:checked]:ring-2 has-[:checked]:ring-fg-strong has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus";
  const circle =
    "inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-strong bg-surface-raised text-sm font-medium text-fg-strong";
  const pickMeta = (which: Pick, idle: string): string =>
    pick === which ? t("signin.gate.pictureInUse") : idle;

  return (
    <div ref={ref} className="space-y-5">
      <AuthTitle>{title}</AuthTitle>
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
          if ((platformTerms && !platformOk) || (productTerms && !productOk))
            return failTerms();
          setTermsError({ platform: false, product: false });
          void run(async () => {
            const out = await portalApi.gateChoose(body());
            if (out.status === "signed_in") return done(out.next, out.nudge);
            setEditing(false);
            await reload();
          });
        }}
      >
        {register ? (
          <EmailConfirmed
            status={t("signin.gate.confirmedByCode")}
            value={gate.email.confirmed ?? ""}
          />
        ) : emailAsked ? (
          providerEmail && vouched && way === "provider" ? (
            <div className="space-y-1">
              <EmailConfirmed
                status={t("signin.gate.confirmedBy", { provider })}
                value={providerEmail}
              />
              {gate.email.relay ? (
                <p className="text-sm text-fg-muted">
                  {t("signin.gate.relay")}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setWay("typed");
                  setError(null);
                  requestAnimationFrame(() => emailRef.current?.focus());
                }}
                className="inline-flex min-h-11 items-center rounded-sm text-sm text-fg-muted underline decoration-2 underline-offset-4 hover:text-fg-strong"
              >
                {t("signin.code.differentEmail")}
              </button>
            </div>
          ) : (
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
                      onChange={() => {
                        setWay("typed");
                        requestAnimationFrame(() => emailRef.current?.focus());
                      }}
                    />
                    {t("signin.code.differentEmail")}
                  </label>
                </>
              ) : null}
              {way === "typed" ? (
                <div className="space-y-1.5">
                  <label htmlFor={emailId} className="sr-only">
                    {t("signin.email.label")}
                  </label>
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
              ) : null}
            </fieldset>
          )
        ) : null}

        <div className="space-y-2">
          <label
            htmlFor={nameId}
            className="block text-sm font-medium text-fg-strong"
          >
            {t("signin.gate.name")}
          </label>
          <Input
            id={nameId}
            value={name}
            onValueChange={setName}
            maxLength={64}
            autoComplete="name"
            aria-describedby={`${nameId}-hint`}
            className="h-12 text-base"
          />
          {suggestions.length > 0 ? (
            <div
              role="group"
              aria-labelledby={`${nameId}-from`}
              className="space-y-1"
            >
              <span id={`${nameId}-from`} className="text-sm text-fg-muted">
                {t("signin.gate.nameFrom")}
              </span>
              <ul className="flex flex-wrap gap-2">
                {suggestions.map((s) => {
                  const on = s.name === name.trim();
                  return (
                    <li key={`${s.source}:${s.name}`}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setName(s.name)}
                        className={cn(
                          "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border px-3 text-sm text-fg-strong hover:bg-hover",
                          on
                            ? "border-fg-strong ring-1 ring-fg-strong"
                            : "border-border-strong",
                        )}
                      >
                        {s.source === "email" ? (
                          <Mail aria-hidden className="size-4 shrink-0" />
                        ) : (
                          <ProviderMark kind={s.source} />
                        )}
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {s.name}
                        </span>
                        {on ? (
                          <Check aria-hidden className="size-4 shrink-0" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          <p id={`${nameId}-hint`} className="text-sm text-fg-muted">
            {t("signin.gate.nameHint")}
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg-strong">
            {t("signin.gate.picture")}
          </legend>
          <div className="grid grid-cols-3 gap-2">
            {hasPicture ? (
              <label className={tile}>
                <input
                  type="radio"
                  name="pk-gate-picture"
                  className="sr-only"
                  checked={pick === "provider"}
                  onChange={() => setPick("provider")}
                />
                <img
                  src={gate.profile.picture ?? ""}
                  alt=""
                  width={40}
                  height={40}
                  className="size-10 shrink-0 rounded-full object-cover"
                />
                <span>{provider}</span>
                <span className="text-xs text-fg-muted">
                  {pickMeta("provider", "")}
                </span>
              </label>
            ) : null}
            <label className={tile}>
              <input
                type="radio"
                name="pk-gate-picture"
                className="sr-only"
                checked={pick === "initials"}
                onChange={() => setPick("initials")}
              />
              <span aria-hidden className={circle}>
                {initialsText}
              </span>
              <span>{t("signin.gate.pictureInitialsTile")}</span>
              <span className="text-xs text-fg-muted">
                {pickMeta("initials", t("signin.gate.pictureFromName"))}
              </span>
            </label>
            <label className={tile}>
              <input
                type="radio"
                name="pk-gate-picture"
                className="sr-only"
                checked={pick === "upload"}
                onChange={() => {
                  if (upload) setPick("upload");
                  else fileRef.current?.click();
                }}
                onClick={() => {
                  // Picking the tile again chooses another file.
                  if (pick === "upload") fileRef.current?.click();
                }}
              />
              {uploadUrl ? (
                <img
                  src={uploadUrl}
                  alt=""
                  width={40}
                  height={40}
                  className="size-10 shrink-0 rounded-full object-cover"
                />
              ) : (
                <span aria-hidden className={circle}>
                  <Upload className="size-5 text-fg-muted" />
                </span>
              )}
              <span>{t("signin.gate.pictureUpload")}</span>
              <span className="text-xs text-fg-muted">
                {pickMeta("upload", t("signin.gate.pictureUploadHint"))}
              </span>
            </label>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              if (!pictureOk(file))
                return void setPictureError(t("signin.gate.pictureInvalid"));
              setPictureError(null);
              setUpload(file);
              setUploadUrl(URL.createObjectURL(file));
              setPick("upload");
            }}
          />
          {pictureError ? (
            <p role="alert" className="text-sm text-danger">
              {pictureError}
            </p>
          ) : null}
        </fieldset>

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

        {platformTerms || productTerms ? (
          <div className="space-y-3">
            {platformTerms ? (
              <div>
                <Checkbox
                  ref={platformRef}
                  checked={platformOk}
                  onCheckedChange={(v) => {
                    setPlatformOk(v);
                    if (v) setTermsError((e) => ({ ...e, platform: false }));
                  }}
                  aria-invalid={termsError.platform || undefined}
                  aria-describedby={
                    termsError.platform ? `${errorId}-platform` : undefined
                  }
                  label={
                    <TermsSentence
                      sentence="signin.gate.platformTerms"
                      url={platformTerms.url}
                      label={t("signin.gate.termsLinkPlatform")}
                    />
                  }
                />
                {termsError.platform ? (
                  <p
                    id={`${errorId}-platform`}
                    role="alert"
                    className="mt-1.5 text-sm text-danger"
                  >
                    {t("core.codes.terms_required.message")}
                  </p>
                ) : null}
              </div>
            ) : null}
            {productTerms ? (
              <div>
                <Checkbox
                  ref={productRef}
                  checked={productOk}
                  onCheckedChange={(v) => {
                    setProductOk(v);
                    if (v) setTermsError((e) => ({ ...e, product: false }));
                  }}
                  aria-invalid={termsError.product || undefined}
                  aria-describedby={
                    termsError.product ? `${errorId}-product` : undefined
                  }
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
                {termsError.product ? (
                  <p
                    id={`${errorId}-product`}
                    role="alert"
                    className="mt-1.5 text-sm text-danger"
                  >
                    {t("core.codes.terms_required.message")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {passkeysSupported() && !existing ? (
          <Checkbox
            checked={passkey}
            onCheckedChange={setPasskey}
            label={
              <span className="text-fg-muted">{t("signin.gate.passkey")}</span>
            }
          />
        ) : null}

        {error?.field === "form" ? (
          <p role="alert" className="text-sm text-danger">
            {error.text}
          </p>
        ) : null}
        <div className="space-y-2">
          <Button
            type="submit"
            variant="neutral"
            size="lg"
            className={primaryClass}
            loading={busy}
          >
            {primary}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className={primaryClass}
            disabled={busy}
            onClick={onCancel}
          >
            {t("signin.gate.cancel")}
          </Button>
        </div>
      </form>
      {live}
    </div>
  );
}
