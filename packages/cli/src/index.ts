import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BUNDLE_USAGE,
  DEFAULT_BASE_URL,
  maskTokens,
  mintBundle,
  type TokenSource,
} from "./bundle.js";
import {
  internalMessage,
  isInternalError,
  isUsageError,
  networkMessage,
  UsageError,
} from "./errors.js";
import { CLI_VERSION } from "./version.js";
import { writeOutputs } from "./actionOutputs.js";
import { MIGRATE_USAGE, formatMigrate, runMigrate } from "./migrate.js";
import {
  COMPLETION_SHELLS,
  COMMANDS,
  completionScript,
  findCommand,
  renderCommandHelp,
  renderHelp,
  shortUrl,
  VALUELESS_FLAGS,
  type CompletionShell,
  type HelpHere,
} from "./help.js";
import {
  controlDev,
  DEV_CONFIG_FILE,
  DEV_DEFAULT_PORT,
  devConfigUrl,
  devInfoFrom,
  serveDev,
  type DevArgs,
  type DevInfo,
} from "./devCommand.js";
import { fixManifest, type FixMove } from "./fix.js";
import {
  block,
  cmdLogout,
  cmdWhoami,
  envelope,
  guarded,
  originFor,
  text,
  type AccountIo,
} from "./account.js";
import { withAdminCredential, type AdminIo } from "./adminAuth.js";
import { cmdLogin, type LoginSeams } from "./login.js";
import { cmdFeedsWrite, type FeedWriteSeams } from "./feedWrite.js";
import { keyringStore, type CredentialStore } from "./credentials.js";
import { applyContext, resolveContext, type PkeyContext } from "./context.js";
import {
  buildReport,
  checkConfigFiles,
  checkRemote,
  DOCTOR_TIMEOUT_MS,
  gatherSession,
  hostOf,
  renderReport,
  reportJson,
  sessionJson,
  type ManifestInput,
} from "./doctor.js";
import { nearest } from "./suggest.js";
import {
  failLine,
  Spinner,
  termFor,
  type Term,
  type TermFlags,
  type TermOut,
} from "./terminal.js";
import {
  findDistributionFile,
  initManifest,
  loadManifest,
  normalizeModules,
  outletIdsFor,
  validateLoadedManifest,
  ManifestSyntaxError,
  type LoadedManifest,
  type ProductModule,
  type ValidationMessage,
  type ValidationResult,
} from "./manifest.js";
import { authGithubOidc, CI_TOKEN_ENV, type CiEnv } from "./oidc.js";
import type { StageProgress } from "./ci.js";
import {
  wrapSpans,
  type Line,
  type TerminalInput,
} from "@polaris-key/node/terminal";
import { askInit, initInput, mayPrompt, type InitKeys } from "./initPrompt.js";
import {
  guardOutput,
  untrusted,
  untrustedJson,
  untrustedLines,
  type UntrustedEnv,
} from "./untrusted.js";
import {
  descriptorManifestOf,
  PUBLISH_USAGE,
  publishRelease,
  type PublishSource,
} from "./publish.js";
import { renderSdkSetup } from "@polaris-key/manifest/integration";
import {
  factsSummary,
  fingerprintOf,
  isSdkLang,
  mergeGodotOptions,
  parseReleaseKeyFlags,
  renderSdkConfig,
  resolveSdkFacts,
  SDK_CONFIG_DEFAULT_OUT,
  SDK_CONFIG_MARKER,
  SDK_CONFIG_USAGE,
  SDK_LANGS,
  type DeclaredReleaseKey,
  type SdkConfigFacts,
  type SdkLang,
} from "./sdkConfig.js";
import { MIRROR_USAGE, writeMirrors } from "./mirrors.js";
import { parseRemoves } from "./saveCompat.js";
import { CHANNEL_USAGE, movePointer, yankRelease } from "./channels.js";
import { isPackageDeliverable, publishPackage } from "./package/publish.js";
import { publishPack } from "./packPublish.js";
import { CONTENT_STAMP_USAGE, writeContentStampFile } from "./contentStamp.js";
import {
  REVOKE_DELEGATION_USAGE,
  REVOKE_USAGE,
  revokeDelegation,
  revokePackRelease,
} from "./revoke.js";
import {
  CONTENT_KEYS_USAGE,
  DELEGATE_USAGE,
  delegateContentKey,
  generateContentKey,
  generatedContentKeyText,
} from "./delegate.js";
import {
  DISTRIBUTION_CI_USAGE,
  ROLLOUT_COMMANDS,
  driveRollout,
  reportDistribution,
  type ReportType,
  type RolloutCommand,
} from "./distribution.js";
import { writeManifestSchemas } from "./schemas.js";
import { TRANSPORT_USAGE, type TransportCommon } from "./transport.js";
import { baPackage, baUpload } from "./transportAppleBa.js";
import { padModules, type PadDelivery } from "./transportPlayPad.js";
import { steamVdf } from "./transportSteam.js";
import { cmdStorefront } from "./storefronts/command.js";
import { CI_INIT_USAGE, ciInit } from "./ciInit.js";
import { cmdChannel, type ChannelArgs, type ChannelIo } from "./channel.js";
import { feedsSetup, FEEDS_SETUP_USAGE } from "./feedSetup.js";
import { feedsPrune, FEEDS_PRUNE_USAGE } from "./feedPrune.js";
import { formatImport, listingImport, LISTING_USAGE } from "./listing.js";
import { listingAssets, LISTING_ASSETS_USAGE } from "./listingAssets.js";
import { ASSETS_PUSH_USAGE, pushAssets } from "./assets.js";
import {
  generatedKeyText,
  generateReleaseKey,
  KEYS_USAGE,
} from "./releaseKeys.js";

export {
  ASSETS_PUSH_USAGE,
  parseAssetMap,
  pushAssets,
  resolveAssetMap,
  type AssetEntry,
  type PushAnswer,
  type PushAssetsOptions,
} from "./assets.js";
export {
  listingAssets,
  LISTING_ASSETS_USAGE,
  REPORT_FORMAT as LISTING_ASSETS_REPORT_FORMAT,
  type ListingAssetsOptions,
  type ListingAssetsReport,
  type ListingAssetsResult,
} from "./listingAssets.js";
export {
  ciClient,
  CiRequestError,
  normalizeBaseUrl,
  renderRefusal,
  type CiClient,
  type CiClientOptions,
} from "./ci.js";
export {
  authGithubOidc,
  canRequestGithubOidc,
  CI_TOKEN_ENV,
  exchangeGithubOidc,
  publishAudience,
  requestGithubOidcToken,
  resolveCiToken,
  type CiEnv,
} from "./oidc.js";
export {
  blobKey,
  buildDescriptor,
  descriptorManifestOf,
  hashFile,
  matchArtifacts,
  provenanceFrom,
  publishRelease,
  readMeta,
  scanDir,
  PUBLISH_USAGE,
  type PublishOptions,
  type PublishResult,
} from "./publish.js";
export { movePointer, yankRelease, CHANNEL_USAGE } from "./channels.js";
export {
  isPackageDeliverable,
  isPrePackageWorker,
  publishPackage,
  PREDATES_PACKAGES,
  type PackagePublishOptions,
  type PackagePublishResult,
} from "./package/publish.js";
export { extractPackage } from "./package/extract.js";
export {
  publishPack,
  STAGE_ROUND_OBJECTS,
  markerJson,
  markerPathFor,
  type PackPublishOptions,
  type PackPublishResult,
  type PackVariantReport,
} from "./packPublish.js";
export {
  declaredVariants,
  packContext,
  requirePacksDiscovery,
  variantDirName,
  type PacksDiscovery,
} from "./packManifest.js";
export {
  buildChunks,
  chunkContainer,
  chunkIndexBytes,
  chunkPayload,
  CHUNK_MIN_PAYLOAD_BYTES,
  CHUNK_PARAMS,
  containerSegments,
  fastcdc,
  frameContentSize,
  layoutChunks,
  priorLocations,
  writeChunkIndex,
  type BuiltChunks,
  type Chunk,
  type ChunkChainBase,
  type ChunkLayout,
  type ChunkOutcome,
  type PriorLocation,
} from "./packChunks.js";
export {
  CONTENT_STAMP_USAGE,
  contentFor,
  contentRuleProblems,
  embedsFor,
  markerPins,
  mergePins,
  parseHoldFlag,
  parsePinFlag,
  readContentStamp,
  readMarker,
  resolveHolds,
  resolvePins,
  stampText,
  writeContentStampFile,
  type ContentStampOptions,
  type SourcedPin,
} from "./contentStamp.js";
export {
  CONTENT_KEY_ENV,
  CONTENT_KEYS_USAGE,
  DEFAULT_DELEGATION_DAYS,
  DELEGATE_USAGE,
  MAX_DELEGATION_DAYS,
  WINDOW_WARN_DAYS,
  contentSigner,
  delegateContentKey,
  generateContentKey,
  generatedContentKeyText,
  listDelegations,
  localDelegatedChecks,
  parseDelegationTypes,
  requireDelegationsDiscovery,
  type ContentSigner,
  type DelegateOptions,
  type DelegateResult,
  type GeneratedContentKey,
  type ListedDelegation,
} from "./delegate.js";
export {
  REVOKE_DELEGATION_USAGE,
  REVOKE_USAGE,
  revokeDelegation,
  type RevokeDelegationOptions,
  type RevokeDelegationResult,
  checkReason,
  requireRevocationsDiscovery,
  revocationRecord,
  revokePackRelease,
  type RevokeOptions,
  type RevokeResult,
} from "./revoke.js";
export {
  checkPckHeader,
  PCK_STRIP_PATHS,
  PckError,
  readPck,
  stripPck,
  writePck,
  type PckDirectory,
  type PckEntry,
  type PckHeader,
} from "./pck.js";
export {
  embeddedCode,
  lintPck,
  lintTreePaths,
  PCK_MAX_ENTRIES,
  PCK_WARN_ENTRIES,
  remapTargets,
} from "./packLint.js";
export {
  RSCC_MAX_BLOCK,
  RSCC_MAX_TOTAL,
  RSCC_MIN_BLOCK,
  RSCC_MODE_ZSTD,
  RSCC_PACK_BUDGET,
  ZSTD_BLOCK_MAX,
  type RsccBudget,
  rsccBody,
  rsccBodyIsResource,
  zstdFrameOk,
} from "./rscc.js";
export {
  buildFilesDelta,
  buildPayload,
  buildPayloadDelta,
  cacheItems,
  containerPayload,
  filesRefOf,
  gapsOf,
  MIN_ZSTD_VERSION,
  noiseReport,
  payloadIdentity,
  readTree,
  selfCheckPayload,
  storeMany,
  zstdCli,
  type BuiltPayload,
  type Payload,
  type PayloadFile,
  type Zstd,
} from "./packArtifacts.js";
export {
  checkSignedRecord,
  fingerprintOf,
  generatedKeyText,
  generateReleaseKey,
  kidFor,
  KEYS_USAGE,
  publicKeyOfPem,
  recordSigner,
  RELEASE_KEY_ENV,
} from "./releaseKeys.js";
export {
  DISTRIBUTION_CI_USAGE,
  driveRollout,
  normalizeFingerprint,
  reportBody,
  reportDistribution,
  type ReportOptions,
  type RolloutOptions,
} from "./distribution.js";
export { MAX_SINGLE_PUT_BYTES, objectUrl, putFile, signV4 } from "./s3.js";
export { manifestSchemas, writeManifestSchemas } from "./schemas.js";
export {
  feedsSetup,
  FEEDS_SETUP_USAGE,
  type FeedsSetupOptions,
} from "./feedSetup.js";
export {
  buildFdroidFeed,
  buildFdroidIndex,
  buildRepoFiles,
  dictDiff,
  indexV2Problems,
  signEntryJar,
  sortedJson,
  FEEDS_USAGE,
  type FdroidFeedOptions,
  type FdroidFeedResult,
  type FdroidInputs,
} from "./feeds.js";
export {
  androidBuildMetadata,
  apkSignerSha256,
  buildMetadataFor,
  iosBuildMetadata,
  MetadataError,
} from "./buildMetadata.js";

