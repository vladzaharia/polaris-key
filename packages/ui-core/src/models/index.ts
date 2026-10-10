// One view model per UI-KITS.md §4.1 component, behind one entry point: `viewOf(component,
// input)`. Every model is a pure function of the input; the stateful ones (`SignInModel`, the
// store) feed them.

import { contextOf, type UiInput } from "../input.js";
import type { View } from "../view.js";
import type { ComponentName } from "../vocabulary.js";
import {
  activateView,
  offlineActivationView,
  welcomeView,
} from "./activate.js";
import { deviceLimitView, devicesView } from "./devices.js";
import {
  bootView,
  gateView,
  graceBannerView,
  statusScreenView,
  toastView,
} from "./gate.js";
import {
  accountView,
  aboutView,
  channelPickerView,
  cloudSyncStatusView,
  entitlementGateView,
  paywallView,
  settingsView,
} from "./settings.js";
import { licenseChoiceView, signInHandoffView, signInView } from "./signIn.js";
import {
  releaseNotesView,
  updateProgressView,
  updatePromptView,
} from "./update.js";

export type Model = (ctx: ReturnType<typeof contextOf>) => View;

export const MODELS: Readonly<Record<ComponentName, Model>> = {
  PolarisKeyGate: gateView,
  Boot: bootView,
  Welcome: welcomeView,
  SignIn: signInView,
  SignInHandoff: signInHandoffView,
  Activate: activateView,
  OfflineActivation: offlineActivationView,
  DeviceLimit: deviceLimitView,
  LicenseChoice: licenseChoiceView,
  Devices: devicesView,
  UpdatePrompt: updatePromptView,
  UpdateProgress: updateProgressView,
  ReleaseNotes: releaseNotesView,
  StatusScreen: statusScreenView,
  GraceBanner: graceBannerView,
  AccountAndLicense: accountView,
  Settings: settingsView,
  Paywall: paywallView,
  EntitlementGate: entitlementGateView,
  CloudSyncStatus: cloudSyncStatusView,
  About: aboutView,
  ChannelPicker: channelPickerView,
  Toast: toastView,
};

/** The view of `component` for `input`. */
export function viewOf(component: ComponentName, input: UiInput): View {
  return MODELS[component](contextOf(input));
}

export * from "./activate.js";
export * from "./devices.js";
export * from "./gate.js";
export * from "./settings.js";
export * from "./signIn.js";
export * from "./update.js";
