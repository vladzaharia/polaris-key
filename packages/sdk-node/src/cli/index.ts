// `@polaris-key/node/cli` — composable CLI command hooks. Consumers inject Polaris Key commands into
// their own commander- or yargs-based CLI in a couple of lines. The core (`commands.ts`) is
// framework-agnostic + side-effect-free; the commander/yargs adapters are thin shells (each an
// OPTIONAL peer dependency).
//
// Verbs are grouped by owning service (see `kit.ts` for the full table, `CLI_VERBS`) so the CLI
// surface matches the SDK's: license, identity, devices, config, update, packs and core.

export {
  activate,
  deactivate,
  describeFailure,
  enroll,
  formatStoreStatus,
  getConfig,
  importBundle,
  LINUX_NO_MACHINE_ID_HINT,
  register,
  status,
  type CommandResult,
  type ClientFactory,
  type ClientFactoryOptions,
} from "./commands.js";

export {
  argName,
  changelog,
  CLI_VERBS,
  configList,
  configReset,
  configSet,
  describeDecision,
  devicesDeauthorize,
  devicesList,
  devicesRename,
  doctor,
  mint,
  offlineRequest,
  packsEnsure,
  packsStatus,
  parseCliValue,
  progressBar,
  secret,
  signIn,
  signOut,
  updateApply,
  updateCheck,
  type CliGroup,
  type CliIO,
  type CliVerb,
} from "./kit.js";

export {
  registerPolarisCommands,
  ttyProgress,
  type CommanderAdapterOptions,
} from "./commander.js";

// The yargs adapter shares the `registerPolarisCommands` name; expose it under explicit
// aliases to avoid the collision while keeping both reachable from the barrel.
export {
  polarisCommandModule,
  registerPolarisCommands as registerYargsCommands,
  type YargsAdapterOptions,
} from "./yargs.js";
