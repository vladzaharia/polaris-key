import * as React from "react";
import { flushSync } from "react-dom";
import { Compass } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { viewTransition } from "../../ui/motion/index.js";
import { Skeleton } from "../../ui/Skeleton.js";
import type { PortalAccount } from "../api.js";
import { AttentionShelf } from "../components/AttentionShelf.js";
import { DiscoverTeaser } from "../components/DiscoverTeaser.js";
import { LibraryEmpty } from "../components/LibraryEmpty.js";
import { LibraryHero } from "../components/LibraryHero.js";
import { LibraryTile } from "../components/LibraryTile.js";
import { ErrorPanel } from "../components/States.js";
import { useLibrary } from "../library.js";
import {
  attentionItems,
  coverageNote,
  platformsOnlyNote,
  quickAction,
  type DeviceInHand,
  type LibraryProduct,
} from "../model/library.js";
import { href, setParams, useDocumentTitle } from "../router.js";
import { LiveRegion } from "../../ui/LiveRegion.js";
import { LibraryList } from "../components/LibraryList.js";
import { LibraryToolbar } from "../components/LibraryToolbar.js";
import {
  applyView,
  effectiveMode,
  justAddedFirst,
  readRememberedMode,
  readView,
  rememberMode,
} from "../model/libraryView.js";
import { useFirstLoad, useFirstLoadStagger } from "../stagger.js";

/**
 * The Library (§4.12–4.15), the default page: one tile per product, never per license.
 * 0 → the empty state; 1 → the hero; 2–7 → large tiles; 8+ → the shelf and the compact grid.
 *
 * Motion (notes/S-23 §6.1; MO-07): the tiles (or the list's rows) stagger in when the library
 * first arrives, never on a refetch, a filter, a return to the page or inside a View Transition
 * (`stagger.ts`); the
 * Grid/List toggle is one `list` View Transition. The page's own blocks are its `.pk-vt-scope`,
 * so during that transition they hold still while the products' view changes.
 *
 * A product added in the last 24 hours (PX-24) is first: under the default sort at 8+, and ahead
 * of the Worker's order in the 2–7 grid, which has no sort.
 */
export function LibraryPage({
  account,
  params,
}: {
  account: PortalAccount;
  params: URLSearchParams;
}): React.ReactElement {
  useDocumentTitle("Library");
  const lib = useLibrary();
  const count = lib.isPending ? 0 : (lib.products?.length ?? 0);
  // Only the document's first load staggers: never a return (Back from a product), never inside
  // a View Transition.
  const firstLoad = useFirstLoad("library", lib.isPending);

  return (
    <section className="pk-vt-scope space-y-8">
      <div className="space-y-2">
        <h1 className="text-[1.875rem] font-bold leading-tight text-fg-strong desk:text-[2.5rem]">
          Your library
        </h1>
        <p className="text-fg-muted">
          {count > 1 ? `${count} products · ` : ""}
          {count > 1 ? "signed in as " : "Signed in as "}
          <span className="text-fg-strong">{account.email}</span>
        </p>
      </div>
      {lib.isPending ? (
        // The large-tile grid's columns, so the page holds still when the library loads.
        <div className="grid gap-6 desk:grid-cols-2 wide:grid-cols-3" aria-busy>
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      ) : lib.error ? (
        <ErrorPanel error={lib.error} onRetry={lib.retry} />
      ) : count === 0 ? (
        <>
          <LibraryEmpty discoverCount={lib.discoverCount} />
          <DiscoverTeaser discoverCount={lib.discoverCount} />
        </>
      ) : (
        <LibraryBody
          products={lib.products!}
          device={lib.device}
          email={account.email}
          discoverCount={lib.discoverCount}
          params={params}
          firstLoad={firstLoad}
        />
      )}
    </section>
  );
}

