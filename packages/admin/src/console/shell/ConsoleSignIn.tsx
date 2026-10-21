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
    <span className="inline-flex items-center text-fg-strong">
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
    </span>
  );
}

/** Offline or a server error: say so, and offer Try again before any sign-in. */
export function ConsoleOffline({
  onRetry,
}: {
  onRetry: () => void;
}): React.ReactElement {
  return (
    <AuthCard brand={<ConsoleBrand />} stepKey="offline">
      <AuthTitle>Can’t reach Polaris Key</AuthTitle>
      <div className="space-y-2">
        <Button
          size="lg"
          className="h-auto min-h-12 w-full py-2 text-base font-semibold"
          onClick={onRetry}
        >
          Try again
        </Button>
        <Button
          asChild
          variant="outline"
          size="lg"
          className="h-auto min-h-12 w-full py-2 text-base font-semibold"
        >
          <a href="/manage/login?ended=1">Sign in again</a>
        </Button>
      </div>
    </AuthCard>
  );
}
