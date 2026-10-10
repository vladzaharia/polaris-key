import * as React from "react";
import { Info, LayoutGrid } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/Button.js";
import { StationaryStar } from "../../ui/EmptyState.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { toast } from "../../ui/toast.js";
import { PortalApiError, type PortalDiscoverOffer } from "../api.js";
import {
  DiscoverTile,
  type DiscoverTileState,
} from "../components/DiscoverTile.js";
import { ErrorPanel } from "../components/States.js";
import { useClaimDiscover, useDiscover, useLibraryView } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import {
  addedOfferFromLibrary,
  addedParam,
  mergeAdded,
  withAdded,
} from "../model/discover.js";
import { withoutHeld } from "../model/owned.js";
import {
  currentParams,
  href,
  navigate,
  setParams,
  useDocumentTitle,
} from "../router.js";
import { useFirstLoad, useFirstLoadStagger } from "../stagger.js";

interface TileError {
  text: string;
  /** The offer is gone (409 `not_eligible`). */
  ended: boolean;
}

/**
 * Discover (PORTAL.md §4.16; notes/S-21 §6.5): every product the account could add for free
 * right now, as Discover tiles with their terms and the always-visible reason (the first way to
 * add it; the storefront page `#/discover/:product` lists every way), plus any listing its
 * developer shows everyone with nothing to add, whose tile links to its store pages. An open
 * product (nothing to licence) adds as a library entry, not a licence. **Add to library** adds once
 * (the button is guarded while its request runs, and the Worker's claim is idempotent), then the
 * tile shows the just-added state, also after a reload through `?added=<product>` (repeated once
 * per product added, so a second add keeps the first one's tile; the most recent few). With
 * nothing to add, the star and **Back to your library**.
 *
 * Motion (MO-07): the tiles stagger in when the offers first arrive (`stagger.ts`), never on a
 * refetch, a return to the page or inside a View Transition; a just-added tile's ring pops in
 * (`DiscoverTile`).
 */
