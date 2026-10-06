import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SERVICE_SLUGS } from "@polaris-key/manifest";
import {
  ADMIN_COOKIE_ENV,
  ADMIN_COOKIE_NAME,
  BUNDLE_USAGE,
  DEFAULT_BASE_URL,
  mintBundle,
} from "./bundle.js";
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
import {
  generatedKeyText,
  generateReleaseKey,
  KEYS_USAGE,
} from "./releaseKeys.js";

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

export interface CliIo {
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
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

export async function runPkey(argv: string[], io: CliIo = {}): Promise<number> {
  const parsed = parseArgs(argv);
  const cwd = io.cwd ?? process.cwd();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const ci = {
    env: io.env ?? (process.env as CiEnv),
    fetchImpl: io.fetchImpl,
    sleep: io.sleep,
  };

  try {
    switch (parsed.command) {
      case "help":
      case "--help":
      case "-h":
        stdout.write(helpText());
        return 0;
      case "init":
        return await cmdInit(parsed, cwd, stdout);
      case "validate":
        return await cmdValidate(cwd, stdout);
      case "distribution":
        return await cmdDistribution(parsed, cwd, stdout, stderr, ci);
      case "doctor":
        return await cmdDoctor(parsed, cwd, stdout);
      case "bundle":
        return await cmdBundle(parsed, cwd, stdout);
      case "trust":
        return cmdTrust(parsed, stdout);
      case "sdk":
        return await cmdSdk(parsed, cwd, stdout, ci.fetchImpl);
      case "mirror":
        return await cmdMirror(parsed, cwd, stdout, ci.fetchImpl);
      case "auth":
        return await cmdAuth(parsed, stdout, stderr, ci);
      case "release":
        return await cmdRelease(parsed, cwd, stdout, stderr, ci);
      case "manifest":
        return await cmdManifest(parsed, cwd, stdout);
      case "feeds":
        return await cmdFeeds(parsed, cwd, stdout, stderr, ci);
      case "listing":
        return await cmdListing(parsed, cwd, stdout, stderr, ci);
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
        stderr.write(`Unknown command "${parsed.command}".\n\n${helpText()}`);
        return 2;
    }
  } catch (err) {
    stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
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
    if (next && !next.startsWith("--")) {
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

async function cmdValidate(
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
  const manifest = await loadManifest(cwd);
  const result = validateLoadedManifest(manifest);
  stdout.write(`Manifest: ${result.ok ? "valid" : "invalid"}\n`);
  stdout.write(
    `Modules: ${result.enabledModules.length ? result.enabledModules.join(", ") : "none"}\n`,
  );
  if (result.requiredSecrets.length)
    stdout.write(`Required secrets: ${result.requiredSecrets.join(", ")}\n`);
  for (const warning of result.warnings) {
    stdout.write(
      `warning ${located(manifest, cwd, warning)}: ${warning.message}\n`,
    );
  }
  for (const error of result.errors) {
    stdout.write(`error ${located(manifest, cwd, error)}: ${error.message}\n`);
  }
  return result.ok ? 0 : 1;
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
  const file = {
    product: manifest.productPath,
    schema: manifest.schemaPath,
    release: manifest.releasePath,
    distribution: manifest.distributionPath,
  }[msg.file];
  return `${msg.file}${msg.path}${file ? ` (${path.relative(cwd, file)})` : ""}`;
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
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
  const localCode = await cmdValidate(cwd, stdout);
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
  const enabled = Object.entries(body.services ?? {})
    .filter(([, service]) => service?.enabled === true)
    .map(([slug]) => slug);
  stdout.write(
    `Services enabled: ${enabled.length ? enabled.join(", ") : "none"}\n`,
  );
  stdout.write(
    `Signing keys exposed: ${JSON.stringify(body.signing ?? body.trust ?? {})}\n`,
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
    // `--no-config` is a boolean flag, so it is read with flagBool; see the parseArgs note in
    // helpText() about passing valueless flags last or with `=`.
    includeConfig: !flagBool(parsed, "no-config"),
    licenseId: flagString(parsed, "license"),
    baseUrl: flagString(parsed, "base-url"),
    out: flagString(parsed, "out"),
    force: flagBool(parsed, "force"),
    cookie: process.env[ADMIN_COOKIE_ENV],
  });

  const rel = path.relative(cwd, result.file);
  stdout.write(`Minted bundle ${result.bundleId}\n`);
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
    // The original snippet mode: a Node example with whatever pins were given.
    const product = flagString(parsed, "product") ?? parsed.positional[0];
    const baseUrl = flagString(parsed, "base-url") ?? "https://key.example.com";
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
  stdout.write(
    `Exchanged the job's OIDC token for a CI token (${issued.scopes.join(", ") || "no scopes"}); ` +
      `${CI_TOKEN_ENV} is set for the job's later steps.\n`,
  );
  return 0;
}

/** `pkey release publish|promote|pin|unpin|yank` (`publish.ts`, `channels.ts`). */
async function cmdRelease(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
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
        if (
          parsed.bare.has("script-extensions") ||
          parsed.bare.has("script-types")
        )
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
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
): Promise<number> {
  switch (parsed.positional[0]) {
    case "import":
      return cmdListingImport(parsed, cwd, stdout, ci);
    case "assets":
      return cmdListingAssets(parsed, cwd, stdout, stderr, ci);
    default:
      throw new Error(`${LISTING_USAGE}\n${LISTING_ASSETS_USAGE}`);
  }
}

/** `pkey listing assets` (A-18d, `listingAssets.ts`). */
async function cmdListingAssets(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  ci: CiIo,
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
  });
  return 0;
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
      ? `${JSON.stringify(flagBool(parsed, "dry-run") ? result.upload : result, null, 2)}\n`
      : `${formatImport(result)}\n`,
  );
  return 0;
}

