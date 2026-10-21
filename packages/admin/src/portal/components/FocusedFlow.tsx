import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { focusPageHeading, href } from "../router.js";
import { Lockup } from "./Lockup.js";
import { ProductIcon } from "./ProductIcon.js";

/**
 * Minimal chrome for one task (PORTAL.md §3.2 "Focused flows", §4.25, §5.2 `FocusedFlow`): the
 * lockup and one way back, no nav, no footer links. The way back is the app (`back.href` is
 * then a return URL the product declares, already checked by `allowedReturn`) or the product
 * page. One `banner`, one `main`; the flow's step supplies the page's one `h1` (`TaskFrame`
 * draws it for a product that has loaded; the loading, not-found and error screens bring their
 * own).
 *
 * Focus lands on that heading once it is the real one, on arrival by a link as well as by a
 * route change (§4.25 item 5): the router focuses it after a hash navigation, and a person who
 * opens the flow from an app or an email has no navigation to do it. A loading placeholder is
 * waited past, never announced.
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
  React.useEffect(() => {
    let alive = true;
    focusPageHeading(undefined, () => alive);
    return () => {
      alive = false;
    };
  }, []);
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
        <div className="mx-auto flex min-h-14 w-full max-w-[82rem] items-center justify-between gap-4 px-4 desk:min-h-16 desk:px-8">
          <a
            href={href.library()}
            aria-label="Polaris Locker: your library"
            className="flex shrink-0 items-center rounded-md"
          >
            <Lockup height={64} className="hidden desk:block" />
            <Lockup height={52} className="desk:hidden" />
          </a>
          <a
            href={back.href}
            aria-label={`${back.label}${back.tail ? ` ${back.tail}` : ""}`}
            className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-fg hover:text-fg-strong"
          >
            <ArrowLeft aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 break-words max-[23.99rem]:hidden">
              {back.label}
              {back.tail ? (
                <span className="hidden sm:inline"> {back.tail}</span>
              ) : null}
            </span>
            <span aria-hidden className="min-[24rem]:hidden">
              Back
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
 * The focused task frame (PORTAL.md §4.25 "The focused task frame"; free a device and the
 * focused download): a factual 12 px breadcrumb ("<Product> / Device access", "<Product> /
 * Download"), the task title at the display step, and a 56 px product identity row where a
 * cropped cover band used to be. Art, if a task ever shows it, is the whole frame, never a slice
 * behind unrelated content.
 *
 * The composition is centred: one 640 px column, and on a short desktop (at least 1024 px wide
 * and at most 900 px tall) or a phone on its side, the identity beside the task, so the task's
 * action is on the first screen (the `twocol` variant, styles.css). The title spans both columns.
 *
 * The frame draws the page's one `h1` so every task has the same display step; the task passes
 * the words (`title`), the ref its focus management needs (`titleRef`) and, for a success, the
 * check that leads the title (`titleIcon`).
 */
export function TaskFrame({
  slug,
  name,
  developer,
  tint,
  iconUrl,
  task,
  title,
  titleRef,
  titleIcon,
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
  /** Factual task context after the product's name: "Device access" or "Download". */
  task: string;
  /** The words of the page's one `h1`. */
  title: React.ReactNode;
  titleRef?: React.Ref<HTMLHeadingElement>;
  /** A decorative glyph before the title (the success check); never the only carrier. */
  titleIcon?: React.ReactNode;
  /** A task-specific fact stated beside the product's identity, once. */
  identityMeta?: string | null;
  /** Facts that belong with the identity, such as the device-seat meter. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const meta = [developer ? `From ${developer}` : null, identityMeta]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[40rem] twocol:max-w-[65rem]",
        className,
      )}
    >
      <p className="mb-2 text-xs text-fg-muted">
        <span dir="auto">{name}</span> / {task}
      </p>
      <h1
        ref={titleRef}
        tabIndex={-1}
        className="flex items-start gap-3 text-page-title-sm font-semibold tracking-[-0.02em] text-fg-strong outline-none desk:text-page-title short:text-page-title-sm"
      >
        {titleIcon ? (
          <span
            aria-hidden
            className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center desk:mt-2 short:mt-0.5"
          >
            {titleIcon}
          </span>
        ) : null}
        <span className="min-w-0 break-words">{title}</span>
      </h1>
      <div className="mt-6 grid gap-6 twocol:grid-cols-[20rem_minmax(0,1fr)] twocol:items-start twocol:gap-8">
        <div className="space-y-3">
          <div
            data-identity=""
            className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3 flex-wrap [&>:last-child]:min-w-[10rem] [&>:last-child]:flex-1"
          >
            <ProductIcon
              slug={slug}
              name={name}
              tint={tint}
              src={iconUrl}
              size={56}
            />
            <div className="min-w-0">
              <p
                dir="auto"
                className="font-semibold text-fg-strong [overflow-wrap:anywhere]"
              >
                {name}
              </p>
              {meta ? (
                <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                  {meta}
                </p>
              ) : null}
            </div>
          </div>
          {aside}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

/**
 * A task's action row on a phone (PORTAL.md §4.25: under 761 px the action row is sticky): stuck
 * to the bottom of the screen with a top edge, so Remove is never below the fold however long the
 * list. From 761 px it sits in the flow, and so it does on a short screen, where a stuck row
 * would cover a third of the viewport (§8).
 */
export function StickyActions({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      data-sticky-actions=""
      className={cn(
        "sticky bottom-0 z-10 -mx-4 border-t border-border bg-surface-page px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3",
        "desk:static desk:mx-0 desk:border-0 desk:bg-transparent desk:p-0",
        "short:static short:mx-0 short:border-0 short:bg-transparent short:p-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The frame's loading shape: the breadcrumb, the title and the identity row hold their places
 * (and the task its block) while the product loads, so the page does not jump when it lands.
 * `aria-busy` with a visually hidden `h1`: the router and the flow wait past this placeholder
 * for the real heading instead of announcing "Loading".
 */
export function TaskFrameSkeleton(): React.ReactElement {
  return (
    <div
      aria-busy
      className="mx-auto w-full max-w-[40rem] twocol:max-w-[65rem]"
    >
      <h1 className="sr-only">Loading</h1>
      <Skeleton className="mb-3 h-3 w-40" />
      <Skeleton className="h-9 w-3/4 desk:h-13" />
      <div className="mt-6 grid gap-6 twocol:grid-cols-[20rem_minmax(0,1fr)] twocol:gap-8">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
