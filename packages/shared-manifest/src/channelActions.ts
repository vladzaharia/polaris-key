/**
 * Customer channel actions (A-26, DC-09): the one model of what a customer can do to get an
 * app, for every distribution channel. The download page (`distribution/page`), the customer
 * portal's Get it and the React kit all arrange their offers through this file, so they agree.
 *
 * It is pure and reads only the channel catalogue (`tools/channels.json`, generated into
 * `channels.generated.ts`): a channel is never named here. What a channel is to a customer (a
 * file, a store page, a source to add, a command to run), where it sits among a platform's offers
 * and which platforms it serves for a product are all catalogue data.
 */

import {
  CHANNELS,
  findChannel,
  type ChannelCustomerAction,
  type ChannelEntry,
} from "./channels.generated.js";
import { archFits } from "./formats.js";

/**
 * How a customer meets a channel:
 *
 * - `file`: a build served here, downloaded;
 * - `store`: a page on someone else's store, opened (a package manager or store that names a
 *   command, such as Flathub or winget, is still a store: it has its own listing);
 * - `source`: served from this product's own feeds or tap (a sideloading source to add, Homebrew
 *   or Scoop steps), so it has no page of its own.
 */
export type ChannelActionClass = "file" | "store" | "source";

/** The class a channel falls in, from its catalogue row. */
export function actionClassOf(entry: ChannelEntry): ChannelActionClass {
  if (entry.customerAction === "install") return "file";
  // A source is served by the product's own feeds (`feed` plane) or its own tap (a `direct`
  // outlet's subkind); everything else is a listing someone else hosts.
  return entry.plane === "feed" || entry.outlet.kind === "direct"
    ? "source"
    : "store";
}

/**
 * The catalogue channel behind an offer's `kind`. A kind is a channel id or alias, the outlet kind
 * the Worker uses, `download` (the file served here: the `install` channel) or a variant of a
 * channel (SideStore adds the same source AltStore does).
 */
export function channelOfKind(kind: string): ChannelEntry | null {
  if (kind === "download")
    return CHANNELS.find((c) => c.customerAction === "install") ?? null;
  const direct = findChannel(kind);
  if (direct) return direct;
  return (
    CHANNELS.find(
      (c) => c.outlet.kind === kind || c.offerKinds?.includes(kind),
    ) ?? null
  );
}

/** The class of an offer kind; `null` for a kind no channel carries. */
export function actionClassOfKind(kind: string): ChannelActionClass | null {
  const c = channelOfKind(kind);
  return c ? actionClassOf(c) : null;
}

/** What the customer does on a channel (the catalogue's `customerAction`), by offer kind. */
export function customerActionOfKind(
  kind: string,
): ChannelCustomerAction | null {
  return channelOfKind(kind)?.customerAction ?? null;
}

/** Sort rank of an offer of `kind` on `platform`: the catalogue's `offerOrder`, else last. */
export function offerRank(kind: string, platform: string): number {
  const c = channelOfKind(kind);
  const base = c?.offerOrder?.[platform];
  // Another offer of the channel (SideStore beside AltStore) follows the channel's own directly.
  const variant = c?.offerKinds?.includes(kind) ? 1 : 0;
  return base === undefined ? Number.MAX_SAFE_INTEGER : base + variant;
}

export interface OfferLike {
  kind: string;
  platforms: readonly string[];
  /** Breaks a tie so the order is stable. */
  outletId: string;
}

/**
 * The offers for one platform, best first: only those that serve it, in the catalogue's order for
 * that platform, ties by outlet. The first is the platform's primary action.
 */
export function offersForPlatform<T extends OfferLike>(
  offers: readonly T[],
  platform: string,
): T[] {
  return offers
    .filter((o) => o.platforms.includes(platform))
    .sort(
      (a, b) =>
        offerRank(a.kind, platform) - offerRank(b.kind, platform) ||
        (a.outletId < b.outletId ? -1 : a.outletId > b.outletId ? 1 : 0),
    );
}

export interface ProductPlatformFact {
  platform: string;
  arches: readonly string[];
}

/** A build the product's outlet for the channel names as its own (`identity.artifact`). */
export interface NamedBuild {
  platform: string;
  arch: string;
  format: string | null;
}

/** A channel's name on a platform ("Mac App Store" on macOS), else its label. */
export function labelOn(kind: string, platform: string): string {
  const c = channelOfKind(kind);
  return c?.labelOn?.[platform] ?? c?.label ?? kind;
}

/**
 * The platforms a channel serves for a product, with evidence. With the product's platforms known,
 * a platform counts when the product has it. Where the channel takes only some arches there (a
 * listing for a build of a particular kind: the Mac App Store takes a sandboxed `pkg`), the
 * product's outlet for the channel must NAME a build for it (`named`, the way an AltStore outlet
 * names its `ipa`), and that one build must fit both the channel's format and its arch: a `pkg`
 * shipped directly earns no store row, and neither does a universal `dmg` beside an x64 `pkg`.
 * With nothing known, the platforms with no arch limit, so a link never claims a platform whose
 * builds were not checked.
 */
export function offerPlatforms(
  entry: Pick<ChannelEntry, "platforms" | "arches" | "formats">,
  product: readonly ProductPlatformFact[],
  named: readonly NamedBuild[] = [],
): string[] {
  const fits = (platform: string): boolean => {
    const accepted = entry.arches?.[platform];
    if (product.length === 0) return accepted === undefined;
    if (!product.some((p) => p.platform === platform)) return false;
    if (accepted === undefined) return true;
    return named.some(
      (b) =>
        b.platform === platform &&
        b.format !== null &&
        entry.formats.includes(b.format.toLowerCase()) &&
        archFits(b.arch, accepted),
    );
  };
  return entry.platforms.filter(fits);
}
