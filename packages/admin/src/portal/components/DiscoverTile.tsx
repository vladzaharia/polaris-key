import * as React from "react";
import { t } from "../../lib/copy.js";
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
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
  type ReasonKind,
} from "../model/discover.js";
import { discoverTileFacts } from "../model/tileFacts.js";
import { href } from "../router.js";
import { SteamGlyph } from "../../ui/Glyphs.js";
import { TileFacts } from "./TileFacts.js";
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
 * library** in the caption under the art and **Open <product>**. Errors are inline on the tile; an offer that ended
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
  reserveStoreRow = false,
  addedActions,
}: {
  offer: PortalDiscoverOffer;
  state: DiscoverTileState;
  /** An inline error from the last Add ("Aperture Seven no longer gives Lumen RAW to your account."). */
  error?: string | null;
  /** The offer is gone (409 `not_eligible`): no Add button any more. */
  ended?: boolean;
  onAdd: () => void;
  /** Some tile in the grid shows store links: every tile keeps the row so the actions sit level. */
  reserveStoreRow?: boolean;
  /** An added tile's actions (`DiscoverAddedActions`); without them it keeps one Open button. */
  addedActions?: React.ReactNode;
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
  const facts = discoverTileFacts(offer);
  // No cover: a short tint field with the icon (or its letter tile) large and centred, as Library.
  const noArt = !offer.headerUrl;
  const stores = !link && !added && offer.cta === "add" ? offer.stores : [];
  return (
    <div className="pk-lift pk-pressable-card relative grid rounded-lg">
      <article
        aria-labelledby={id}
        data-state={state}
        data-cta={offer.cta}
        className={cn(
          "relative flex flex-col overflow-hidden rounded-lg border bg-surface-raised shadow-elevation-1",
          added ? "border-fg-strong" : "border-border",
        )}
      >
        <ProductArt
          slug={offer.product}
          name={offer.name}
          tint={offer.tintColor}
          src={offer.headerUrl}
          variant="tile"
          letter={noArt && !offer.iconUrl}
          liftArt
          // The whole 16:9 frame edge to edge, capped at 280 px tall (contained over a blurred
          // copy of itself where the column is wider), as on Library tiles.
          fit="contain"
          className="aspect-[5/2] w-full"
        >
          {noArt && offer.iconUrl ? (
            <ProductIcon
              slug={offer.product}
              name={offer.name}
              tint={offer.tintColor}
              src={offer.iconUrl}
              size={48}
              lift
              className="absolute start-1/2 top-1/2 -translate-x-1/2 rtl:translate-x-1/2 -translate-y-1/2"
            />
          ) : null}
        </ProductArt>
        <div className="flex flex-1 flex-col px-3 pb-3 desk:px-3.5 desk:pb-3.5">
          <div
            // No cover: the row starts at the same 4 px under the art as the icon's row does, and
            // keeps its height, so a tile without an icon sits level with its neighbours (B-079).
            className={cn(
              "flex items-start gap-2.5",
              noArt ? "mt-1 min-h-5" : "-mt-4",
            )}
          >
            {noArt ? null : (
              <ProductIcon
                slug={offer.product}
                name={offer.name}
                tint={offer.tintColor}
                src={offer.iconUrl}
                size={40}
                className="relative outline-3 -outline-offset-3 outline-surface-raised shadow-elevation-2"
              />
            )}
            <div className={cn("min-w-0 flex-1", !noArt && "pt-5")}>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <h3
                  id={id}
                  className="min-w-0 max-w-full break-words text-base font-semibold leading-snug text-fg-strong"
                >
                  <a
                    href={page}
                    // block: the name's full line is the link (24 px or taller), so a short name
                    // still meets the target size (WCAG 2.5.8; PS-05). Its focus ring is the
                    // card's, which it stretches over (styles.css, .pk-press-link).
                    className="pk-press-link line-clamp-2 rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                  >
                    <span dir="auto">{offer.name}</span>
                  </a>
                </h3>
                {offer.developerName ? (
                  <p
                    dir="auto"
                    className="min-w-0 max-w-full truncate text-sm text-fg-muted"
                  >
                    {offer.developerName}
                  </p>
                ) : null}
              </div>
              {added ? (
                // Below the art, in the caption: B6 keeps text off customer art (ux-name-over-art).
                <p className="mt-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border border-success-border bg-surface-sunken px-2 py-0.5 text-xs font-medium text-success",
                      pop && "pk-pop-in",
                    )}
                  >
                    <Check aria-hidden className="size-4" />
                    {t("locker.activate.inLibrary")}
                  </span>
                </p>
              ) : null}
            </div>
          </div>
          <TileFacts
            className="mt-2"
            facts={facts}
            platforms={offerPlatforms(offer.platforms)}
          />
          {error ? (
            // A failed Add says so in the reason's place: the tile keeps its height and the row does
            // not move (B-080). Focusable so a keyboard user lands on it when the button has gone.
            <p
              id={errorId}
              role="alert"
              tabIndex={-1}
              className="mt-2 flex min-h-8 items-center gap-2 rounded-md bg-danger-subtle px-2 py-1.5 text-xs leading-4 text-fg outline-none"
            >
              <AlertCircle
                aria-hidden
                className="size-4 shrink-0 text-danger"
              />
              <span>{error}</span>
            </p>
          ) : reason && ReasonIcon ? (
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-surface-sunken px-2.5 py-1.5 text-sm text-fg-strong">
              <span className="flex min-w-0 flex-1 gap-2.5">
                <ReasonIcon
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 self-start text-accent-fg"
                />
                <span>
                  <span className="sr-only">{t("locker.offer.why")} </span>
                  {reason.text}
                </span>
              </span>
              {more ? (
                // Every way to add it, with its terms, is on the product page (S-21 §6.5).
                <a
                  href={page}
                  className="relative inline-flex min-h-6 items-center text-sm font-medium text-accent-fg hover:underline"
                >
                  {more}
                  <span className="sr-only">
                    {" "}
                    {t("locker.offer.moreAria", { product: offer.name })}
                  </span>
                </a>
              ) : null}
            </p>
          ) : null}
          {link ? (
            <LinkActions offer={offer} page={page} />
          ) : ended && !added ? null : (
            <div className="relative mt-auto pt-3">
              {added ? (
                (addedActions ?? (
                  <Button
                    asChild
                    variant="quiet"
                    size="md"
                    className="h-10 w-full pointer-coarse:h-11"
                  >
                    <a id={`${id}-open`} href={href.product(offer.product)}>
                      <ArrowRight aria-hidden />
                      <span className="truncate">
                        {t("locker.activate.open", { product: offer.name })}
                      </span>
                    </a>
                  </Button>
                ))
              ) : (
                <Button
                  id={`${id}-add`}
                  variant="quiet"
                  size="md"
                  className="h-10 w-full pointer-coarse:h-11"
                  iconStart={<Plus aria-hidden />}
                  loading={state === "adding"}
                  aria-describedby={error ? errorId : undefined}
                  aria-label={t("locker.offer.addAria", {
                    product: offer.name,
                  })}
                  onClick={onAdd}
                >
                  {state === "adding"
                    ? t("locker.offer.adding")
                    : t("locker.offer.add")}
                </Button>
              )}
            </div>
          )}
          {/* The row is kept on every tile when any tile has store links, from tablets up, so
              the actions sit level across a row. */}
          {reserveStoreRow || stores.length > 0 ? (
            <div
              className={cn(
                "mt-2",
                reserveStoreRow ? "hidden min-h-9 desk:block" : "",
                stores.length > 0 && "block",
              )}
            >
              {stores.length > 0 ? (
                <StoreLinks offer={offer} stores={stores} />
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
      {added ? (
        // The ink ring around the card (form, not colour) (outside its border, where the card can't clip it).
        <span
          aria-hidden
          data-ring
          className={cn(
            "pointer-events-none absolute inset-0 rounded-lg ring-1 ring-fg-strong",
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
    <ul className="relative mt-auto flex flex-col gap-2 pt-3">
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
            label={t("locker.offer.getFrom", {
              developer: offer.developerName ?? t("license.developerFallback"),
            })}
            name={offer.name}
          />
        </li>
      ) : (
        <li>
          <Button
            asChild
            variant="quiet"
            size="md"
            className="h-10 w-full pointer-coarse:h-11"
          >
            <a
              href={page}
              aria-label={t("locker.offer.seeDetailsAria", {
                product: offer.name,
              })}
            >
              <ArrowRight aria-hidden />
              {t("locker.offer.seeDetails")}
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
    <Button
      asChild
      variant="quiet"
      size="md"
      className="h-10 w-full pointer-coarse:h-11"
    >
      <a
        href={to}
        target="_blank"
        rel="noreferrer"
        aria-label={t("locker.offer.newTabAria", {
          store: label,
          product: name,
        })}
      >
        <ExternalLink aria-hidden />
        <span className="truncate">{label}</span>
      </a>
    </Button>
  );
}

/** The other places to get it (the kit's `.stores`): quieter than Add to library. */
function StoreLinks({
  offer,
  stores,
}: {
  offer: PortalDiscoverOffer;
  stores: PortalDiscoverOffer["stores"];
}): React.ReactElement {
  return (
    <p className="relative flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
      <span>{t("locker.offer.alsoOn")}</span>
      {stores.map((st) => (
        <a
          key={st.id}
          href={st.url}
          target="_blank"
          rel="noreferrer"
          aria-label={t("locker.offer.newTabAria", {
            store: st.label,
            product: offer.name,
          })}
          className="inline-flex items-center gap-1.5 font-medium text-accent-fg underline decoration-accent-fg/35 underline-offset-[3px]"
        >
          {st.kind === "steam" ? (
            <SteamGlyph className="size-4" />
          ) : (
            <ShoppingBag aria-hidden className="size-4" />
          )}
          {st.label}
          <ArrowUpRight aria-hidden className="size-3.5 text-fg-subtle" />
        </a>
      ))}
    </p>
  );
}
