import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Input } from "../../../ui/Input.js";
import { Spinner } from "../../../ui/Spinner.js";
import {
  AuthTitle,
  CODE_LENGTH,
  CodeCells,
  QuietLink,
} from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { sc } from "../../copy/signin.js";
import {
  portalApi,
  PortalApiError,
  type PortalGate,
  type PortalGateChoice,
} from "../../api.js";
import { portalKeys } from "../../data.js";
import { rememberVia } from "../../lastMethod.js";
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

export function FinishStep({
  onLeave,
  onExpired,
}: {
  /** Cancel sign-in: back to the methods. */
  onLeave: () => void;
  /** The gate is gone (15 minutes, or never opened): back to the methods with a notice. */
  onExpired: () => void;
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
  const passed = async (next: string): Promise<void> => {
    const via = phase.kind === "gate" ? phase.gate.provider : null;
    if (
      via === "apple" ||
      via === "google" ||
      via === "steam" ||
      via === "email"
    )
      rememberVia(via);
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

  if (phase.kind === "loading" || phase.kind === "gone")
    return (
      <div aria-busy role="status" aria-label="Loading" className="space-y-5">
        <div aria-hidden className="h-8 w-2/3 rounded-md bg-hover" />
        <div aria-hidden className="h-24 rounded-md bg-hover" />
        <div aria-hidden className="h-12 rounded-md bg-hover" />
      </div>
    );
  if (phase.kind === "error")
    return (
      <>
        <AuthTitle>{t("signin.network.title")}</AuthTitle>
        <Button variant="outline" onClick={() => void load()}>
          {t("signin.retry")}
        </Button>
      </>
    );
  return (
    <FinishForm
      gate={phase.gate}
      reload={load}
      onPassed={passed}
      onCancel={async () => {
        try {
          await portalApi.gateCancel();
        } catch {
          // Already gone: the same end.
        }
        onLeave();
      }}
    />
  );
}

function FinishForm({
  gate,
  reload,
  onPassed,
  onCancel,
}: {
  gate: PortalGate;
  reload: () => Promise<void>;
  onPassed: (next: string) => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  const provider = providerName(gate.provider);
  const register = gate.provider === "email";
  const providerEmail = gate.email.provider;
  const vouched = Boolean(providerEmail && gate.email.providerVerified);
  const [way, setWay] = React.useState<"provider" | "typed">(
    providerEmail ? "provider" : "typed",
  );
  const [typed, setTyped] = React.useState("");
  const [name, setName] = React.useState(gate.profile.name ?? "");
  const [initials, setInitials] = React.useState(
    gate.profile.initials === true,
  );
  const [birth, setBirth] = React.useState(false);
  const [product, setProduct] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const errorId = React.useId();
  const nameId = React.useId();
  const emailId = React.useId();
  const codeId = React.useId();

  const emailAsked = gate.emailRequired;
  const productTerms = gate.terms;
  const platformTerms = gate.platformTerms ?? null;
  const needsCode = emailAsked && !(way === "provider" && vouched);
  const identity =
    gate.email.confirmed ?? providerEmail ?? gate.profile.name ?? null;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof PortalApiError) {
        // The gate moved on or ran out: show what is true now.
        if (err.status === 409 || err.code === "email_in_use")
          return void (await reload());
        if (err.code === "terms_required")
          return setError(sc("signin.gate.termsRequired"));
        if (err.code === "invalid_code")
          return setError(wrongCodeText(err.triesLeft));
        if (err.status === 422) return setError(t("signin.email.invalid"));
        if (err.status === 429)
          return setError(t("signin.rateLimited", { minutes: "a few" }));
        if (err.status === 400) return void (await reload());
      }
      setError(sc("signin.approve.failed"));
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

  // The join offer replaces the step (§3.5).
  if (gate.stage === "join_offer") {
    const email = gate.join?.email ?? "";
    return (
      <>
        <div className="space-y-2">
          <AuthTitle>{sc("signin.gate.joinTitle")}</AuthTitle>
          <p className="text-fg-muted">
            {sc("signin.gate.joinLede", { email })}
          </p>
          {gate.join?.proven ? null : (
            <p className="text-sm text-fg-muted">
              {sc("signin.gate.joinProve")}
            </p>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="space-y-3">
          {gate.join?.proven ? (
            <Button
              variant="neutral"
              size="lg"
              className="h-12 w-full text-base font-semibold"
              loading={busy}
              onClick={() =>
                void run(async () =>
                  onPassed((await portalApi.gateJoin()).next),
                )
              }
            >
              {t("signin.gate.join")}
            </Button>
          ) : null}
          <Button
            variant={gate.join?.proven ? "ghost" : "neutral"}
            size="lg"
            className="h-12 w-full text-base font-semibold"
            disabled={busy}
            onClick={onCancel}
          >
            {t("signin.code.differentEmail")}
          </Button>
        </div>
      </>
    );
  }

  const title = register
    ? t("signin.register.title")
    : emailAsked
      ? t("signin.gate.title")
      : sc("signin.gate.termsTitle");
  const lede =
    gate.product?.name && !register
      ? t("signin.gate.ledeApp", { app: gate.product.name })
      : null;

  // The code for a typed or unvouched address.
  if (gate.stage === "code_sent") {
    const to = gate.email.pending ?? "";
    return (
      <>
        <div className="space-y-2">
          <AuthTitle>{t("signin.code.title")}</AuthTitle>
          <p className="text-fg-muted">
            {sc("signin.gate.codeSent", { email: to })}
          </p>
        </div>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === CODE_LENGTH)
              void run(async () =>
                onPassed((await portalApi.gateVerify(code)).next),
              );
          }}
        >
          <CodeCells
            id={codeId}
            value={code}
            invalid={Boolean(error)}
            describedBy={error ? errorId : undefined}
            onChange={(v) => {
              setCode(v);
              setError(null);
            }}
          />
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="neutral"
            size="lg"
            className="h-12 w-full text-base font-semibold"
            disabled={code.length !== CODE_LENGTH}
            loading={busy}
          >
            {t("signin.gate.verify")}
          </Button>
        </form>
        <div className="flex justify-center">
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
        </div>
      </>
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

  return (
    <>
      {register ? null : (
        <div
          data-gate-strip
          className="flex items-center gap-3 rounded-md border border-success-border bg-success-subtle px-3 py-2.5 text-sm text-fg"
        >
          <ProviderMark kind={gate.provider} />
          <span className="min-w-0 flex-1 truncate">
            {identity
              ? t("signin.gate.strip", { provider, identity })
              : sc("signin.gate.stripNoIdentity", { provider })}
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-success">
            <Check aria-hidden className="size-4" />
            {sc("signin.gate.done")}
          </span>
        </div>
      )}
      <div className="space-y-2">
        <AuthTitle>{title}</AuthTitle>
        {register ? (
          <p role="status" className="text-fg-muted">
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
          if (productTerms && !product)
            return setError(sc("signin.gate.termsRequired"));
          if (
            emailAsked &&
            way === "typed" &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed.trim())
          )
            return setError(t("signin.email.invalid"));
          void run(async () => {
            const out = await portalApi.gateChoose(body());
            if (out.status === "signed_in") return onPassed(out.next);
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
                className="mt-6 inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-hover text-sm font-medium text-fg-strong"
              >
                {initialsOf(name, null)}
              </span>
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <label
                htmlFor={nameId}
                className="text-sm font-medium text-fg-strong"
              >
                {sc("signin.gate.name")}
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
                  aria-label={sc("signin.gate.name")}
                >
                  {suggestions.map((s) => (
                    <li key={s.name}>
                      <button
                        type="button"
                        onClick={() => setName(s.name)}
                        className="min-h-8 rounded-full border border-border-strong px-3 text-sm text-fg-strong hover:bg-hover"
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
                    className="font-medium text-fg-strong underline underline-offset-4"
                    onClick={() => setInitials(!initials)}
                  >
                    {initials
                      ? sc("signin.gate.pictureProvider", { provider })
                      : sc("signin.gate.pictureInitials")}
                  </button>
                ) : null}
              </p>
            </div>
          </div>
        </div>
        {emailAsked ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-fg-strong">
              {sc("signin.gate.emailChoice")}
            </legend>
            {providerEmail ? (
              <>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border-strong px-3 py-2 text-sm has-[:checked]:border-accent">
                  <input
                    type="radio"
                    name="pk-gate-email"
                    checked={way === "provider"}
                    onChange={() => setWay("provider")}
                  />
                  <span className="min-w-0 break-words">
                    <bdi>
                      {sc("signin.gate.useEmail", { email: providerEmail })}
                    </bdi>
                    {gate.email.relay ? (
                      <span className="block text-fg-muted">
                        {sc("signin.gate.relay")}
                      </span>
                    ) : null}
                  </span>
                </label>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border-strong px-3 py-2 text-sm has-[:checked]:border-accent">
                  <input
                    type="radio"
                    name="pk-gate-email"
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
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={typed}
                  onValueChange={setTyped}
                  className="h-12 text-base"
                  aria-describedby={
                    gate.provider === "steam" ? `${emailId}-help` : undefined
                  }
                />
                {gate.provider === "steam" ? (
                  <p id={`${emailId}-help`} className="text-sm text-fg-muted">
                    {t("signin.gate.steam")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>
        ) : null}
        {gate.profile.birthdate ? (
          <Checkbox
            checked={birth}
            onCheckedChange={setBirth}
            label={sc("signin.gate.birthdate", {
              from: gate.profile.birthdate.from,
            })}
            description={sc("signin.gate.birthdateHelp")}
          />
        ) : null}
        {productTerms ? (
          <Checkbox
            checked={product}
            onCheckedChange={setProduct}
            label={
              <>
                {sc("signin.gate.productTerms", {
                  product: gate.product?.name ?? "",
                })}{" "}
                {safeHref(productTerms.url) ? (
                  <a
                    href={safeHref(productTerms.url)!}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline underline-offset-4"
                  >
                    {sc("signin.gate.termsLink")}
                  </a>
                ) : null}
              </>
            }
          />
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="neutral"
          size="lg"
          className="h-12 w-full text-base font-semibold"
          loading={busy}
        >
          {primary}
        </Button>
        <div className="flex justify-center">
          <QuietLink onClick={onCancel}>{t("signin.gate.cancel")}</QuietLink>
        </div>
        {platformTerms ? (
          <p className="text-sm text-fg-muted">
            {sc("signin.gate.platformTerms")}{" "}
            {safeHref(platformTerms.url) ? (
              <a
                href={safeHref(platformTerms.url)!}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-4"
              >
                {sc("signin.gate.termsLink")}
              </a>
            ) : (
              sc("signin.gate.termsLink")
            )}
            .
          </p>
        ) : null}
      </form>
      {busy && !error ? (
        <span className="sr-only">
          <Spinner label="Working" />
        </span>
      ) : null}
    </>
  );
}
