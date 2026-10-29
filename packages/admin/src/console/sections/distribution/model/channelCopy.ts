/**
 * The channel page's words (A-22.1): a delivery state as a pill, an attention code as one line and
 * its fix. Pure, so the page and its tests read the same copy.
 */

import type {
  ChannelAttention,
  ChannelDeliveryState,
} from "../../../../api.js";
import type { Tone } from "../../../../lib/status.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
import { r } from "../../../routes.js";

export interface ChannelPill {
  tone: Tone;
  label: string;
}

/**
 * The header pill. Out of scope is a fact about the product, not a fault: neutral, with its reason
 * on the Status tab (A-20 R7). Live reads as quiet success text; only attention is a warning.
 */
export function channelPill(
  state: ChannelDeliveryState,
  outOfScope: boolean,
): ChannelPill {
  if (outOfScope) return { tone: "neutral", label: "Out of scope" };
  switch (state) {
    case "live":
      return { tone: "success", label: "Live" };
    case "ready":
      return { tone: "info", label: "Ready" };
    case "attention":
      return { tone: "warning", label: "Attention" };
    default:
      return { tone: "neutral", label: "Not set up" };
  }
}

export const DELIVERY_LINE: Record<ChannelDeliveryState, string> = {
  not_set_up: "Nothing is sent here yet.",
  ready: "A build fits. Nothing has been sent yet.",
  live: "Builds are reaching this channel.",
  attention: "Fix these to keep builds flowing.",
};

const FIT: Record<string, string> = {
  format: "the file format",
  arch: "the architecture",
  "unknown-format": "an unrecognized file format",
};

export interface AttentionLine {
  title: string;
  detail: string;
  action?: { label: string; to: string };
}

export function attentionLine(
  a: ChannelAttention,
  slug: string,
  name: string,
  channelId?: string,
): AttentionLine {
  switch (a.code) {
    case "out_of_scope":
      return {
        title: "Out of scope",
        detail: `None of ${name}'s platforms fit this channel.`,
      };
    case "no_fitting_build":
      return {
        title: "No build fits",
        detail: `Builds exist, but none match ${
          a.reasons.map((x) => FIT[x] ?? x).join(" or ") || "this channel"
        }.`,
        action: { label: "See what fits", to: r.matrix(slug) },
      };
    case "credential_expiring":
      return {
        title: "Credential expiring",
        detail: "Replace it before it lapses.",
        action: { label: "Credentials", to: credentialsHome(slug, channelId) },
      };
    case "credential_missing":
      return {
        title: "Credential missing",
        detail: "Add one so Polaris Key can reach the store.",
        action: { label: "Credentials", to: credentialsHome(slug, channelId) },
      };
    case "identity_mismatch":
      return {
        title: "App differs",
        detail: `The store's ${humanField(a.field).toLowerCase()} is not the one assigned.`,
        action: { label: "Channel setup", to: r.outlets(slug) },
      };
  }
}

/** Where a credential is fixed: the channel's Setup tab, or the Credentials page for no channel. */
const credentialsHome = (slug: string, channelId?: string): string =>
  channelId ? r.channel(slug, channelId, "setup") : r.credentials(slug);

/** `bundleId` to "Bundle id". */
export function humanField(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(
    /^Apple id$/,
    "Apple ID",
  );
}

/** "iOS arm64 · macOS arm64, x64": the platforms a channel serves, for the header's meta line. */
export function platformsLine(
  platforms: readonly { platform: string; arches: readonly string[] }[],
): string {
  return platforms
    .map((p) =>
      [platformName(p.platform), p.arches.join(", ")].filter(Boolean).join(" "),
    )
    .join(" · ");
}
