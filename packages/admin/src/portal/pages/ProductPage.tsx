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
import { capabilitiesOrNone, useCapabilities, useLicense } from "../data.js";
import { consumeHeadingFocus } from "../focus.js";
import { useLibrary } from "../library.js";
import { quickAction, type LibraryProduct } from "../model/library.js";
import { presentSections, SECTION_LABEL } from "../model/product.js";
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
  const releasesOn = capabilitiesOrNone(useCapabilities()).modules.releases;
  const selected =
    product.licenses.find((l) => l.id === requested) ?? product.best;
  const detail = useLicense(product.slug, selected.id);
  const sections = presentSections(product, releasesOn);
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

  // The nav marks the section on screen.
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = sections
      .map((s) => document.getElementById(`section-${s}`))
      .filter((e): e is HTMLElement => e !== null);
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          )[0];
        const s = top?.target.getAttribute(
          "data-section",
        ) as ProductSection | null;
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

  const action = quickAction(product, device, (s) =>
    href.product(product.slug, s),
  );
  const activeDevices =
    detail.data?.devices.filter((d) => d.status === "authorized").length ??
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
                <GetItPanel product={product} device={device} />
              </div>
            ) : null}
            {has("new") ? (
              <div className="order-4">
                <WhatsNew product={product} />
              </div>
            ) : null}
          </div>
          <div className="contents desk:flex desk:flex-col desk:gap-6">
            <div className="order-2">
              <LicenseCard
                product={product}
                detail={detail.data}
                loading={detail.isPending}
                error={detail.error}
                onRetry={retry}
                selectedId={selected.id}
                onSelect={(id) =>
                  setParams({ license: id === product.best.id ? null : id })
                }
              />
            </div>
            {has("devices") ? (
              <div className="order-3">
                <DevicesCard
                  productName={product.name}
                  seatLimit={
                    selected.id === product.best.id
                      ? product.seats?.limit
                      : null
                  }
                  detail={detail.data}
                  loading={detail.isPending}
                  error={detail.error}
                  onRetry={retry}
                />
              </div>
            ) : null}
            {has("help") ? (
              <div className="order-5">
                <HelpCard product={product} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
