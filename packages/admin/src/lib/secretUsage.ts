import type { SecretUsage } from "../api.js";

/**
 * What a product secret may be used for, as the Set secret form offers it (P0-12). Only an
 * operator chooses a usage; a manifest can name a secret but never make it signable. "Keep
 * current" sends no usage, so re-uploading a rotated key never changes what it may sign.
 */
export type UsageChoice = "keep" | SecretUsage;

export const USAGE_CHOICES: { value: UsageChoice; label: string }[] = [
  { value: "keep", label: "Keep current (new secrets: general)" },
  { value: "general", label: "General" },
  { value: "edge-mint", label: "Edge-mint signing key" },
];
