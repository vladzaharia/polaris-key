import * as React from "react";
import {
  AlertCircle,
  ArrowLeft,
  Compass,
  ExternalLink,
  LayoutGrid,
  Plus,
} from "lucide-react";
import { Button } from "../../ui/Button.js";
import { StationaryStar } from "../../ui/EmptyState.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { toast } from "../../ui/toast.js";
import { cn } from "../../lib/cn.js";
import {
  PortalApiError,
  type PortalObtainPath,
  type PortalStorefrontProduct,
} from "../api.js";
import { REASON_ICON } from "../components/DiscoverTile.js";
import { PlatformGlyphs } from "../components/Glyphs.js";
import { ProductArt } from "../components/ProductArt.js";
import { ProductIcon } from "../components/ProductIcon.js";
import { SectionCard } from "../components/product/Card.js";
import { ErrorPanel } from "../components/States.js";
import {
  useClaimDiscover,
  useLibraryView,
  useStorefrontProduct,
} from "../data.js";
import { isNotFound, portalErrorCopy } from "../errors.js";
import { requestHeadingFocus } from "../focus.js";
import {
  offerPlatforms,
  pathCopy,
  pathTermsLine,
  storeLinkLabel,
} from "../model/discover.js";
import { mediaUrl } from "../model/library.js";
import { href, useDocumentTitle } from "../router.js";

/**
 * The storefront product page, `#/discover/:product` (PS-05; notes/S-21 §6.5): a product the
 * person could add, before it is theirs. The listing (art, the one-line description, the
 * description and the screenshots, the platforms), every way to add it with its terms, the
 * product's store pages, and **Add to library**. With more than one way, the person picks one;
 * the first (the Worker's order, the tile's reason) is preselected.
 *
 * After Add the page is replaced by the product's library page (`#/p/:product`), which takes
 * focus on its `h1`: the storefront page no longer exists for this person, so Back skips it. A
 * product the library already holds goes there too.
 *
 * Unknown, unlisted, ineligible and withdrawn products all answer the Worker's one `404`, and
 * the page shows them one way (S-21 D5: no enumeration). A link-only listing (shown to everyone
 * with nothing to add) has no Add: its actions are its store pages.
 */
export function StorefrontPage({
  product: slug,
}: {
  product: string;
}): React.ReactElement {
  const q = useStorefrontProduct(slug);
  const library = useLibraryView();
  // The library's own answer, never the Worker's: a product it holds lives on its library page.
  const held = library.data?.products.some((p) => p.product === slug) === true;
  React.useEffect(() => {
    if (held) window.location.replace(href.product(slug));
  }, [held, slug]);
  const notFound = q.error != null && isNotFound(q.error);
  useDocumentTitle(
    q.data
      ? q.data.name
      : q.isPending || held
        ? null
        : notFound
          ? "Not available"
          : "Something went wrong",
  );
  if (q.isPending || library.isPending || held) return <StorefrontSkeleton />;
  if (notFound) return <NotOffered />;
  if (q.error || !q.data)
    return (
      <ErrorPanel error={q.error} onRetry={() => void q.refetch()} asPage />
    );
  return <StorefrontBody product={q.data} />;
}

function StorefrontSkeleton(): React.ReactElement {
  return (
    <div aria-busy className="space-y-6">
      <h1 className="sr-only">Loading</h1>
      <Skeleton className="h-64 w-full rounded-xl desk:h-80" />
      <div className="grid gap-6 desk:grid-cols-[minmax(0,1fr)_24rem]">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </div>
  );
}

/** Every 404 alike: unknown, unlisted, not offered to this account, or no longer offered. */
function NotOffered(): React.ReactElement {
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      <StationaryStar />
      <h1 className="text-[1.875rem] font-bold leading-tight text-fg-strong">
        There's nothing to add here
      </h1>
      <p className="text-fg-muted">
        This link doesn't lead to a product you can add from this account right
        now.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild variant="outline" size="lg">
          <a href={href.discover()}>
            <Compass aria-hidden />
            Browse Discover
          </a>
        </Button>
        <Button asChild variant="quiet" size="lg">
          <a href={href.library()}>
            <LayoutGrid aria-hidden />
            Back to your library
          </a>
        </Button>
      </div>
    </section>
  );
}

interface AddError {
  text: string;
  /** The offer is gone (409 `not_eligible`): no Add any more. */
  ended: boolean;
}

