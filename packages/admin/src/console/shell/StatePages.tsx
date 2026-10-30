/**
 * State pages (ADMIN.md §3 T8, EXPERIENCE.md §9): not found, page moved, unknown product, service
 * off and boot. Each one says what is missing and offers the way out, rather than falling back to
 * some other page in silence (SH-8). All but boot are the shared `ui/EmptyState` (kinds
 * `not-found` and `service-off`) under the page's `<h1>`, inside the product chrome.
 *
 * Motion (S-23 §6.1; MO-10): a state page and the boot error card enter (`animate-pk-enter`);
 * they leave with their route, which owns the exit. "Loading console…" waits out the skeleton's
 * 150 ms grace, so a fast boot never flashes it. All of it is an instant swap under reduced motion.
 */

import * as React from "react";
import { channelLabel } from "@polaris-key/manifest";
import type { ProductRef } from "../../api.js";
import { Logo } from "../../components/brand/Logo.js";
import { Button } from "../../ui/Button.js";
import { EmptyState } from "../../ui/EmptyState.js";
import { Spinner } from "../../ui/Spinner.js";
import {
  SETTINGS_HUB_PAGES,
  SETTINGS_TAB_OF,
  featureOfSection,
  pageOf,
  sectionOf,
  type NavSection,
  type ProductPageId,
} from "../nav.js";
import { humanize } from "../../lib/status.js";
import { Link } from "../router.js";
import { movedHref, r, searchTermFor, type MovedTo } from "../routes.js";
import { LiveRegion } from "../../ui/LiveRegion.js";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "../../ui/toast.js";
import { mutate } from "../data/mutations.js";
import { qk } from "../data/queries.js";
import { useWriteGate } from "../access/useCan.js";

