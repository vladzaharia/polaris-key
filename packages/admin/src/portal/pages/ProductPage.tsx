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
import { consumeHeadingFocus } from "../focus.js";
import { useLibrary } from "../library.js";
import {
  quickAction,
  tierLabel,
  type LibraryProduct,
} from "../model/library.js";
import {
  presentSections,
  readUaHints,
  resolveDevice,
  seatLimitFor,
  SECTION_LABEL,
  seatsFor,
  showsDeviceCount,
  storeFor,
  withSeats,
} from "../model/product.js";
import {
  href,
  setParams,
  useDocumentTitle,
  type ProductSection,
} from "../router.js";
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
  product: LibraryProduct;
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
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  // After adding this product, focus its heading (§9.4).
  React.useEffect(() => {
    // After the dialog has closed and handed focus back to its opener.
    if (consumeHeadingFocus(product.slug))
      requestAnimationFrame(() => headingRef.current?.focus());
  }, [product.slug]);

  // A section deep link scrolls there once.
  React.useEffect(() => {
    if (!section || section === sections[0]) return;
    document
      .getElementById(`section-${section}`)
      ?.scrollIntoView?.({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The nav marks the section on screen: the topmost section inside the band (nav order breaks
  // a tie, as between the two columns' first cards on desktop). An observer callback carries
  // only the sections whose intersection changed, so the set in the band is kept across
  // callbacks; picking from the changed entries alone left the nav on a section that had passed
  // through the band and out again (a layout shift above a deep link, then a scroll back),
  // whatever was on screen once the page settled.
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = sections
      .map((s) => document.getElementById(`section-${s}`))
      .filter((e): e is HTMLElement => e !== null);
    const inBand = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) inBand.add(e.target);
          else inBand.delete(e.target);
        }
        let top: Element | undefined;
        let topY = Infinity;
        for (const el of els) {
          if (!inBand.has(el)) continue;
          const y = el.getBoundingClientRect().top;
          if (y < topY) [top, topY] = [el, y];
        }
        const s = top?.getAttribute("data-section") as ProductSection | null;
        if (s) setCurrent(s);
      },
      { rootMargin: "-120px 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [sections.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: ProductSection): void => {
    setCurrent(s);
    document
      .getElementById(`section-${s}`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
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
  const labels: Partial<Record<ProductSection, string>> = {
    devices: `${SECTION_LABEL.devices} ${activeDevices}`,
  };
  const has = (s: ProductSection) => sections.includes(s);
  const navProps = {
    sections,
    current,
    labels,
    onPick: pick,
    hrefFor: (s: ProductSection) => href.product(product.slug, s),
  };
  const retry = () => void detail.refetch();

  return (
    <div className="space-y-6 desk:space-y-8">
      <ProductHeader
        product={product}
        action={action}
        headingRef={headingRef}
      />
      <SectionNav {...navProps} variant="pills" />
      <div className="flex gap-8">
        <SectionNav {...navProps} variant="toc" />
        <div className="flex min-w-0 flex-1 flex-col gap-6 desk:grid desk:grid-cols-[minmax(0,1fr)_21.25rem] desk:items-start wide:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="contents desk:flex desk:flex-col desk:gap-6">
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
          </div>
          <div className="contents desk:flex desk:flex-col desk:gap-6">
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
                seatLimit={seatLimit}
                showDeviceCount={showCount}
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
            {has("help") ? (
              <div className="order-6">
                <HelpCard product={product} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
