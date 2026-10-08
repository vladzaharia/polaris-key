import * as React from "react";
import { Skeleton } from "../../ui/Skeleton.js";
import type { PortalAccount } from "../api.js";
import { DevicesCard } from "../components/product/DevicesCard.js";
import { GetItPanel } from "../components/product/GetItPanel.js";
import { HelpCard } from "../components/product/HelpCard.js";
import { LicenseCard } from "../components/product/LicenseCard.js";
import { ProductHeader } from "../components/product/ProductHeader.js";
import { SectionNav } from "../components/product/SectionNav.js";
import { WhatsNew } from "../components/product/WhatsNew.js";
import { ErrorPanel } from "../components/States.js";
import {
  capabilitiesOrNone,
  useCapabilities,
  useLicense,
  usePackageAccess,
  useProduct,
} from "../data.js";
import { PackageAccessCard } from "../components/product/PackageAccessCard.js";
import { ProductIdentityCard } from "../components/product/ProductIdentityCard.js";
import { RemoveLicenseDialog } from "../components/product/RemoveLicenseDialog.js";
import { toast } from "../../ui/toast.js";
import { consumeHeadingFocus, focusSectionHeading } from "../focus.js";
import { useLibrary } from "../library.js";
import {
  quickAction,
  tierLabel,
  type LicensedProduct,
} from "../model/library.js";
import {
  presentSections,
  readUaHints,
  resolveDevice,
  seatLimitFor,
  seatsFor,
  showsDeviceCount,
  storeFor,
  tierName,
  withSeats,
} from "../model/product.js";
import {
  focusPageHeading,
  href,
  navigate,
  scrollBehavior,
  setParams,
  useDocumentTitle,
  type ProductSection,
} from "../router.js";
import { EntryProductBody } from "./EntryProductPage.js";
import { NotFoundProduct } from "./NotFoundProduct.js";

/**
 * The product page (§4.20) on today's data: everything about one product in one place. The
 * license comes from `?license=` or the best one; sections that don't apply are omitted with
 * their TOC entry and pill.
 */
export function ProductPage({
  account,
  product: slug,
  section,
  params,
}: {
  account: PortalAccount;
  product: string;
  section: ProductSection | null;
  params: URLSearchParams;
}): React.ReactElement {
  const lib = useLibrary();
  const product = lib.products?.find((p) => p.slug === slug);
  useDocumentTitle(
    product
      ? product.name
      : lib.isPending
        ? null
        : lib.error
          ? "Something went wrong"
          : "Not in your library",
  );
  if (lib.isPending) return <ProductSkeleton />;
  if (lib.error)
    return <ErrorPanel error={lib.error} onRetry={lib.retry} asPage />;
  if (!product) return <NotFoundProduct email={account.email} />;
  // An open product's entry (PS-04): no licence, so no licence card, devices or package access.
  if (product.kind === "entry")
    return <EntryProductBody product={product} device={lib.device} />;
  return (
    <ProductBody
      product={product}
      section={section}
      requested={params.get("license")}
      device={lib.device}
    />
  );
}

