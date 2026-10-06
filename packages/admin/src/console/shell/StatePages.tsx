/**
 * State pages (ADMIN.md §3 T8, EXPERIENCE.md §9): not found, unknown product, service off and
 * boot. Each one says what is missing and offers the way out, rather than falling back to some
 * other page in silence (SH-8). The first three are the shared `ui/EmptyState` (kinds `not-found`
 * and `service-off`) under the page's `<h1>`, inside the product chrome.
 *
 * Motion (S-23 §6.1; MO-10): a state page and the boot error card enter (`animate-pk-enter`);
 * they leave with their route, which owns the exit. "Loading console…" waits out the skeleton's
 * 150 ms grace, so a fast boot never flashes it. All of it is an instant swap under reduced motion.
 */

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import type { ProductRef } from "../../api.js";
import { Logo } from "../../components/brand/Logo.js";
import { Button } from "../../ui/Button.js";
import { EmptyState } from "../../ui/EmptyState.js";
import { Spinner } from "../../ui/Spinner.js";
import type { NavSection } from "../nav.js";
import { Link } from "../router.js";
import { r } from "../routes.js";
import { LiveRegion } from "./bits.js";

/** A page title for a state page: an `<h1>` the route focus can land on. */
function StateHeading({ children }: { children: React.ReactNode }) {
  return (
    <h1
      tabIndex={-1}
      className="text-2xl font-bold tracking-tight text-fg-strong outline-hidden"
    >
      {children}
    </h1>
  );
}

/** Levenshtein distance, for "did you mean" on an unknown product slug. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!;
      prev[j] = Math.min(
        above + 1,
        prev[j - 1]! + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = above;
    }
  }
  return prev[b.length]!;
}

/** The slugs within edit distance 2 of `slug`, closest first. */
export function closestSlugs(
  slug: string,
  products: ProductRef[],
): ProductRef[] {
  return products
    .map((p) => ({
      p,
      d: editDistance(slug.toLowerCase(), p.slug.toLowerCase()),
    }))
    .filter(({ d }) => d <= 2)
    .sort((a, b) => a.d - b.d || a.p.slug.localeCompare(b.p.slug))
    .map(({ p }) => p);
}

export function NotFoundPage({
  path,
  slug,
  productName,
  onOpenPalette,
}: {
  path: string;
  slug?: string;
  productName?: string;
  onOpenPalette: () => void;
}): React.ReactElement {
  return (
    <section className="space-y-6 animate-pk-enter">
      <StateHeading>Page not found</StateHeading>
      <EmptyState
        kind="not-found"
        headingLevel={2}
        title={
          <>
            No page <code className="font-mono">{path || "/"}</code>
            {productName ? ` in ${productName}` : ""}
          </>
        }
        description="The link may be out of date, or the page may have moved. Search for it, or start from the overview."
        primaryAction={
          <Button asChild>
            <Link to={slug ? r.overview(slug) : r.home()}>
              {slug ? "Go to Overview" : "Go to Home"}
            </Link>
          </Button>
        }
        secondaryAction={
          <Button variant="outline" onClick={onOpenPalette}>
            Search or jump to…
          </Button>
        }
      />
    </section>
  );
}

