"use client";
// @polaris-key/react/kit: the Polaris Key UI kit as React components (UI-KITS.md §1.3, §4.1), on
// ui-core, drawing the elements' DOM under their shared stylesheet.
//
//   (a) drop-in   <PolarisKeyGate> runs every screen the license calls for and renders the app
//   (b) parts     every §4.1 component as its own React component, restyled with `pk-*` classes,
//                 `data-part` names and `--pk-*` variables in `@layer polaris-key`
//   (c) headless  ui-core's models (viewOf, ViewModel, SignInModel), re-exported here, and
//                 useSignIn() for the one sign-in form
//
// Theme with `<PolarisKeyTheme theme={…}>` or a component's `theme` prop (§3.1). The stylesheet is
// adopted on first render; a server-rendered app imports `@polaris-key/react/styles.css`.

import type { ComponentName } from "@polaris-key/ui-core";

import { kitComponent } from "./kitComponent.js";
import { holderScreen } from "./holdersLazy.js";
import { syncScreen } from "./syncLazy.js";
import type { ActivateDoneProps, AddToAccountProps } from "./holders.js";
import type {
  RecoveryCodeProps,
  RingChangeProps,
  UnlockSyncProps,
} from "./syncScreens.js";

export { kitComponent } from "./kitComponent.js";
export {
  PolarisKeyTheme,
  type KitAction,
  type KitProps,
  type KitTheme,
  type PolarisKeyGateProps,
} from "./component.js";
export { adoptKitStyles, kitStylesCss } from "./styles.js";
// Register a launch locale's copy pack up front, for a host whose bundler does not split the
// lazily loaded packs (the kit otherwise fetches a pack the first time its locale is asked for).
export { provideTable as provideKitCopy } from "./contract.js";
// Load the lazily split parts (the QR encoder, the settings, device and account rows) up front.
export { preloadParts as preloadKitParts } from "./lazy.js";
// The one sign-in form (SIGN-IN.md §3.17): the drop-in form, its step parts, its headless hook.
export {
  ReplaceDevice,
  SignIn,
  SignInDone,
  SignInMethods,
  useSignIn,
  type FormInput,
  type FormStep,
  type SignInProps,
  type UseSignIn,
  type UseSignInOptions,
} from "./signin.js";

// Layer (c): the headless models, so an app building its own UI imports one package.
export {
  SignInModel,
  ViewModel,
  viewOf,
  type ComponentName,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";

// The parts that act run themselves inside the provider (layer a) and are the plain parts given an
// `input` (layer b).
export { About, Devices, Settings, UpdatePrompt } from "./drive.js";
export { PolarisKeyGate } from "./gate.js";

const c = (name: ComponentName) => kitComponent(name);

export const Boot = c("Boot");
export const Welcome = c("Welcome");
export const SignInHandoff = c("SignInHandoff");
// NearbyApproval is not exported: nearby approval ships with I-40 and CC-15, and its ask step
// draws no codes yet (UXR-kits-v7 B4). The component stays internal (`kitComponent`).
export const Activate = c("Activate");
export const OfflineActivation = c("OfflineActivation");
export const DeviceLimit = c("DeviceLimit");
export const LicenseChoice = c("LicenseChoice");
export const UpdateProgress = c("UpdateProgress");
export const ReleaseNotes = c("ReleaseNotes");
export const StatusScreen = c("StatusScreen");
export const GraceBanner = c("GraceBanner");
export const AccountAndLicense = c("AccountAndLicense");
export const Paywall = c("Paywall");
export const EntitlementGate = c("EntitlementGate");
export { CloudSyncStatus } from "./statusDrive.js";
// The Cloud Sync screens load on demand (their chunk is fetched the first time one is drawn).
export const UnlockSync = syncScreen<UnlockSyncProps>("UnlockSync");
export const RecoveryCode = syncScreen<RecoveryCodeProps>("RecoveryCode");
export const RingChange = syncScreen<RingChangeProps>("RingChange");
// Activation without an account (UK-42): the Done step after a license key, and Add your name and
// email. They load on demand; the hooks are the headless half and load nothing.
export const ActivateDone = holderScreen<ActivateDoneProps>("ActivateDone");
export const AddToAccount = holderScreen<AddToAccountProps>("AddToAccount");
export {
  useActivateDone,
  useAddToAccount,
  type AddToAccountValues,
  type AttachOutcome,
  type UseActivateDone,
  type UseActivateDoneOptions,
  type UseAddToAccount,
  type UseAddToAccountOptions,
} from "./holderHooks.js";
export type { ActivateDoneProps, AddToAccountProps } from "./holders.js";
export const ChannelPicker = c("ChannelPicker");
export const Toast = c("Toast");
