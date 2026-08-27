// @plrs/react/config — the Config service's UI surface: the managed-settings hook and the
// prebuilt settings panel over it.

export { useManagedConfig } from "../react/hooks.js";
export type { UseManagedConfig } from "../react/hooks.js";
export {
  ConfigPanel,
  type ConfigPanelProps,
  type ConfigPanelSlots,
  type ConfigRow,
} from "../components/ConfigPanel.js";
export type { UserConfigEntry } from "../core/index.js";
export type { ConfigSource } from "@plrs/client-core";
export type { ManagedEntry, ManagementState } from "@plrs/protocol/core";