function ProductSkeleton(): React.ReactElement {
  return (
    <div aria-busy className="space-y-6">
      <h1 className="sr-only">Loading</h1>
      <Skeleton className="h-80 w-full rounded-xl" />
      <div className="grid gap-6 desk:grid-cols-[1fr_340px]">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

function ProductBody({
  product,
  section,
  requested,
  device,
}: {
  product: LicensedProduct;
  section: ProductSection | null;
  requested: string | null;
  device: ReturnType<typeof useLibrary>["device"];
}): React.ReactElement {
  const caps = capabilitiesOrNone(useCapabilities());
  const releasesOn = caps.modules.releases;
  const selected =
    product.licenses.find((l) => l.id === requested) ?? product.best;
  const detail = useLicense(product.slug, selected.id);
  // One device source (§0.6 P4): the seats the free-device flow reads too.
  const view = useProduct(product.slug);
  const seats = seatsFor(view.data, selected.id);
  // One OS source (§0.6 P3): the header's action and Get it work from the same answer.
  const here = React.useMemo(
    () => resolveDevice(product.downloads, device, readUaHints()),
    [product.downloads, device],
  );
  const pkg = usePackageAccess(product.slug, selected.id);
  // Per-licence seat limits (PX-W1) from the same product view; the library only carries the
  // best licence's.
  const seatLimit = seatLimitFor(product, view.data, selected.id);
  const showCount = showsDeviceCount(product, selected);
  // The store of an active purchase on each licence (PX-W6): the origin names it with the key.
  const storeOf = (id: string): string | null => storeFor(view.data, id);
  const sections = presentSections(product, releasesOn, {
    packageAccess: pkg.data?.available === true,
  });
  const [current, setCurrent] = React.useState<ProductSection | null>(
    section && sections.includes(section) ? section : (sections[0] ?? null),
  );
  // A section picked in the nav, or opened by a deep link, keeps the mark until the person
  // scrolls by themselves (see the reading effect below).
  const held = React.useRef<ProductSection | null>(
    section && sections.includes(section) && section !== sections[0]
      ? section
      : null,
  );
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  // PX-23: the header menu's Remove from my library, for the licence the page shows.
  const [removing, setRemoving] = React.useState(false);
  const removed = (others: number): void => {
    if (others > 0) {
      toast.success(
        `The ${tierName(selected)} license was removed from your library`,
      );
      setParams({ license: null });
      focusPageHeading(() => headingRef.current);
      return;
    }
    toast.success(`${product.name} was removed from your library`);
    navigate(href.library());
  };

  // After adding this product, focus its heading (§9.4): once the dialog has left (through its
  // exit) and handed focus back to its opener, and without scrolling away from a deep link.
  React.useEffect(() => {
    if (consumeHeadingFocus(product.slug))
      focusPageHeading(() => headingRef.current);
  }, [product.slug]);

  // A section deep link scrolls there once.
  React.useEffect(() => {
    if (!section || section === sections[0]) return;
    document
      .getElementById(`section-${section}`)
      ?.scrollIntoView?.({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The nav marks the section being read (owner polish 2026-10-07): the one whose top most
  // recently passed the reading line, which sits where a jump to a section puts it (its scroll
  // margin), so the mark walks down the nav in the page's order as the page scrolls, whichever
  // column a card is in; two cards that share a top go to the later one in that order. Over the
  // page's last screen of scrolling the line slides down to the screen's bottom, so the last
  // cards, which can never reach the top, are still each marked in turn before the page runs
  // out. A section picked in the nav (or a deep link) holds the mark until the person scrolls
  // themselves (wheel, touch, a scroll key or the scrollbar), so a card beside it never takes it.
  // One read per frame, after a scroll.
  React.useEffect(() => {
    let frame = 0;
    const read = (): void => {
      frame = 0;
      if (held.current) return;
      const view = window.innerHeight;
      const end = document.documentElement.scrollHeight - view;
      const slide = Math.min(view, end);
      const left = Math.max(0, end - window.scrollY);
      const t = slide > 0 ? Math.min(1, Math.max(0, 1 - left / slide)) : 0;
      let pick: ProductSection | null = null;
      let pickTop = -Infinity;
      const rootPad =
        parseFloat(
          getComputedStyle(document.documentElement).scrollPaddingTop,
        ) || 0;
      for (const s of sections) {
        const el = document.getElementById(`section-${s}`);
        if (!el) continue;
        const box = el.getBoundingClientRect();
        if (box.height === 0) continue; // not laid out
        // Where a jump puts its top: the page's scroll padding (the sticky chrome) plus its own
        // scroll margin (product/Card.tsx), and 8 px of slack.
        const base =
          rootPad + (parseFloat(getComputedStyle(el).scrollMarginTop) || 0) + 8;
        const line = base + Math.max(0, view - base) * t;
        if (box.top <= line && box.top >= pickTop)
          [pick, pickTop] = [s, box.top];
      }
      setCurrent(pick ?? sections[0] ?? null);
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    const release = (): void => {
      held.current = null;
    };
    const releaseOnKey = (e: KeyboardEvent): void => {
      if (SCROLL_KEYS.has(e.key)) release();
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchstart", release, { passive: true });
    window.addEventListener("keydown", releaseOnKey);
    // The scrollbar: a press on the document's edge, outside the page's content.
    const releaseOnBar = (e: PointerEvent): void => {
      if (e.target === document.documentElement) release();
    };
    window.addEventListener("pointerdown", releaseOnBar);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchstart", release);
      window.removeEventListener("keydown", releaseOnKey);
      window.removeEventListener("pointerdown", releaseOnBar);
    };
  }, [sections.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: ProductSection): void => {
    held.current = s;
    setCurrent(s);
    // Smooth only when motion is allowed: instant under reduced motion (notes/S-23 §6.6).
    document
      .getElementById(`section-${s}`)
      ?.scrollIntoView?.({ behavior: scrollBehavior(), block: "start" });
    // Focus follows the jump (PS-05 review M4): the next Tab starts in that section. Without
    // scrolling, so the jump's own scroll is the one that runs.
    focusSectionHeading(s);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${href.product(product.slug, s)}`,
    );
  };

  const action = quickAction(product, here, (s) =>
    href.product(product.slug, s),
  );
  const devicesDetail = detail.data ? withSeats(detail.data, seats) : undefined;
  // The product view is the seat source; an older Worker without it keeps the licence detail.
  const seatsPending = view.isPending && !view.error;
  const activeDevices =
    seats?.inUse ??
    devicesDetail?.devices.filter((d) => d.status === "authorized").length ??
    product.deviceCount;
  const counts: Partial<Record<ProductSection, number>> = {
    devices: activeDevices,
  };
  const has = (s: ProductSection) => sections.includes(s);
  // Two columns when the main column has a card from the start (Get it and What's new come
  // with the releases, Help with the developer's links); Package access alone arrives later.
  const twoColumns = has("get") || has("new") || has("help");
  const column = twoColumns
    ? "pk-vt-scope contents desk:flex desk:flex-col desk:gap-6"
    : "pk-vt-scope contents";
  const navProps = {
    sections,
    current,
    counts,
    onPick: pick,
    hrefFor: (s: ProductSection) => href.product(product.slug, s),
  };
  const retry = () => void detail.refetch();

  return (
    // data-first-section: a link to the first section keeps the page at its top, as the deep
    // link above does (the router reads it, MO-05).
    <div
      className="space-y-6 desk:space-y-8"
      data-first-section={sections[0] ?? undefined}
    >
      <ProductHeader
        product={product}
        action={action}
        headingRef={headingRef}
        // Only a licence its key can bring back (the Worker's `removable`, PX-23 review).
        onRemove={
          selected.removable === true ? () => setRemoving(true) : undefined
        }
      />
      <RemoveLicenseDialog
        open={removing}
        onOpenChange={setRemoving}
        product={product}
        license={selected}
        detail={detail.data}
        cloudSync={view.data?.services.sync === true}
        store={storeOf(selected.id)}
        onRemoved={removed}
      />
      <SectionNav {...navProps} variant="pills" />
      <div className="flex gap-8">
        <SectionNav {...navProps} variant="toc" />
        {/* pk-vt-scope on both columns: when the Devices card's list changes (MO-06), every card
            moves to its new place with it instead of jumping under it (src/motion.css). With no
            main-column card known up front (no releases, no help), the licence's cards are the
            page: one readable column beside the nav, never a column of air before them (owner
            polish 2026-10-07). Package access, which arrives later, then
            follows them in that column rather than moving them. */}
        <div
          data-columns={twoColumns ? "two" : "one"}
          className={
            twoColumns
              ? "flex min-w-0 flex-1 flex-col gap-6 desk:grid desk:grid-cols-[minmax(0,1fr)_21.25rem] desk:items-start wide:grid-cols-[minmax(0,1fr)_24rem]"
              : "flex min-w-0 max-w-2xl flex-1 flex-col gap-6"
          }
        >
          <div className={column}>
            {has("get") ? (
              <div className="order-1">
                <GetItPanel product={product} device={here} />
              </div>
            ) : null}
            {has("new") ? (
              <div className="order-4">
                <WhatsNew product={product} />
              </div>
            ) : null}
            {has("package") ? (
              <div className="order-5">
                <PackageAccessCard
                  product={product.slug}
                  productName={product.name}
                  developer={product.presentation.developer}
                  tier={tierLabel(selected.tier)}
                  licenseId={selected.id}
                  access={pkg.data}
                  loading={pkg.isPending}
                  error={pkg.error}
                  onRetry={() => void pkg.refetch()}
                />
              </div>
            ) : null}
            {/* Help closes the page in every layout (owner polish 2026-10-07): the side column
                is the licence's (License, product sign-in, Devices), so the nav's one order is
                the page's order on desktop as on phones. */}
            {has("help") ? (
              <div className="order-6">
                <HelpCard product={product} />
              </div>
            ) : null}
          </div>
          <div className={column}>
            <div className="order-2">
              <LicenseCard
                product={product}
                detail={devicesDetail}
                loading={detail.isPending}
                error={detail.error}
                onRetry={retry}
                selectedId={selected.id}
                onSelect={(id) =>
                  setParams({ license: id === product.best.id ? null : id })
                }
                storeOf={storeOf}
              />
            </div>
            {has("devices") ? (
              <div className="order-3">
                <DevicesCard
                  productName={product.name}
                  emailConfigured={caps.auth.magic}
                  seatLimit={seatLimit}
                  showCount={showCount}
                  detail={devicesDetail}
                  loading={detail.isPending || seatsPending}
                  error={detail.error}
                  onRetry={retry}
                />
              </div>
            ) : null}
            {/* Product sign-in, only with Identity on (§3.1): after License on wide screens, after
                Devices on phones (§4.20's task order); equal orders keep the source order. */}
            {view.data?.services.identity === true ? (
              <div className="order-3 desk:order-2">
                <ProductIdentityCard productName={product.name} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Keys that scroll the page: pressing one hands the section mark back to the reading line. */
const SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
  " ",
]);
