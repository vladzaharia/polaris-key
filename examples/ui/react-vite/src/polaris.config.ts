// What `--live` connects with. Replace this file with the one `pkey sdk --lang react --write`
// generates for your product: the slug, the Worker's origin and the pinned trust keys (a page on
// its own origin verifies every document against them). Never paste keys by hand.
import type { PolarisKeyProviderProps } from "@polaris-key/react";

export const pinnedKeys: Record<string, string> = {};

export const polarisConfig = {
  productSlug: "tidewater",
  baseUrl: "https://key.plrs.im",
  trust: { pinnedKeys },
  expectServices: ["license", "config", "identity", "update"],
} satisfies Partial<PolarisKeyProviderProps>;

export default polarisConfig;
