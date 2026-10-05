import * as React from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Gift,
  Plus,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../ui/Button.js";
import { cn } from "../../lib/cn.js";
import type { PortalDiscoverOffer } from "../api.js";
import {
  offerPlatforms,
  reasonCopy,
  termsLine,
  type ReasonKind,
} from "../model/discover.js";
import { href } from "../router.js";
import { PlatformGlyphs } from "./Glyphs.js";
import { ProductArt } from "./ProductArt.js";
import { ProductIcon } from "./ProductIcon.js";

const REASON_ICON: Record<ReasonKind, LucideIcon> = {
  account: User,
  group: Users,
  added: Check,
  other: Gift,
};

export type DiscoverTileState = "offer" | "adding" | "added";

/**
 * A Discover tile (PORTAL.md §4.16, §5.2 `DiscoverTile`): art, the icon overlapping, name and
 * developer, what you'd get (tier and terms) with platform glyphs, **why you can add it** (always
 * visible, owner decision Q-6) and the outlined **Add to library**. Added, the tile turns
 * green-edged with **In your library** on the art and **Open <product>**. Errors are inline on
 * the tile; an offer that ended loses its button.
 */
export function DiscoverTile({
  offer,
  state,
  error = null,
  ended = false,
  onAdd,
}: {
  offer: PortalDiscoverOffer;
  state: DiscoverTileState;
  /** An inline error from the last Add ("Aperture Seven stopped this offer."). */
  error?: string | null;
  /** The offer is gone (409 `not_eligible`): no Add button any more. */
  ended?: boolean;
  onAdd: () => void;
}): React.ReactElement {
  const reason = reasonCopy(offer.reason);
  const ReasonIcon = REASON_ICON[reason.kind];
  const added = state === "added";
  const id = `offer-${offer.product}`;
  const errorId = `${id}-error`;
  return (
    <article
      aria-labelledby={id}
      data-state={state}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-surface-raised shadow-elevation-1",
        added ? "border-success ring-1 ring-success" : "border-border",
      )}
    >
      <ProductArt
        slug={offer.product}
        name={offer.name}
        tint={offer.tintColor}
        src={offer.headerUrl}
        variant="tile"
        className="aspect-video"
      >
        {added ? (
          <span className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-success-border bg-surface-overlay px-2.5 py-0.5 text-sm font-bold text-success shadow-elevation-2">
            <Check aria-hidden className="size-4" />
            In your library
          </span>
        ) : null}
      </ProductArt>
      <div className="flex flex-1 flex-col px-5 pb-5">
        <div className="-mt-7 flex items-start gap-3">
          <ProductIcon
            slug={offer.product}
            name={offer.name}
            tint={offer.tintColor}
            src={offer.iconUrl}
            size={64}
            className="relative border-[3px] border-surface-raised shadow-elevation-2"
          />
          <div className="min-w-0 pt-9">
            <h3 id={id} className="truncate text-lg font-bold text-fg-strong">
              {offer.name}
            </h3>
            {offer.developerName ? (
              <p className="truncate text-sm text-fg-muted">
                {offer.developerName}
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 text-sm text-fg-muted">
          <span className="min-w-0">{termsLine(offer.offer)}</span>
          <PlatformGlyphs
            platforms={offerPlatforms(offer.platforms)}
            className="shrink-0"
          />
        </div>
        <p className="mt-3 flex gap-2.5 rounded-md bg-surface-sunken px-3 py-2.5 text-[0.9375rem] text-fg-strong">
          <ReasonIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-accent-fg"
          />
          <span>
            <span className="sr-only">Why you can add it: </span>
            {reason.text}
          </span>
        </p>
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="mt-3 flex gap-2 text-sm text-danger"
          >
            <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
        {ended && !added ? null : (
          <div className="mt-auto pt-5">
            {added ? (
              <Button asChild variant="quiet" size="lg" className="h-11 w-full">
                <a id={`${id}-open`} href={href.product(offer.product)}>
                  <ArrowRight aria-hidden />
                  <span className="truncate">Open {offer.name}</span>
                </a>
              </Button>
            ) : (
              <Button
                variant="quiet"
                size="lg"
                className="h-11 w-full"
                iconStart={<Plus aria-hidden />}
                loading={state === "adding"}
                aria-describedby={error ? errorId : undefined}
                aria-label={`Add to library: ${offer.name}`}
                onClick={onAdd}
              >
                Add to library
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
