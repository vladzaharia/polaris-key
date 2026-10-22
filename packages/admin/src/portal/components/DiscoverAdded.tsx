import * as React from "react";
import { ArrowRight } from "lucide-react";
import { t } from "../../lib/copy.js";
import { Button } from "../../ui/Button.js";
import { useLibrary } from "../library.js";
import { isDownloadAction, quickAction } from "../model/library.js";
import { href } from "../router.js";
import { QuickActionButton } from "./QuickAction.js";

/**
 * A just-added Discover tile's actions (portal.discover): the product's covered build for this
 * device first, outlined ("Download for macOS", "Email me the download" on a phone), then a text
 * link "Go to <product>" to its library page, which takes focus (§9.4). Without a download for
 * this device (or while the library answers) the tile keeps the one **Open <product>** button.
 *
 * Rendered only for an added tile, so the library's downloads are fetched only once something
 * has been added.
 */
export function DiscoverAddedActions({
  slug,
  name,
  openId,
}: {
  slug: string;
  name: string;
  /** The id the page focuses after an Add. */
  openId: string;
}): React.ReactElement {
  const lib = useLibrary();
  const product = lib.isPending
    ? undefined
    : lib.products?.find((p) => p.slug === slug);
  const action = product
    ? quickAction(product, lib.device, (s) => href.product(slug, s))
    : null;
  const download = product && action && isDownloadAction(action);
  if (!download) {
    return (
      <Button
        asChild
        variant="quiet"
        size="md"
        className="h-10 w-full pointer-coarse:h-11"
      >
        <a id={openId} href={href.product(slug)}>
          <ArrowRight aria-hidden />
          <span className="truncate">
            {t("locker.activate.open", { product: name })}
          </span>
        </a>
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <QuickActionButton
        product={product}
        action={action}
        size="md"
        className="h-auto min-h-10 w-full whitespace-normal py-1.5 text-center pointer-coarse:min-h-11"
      />
      <a
        id={openId}
        href={href.product(slug)}
        className="relative inline-flex min-h-6 items-center gap-1.5 rounded-sm text-sm font-medium text-accent-fg underline decoration-accent-fg underline-offset-[3px] pointer-coarse:min-h-11"
      >
        {t("locker.discover.go", { product: name })}
        <ArrowRight aria-hidden className="size-3.5" />
      </a>
    </div>
  );
}
