// The DOM contract the React kit shares with @polaris-key/elements: the layouts and where a view's
// keys go, the controls that leave the app, the theme and copy resolution, the stylesheet's light-DOM form. One source, so the two web renderers draw the same pixels.
//
// The elements package is not published yet, so this is the kit's only import of it, and the build
// bundles this module into dist/kit/contract.js (scripts/bundle-contract.mjs): the published
// package imports only published packages.

export {
  actionOf,
  copyFor,
  decodeIcon,
  FORM_ORDER,
  formStep,
  groundPrefersDark,
  inputWithIdentity,
  LAYOUTS,
  lightDomWebCss,
  canMorph,
  morph,
  mergeThemes,
  monogramOf,
  onCopyLoaded,
  preloadCopy,
  OPENS,
  outOfRange,
  settingKind,
  settingLabel,
  settingText,
  sliderStep,
  type SettingsRow,
  dialogControls,
  placeKeys,
  provideTable,
  spellOut,
  platformLabel,
  resolveFor,
  themeVars,
  watchGround,
  watchProductIdentity,
  type FormInput,
  type FormStep,
  type Layout,
  type Resolved,
} from "@polaris-key/elements/contract";
