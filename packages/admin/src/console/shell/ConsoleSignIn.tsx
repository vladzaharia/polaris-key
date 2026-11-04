/**
 * The console's card when the SPA cannot load its session (SIGN-IN.md §3.12): the shared
 * `ui/auth/AuthCard` under the Polaris Key lockup and "│ Console", never Polaris Locker. The
 * Worker serves the same card (`console/signinPage.ts`) for sign in, signed out, session ended and
 * step-up; this one is the offline / 5xx state, which has no page to come from.
 */
import * as React from "react";
import { PolarisLockup } from "@polaris-key/brand/react";
import { useTheme } from "../../components/theme.js";
import { Button } from "../../ui/Button.js";
import { AUTH_METHOD_CLASS, AuthCard, AuthTitle } from "../../ui/auth/index.js";
import { AUTH_PRIMARY_CLASS } from "../../ui/auth/parts.js";
import { FooterNav } from "../../ui/auth/FooterNav.js";

/** Help and Privacy under the console cards: the Worker card's links (public pages, no session). */
export function ConsoleLegalNav(): React.ReactElement {
  return (
    <FooterNav help="/docs/" privacy="/docs/reference/what-apps-collect/" />
  );
}

export function ConsoleBrand(): React.ReactElement {
  const { theme } = useTheme();
  // The brand row (SIGNIN-REDESIGN §5, §8): the compact lockup on its 64 px canvas (a phone sizes
  // it by width, min(180px, 52vw)), a 1 px rule 24 px tall, and "Console" at 16/24, 400, muted.
  return (
    <header className="inline-flex items-center text-fg-strong">
      <PolarisLockup
        kind="key"
        layout="compact"
        theme={theme}
        height={64}
        title=""
        className="max-sm:h-auto max-sm:w-[min(180px,52vw)]"
      />
      <span aria-hidden className="mx-3 h-6 w-px shrink-0 bg-border-strong" />
      <span
        aria-hidden
        className="text-base/6 font-normal text-fg-muted forced-colors:text-[CanvasText]"
      >
        Console
      </span>
      <span className="sr-only">Polaris Key Console</span>
    </header>
  );
}

/** Offline or a server error: say so, and offer Try again before any sign-in. */
export function ConsoleOffline({
  onRetry,
  serverError = false,
}: {
  /** The server answered with a 5xx: it is up but failing, so the copy must not say it can't be reached. */
  serverError?: boolean;
  /** Resolves with whether the session still fails to load. */
  onRetry: () => Promise<{ isError: boolean }>;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [again, setAgain] = React.useState(false);
  const retry = (): void => {
    setBusy(true);
    setAgain(false);
    void onRetry()
      .then((r) => setAgain(r.isError))
      .catch(() => setAgain(true))
      .finally(() => setBusy(false));
  };
  const back = `/manage/${window.location.hash}`;
  return (
    // focusKey: the card's h1 takes focus and is announced when the card appears.
    <AuthCard
      brand={<ConsoleBrand />}
      brandAir="canvas"
      after={<ConsoleLegalNav />}
      stepKey="offline"
      focusKey={1}
    >
      <AuthTitle>
        {serverError
          ? "Something went wrong on the server"
          : "Can't reach Polaris Key"}
      </AuthTitle>
      <p aria-live="polite" className="text-base/6 text-fg-muted empty:hidden">
        {again
          ? serverError
            ? "Still something went wrong on the server."
            : "Still can't reach Polaris Key."
          : ""}
      </p>
      <div className="space-y-3">
        <Button
          variant="neutral"
          size="xl"
          loading={busy}
          aria-busy={busy}
          className={AUTH_PRIMARY_CLASS}
          onClick={retry}
        >
          Try again
        </Button>
        <Button
          asChild
          variant="outline"
          size="xl"
          className={AUTH_METHOD_CLASS}
        >
          <a href={`/manage/login?returnTo=${encodeURIComponent(back)}`}>
            Sign in again
          </a>
        </Button>
      </div>
    </AuthCard>
  );
}

/**
 * `/me` answered, and the answer was a refusal (a 403): the session works, the account is not let
 * in. Trying again cannot change that, so there is no Try again, only the way to another account.
 */
export function ConsoleRefused(): React.ReactElement {
  const back = `/manage/${window.location.hash}`;
  return (
    <AuthCard
      brand={<ConsoleBrand />}
      brandAir="canvas"
      after={<ConsoleLegalNav />}
      stepKey="refused"
      focusKey={1}
    >
      <AuthTitle>This account can't open the console</AuthTitle>
      <p className="text-fg-muted">
        Ask an admin to add you, or sign in with another account.
      </p>
      <Button
        asChild
        variant="neutral"
        size="xl"
        className={AUTH_PRIMARY_CLASS}
      >
        <a href={`/manage/login?returnTo=${encodeURIComponent(back)}`}>
          Sign in with another account
        </a>
      </Button>
    </AuthCard>
  );
}