export function UnknownProductPage({
  slug,
  products,
}: {
  slug: string;
  products: ProductRef[];
}): React.ReactElement {
  const close = closestSlugs(slug, products);
  return (
    <section className="space-y-6 animate-pk-enter">
      <StateHeading>Unknown product</StateHeading>
      <EmptyState
        kind="not-found"
        headingLevel={2}
        title={
          <>
            No product with the slug <code className="font-mono">{slug}</code>
          </>
        }
        description={
          close.length > 0 ? (
            <span>
              Did you mean{" "}
              {close.map((p, i) => (
                <React.Fragment key={p.slug}>
                  {i > 0 ? ", " : null}
                  <Link
                    to={r.overview(p.slug)}
                    className="font-mono text-accent-fg underline-offset-4 hover:underline"
                  >
                    {p.slug}
                  </Link>
                </React.Fragment>
              ))}
              ?
            </span>
          ) : (
            "Products are addressed by their slug. Pick one from the registry."
          )
        }
        primaryAction={
          // The closest match is the suggestion, so it is the primary (EXPERIENCE.md §9).
          close[0] ? (
            <Button asChild>
              <Link to={r.overview(close[0].slug)}>Open {close[0].name}</Link>
            </Button>
          ) : undefined
        }
        secondaryAction={
          <Button asChild variant={close[0] ? "outline" : "primary"}>
            <Link to={r.products()}>All products</Link>
          </Button>
        }
      />
    </section>
  );
}

/**
 * A deep link into a service this product does not run. The sidebar has already dropped the
 * section, so the way here is a bookmark, a shared URL, or a service turned off in another tab.
 * Rendering the view would fire requests the worker answers with 404s; this names the service and
 * puts the fix (Core → Services) one click away. It explains, it does not guard: every endpoint
 * gates itself on the worker.
 */
export function ServiceOffPage({
  section,
  slug,
  productName,
}: {
  section: NavSection;
  slug: string;
  productName: string;
}): React.ReactElement {
  return (
    <section
      className="space-y-6 animate-pk-enter"
      data-service={section.accent}
    >
      <StateHeading>{section.label}</StateHeading>
      <EmptyState
        kind="service-off"
        headingLevel={2}
        service={section.service ?? undefined}
        title={`The ${section.label} service isn’t enabled for ${productName}.`}
        description={`${productName} doesn’t run ${section.label}, so there is nothing here to manage. Turn it on in Services and this page comes back.`}
        primaryAction={
          <Button asChild>
            <Link to={r.services(slug)}>Enable {section.label}</Link>
          </Button>
        }
        docs={section.docs}
      />
    </section>
  );
}

/**
 * Before the session loads, and the console's own sign-in moment: the Polaris Key lockup (the
 * Pinned K, no bit, BRAND.md §6) above a live "Loading console…", or, when the session cannot
 * load, one card with Retry and Sign in. It shares the customer portal's sign-in look (the
 * centred lockup over a 28 rem card, brand type and spacing, both themes) without any of the
 * portal's customer parts, and matches the Worker's sign-in error pages (`core/brandHtml.ts`).
 */
export function BootScreen({
  error,
  onRetry,
}: {
  error?: boolean;
  onRetry?: () => void;
}): React.ReactElement {
  return (
    // A div, not <main>: the console's one main landmark is the shell's, and tests (and assistive
    // tech) waiting for it must not find this screen's instead.
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface-page px-4 py-12 text-fg">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <Logo subtitle="console" />
        {error ? (
          <section
            aria-labelledby="boot-error-title"
            className="w-full rounded-lg border border-border bg-surface-raised p-6 shadow-pk-sm animate-pk-enter sm:p-8"
          >
            <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-danger-subtle text-danger">
              <AlertTriangle aria-hidden className="size-5" />
            </div>
            <h1
              id="boot-error-title"
              className="text-xl font-bold tracking-tight text-fg-strong"
            >
              Can’t load the console
            </h1>
            <p className="mt-2 text-sm text-fg-muted">
              The admin session could not be loaded. Retry, or sign in again if
              your session ended.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <Button className="w-full" onClick={onRetry}>
                Retry
              </Button>
              <Button asChild variant="outline" className="w-full">
                <a href="/manage/login">Sign in</a>
              </Button>
            </div>
          </section>
        ) : (
          <div className="pk-skeleton-group flex items-center gap-3 text-sm text-fg-muted">
            <Spinner className="size-5 text-fg-subtle" />
            <LiveRegion message="Loading console…" />
            <span aria-hidden>Loading console…</span>
          </div>
        )}
      </div>
    </div>
  );
}
