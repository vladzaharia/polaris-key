// Layer (c) for the elements (UI-KITS.md §1.3): the headless models are ui-core's, re-exported so
// an app that builds its own UI imports one package. No DOM, no Lit.
export {
  SignInModel,
  ViewModel,
  viewOf,
  type UiInput,
  type View,
  type ComponentName,
  type ScreenName,
  type HolderScreenName,
  type ReasonServices,
  type ActivateDoneState,
  type AddToAccountState,
  activateDoneView,
  addToAccountView,
  recommendReasons,
  maskEmail,
  type ActivationInput,
  type LicenseChoiceView,
  type ReplaceView,
  type SignInPrimitives,
  type SignInWait,
} from "@polaris-key/ui-core";