export {
  MIGRATE_USAGE,
  formatMigrate,
  runMigrate,
  type MigrateOptions,
  type MigrateResult,
} from "./migrate.js";

export {
  ADMIN_TOKEN_ENV,
  BUNDLE_USAGE,
  DEFAULT_BASE_URL,
  MAX_GRACE_DAYS,
  bundleFileName,
  mintBundle,
  type MintBundleOptions,
  type MintBundleResult,
} from "./bundle.js";

export {
  contentLevel,
  loadTransportPack,
  loadTransportProduct,
  TRANSPORT_USAGE,
  type LoadedTransportPack,
  type TransportCommon,
  type TransportProduct,
  type TransportVariant,
} from "./transport.js";
export {
  ASC_API,
  AscUploadError,
  assetPackIdFor,
  baPackage,
  baUpload,
  DEFAULT_ASSET_PACK_LOCK,
  downloadPolicy,
  type AscUploadErrorCode,
  type BaPackageOptions,
  type BaPackageResult,
  type BaUploadOptions,
  type BaUploadResult,
} from "./transportAppleBa.js";
export {
  padDirectories,
  padModuleGradle,
  padModules,
  patchAppGradle,
  patchSettingsGradle,
  TCF_ALIASES,
  type PadDelivery,
  type PadModulesOptions,
  type PadModulesResult,
} from "./transportPlayPad.js";
export {
  appBuildVdf,
  depotBuildVdf,
  steamVdf,
  STEAM_PACK_DIR,
  type SteamVdfOptions,
  type SteamVdfResult,
} from "./transportSteam.js";
export {
  formatImport,
  listingImport,
  LISTING_USAGE,
  type ImportAnswer,
  type ListingImportOptions,
  type ListingImportResult,
} from "./listing.js";
export {
  parseGodotConfig,
  pngSize,
  readGodotListing,
  resolveResPath,
  type GodotConfig,
  type GodotIcon,
  type GodotListing,
  type GodotRead,
  type GodotValue,
} from "./godotProject.js";
export {
  findDistributionFile,
  initManifest,
  loadManifest,
  normalizeModules,
  outletIdsFor,
  validateLoadedManifest,
  type InitOptions,
  type InitResult,
  type LoadedManifest,
  type ProductModule,
  type ValidationMessage,
  type ValidationResult,
} from "./manifest.js";

export {
  COMMANDS,
  COMPLETION_SHELLS,
  completionScript,
  renderCommandHelp,
  renderHelp,
  type CompletionShell,
  type PkeyCommand,
} from "./help.js";
export {
  Spinner,
  termFor,
  type Term,
  type TermFlags,
  type TermOut,
} from "./terminal.js";
export type { StageProgress } from "./ci.js";
export {
  COMMAND_BREAK,
  escapeData,
  guardLine,
  guardOutput,
  underActions,
  untrusted,
  untrustedJson,
  untrustedLines,
  type UntrustedEnv,
} from "./untrusted.js";

export interface CliIo {
  cwd?: string;
  /** Where results go. `isTTY` and `columns` (Node's streams have them) decide colour and width. */
  stdout?: TermOut;
  /** Where errors, warnings and, on a terminal, the spinner go. */
  stderr?: TermOut;
  /** The environment the CI commands read (default `process.env`). */
  env?: CiEnv;
  /** The test seam for every network call the CI commands make. */
  fetchImpl?: typeof fetch;
  /** The back-off seam (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  /** The credential store behind login, whoami and logout (tests pass `memoryStore()`). */
  credentialStore?: () => Promise<CredentialStore>;
  /** The browser, clipboard, keys and clock behind `pkey login` (tests pass fakes). */
  login?: LoginSeams;
  /** The terminal's keyboard for `pkey init`'s questions (tests pass a TTY stdin and scripted keys). */
  prompt?: { stdin?: TerminalInput; keys?: InitKeys };
  /** The commands, PATH probe and temp dir behind `pkey feeds setup --write` (tests pass fakes). */
  feedWrite?: FeedWriteSeams;
}

interface ParsedArgs {
  command: string;
  /** Everything after a bare `--` (`pkey storefront exec … -- <argv>`), verbatim. */
  rest: string[];
  flags: Record<string, string | boolean>;
  /** Every string value of a repeatable flag (`--pin a@1 --pin b@2`), in order. */
  multi: Record<string, string[]>;
  /** Flags given without a value (`--dry-run`, or a `--pin` missing its value). */
  bare: Set<string>;
  positional: string[];
}

/** The flags every command takes, read before the command's own parse; none takes a value. */
interface GlobalFlags extends TermFlags {
  /** `--help` or `-h` anywhere before a bare `--`: print help and run nothing. */
  help: boolean;
}

/**
 * Take the global flags out of `argv` (UK-14): `--help`/`-h`, `--no-color`/`--color` and
 * `--ascii`. They never take a value, so they cannot swallow the next word, and a command never
 * sees them; everything after a bare `--` (`pkey storefront exec … -- <argv>`) is left alone.
 */
function globalFlags(argv: readonly string[]): {
  argv: string[];
  flags: GlobalFlags;
} {
  const rest: string[] = [];
  const flags: GlobalFlags = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--help" || arg === "-h" || arg.startsWith("--help="))
      flags.help = true;
    else if (arg === "--no-color") flags.color = false;
    else if (arg === "--color") flags.color = true;
    else if (arg === "--ascii") flags.ascii = true;
    else rest.push(arg);
  }
  return { argv: rest, flags };
}

