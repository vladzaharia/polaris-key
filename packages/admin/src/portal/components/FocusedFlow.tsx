import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { href } from "../router.js";
import { Lockup } from "./Lockup.js";
import { ProductArt } from "./ProductArt.js";
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
        className="flex-1 px-4 pb-16 pt-6 outline-none desk:pt-10"
      >
        {children}
      </main>
    </div>
  );
}

/** The flow's card: the product's art strip, its icon overlapping, "Name · Developer". */
export function FlowCard({
  slug,
  name,
  developer,
  tint,
  iconUrl,
  headerUrl,
  children,
  className,
}: {
  slug: string;
  name: string;
  developer: string | null;
  tint: string | null;
  iconUrl: string | null;
  headerUrl: string | null;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section
      className={cn(
        "mx-auto w-full max-w-[41rem] overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1",
        className,
      )}
    >
      <ProductArt
        slug={slug}
        name={name}
        tint={tint}
        src={headerUrl}
        variant="banner"
        // No cover: a bare tint field; the icon overlapping the strip already shows the letter.
        letter={false}
        className="h-24 desk:h-30"
      />
      <div className="px-5 pb-6 desk:px-8 desk:pb-8">
        <ProductIcon
          slug={slug}
          name={name}
          tint={tint}
          src={iconUrl}
          size={64}
          lift
          className="relative -mt-8"
          tileClassName="border-[3px] border-surface-raised"
        />
        <p className="mt-3 text-sm text-fg-muted">
          {name}
          {developer ? ` · ${developer}` : ""}
        </p>
        {children}
      </div>
    </section>
  );
}
