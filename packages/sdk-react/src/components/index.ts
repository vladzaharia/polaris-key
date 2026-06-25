// The drop-in UI: the full-window gate, the sign-in card, and the theme primitives.

export {
  LicenseGate,
  type LicenseGateProps,
  type LicenseGateSlots,
} from "./LicenseGate.js";
export { PolarisLogin, type PolarisLoginProps } from "./PolarisLogin.js";
export { PolarisLogout, type PolarisLogoutProps } from "./PolarisLogout.js";
export {
  defaultTheme,
  highContrastTheme,
  mergeTheme,
  themeVars,
  type PolarisTheme,
  type PolarisThemeTokens,
  type PolarisThemeCopy,
  type PartialTheme,
} from "./theme.js";
