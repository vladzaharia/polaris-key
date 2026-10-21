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
import { AuthCard, AuthTitle } from "../../ui/auth/index.js";

export function ConsoleBrand(): React.ReactElement {
  const { theme } = useTheme();
  return (
    <header className="inline-flex items-center text-fg-strong">
      <PolarisLockup
        kind="key"
        layout="compact"
        theme={theme}
        height={40}
        title=""
      />
      <span
        aria-hidden
        className="ml-3 border-l border-border-strong pl-3 text-base text-fg-muted forced-colors:text-[CanvasText]"
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
}: {
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
    <AuthCard brand={<ConsoleBrand />} stepKey="offline" focusKey={1}>
      <AuthTitle>Can’t reach Polaris Key</AuthTitle>
      <p aria-live="polite" className="text-sm text-fg-muted empty:hidden">
        {again ? "Still can’t reach Polaris Key." : ""}
      </p>
      <div className="space-y-2">
        <Button
          variant="neutral"
          size="lg"
          loading={busy}
          aria-busy={busy}
          className="h-auto min-h-12 w-full py-2 text-base font-semibold"
          onClick={retry}
        >
          Try again
        </Button>
        <Button
          asChild
          variant="outline"
          size="lg"
          className="h-auto min-h-12 w-full py-2 text-base font-semibold"
        >
          <a href={`/manage/login?returnTo=${encodeURIComponent(back)}`}>
            Sign in again
          </a>
        </Button>
      </div>
    </AuthCard>
  );
}
