import type { CloudSyncEncryption } from "@polaris-key/catalog";

/** The console's words for a product's Cloud Sync encryption (`cloudSync.encryption`). */
export const ENCRYPTION_LABEL: Record<CloudSyncEncryption, string> = {
  e2e: "End-to-end",
  server: "Readable by Polaris Key",
};

/**
 * What a publish that changes the encryption to `to` means for data people already synced.
 * Neither direction rewrites anything (U-01b R4 rule 6).
 */
export function encryptionChangeCopy(to: CloudSyncEncryption): string {
  return to === "server"
    ? "Data already synced stays as it is. New saves are readable by Polaris Key."
    : "Data already synced stays as it is. New saves are sealed on the device, out of Polaris Key's reach.";
}
