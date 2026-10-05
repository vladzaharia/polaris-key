import {
  feedSetupProblem,
  isPackageEcosystem,
  renderFeedSetup,
  type FeedSetupCredential,
  type FeedSnippet,
} from "@polaris-key/manifest";
import type { PortalPackageFeed } from "../api.js";

/**
 * Package access (PORTAL.md §4.20, §4.21; PX-11) over F-21's portal token API. The snippets are
 * `@polaris-key/manifest` `renderFeedSetup`, the bytes `pkey feeds setup` and the console print,
 * so the three never disagree.
 */

/** The environment variable the card's snippets name the token by (the console's too). */
export const TOKEN_ENV = "PKEY_REGISTRY_TOKEN";

export const ECOSYSTEM_LABEL: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  oci: "Docker / OCI",
  swift: "Swift",
  maven: "Maven / Gradle",
  godot: "Godot",
};

export function ecosystemLabel(eco: string): string {
  return ECOSYSTEM_LABEL[eco] ?? eco;
}

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
  const context = { origin, owner: ctx.product, credential };
  if (feedSetupProblem(feed.ecosystem, context) !== null) return [];
  return renderFeedSetup(feed.ecosystem, context);
}

const DAY = 86_400;
/** §4.20: "the amber 'Expires in 6 days' pill" inside this window. */
export const TOKEN_EXPIRES_SOON_DAYS = 14;

/** A token's expiry as the card words it: a pill inside 14 days, else a plain date. */
export function tokenExpiry(
  expiresAt: number,
  now: number,
): { soon: boolean; text: string } {
  const days = Math.ceil((expiresAt - now) / DAY);
  if (expiresAt <= now) return { soon: true, text: "Expired" };
  if (days <= TOKEN_EXPIRES_SOON_DAYS)
    return {
      soon: true,
      text: days <= 1 ? "Expires tomorrow" : `Expires in ${days} days`,
    };
  return { soon: false, text: `Expires ${formatDate(expiresAt)}` };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export function formatDate(at: number): string {
  const d = new Date(at * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
