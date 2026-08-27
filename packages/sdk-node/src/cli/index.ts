// `@polaris-key/node/cli` — composable CLI command hooks. Consumers inject Polaris Key commands into
// their own commander- or yargs-based CLI in a couple of lines. The core (`commands.ts`) is
// framework-agnostic + side-effect-free; the commander/yargs adapters are thin shells (each an
// OPTIONAL peer dependency).
//
// Verbs are grouped by owning service — license (activate/enroll/deactivate/status), devices
// (register), config (config), core (import-bundle) — so the CLI surface matches the SDK's.

export {
  activate,
  deactivate,
  enroll,
  getConfig,
  importBundle,
  register,
  status,
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
