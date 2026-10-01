// `@polaris-key/node/config` — the Config service's client surface.

export {
  ConfigClient,
  DEFAULT_ENV_PREFIX,
  type ConfigClientOptions,
  type ConfigSource,
  type MintedToken,
  type UserConfigEntry,
} from "./client.js";

export { MINT_REUSE_MARGIN_SECONDS } from "./mint.js";

export { fetchConfigDocument } from "./fetch.js";
