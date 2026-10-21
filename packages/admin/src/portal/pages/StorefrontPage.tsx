import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { ProductArt } from "../components/ProductArt.js";
import { ProductIcon } from "../components/ProductIcon.js";
import { SectionCard } from "../components/product/Card.js";
import { ErrorPanel } from "../components/States.js";
import {
  portalKeys,
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
import { t } from "../../lib/copy.js";
import { platformConsumerName } from "../../lib/vocab/platforms.js";

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
          ? t("core.codes.mint-unavailable.title")
          : t("core.fallback.title"),
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
      <h1 className="sr-only">{t("common.loading")}</h1>
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
      <h1 className="text-3xl font-semibold leading-tight text-fg-strong">
        {t("locker.storefront.nothingTitle")}
      </h1>
      <p className="text-fg-muted">{t("locker.storefront.nothingBody")}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild variant="outline" size="lg">
          <a href={href.discover()}>
            <Compass aria-hidden />
            {t("locker.storefront.browse")}
          </a>
        </Button>
        <Button asChild variant="quiet" size="lg">
          <a href={href.library()}>
            <LayoutGrid aria-hidden />
            {t("locker.discover.empty.back")}
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
  const qc = useQueryClient();
  const slug = product.product;
  const [chosen, setChosen] = React.useState<string | null>(
    product.paths[0]?.kind ?? null,
  );
  const [error, setError] = React.useState<AddError | null>(null);
  // A double click fires twice before React re-renders the button as busy.
  const inFlight = React.useRef(false);

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
      toast.success(t("locker.discover.added", { product: product.name }));
      // The library page takes focus on its heading; this page is replaced, so Back skips it.
      requestHeadingFocus(slug);
      window.location.replace(href.product(slug));
    } catch (err) {
      const failed = addError(product, err);
      // The offer is gone: Discover stops listing it.
      if (failed.ended)
        void qc.invalidateQueries({ queryKey: portalKeys.discover });
      setError(failed);
    } finally {
      inFlight.current = false;
    }
  };

  const shots = product.screenshots.flatMap((s) => mediaUrl(s) ?? []);
  const platforms = offerPlatforms(product.platforms);
  const canAdd = product.cta === "add" && !error?.ended;
  return (
    <div>
      <nav aria-label={t("locker.storefront.breadcrumb")} className="mb-2">
        <a
          href={href.discover()}
          className="inline-flex min-h-11 items-center gap-2 rounded-sm text-sm text-fg-muted hover:text-fg-strong"
        >
          <ArrowLeft aria-hidden className="size-4" />
          {t("locker.discover.title")}
        </a>
      </nav>
      <div className="flex flex-col gap-6 desk:grid desk:grid-cols-[minmax(0,1fr)_21.25rem] desk:items-start desk:gap-x-8 desk:gap-y-8 wide:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 desk:col-start-1 desk:row-start-1">
          <StorefrontHeader product={product} />
        </div>
        <aside className="@container min-w-0 desk:sticky desk:top-24 desk:col-start-2 desk:row-span-2 desk:row-start-1">
          <DecisionPanel
            product={product}
            platforms={platforms}
            chosen={chosen}
            onChoose={setChosen}
            canAdd={canAdd}
            adding={claim.isPending}
            error={error}
            onAdd={() => void add()}
          />
        </aside>
        {product.description || shots.length ? (
          <div className="flex min-w-0 flex-col gap-6 desk:col-start-1 desk:row-start-2 desk:gap-8">
            {product.description ? (
              <p className="max-w-prose whitespace-pre-line text-fg break-words hyphens-auto">
                {product.description}
              </p>
            ) : null}
            {shots.length ? (
              <SectionCard
                id="screenshots"
                title={t("locker.storefront.screenshots")}
                className="min-w-0"
              >
                <ul className="grid gap-3 desk:grid-cols-2">
                  {shots.map((src, i) => (
                    <li key={src}>
                      <img
                        src={src}
                        alt={t("locker.storefront.shot", {
                          product: product.name,
                          n: i + 1,
                          total: shots.length,
                        })}
                        decoding="async"
                        className="aspect-video w-full rounded-lg border border-border bg-surface-sunken object-cover"
                      />
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The one decision panel (PX-32a, portal-19): where it runs, what the person would get, why they
 * qualify, and the one action. With several ways to add it, the rows become a choice. Add is the
 * one primary; a store-only listing has no Add, its store links are the action.
 */
function DecisionPanel({
  product,
  platforms,
  chosen,
  onChoose,
  canAdd,
  adding,
  error,
  onAdd,
}: {
  product: PortalStorefrontProduct;
  platforms: ReturnType<typeof offerPlatforms>;
  chosen: string | null;
  onChoose: (kind: string) => void;
  canAdd: boolean;
  adding: boolean;
  error: AddError | null;
  onAdd: () => void;
}): React.ReactElement {
  const errorId = "storefront-add-error";
  const paths = product.paths;
  const several = paths.length > 1;
  const path = paths.find((p) => p.kind === chosen) ?? paths[0] ?? null;
  const lockedIn = adding || error?.ended === true;
  // Add unmounts once the offer has ended: focus goes to the way out.
  const backRef = React.useRef<HTMLAnchorElement>(null);
  const ended = error?.ended === true;
  React.useEffect(() => {
    if (ended) backRef.current?.focus();
  }, [ended]);
  const hasLinks = product.stores.length > 0 || siteOf(product) !== null;
  const hasFooter =
    product.cta === "link"
      ? hasLinks
      : canAdd || error !== null || product.stores.length > 0;
  return (
    <SectionCard
      id="get"
      title={t("locker.storefront.get", { product: product.name })}
    >
      <div className="-mx-5 -mb-5 desk:-mx-6 desk:-mb-6">
        {platforms.length || (product.cta === "add" && !several && path) ? (
          <dl className="divide-y divide-border border-t border-border text-sm">
            {platforms.length ? (
              <Row term={t("locker.storefront.runsOn")}>
                {platforms.map((p) => platformConsumerName(p)).join(", ")}
              </Row>
            ) : null}
            {product.cta === "add" && !several && path ? (
              <>
                <Row term={t("locker.storefront.youGet")}>
                  {pathTermsLine(path)}
                </Row>
                <Row term={t("locker.storefront.youQualify")}>
                  {pathCopy(path).text}
                </Row>
              </>
            ) : null}
          </dl>
        ) : null}
        {product.cta === "add" && several ? (
          <div className="border-t border-border px-5 py-4 @max-[20rem]:px-3 desk:px-6">
            <fieldset disabled={lockedIn} className="min-w-0 space-y-2">
              <legend className="mb-1 text-sm text-fg-muted">
                {t("locker.storefront.ways")}
              </legend>
              {paths.map((p) => (
                <label
                  key={p.kind}
                  className={cn(
                    "flex min-h-11 cursor-pointer gap-3 rounded-lg border p-2.5 @max-[20rem]:gap-2 @max-[20rem]:p-2",
                    chosen === p.kind
                      ? "border-border-strong bg-surface-sunken"
                      : "border-border hover:bg-hover",
                  )}
                >
                  <input
                    type="radio"
                    name="storefront-path"
                    value={p.kind}
                    checked={chosen === p.kind}
                    onChange={() => onChoose(p.kind)}
                    className="mt-1 size-4 shrink-0 accent-[var(--pk-fg-strong,currentColor)]"
                  />
                  <PathLines path={p} />
                </label>
              ))}
            </fieldset>
          </div>
        ) : null}
        {product.cta === "link" && !hasLinks ? (
          <p className="border-t border-border px-5 py-4 text-sm text-fg-muted desk:px-6">
            {t("locker.storefront.linkOnly", {
              developer:
                product.developerName ?? t("locker.storefront.itsDeveloper"),
            })}
          </p>
        ) : null}
        {hasFooter ? (
          <div className="space-y-3 border-t border-border px-5 py-4 @max-[20rem]:px-3 desk:px-6 desk:py-5">
            {product.cta === "link" ? (
              <StoreButtons product={product} lead />
            ) : canAdd ? (
              <Button
                size="lg"
                className="h-auto min-h-12 w-full whitespace-normal px-6 py-2 font-medium"
                iconStart={<Plus aria-hidden />}
                loading={adding}
                aria-describedby={error ? errorId : undefined}
                onClick={onAdd}
              >
                {adding ? t("locker.offer.adding") : t("locker.offer.add")}
              </Button>
            ) : null}
            {error ? (
              <div className="space-y-3">
                <p
                  id={errorId}
                  role="alert"
                  className="flex gap-2 text-sm text-danger"
                >
                  <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {error.text}
                </p>
                {error.ended ? (
                  <Button
                    asChild
                    variant="outline"
                    size="lg"
                    className="h-auto min-h-12 w-full whitespace-normal px-6 py-2 font-medium"
                  >
                    <a ref={backRef} href={href.discover()}>
                      {t("locker.storefront.backDiscover")}
                    </a>
                  </Button>
                ) : null}
              </div>
            ) : null}
            {product.cta === "add" && product.stores.length ? (
              <AlsoOn product={product} />
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

function Row({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 py-3 @max-[20rem]:px-3 desk:px-6">
      <dt className="w-[6.5rem] shrink-0 text-fg-muted">{term}</dt>
      <dd className="min-w-0 flex-[1_1_8rem] text-fg break-words hyphens-auto">
        {children}
      </dd>
    </div>
  );
}

/** "Also on the App Store, Google Play and Steam": each store name a link to its page. */
function AlsoOn({
  product,
}: {
  product: PortalStorefrontProduct;
}): React.ReactElement {
  const n = product.stores.length;
  return (
    <p className="text-sm text-fg-muted">
      {t("locker.offer.alsoOn")}{" "}
      {product.stores.map((s, i) => (
        <React.Fragment key={s.id}>
          {i > 0 ? (i === n - 1 ? " and " : ", ") : null}
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer"
            aria-label={t("locker.offer.newTabAria", {
              store: s.label,
              product: product.name,
            })}
            className="rounded-sm font-medium text-fg-strong underline decoration-fg-subtle underline-offset-[3px] hover:decoration-fg-strong"
          >
            {s.label}
          </a>
        </React.Fragment>
      ))}
      .
    </p>
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
}: {
  product: PortalStorefrontProduct;
}): React.ReactElement {
  const [coverFailed, setCoverFailed] = React.useState(false);
  const cover = mediaUrl(product.headerUrl);
  const hasCover = Boolean(cover) && !coverFailed;
  // On a phone the icon stands for the cover, so the panel reaches the first screen.
  const hasIcon = Boolean(mediaUrl(product.iconUrl));
  return (
    <div className="@container">
      {hasCover ? (
        <ProductArt
          slug={product.product}
          name={product.name}
          tint={product.tintColor}
          src={cover}
          variant="banner"
          onError={() => setCoverFailed(true)}
          className={cn(
            "pk-vt-hero aspect-[3/1] rounded-xl desk:aspect-[3/1] desk:max-h-[26rem]",
            hasIcon && "max-desk:hidden",
          )}
        />
      ) : null}
      <div
        data-cover={hasCover ? "image" : "none"}
        className={cn(
          "flex flex-col gap-3 @[20rem]:flex-row @[20rem]:items-start @[20rem]:gap-4",
          hasCover ? (hasIcon ? "desk:mt-5" : "mt-5") : "pt-2",
        )}
      >
        <ProductIcon
          slug={product.product}
          name={product.name}
          tint={product.tintColor}
          src={mediaUrl(product.iconUrl)}
          size={64}
          className="pk-vt-hero-icon shrink-0"
        />
        <div className="min-w-0 flex-1 space-y-1 @[20rem]:pt-1">
          <h1
            tabIndex={-1}
            className="pk-vt-hero-title w-fit max-w-full text-headline break-words hyphens-auto font-semibold leading-tight text-fg-strong outline-none desk:text-4xl"
          >
            {product.name}
          </h1>
          {product.developerName ? (
            <p className="text-fg-muted">by {product.developerName}</p>
          ) : null}
        </div>
      </div>
      {product.shortDescription ? (
        <p className="mt-5 max-w-prose text-fg break-words hyphens-auto">
          {product.shortDescription}
        </p>
      ) : null}
    </div>
  );
}

function PathLines({ path }: { path: PortalObtainPath }): React.ReactElement {
  const copy = pathCopy(path);
  const devices = path.terms?.deviceLimit ?? 0;
  // A trial's name already says how long: the line under it adds only what is new.
  const line =
    copy.kind === "trial" && devices > 0
      ? t("devices.count", { count: devices })
      : pathTermsLine(path);
  return (
    <span className="min-w-0">
      <span className="block font-medium text-fg-strong">{copy.text}</span>
      <span className="block text-sm text-fg-muted">{line}</span>
    </span>
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
            label: t("locker.offer.getFrom", {
              developer:
                product.developerName ?? t("license.developerFallback"),
            }),
          },
        ]
      : [];
  if (links.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-2", lead && "w-full flex-col")}>
      {links.map((l, i) => (
        <li key={l.id} className={cn(lead && "w-full")}>
          <Button
            asChild
            // One solid lead per page: the first store; any others are outlined.
            variant={lead && i === 0 ? "primary" : lead ? "outline" : "quiet"}
            size="lg"
            className={cn(
              lead
                ? "h-auto min-h-12 w-full whitespace-normal px-6 py-2 font-medium"
                : "h-11",
            )}
          >
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              aria-label={t("locker.offer.newTabAria", {
                store: l.label,
                product: product.name,
              })}
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
      text: t("locker.discover.ended", {
        developer: product.developerName ?? t("license.developerFallbackCap"),
        product: product.name,
      }),
      ended: true,
    };
  // The words PX-34 settled on Discover's tile.
  const offline = err instanceof PortalApiError && err.status === 0;
  const copy = portalErrorCopy(err);
  return {
    text: `${t("locker.discover.addFailed", { product: product.name })} ${offline ? t("core.codes.transport.message") : copy.description}`,
    ended: false,
  };
}
