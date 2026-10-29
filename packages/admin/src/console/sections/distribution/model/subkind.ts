import { channelForOutlet, type ChannelEntry } from "@polaris-key/manifest";

/** An outlet as far as the channel it serves is concerned; `identity` absent means not known. */
export interface OutletLike {
  kind: string;
  identity?: Record<string, unknown>;
}

/**
 * The package-manager subkind of a `direct` outlet, as the Worker reads it
 * (`services/distribution/channels.ts`): an explicit `identity.subkind`, else `homebrew` when the
 * outlet names a cask or formula. A bare `direct` is Polaris Key itself.
 */
export function subkindOf(o: OutletLike): string | null {
  if (o.kind !== "direct") return null;
  const id = o.identity ?? {};
  if (typeof id.subkind === "string") return id.subkind;
  return typeof id.homebrewCask === "string" ||
    typeof id.homebrewFormula === "string"
    ? "homebrew"
    : null;
}

/** The channel an outlet serves; null for a `direct` outlet whose identity is not known. */
export function channelOfOutlet(o: OutletLike): ChannelEntry | null {
  if (o.kind === "direct" && !o.identity) return null;
  return channelForOutlet(o.kind, subkindOf(o));
}
