// @polaris-key/ui-core: the one headless layer of every JavaScript UI kit (docs/design/UI-KITS.md
// §1.3 layer c, §5.1). Elements, React, the Electron main process and the Node terminal all
// render from it, so a screen fed the same input shows the same step with the same copy key in
// every kit; conformance/corpus/v2/ui-matrix.json pins it for every language.
//
//   viewOf(component, input)   one view model per §4.1 component: state, copy keys, actions,
//                              arguments, and the design language's decisions (DL4, DL6, DL7,
//                              DL9, DL14) as data
//   SignInModel                the one sign-in form's state machine over the SDK primitives
//   ViewModel                  any component's view as a live value, DL7's delay included
//   createStore                snapshot + subscribe, with the UI-thread delivery hook
//   Copy, formatMessage        the catalog lookup and ICU-subset formatter (tables injected)
//   linkVerdict, validLink     DL14's one validating opener
//   LOADING_DELAY_MS           DL7's loading delay, as a model timer
//
// The theme and ProductIdentity resolvers need `@polaris-key/brand`: they are the
// `@polaris-key/ui-core/theme` subpath. The terminal kit's text views are
// `@polaris-key/ui-core/terminal`. No module here imports a DOM, React or Lit.

export * from "./vocabulary.js";
export * from "./input.js";
export * from "./view.js";
export * from "./errors.js";
export * from "./link.js";
export * from "./loading.js";
export * from "./store.js";
export * from "./copy.js";
export * from "./models/index.js";
export * from "./signInModel.js";
export * from "./viewModel.js";