function StorefrontBody({
  product,
}: {
  product: PortalStorefrontProduct;
}): React.ReactElement {
  const claim = useClaimDiscover();
  const slug = product.product;
  const [chosen, setChosen] = React.useState<string | null>(
    product.paths[0]?.kind ?? null,
  );
  const [error, setError] = React.useState<AddError | null>(null);
  // A double click fires twice before React re-renders the button as busy.
  const inFlight = React.useRef(false);
  const errorId = "storefront-add-error";

  const add = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      // The first path is the Worker's default: name a path only when the person chose another.
      const path =
        chosen !== null && chosen !== product.paths[0]?.kind
          ? chosen
          : undefined;
      await claim.mutateAsync({ product: slug, path });
      toast.success(`${product.name} is in your library`);
      // The library page takes focus on its heading; this page is replaced, so Back skips it.
      requestHeadingFocus(slug);
      window.location.replace(href.product(slug));
    } catch (err) {
      setError(addError(product, err));
    } finally {
      inFlight.current = false;
    }
  };

  const shots = product.screenshots.flatMap((s) => mediaUrl(s) ?? []);
  const platforms = offerPlatforms(product.platforms);
  const canAdd = product.cta === "add" && !error?.ended;
  return (
    <div className="space-y-6 desk:space-y-8">
      <StorefrontHeader product={product}>
        {product.cta === "link" ? (
          <StoreButtons product={product} lead />
        ) : canAdd ? (
          <Button
            size="lg"
            className="h-12 w-full px-6 font-bold desk:w-auto"
            iconStart={<Plus aria-hidden />}
            loading={claim.isPending}
            aria-describedby={error ? errorId : undefined}
            onClick={() => void add()}
          >
            Add to library
          </Button>
        ) : null}
      </StorefrontHeader>
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="flex gap-2 rounded-lg border border-danger-border bg-surface-raised p-4 text-danger"
        >
          <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0" />
          {error.text}
        </p>
      ) : null}
      <div className="flex flex-col gap-6 desk:grid desk:grid-cols-[minmax(0,1fr)_21.25rem] desk:items-start wide:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {product.description || platforms.length ? (
            <SectionCard id="about" title={`About ${product.name}`}>
              <div className="space-y-4">
                {product.description ? (
                  <p className="whitespace-pre-line text-fg [overflow-wrap:anywhere]">
                    {product.description}
                  </p>
                ) : null}
                {platforms.length ? (
                  <p className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
                    Runs on
                    <PlatformGlyphs platforms={platforms} />
                  </p>
                ) : null}
              </div>
            </SectionCard>
          ) : null}
          {shots.length ? (
            <SectionCard id="screenshots" title="Screenshots">
              <ul className="grid gap-3 desk:grid-cols-2">
                {shots.map((src, i) => (
                  <li key={src}>
                    <img
                      src={src}
                      alt={`${product.name}, screenshot ${i + 1} of ${shots.length}`}
                      decoding="async"
                      className="aspect-video w-full rounded-lg border border-border bg-surface-sunken object-cover"
                    />
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {product.cta === "add" ? (
            <WaysToAdd
              paths={product.paths}
              chosen={chosen}
              onChoose={setChosen}
              disabled={claim.isPending || error?.ended === true}
            />
          ) : null}
          {product.cta === "add" && product.stores.length ? (
            <SectionCard id="stores" title="Also on">
              <StoreButtons product={product} />
            </SectionCard>
          ) : null}
        </div>
      </div>
      <p className="flex gap-2 text-sm text-fg-muted">
        <Compass aria-hidden className="mt-0.5 size-4 shrink-0" />
        {product.cta === "add"
          ? "Adding it is free and puts it in your library."
          : `${product.developerName ?? "Its developer"} shows it to everyone with a Polaris Key account.${
              product.stores.length
                ? " Get it from a store above."
                : siteOf(product)
                  ? " Get it from their website above."
                  : ""
            }`}
      </p>
    </div>
  );
}

/**
 * The header: back to Discover, the cover (as the library's product page draws it), the icon in
 * front of its lower edge, the name as the page's `h1`, "by <developer>", the one-line
 * description, and the page's one action. The art, icon and name carry the hero names the
 * router flies the Discover tile into (MO-05): opened from Discover, the tile's offer seeds the
 * page (`useStorefrontProduct`), so the header is there in the transition's first frame.
 */
function StorefrontHeader({
  product,
  children,
}: {
  product: PortalStorefrontProduct;
  children: React.ReactNode;
}): React.ReactElement {
  const [coverFailed, setCoverFailed] = React.useState(false);
  const cover = mediaUrl(product.headerUrl);
  const hasCover = Boolean(cover) && !coverFailed;
  return (
    <div>
      <a
        href={href.discover()}
        className="mb-4 inline-flex items-center gap-2 rounded-sm text-sm text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Discover
      </a>
      {hasCover ? (
        <ProductArt
          slug={product.product}
          name={product.name}
          tint={product.tintColor}
          src={cover}
          variant="banner"
          onError={() => setCoverFailed(true)}
          className="pk-vt-hero -mx-4 aspect-video desk:mx-0 desk:aspect-[3/1] desk:max-h-[26rem] desk:rounded-xl"
        />
      ) : null}
      <div
        data-cover={hasCover ? "image" : "none"}
        className={cn(
          "flex gap-4 desk:gap-6",
          hasCover
            ? "flex-col desk:flex-row desk:items-end desk:px-6"
            : "flex-row flex-wrap items-center pt-2 desk:flex-nowrap",
        )}
      >
        <ProductIcon
          slug={product.product}
          name={product.name}
          tint={product.tintColor}
          src={mediaUrl(product.iconUrl)}
          size={112}
          lift={hasCover}
          tileClassName="border-4 border-surface-page max-desk:text-3xl"
          className={cn(
            "pk-vt-hero-icon relative z-10 max-desk:size-20",
            hasCover && "-mt-10 desk:-mt-16 desk:self-start",
          )}
        />
        <div className="min-w-0 flex-1 space-y-2 desk:pb-1">
          <h1
            tabIndex={-1}
            className="pk-vt-hero-title w-fit text-[1.75rem] font-bold leading-tight text-fg-strong outline-none desk:text-4xl"
          >
            {product.name}
          </h1>
          {product.developerName ? (
            <p className="text-fg-muted">
              by{" "}
              <span className="font-bold text-accent-fg">
                {product.developerName}
              </span>
            </p>
          ) : null}
          {product.shortDescription ? (
            <p className="max-w-prose text-fg [overflow-wrap:anywhere]">
              {product.shortDescription}
            </p>
          ) : null}
        </div>
        <div className="flex max-desk:w-full desk:pb-1">{children}</div>
      </div>
    </div>
  );
}

/**
 * Every way to add the product, each with why and what it gives (S-21 §6.5). With more than one,
 * a choice; the first (the Worker's order) is preselected.
 */
function WaysToAdd({
  paths,
  chosen,
  onChoose,
  disabled,
}: {
  paths: readonly PortalObtainPath[];
  chosen: string | null;
  onChoose: (kind: string) => void;
  disabled: boolean;
}): React.ReactElement {
  const several = paths.length > 1;
  return (
    <SectionCard
      id="ways"
      title={several ? "Ways to add it" : "Why you can add it"}
      subtitle={several ? "Pick the one Add uses." : undefined}
    >
      {several ? (
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="sr-only">Choose how to add it</legend>
          {paths.map((p) => (
            <label
              key={p.kind}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-3",
                chosen === p.kind
                  ? "border-accent bg-accent-subtle"
                  : "border-border hover:bg-hover",
              )}
            >
              <input
                type="radio"
                name="storefront-path"
                value={p.kind}
                checked={chosen === p.kind}
                onChange={() => onChoose(p.kind)}
                className="mt-1 size-4 shrink-0 accent-[var(--pk-accent)]"
              />
              <PathLines path={p} />
            </label>
          ))}
        </fieldset>
      ) : (
        <ul className="space-y-2">
          {paths.map((p) => (
            <li
              key={p.kind}
              className="flex gap-3 rounded-lg bg-surface-sunken p-3"
            >
              <PathLines path={p} icon />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function PathLines({
  path,
  icon = false,
}: {
  path: PortalObtainPath;
  icon?: boolean;
}): React.ReactElement {
  const copy = pathCopy(path);
  const Icon = REASON_ICON[copy.kind];
  return (
    <>
      {icon ? (
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-fg" />
      ) : null}
      <span className="min-w-0">
        <span className="block font-bold text-fg-strong">{copy.text}</span>
        <span className="block text-sm text-fg-muted">
          {pathTermsLine(path)}
        </span>
      </span>
    </>
  );
}

/** "Get it on <store>" for each of the product's live store pages, opening in a new tab. */
function StoreButtons({
  product,
  lead = false,
}: {
  product: PortalStorefrontProduct;
  lead?: boolean;
}): React.ReactElement | null {
  const site = siteOf(product);
  const links = product.stores.length
    ? product.stores.map((s) => ({
        id: s.id,
        url: s.url,
        label: storeLinkLabel(s),
      }))
    : lead && site
      ? [
          {
            id: "website",
            url: site,
            label: `Get it from ${product.developerName ?? "the developer"}`,
          },
        ]
      : [];
  if (links.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-2", lead && "max-desk:w-full")}>
      {links.map((l, i) => (
        <li key={l.id} className={cn(lead && "max-desk:w-full")}>
          <Button
            asChild
            // One solid lead per page: the first store; any others are outlined.
            variant={lead && i === 0 ? "primary" : lead ? "outline" : "quiet"}
            size="lg"
            className={cn(lead ? "h-12 w-full px-6 font-bold" : "h-11")}
          >
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`${l.label}: ${product.name} (opens in a new tab)`}
            >
              <ExternalLink aria-hidden />
              {l.label}
            </a>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The developer's website, when it is an `https:` page. */
function siteOf(product: PortalStorefrontProduct): string | null {
  return product.website && /^https:\/\//.test(product.website)
    ? product.website
    : null;
}

/** An Add that didn't go through, in the person's words (§6.4). */
function addError(product: PortalStorefrontProduct, err: unknown): AddError {
  if (
    err instanceof PortalApiError &&
    err.status === 409 &&
    err.code === "not_eligible"
  )
    return {
      text: `${product.developerName ?? "The developer"} stopped this offer.`,
      ended: true,
    };
  const copy = portalErrorCopy(err);
  return { text: `${copy.title}. ${copy.description}`, ended: false };
}
