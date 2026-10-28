// @polaris-key/react/config — the managed-settings hook and wire types. Render the shared
// settings part with `Settings` from `@polaris-key/react/kit`.
export { useManagedConfig, useConfigSetting } from "../react/hooks.js";
export type { UseManagedConfig, UseConfigSetting } from "../react/hooks.js";
export { useSetting } from "../react/useCloudSync.js";
export type { UseSetting } from "../react/useCloudSync.js";
export type {
  ChangeOrigin,
  SettingSync,
  ConfigChange,
  ConfigSetting,
  ConfigStorage,
  LocalConfig,
} from "../core/localConfig.js";
export type { UserConfigEntry, ProductCatalog } from "../core/index.js";
export type { ConfigSource } from "@polaris-key/client-core";
export type { ManagedEntry, ManagementState } from "@polaris-key/protocol/core";
