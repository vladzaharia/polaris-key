"use client";
// @polaris-key/react/kit: the Polaris Key UI kit as React components (UI-KITS.md §1.3, §4.1), on
// ui-core, drawing the elements' DOM under their shared stylesheet.
//
//   (a) drop-in   <PolarisKeyGate> runs every screen the license calls for and renders the app
//   (b) parts     every §4.1 component as its own React component, restyled with `pk-*` classes,
//                 `data-part` names and `--pk-*` variables in `@layer polaris-key`
//   (c) headless  ui-core's models (viewOf, ViewModel, SignInModel), re-exported here
//
// Theme with `<PolarisKeyTheme theme={…}>` or a component's `theme` prop (§3.1). The stylesheet is
// adopted on first render; a server-rendered app imports `@polaris-key/react/styles.css`.

import type { ComponentName } from "@polaris-key/ui-core";

import { kitComponent } from "./component.js";

export {
  PolarisKeyGate,
  PolarisKeyTheme,
  kitComponent,
  type KitAction,
  type KitProps,
  type KitTheme,
  type PolarisKeyGateProps,
} from "./component.js";
export { adoptKitStyles, kitStylesCss } from "./styles.js";

// Layer (c): the headless models, so an app building its own UI imports one package.
export {
  SignInModel,
  ViewModel,
  viewOf,
  type ComponentName,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";

const c = (name: ComponentName) => kitComponent(name);

export const Boot = c("Boot");
export const Welcome = c("Welcome");
export const SignIn = c("SignIn");
export const SignInHandoff = c("SignInHandoff");
export const Activate = c("Activate");
export const OfflineActivation = c("OfflineActivation");
export const DeviceLimit = c("DeviceLimit");
export const LicenseChoice = c("LicenseChoice");
export const Devices = c("Devices");
export const UpdatePrompt = c("UpdatePrompt");
export const UpdateProgress = c("UpdateProgress");
export const ReleaseNotes = c("ReleaseNotes");
export const StatusScreen = c("StatusScreen");
export const GraceBanner = c("GraceBanner");
export const AccountAndLicense = c("AccountAndLicense");
export const Settings = c("Settings");
export const Paywall = c("Paywall");
export const EntitlementGate = c("EntitlementGate");
export const CloudSyncStatus = c("CloudSyncStatus");
export const About = c("About");
export const ChannelPicker = c("ChannelPicker");
export const Toast = c("Toast");
