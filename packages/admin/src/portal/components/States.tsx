import * as React from "react";
import { ErrorState } from "../../ui/ErrorState.js";
import { ErrorVoiceProvider } from "../../ui/errorVoice.js";
import { StationaryStar } from "../../ui/EmptyState.js";
import { portalVoice } from "../errors.js";
import { href } from "../router.js";
import { t } from "../../lib/copy.js";

/**
 * A failed load, in the person's words with a Retry (PORTAL.md §4.28, §6.4). Never the HTTP
 * status. It is `ErrorState` in the portal's voice (see `ui/ErrorState.tsx` for `asPage`, `page`
 * and `message`); `backToLibrary` adds the way out.
 */
export function ErrorPanel({
  error,
  onRetry,
  asPage = false,
  account = false,
  page,
  message,
  backToLibrary = false,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  asPage?: boolean;
  /** An Account screen: no developer to contact. */
  account?: boolean;
  /** The page's own title, kept as the `h1` over the panel (with `asPage`). */
  page?: string;
  /** What failed, for the catch-all error; given, the panel has no title of its own. */
  message?: string;
  /** A way back to the Library. */
  backToLibrary?: boolean;
  className?: string;
}): React.ReactElement {
  // Its own provider, so a panel drawn outside `PortalApp` (an error boundary) still speaks portal.
  return (
    <ErrorVoiceProvider voice={portalVoice}>
      <ErrorState
        error={error}
        onRetry={onRetry}
        asPage={asPage}
        account={account}
        page={page}
        message={message}
        backTo={
          backToLibrary
            ? { href: href.library(), label: t("locker.library.title") }
            : undefined
        }
        className={className}
      />
    </ErrorVoiceProvider>
  );
}

/** A centred screen with the stationary star: boot, network errors and other no-context states. */
export function StarScreen({
  title,
  children,
  busy,
}: {
  title: string;
  children?: React.ReactNode;
  busy?: boolean;
}): React.ReactElement {
  return (
    <main
      aria-busy={busy || undefined}
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-page px-4 text-center text-fg"
    >
      <StationaryStar />
      <h1 className="text-xl font-semibold text-fg-strong">{title}</h1>
      {children}
    </main>
  );
}
