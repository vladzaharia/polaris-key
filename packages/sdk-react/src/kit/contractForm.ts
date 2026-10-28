// The sign-in form's steps, apart from the shared contract module: only the form (a lazy chunk)
// draws them, and keeping them out of ./contract.js keeps ui-core's whole view registry out of the
// gate's first load. Bundled beside contract.js (scripts/bundle-contract.mjs).
export {
  FORM_ORDER,
  formStep,
  type FormInput,
  type FormStep,
} from "@polaris-key/elements/form";
