// Automatic sign-in in `<pk-gate config>` (plans/auto-sign-in.md, I-46.9): the mapping and the
// primitives are ui-core's (shared with React's gate); this is the one check the gate makes.

import type { PolarisAdapter } from "@polaris-key/ui-core/browser";
import { Feature } from "@polaris-key/ui-core/browser/sdk/constants.generated.js";

export {
  AUTO_WAIT_MS,
  runAuto,
} from "@polaris-key/ui-core/browser/sdk/autoSignIn.js";
export { primitivesOf } from "@polaris-key/ui-core/browser/sdk/autoPrimitives.js";
export { linkOfferOutcome } from "@polaris-key/ui-core/browser/sdk/linkOffer.js";

/** True where the build has a ladder to run. */
export function autoSupported(a: PolarisAdapter): boolean {
  return (
    typeof a.autoSignIn === "function" &&
    a.supports(Feature.identityAutosignin).supported === true
  );
}
