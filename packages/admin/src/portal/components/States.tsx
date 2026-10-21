import * as React from "react";
import { AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { StationaryStar } from "../../ui/EmptyState.js";
import { cn } from "../../lib/cn.js";
import { portalErrorCopy } from "../errors.js";
import { href } from "../router.js";
import { t } from "../../lib/copy.js";
import { HelpLink } from "./HelpLink.js";

/**
 * A failed load, in the person's words with a Retry (PORTAL.md §4.28, §6.4). Never the HTTP
 * status. `asPage` makes the title the screen's `h1`.
 *
 * A page that knows what it was loading (LK-polish M6) passes `page`: its own title stays as the
 * `h1` (`asPage` only; the Library draws its own), the panel drops the catalog's "Something went
 * wrong" for one sentence naming what failed (`message`, used for the catch-all code only; a
 * specific refusal keeps its own sentence), and `backToLibrary` adds the way out.
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
  const copy = portalErrorCopy(error, { account });
  const Title = asPage ? "h1" : "h2";
  const named = message !== undefined || page !== undefined;
  const panel = (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-xl border border-border bg-surface-raised p-6",
        className,
      )}
    >
      <AlertCircle aria-hidden className="size-6 text-danger" />
      {named ? (
        <p className="text-fg-strong">
          {copy.generic && message ? message : copy.line}
        </p>
      ) : (
        <>
          <Title className="text-lg font-semibold text-fg-strong">
            {copy.title}
          </Title>
          <p className="text-fg-muted">{copy.description}</p>
        </>
      )}
      {copy.help ? (
        <HelpLink href={copy.help}>{t("locker.help.whatToDo")}</HelpLink>
      ) : null}
      {onRetry && copy.retry ? (
        <Button
          variant="outline"
          iconStart={<RefreshCw aria-hidden />}
          onClick={onRetry}
        >
          {t("signin.retry")}
        </Button>
      ) : null}
      {backToLibrary ? (
        <a
          href={href.library()}
          className="inline-flex items-center gap-2 rounded-sm text-sm text-fg-muted hover:text-fg-strong pointer-coarse:min-h-11"
        >
          <ArrowLeft aria-hidden className="size-4" />
          {t("locker.library.title")}
        </a>
      ) : null}
    </div>
  );
  if (page === undefined) return panel;
  return (
    <div className="space-y-6">
      <h1 className="text-headline font-semibold leading-tight text-fg-strong [overflow-wrap:anywhere] desk:text-4xl">
        {page}
      </h1>
      {panel}
    </div>
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
