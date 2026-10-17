/**
 * Distribution's facade for the composition modules (P0-19): the one module under
 * `services/distribution/` that `dispatch.ts` and `assetQueue.ts` may import besides `index.ts`
 * (`test/boundaries.test.ts`). It re-exports exactly what they use; anything new a surface needs
 * from this service is added here.
 */

export { listingSlotMirror } from "./listing/hostedMirror.js";
export { syncManifestListingAssets } from "./listing/manifestAssets.js";
