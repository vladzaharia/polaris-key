/**
 * The platform family of a device (WIRE-CONTRACT-V4 §13.1; plans/U-01b.md R4): the coarse group a
 * `platform`-scope synced setting is shared within. Four families exist (`desktop`, `mobile`,
 * `console`, `web`). It is derived from the device row's stored `X-PKey-Platform` value
 * (§5.2's canonical spellings), never from a request body, so a client cannot pick its family.
 *
 * A device that has reported no platform, or one outside the table, is `desktop`: the family
 * is a grouping of the person's OWN devices, never a permission, so a wrong guess can only
 * share a platform-scope value with the wrong group of that same person's devices.
 */

import type { ClientPlatform } from "@polaris-key/protocol/core";

/** The closed set of platform ids a device can report (the keys of `FAMILY_OF`). */
export function knownPlatform(value: unknown): ClientPlatform | null {
  return typeof value === "string" && Object.hasOwn(FAMILY_OF, value)
    ? (value as ClientPlatform)
    : null;
}

export type PlatformFamily = "desktop" | "mobile" | "console" | "web";

const FAMILY_OF: Readonly<Record<ClientPlatform, PlatformFamily>> = {
  macos: "desktop",
  windows: "desktop",
  linux: "desktop",
  visionos: "desktop",
  ios: "mobile",
  android: "mobile",
  watchos: "mobile",
  tvos: "console",
  web: "web",
};

export function platformFamily(
  platform: string | null | undefined,
): PlatformFamily {
  if (!platform) return "desktop";
  return Object.hasOwn(FAMILY_OF, platform)
    ? FAMILY_OF[platform as ClientPlatform]
    : "desktop";
}
