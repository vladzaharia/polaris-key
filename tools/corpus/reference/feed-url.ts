// Reference: the app-updater feed URL expansion (plans/SP-00.md D5).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { CHANNEL_ALIASES } from "@polaris-key/protocol/core";

/** Feed kind → the `update.endpoints` key it reads. */
export const FEED_URL_KINDS = {
  appcast: "appcast",
  winsparkle: "winsparkle",
  velopack: "velopack",
  appInstaller: "appInstaller",
  zsync: "zsync",
} as const;
type FeedUrlKind = keyof typeof FEED_URL_KINDS;

export interface FeedUrlInput {
  kind: FeedUrlKind;
  channel?: string;
  velopackChannel?: string;
  buildId?: string;
}
export type FeedUrlExpect = { url: string } | { unsupported: "product" };

/** The reference expansion (see the section comment). */
export function refFeedUrl(
  endpoints: Record<string, string>,
  input: FeedUrlInput,
): FeedUrlExpect {
  const template = endpoints[FEED_URL_KINDS[input.kind]];
  if (typeof template !== "string" || template === "")
    return { unsupported: "product" };
  const requested = input.channel ?? "stable";
  const channel =
    (CHANNEL_ALIASES as Record<string, string>)[requested] ?? requested;
  if (input.kind === "appcast") {
    if (channel === "stable") return { url: template };
    const at = template.search(/[?#]/);
    const path = at < 0 ? template : template.slice(0, at);
    const tail = at < 0 ? "" : template.slice(at);
    if (!path.endsWith("/appcast.xml")) return { url: template };
    return {
      url: `${path.slice(0, -"/appcast.xml".length)}/${encodeURIComponent(channel)}/appcast.xml${tail}`,
    };
  }
  let t = template;
  if (input.kind === "velopack" && input.velopackChannel === undefined) {
    const at = t.indexOf("releases.");
    if (at < 0)
      throw new Error("feed-url-matrix: a velopack template without releases.");
    t = t.slice(0, at);
  }
  if (input.kind === "zsync" && input.buildId === undefined)
    throw new Error("feed-url-matrix: a zsync row needs a buildId");
  t = t.split("{channel}").join(encodeURIComponent(channel));
  if (input.velopackChannel !== undefined)
    t = t
      .split("{velopackChannel}")
      .join(encodeURIComponent(input.velopackChannel));
  if (input.buildId !== undefined)
    t = t.split("{buildId}").join(encodeURIComponent(input.buildId));
  if (/[{}]/.test(t))
    throw new Error(`feed-url-matrix: an unexpanded placeholder in ${t}`);
  return { url: t };
}
