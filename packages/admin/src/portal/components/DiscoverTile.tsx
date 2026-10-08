import * as React from "react";
import {
  AlertCircle,
  ArrowRight,
  AtSign,
  Check,
  Clock,
  ExternalLink,
  Gift,
  Plus,
  ShoppingBag,
  Sparkles,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../ui/Button.js";
import { cn } from "../../lib/cn.js";
import type { PortalDiscoverOffer } from "../api.js";
import {
  moreWaysText,
  offerPlatforms,
  offerReason,
  storeLinkLabel,
  termsLine,
  type ReasonKind,
} from "../model/discover.js";
import { href } from "../router.js";
import { PlatformGlyphs } from "./Glyphs.js";
import { ProductArt } from "./ProductArt.js";
import { ProductIcon } from "./ProductIcon.js";

export const REASON_ICON: Record<ReasonKind, LucideIcon> = {
  account: User,
  trial: Clock,
  group: Users,
  idp: User,
  domain: AtSign,
  store: ShoppingBag,
  open: Sparkles,
  added: Check,
  other: Gift,
};

export type DiscoverTileState = "offer" | "adding" | "added";

/**
 * A Discover tile (PORTAL.md §4.16, §5.2 `DiscoverTile`; notes/S-21 §6.5): art, the icon
 * overlapping, name and developer, what you'd get (tier and terms; an open product's or a
 * link's one-line description instead) with platform glyphs, **why you can add it** (always
 * visible, owner decision Q-6: the first way to add it, with "+1 more way" when there are others)
 * and the outlined **Add to library**. Added, the tile turns green-edged with **In your
 * library** on the art and **Open <product>**. Errors are inline on the tile; an offer that ended
 * loses its button.
 *
 * A link-only listing (an operator showed it to everyone signed in, with nothing to add) has no
 * reason line and no Add: its actions are its store pages, "Get it on <store>" (S-21 §6.5).
 *
 * The name opens the storefront product page (`#/discover/:product`, PS-05): every way to add
 * it, its listing and screenshots. The whole card follows the name (`pk-press-link`), its own
 * buttons and links excepted.
 *
 * Motion (notes/S-23 §6.1; MO-07): under a pointer the tile lifts and its art scales a little;
 * pressing the card's link presses the card, while its buttons press only themselves. When an
 * Add goes through while the tile is on screen, the **In your library** plate pops in once
 * (`.pk-pop-in`) and the ring fades in once (`.pk-content-in`, opacity only: scaling a 1 px ring
 * would pass it inside the card's edge); a tile that is already added when it mounts (`?added=`
 * after a reload) just shows them. The words carry the meaning; the ring is decoration. The lift
 * and the ring sit on a wrapper because the card clips its art (`overflow-hidden`), which would
 * clip both.
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
  const reason = offerReason(offer);
  const ReasonIcon = reason ? REASON_ICON[reason.kind] : null;
  const added = state === "added";
  const link = offer.cta === "link" && !added;
  const more = added ? null : moreWaysText(offer);
  // Added while on screen (not already added when the tile mounted): ring and plate come in once.
  const [addedAtMount] = React.useState(added);
  const pop = added && !addedAtMount;
  const id = `offer-${offer.product}`;
  const errorId = `${id}-error`;
  // Held now: its storefront page is gone, its library page is where it lives.
  const page = added
    ? href.product(offer.product)
    : href.storefront(offer.product);
  const what = offer.offer ? termsLine(offer.offer) : offer.shortDescription;
  return (
    <div className="pk-lift pk-pressable-card relative grid rounded-xl">
      <article
        aria-labelledby={id}
        data-state={state}
        data-cta={offer.cta}
        className={cn(
          "relative flex flex-col overflow-hidden rounded-xl border bg-surface-raised shadow-elevation-1",
          added ? "border-success" : "border-border",
        )}
      >
        <ProductArt
          slug={offer.product}
          name={offer.name}
          tint={offer.tintColor}
          src={offer.headerUrl}
          variant="tile"
          // No cover: a bare tint field; the icon (or its letter tile) in front of the art's lower
          // edge already shows the letter, as on Library cards.
          letter={false}
          liftArt
          className="aspect-video"
        >
          {added ? (
            <span
              className={cn(
                "absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-success-border bg-surface-overlay px-2.5 py-0.5 text-sm font-bold text-success shadow-elevation-2",
                pop && "pk-pop-in",
              )}
            >
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
                <a
                  href={page}
                  // block: the name's full line is the link (24 px or taller), so a short name
                  // still meets the target size (WCAG 2.5.8; PS-05).
                  className="pk-press-link block truncate rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                >
                  {offer.name}
                </a>
              </h3>
              {offer.developerName ? (
                <p className="truncate text-sm text-fg-muted">
                  {offer.developerName}
                </p>
              ) : null}
            </div>
          </div>
          {what || offer.platforms.length ? (
            <div className="mt-4 flex items-center justify-between gap-3 text-sm text-fg-muted">
              <span className="min-w-0">{what}</span>
              <PlatformGlyphs
                platforms={offerPlatforms(offer.platforms)}
                className="shrink-0"
              />
            </div>
          ) : null}
          {reason && ReasonIcon ? (
            <p className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-md bg-surface-sunken px-3 py-2.5 text-[0.9375rem] text-fg-strong">
              <span className="flex min-w-0 flex-1 gap-2.5">
                <ReasonIcon
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 self-start text-accent-fg"
                />
                <span>
                  <span className="sr-only">Why you can add it: </span>
                  {reason.text}
                </span>
              </span>
              {more ? (
                // Every way to add it, with its terms, is on the product page (S-21 §6.5).
                <a
                  href={page}
                  className="relative text-sm font-bold text-accent-fg hover:underline"
                >
                  {more}
                  <span className="sr-only"> to add {offer.name}</span>
                </a>
              ) : null}
            </p>
          ) : null}
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
          {link ? (
            <LinkActions offer={offer} page={page} />
          ) : ended && !added ? null : (
            <div className="relative mt-auto pt-5">
              {added ? (
                <Button
                  asChild
                  variant="quiet"
                  size="lg"
                  className="h-11 w-full"
                >
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
      {added ? (
        // The green ring around the card (outside its border, where the card can't clip it).
        <span
          aria-hidden
          data-ring
          className={cn(
            "pointer-events-none absolute inset-0 rounded-xl ring-1 ring-success",
            pop && "pk-content-in",
          )}
        />
      ) : null}
    </div>
  );
}

/**
 * A link-only listing's actions (S-21 §6.5): "Get it on <store>" for each live store page, else
 * "Get it from <developer>" on their website, else the product page.
 */
function LinkActions({
  offer,
  page,
}: {
  offer: PortalDiscoverOffer;
  page: string;
}): React.ReactElement {
  const site =
    offer.website && /^https:\/\//.test(offer.website) ? offer.website : null;
  return (
    <ul className="relative mt-auto flex flex-col gap-2 pt-5">
      {offer.stores.length > 0 ? (
        offer.stores.map((s) => (
          <li key={s.id}>
            <ExternalButton
              href={s.url}
              label={storeLinkLabel(s)}
              name={offer.name}
            />
          </li>
        ))
      ) : site ? (
        <li>
          <ExternalButton
            href={site}
            label={`Get it from ${offer.developerName ?? "the developer"}`}
            name={offer.name}
          />
        </li>
      ) : (
        <li>
          <Button asChild variant="quiet" size="lg" className="h-11 w-full">
            <a href={page} aria-label={`See details: ${offer.name}`}>
              <ArrowRight aria-hidden />
              See details
            </a>
          </Button>
        </li>
      )}
    </ul>
  );
}

function ExternalButton({
  href: to,
  label,
  name,
}: {
  href: string;
  label: string;
  name: string;
}): React.ReactElement {
  return (
    <Button asChild variant="quiet" size="lg" className="h-11 w-full">
      <a
        href={to}
        target="_blank"
        rel="noreferrer"
        aria-label={`${label}: ${name} (opens in a new tab)`}
      >
        <ExternalLink aria-hidden />
        <span className="truncate">{label}</span>
      </a>
    </Button>
  );
}