export function DiscoverPage({
  params,
}: {
  params: URLSearchParams;
}): React.ReactElement {
  useDocumentTitle("Discover");
  const discover = useDiscover();
  const library = useLibraryView();
  const claim = useClaimDiscover();
  // `?added=<p>` (repeated) after a reload: those products are in the library now.
  const query = params.toString();
  const addedParams = React.useMemo(
    () => addedParam(new URLSearchParams(query)),
    [query],
  );
  // Only the document's first load staggers: never a return, never inside a View Transition.
  const firstLoad = useFirstLoad(
    "discover",
    discover.isPending || (addedParams.length > 0 && library.isPending),
  );
  const stagger = useFirstLoadStagger(firstLoad);

  // Added in this visit, kept as the offer that was shown (the Worker stops listing it).
  const [added, setAdded] = React.useState<Map<string, PortalDiscoverOffer>>(
    () => new Map(),
  );
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [errors, setErrors] = React.useState<Map<string, TileError>>(
    () => new Map(),
  );
  // In-flight adds, outside render: a double click fires twice before React re-renders.
  const inFlight = React.useRef(new Set<string>());
  // After an add the button is gone: focus moves to the tile's Open link (§9.4).
  const [focusOpen, setFocusOpen] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!focusOpen) return;
    document.getElementById(`offer-${focusOpen}-open`)?.focus();
    setFocusOpen(null);
  }, [focusOpen]);

  // `?added=` after a reload: each product is in the library now, so its tile comes from there.
  const fromReload = React.useMemo(
    () =>
      addedParams.flatMap((slug) => {
        if (added.has(slug)) return [];
        const item = library.data?.products.find((p) => p.product === slug);
        return item ? [addedOfferFromLibrary(item)] : [];
      }),
    [addedParams, added, library.data],
  );

  // The server's offers never include what the library holds (`withoutHeld`, G24); the tiles
  // added on this page are merged in afterwards, so a just-added product keeps its tile.
  const offers = withoutHeld(discover.data ?? [], library.data?.products);
  const addedTiles = [...added.values()];
  for (const tile of fromReload)
    if (!offers.some((o) => o.product === tile.product)) addedTiles.push(tile);
  const addedSlugs = new Set(addedTiles.map((o) => o.product));
  const tiles = mergeAdded(
    offers.filter((o) => !addedSlugs.has(o.product)),
    addedTiles,
  );

  const add = async (offer: PortalDiscoverOffer): Promise<void> => {
    const slug = offer.product;
    if (inFlight.current.has(slug)) return;
    inFlight.current.add(slug);
    setAdding((s) => new Set(s).add(slug));
    setErrors((m) => {
      const next = new Map(m);
      next.delete(slug);
      return next;
    });
    try {
      await claim.mutateAsync({ product: slug });
      setAdded((m) => new Map(m).set(slug, offer));
      setFocusOpen(slug);
      // Read now, not from this render: another add may have finished meanwhile.
      setParams({ added: withAdded(addedParam(currentParams()), slug) });
      toast.success(`${offer.name} is in your library`, {
        action: {
          label: "Open",
          onClick: () => navigate(href.product(slug)),
        },
      });
    } catch (err) {
      setErrors((m) => new Map(m).set(slug, tileError(offer, err)));
    } finally {
      inFlight.current.delete(slug);
      setAdding((s) => {
        const next = new Set(s);
        next.delete(slug);
        return next;
      });
    }
  };

  const pending =
    discover.isPending || (addedParams.length > 0 && library.isPending);
  const empty = !pending && !discover.error && tiles.length === 0;

  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-page-title-sm font-semibold text-fg-strong desk:text-page-title">
          Discover
        </h1>
        <p className="text-fg-muted">
          {empty
            ? "Products their developers offer to your account, free to add."
            : "Products their developers offer to your account. Adding one puts it in your library straight away, at no cost."}
        </p>
      </div>
      {pending ? (
        // Two columns on tablets, three from 1180 px (§4.16), as the loaded grid.
        <div className="grid gap-5 desk:grid-cols-2 wide:grid-cols-3" aria-busy>
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="hidden h-96 rounded-xl desk:block" />
          <Skeleton className="hidden h-96 rounded-xl wide:block" />
        </div>
      ) : discover.error ? (
        <ErrorPanel
          error={discover.error}
          onRetry={() => void discover.refetch()}
        />
      ) : empty ? (
        <section
          aria-labelledby="discover-empty-h"
          className="flex flex-col items-center gap-4 py-10 text-center"
        >
          <StationaryStar />
          <h2
            id="discover-empty-h"
            className="text-2xl font-semibold text-fg-strong desk:text-3xl"
          >
            Nothing to add right now
          </h2>
          <p className="max-w-prose text-fg-muted">
            When a developer offers something to your account, like a free game,
            a beta or an app your team gets, it appears here.
          </p>
          <Button asChild variant="action" size="lg" className="h-12">
            <a href={href.library()}>
              <LayoutGrid aria-hidden />
              Back to your library
            </a>
          </Button>
        </section>
      ) : (
        <>
          <section aria-labelledby="offers-h">
            <h2 id="offers-h" className="sr-only">
              Products you can add
            </h2>
            <ul
              ref={stagger.ref}
              className={cn(
                "grid gap-5 desk:grid-cols-2 wide:grid-cols-3",
                stagger.className,
              )}
            >
              {tiles.map((offer) => {
                const slug = offer.product;
                const state: DiscoverTileState = addedSlugs.has(slug)
                  ? "added"
                  : adding.has(slug)
                    ? "adding"
                    : "offer";
                const error = errors.get(slug);
                return (
                  <li key={slug} className="grid">
                    <DiscoverTile
                      offer={offer}
                      state={state}
                      error={error?.text ?? null}
                      ended={error?.ended ?? false}
                      onAdd={() => void add(offer)}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
          <p className="flex gap-2 text-sm text-fg-muted">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            Only products you can add for free appear here. Anything you buy
            shows up in your library by itself.
          </p>
        </>
      )}
    </section>
  );
}

/** An Add that didn't go through, in the person's words (§6.4), inline on the tile. */
function tileError(offer: PortalDiscoverOffer, err: unknown): TileError {
  if (
    err instanceof PortalApiError &&
    err.status === 409 &&
    err.code === "not_eligible"
  ) {
    return {
      text: `${offer.developerName ?? "The developer"} stopped this offer.`,
      ended: true,
    };
  }
  const copy = portalErrorCopy(err);
  return { text: `${copy.title}. ${copy.description}`, ended: false };
}
