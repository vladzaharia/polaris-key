import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ADMIN_COOKIE_ENV,
  BUNDLE_USAGE,
  DEFAULT_BASE_URL,
  mintBundle,
} from "./bundle.js";
import {
  COMPLETION_SHELLS,
  completionScript,
  findCommand,
  renderCommandHelp,
  renderHelp,
  type CompletionShell,
} from "./help.js";
import {
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
  sdkSnippet,
  trustSnippet,
  validateLoadedManifest,
  type LoadedManifest,
  type ProductModule,
  type ValidationMessage,
} from "./manifest.js";
import { authGithubOidc, CI_TOKEN_ENV, type CiEnv } from "./oidc.js";
import type { StageProgress } from "./ci.js";
import { wrapSpans, type Line } from "@polaris-key/node/terminal";
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
import {
  factsSummary,
  isSdkLang,
  parseReleaseKeyFlags,
  renderSdkConfig,
  resolveSdkFacts,
  SDK_CONFIG_DEFAULT_OUT,
  SDK_CONFIG_MARKER,
  SDK_CONFIG_USAGE,
  SDK_LANGS,
  type DeclaredReleaseKey,
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
import { buildFdroidFeed, FEEDS_USAGE } from "./feeds.js";
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
  ADMIN_COOKIE_ENV,
  ADMIN_COOKIE_NAME,
  BUNDLE_USAGE,
  CSRF_HEADER,
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
  sdkSnippet,
  trustSnippet,
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
    return cmdHelp(words, stdout, stderr, term);
  }

  try {
    switch (parsed.command) {
      case "init":
        return await cmdInit(parsed, cwd, stdout);
      case "validate":
        return await cmdValidate(parsed, cwd, stdout, term(stdout));
      case "completion":
        return cmdCompletion(parsed, stdout, stderr);
      case "distribution":
        return await cmdDistribution(parsed, cwd, stdout, stderr, ci);
      case "doctor":
        return await cmdDoctor(parsed, cwd, stdout, term(stdout), ci.env);
      case "bundle":
        return await cmdBundle(parsed, cwd, stdout, ci.env);
      case "trust":
        return cmdTrust(parsed, stdout);
      case "sdk":
        return await cmdSdk(parsed, cwd, stdout, ci.fetchImpl);
      case "mirror":
        return await cmdMirror(parsed, cwd, stdout, ci.fetchImpl);
      case "auth":
        return await cmdAuth(parsed, stdout, stderr, ci);
      case "release":
        return await cmdRelease(parsed, cwd, stdout, stderr, ci, g);
      case "manifest":
        return await cmdManifest(parsed, cwd, stdout);
      case "feeds":
        return await cmdFeeds(parsed, cwd, stdout, stderr, ci);
      case "listing":
        return await cmdListing(parsed, cwd, stdout, stderr, ci, g);
      case "assets":
        return await cmdAssets(parsed, cwd, stdout, stderr, ci);
      case "transport":
        return await cmdTransport(parsed, cwd, stdout, stderr, ci);
      case "storefront":
        return await cmdStorefront(
          {
            positional: parsed.positional,
            flags: parsed.flags,
            rest: parsed.rest,
          },
          { cwd, stdout, stderr, ...ci },
        );
      default:
        stderr.write(
          `Unknown command "${parsed.command}".\n\n${renderHelp(term(stderr))}`,
        );
        return 2;
    }
  } catch (err) {
    // An error's message may quote the server (a refusal, a URL it answered, a field it sent):
    // cleaned per line, so it draws no escape and no line of it reads as a workflow command.
    stderr.write(`${untrustedLines((err as Error).message, ci.env)}\n`);
    return 1;
  }
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
): number {
  const [name, sub] = words;
  if (name === undefined) {
    stdout.write(renderHelp(term(stdout)));
    return 0;
  }
  const cmd = findCommand(name);
  if (!cmd) {
    stderr.write(`Unknown command "${name}".\n\n${renderHelp(term(stderr))}`);
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

/** Flags that never take a value, so they never swallow the next word (`validate --json dir`). */
const VALUELESS_FLAGS = new Set(["json"]);

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

async function cmdInit(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
  const basename =
    path
      .basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "my-product";
  const slug =
    flagString(parsed, "product") ?? flagString(parsed, "slug") ?? basename;
  const name = flagString(parsed, "name") ?? titleize(slug);
  const modules = normalizeModules(flagString(parsed, "modules"));
  const result = await initManifest({
    cwd,
    slug,
    name,
    modules,
    adminGroup: flagString(parsed, "admin-group"),
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

const VALIDATE_USAGE = "Usage: pkey validate [path] [--json]";

/**
 * `pkey validate [path] [--json]`: the `.pkey/` under `path` (relative to the current directory;
 * default the current directory), through the validator repo-link and resync apply. Exit 0 when
 * valid, 1 when not.
 */
async function cmdValidate(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  term: Term,
): Promise<number> {
  if (parsed.positional.length > 1) throw new Error(VALIDATE_USAGE);
  const target = parsed.positional[0];
  const dir = target === undefined ? cwd : path.resolve(cwd, target);
  if (flagBool(parsed, "json")) return validateJson(dir, cwd, stdout);
  return validateText(dir, cwd, stdout, term);
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
  const { painter, symbols, caps } = term;
  const rows: Array<{ mark: string; spans: Line }> = [];
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
      { text: "Modules: ", style: ["muted"] },
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
  const message = (
    kind: "warning" | "error",
    at: Line,
    text: string,
  ): { mark: string; spans: Line } => {
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
  const gap = " ".repeat(2);
  for (const row of rows) {
    const lines = caps.tty
      ? wrapSpans(row.spans, Math.max(20, caps.columns - 3), symbols.ellipsis)
      : [row.spans];
    lines.forEach((l, i) =>
      stdout.write(`${i === 0 ? row.mark : " "}${gap}${painter.line(l)}\n`),
    );
  }
  return result.ok ? 0 : 1;
}

/**
 * `pkey validate --json`: one JSON line on stdout in the terminal kits' flattened envelope (the
 * Python kit's, which the Node kit and pkey follow): `v`, `command`, `event`, `ok` and `exit`,
 * then the verdict's own fields beside them,
 * `{"v":1,"command":"validate","event":"result","ok","exit","valid","modules","requiredSecrets",
 * "warnings","errors"}`, or `"error":"no-manifest"` and a `"message"` when no manifest could be
 * read (a file problem, exit 1). ASCII only.
 */
async function validateJson(
  dir: string,
  cwd: string,
  stdout: TermOut,
): Promise<number> {
  const envelope = (exit: number, rest: Record<string, unknown>) =>
    `${JSON.stringify({ v: 1, command: "validate", event: "result", ok: exit === 0, exit, ...rest }).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
  let manifest: LoadedManifest;
  try {
    manifest = await loadManifest(dir);
  } catch (e) {
    stdout.write(
      envelope(1, {
        error: "no-manifest",
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

async function cmdDoctor(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  term: Term,
  env: UntrustedEnv,
): Promise<number> {
  const u = (v: unknown) => untrusted(v, env);
  const localCode = await validateText(cwd, cwd, stdout, term);
  const baseUrl = flagString(parsed, "base-url");
  const product = flagString(parsed, "product");
  if (!baseUrl || !product) {
    stdout.write(
      "\nRemote checks skipped. Pass --base-url and --product to check product discovery.\n",
    );
    return localCode;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(product)}/.well-known/polaris.json`;
  const res = await fetch(url);
  if (!res.ok) {
    stdout.write(`\nRemote discovery: failed (${res.status}) ${url}\n`);
    return 1;
  }
  const body = (await res.json()) as {
    signing?: unknown;
    trust?: unknown;
    services?: Record<string, { enabled?: unknown } | undefined>;
  };
  stdout.write(`\nRemote discovery: ok ${url}\n`);
  // Every name and value below is the server's: each is cleaned (`untrusted.ts`).
  const enabled = Object.entries(body.services ?? {})
    .filter(([, service]) => service?.enabled === true)
    .map(([slug]) => u(slug));
  stdout.write(
    `Services enabled: ${enabled.length ? enabled.join(", ") : "none"}\n`,
  );
  stdout.write(
    `Signing keys exposed: ${u(JSON.stringify(body.signing ?? body.trust ?? {}))}\n`,
  );
  return localCode;
}

/**
 * `pkey bundle` — mint one offline activation bundle. A thin shell over `mintBundle`: it reads
 * the flags, reads the admin session cookie out of the environment (the module itself never
 * touches `process.env`, so it stays testable), and prints what came back.
 */
async function cmdBundle(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  env: UntrustedEnv,
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
    // `--no-config` is a boolean flag, so it is read with flagBool; see the note in
    // `pkey bundle --help` about passing valueless flags last or with `=`.
    includeConfig: !flagBool(parsed, "no-config"),
    licenseId: flagString(parsed, "license"),
    baseUrl: flagString(parsed, "base-url"),
    out: flagString(parsed, "out"),
    force: flagBool(parsed, "force"),
    cookie: process.env[ADMIN_COOKIE_ENV],
  });

  const rel = path.relative(cwd, result.file);
  stdout.write(`Minted bundle ${untrusted(result.bundleId, env)}\n`);
  stdout.write(`- File: ${rel}\n`);
  stdout.write(`- Device: ${result.deviceId}\n`);
  stdout.write(
    `- Grace window: ${result.graceDays} day${result.graceDays === 1 ? "" : "s"} offline\n`,
  );
  // Which documents rode along is decided server-side by the product's enabled services, and
  // the mint response does not say — so claim nothing rather than guess.
  stdout.write(
    "\nNext: transfer this file to the offline machine and import it there.\n",
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
  stdout.write(`${trustSnippet(kid, publicKey)}\n`);
  return 0;
}

async function cmdSdk(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const lang = flagString(parsed, "lang");
  if (lang === undefined) {
    // The original snippet mode: a Node example with whatever pins were given, against the
    // production origin unless `--base-url` names another (the default every other command uses).
    const product = flagString(parsed, "product") ?? parsed.positional[0];
    const baseUrl = flagString(parsed, "base-url") ?? DEFAULT_BASE_URL;
    if (!product) throw new Error(SDK_CONFIG_USAGE);
    stdout.write(
      `${sdkSnippet({
        baseUrl,
        product,
        kid: flagString(parsed, "kid"),
        publicKey: flagString(parsed, "public-key"),
      })}\n`,
    );
    return 0;
  }
  if (!isSdkLang(lang))
    throw new Error(
      `--lang must be one of ${SDK_LANGS.join(", ")}.\n${SDK_CONFIG_USAGE}`,
    );

  // The product repo's .pkey/, when there is one: the slug and the declared release keys.
  let local: { slug: string; releaseKeys: DeclaredReleaseKey[] } | null = null;
  try {
    const m = descriptorManifestOf(await loadManifest(cwd));
    if (m.product) local = { slug: m.product.slug, releaseKeys: m.releaseKeys };
  } catch (e) {
    if (!/No \.pkey\/product manifest/.test((e as Error).message)) throw e;
  }
  const product =
    flagString(parsed, "product") ?? parsed.positional[0] ?? local?.slug;
  if (!product) throw new Error(SDK_CONFIG_USAGE);
  if (local && local.slug !== product)
    throw new Error(
      `The .pkey/ in ${cwd} is product ${local.slug}, not ${product}; run pkey sdk from ${product}'s repo or drop --product.`,
    );
  const kid = flagString(parsed, "kid");
  const publicKey = flagString(parsed, "public-key");
  if ((kid === undefined) !== (publicKey === undefined))
    throw new Error("--kid and --public-key go together.");
  const facts = await resolveSdkFacts({
    product,
    baseUrl: flagString(parsed, "base-url") ?? DEFAULT_BASE_URL,
    releaseKeys: [
      ...(local?.releaseKeys ?? []),
      ...parseReleaseKeyFlags(parsed.multi["release-key"] ?? []),
    ],
    ...(kid !== undefined && publicKey !== undefined
      ? { expectPin: { kid, publicKey } }
      : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const out = flagString(parsed, "out");
  const pkg = flagString(parsed, "package");
  const content = renderSdkConfig(lang, facts, {
    ...(out !== undefined ? { out } : {}),
    ...(pkg !== undefined ? { kotlinPackage: pkg } : {}),
  });
  if (!flagBool(parsed, "write")) {
    stdout.write(content);
    return 0;
  }
  const target = path.resolve(cwd, out ?? SDK_CONFIG_DEFAULT_OUT[lang]);
  const existing = await readFile(target, "utf8").catch(() => null);
  if (
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
  return 0;
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
    throw new Error("--pin needs a value: --pin <packId>@<version>.");
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
      throw new Error(
        "--no-record does not apply to a package: a package release never carries a record.",
      );
    progress.stage(`Publishing ${deliverable}`);
    await publishPackage({
      ...common,
      cwd,
      product,
      dir,
      deliverable,
      version: flagString(parsed, "version"),
      channel: flagString(parsed, "channel"),
      dryRun: flagBool(parsed, "dry-run"),
    });
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
      throw new Error(
        "--provides needs a file and --removes a content id: --provides <file>, --removes <id>[,<id>...].",
      );
    if (parsed.bare.has("script-extensions") || parsed.bare.has("script-types"))
      throw new Error(
        "--script-extensions and --script-types need values: --script-extensions lua[,wren...], --script-types LuaScript[,...].",
      );
    const scriptExtensions = parseRemoves(
      parsed.multi["script-extensions"] ?? [],
    );
    const scriptTypes = parseRemoves(parsed.multi["script-types"] ?? []);
    // P4-03: a pack release.
    await publishPack({
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
  await publishRelease({
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
        throw new Error("--pin needs a value: --pin <packId>@<version>.");
      if (parsed.bare.has("hold"))
        throw new Error(
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
        throw new Error(KEYS_USAGE);
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
        `${PUBLISH_USAGE}\n${CONTENT_STAMP_USAGE}\n${CHANNEL_USAGE}`,
      );
  }
}

/** `pkey feeds fdroid` (P2b-05, `feeds.ts`), `pkey feeds setup` (F-12, `feedSetup.ts`) and
 *  `pkey feeds prune` (feed retention, `feedPrune.ts`). */
async function cmdFeeds(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
): Promise<number> {
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
  const product = flagString(parsed, "product");
  const channel = flagString(parsed, "channel");
  const out = flagString(parsed, "out");
  if (parsed.positional[0] !== "fdroid" || !product || !channel || !out)
    throw new Error(
      `${FEEDS_USAGE}\n${FEEDS_SETUP_USAGE}\n${FEEDS_PRUNE_USAGE}`,
    );
  await buildFdroidFeed({
    cwd,
    product,
    channel,
    out,
    keystore: flagString(parsed, "keystore"),
    alias: flagString(parsed, "alias"),
    ksPassEnv: flagString(parsed, "ks-pass-env"),
    apksigner: flagString(parsed, "apksigner"),
    icon: flagString(parsed, "icon"),
    dryRun: flagBool(parsed, "dry-run"),
    baseUrl: flagString(parsed, "base-url"),
    env: ci.env,
    stdout,
    stderr,
    fetchImpl: ci.fetchImpl,
    sleep: ci.sleep,
  });
  return 0;
}

/** `pkey listing import` (A-18c, `listing.ts`) and `pkey listing assets` (A-18d, `listingAssets.ts`). */
async function cmdListing(
  parsed: ParsedArgs,
  cwd: string,
  stdout: TermOut,
  stderr: TermOut,
  ci: CiIo,
  g: TermFlags,
): Promise<number> {
  switch (parsed.positional[0]) {
    case "import":
      return cmdListingImport(parsed, cwd, stdout, ci);
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
      throw new Error(
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
        throw new Error("--wait takes whole minutes.");
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
        throw new Error(
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
      if (!depot) throw new Error(`--depot is required.\n${TRANSPORT_USAGE}`);
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
    throw new Error(
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
 * product's shared listing — the diff first, written only with `--apply`. The cookie is read from
 * the environment here, as `pkey bundle` does, so `listing.ts` never touches `process.env`.
 */
async function cmdListingImport(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
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
    cookie: (ci.env as Record<string, string | undefined>)[ADMIN_COOKIE_ENV],
    ...(ci.fetchImpl ? { fetchImpl: ci.fetchImpl } : {}),
  });
  stdout.write(
    flagBool(parsed, "json") || flagBool(parsed, "dry-run")
      ? `${untrustedJson(flagBool(parsed, "dry-run") ? result.upload : result, 2)}\n`
      : `${formatImport(result, ci.env)}\n`,
  );
  return 0;
}