function helpText(): string {
  return `pkey - Polaris Key platform CLI

Commands:
  pkey init [--product slug] [--name name] [--modules ${SERVICE_SLUGS.join(",")}]
  pkey validate
  pkey distribution outlet-ids --outlet id
  pkey doctor [--base-url url --product slug]
  pkey trust --kid kid --public-key key
  pkey sdk --product slug [--base-url url] [--kid kid --public-key key]
  pkey sdk --lang node|react|python|swift|kotlin|godot [--product slug] [--base-url url]
              [--write [--out path] [--force]] [--kid kid --public-key key]
              [--release-key kid=key ...] [--package kotlin.package]
  pkey mirror --lang ts,python,swift,gdscript,kotlin [--out-dir dir] [--catalog file |
              --product slug [--base-url url]] [--package kotlin.package] [--check]
  pkey bundle --product slug --device id --grace-days n [--no-config] [--license id]
              [--base-url url] [--out file] [--force]
  pkey manifest schemas --out dir
  pkey listing import --godot project --product slug [--preset name ...] [--locale code]
              [--overwrite] [--apply [--fields a,b]] [--json] [--base-url url]
  pkey listing import --godot project --dry-run [--preset name ...]

CI (GitHub Actions with permissions: id-token: write, or PKEY_CI_TOKEN):
  pkey auth github-oidc --product slug [--base-url url]
  pkey release publish --product slug --version v --dir path [--deliverable app]
              [--tag vX.Y.Z] [--channel c] [--source r2|github] [--meta builds.json]
              [--base-url url] [--release-key-file pem] [--min-supported-seq n]
              [--no-record] [--content-stamp file | --embedded dir --pin pack@v ...]
              [--content-interface registry.json [--strict]] [--dry-run]
  pkey release publish --product slug --version v --dir path --deliverable packId
              [--out dir] [--bases dir] [--release-key-file pem] [--base-url url] [--dry-run]
              [--content-key-file pem --delegation sha256]
              [--provides ids.json] [--removes id[,id...] ...]
              [--script-extensions ext[,ext...]] [--script-types Type[,Type...]]
  pkey release content-stamp --product slug --out pkey-content.json [--embedded dir]
              [--pin packId@version ...] [--hold packId@version[=reason] ...] [--base-url url]
  pkey release revoke packId@version --reason text --product slug [--replacement version]
              [--release-key-file pem] [--base-url url] [--dry-run]
  pkey release revoke --delegation sha256|file --reason text --product slug
              [--release-key-file pem] [--base-url url] [--dry-run]
  pkey release keys generate --kid kid --out file [--force]
  pkey release keys generate --content --out file
  pkey release delegate --product slug --prefix packId --types type,... --public-key key
              [--expires-in days] [--notes text] [--release-key-file pem] [--base-url url]
              [--dry-run]
  pkey release promote|pin releaseId --channel c --product slug [--deliverable id]
  pkey release unpin --channel c --product slug [--deliverable id]
  pkey release yank releaseId --reason text --product slug
  pkey distribution report availability|submission --product slug --outlet id
              (--release id | --version v [--deliverable id]) --state s [--build id]
              [--since epoch] [--platform-ref json] [--detail json]
  pkey distribution report key --product slug --purpose p --sha256 hex [--outlet id]
  pkey distribution rollout --product slug --outlet id --channel c --release id --bp n
              [--deliverable id]
  pkey distribution pause|resume|halt|complete --product slug --outlet id --channel c
              [--release id] [--deliverable id]
  pkey feeds fdroid --product slug --channel c --out dir [--keystore path --alias a]
              [--ks-pass-env NAME] [--apksigner path] [--icon png] [--base-url url] [--dry-run]
  pkey feeds setup --ecosystem npm|pypi|swift|maven|oci|godot --owner slug
              [--namespace key=value ...] [--package name [--version v]] [--origin url]
              [--token-env NAME] [--json]
  pkey feeds prune --product slug [--deliverable id] [--apply] [--json] [--base-url url]
  pkey listing assets --out dir [--icon png] [--key-art png] [--key-art-portrait png]
              [--wordmark png] [--screenshots dir] [--focal x,y] [--focal-portrait x,y]
              [--background #rrggbb] [--accept store/class/name ...] [--pad store/class/name ...]
              [--locale code] [--upload --product slug [--base-url url] [--dry-run]]
  pkey transport apple-ba package --deliverable packId --release v --from dir [--content-api n]
              [--variant key] [--out dir] [--platforms iOS[,macOS]] [--no-archive] [--no-report]
  pkey transport apple-ba upload --deliverable packId --release v [--dir dir] [--from dir] [--content-api n]
              [--expect-resource id] [--lock file] [--wait minutes] [--no-report]
  pkey transport play-pad modules --deliverable packId --release v --from dir --project dir
              [--delivery fast-follow|on-demand] [--default-texture fmt] [--variant key] [--no-report]
  pkey transport steam-depot vdf --deliverable packId --release v --from dir --depot id
              (--branch b | --channel c) [--setlive] [--app id] [--out dir] [--no-report]
  pkey storefront itch push --platform windows|linux|mac|android --dir dir --version v
              [--channel c] [--outlet id] [--dry-run] [--no-report]
  pkey storefront snap metadata --yaml snapcraft.yaml [--dry-run]
  pkey storefront snap upload --snap file.snap --channel c[,c...] [--outlet id] [--dry-run] [--no-report]
  pkey storefront snap upload-metadata --snap file.snap [--dry-run] [--no-report]
  pkey storefront exec store command --op operation [--outlet id] [--tool-path path] -- argv...
  pkey storefront allow-list [--store s] [--json]
  pkey storefront winget|homebrew|scoop|flathub pr [--channel c] [--outlet id] [--dry-run [--out dir]]
              [--portable path] [--command name] [--license l] [--app name] [--project-license spdx] [--no-report]
  pkey storefront winget|homebrew|scoop|flathub status [--channel c] [--version v] [--outlet id] [--no-report]
  pkey storefront flathub init [--out dir] [--channel c] [--outlet id] [--command path] [--runtime-version v]

pkey release publish matches the files under --dir against .pkey/release's
deliverables.app.artifacts map (<file>.sig and <file>.sha256 ride along as sidecars), hashes
them, uploads what Polaris Key does not already hold, and submits the release descriptor.
--dry-run prints the descriptor and the server's verdict and uploads and writes nothing.
With a release key (PKEY_RELEASE_KEY, or --release-key-file) it also signs the release record
(pkey-release+jws) under the .pkey/release releaseKeys entry whose public key matches, checks it,
and submits it with the descriptor; a dry run prints the record unsigned. pkey release keys
generate writes a new private release key to --out and prints its releaseKeys entry.
When .pkey/release declares packs, an app publish states its pins: --content-stamp is the
pkey-content.json pkey release content-stamp wrote before the export (from the pkey-marker/1
markers under --embedded, verified, and --pin packId@version resolved through Polaris Key), and
each build's embeds come from the artifact map; both go into the descriptor, which the record
is moved from. --deliverable <packId> publishes a pack: per declared variant, the payload at
<dir>/<variant key or "default">/ (one .pck file, or the tree), checked, stripped of
project.binary and the class cache, linted, indexed (pkey-files/1), with a full object, file
blobs, a gaps object and deltas against the releases --bases keeps (zstd >= 1.5.5 on PATH), and
for a PCK variant of 4 MiB or more a pkey-chunks/1 chunk index with chunk bundles shared along
the --bases chain (patch.strategies chunk, discovery release.chunks); it signs the pack record,
uploads in stage rounds, submits it, and writes a marker beside each payload. --out keeps the
record, payloads and chunk indexes for the next publish's --bases.
A godot.pck lint (P4-28) refuses a resource that references an app script or a UID outside the
pack's uid cache unless .pkey/release lists it in deliverables.app.content.attachable (the
device's PKeyOptions.pack_attachable), and refuses as scripts .gd, .gdc, .cs plus
--script-extensions (bare extensions of a GDExtension script language) and the class names
--script-types gives (the device asks its engine for both).
Save compatibility (P4-20): a pack release signs the content ids it provides, from --provides or
the pack's declared provides.from (default .pkey/provides.json; provides.required fails a
publish without it); Polaris Key refuses a release that stops providing an id its predecessor
provided at a live contentApi level both support, unless --removes acknowledges it. An app
publish with --content-interface hashes that registry (canonical JSON, SHA-256), stores it with
the release and warns when it changed since the channel's current app release while contentApi
did not (--strict fails instead, before anything is uploaded).
pkey release content-stamp --hold packId@version[=reason] keeps a compatible pack at one
release for this app release (written into the stamp's holds; never a pinned pack).
pkey release revoke signs a kind: revocation release record with the release key and submits it:
devices stop using that pack release, and --replacement names the release of the same pack they
take instead. Revocations are permanent; a later revoke of the same release supersedes the
replacement or reason, never the revoked status.
pkey release keys generate --content writes a new content key (no kid) and prints its public
key; pkey release delegate signs a kind: delegation record with the release key that lets that
key sign data-only pack releases (files.tree, data.json, l10n.table) of compatible or standalone
packs under --prefix (whole segments) for --expires-in days (default 180, at most 366). A content
team then publishes with PKEY_CONTENT_KEY (or --content-key-file) and --delegation <sha256>:
the files must pass the data-only rule, and the record is signed under the kid pkd1-<sha256>.
pkey release revoke --delegation revokes a delegation and every pack release signed under it.
--meta is a JSON file {"<buildId>": {"buildNumber", "minOS", "requires"}}. An ipa or apk
payload's facts (bundle id, versions, entitlements; package, version code, ABIs, signer) are
read into the descriptor for the storefront feeds. The CI commands
exchange the job's GitHub OIDC token for a short-lived pkeyci_ token themselves; no secret
is stored in the repository. See /docs/build/ci/.

pkey distribution report tells Polaris Key what a store says until its connector exists:
availability (pending, processing, in-review, approved, live, rejected, removed) and the
submission state (prepared, submitted, in-review, approved, rejected,
pending-developer-release, released, cancelled) of a release on an outlet. report key
sends the SHA-256 fingerprint the job signed with (colons allowed); one that is not in the
product's key inventory is flagged for an operator and the command exits 1. rollout, pause,
resume, halt and complete drive the outlet rollout; --bp is basis points (2500 = 25%), and
they need a token an operator granted distribution:rollout.

pkey feeds fdroid builds the channel's F-Droid repository (index-v2.json, entry.json, a diff)
from Polaris Key's releases, signs entry.jar with apksigner and the CI-held repo key (the
password in $PKEY_FDROID_KS_PASS), uploads it and registers it; the token needs
distribution:feeds. Without --keystore it writes the unsigned files and stops.

pkey feeds prune deletes each package's builds of main (X-main.N, PyPI X.devN) below its newest
stable release, the backfill of the Worker's automatic feed retention. It is a dry run unless
--apply: it prints what would go, per package, with counts and bytes. With --apply it also lists
any version skipped (held since the plan, so kept) and exits non-zero if any version failed. The
token needs release:yank, which an operator grants.

pkey feeds setup prints the copy-paste setup for one package feed on the registry host (default
https://pkg.plrs.im), the same snippets the console's Setup tab shows: strict routing only (the
npm scope, uv explicit = true, Gradle exclusiveContent, SwiftPM --scope, a fully qualified image
reference, the Godot editor URLs). --namespace sets the feed's namespace (scope=@acme,
groupPrefixes=gg.acme,gg.acme.tools); --token-env NAME adds the credential lines, reading the
registry token from that environment variable. Offline: nothing is sent anywhere.

pkey listing assets derives every store's icons from one square icon master (Play 512, the
Microsoft tile 300, Steam's 184 JPG and 256 icons, Flathub, Snap, winget and F-Droid; Android's
adaptive layers only when the mark sits inside the central 66 of 108 dp), composes every store's
art from logo-free key art and the wordmark (Play and F-Droid feature graphics, Steam's capsules
and library set, the Microsoft super hero, poster and box art, the itch.io cover, the Snap banner;
cropped around --focal, the wordmark only on slots that allow a title), and fits each screenshot
under --screenshots (one directory per size class) for the App Store, Play, the Microsoft Store and
Steam. A screenshot that does not fit gets a crop or pad proposal, used only for the images named
with --accept or --pad. Everything goes under --out with report.json (the fit report), preview.html
and one ZIP pack per store. --upload stores the masters, outputs and packs in the listing model
(the token needs distribution:listing); nothing is pushed to a store. Needs the sharp library.

pkey transport packages a published pack release (the --out cache of pkey release publish
--deliverable <packId>, re-hashed against its record and linted again, so a pack with scripts
never reaches a store) for the transport .pkey/distribution routes it through, writes the
pkey-marker/1 marker beside the payload, and reports the transport's availability:
apple-ba package writes Manifest.json for asset pack <pack>-c<contentApi> (dots become hyphens;
every apple-ba pack is mapped at once and a collision, double hyphen or id over 64 characters is
refused before anything is written) and runs xcrun ba-package (macOS); apple-ba upload sends it
to App Store Connect with CI's key (ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY or ASC_KEY_PATH)
and records the asset pack's resource id in .pkey/asset-packs.json (commit it; a later upload
into any other resource is refused); play-pad modules writes com.android.asset-pack modules
(a #tcf_ directory per texture variant) into a Godot Android Gradle build and patches it;
steam-depot vdf writes a content-only SteamPipe build (SetLive on named branches only).

pkey storefront runs a store's vendor CLI from CI, and only as a command its CI allow-list
admits (pkey storefront allow-list prints them): itch push is butler push <dir>
<user/game>:<platform[-channel]> --userversion <v>, the target from the itch outlet's identity
(BUTLER_API_KEY in the environment); snap upload is snapcraft upload <snap> --release=<snap
channels>, only the channels the snap outlet's channels map declares, and snap upload-metadata
sends the summary, description and icon the snap carries, which snap metadata writes into
snapcraft.yaml from the listing model before the build (SNAPCRAFT_STORE_CREDENTIALS, a scoped
export-login). exec runs any other allow-listed command (steamcmd +run_app_build, whose script
may set live only a named branch; msstore publish, refused while the console has a staged
draft; BuildPatchTool -mode=UploadBinary). Each step is reported back to Polaris Key before and
after it runs (distribution:report), so the store's ledger shows it beside console steps; a step
already done in the same run is skipped. --dry-run checks and prints the command lines.
pkey storefront <store> pr writes winget's manifests (schema 1.12.0), the cask in your own
Homebrew tap (direct.homebrewTap), the Scoop feed's manifest in your own bucket
(direct.scoopBucket) or Flathub's updated manifest and MetaInfo for the channel's newest release,
and opens one pull request per version with the GitHub token in PKEY_PR_TOKEN (a CI secret,
never argv); a PR already open or merged for the version is recorded and nothing is written.
status reads the pull request's state and review labels. flathub init writes the first
submission's files, which a person opens against flathub/flathub's new-pr branch.

pkey manifest schemas writes the .pkey/ JSON Schemas into a directory, for editors in a
repository with no node_modules.

pkey bundle mints one offline activation bundle and writes it to a file (default
<product>-<first 8 of device id>.pkeybundle; --base-url defaults to ${DEFAULT_BASE_URL}).
Copy that file to the air-gapped machine and import it there.

pkey distribution outlet-ids prints the build outlet's store ids from .pkey/distribution as
one JSON object of strings (steamAppId, itchGameId, flatpakId, snapName, caskToken,
homebrewFormula, msixFamilyName, bundleId), for CI to pass to a Godot export as PKEY_OUTLET_IDS. With no
.pkey/distribution it prints {}.

Environment:
  ${ADMIN_COOKIE_ENV}   Required by \`pkey bundle\`. The console's admin session cookie, as
                      \`${ADMIN_COOKIE_NAME}=<value>\` (the bare value is accepted too).
                      The admin API is authenticated by the console's browser session —
                      there is no API token yet — so copy the cookie from an authenticated
                      console tab: devtools -> Application -> Cookies -> the console origin.
                      It is a SHORT-LIVED session credential carrying full admin authority:
                      do not commit it, and do not export it into a shared shell.
  ${CI_TOKEN_ENV}       Optional for the CI commands: a static pkeyci_ token an operator
                      issued, for CI that is not GitHub Actions. Unset in Actions, where
                      the job's OIDC token is exchanged instead.

Note: --no-config, --force and --dry-run take no value. A valueless flag swallows the next bare word, so
pass them last or as --no-config=true / --force=true / --dry-run=true.
`;
}