export async function runPkey(argv: string[], io: CliIo = {}): Promise<number> {
  const env = io.env ?? (process.env as CiEnv);
  // Inside GitHub Actions both streams run behind the output guard (`untrusted.ts`): no line the
  // server's words reach can read as a workflow command, whichever command printed it.
  const stdout = guardOutput(io.stdout ?? process.stdout, env);
  const stderr = guardOutput(io.stderr ?? process.stderr, env);
  try {
    return await runCommand(argv, {
      ...io,
      env,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
  } finally {
    stdout.flush();
    stderr.flush();
  }
}

async function runCommand(
  argv: string[],
  io: CliIo & { env: CiEnv; stdout: TermOut; stderr: TermOut },
): Promise<number> {
  // `pkey --version` (also -V, -v) is the first word only: `release publish --version v` is a flag.
  if (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "-v") {
    io.stdout.write(`pkey ${CLI_VERSION}\n`);
    return 0;
  }
  const global = globalFlags(argv);
  const parsed = parseArgs(global.argv);
  const cwd = io.cwd ?? process.cwd();
  const { stdout, stderr } = io;
  const ci = {
    env: io.env,
    fetchImpl: io.fetchImpl,
    sleep: io.sleep,
  };
  const g: TermFlags = { color: global.flags.color, ascii: global.flags.ascii };
  const term = (out: TermOut): Term => termFor(out, ci.env, g);

  // Help runs nothing: `pkey`, `pkey help [command]`, and `--help`/`-h` on any command.
  if (global.flags.help || parsed.command === "help") {
    const words =
      parsed.command === "help"
        ? parsed.positional
        : [parsed.command, ...parsed.positional];
    const here = await resolveContext({ cwd, env: ci.env });
    return cmdHelp(words, stdout, stderr, term, {
      product: here.product,
      baseUrl: here.baseUrl.url,
    });
  }

  try {
    // The registry (`help.ts`) is the one list of commands: a word it does not name is unknown,
    // whatever the handlers table holds.
    const cmd = findCommand(parsed.command);
    const handler = cmd ? HANDLERS[cmd.name] : undefined;
    if (!cmd && parsed.command.startsWith("-")) {
      stderr.write(unknownOption(parsed.command, term(stderr)));
      return 2;
    }
    if (!cmd || !handler) {
      stderr.write(unknownCommand(parsed.command, term(stderr)));
      return 2;
    }
    const sub = parsed.positional[0];
    if (
      cmd.tree &&
      cmd.name !== "completion" &&
      sub !== undefined &&
      !(sub in cmd.tree)
    ) {
      stderr.write(
        unknownCommand(`${cmd.name} ${sub}`, term(stderr), cmd.name),
      );
      return 2;
    }
    await applyContext(cmd.context, parsed.flags, { cwd, env: ci.env });
    return await handler(parsed, {
      cwd,
      stdout,
      stderr,
      ci,
      g,
      term,
      store: io.credentialStore ?? defaultStore,
      login: io.login,
      stdin: io.prompt?.stdin,
      keys: io.prompt?.keys,
      feedWrite: io.feedWrite,
    });
  } catch (err) {
    // An error's message may quote the server (a refusal, a URL it answered, a field it sent):
    // cleaned per line, so it draws no escape and no line of it reads as a workflow command.
    // A bug's exception prints one line and no stack (PKEY_DEBUG=1 adds it); a failed request
    // says what to check; a message that carries `Usage:` lines is a usage error (exit 2).
    if (err instanceof ManifestSyntaxError) {
      stderr.write(failLine(untrustedLines(err.message, ci.env), term(stderr)));
      return 1;
    }
    const message = isInternalError(err)
      ? internalMessage(err)
      : networkMessage(err);
    stderr.write(`${untrustedLines(message, ci.env)}\n`);
    if (ci.env.PKEY_DEBUG && err instanceof Error && err.stack)
      stderr.write(`${untrustedLines(err.stack, ci.env)}\n`);
    return err instanceof UsageError || isUsageError(message) ? 2 : 1;
  }
}

/** What a command handler gets besides its parsed arguments. */
interface Runtime {
  cwd: string;
  /** Keys for the prompts (`pkey init`); default is the terminal. */
  stdin?: TerminalInput;
  /** A scripted key reader (tests). */
  keys?: InitKeys;
  stdout: TermOut;
  stderr: TermOut;
  ci: CiIo & { env: CiEnv };
  g: TermFlags;
  term: (out: TermOut) => Term;
  store: () => Promise<CredentialStore>;
  login?: LoginSeams;
  feedWrite?: FeedWriteSeams;
}

type Handler = (parsed: ParsedArgs, rt: Runtime) => number | Promise<number>;

/**
 * Each registered command's handler, by name. `help` is answered before dispatch. A test holds
 * this table's keys to the registry's names (`COMMANDS` less `help`) so a command cannot be
 * listed without running, or run without being listed.
 */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  login: (p, rt) =>
    cmdLogin({
      ...accountIo(p, rt),
      noBrowser: flagBool(p, "no-browser"),
      flags: rt.g,
      seams: { sleep: rt.ci.sleep, ...rt.login },
    }),
  whoami: (p, rt) => cmdWhoami(accountIo(p, rt)),
  logout: (p, rt) => cmdLogout(accountIo(p, rt)),
  init: (p, rt) => cmdInit(p, rt),
  validate: (p, rt) =>
    cmdValidate(p, rt.cwd, rt.stdout, rt.stderr, rt.term(rt.stdout)),
  completion: (p, rt) => cmdCompletion(p, rt.stdout, rt.stderr),
  distribution: (p, rt) =>
    cmdDistribution(p, rt.cwd, rt.stdout, rt.stderr, rt.ci),
  doctor: (p, rt) =>
    guarded(accountIo(p, rt), "doctor", () =>
      cmdDoctor(
        p,
        rt.cwd,
        rt.stdout,
        rt.stderr,
        rt.term(rt.stdout),
        rt.ci,
        adminIo(p, rt),
      ),
    ),
  bundle: (p, rt) =>
    withAdminCredential(adminIo(p, rt), "bundle", (token) =>
      cmdBundle(
        p,
        rt.cwd,
        rt.stdout,
        rt.term(rt.stdout),
        rt.ci.env,
        token,
        rt.ci.fetchImpl,
      ),
    ),
  migrate: (p, rt) =>
    withAdminCredential(adminIo(p, rt), "migrate", (token) =>
      cmdMigrate(p, rt.stdout, rt.ci.env, token, rt.ci.fetchImpl),
    ),
  trust: (p, rt) => cmdTrust(p, rt.stdout),
  sdk: (p, rt) => cmdSdk(p, rt.cwd, rt.stdout, rt.stderr, rt.ci.fetchImpl),
  dev: (p, rt) => cmdDev(p, rt),
  mirror: (p, rt) => cmdMirror(p, rt.cwd, rt.stdout, rt.ci.fetchImpl),
  auth: (p, rt) => cmdAuth(p, rt.stdout, rt.stderr, rt.ci),
  ci: (p, rt) =>
    p.positional[0] === "init"
      ? ciInit(...channelParts(p, rt))
      : Promise.reject(new UsageError(CI_INIT_USAGE)),
  release: (p, rt) => cmdRelease(p, rt.cwd, rt.stdout, rt.stderr, rt.ci, rt.g),
  manifest: (p, rt) => cmdManifest(p, rt.cwd, rt.stdout),
  feeds: (p, rt) => cmdFeeds(p, rt.cwd, rt.stdout, rt.stderr, rt.ci, rt),
  listing: (p, rt) =>
    cmdListing(p, rt.cwd, rt.stdout, rt.stderr, rt.ci, rt.g, adminIo(p, rt)),
  assets: (p, rt) => cmdAssets(p, rt.cwd, rt.stdout, rt.stderr, rt.ci),
  transport: (p, rt) => cmdTransport(p, rt.cwd, rt.stdout, rt.stderr, rt.ci),
  storefront: (p, rt) =>
    cmdStorefront(
      { positional: p.positional, flags: p.flags, rest: p.rest },
      { cwd: rt.cwd, stdout: rt.stdout, stderr: rt.stderr, ...rt.ci },
    ),
  channel: (p, rt) => cmdChannel(...channelParts(p, rt)),
};

/** What `channel` and `ci` handlers take: the parsed words and the streams. */
function channelParts(p: ParsedArgs, rt: Runtime): [ChannelArgs, ChannelIo] {
  return [
    { positional: p.positional, flags: p.flags, multi: p.multi },
    {
      cwd: rt.cwd,
      stdout: rt.stdout,
      stderr: rt.stderr,
      term: rt.term,
      ...rt.ci,
    },
  ];
}

/** The OS credential store, opened on first use and only by the account commands. */
let osStore: Promise<CredentialStore> | undefined;
const defaultStore = (): Promise<CredentialStore> =>
  (osStore ??= keyringStore());

function accountIo(parsed: ParsedArgs, rt: Runtime): AccountIo {
  return {
    baseUrl: flagString(parsed, "base-url") ?? DEFAULT_BASE_URL,
    baseUrlGiven: flagString(parsed, "base-url") !== undefined,
    json: flagBool(parsed, "json"),
    env: rt.ci.env,
    stdout: rt.stdout,
    stderr: rt.stderr,
    term: rt.term,
    store: rt.store,
    fetchImpl: rt.ci.fetchImpl,
  };
}

function adminIo(parsed: ParsedArgs, rt: Runtime): AdminIo {
  return {
    baseUrl: flagString(parsed, "base-url") ?? DEFAULT_BASE_URL,
    env: rt.ci.env,
    stderr: rt.stderr,
    term: rt.term,
    store: rt.store,
    fetchImpl: rt.ci.fetchImpl,
    json: flagBool(parsed, "json"),
    stdout: rt.stdout,
  };
}

/**
 * `✗  Unknown command "bogus". Run pkey help to see every command.` and nothing else: the hundred
 * lines of help would push the error out of view.
 */
function unknownCommand(name: string, term: Term, parent?: string): string {
  const sub = parent ? name.slice(parent.length + 1) : name;
  // F-37.4: the F-Droid build moved, with no alias. Exit 2, nothing runs.
  if (parent === "feeds" && sub === "fdroid")
    return failLine(
      "pkey feeds fdroid moved. Run pkey storefront fdroid.",
      term,
    );
  const near = nearest(
    sub,
    parent
      ? Object.keys(findCommand(parent)?.tree ?? {})
      : COMMANDS.map((c) => c.name),
  );
  const hint = near
    ? ` Did you mean ${parent ? `${parent} ${near}` : near}?`
    : "";
  return failLine(
    parent
      ? `Unknown ${parent} command "${sub}".${hint} Run pkey help ${parent} to see its commands.`
      : `Unknown command "${name}".${hint} Run pkey help to see every command.`,
    term,
  );
}

/** `✗  Unknown option --bogus. Run pkey help to see the options.` for a flag where a command goes. */
function unknownOption(flag: string, term: Term): string {
  return failLine(
    `Unknown option ${flag.split("=")[0]}. Run pkey help to see the options.`,
    term,
  );
}

/**
 * `pkey help [command [subcommand]]`, or `--help`/`-h` on any command: the grouped overview, or
 * one command's usage lines and notes. Exit 0; an unknown command is a usage error (2).
 */
function cmdHelp(
  words: readonly string[],
  stdout: TermOut,
  stderr: TermOut,
  term: (out: TermOut) => Term,
  here: HelpHere,
): number {
  const [name, sub] = words;
  if (name === undefined) {
    stdout.write(renderHelp(term(stdout), here));
    return 0;
  }
  const cmd = findCommand(name);
  if (!cmd) {
    stderr.write(unknownCommand(name, term(stderr)));
    return 2;
  }
  stdout.write(renderCommandHelp(term(stdout), cmd, sub));
  return 0;
}

const COMPLETION_USAGE = `Usage: pkey completion ${COMPLETION_SHELLS.join("|")}`;

/** `pkey completion bash|zsh|fish`: the script, generated from the command table (`help.ts`). */
function cmdCompletion(
  parsed: ParsedArgs,
  stdout: TermOut,
  stderr: TermOut,
): number {
  const shell = parsed.positional[0];
  if (
    parsed.positional.length !== 1 ||
    !COMPLETION_SHELLS.includes(shell as CompletionShell)
  ) {
    stderr.write(`${COMPLETION_USAGE}\n`);
    return 2;
  }
  stdout.write(completionScript(shell as CompletionShell));
  return 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  const bare = new Set<string>();
  const positional: string[] = [];
  const add = (key: string, value: string) => {
    flags[key] = value;
    (multi[key] ??= []).push(value);
  };
  let after: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--") {
      after = rest.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2) as [
      string,
      string?,
    ];
    if (inlineValue !== undefined) {
      add(rawKey, inlineValue);
      continue;
    }
    const next = rest[i + 1];
    if (next && !next.startsWith("--") && !VALUELESS_FLAGS.has(rawKey)) {
      add(rawKey, next);
      i += 1;
    } else {
      flags[rawKey] = true;
      bare.add(rawKey);
    }
  }
  return { command, flags, multi, bare, positional, rest: after };
}

async function cmdInit(parsed: ParsedArgs, rt: Runtime): Promise<number> {
  const { cwd, stdout } = rt;
  const basename =
    path
      .basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "my-product";
  const slug =
    flagString(parsed, "product") ?? flagString(parsed, "slug") ?? basename;
  const name = flagString(parsed, "name") ?? titleize(slug);
  const modulesFlag = flagString(parsed, "modules");
  let modules: ProductModule[] = normalizeModules(modulesFlag);
  const tierFlag = flagString(parsed, "starter-tier");
  if (tierFlag !== undefined && tierFlag !== "free" && tierFlag !== "none")
    throw new UsageError("--starter-tier takes free or none.");
  let starterTier: "free" | "none" | undefined = tierFlag;
  // On a terminal, ask for what the flags did not give (ST-46.3); anywhere else, none of this runs.
  const stdin = initInput(rt.stdin);
  const term = termFor(stdout, rt.ci.env, rt.g, stdin);
  if (mayPrompt(term, stdin)) {
    // Refuse before asking anything when the files are there (the write would refuse anyway).
    const clash = async (rels: string[]) => {
      if (flagBool(parsed, "force")) return;
      for (const rel of rels)
        if (
          await stat(path.join(cwd, rel)).then(
            () => true,
            () => false,
          )
        )
          throw new Error(`${rel} already exists. Pass --force to overwrite.`);
    };
    await clash([".pkey/product.yaml", ".pkey/schema.yaml"]);
    const asked = await askInit({
      name,
      term,
      stdout,
      stdin,
      keys: rt.keys,
      givenServices: modulesFlag ? modules : undefined,
      tierGiven: tierFlag !== undefined,
    });
    if (typeof asked === "number") return asked;
    if (asked.modules) modules = asked.modules;
    if (modules.includes("release")) await clash([".pkey/release.yaml"]);
    if (asked.starterTier) starterTier = asked.starterTier;
  }
  const result = await initManifest({
    cwd,
    slug,
    name,
    modules,
    starterTier,
    releaseOwner: flagString(parsed, "release-owner"),
    releaseRepo: flagString(parsed, "release-repo"),
    force: flagBool(parsed, "force"),
  });
  stdout.write(
    `Created ${result.files.length} manifest file${result.files.length === 1 ? "" : "s"}:\n`,
  );
  for (const file of result.files)
    stdout.write(`- ${path.relative(cwd, file)}\n`);
  stdout.write("\nNext: pkey validate\n");
  return 0;
}

const VALIDATE_USAGE = "Usage: pkey validate [path] [--fix] [--json]";

/**
 * `pkey validate [path] [--json]`: the `.pkey/` under `path` (relative to the current directory;
 * default the current directory), through the validator repo-link and resync apply. Exit 0 when
 * valid, 1 when not.
 */
async function cmdValidate(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  stderr: TermOut,
  term: Term,
): Promise<number> {
  const bad = checkFlags(parsed, "validate", ["fix", "json"], term);
  if (bad) {
    stderr.write(bad);
    return 2;
  }
  if (parsed.positional.length > 1) throw new Error(VALIDATE_USAGE);
  const target = parsed.positional[0];
  const dir = target === undefined ? cwd : path.resolve(cwd, target);
  const json = flagBool(parsed, "json");
  // `--fix` repairs what it safely can, then validates what is left (`fix.ts`).
  let fixed: FixMove[] | undefined;
  if (flagBool(parsed, "fix")) {
    fixed = await fixManifest(await loadManifest(dir), cwd);
    if (!json) writeFixed(fixed, stdout, term);
  }
  if (json) return validateJson(dir, cwd, stdout, fixed);
  return validateText(dir, cwd, stdout, term);
}