/** A page title for a state page: an `<h1>` the route focus can land on. */
function StateHeading({ children }: { children: React.ReactNode }) {
  return (
    <h1
      tabIndex={-1}
      className="text-2xl font-semibold tracking-tight text-fg-strong outline-hidden"
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

/**
 * A path that matches no page. "Search or jump to…" opens the palette already searching for the
 * dead segment (`searchTermFor`), so a near miss is one Enter away.
 */
export function NotFoundPage({
  path,
  slug,
  productName,
  onOpenPalette,
}: {
  path: string;
  slug?: string;
  productName?: string;
  /** Open the command palette with `query` typed into it. */
  onOpenPalette: (query?: string) => void;
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
          <Button
            variant="outline"
            onClick={() => onOpenPalette(searchTermFor(path))}
          >
            Search or jump to…
          </Button>
        }
      />
    </section>
  );
}

/**
 * A removed 0.9 address (`routeLedger.ts`): not found, but the page says where it went and links
 * there, keeping the record id and the query. A page deleted with no successor says that instead.
 * It does not redirect; the 0.9 line keeps no compatibility windows, and the bookmark is the
 * operator's to update.
 */
export function MovedPage({
  path,
  slug,
  moved,
  query,
  onOpenPalette,
}: {
  path: string;
  slug?: string;
  moved: MovedTo;
  query: URLSearchParams;
  onOpenPalette: (query?: string) => void;
}): React.ReactElement {
  const target = moved.page ? pageOf(moved.page) : undefined;
  const section = moved.page ? sectionOf(moved.page) : undefined;
  const record = moved.id !== undefined ? target?.record : undefined;
  // The hub's tabs are reached from Settings, whatever section the page sits in.
  const tab = moved.page
    ? SETTINGS_TAB_OF[moved.page as ProductPageId]
    : undefined;
  // A page that moved to one record's tab ("Ship builds → App Store → Releases", A-22.4).
  const toRecord =
    moved.page && moved.id !== undefined && moved.tab !== undefined
      ? { name: channelLabel(moved.id), tab: moved.tab }
      : undefined;
  const feature = section ? featureOfSection(section.key) : null;
  const home = toRecord
    ? `${(feature?.label ?? section?.label ?? "").replace(/ /g, "\u00a0")}\u00a0\u2192\u00a0${toRecord.name}\u00a0\u2192\u00a0`
    : moved.page && SETTINGS_HUB_PAGES.includes(moved.page as ProductPageId)
      ? `Settings\u00a0\u2192\u00a0${tab ? `${pageOf(tab).label}\u00a0\u2192\u00a0` : ""}`
      : section
        ? `${section.label}\u00a0\u2192\u00a0`
        : "";
  const href = movedHref(slug, moved, query);
  const fallback = slug ? r.overview(slug) : r.home();
  return (
    <section className="space-y-6 animate-pk-enter">
      <StateHeading>Page moved</StateHeading>
      <EmptyState
        kind="moved"
        headingLevel={2}
        // No-break spaces keep "License → Licenses" on one line when the title wraps on a phone.
        title={
          target
            ? toRecord
              ? `This page moved to ${home}${humanize(toRecord.tab)}`
              : `This page moved to ${home}${target.label}`
            : "This page was deleted"
        }
        description={
          <>
            An address from before the console was reorganized:{" "}
            <code className="font-mono">{path}</code>.{" "}
            {target
              ? "Update your bookmark to the new one."
              : "Nothing replaces it."}
          </>
        }
        primaryAction={
          <Button asChild>
            <Link to={href ?? fallback}>
              {toRecord
                ? `Open ${toRecord.name} ${toRecord.tab}`
                : target && record
                  ? `Open ${record.noun.toLowerCase()} ${moved.id}`
                  : target
                    ? `Go to ${target.label}`
                    : slug
                      ? "Go to Overview"
                      : "Go to Home"}
            </Link>
          </Button>
        }
        secondaryAction={
          <Button variant="outline" onClick={() => onOpenPalette()}>
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
                    className="font-mono py-1 text-accent-fg underline-offset-4 hover:underline"
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
            <Link to={r.home()}>All products</Link>
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
/** Sign-in's own way back: one button on the page, no trip to Services (I-29). */
function TurnOnSignIn({ slug }: { slug: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const gate = useWriteGate("core", slug);
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      loading={busy}
      disabled={!gate.allowed}
      disabledReason={gate.disabledReason}
      onClick={() => {
        setBusy(true);
        mutate("updateServices", slug, {
          services: { identity: { enabled: true } },
        })
          .then((next) => {
            queryClient.setQueryData(qk.services(slug), next);
            void queryClient.invalidateQueries({ queryKey: qk.product(slug) });
            toast.success("Sign-in turned on");
          })
          .catch((error) => toast.error(error))
          .finally(() => setBusy(false));
      }}
    >
      Turn on Sign-in
    </Button>
  );
}

export function ServiceOffPage({
  section,
  slug,
  productName,
}: {
  section: NavSection;
  slug: string;
  productName: string;
}): React.ReactElement {
  const signIn = section.key === "identity";
  // The operator's words: the feature (the Features tab's rows), never a service slug.
  const feature = featureOfSection(section.key)?.label ?? section.label;
  return (
    <section
      className="space-y-6 animate-pk-enter"
      data-service={section.accent}
    >
      <StateHeading>{signIn ? "App sign-in" : feature}</StateHeading>
      <EmptyState
        kind="service-off"
        headingLevel={2}
        service={section.service ?? undefined}
        title={
          signIn
            ? `Sign-in is off for ${productName}.`
            : `${feature} is off for ${productName}.`
        }
        description={
          signIn
            ? `No one can sign in to ${productName} until Sign-in is on. Accounts and settings are kept.`
            : `${productName} doesn't use ${feature}, so there is nothing here to manage. Turn it on in Features and this page comes back.`
        }
        primaryAction={
          signIn ? (
            <TurnOnSignIn slug={slug} />
          ) : (
            // A link: the Features tab holds the switch and gates it itself.
            <Button asChild>
              <Link to={r.services(slug)}>Open Features</Link>
            </Button>
          )
        }
        docs={section.docs}
        docsFor={signIn ? "App sign-in" : feature}
      />
    </section>
  );
}

/** A link to a page whose store is not one of the product's channels (A-20.7). */
export function ChannelOutOfScopePage({
  section,
  title,
  slug,
  channel,
}: {
  section: NavSection;
  /** The page's own label (App Store), not its section's. */
  title: string;
  slug: string;
  /** The catalogue channel id the page needs. */
  channel: string;
}): React.ReactElement {
  return (
    <section
      className="space-y-6 animate-pk-enter"
      data-service={section.accent}
    >
      <StateHeading>{title}</StateHeading>
      <EmptyState
        kind="not-found"
        headingLevel={2}
        title={`${channelLabel(channel)} isn't one of this product's channels`}
        description="Its platforms and builds don't fit this store."
        primaryAction={
          <Button asChild>
            <Link to={r.storefronts(slug)}>Open Storefronts</Link>
          </Button>
        }
        docs={section.docs}
      />
    </section>
  );
}

/**
 * Before the session loads: the Polaris Key lockup (the Pinned K, no bit, BRAND.md §6) above a
 * live "Loading console…". When the session cannot load, `ConsoleOffline` (the shared AuthCard)
 * takes over, and the Worker's sign-in card (`console/signinPage.ts`) covers the rest.
 */
export function BootScreen(): React.ReactElement {
  return (
    // A div, not <main>: the console's one main landmark is the shell's, and tests (and assistive
    // tech) waiting for it must not find this screen's instead.
    <div className="flex min-h-dvh flex-col items-center justify-center bg-surface-page px-4 py-12 text-fg">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <Logo subtitle="console" />
        <div className="pk-skeleton-group flex items-center gap-3 text-sm text-fg-muted">
          <Spinner className="size-5 text-fg-subtle" />
          <LiveRegion message="Loading console…" />
          <span aria-hidden>Loading console…</span>
        </div>
      </div>
    </div>
  );
}
