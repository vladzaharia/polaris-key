import { ErrorState } from "../../ui/ErrorState.js";
import { t, tParts } from "../../lib/copy.js";
import * as React from "react";
import { flushSync } from "react-dom";
import { Compass } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { viewTransition } from "../../ui/motion/index.js";
import { Skeleton } from "../../ui/Skeleton.js";
import type { PortalAccount } from "../api.js";
import { AttentionShelf } from "../components/AttentionShelf.js";
import { LibraryEmpty } from "../components/LibraryEmpty.js";
import { LibraryKeyTile } from "../components/LibraryKeyTile.js";
import { LibraryHero } from "../components/LibraryHero.js";
import { LibraryTile } from "../components/LibraryTile.js";
import { libraryGrid, TILE_GRID } from "../components/tileGrid.js";
import { useLibrary } from "../library.js";
import {
  attentionItems,
  coverageNote,
  platformsOnlyNote,
  quickAction,
  type DeviceInHand,
  type LibraryProduct,
} from "../model/library.js";
import { useDownloadFailedNotice } from "../downloadNotice.js";
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
  useDocumentTitle(t("locker.library.title"));
  useDownloadFailedNotice(params);
  const lib = useLibrary();
  const count = lib.isPending ? 0 : (lib.products?.length ?? 0);
  // Only the document's first load staggers: never a return (Back from a product), never inside
  // a View Transition.
  const firstLoad = useFirstLoad("library", lib.isPending);

  return (
    // A short screen (§8) tightens the gap under the title, so a hero's download is on screen.
    <section className="pk-vt-scope space-y-6 desk:pt-4 short:space-y-4 short:pt-0">
      <div className="space-y-2">
        <h1 className="text-page-title-sm font-semibold text-fg-strong desk:text-page-title">
          {t("locker.library.heading")}
        </h1>
        <p className="text-fg-muted">
          {tParts("locker.library.signedInAs", ["email"]).map((part, i) =>
            typeof part === "string" ? (
              part
            ) : (
              <span key={i} className="text-fg-strong">
                {account.email}
              </span>
            ),
          )}
        </p>
      </div>
      {lib.isPending ? (
        // The large-tile grid's columns, so the page holds still when the library loads.
        // A tile is its 16:9 art and about 150 px of text; the key tile is dashed.
        <div className={TILE_GRID} aria-busy>
          <SkeletonTile />
          <SkeletonTile />
          <SkeletonTile className="hidden desk:block" />
          <SkeletonTile className="hidden wide:block" />
        </div>
      ) : lib.error ? (
        <ErrorState
          error={lib.error}
          onRetry={lib.retry}
          message={t("locker.error.loadFailedLibrary")}
        />
      ) : count === 0 ? (
        <LibraryEmpty discoverCount={lib.discoverCount} />
      ) : (
        <>
          <LibraryBody
            products={lib.products!}
            device={lib.device}
            email={account.email}
            discoverCount={lib.discoverCount}
            params={params}
            firstLoad={firstLoad}
          />
        </>
      )}
    </section>
  );
}

function SkeletonTile({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <div aria-hidden className={cn("space-y-2 rounded-xl", className)}>
      <Skeleton className="aspect-[5/2] w-full rounded-xl" />
      {/* The text block of a loaded tile, measured at 390, 768, 1024 and 1440: about 144 px from
          1024 px, 176 from 761 and 224 on phones, where the text wraps more and every link and
          button takes the 44 px touch floor (B-084). */}
      <Skeleton className="h-56 w-full rounded-xl min-[761px]:h-[10.8rem] min-[1024px]:h-36" />
    </div>
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
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {t("locker.library.everything", { email })}
            {discoverCount ? (
              <>
                {" "}
                <a
                  href={href.discover()}
                  className="font-medium text-accent-fg underline underline-offset-2"
                >
                  {t("locker.library.more", { count: discoverCount })}
                </a>
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
          {t("locker.library.allProducts")}
        </h2>
        <ul
          ref={stagger.ref}
          className={cn(libraryGrid(products.length + 1), stagger.className)}
        >
          {justAddedFirst(products).map((p) => (
            <li key={p.slug} className="grid">
              {/* No "Windows and Linux only" here: the tile's platform glyphs already say it
                  (B-086); the compact tiles below draw no glyphs, so they keep the note. */}
              <LibraryTile
                product={p}
                action={action(p)}
                note={coverageNote(p)}
              />
            </li>
          ))}
          <LibraryKeyTile />
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
  const mode = effectiveMode(v.view, remembered);
  const shown = applyView(products, v);
  const filtered = v.q.trim() !== "" || v.filter !== "all";
  const action = (p: LibraryProduct) =>
    quickAction(p, device, (s) => href.product(p.slug, s));
  const attention = products.filter((p) => p.status.attention).length;
  const summary = t("locker.library.showing", {
    count: shown.length,
    total: products.length,
  });
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
      {filtered ? null : (
        <AttentionShelf
          items={attentionItems(products, (s) => href.product(s, "devices"))}
        />
      )}
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
      <section
        ref={productsSection}
        aria-labelledby="all-h"
        className="flex flex-col gap-4"
      >
        <h2 id="all-h" className="sr-only">
          {t("locker.library.allProducts")}
          <span>
            {" "}
            ·{" "}
            {v.sort === "name"
              ? t("locker.library.byName")
              : t("locker.library.recentFirst")}
          </span>
        </h2>
        {filtered ? (
          <p className="text-sm text-fg-muted">
            {summary} ·{" "}
            <button
              type="button"
              className="inline-flex min-h-6 items-center font-medium text-accent-fg hover:underline"
              onClick={() => setParams({ q: null, filter: null })}
            >
              {t("locker.library.showAll")}
            </button>
          </p>
        ) : null}
        {shown.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-fg-muted">
            {v.q.trim()
              ? t("locker.library.noMatchQuery", { name: v.q.trim() })
              : t("locker.library.noMatchFilter")}
          </p>
        ) : mode === "list" ? (
          <LibraryList
            bodyRef={stagger.ref}
            bodyClassName={stagger.className}
            products={shown}
            actionFor={action}
            actionHeader={
              device.os && !device.phone
                ? device.os === "macos"
                  ? t("locker.library.quickMac")
                  : t("locker.library.quickComputer")
                : t("locker.library.quick")
            }
          />
        ) : (
          // Compact tiles (§8, PX-35): the shared grid (`tileGrid.ts`). A narrow tile's download
          // reads "Download" (QuickActionButton's shortLabel).
          <ul
            ref={stagger.ref}
            data-library-grid="compact"
            className={cn(TILE_GRID, stagger.className)}
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