/** What `--fix` moved, one ✓ line each, or the one line saying there was nothing to repair. */
function writeFixed(moves: FixMove[], stdout: TermOut, term: Term): void {
  const { painter, symbols } = term;
  if (!moves.length) {
    stdout.write(`Nothing to fix.\n\n`);
    return;
  }
  for (const m of moves)
    stdout.write(
      `${painter.style(symbols.ok, ["success"])}  ${
        m.to === "(dropped)"
          ? `Dropped ${m.from}`
          : `Moved ${m.from} to ${m.to}`
      } (${m.file})\n`,
    );
  stdout.write("\n");
}

/**
 * The verdict, the services and the required secrets, then every warning (▲) and error (✗) with
 * where it points. On a terminal the roles are coloured and long messages wrap under their own
 * column; anywhere else each message is one plain line, as a log or a grep wants it.
 */
async function validateText(
  dir: string,
  cwd: string,
  stdout: TermOut,
  term: Term,
): Promise<number> {
  const manifest = await loadManifest(dir);
  const result = validateLoadedManifest(manifest);
  writeRows(validateRows(manifest, result, cwd, term), stdout, term);
  return result.ok ? 0 : 1;
}

/** One line of a report: a mark (a glyph, or a blank) and the spans that wrap beside it. */
interface Row {
  mark: string;
  spans: Line;
}

/** Print rows: on a terminal each wraps under its own column, elsewhere each is one plain line. */
function writeRows(rows: readonly Row[], stdout: TermOut, term: Term): void {
  const { painter, symbols, caps } = term;
  const gap = " ".repeat(2);
  for (const row of rows) {
    const lines = caps.tty
      ? wrapSpans(row.spans, Math.max(1, caps.columns - 3), symbols.ellipsis)
      : [row.spans];
    lines.forEach((l, i) =>
      stdout.write(`${i === 0 ? row.mark : " "}${gap}${painter.line(l)}\n`),
    );
  }
}

/** The verdict, the features and the required secrets, then every warning (▲) and error (✗). */
function validateRows(
  manifest: LoadedManifest,
  result: ValidationResult,
  cwd: string,
  term: Term,
): Row[] {
  const { painter, symbols } = term;
  const rows: Row[] = [];
  const mark = (glyph: string, role: string) => painter.style(glyph, [role]);
  rows.push({
    mark: result.ok
      ? mark(symbols.ok, "success")
      : mark(symbols.fail, "danger"),
    spans: [
      {
        text: `Manifest: ${result.ok ? "valid" : "invalid"}`,
        style: ["strong"],
      },
    ],
  });
  rows.push({
    mark: " ",
    spans: [
      { text: "Features: ", style: ["muted"] },
      {
        text: result.enabledModules.length
          ? result.enabledModules.join(", ")
          : "none",
      },
    ],
  });
  if (result.requiredSecrets.length)
    rows.push({
      mark: " ",
      spans: [
        { text: "Required secrets: ", style: ["muted"] },
        { text: result.requiredSecrets.join(", ") },
      ],
    });
  const message = (kind: "warning" | "error", at: Line, text: string): Row => {
    const role = kind === "warning" ? "warning" : "danger";
    return {
      mark: mark(kind === "warning" ? symbols.warn : symbols.fail, role),
      spans: [
        { text: `${kind} `, style: [role] },
        ...at,
        { text: `: ${text}` },
      ],
    };
  };
  for (const warning of manifest.fileWarnings ?? [])
    rows.push(message("warning", [{ text: ".pkey/" }], warning));
  for (const warning of result.warnings)
    rows.push(
      message("warning", pointerSpans(manifest, cwd, warning), warning.message),
    );
  for (const error of result.errors)
    rows.push(
      message("error", pointerSpans(manifest, cwd, error), error.message),
    );
  return rows;
}

/**
 * `pkey validate --json`: one JSON line on stdout in the terminal kits' flattened envelope (the
 * Python kit's, which the Node kit and pkey follow): `v`, `command`, `event`, `ok` and `exit`,
 * then the verdict's own fields beside them,
 * `{"v":1,"command":"validate","event":"result","ok","exit","valid","modules","requiredSecrets",
 * "warnings","errors"}`, or `"error":"no-manifest"` (none found) or `"unreadable-manifest"` (a
 * file that is not valid JSON or YAML) and a `"message"` when no manifest could be read (exit 1). ASCII only.
 */
