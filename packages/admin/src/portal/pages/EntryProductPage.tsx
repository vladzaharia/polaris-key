import * as React from "react";
import { ExternalLink, Info } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { SectionCard } from "../components/product/Card.js";
import { GetItPanel } from "../components/product/GetItPanel.js";
import { HelpCard } from "../components/product/HelpCard.js";
import { ProductHeader } from "../components/product/ProductHeader.js";
import { RemoveEntryConfirm } from "../components/RemoveEntryConfirm.js";
import { useProductDownloads } from "../data.js";
import { consumeHeadingFocus } from "../focus.js";
import {
  quickAction,
  type DeviceInHand,
  type EntryProduct,
} from "../model/library.js";
import {
  getItFromDownloads,
  readUaHints,
  resolveDevice,
} from "../model/product.js";
import { focusPageHeading, href, navigate } from "../router.js";

/**
 * The product page of an open product in the library through an entry (PS-04, notes/S-21 §6.4,
 * §6.5): no licence, so no License card, no seat meter, no Devices and no Package access. The
 * header says "Free to use"; **Get it** comes next, then Help; the header menu's **Remove from
 * library** is confirmed inline under the header, and afterwards the page goes back to the
 * Library (its heading takes focus there).
 *
 * Get it is the per-product downloads view when the Worker serves one for the entry, else the
 * developer's website ("Get it from <developer>"). With neither, the section is left out.
 */
export function EntryProductBody({
  product,
  device,
}: {
  product: EntryProduct;
  device: DeviceInHand;
}): React.ReactElement {
  const here = React.useMemo(
    () => resolveDevice(product.downloads, device, readUaHints()),
    [product.downloads, device],
  );
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const menuButton = React.useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = React.useState(false);

  // After adding this product (Discover's storefront page), focus its heading (§9.4).
  React.useEffect(() => {
    if (consumeHeadingFocus(product.slug))
      focusPageHeading(() => headingRef.current);
  }, [product.slug]);

  const action = quickAction(product, here, (s) =>
    href.product(product.slug, s),
  );
  const { supportUrl, supportEmail, website } = product.presentation;
  const help = Boolean(supportUrl || supportEmail || website);
  return (
    <div className="space-y-6 desk:space-y-8">
      <ProductHeader
        product={product}
        action={action}
        headingRef={headingRef}
        menuTriggerRef={menuButton}
        onRemove={() => setConfirming(true)}
      />
      {confirming ? (
        <RemoveEntryConfirm
          slug={product.slug}
          name={product.name}
          className="max-w-xl"
          onCancel={() => {
            setConfirming(false);
            menuButton.current?.focus();
          }}
          // The page goes with the entry: back to the Library, whose heading takes focus.
          onRemoved={() => navigate(href.library())}
        />
      ) : null}
      <div className="flex flex-col gap-6 desk:grid desk:grid-cols-[minmax(0,1fr)_21.25rem] desk:items-start wide:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <EntryGetIt product={product} device={here} />
        </div>
        {help ? (
          <div className="flex min-w-0 flex-col gap-6">
            <HelpCard product={product} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Get it for an entry: the downloads view's files when the Worker serves them for this account,
 * else the developer's website. `null` (no section) when there is neither.
 */
function EntryGetIt({
  product,
  device,
}: {
  product: EntryProduct;
  device: DeviceInHand;
}): React.ReactElement | null {
  const downloads = useProductDownloads(product.slug, true);
  const { developer, website } = product.presentation;
  if (downloads.isPending)
    return (
      <SectionCard id="get" title={`Get ${product.name}`}>
        <Skeleton className="h-24 w-full" aria-busy />
      </SectionCard>
    );
  const files = downloads.data
    ? getItFromDownloads(downloads.data, device, { developer, website })
    : null;
  if (files) return <GetItPanel product={product} device={device} />;
  if (!website) return null;
  const who = developer ?? "the developer";
  return (
    <SectionCard id="get" title={`Get ${product.name}`}>
      <div className="space-y-4">
        <p className="flex gap-2 text-fg">
          <Info aria-hidden className="mt-1 size-4 shrink-0 text-fg-muted" />
          <span>
            {product.name} is free to use, with no license.{" "}
            {developer ?? "Its developer"} hands it out on their website.
          </span>
        </p>
        <Button asChild variant="quiet" size="lg" className="h-11">
          <a
            href={website}
            target="_blank"
            rel="noreferrer"
            aria-label={`Get it from ${who}: ${product.name} (opens in a new tab)`}
          >
            <ExternalLink aria-hidden />
            Get it from {who}
          </a>
        </Button>
      </div>
    </SectionCard>
  );
}
