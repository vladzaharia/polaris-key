/**
 * The stable requirement codes `PATCH …/services` returns in `error.errors` (worker
 * `core/services.ts` `validateServices`). The server owns prerequisite enforcement; the console
 * only explains a refusal or blocks a visibly impossible enable.
 */
export const SERVICE_ERROR_MESSAGES: Record<string, string> = {
  distribution_requires_release:
    "Rollouts deliver what Releases says exists, so turn on Releases first.",
  update_requires_distribution: "In-app updates need Rollouts to be on first.",
  sync_requires_config: "Cloud Sync needs Managed config to be on first.",
  sync_requires_identity: "Cloud Sync needs Sign-in to be on first.",
  commerce_requires_license: "Commerce needs Licensing to be on first.",
};
