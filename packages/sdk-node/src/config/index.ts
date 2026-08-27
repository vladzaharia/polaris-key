// `@plrs/node/config` — the Config service's client surface.

export {
  ConfigClient,
  DEFAULT_ENV_PREFIX,
  type ConfigClientOptions,
  type ConfigSource,
  type UserConfigEntry,
} from "./client.js";

export { fetchConfigDocument } from "./fetch.js";
