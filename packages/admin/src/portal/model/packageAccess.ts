import {
  feedSetupProblem,
  isPackageEcosystem,
  renderFeedSetup,
  type FeedSetupCredential,
  type FeedSnippet,
} from "@polaris-key/manifest";
import type { PortalPackageFeed } from "../api.js";
import { formatDay } from "../date.js";
import { t } from "../../lib/copy.js";
import { TOKEN_ENV, ecosystemLabel } from "../../lib/vocab/ecosystems.js";
import { EXPIRES_SOON_DAYS, expiresInText } from "../../lib/vocab/license.js";

export { TOKEN_ENV, ecosystemLabel };

/**
 * Package access (PORTAL.md §4.20, §4.21; PX-11) over F-21's portal token API. The snippets are
 * `@polaris-key/manifest` `renderFeedSetup`, the bytes `pkey feeds setup` and the console print,
 * so the three never disagree.
 */

/**
 * One feed's setup, for its owner, with the token as an environment variable (the card) or the
 * real token (the shown-once dialog). Godot carries the token in its URL. `[]` when the feed
 * can't be rendered (an unknown ecosystem, a bad origin).
 */
export function feedSnippets(
  feed: PortalPackageFeed,
  ctx: { product: string; registryOrigin: string | null },
  token?: string,
): FeedSnippet[] {
  if (!isPackageEcosystem(feed.ecosystem)) return [];
  let origin: string;
  try {
    origin = new URL(feed.baseUrl ?? ctx.registryOrigin ?? "").origin;
  } catch {
    return [];
  }
  const credential: FeedSetupCredential =
    token === undefined
      ? feed.ecosystem === "godot"
        ? { kind: "none" }
        : { kind: "env", name: TOKEN_ENV }
      : feed.ecosystem === "godot"
        ? { kind: "godot-url", value: token }
        : { kind: "token", value: token };
  const context = {
    origin,
    owner: ctx.product,
    credential,
    ...(feed.namespace ? { namespace: feed.namespace } : {}),
  };
  if (feedSetupProblem(feed.ecosystem, context) !== null) return [];
  return renderFeedSetup(feed.ecosystem, context);
}

const DAY = 86_400;
/** A token's expiry as the card words it: a pill inside 14 days, else a plain date. */
export function tokenExpiry(
  expiresAt: number,
  now: number,
): { soon: boolean; text: string } {
  const days = Math.ceil((expiresAt - now) / DAY);
  if (expiresAt <= now) return { soon: true, text: t("part.status.expired") };
  if (days <= EXPIRES_SOON_DAYS)
    return {
      soon: true,
      text: expiresInText(days, { tomorrow: true }),
    };
  return { soon: false, text: `Expires ${formatDate(expiresAt)}` };
}

/** "Oct 1, 2026": the one date format (../date.ts), read as a UTC day. */
export function formatDate(at: number): string {
  return formatDay(at, true, { utc: true });
}
