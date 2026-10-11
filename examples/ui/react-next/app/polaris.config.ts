// `--live` connects with this configuration. Replace this file with the one
// `pkey sdk --lang react --write` generates for your product: its slug, Worker origin and
// pinned trust keys. A browser page verifies every document against those keys.
import type { PolarisKeyConfig } from "@polaris-key/react";

export const pinnedKeys: Record<string, string> = {};

export const polarisKey = {
  productSlug: "tidewater",
  baseUrl: "https://key.plrs.im",
  trust: { pinnedKeys },
  expectedServices: ["license", "config", "identity", "update"] as const,
} satisfies PolarisKeyConfig;

export default polarisKey;
