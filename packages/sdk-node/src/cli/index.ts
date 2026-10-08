// `@polaris-key/node/cli` — the Node terminal kit (docs/design/UI-KITS.md §1.4 "Terminal", §5.1
// Node row) and the composable CLI command hooks under it. Consumers inject Polaris Key commands
// into their own commander- or yargs-based CLI in a couple of lines; each verb runs the kit's
// flow (the rail, masked key entry, spinners and progress, `--json`, grouped help).
//
// Three layers (§1.3): (a) the drop-in flows (`flows.ts`, wired by the adapters), (b) the styled
// parts (`parts.ts`, over `@polaris-key/node/terminal`), (c) the headless views (`models.ts`).
// The plain command core (`commands.ts`, `kit.ts`'s `run`) stays side-effect-free and is what
// `kit: false` prints. Verbs are grouped by owning service (`CLI_VERBS`).

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
  type VerbFlags,
} from "./kit.js";

export {
  activateFlow,
  changelogFlow,
  checkFlow,
  configGetFlow,
  configListFlow,
  configWriteFlow,
  deactivateFlow,
  devicesListFlow,
  devicesRemoveFlow,
  devicesRenameFlow,
  doctorFlow,
  enrollFlow,
  importBundleFlow,
  loginFlow,
  logoutFlow,
  mintFlow,
  offlineRequestFlow,
  packsEnsureFlow,
  packsStatusFlow,
  registerFlow,
  secretFlow,
  statusFlow,
  updateApplyFlow,
  updateCheckFlow,
  type ActivateArgs,
  type ConfirmArgs,
  type LoginArgs,
} from "./flows.js";

export {
  activationOutcome,
  clock,
  devicesView,
  handoffView,
  installView,
  KEY_SECRET_LENGTH,
  keyVerdict,
  progressView,
  seatCells,
  statusExit,
  statusView,
  updateView,
  type ActivateOutcome,
  type DeviceLimitView,
  type DevicesView,
  type GateStatus,
  type HandoffState,
  type HandoffView,
  type KeyFieldState,
  type KeyVerdict,
  type StatusFix,
  type StatusView,
  type UpdatePromptView,
  type UpdateProgressView,
  type View,
} from "./models.js";

export {
  codeRows,
  endRow,
  fixRows,
  gap,
  hintsRow,
  keyMask,
  linkSpan,
  problemRows,
  productHeader,
  seatMeter,
  stepRow,
  tableRows,
  textRow,
} from "./parts.js";

export {
  bundleIdentity,
  presentationSourceOf,
  readPresentation,
  resolveProduct,
  titleizeSlug,
  type AccentSource,
  type PolarisKeyTerminalTheme,
  type PresentationSource,
  type ProductIdentity,
  type ProductPresentation,
  type ResolvedProduct,
} from "./theme.js";

export {
  createKitContext,
  createKitContextSync,
  type CreateContextOptions,
  type KitContext,
  type TerminalIO,
} from "./context.js";

export {
  formatMessage,
  KitCopy,
  localeFromEnv,
  resolveLocale,
  type CopyArgs,
  type CopyOptions,
} from "./copy.js";

export {
  accentLabel,
  contrastRatio,
  deriveAccent,
  resolveAccent,
  type ResolvedProductAccent,
} from "./accent.js";

export {
  COMPLETION_SHELLS,
  completionScript,
  GLOBAL_OPTIONS,
  GROUP_HEADINGS,
  renderHelp,
  renderVerbHelp,
  VERB_OPTIONS,
  type CompletionShell,
} from "./help.js";

export {
  CLI_JSON_VERSION,
  envelope,
  EXIT,
  type CliJson,
  type CliJsonError,
  type FlowResult,
} from "./json.js";

export {
  lineSink,
  runKitVerb,
  type KitAdapterOptions,
  type ParsedVerbFlags,
} from "./adapter.js";

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
