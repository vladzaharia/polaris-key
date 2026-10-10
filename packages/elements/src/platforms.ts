// Platform names for device rows (DL8: never a raw platform id; `macos` is macOS). The kit-copy
// catalog has no platform-name keys yet, so this typed table is the fallback until it does: every
// `Os` of ui-core's vocabulary has a label (the compiler holds the table to the vocabulary), plus
// the ids a server's device record commonly carries. Platform names are trademarks and stay the
// same in every launch locale. A value the table does not know is shown as the server sent it
// (it is already a name, such as "Windows 11"), never lower-cased or guessed at.

import type { Os } from "@polaris-key/ui-core";

/** The name of each platform of the vocabulary. */
export const OS_LABELS: Readonly<Record<Os, string>> = {
  macos: "macOS",
  ios: "iOS",
  android: "Android",
  windows: "Windows",
  linux: "Linux",
  web: "Web",
  tvos: "tvOS",
  visionos: "visionOS",
  watchos: "watchOS",
};

/** Ids outside the vocabulary that device records carry. */
const MORE_LABELS: Readonly<Record<string, string>> = {
  ipados: "iPadOS",
  chromeos: "ChromeOS",
  steamos: "SteamOS",
  freebsd: "FreeBSD",
  darwin: "macOS",
  win32: "Windows",
};

/** A device's platform as a person reads it: the table's name for a known id, else the text as
 *  sent; an empty string for none. */
export function platformLabel(platform: string | null | undefined): string {
  if (!platform) return "";
  const id = platform.trim().toLowerCase();
  return (
    (OS_LABELS as Readonly<Record<string, string>>)[id] ??
    MORE_LABELS[id] ??
    platform.trim()
  );
}
