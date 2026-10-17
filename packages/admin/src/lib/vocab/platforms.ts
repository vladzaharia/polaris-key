/**
 * Platform names: the one place the console and the portal turn a platform id (`macos`) into
 * words (P0-35). The wording is layered, never copied:
 *
 * 1. the kit copy catalog's `part.platform.<id>` (a device's platform, trademark names; the same
 *    words the SDK kits show);
 * 2. `@polaris-key/manifest` `platformLabel` (build platforms the catalog has no key for, such
 *    as `xbox` or `switch`, and the consumer wording "iPhone and iPad");
 * 3. the id as sent, for a value neither knows (it is already a name, such as "Windows 11").
 *
 * `test/vocab.test.ts` fails when a label map for these names appears anywhere else.
 */
import { platformLabel as manifestPlatformLabel } from "@polaris-key/manifest";
import { hasCopy, t } from "../copy.js";

/** A platform's name for operators and for a device row: "macOS", "iOS", "Xbox". Empty reads
 *  "None". */
export function platformName(platform: string | null | undefined): string {
  const id = platform?.trim();
  if (!id) return "None";
  const key = `part.platform.${id.toLowerCase()}`;
  if (hasCopy(key)) return t(key);
  return manifestPlatformLabel(id);
}

/** A platform's name for a customer: "macOS", "iPhone and iPad", "Web". */
export function platformConsumerName(
  platform: string | null | undefined,
): string {
  const id = platform?.trim();
  if (!id) return "None";
  const k = id.toLowerCase();
  return k === "ios"
    ? manifestPlatformLabel(k, { audience: "consumer" })
    : platformName(id);
}

/**
 * A platform inside a sentence ("Download for macOS", "Runs on the web"). `phone` names the iOS
 * device itself ("iPhone"), for a button that downloads to this device.
 */
export function platformInSentence(
  platform: string | null | undefined,
  opts: { phone?: boolean } = {},
): string {
  const k = platform?.trim().toLowerCase();
  if (k === "web") return "the web";
  if (k === "ios" && opts.phone) return "iPhone";
  return platformConsumerName(platform);
}

/** App Store Connect's platform values (`MAC_OS`), as Apple writes them, and the platform id each
 *  stands for. */
export const APPLE_PLATFORM_IDS: Readonly<Record<string, string>> = {
  IOS: "ios",
  MAC_OS: "macos",
  TV_OS: "tvos",
  VISION_OS: "visionos",
};

/** App Store Connect's platform values with their names, for pickers and cells. */
export const APPLE_PLATFORM_LABELS: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(APPLE_PLATFORM_IDS).map(([apple, id]) => [
      apple,
      platformName(id),
    ]),
  );
