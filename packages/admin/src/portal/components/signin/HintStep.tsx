import * as React from "react";
import { Mail, Fingerprint } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import {
  AuthTitle,
  OrDivider,
  QuietLink,
  QuietLinks,
  providerLabel,
} from "../../../ui/auth/index.js";
import {
  AppleGlyph,
  GoogleGlyph,
  SteamGlyph,
} from "../../../ui/auth/ProviderGlyphs.js";
import { t } from "../../../lib/copy.js";
import { portalApi, PortalApiError, type PortalEmailSent } from "../../api.js";
import { initialsOf } from "../Avatar.js";
import type { LastMethod } from "../../lastMethod.js";
import { usePasskeySignIn } from "./usePasskeySignIn.js";

/**
 * HintStep (SIGN-IN.md §3.4, PORTAL.md §4.3): the typed address matches the one this browser last
 * signed in with, so the usual way is offered first, labelled, with the other ways under it. The
 * hint comes from the first-party `pk_last_method` cookie and nothing the server said
 * (`lastMethod.ts`). A method this card no longer offers never reaches this step.
 */
/** "2 days ago", "last year": long units, never the compact "yr." of tables. */
function whenText(ms: number): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const s = Math.round((ms - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units)
    if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return rtf.format(0, "second");
}

const NAME: Record<string, string> = {
  apple: "Apple",
  google: "Google",
  steam: "Steam",
};

export function HintStep({
  email,
  last,
  passkeyAvailable,
  hrefFor,
  onProvider,
  onSent,
  onOther,
  returnTo,
}: {
  email: string;
  last: LastMethod;
  passkeyAvailable: boolean;
  /** The provider's start link for the usual provider. */
  hrefFor: (provider: "apple" | "google" | "steam") => string;
  onProvider: (provider: "apple" | "google" | "steam") => void;
  onSent: (email: string, sent: PortalEmailSent | undefined) => void;
  /** Change, or Other ways to sign in: back to the methods with the address kept. */
  onOther: () => void;
  returnTo: () => string;
}): React.ReactElement {
  const pk = usePasskeySignIn(returnTo);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const provider =
    last.kind === "apple" || last.kind === "google" || last.kind === "steam"
      ? last.kind
      : null;
  const methodName = provider
    ? NAME[provider]!
    : t(
        last.kind === "passkey"
          ? "signin.hint.method.passkey"
          : "signin.hint.method.email",
      );

  const mail = async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      onSent(email, await portalApi.startEmailSignIn(email));
    } catch (err) {
      setError(
        err instanceof PortalApiError &&
          (err.status === 429 || err.code === "rate_limited")
          ? t("signin.rateLimitedFew")
          : t("signin.emailDown"),
      );
    } finally {
      setSending(false);
    }
  };

  const mark =
    provider === "apple" ? (
      <AppleGlyph className="size-5" />
    ) : provider === "google" ? (
      <GoogleGlyph className="size-5" />
    ) : provider === "steam" ? (
      <SteamGlyph className="size-5" />
    ) : (
      <Fingerprint aria-hidden className="size-5" />
    );
  const primaryClass =
    "h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold";
  return (
    <>
      <div className="inline-flex max-w-full flex-wrap items-center gap-x-2 rounded-2xl border border-border-strong py-0.5 pl-1 pr-3 text-sm">
        <span
          aria-hidden
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-medium text-fg-strong"
        >
          {initialsOf(last.name, email)}
        </span>
        <span className="min-w-0 [overflow-wrap:break-word] text-fg-strong">
          {email}
        </span>
        <button
          type="button"
          onClick={onOther}
          className="inline-flex min-h-11 shrink-0 items-center font-medium text-fg-strong underline decoration-2 underline-offset-4"
        >
          {t("signin.hint.change")}
        </button>
      </div>
      <AuthTitle>
        {last.name
          ? t("signin.hint.welcome", { name: last.name })
          : t("signin.hint.welcomeNoName")}
      </AuthTitle>
      <div className="flex items-center gap-3 rounded-md bg-hover px-4 py-3">
        <span className="shrink-0 text-fg-strong">{mark}</span>
        <div className="min-w-0">
          <p className="font-medium text-fg-strong">
            {t("signin.hint.usual", { method: methodName })}
          </p>
          {last.at ? (
            <p className="text-sm text-fg-muted">
              {t("signin.hint.when", { when: whenText(last.at * 1000) })}
            </p>
          ) : null}
        </div>
      </div>
      {provider ? (
        <Button asChild variant="neutral" size="lg" className={primaryClass}>
          <a href={hrefFor(provider)} onClick={() => onProvider(provider)}>
            {mark}
            {providerLabel(provider, "continue")}
          </a>
        </Button>
      ) : last.kind === "passkey" ? (
        <Button
          variant="neutral"
          size="lg"
          className={primaryClass}
          loading={pk.busy}
          onClick={() => void pk.run()}
          iconStart={<Fingerprint aria-hidden />}
        >
          {t("signin.hint.usePasskey")}
        </Button>
      ) : null}
      <OrDivider />
      <div className="space-y-3">
        {last.kind !== "email" ? (
          <Button
            variant="outline"
            size="lg"
            className={primaryClass}
            loading={sending}
            onClick={() => void mail()}
            iconStart={<Mail aria-hidden />}
          >
            {t("signin.hint.emailCode")}
          </Button>
        ) : null}
        {passkeyAvailable && last.kind !== "passkey" ? (
          <Button
            variant="outline"
            size="lg"
            className={primaryClass}
            loading={pk.busy}
            onClick={() => void pk.run()}
            iconStart={<Fingerprint aria-hidden />}
          >
            {t("signin.hint.usePasskey")}
          </Button>
        ) : null}
      </div>
      {error || pk.error ? (
        <p role="alert" className="text-sm text-danger">
          {error ?? pk.error}
        </p>
      ) : null}
      <QuietLinks>
        <QuietLink onClick={onOther}>{t("signin.hint.other")}</QuietLink>
      </QuietLinks>
    </>
  );
}