function LibraryBody({
  products,
  device,
  email,
  discoverCount,
  params,
  firstLoad,
}: {
  products: LibraryProduct[];
  device: DeviceInHand;
  email: string;
  discoverCount: number | null;
  params: URLSearchParams;
  firstLoad: boolean;
}): React.ReactElement {
  const stagger = useFirstLoadStagger(firstLoad);
  const action = (p: LibraryProduct) =>
    quickAction(p, device, (s) => href.product(p.slug, s));
  if (products.length === 1) {
    const p = products[0]!;
    return (
      <>
        <LibraryHero product={p} action={action(p)} />
        <p className="flex items-center gap-2 text-fg-muted">
          <Compass aria-hidden className="size-4 shrink-0" />
          <span>
            That's everything linked to {email}.
            {discoverCount ? (
              <>
                {" "}
                {discoverCount === 1 ? "There is " : "There are "}
                <a
                  href={href.discover()}
                  className="font-bold text-accent-fg hover:underline"
                >
                  {discoverCount} more you can add in Discover
                </a>
                .
              </>
            ) : null}
          </span>
        </p>
      </>
    );
  }
  if (products.length < 8) {
    return (
      <section aria-labelledby="all-h">
        <h2 id="all-h" className="sr-only">
          All products
        </h2>
        <ul
          ref={stagger.ref}
          className={cn(
            "grid gap-6 desk:grid-cols-2 wide:grid-cols-3",
            stagger.className,
          )}
        >
          {justAddedFirst(products).map((p) => (
            <li key={p.slug} className="grid">
              <LibraryTile
                product={p}
                action={action(p)}
                note={coverageNote(p) ?? platformsOnlyNote(p, device)}
              />
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <ScaledLibrary
      products={products}
      device={device}
      params={params}
      firstLoad={firstLoad}
    />
  );
}

/** 8+ products (§4.15): toolbar, the shelf, then the compact grid or the list. */
function ScaledLibrary({
  products,
  device,
  params,
  firstLoad,
}: {
  products: LibraryProduct[];
  device: DeviceInHand;
  params: URLSearchParams;
  firstLoad: boolean;
}): React.ReactElement {
  const v = readView(params);
  const [remembered, setRemembered] = React.useState(readRememberedMode);
  const mode = effectiveMode(
    v.view,
    remembered,
    device.phone || isNarrow(),
    products.length,
  );
  const shown = applyView(products, v);
  const filtered = v.q.trim() !== "" || v.filter !== "all";
  const action = (p: LibraryProduct) =>
    quickAction(p, device, (s) => href.product(p.slug, s));
  const attention = products.filter((p) => p.status.attention).length;
  const summary = `Showing ${shown.length} of ${products.length}`;
  // Any search, filter, sort or view switch ends the first-load stagger for good.
  const stagger = useFirstLoadStagger(
    firstLoad,
    [mode, v.q, v.filter, v.sort].join("\n"),
  );
  // The products' section: its heading and its view (the grid or the list) are the rows of the
  // Grid/List transition.
  const productsSection = React.useRef<HTMLElement>(null);
  return (
    <>
      <LibraryToolbar
        total={products.length}
        q={v.q}
        filter={v.filter}
        sort={v.sort}
        mode={mode}
        attentionCount={attention}
        onChange={(patch) =>
          setParams({
            ...(patch.q !== undefined ? { q: patch.q } : {}),
            ...(patch.filter !== undefined
              ? { filter: patch.filter === "all" ? null : patch.filter }
              : {}),
            ...(patch.sort !== undefined
              ? { sort: patch.sort === "recent" ? null : patch.sort }
              : {}),
          })
        }
        onMode={(m) => {
          rememberMode(m);
          // One list transition (S-23 §6.1, D7): the old view leaves, the new one rises in, and
          // the rest of the page (the LibraryPage scope) holds still. Under reduced motion, or
          // without the API, an instant swap.
          viewTransition(
            () =>
              flushSync(() => {
                setRemembered(m);
                setParams({ view: m });
              }),
            { type: "list", list: productsSection.current },
          );
        }}
      />
      <LiveRegion message={filtered ? summary : ""} />
      {filtered ? null : (
        <AttentionShelf
          items={attentionItems(products, (s) => href.product(s, "devices"))}
        />
      )}
      <section
        ref={productsSection}
        aria-labelledby="all-h"
        className="space-y-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2
            id="all-h"
            className="flex items-baseline gap-3 text-lg font-bold text-fg-strong"
          >
            All products
            <span className="text-sm font-normal text-fg-muted">
              {v.sort === "name" ? "By name" : "Recently added first"}
            </span>
          </h2>
          {filtered ? (
            <p className="text-sm text-fg-muted">
              {summary} ·{" "}
              <button
                type="button"
                className="font-bold text-accent-fg hover:underline"
                onClick={() => setParams({ q: null, filter: null })}
              >
                Show all
              </button>
            </p>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-fg-muted">
            Nothing in your library matches
            {v.q.trim() ? ` “${v.q.trim()}”` : " this filter"}.
          </p>
        ) : mode === "list" ? (
          <LibraryList
            bodyRef={stagger.ref}
            bodyClassName={stagger.className}
            products={shown}
            actionFor={action}
            actionHeader={
              device.os && !device.phone
                ? `Quick action for this ${device.os === "macos" ? "Mac" : "computer"}`
                : "Quick action"
            }
          />
        ) : (
          // Compact tiles (§8): three columns on tablets, four from 1180 px. A narrow tile's
          // download reads "Download" (QuickActionButton's shortLabel).
          <ul
            ref={stagger.ref}
            data-library-grid="compact"
            className={cn(
              "grid gap-5 desk:grid-cols-3 wide:grid-cols-4",
              stagger.className,
            )}
          >
            {shown.map((p) => (
              <li key={p.slug} className="grid">
                <LibraryTile
                  product={p}
                  action={action(p)}
                  note={coverageNote(p) ?? platformsOnlyNote(p, device)}
                  compact
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function isNarrow(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 760px)").matches
    : false;
}
