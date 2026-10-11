import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { href } from "../router.js";
import { Lockup } from "./Lockup.js";
import { ProductIcon } from "./ProductIcon.js";

/**
 * Minimal chrome for one task (PORTAL.md §3.2 "Focused flows", §4.25, §5.2 `FocusedFlow`): the
 * lockup and one way back, no nav, no footer links. The way back is the app (`back.href` is
 * then a return URL the product declares, already checked by `allowedReturn`) or the product
 * page. One `banner`, one `main`; the flow's step supplies the page's one `h1`.
 */
export function FocusedFlow({
  back,
  children,
}: {
  back: {
    label: string;
    href: string;
    external: boolean;
    /** Words dropped on phones so the label fits ("without changes"). */
    tail?: string;
  };
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-page text-fg">
      <a
        href="#flow"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("flow")?.focus();
        }}
        className="sr-only z-50 rounded-md bg-surface-overlay px-3 py-2 text-fg-strong focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-surface-page">
        <div className="mx-auto flex h-14 w-full max-w-[82rem] items-center justify-between gap-4 px-4 desk:h-16 desk:px-8">
          <a
            href={href.library()}
            aria-label="Polaris Key: your library"
            className="flex shrink-0 items-center rounded-md"
          >
            <Lockup height={64} className="hidden desk:block" />
            <Lockup height={52} className="desk:hidden" />
          </a>
          <a
            href={back.href}
            className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-fg hover:text-fg-strong"
          >
            <ArrowLeft aria-hidden className="size-4 shrink-0" />
            <span className="truncate">
              {back.label}
              {back.tail ? (
                <span className="hidden sm:inline"> {back.tail}</span>
              ) : null}
            </span>
          </a>
        </div>
      </header>
      <main
        id="flow"
        tabIndex={-1}
        className="flex-1 px-4 pb-16 pt-6 outline-none desk:pt-10 short:pt-4"
      >
        {children}
      </main>
    </div>
  );
}

/**
 * The shared focused-task frame (PORTAL.md §4.25): a factual breadcrumb, a task title and a
 * 56 px product identity row. It deliberately has no cropped art band: art belongs to a whole
 * frame, never a slice behind unrelated task content.
 */
export function TaskFrame({
  slug,
  name,
  developer,
  tint,
  iconUrl,
  task,
  title,
  identityMeta,
  aside,
  children,
  className,
}: {
  slug: string;
  name: string;
  developer: string | null;
  tint: string | null;
  iconUrl: string | null;
  /** Factual task context, for example "Device access" or "Download". */
  task: string;
  /** The page's one h1, supplied by the task so it can retain its focus ref. */
  title: React.ReactNode;
  /** A task-specific fact stated beside the product identity once. */
  identityMeta?: string | null;
  /** Facts that belong with identity, such as the device-seat meter. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const meta = [
    developer ? `From ${developer}` : null,
    identityMeta,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[40rem] shortdesk:max-w-[65rem]",
        className,
      )}
    >
      <p className="mb-2 text-xs text-fg-muted">
        <span dir="auto">{name}</span> / {task}
      </p>
      {title}
      <div className="mt-5 grid gap-6 shortdesk:grid-cols-[20rem_minmax(0,1fr)] shortdesk:gap-8">
        <div className="space-y-3">
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface-raised p-3">
            <ProductIcon
              slug={slug}
              name={name}
              tint={tint}
              src={iconUrl}
              size={56}
            />
            <div className="min-w-0">
              <p dir="auto" className="break-words font-semibold text-fg-strong">
                {name}
              </p>
              {meta ? <p className="text-sm text-fg-muted">{meta}</p> : null}
            </div>
          </div>
          {aside}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}


/** @internal Temporary migration surface while PX-29 moves both focused flows to TaskFrame. */
export function FlowCard({
  slug,
  name,
  developer,
  tint,
  iconUrl,
  children,
  className,
}: {
  slug: string;
  name: string;
  developer: string | null;
  tint: string | null;
  iconUrl: string | null;
  /** Retained only while callers migrate in this work package. */
  headerUrl: string | null;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <TaskFrame
      slug={slug}
      name={name}
      developer={developer}
      tint={tint}
      iconUrl={iconUrl}
      task="Device access"
      title={null}
      className={className}
    >
      {children}
    </TaskFrame>
  );
}