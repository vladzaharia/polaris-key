import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CircleX,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import type { ErrorContext, errorCopy } from "../lib/errorCopy.js";
import { Button } from "./Button.js";
import { Unlocked } from "./WriteLock.js";
import { CopyButton } from "./CopyButton.js";
import { CopyDetails } from "./CopyDetails.js";
import { useErrorVoice, type PortalVoice } from "./errorVoice.js";

/**
 * A failed load, rendered through `errorCopy` (components.md §5.5): what went wrong in words, and
 * the next step. Never `EmptyState` with a warning icon (UI-14), never "api 422". The retry label
 * is always "Try again". `compact` is one inline line for a table body, a card or a tile (no Copy
 * details there; the full state offers it).
 */
export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  context?: ErrorContext;
  compact?: boolean;
  /**
   * Names what failed: the title becomes "{thing} didn't load" and the retry reads "Retry", with
   * "Copy details" beside it as a quiet second action. Without it the wording is `errorCopy`'s.
   */
  thing?: string;
  className?: string;
  /**
   * The customer site's look (the voice's `tone`); the console ignores these. `asPage` makes the
   * title the screen's `h1`. A page that knows what it was loading passes `page` (its own title
   * stays as the `h1`, over the panel) and `message` (one sentence naming what failed, used for
   * the catch-all code only; a specific refusal keeps its own sentence). `backTo` adds the way
   * out; `account` marks an Account screen.
   */
  asPage?: boolean;
  page?: string;
  message?: string;
  backTo?: { href: string; label: string };
  account?: boolean;
}

export function ErrorState({
  error,
  onRetry,
  context,
  compact = false,
  thing,
  className,
  asPage = false,
  page,
  message,
  backTo,
  account = false,
}: ErrorStateProps): React.ReactElement {
  const voice = useErrorVoice();
  if (voice.tone === "portal")
    return (
      <PortalErrorState
        voice={voice}
        error={error}
        onRetry={onRetry}
        asPage={asPage}
        page={page}
        message={message}
        backTo={backTo}
        account={account}
        className={className}
      />
    );
  const base = voice.copy(error, context);
  const copy =
    thing && base.action !== "sign-in"
      ? { ...base, title: `${thing} didn't load` }
      : base;
  const titleId = React.useId();
  if (compact) {
    // Inside a tile, a card or a table body: one line, so a failure never stretches its row.
    return (
      <div
        role="alert"
        aria-labelledby={titleId}
        data-error-action={copy.action}
        className={cn(
          "flex flex-wrap items-start gap-x-2 gap-y-1 px-1 py-2 text-sm",
          className,
        )}
      >
        <AlertTriangle
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-danger"
        />
        <p className="min-w-0 flex-1">
          <span id={titleId} className="font-semibold text-fg-strong">
            {copy.title}.
          </span>{" "}
          <span className="text-fg-muted">{copy.description}</span>
        </p>
        <Actions
          copy={copy}
          onRetry={onRetry}
          context={context}
          compact
          named={Boolean(thing)}
        />
      </div>
    );
  }
  return (
    <div
      role="alert"
      aria-labelledby={titleId}
      data-error-action={copy.action}
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-raised px-6 py-12 text-center",
        className,
      )}
    >
      {thing ? (
        <CircleX aria-hidden className="size-8 text-danger" />
      ) : (
        <AlertTriangle aria-hidden className="size-8 text-danger" />
      )}
      <div className="max-w-md space-y-1">
        <p id={titleId} className="text-base font-semibold text-fg-strong">
          {copy.title}
        </p>
        <p className="text-sm text-fg-muted">{copy.description}</p>
        {copy.lines?.length ? (
          <ul className="mt-2 list-disc space-y-1 ps-5 text-start text-sm text-fg">
            {copy.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
        {copy.references?.length ? (
          <ul className="mt-2 space-y-1 text-start text-sm text-fg">
            {copy.references.map((r) => (
              <li key={r} className="font-mono text-xs">
                {r}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Actions
        copy={copy}
        onRetry={onRetry}
        context={context}
        named={Boolean(thing)}
      />
    </div>
  );
}

/** The customer site's look: left-aligned, the title (or one sentence) over a Retry. */
function PortalErrorState({
  voice,
  error,
  onRetry,
  asPage,
  page,
  message,
  backTo,
  account,
  className,
}: {
  voice: PortalVoice;
  error: unknown;
  onRetry?: () => void;
  asPage: boolean;
  page?: string;
  message?: string;
  backTo?: { href: string; label: string };
  account: boolean;
  className?: string;
}): React.ReactElement {
  const copy = voice.copy(error, { account });
  const Title = asPage ? "h1" : "h2";
  const panelRef = React.useRef<HTMLDivElement>(null);
  const retry = onRetry
    ? () => {
        voice.afterRetry(panelRef.current);
        onRetry();
      }
    : undefined;
  const named = message !== undefined || page !== undefined;
  const panel = (
    <div
      ref={panelRef}
      role="alert"
      className={cn(
        "flex w-full max-w-xl flex-col items-start gap-3 rounded-xl border border-border bg-surface-raised p-6",
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
        <voice.HelpLink href={copy.help}>{voice.helpLabel}</voice.HelpLink>
      ) : null}
      {/* Try again leads; Copy details is the quiet second action. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {retry && copy.retry ? (
          <Button
            variant="outline"
            iconStart={<RefreshCw aria-hidden />}
            onClick={retry}
          >
            {voice.retryLabel}
          </Button>
        ) : null}
        <CopyDetails
          variant="ghost"
          copy={{ action: "copy-details", details: voice.details(error) }}
        />
      </div>
      {backTo ? (
        <a
          href={backTo.href}
          className="inline-flex min-h-6 items-center gap-2 rounded-sm text-sm text-fg-muted hover:text-fg-strong pointer-coarse:min-h-11"
        >
          <ArrowLeft aria-hidden className="size-4" />
          {backTo.label}
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

function Actions({
  copy,
  onRetry,
  context,
  compact = false,
  named = false,
}: {
  copy: ReturnType<typeof errorCopy>;
  onRetry?: () => void;
  context?: ErrorContext;
  compact?: boolean;
  named?: boolean;
}): React.ReactElement {
  const variant = compact ? "ghost" : "outline";
  const size = compact ? "xs" : "sm";
  return (
    <Unlocked>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button
            size={size}
            variant={variant}
            iconStart={<RotateCw />}
            onClick={onRetry}
          >
            {named ? "Retry" : "Try again"}
          </Button>
        ) : null}
        {copy.action === "reload" ? (
          <Button
            size={size}
            variant={variant}
            onClick={() => window.location.reload()}
          >
            Reload the page
          </Button>
        ) : null}
        {copy.action === "sign-in" ? (
          <Button size={size} asChild>
            <a
              href={`/manage/login?returnTo=${encodeURIComponent(window.location.hash)}`}
            >
              Sign in
            </a>
          </Button>
        ) : null}
        {copy.action === "platform" ? (
          <Button size={size} variant={variant} asChild>
            <a href="#/platform">Open Platform</a>
          </Button>
        ) : null}
        {copy.action === "none" && context?.collectionHref ? (
          <Button size={size} variant={variant} asChild>
            <a href={context.collectionHref}>Back to the list</a>
          </Button>
        ) : null}
        {copy.action === "copy-details" || named ? (
          <CopyButton
            value={JSON.stringify(copy.details, null, 2)}
            label="Copy details"
            showLabel
            size={named ? "xs" : size}
            text="Copy details"
          />
        ) : null}
      </div>
    </Unlocked>
  );
}

export { ErrorDescription } from "./CopyDetails.js";
