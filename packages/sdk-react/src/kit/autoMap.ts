// Automatic sign-in in the gate: the SDK's result in the form's terms, and the one run per
// adapter. Shared with the elements' gate (ui-core/browser/sdk/autoSignIn.ts); small and eager (the
// gate reads it at boot); the form that draws the steps loads on demand (autoForm.tsx).

export {
  autoSignInOnce,
  outcomeOf,
  runAuto,
} from "@polaris-key/ui-core/browser/sdk/autoSignIn.js";
export { linkOfferOutcome } from "@polaris-key/ui-core/browser/sdk/linkOffer.js";
