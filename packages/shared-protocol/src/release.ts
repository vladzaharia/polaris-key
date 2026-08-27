// @polaris-key/protocol/release — Release service wire types (spec §A/D-13).

/** Release surface visibility. `entitled` (v3, D-13) additionally enforces the caller's
 *  per-license channel entitlement + version window on feeds and artifacts — the
 *  per-product opt-in that closes the R3 "stable-only license fetches the beta appcast"
 *  gap without breaking public/anonymous update checking for products that want it. */
export type ReleaseAccess =
  | "public"
  | "authenticated"
  | "licensed"
  | "entitled";

export interface ReleaseAccessPolicy {
  metadata: ReleaseAccess;
  artifacts: ReleaseAccess;
}

export const DEFAULT_RELEASE_ACCESS: ReleaseAccessPolicy = {
  metadata: "public",
  artifacts: "public",
};