async function validateJson(
  dir: string,
  cwd: string,
  stdout: TermOut,
  fixed?: FixMove[],
): Promise<number> {
  const envelope = (exit: number, rest: Record<string, unknown>) =>
    `${JSON.stringify({ v: 1, command: "validate", event: "result", ok: exit === 0, exit, ...rest }).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
  let manifest: LoadedManifest;
  try {
    manifest = await loadManifest(dir);
  } catch (e) {
    stdout.write(
      envelope(1, {
        error: /not valid (?:JSON|YAML)/.test((e as Error).message)
          ? "unreadable-manifest"
          : "no-manifest",
        message: (e as Error).message,
      }),
    );
    return 1;
  }
  const result = validateLoadedManifest(manifest);
  const entry = (m: ValidationMessage) => {
    const file = fileOf(manifest, m);
    return {
      code: m.code,
      message: m.message,
      at: `${m.file}${m.path}`,
      file: file ? path.relative(cwd, file) : null,
    };
  };
  const exitCode = result.ok ? 0 : 1;
  stdout.write(
    envelope(exitCode, {
      ...(fixed ? { fixed } : {}),
      valid: result.ok,
      modules: result.enabledModules,
      requiredSecrets: result.requiredSecrets,
      warnings: [
        // The CLI's own duplicate-file warning has no validator code.
        ...(manifest.fileWarnings ?? []).map((message) => ({
          code: null,
          message,
          at: ".pkey/",
          file: null,
        })),
        ...result.warnings.map(entry),
      ],
      errors: result.errors.map(entry),
    }),
  );
  return exitCode;
}

/** The file a validation message's document was read from, when there is one. */
function fileOf(
  manifest: LoadedManifest,
  msg: ValidationMessage,
): string | undefined {
  return {
    product: manifest.productPath,
    schema: manifest.schemaPath,
    release: manifest.releasePath,
    distribution: manifest.distributionPath,
  }[msg.file];
}

/**
 * Where a validation message points: `<document><pointer>`, followed by the file it was read
 * from when there is one (`distribution/outlets/web (.pkey/distribution.yaml)`), so an author
 * with several spellings on disk sees which file the validator actually read.
 */
function located(
  manifest: LoadedManifest,
  cwd: string,
  msg: ValidationMessage,
): string {
  return pointerSpans(manifest, cwd, msg)
    .map((s) => s.text)
    .join("");
}

/** `located` as spans: the pointer, then the file in the muted role. */
function pointerSpans(
  manifest: LoadedManifest,
  cwd: string,
  msg: ValidationMessage,
): Line {
  const file = fileOf(manifest, msg);
  return [
    { text: `${msg.file}${msg.path}` },
    ...(file
      ? [{ text: ` (${path.relative(cwd, file)})`, style: ["muted"] }]
      : []),
  ];
}

const DISTRIBUTION_USAGE = `Usage: pkey distribution outlet-ids --outlet <id>\n${DISTRIBUTION_CI_USAGE}`;

/**
 * `pkey distribution outlet-ids --outlet <id>` (P2b-02): print the build outlet's `outletIds`
 * as one compact JSON object on stdout — keys sorted, every value a string — for CI to pass to a
 * Godot export as `PKEY_OUTLET_IDS` (P1-11 cannot read YAML, nor `.pkey/` outside its project).
 *
 * The absent-file check runs FIRST: with no `.pkey/distribution` the answer is `{}` and exit 0
 * for any `--outlet` (there are no ids to stamp). With a file, the manifest must validate and
 * must declare the outlet; anything else is a non-zero exit with the reason on stderr.
 */
async function cmdDistribution(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
): Promise<number> {
  const sub = parsed.positional[0];
  if (sub === "report" || ROLLOUT_COMMANDS.includes(sub as RolloutCommand))
    return cmdDistributionCi(parsed, stdout, stderr, ci);
  if (sub !== "outlet-ids") throw new Error(DISTRIBUTION_USAGE);
  const outlet = flagString(parsed, "outlet");
  if (!outlet) throw new Error(DISTRIBUTION_USAGE);

  if (!(await findDistributionFile(cwd))) {
    stdout.write("{}\n");
    return 0;
  }
  const manifest = await loadManifest(cwd);
  const result = validateLoadedManifest(manifest);
  if (!result.ok) {
    for (const error of result.errors)
      stderr.write(
        `error ${located(manifest, cwd, error)}: ${error.message}\n`,
      );
    return 1;
  }
  const ids = outletIdsFor(manifest, outlet);
  if (!ids) {
    stderr.write(
      `outlet ${JSON.stringify(outlet)} is not declared in ${path.relative(cwd, manifest.distributionPath!)}\n`,
    );
    return 1;
  }
  stdout.write(`${JSON.stringify(ids)}\n`);
  return 0;
}

/**
 * `pkey distribution report availability|submission|key` and `pkey distribution
 * rollout|pause|resume|halt|complete` (P2b-03, `distribution.ts`): CI reports and outlet rollout
 * controls on the CI token plumbing. A key report the inventory does not hold exits 1.
 */
async function cmdDistributionCi(
  parsed: ParsedArgs,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
): Promise<number> {
  const [sub, type] = parsed.positional;
  const product = flagString(parsed, "product");
  if (!product) throw new Error(DISTRIBUTION_CI_USAGE);
  const common = {
    product,
    baseUrl: flagString(parsed, "base-url"),
    env: ci.env,
    stdout,
    stderr,
    fetchImpl: ci.fetchImpl,
    sleep: ci.sleep,
  };
  if (sub === "report") {
    if (type !== "availability" && type !== "submission" && type !== "key")
      throw new Error(DISTRIBUTION_CI_USAGE);
    const result = await reportDistribution({
      ...common,
      type: type as ReportType,
      outlet: flagString(parsed, "outlet"),
      releaseId: flagString(parsed, "release"),
      version: flagString(parsed, "version"),
      deliverable: flagString(parsed, "deliverable"),
      buildId: flagString(parsed, "build"),
      state: flagString(parsed, "state"),
      since: flagString(parsed, "since"),
      platformRef: flagString(parsed, "platform-ref"),
      detail: flagString(parsed, "detail"),
      purpose: flagString(parsed, "purpose"),
      sha256: flagString(parsed, "sha256"),
    });
    return result.ok ? 0 : 1;
  }
  const outlet = flagString(parsed, "outlet");
  const channel = flagString(parsed, "channel");
  if (!outlet || !channel) throw new Error(DISTRIBUTION_CI_USAGE);
  await driveRollout({
    ...common,
    command: sub as RolloutCommand,
    outlet,
    channel,
    releaseId: flagString(parsed, "release"),
    deliverable: flagString(parsed, "deliverable"),
    bp: flagString(parsed, "bp"),
  });
  return 0;
}

/**
 * `pkey doctor [--product slug] [--base-url url] [--json]`: validate `.pkey/`, then, when a
 * product is known (the flag, else the nearest `.pkey/product`), check its live discovery at the
 * base URL (the flag, else `PKEY_BASE_URL`, else production), who is signed in and the product's
 * Integration. Every step runs whatever the one before found, and the text and `--json` are drawn
 * from one report (`doctor.ts`): the summary and the exit code are the same count.
 */
async function cmdDoctor(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  stderr: TermOut,
  term: Term,
  ci: CiIo & { env: CiEnv },
  admin: AdminIo,
): Promise<number> {
  const bad = checkFlags(
    parsed,
    "doctor",
    ["product", "base-url", "json"],
    term,
  );
  if (bad) {
    stderr.write(bad);
    return 2;
  }
  const started = performance.now();
  const ctx = await resolveContext({
    cwd,
    env: ci.env,
    product: flagString(parsed, "product"),
    baseUrl: flagString(parsed, "base-url"),
  });
  // An address that is not https (http works on localhost) is a ▲ usage line, not a report.
  originFor({ baseUrl: ctx.baseUrl.url }, "doctor");
  // One deadline for discovery, /me and the Integration view.
  const signal = AbortSignal.timeout(DOCTOR_TIMEOUT_MS);
  const io: AdminIo = { ...admin, baseUrl: ctx.baseUrl.url, signal };

  let manifest: ManifestInput;
  try {
    const loaded = await loadManifest(cwd);
    manifest = {
      state: "read",
      result: validateLoadedManifest(loaded),
      fileWarnings: loaded.fileWarnings ?? [],
    };
  } catch (e) {
    manifest = { state: "missing", problem: (e as Error).message };
  }
  const remote = ctx.product
    ? await checkRemote({
        baseUrl: ctx.baseUrl.url,
        product: ctx.product.slug,
        fetchImpl: ci.fetchImpl,
        signal,
      })
    : null;
  const session = await gatherSession({
    io,
    slug: ctx.product?.slug ?? null,
    signal,
  });
  const reached = remote?.facts[0]?.state === "ok";
  const config = await checkConfigFiles({
    cwd,
    host: hostOf(ctx.baseUrl.url),
    exposed: reached ? remote!.pinned : null,
  });
  const report = buildReport({
    product: ctx.product,
    baseUrl: ctx.baseUrl.url,
    manifest,
    remote,
    session,
    config,
    env: ci.env,
  });
  if (flagBool(parsed, "json")) {
    stdout.write(
      envelope("doctor", report.exit, {
        product: ctx.product?.slug ?? null,
        baseUrl: maskTokens(ctx.baseUrl.url),
        ...reportJson(report),
        services: remote?.services ?? [],
        signing: remote?.signing ?? null,
        keys: remote?.keys ?? [],
        ...sessionJson(session),
      }),
    );
    return report.exit;
  }
  stdout.write(renderReport(report, term, performance.now() - started));
  return report.exit;
}

/**
 * Refuse what a command does not take: an option it does not know (`--prodcut`, with the nearest
 * it does know) and an option that needs a value and got none. `null` when all is well.
 */
function checkFlags(
  parsed: ParsedArgs,
  command: string,
  known: readonly string[],
  term: Term,
): string | null {
  const unknown = Object.keys(parsed.flags).find((k) => !known.includes(k));
  if (unknown !== undefined) {
    const near = nearest(unknown, known);
    return failLine(
      `Unknown option --${unknown}.${near ? ` Did you mean --${near}?` : ` Run pkey help ${command} to see the options.`}`,
      term,
    );
  }
  const valueless = new Set(
    findCommand(command)?.valueless ?? ([] as readonly string[]),
  );
  const missing = known.find((k) => parsed.bare.has(k) && !valueless.has(k));
  if (missing !== undefined)
    return failLine(`Option --${missing} needs a value.`, term);
  return null;
}

/**
 * `pkey bundle` — mint one offline activation bundle. A thin shell over `mintBundle`: it reads
 * the flags, reads the admin API token out of the environment (the module itself never touches
 * `process.env`, so it stays testable), and prints what came back.
 */
async function cmdBundle(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  term: Term,
  env: UntrustedEnv,
  token: TokenSource,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const product = flagString(parsed, "product");
  const device = flagString(parsed, "device");
  const graceRaw = flagString(parsed, "grace-days");
  if (!product || !device || !graceRaw) throw new Error(BUNDLE_USAGE);

  const result = await mintBundle({
    cwd,
    product,
    deviceId: device,
    graceDays: Number(graceRaw),
    // `--no-config` is a boolean flag, so it is read with flagBool.
    includeConfig: !flagBool(parsed, "no-config"),
    licenseId: flagString(parsed, "license"),
    baseUrl: flagString(parsed, "base-url"),
    out: flagString(parsed, "out"),
    force: flagBool(parsed, "force"),
    token,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const rel = path.relative(cwd, result.file);
  if (flagBool(parsed, "json")) {
    stdout.write(
      envelope("bundle", 0, {
        bundleId: untrusted(result.bundleId, env),
        file: result.file,
        deviceId: result.deviceId,
        graceDays: result.graceDays,
        documents: result.documents,
      }),
    );
    return 0;
  }
  // Which documents rode along is read from the bundle itself; if it cannot be read, say nothing.
  const carries = result.documents.length
    ? `${result.documents.join(" and ")}, `
    : "";
  stdout.write(
    block(term, "ok", [
      [
        text("Wrote "),
        text(rel, { break: "url" }),
        text(
          ` (${carries}${result.graceDays} day${result.graceDays === 1 ? "" : "s"} offline)`,
        ),
      ],
      [text("Bundle "), text(untrusted(result.bundleId, env), { unit: true })],
      [text("Take it to the offline device and import it there.")],
    ]),
  );
  return 0;
}

/**
 * `pkey migrate list | dry-run <job> | report <run>` — the data-migration runner's read side,
 * through an admin API token scoped `migrations:report` (`migrate.ts`). Apply and down stay in the
 * console: they need a step-up a token cannot have.
 */
async function cmdMigrate(
  parsed: ParsedArgs,
  stdout: Pick<NodeJS.WriteStream, "write">,
  env: UntrustedEnv,
  token: TokenSource,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const [verb, target, ...extra] = parsed.positional;
  if (
    (verb !== "list" && verb !== "dry-run" && verb !== "report") ||
    extra.length > 0 ||
    (verb === "list" && target !== undefined)
  )
    throw new Error(MIGRATE_USAGE);
  const result = await runMigrate({
    verb,
    target,
    baseUrl: flagString(parsed, "base-url"),
    token,
    fetchImpl,
  });
  stdout.write(
    flagBool(parsed, "json")
      ? envelope("migrate", 0, { ...result })
      : formatMigrate(result, env),
  );
  return 0;
}

function cmdTrust(
  parsed: ParsedArgs,
  stdout: Pick<NodeJS.WriteStream, "write">,
): number {
  const kid = flagString(parsed, "kid") ?? parsed.positional[0];
  const publicKey = flagString(parsed, "public-key") ?? parsed.positional[1];
  if (!kid || !publicKey)
    throw new Error("Usage: pkey trust --kid <kid> --public-key <base64url>");
  // An Ed25519 public key is 32 bytes: 43 base64url characters. Anything else would print a
  // config no SDK could verify with, so say so here, not at the first failed verification.
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey))
    throw new UsageError(
      `--public-key must be an Ed25519 public key: 43 base64url characters (A-Z a-z 0-9 - _); got ${publicKey.length}. ` +
        "Copy it from the console's Keys & secrets page.",
    );
  // The pin as every SDK's config module holds it: the same renderer `pkey sdk` writes with.
  for (const lang of SDK_LANGS) {
    const setup = renderSdkSetup(lang, {
      slug: "<slug>",
      pins: [{ kid, publicKey }],
      services: [],
    });
    stdout.write(
      `--- ${lang}: ${setup.config.filename}\n${setup.config.code}\n`,
    );
  }
  return 0;
}

/** `pkey dev` and `pkey dev <command>` (`devCommand.ts`). */
async function cmdDev(parsed: ParsedArgs, rt: Runtime): Promise<number> {
  const port = flagString(parsed, "port");
  if (port !== undefined && !/^\d{1,5}$/.test(port))
    throw new UsageError(`--port must be a number; got ${port}.`);
  const [sub, ...positional] = parsed.positional;
  const args: DevArgs = {
    sub,
    positional,
    port: port === undefined ? DEV_DEFAULT_PORT : Number(port),
    url: flagString(parsed, "url"),
    autoApprove: flagBool(parsed, "auto-approve"),
    builtin: flagBool(parsed, "builtin"),
    out: flagBool(parsed, "no-write")
      ? null
      : (flagString(parsed, "out") ?? DEV_CONFIG_FILE),
    channel: flagString(parsed, "channel"),
    key: flagString(parsed, "key"),
    json: flagBool(parsed, "json"),
  };
  const io = {
    cwd: rt.cwd,
    stdout: rt.stdout,
    stderr: rt.stderr,
    fetchImpl: rt.ci.fetchImpl,
  };
  if (sub !== undefined) return controlDev(args, io);
  let stopNow!: () => void;
  const stop = new Promise<void>((resolve) => {
    stopNow = resolve;
  });
  process.once("SIGINT", stopNow);
  process.once("SIGTERM", stopNow);
  try {
    return await serveDev(args, { ...io, stop });
  } finally {
    process.off("SIGINT", stopNow);
    process.off("SIGTERM", stopNow);
  }
}

async function cmdSdk(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const add = parsed.positional[0] === "add";
  const lang = add ? parsed.positional[1] : flagString(parsed, "lang");
  if (lang === undefined && !add) {
    // The original snippet mode: the Node setup with whatever pins were given, against the
    // production origin unless `--base-url` names another (the default every other command uses).
    const product = flagString(parsed, "product") ?? parsed.positional[0];
    const baseUrl = flagString(parsed, "base-url") ?? DEFAULT_BASE_URL;
    if (!product) throw new Error(SDK_CONFIG_USAGE);
    const kid = flagString(parsed, "kid");
    const publicKey = flagString(parsed, "public-key");
    const setup = renderSdkSetup("node", {
      slug: product,
      origin: baseUrl,
      pins: kid && publicKey ? [{ kid, publicKey }] : [],
      services: [],
    });
    stdout.write(`${setup.config.code}\n${setup.start.code}\n`);
    return 0;
  }
  if (lang === undefined || !isSdkLang(lang))
    throw new UsageError(
      add
        ? `pkey sdk add needs the SDK first: pkey sdk add ${SDK_LANGS.join("|")} --expect <kid>@sha256:<fingerprint>[,...]`
        : `--lang must be one of ${SDK_LANGS.join(", ")}.\n${SDK_CONFIG_USAGE}`,
    );
  // `sdk add` pins nothing it was not told to: no trust on first use (SETUP.md D30).
  const expect = add ? parseExpect(flagString(parsed, "expect")) : null;
  // Outside `add` the fetched pins are written as served, so an --expect there would read as a
  // pin it never checked.
  if (!add && flagString(parsed, "expect") !== undefined)
    throw new UsageError(
      "--expect is only for pkey sdk add <lang>; it checks the served pins before writing.",
    );

  // The product repo's .pkey/, when there is one: the slug and the declared release keys.
  let local: { slug: string; releaseKeys: DeclaredReleaseKey[] } | null = null;
  try {
    const m = descriptorManifestOf(await loadManifest(cwd));
    if (m.product) local = { slug: m.product.slug, releaseKeys: m.releaseKeys };
  } catch (e) {
    if (!/No \.pkey\/product manifest/.test((e as Error).message)) throw e;
  }
  // --dev: the product, origin and release keys of a running pkey dev.
  let devFacts: DevInfo | null = null;
  if (flagBool(parsed, "dev")) {
    const base =
      flagString(parsed, "url") ??
      flagString(parsed, "base-url") ??
      (await devConfigUrl(cwd)) ??
      `http://127.0.0.1:${DEV_DEFAULT_PORT}`;
    devFacts = await devInfoFrom(base.replace(/\/+$/, ""), fetchImpl);
  }
  const product =
    flagString(parsed, "product") ??
    (add ? undefined : parsed.positional[0]) ??
    devFacts?.product ??
    local?.slug;
  if (!product)
    throw new UsageError(
      add
        ? "pkey sdk add needs --product <slug> (or run it in the product repo, where .pkey/ names it)."
        : SDK_CONFIG_USAGE,
    );
  if (local && !devFacts && local.slug !== product)
    throw new UsageError(
      `The .pkey/ in ${cwd} is product ${local.slug}, not ${product}; run pkey sdk from ${product}'s repo or drop --product.`,
    );
  const kid = flagString(parsed, "kid");
  const publicKey = flagString(parsed, "public-key");
  if ((kid === undefined) !== (publicKey === undefined))
    throw new UsageError("--kid and --public-key go together.");
  const facts = await resolveSdkFacts({
    product,
    baseUrl:
      devFacts?.baseUrl ?? flagString(parsed, "base-url") ?? DEFAULT_BASE_URL,
    releaseKeys: [
      ...(devFacts ? [] : (local?.releaseKeys ?? [])),
      ...Object.entries(devFacts?.releaseKeys ?? {}).map(
        ([kid, publicKey]) => ({ kid, publicKey }),
      ),
      ...parseReleaseKeyFlags(parsed.multi["release-key"] ?? []),
    ],
    ...(kid !== undefined && publicKey !== undefined
      ? { expectPin: { kid, publicKey } }
      : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (expect) checkExpected(expect, facts);
  // With one pinned key there is no remote recovery from its compromise.
  if (!devFacts && Object.keys(facts.pinnedKeys).length === 1)
    stderr.write(
      "warning: discovery lists one signing key; stage a second key before you ship, so this one can be revoked.\n",
    );
  const out = flagString(parsed, "out");
  const pkg = flagString(parsed, "package");
  const writing = add || flagBool(parsed, "write");
  let target: string | undefined;
  let content = renderSdkConfig(lang, facts, {
    ...(out !== undefined ? { out } : {}),
    ...(pkg !== undefined ? { kotlinPackage: pkg } : {}),
  });
  if (lang === "godot") {
    // One file: polaris_key.tres beside project.godot. The five facts go into it and every other
    // property stays; a project without one gets a new file.
    if (out !== undefined) target = path.resolve(cwd, out);
    else {
      const project = await findGodotProject(cwd);
      if (project) target = path.join(project, SDK_CONFIG_DEFAULT_OUT.godot);
      else if (writing)
        throw new Error(
          `No project.godot at or above ${cwd}; run pkey sdk in the Godot project, or pass --out.`,
        );
    }
    const current = target
      ? await readFile(target, "utf8").catch(() => null)
      : null;
    if (current !== null && !flagBool(parsed, "force")) {
      try {
        content = mergeGodotOptions(current, facts);
      } catch (e) {
        throw new Error(
          `${target}: ${(e as Error).message}; pass --force to replace it.`,
        );
      }
    }
  }
  if (!writing) {
    stdout.write(content);
    return 0;
  }
  target ??= path.resolve(cwd, out ?? SDK_CONFIG_DEFAULT_OUT[lang]);
  const existing = await readFile(target, "utf8").catch(() => null);
  if (
    lang !== "godot" &&
    existing !== null &&
    !existing.includes(SDK_CONFIG_MARKER) &&
    !flagBool(parsed, "force")
  )
    throw new Error(
      `${target} exists and was not written by pkey sdk; pass --force to replace it.`,
    );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  stdout.write(`${factsSummary(facts)}\nWrote ${target}\n`);
  if (lang === "godot") {
    const old = path.join(path.dirname(target), "polaris_key_config.gd");
    if (
      await stat(old).then(
        () => true,
        () => false,
      )
    )
      stdout.write(
        `Note: ${old} is no longer read; delete it. The settings live in polaris_key.tres.\n`,
      );
  }
  if (add) stdout.write(addNextSteps(lang, facts));
  return 0;
}

/** The nearest directory at or above `from` holding `project.godot`, or null. */
async function findGodotProject(from: string): Promise<string | null> {
  for (let dir = path.resolve(from); ; ) {
    if (
      await stat(path.join(dir, "project.godot")).then(
        () => true,
        () => false,
      )
    )
      return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** `--expect kid@sha256:<hex>[,kid@sha256:<hex>...]`: the pins the developer saw in the console. */
function parseExpect(raw: string | undefined): Map<string, string> {
  if (raw === undefined)
    throw new UsageError(
      "pkey sdk add needs --expect <kid>@sha256:<fingerprint>[,...]: the pin fingerprints on the console's Integration page. It never trusts what discovery says first.",
    );
  const out = new Map<string, string>();
  for (const part of raw.split(",").filter(Boolean)) {
    const m = /^(.+)@sha256:([0-9a-f]{64})$/i.exec(part.trim());
    if (!m)
      throw new UsageError(
        `--expect takes <kid>@sha256:<64 hex digits>; got ${part}.`,
      );
    out.set(m[1] as string, (m[2] as string).toLowerCase());
  }
  if (out.size === 0) throw new UsageError("--expect lists no pin.");
  return out;
}

/** Refuse unless discovery serves exactly the pins that were expected, fingerprint for fingerprint. */
function checkExpected(
  expect: ReadonlyMap<string, string>,
  facts: SdkConfigFacts,
): void {
  const served = new Map(
    Object.entries(facts.pinnedKeys).map(([kid, key]) => [
      kid,
      fingerprintOf(key),
    ]),
  );
  const wrong = [...expect].filter(([kid, fp]) => served.get(kid) !== fp);
  const extra = [...served.keys()].filter((kid) => !expect.has(kid));
  if (wrong.length > 0 || extra.length > 0)
    throw new Error(
      `Discovery does not serve the pins you expected; nothing was written. ` +
        (wrong.length > 0
          ? `Missing or different: ${wrong.map(([kid]) => kid).join(", ")}. `
          : "") +
        (extra.length > 0 ? `Not in --expect: ${extra.join(", ")}. ` : "") +
        `Compare the console's signing keys with ${facts.discoveryUrl}.`,
    );
}

/** What `pkey sdk add` prints after it writes the file: install from our feeds, then the start. */
function addNextSteps(lang: SdkLang, facts: SdkConfigFacts): string {
  const setup = renderSdkSetup(lang, {
    slug: facts.product,
    origin: facts.baseUrl,
    pins: Object.entries(facts.pinnedKeys).map(([kid, publicKey]) => ({
      kid,
      publicKey,
    })),
    releaseKeys: Object.entries(facts.pinnedReleaseKeys).map(
      ([kid, publicKey]) => ({ kid, publicKey }),
    ),
    services: facts.services,
  });
  const lines = ["", "Install from pkg.plrs.im, routing the name to it first:"];
  for (const snip of setup.install)
    lines.push(
      "",
      `${snip.filename ? `# ${snip.filename}\n` : ""}${snip.code}`,
    );
  if (setup.installNote) lines.push("", setup.installNote);
  lines.push("", `Start (${setup.start.filename}):`, "", setup.start.code);
  for (const w of setup.warnings) lines.push(`warning: ${w}`);
  return `${lines.join("\n")}\n`;
}

async function cmdMirror(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const langs = (flagString(parsed, "lang") ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  if (langs.length === 0) throw new Error(MIRROR_USAGE);
  const written = await writeMirrors({
    cwd,
    langs,
    outDir: flagString(parsed, "out-dir") ?? ".",
    catalog: flagString(parsed, "catalog"),
    product: flagString(parsed, "product"),
    baseUrl: flagString(parsed, "base-url") ?? DEFAULT_BASE_URL,
    kotlinPackage: flagString(parsed, "package"),
    check: flagBool(parsed, "check"),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  for (const w of written)
    stdout.write(
      `${w.changed ? (flagBool(parsed, "check") ? "stale" : "wrote") : "up to date"}: ${w.path}\n`,
    );
  return flagBool(parsed, "check") && written.some((w) => w.changed) ? 1 : 0;
}

interface CiIo {
  env: CiEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const AUTH_USAGE =
  "Usage: pkey auth github-oidc --product <slug> [--base-url <url>]";

/**
 * `pkey auth github-oidc` — exchange the Actions job's OIDC token for a `pkeyci_` token, mask it,
 * and write `PKEY_CI_TOKEN` to `$GITHUB_ENV` for the job's later steps (`oidc.ts`).
 */
async function cmdAuth(
  parsed: ParsedArgs,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
): Promise<number> {
  const product = flagString(parsed, "product");
  if (parsed.positional[0] !== "github-oidc" || !product)
    throw new Error(AUTH_USAGE);
  const issued = await authGithubOidc({
    baseUrl: flagString(parsed, "base-url"),
    product,
    env: ci.env,
    out: stdout,
    log: stderr,
    fetchImpl: ci.fetchImpl,
    sleep: ci.sleep,
  });
  const scopes = issued.scopes.map((s) => untrusted(s, ci.env));
  stdout.write(
    `Exchanged the job's OIDC token for a CI token (${scopes.join(", ") || "no scopes"}); ` +
      `${CI_TOKEN_ENV} is set for the job's later steps.\n`,
  );
  return 0;
}

/**
 * `pkey release publish`: an app release (`publish.ts`), a pack release (`packPublish.ts`) or a
 * package release (`package/publish.ts`), reporting its stages to `progress`.
 */
async function releasePublish(
  parsed: ParsedArgs,
  cwd: string,
  product: string | undefined,
  common: {
    baseUrl: string | undefined;
    env: CiEnv;
    stdout: TermOut;
    stderr: TermOut;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  },
  progress: StageProgress,
): Promise<number> {
  const dir = flagString(parsed, "dir");
  if (!product || !dir) throw new Error(PUBLISH_USAGE);
  const deliverable = flagString(parsed, "deliverable");
  const releaseKeyPem = flagString(parsed, "release-key-file")
    ? await readFile(
        path.resolve(cwd, flagString(parsed, "release-key-file")!),
        "utf8",
      )
    : undefined;
  const minSupportedSeq =
    flagString(parsed, "min-supported-seq") !== undefined
      ? Number(flagString(parsed, "min-supported-seq"))
      : undefined;
  if (parsed.bare.has("pin"))
    throw new UsageError("--pin needs a value: --pin <packId>@<version>.");
  const contentKeyPem = flagString(parsed, "content-key-file")
    ? await readFile(
        path.resolve(cwd, flagString(parsed, "content-key-file")!),
        "utf8",
      )
    : undefined;
  const delegation = flagString(parsed, "delegation");
  // F-03: a package release (a `kind: package` deliverable): extracted, never signed.
  if (
    deliverable &&
    deliverable !== "app" &&
    (await isPackageDeliverable(cwd, deliverable))
  ) {
    refuseFlags(
      parsed,
      [
        "tag",
        "source",
        "meta",
        "release-key-file",
        "min-supported-seq",
        "content-stamp",
        "embedded",
        "pin",
        "content-interface",
        "provides",
        "removes",
        "out",
        "bases",
        "content-key-file",
        "delegation",
        "script-extensions",
        "script-types",
      ],
      `--deliverable ${deliverable} is a package: its files are extracted from --dir, its release id is <deliverable>@<version>, and it is never signed`,
    );
    if (flagBool(parsed, "no-record"))
      throw new UsageError(
        "--no-record does not apply to a package: a package release never carries a record.",
      );
    progress.stage(`Publishing ${deliverable}`);
    const result = await publishPackage({
      ...common,
      cwd,
      product,
      dir,
      deliverable,
      version: flagString(parsed, "version"),
      channel: flagString(parsed, "channel"),
      dryRun: flagBool(parsed, "dry-run"),
    });
    await writeOutputs(common, result.releaseId, result.server);
    return 0;
  }
  if (deliverable && deliverable !== "app") {
    refuseFlags(
      parsed,
      ["content-stamp", "embedded", "pin"],
      `--deliverable ${deliverable} is a pack; these stamp an app release's packs`,
    );
    refuseFlags(
      parsed,
      ["content-interface", "strict"],
      `--deliverable ${deliverable} is a pack; the content-interface fingerprint is the app's (its pack lists content ids with --provides)`,
    );
    if (parsed.bare.has("removes") || parsed.bare.has("provides"))
      throw new UsageError(
        "--provides needs a file and --removes a content id: --provides <file>, --removes <id>[,<id>...].",
      );
    if (parsed.bare.has("script-extensions") || parsed.bare.has("script-types"))
      throw new UsageError(
        "--script-extensions and --script-types need values: --script-extensions lua[,wren...], --script-types LuaScript[,...].",
      );
    const scriptExtensions = parseRemoves(
      parsed.multi["script-extensions"] ?? [],
    );
    const scriptTypes = parseRemoves(parsed.multi["script-types"] ?? []);
    // P4-03: a pack release.
    const result = await publishPack({
      ...common,
      progress,
      cwd,
      product,
      dir,
      deliverable,
      version: flagString(parsed, "version"),
      tag: flagString(parsed, "tag"),
      channel: flagString(parsed, "channel"),
      out: flagString(parsed, "out"),
      bases: flagString(parsed, "bases"),
      dryRun: flagBool(parsed, "dry-run"),
      ...(releaseKeyPem !== undefined ? { releaseKeyPem } : {}),
      ...(contentKeyPem !== undefined ? { contentKeyPem } : {}),
      ...(delegation !== undefined ? { delegation } : {}),
      ...(minSupportedSeq !== undefined ? { minSupportedSeq } : {}),
      ...(flagString(parsed, "provides") !== undefined
        ? { providesFile: flagString(parsed, "provides") }
        : {}),
      removes: parseRemoves(parsed.multi["removes"] ?? []),
      // P4-28: another script language's extensions and types, for the PCK lint.
      ...(scriptExtensions.length ? { scriptExtensions } : {}),
      ...(scriptTypes.length ? { scriptTypes } : {}),
    });
    await writeOutputs(common, result.releaseId, result.server);
    return 0;
  }
  refuseFlags(
    parsed,
    ["provides", "removes"],
    "they list a pack release's content ids; the app's code interface is --content-interface",
  );
  refuseFlags(
    parsed,
    ["script-extensions", "script-types"],
    "they configure a godot.pck pack's lint",
  );
  refuseFlags(
    parsed,
    ["out", "bases"],
    "they keep and read a pack's earlier releases; the app takes neither",
  );
  refuseFlags(
    parsed,
    ["content-key-file", "delegation"],
    "a content key signs only data-only pack releases, never an app record",
  );
  const result = await publishRelease({
    ...common,
    progress,
    cwd,
    product,
    dir,
    deliverable,
    version: flagString(parsed, "version"),
    tag: flagString(parsed, "tag"),
    channel: flagString(parsed, "channel"),
    source: flagString(parsed, "source") as PublishSource | undefined,
    meta: flagString(parsed, "meta"),
    dryRun: flagBool(parsed, "dry-run"),
    ...(releaseKeyPem !== undefined ? { releaseKeyPem } : {}),
    ...(minSupportedSeq !== undefined ? { minSupportedSeq } : {}),
    noRecord: flagBool(parsed, "no-record"),
    contentStamp: flagString(parsed, "content-stamp"),
    embedded: flagString(parsed, "embedded"),
    pins: parsed.multi["pin"] ?? [],
    ...(flagString(parsed, "content-interface") !== undefined
      ? { contentInterface: flagString(parsed, "content-interface") }
      : {}),
    strict: flagBool(parsed, "strict"),
  });
  await writeOutputs(common, result.releaseId, result.server);
  return 0;
}

/** `pkey release publish|promote|pin|unpin|yank` (`publish.ts`, `channels.ts`). */
async function cmdRelease(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  stderr: TermOut,
  ci: CiIo,
  g: TermFlags,
): Promise<number> {
  const [sub, releaseId] = parsed.positional;
  const product = flagString(parsed, "product");
  const common = {
    baseUrl: flagString(parsed, "base-url"),
    env: ci.env,
    stdout,
    stderr,
    fetchImpl: ci.fetchImpl,
    sleep: ci.sleep,
  };
  switch (sub) {
    case "publish": {
      // One spinner line per stage, on stderr, only on an interactive terminal (`terminal.ts`).
      const spinner = new Spinner(stderr, ci.env, g);
      try {
        return await releasePublish(
          parsed,
          cwd,
          product,
          {
            ...common,
            stdout: spinner.wrap(stdout),
            stderr: spinner.wrap(stderr),
          },
          spinner,
        );
      } finally {
        spinner.stop();
      }
    }
    case "content-stamp": {
      if (parsed.bare.has("pin"))
        throw new UsageError("--pin needs a value: --pin <packId>@<version>.");
      if (parsed.bare.has("hold"))
        throw new UsageError(
          "--hold needs a value: --hold <packId>@<version>[=<reason>].",
        );
      // `pkey release content-stamp` (P4-03): the pkey-content/1 stamp a build embeds.
      const outFile = flagString(parsed, "out");
      if (!product || !outFile) throw new Error(CONTENT_STAMP_USAGE);
      await writeContentStampFile({
        ...common,
        cwd,
        product,
        out: outFile,
        embedded: flagString(parsed, "embedded"),
        pins: parsed.multi["pin"] ?? [],
        holds: parsed.multi["hold"] ?? [],
      });
      return 0;
    }
    case "revoke": {
      // `pkey release revoke` (P4-13): a CI-signed revocation of one pack release.
      const reason = flagString(parsed, "reason");
      const delegationFlag = flagString(parsed, "delegation");
      if (delegationFlag !== undefined) {
        // P4-19: the revocation of a delegation (by hash, or a file holding its JWS).
        if (!product || !reason || releaseId)
          throw new Error(REVOKE_DELEGATION_USAGE);
        refuseFlags(
          parsed,
          ["replacement"],
          "no release replaces a delegation",
        );
        const pem = flagString(parsed, "release-key-file")
          ? await readFile(
              path.resolve(cwd, flagString(parsed, "release-key-file")!),
              "utf8",
            )
          : undefined;
        await revokeDelegation({
          ...common,
          cwd,
          product,
          delegation: delegationFlag,
          reason,
          dryRun: flagBool(parsed, "dry-run"),
          ...(pem !== undefined ? { releaseKeyPem: pem } : {}),
        });
        return 0;
      }
      if (!product || !releaseId || !reason) throw new Error(REVOKE_USAGE);
      const releaseKeyPem = flagString(parsed, "release-key-file")
        ? await readFile(
            path.resolve(cwd, flagString(parsed, "release-key-file")!),
            "utf8",
          )
        : undefined;
      await revokePackRelease({
        ...common,
        cwd,
        product,
        target: releaseId,
        replacement: flagString(parsed, "replacement"),
        reason,
        dryRun: flagBool(parsed, "dry-run"),
        ...(releaseKeyPem !== undefined ? { releaseKeyPem } : {}),
      });
      return 0;
    }
    case "delegate": {
      // `pkey release delegate` (P4-19): a CI-signed delegation of a content key.
      const prefix = flagString(parsed, "prefix");
      const types = flagString(parsed, "types");
      const publicKey = flagString(parsed, "public-key");
      if (!product || !prefix || !types || !publicKey)
        throw new Error(DELEGATE_USAGE);
      const expires = flagString(parsed, "expires-in");
      const pem = flagString(parsed, "release-key-file")
        ? await readFile(
            path.resolve(cwd, flagString(parsed, "release-key-file")!),
            "utf8",
          )
        : undefined;
      await delegateContentKey({
        ...common,
        cwd,
        product,
        prefix,
        types,
        publicKey,
        ...(expires !== undefined ? { expiresInDays: Number(expires) } : {}),
        notes: flagString(parsed, "notes"),
        dryRun: flagBool(parsed, "dry-run"),
        ...(pem !== undefined ? { releaseKeyPem: pem } : {}),
      });
      return 0;
    }
    case "keys": {
      // `pkey release keys generate --kid <kid> --out <file>` (P3-03), or `--content` (P4-19).
      const kid = flagString(parsed, "kid");
      const outFile = flagString(parsed, "out");
      if (flagBool(parsed, "content")) {
        if (parsed.positional[1] !== "generate" || !outFile || kid)
          throw new Error(CONTENT_KEYS_USAGE);
        const generated = await generateContentKey({
          out: path.resolve(cwd, outFile),
        });
        stdout.write(generatedContentKeyText(generated));
        return 0;
      }
      if (parsed.positional[1] !== "generate" || !kid || !outFile)
        throw new Error(`${KEYS_USAGE}\n${CONTENT_KEYS_USAGE}`);
      const generated = await generateReleaseKey({
        kid,
        out: path.resolve(cwd, outFile),
        force: flagBool(parsed, "force"),
      });
      stdout.write(generatedKeyText(generated));
      return 0;
    }
    case "promote":
    case "pin":
    case "unpin": {
      const channel = flagString(parsed, "channel");
      if (!product || !channel) throw new Error(CHANNEL_USAGE);
      await movePointer({
        ...common,
        product,
        op: sub,
        channel,
        releaseId,
        deliverable: flagString(parsed, "deliverable"),
      });
      return 0;
    }
    case "yank": {
      const reason = flagString(parsed, "reason");
      if (!product || !releaseId || !reason) throw new Error(CHANNEL_USAGE);
      await yankRelease({ ...common, product, releaseId, reason });
      return 0;
    }
    default:
      throw new Error(
        [
          PUBLISH_USAGE,
          CONTENT_STAMP_USAGE,
          REVOKE_USAGE,
          REVOKE_DELEGATION_USAGE,
          KEYS_USAGE,
          CONTENT_KEYS_USAGE,
          DELEGATE_USAGE,
          CHANNEL_USAGE,
        ].join("\n"),
      );
  }
}

/** `pkey feeds setup` (F-12, `feedSetup.ts`) and
 *  `pkey feeds prune` (feed retention, `feedPrune.ts`). */
async function cmdFeeds(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
  rt: Runtime,
): Promise<number> {
  if (parsed.positional[0] === "setup" && flagBool(parsed, "write"))
    return cmdFeedsWrite(
      {
        ...accountIo(parsed, rt),
        noBrowser: flagBool(parsed, "no-browser"),
        flags: rt.g,
        seams: { sleep: rt.ci.sleep, ...rt.login },
      },
      {
        cwd,
        owner: flagString(parsed, "owner"),
        seams: rt.feedWrite ?? {},
      },
    );
  if (parsed.positional[0] === "setup") {
    stdout.write(
      feedsSetup({
        ecosystem: flagString(parsed, "ecosystem"),
        owner: flagString(parsed, "owner"),
        namespace: parsed.multi["namespace"] ?? [],
        package: flagString(parsed, "package"),
        version: flagString(parsed, "version"),
        origin: flagString(parsed, "origin"),
        tokenEnv: flagString(parsed, "token-env"),
        json: flagBool(parsed, "json"),
      }),
    );
    return 0;
  }
  if (parsed.positional[0] === "prune") {
    const prunedProduct = flagString(parsed, "product");
    if (!prunedProduct) throw new Error(FEEDS_PRUNE_USAGE);
    const report = await feedsPrune({
      product: prunedProduct,
      deliverable: flagString(parsed, "deliverable"),
      apply: flagBool(parsed, "apply"),
      json: flagBool(parsed, "json"),
      baseUrl: flagString(parsed, "base-url"),
      env: ci.env,
      stdout,
      stderr,
      fetchImpl: ci.fetchImpl,
      sleep: ci.sleep,
    });
    // An applied prune with failed versions is not done: exit non-zero so CI notices.
    return report.totals.failed > 0 ? 1 : 0;
  }
  throw new UsageError(`${FEEDS_SETUP_USAGE}\n${FEEDS_PRUNE_USAGE}`);
}

/** `pkey listing import` (A-18c, `listing.ts`) and `pkey listing assets` (A-18d, `listingAssets.ts`). */
async function cmdListing(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  stderr: TermOut,
  ci: CiIo,
  g: TermFlags,
  admin: AdminIo,
): Promise<number> {
  switch (parsed.positional[0]) {
    case "import":
      // A dry run reads the project and contacts nothing, so it needs no credential.
      return flagBool(parsed, "dry-run")
        ? cmdListingImport(parsed, cwd, stdout, ci, undefined)
        : withAdminCredential(
            admin,
            "listing import",
            (token) => cmdListingImport(parsed, cwd, stdout, ci, token),
            true,
          );
    case "assets": {
      // One spinner line per stage, on stderr, only on an interactive terminal (`terminal.ts`).
      const spinner = new Spinner(stderr, ci.env, g);
      try {
        return await cmdListingAssets(
          parsed,
          cwd,
          spinner.wrap(stdout),
          spinner.wrap(stderr),
          ci,
          spinner,
        );
      } finally {
        spinner.stop();
      }
    }
    default:
      throw new Error(`${LISTING_USAGE}\n${LISTING_ASSETS_USAGE}`);
  }
}

/** `pkey listing assets` (A-18d, `listingAssets.ts`). */
async function cmdListingAssets(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  stderr: TermOut,
  ci: CiIo,
  progress: StageProgress,
): Promise<number> {
  const out = flagString(parsed, "out");
  if (parsed.positional[0] !== "assets" || !out)
    throw new Error(LISTING_ASSETS_USAGE);
  await listingAssets({
    cwd,
    out,
    icon: flagString(parsed, "icon"),
    keyArt: flagString(parsed, "key-art"),
    keyArtPortrait: flagString(parsed, "key-art-portrait"),
    wordmark: flagString(parsed, "wordmark"),
    screenshots: flagString(parsed, "screenshots"),
    focal: flagString(parsed, "focal"),
    focalPortrait: flagString(parsed, "focal-portrait"),
    background: flagString(parsed, "background"),
    accept: parsed.multi["accept"] ?? [],
    pad: parsed.multi["pad"] ?? [],
    locale: flagString(parsed, "locale"),
    upload: flagBool(parsed, "upload"),
    product: flagString(parsed, "product"),
    baseUrl: flagString(parsed, "base-url"),
    dryRun: flagBool(parsed, "dry-run"),
    env: ci.env,
    stdout,
    stderr,
    fetchImpl: ci.fetchImpl,
    sleep: ci.sleep,
    progress,
  });
  return 0;
}

/**
 * `pkey assets push <file> --slot <slot>` (HA-06, `assets.ts`): host a file that is not on the web
 * in a presentation or listing slot. Exit 1 when the Worker refused it; a slot the console claimed
 * or a manifest declares is `kept`, which is not a failure.
 */
async function cmdAssets(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
): Promise<number> {
  const file = parsed.positional[1];
  const slot = flagString(parsed, "slot");
  const product = flagString(parsed, "product");
  if (
    parsed.positional[0] !== "push" ||
    !file ||
    parsed.positional.length > 2 ||
    !slot ||
    !product
  )
    throw new Error(ASSETS_PUSH_USAGE);
  const locale = flagString(parsed, "locale");
  const answer = await pushAssets({
    cwd,
    product,
    entries: [{ file, slot, ...(locale ? { locale } : {}) }],
    baseUrl: flagString(parsed, "base-url"),
    dryRun: flagBool(parsed, "dry-run"),
    env: ci.env,
    stdout,
    stderr,
    fetchImpl: ci.fetchImpl,
    sleep: ci.sleep,
  });
  return answer && answer.refused.length > 0 ? 1 : 0;
}

const MANIFEST_USAGE = "Usage: pkey manifest schemas --out <dir>";

/** `pkey manifest schemas --out <dir>` — vendor the `.pkey/` JSON Schemas (`schemas.ts`). */
async function cmdManifest(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
  const outDir = flagString(parsed, "out");
  if (parsed.positional[0] !== "schemas" || !outDir)
    throw new Error(MANIFEST_USAGE);
  const written = await writeManifestSchemas(path.resolve(cwd, outDir));
  stdout.write(`Wrote ${written.length} schemas:\n`);
  for (const file of written) stdout.write(`- ${path.relative(cwd, file)}\n`);
  return 0;
}

/**
 * `pkey transport apple-ba package|upload`, `play-pad modules`, `steam-depot vdf` (P5-08,
 * `transport*.ts`): package a published pack release for a store transport, then report it.
 */
async function cmdTransport(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
): Promise<number> {
  const [transport, step] = parsed.positional;
  const deliverable = flagString(parsed, "deliverable");
  const version = flagString(parsed, "release");
  if (!deliverable || !version) throw new Error(TRANSPORT_USAGE);
  const common: TransportCommon = {
    cwd,
    deliverable,
    version,
    product: flagString(parsed, "product"),
    baseUrl: flagString(parsed, "base-url"),
    env: ci.env,
    stdout,
    stderr,
    fetchImpl: ci.fetchImpl,
    sleep: ci.sleep,
    report: !flagBool(parsed, "no-report"),
  };
  const from = () => {
    const f = flagString(parsed, "from");
    if (!f)
      throw new UsageError(
        `--from is required: the --out directory of pkey release publish --deliverable ${deliverable}.\n${TRANSPORT_USAGE}`,
      );
    return f;
  };
  const list = (name: string) =>
    flagString(parsed, name)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  switch (`${transport ?? ""} ${step ?? ""}`) {
    case "apple-ba package":
      await baPackage({
        ...common,
        from: from(),
        out: flagString(parsed, "out"),
        contentApi: flagString(parsed, "content-api"),
        variant: flagString(parsed, "variant"),
        platforms: list("platforms"),
        archive: !flagBool(parsed, "no-archive"),
      });
      return 0;
    case "apple-ba upload": {
      const wait = flagString(parsed, "wait");
      if (wait !== undefined && !/^[0-9]{1,4}$/.test(wait))
        throw new UsageError("--wait takes whole minutes.");
      await baUpload({
        ...common,
        dir: flagString(parsed, "dir"),
        from: flagString(parsed, "from"),
        contentApi: flagString(parsed, "content-api"),
        expectResource: flagString(parsed, "expect-resource"),
        lock: flagString(parsed, "lock"),
        ...(wait !== undefined ? { waitMinutes: Number(wait) } : {}),
      });
      return 0;
    }
    case "play-pad modules": {
      const project = flagString(parsed, "project");
      if (!project)
        throw new UsageError(
          `--project is required: the Godot Android Gradle build (android/build).\n${TRANSPORT_USAGE}`,
        );
      await padModules({
        ...common,
        from: from(),
        project,
        delivery: flagString(parsed, "delivery") as PadDelivery | undefined,
        defaultTexture: flagString(parsed, "default-texture"),
        variant: flagString(parsed, "variant"),
      });
      return 0;
    }
    case "steam-depot vdf": {
      const depot = flagString(parsed, "depot");
      if (!depot)
        throw new UsageError(`--depot is required.\n${TRANSPORT_USAGE}`);
      await steamVdf({
        ...common,
        from: from(),
        depot,
        app: flagString(parsed, "app"),
        branch: flagString(parsed, "branch"),
        channel: flagString(parsed, "channel"),
        setlive: flagBool(parsed, "setlive"),
        out: flagString(parsed, "out"),
        variant: flagString(parsed, "variant"),
      });
      return 0;
    }
    default:
      stderr.write(`${TRANSPORT_USAGE}\n`);
      return 2;
  }
}

function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Refuse flags that do not apply to this command, instead of ignoring them. */
function refuseFlags(
  parsed: ParsedArgs,
  names: readonly string[],
  why: string,
): void {
  const given = names.filter((n) => parsed.flags[n] !== undefined);
  if (given.length)
    throw new UsageError(
      `${given.map((n) => `--${n}`).join(", ")} ${given.length === 1 ? "does" : "do"} not apply here: ${why}.`,
    );
}

function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true || parsed.flags[name] === "true";
}

function titleize(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * `pkey listing import --godot <project>` (A-18c): read the Godot project and import it into the
 * product's shared listing — the diff first, written only with `--apply`. The credential is
 * resolved by the caller (`adminAuth.ts`), so `listing.ts` never touches `process.env`.
 */
async function cmdListingImport(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
  token: TokenSource,
): Promise<number> {
  const godot = flagString(parsed, "godot");
  if (parsed.positional[0] !== "import" || !godot)
    throw new Error(LISTING_USAGE);
  const fields = flagString(parsed, "fields");
  const result = await listingImport({
    godot: path.resolve(cwd, godot),
    product: flagString(parsed, "product"),
    presets: parsed.multi["preset"] ?? [],
    locale: flagString(parsed, "locale"),
    overwrite: flagBool(parsed, "overwrite"),
    apply: flagBool(parsed, "apply"),
    ...(fields
      ? {
          fields: fields
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean),
        }
      : {}),
    dryRun: flagBool(parsed, "dry-run"),
    baseUrl: flagString(parsed, "base-url"),
    ...(token ? { token } : {}),
    ...(ci.fetchImpl ? { fetchImpl: ci.fetchImpl } : {}),
  });
  // `--json` is one envelope line like every other command's; a bare `--dry-run` prints the upload.
  stdout.write(
    flagBool(parsed, "json")
      ? envelope("listing import", 0, { ...result })
      : flagBool(parsed, "dry-run")
        ? `${untrustedJson(result.upload, 2)}\n`
        : `${formatImport(result, ci.env)}\n`,
  );
  return 0;
}
