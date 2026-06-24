// `@polaris-key/node/cli` — composable CLI command hooks. Consumers inject Polaris Key
// commands (activate/deactivate/status/config) into their own commander- or yargs-based CLI
// in a couple of lines. The core (`commands.ts`) is framework-agnostic + side-effect-free;
// the commander/yargs adapters are thin shells (each an OPTIONAL peer dependency).

export {
  activate,
  deactivate,
  status,
  getConfig,
  type CommandResult,
  type ClientFactory,
  type ClientFactoryOptions,
} from "./commands.js";

export {
  registerPolarisCommands,
  type CommanderAdapterOptions,
} from "./commander.js";

// The yargs adapter shares the `registerPolarisCommands` name; expose it under explicit
// aliases to avoid the collision while keeping both reachable from the barrel.
export {
  polarisCommandModule,
  registerPolarisCommands as registerYargsCommands,
  type YargsAdapterOptions,
} from "./yargs.js";
