/**
 * Overview's SDK quick start (UX-59; docs/design/SETUP.md §3.3, §3.4): what an app needs to talk
 * to this product, per SDK. The content is `renderSdkSetup` from `@polaris-key/manifest/integration`
 * (SP-33a), the same function `pkey sdk` and the docs call; this file only feeds it the product's
 * facts and keeps the console-side bits (the SDK chooser, the pins read from the admin API).
 *
 * - **Install** comes only from Polaris Key's own feeds on `pkg.plrs.im`, and always routes the
 *   namespace to the feed before anything is installed. A bare `npm install @polaris-key/node`
 *   would resolve against npmjs: dependency confusion (D17).
 * - **Configuration** pins every signing key the product trusts now, the active one and any staged
 *   for rotation, so a build made during a staged rotation trusts both (D16). The pins come from
 *   the authenticated admin API (`GET …/keys`), never from discovery.
 * - The version an app sends is **its own**, never the latest release's.
 */

import {
  DEFAULT_BASE_URL,
  SDK_IDS,
  SDK_LABELS,
  renderSdkSetup,
  type SdkId,
  type SdkSetup,
  type TrustPin,
} from "@polaris-key/manifest/integration";
import type { ServiceSlug, SigningKeyDto } from "../../../../api.js";
import type { CodeLanguage } from "../../../../lib/highlight.js";

export type { SdkId, TrustPin };

export const SDK_OPTIONS: readonly { value: SdkId; label: string }[] =
  SDK_IDS.map((value) => ({ value, label: SDK_LABELS[value] }));

/** The DOM id of the SDK chooser in Overview's quick start; the palette's SDK rows focus it. */
export const SDK_QUICK_START_ID = "sdk-quick-start";

/**
 * The keys an app pins: every active and staged signing key, active first. Falls back to the
 * product row's active key while the inventory loads or when it cannot be read.
 */
export function trustPins(
  keys: readonly SigningKeyDto[] | undefined,
  active: { kid: string; publicKey?: string } | null,
): TrustPin[] {
  const fromInventory = (keys ?? [])
    .filter((k) => k.status === "active" || k.status === "staged")
    .sort((a, b) =>
      a.status === b.status ? 0 : a.status === "active" ? -1 : 1,
    )
    .map((k) => ({ kid: k.kid, publicKey: k.publicKey }));
  if (fromInventory.length > 0) return fromInventory;
  return active?.publicKey
    ? [{ kid: active.kid, publicKey: active.publicKey }]
    : [];
}

export interface SdkSetupInput {
  slug: string;
  /** The console's origin; the config omits nothing, but production is the default. */
  origin: string;
  pins: readonly TrustPin[];
  services: readonly ServiceSlug[];
}

/** The setup for one SDK: install, configuration with the pins, and the drop-in start. */
export function sdkSetup(sdk: SdkId, o: SdkSetupInput): SdkSetup {
  return renderSdkSetup(sdk, {
    slug: o.slug,
    origin: o.origin || DEFAULT_BASE_URL,
    pins: o.pins,
    services: o.services,
  });
}

/** The highlighter's name for a block's language; it knows `ts` and falls back to plain text. */
export function codeLanguage(lang: string): CodeLanguage {
  return lang === "ts" || lang === "tsx" ? "ts" : "text";
}
