/**
 * THE PR PLANE (A-18i; notes/S-15 §4.4, §6.2, §6.3, owner decision 7): the outlets Polaris Key
 * writes only through files in a GitHub repository — winget (`microsoft/winget-pkgs`), the
 * product's own Homebrew tap, its own Scoop bucket and its Flathub app repository. A change to
 * this file is a THREAT-MODEL §9 review trigger, as the CI plane's is.
 *
 *   store     repository                     the PR writes                          never
 *   winget    microsoft/winget-pkgs (fork)   manifests/<p>/<Pub>/<Pkg>/<v>/          another repository;
 *                                            <id>.yaml, .installer.yaml,             merge, close, a
 *                                            .locale.<locale>.yaml (schema 1.12.0)   branch delete
 *   homebrew  the outlet's homebrewTap       Casks/<homebrewCask>.rb                 homebrew/cask or any
 *                                                                                    Homebrew repository
 *   scoop     the outlet's scoopBucket       bucket/<app>.json                       a ScoopInstaller bucket
 *   flathub   flathub/<appId>                <appId>.yml|.yaml|.json,                flathub/flathub (the
 *                                            <appId>.metainfo.xml                    first submission is a
 *                                                                                    person's); closing the
 *                                                                                    app
 *
 * HOW IT IS ENFORCED. A PR step is described as an argv for the pseudo-tool `github`
 * (`pull-request --repo <repo> --package <id> --version <v>`), checked with the CI plane's own
 * allow-list check (`ci.ts` `checkCiCommand`): the repository is a literal (winget) or a parameter
 * bound to the outlet's identity (the tap, the bucket, the Flathub app id), so neither a workflow
 * nor a tampered CLI can point a step at another repository without the Worker refusing its
 * report. The files a step writes are path templates over the same parameters (`paths`,
 * `prPathAllowed`): the CLI refuses to write any other path, and the Worker refuses a report
 * naming one, so a ledger row never records a write outside them. The CLI's copy is generated
 * (`packages/cli/src/storefronts/ciPlane.generated.ts`, `pnpm gen:storefront-ci`).
 *
 * TOKENS (decision 7): a fine-grained GitHub token with `contents:write` and `pull_requests:write`
 * on the own tap and bucket only; for winget, a classic `public_repo` token only if A-18k shows a
 * fine-grained one cannot open the PR; for Flathub, the maintainer's token on `flathub/<appId>`.
 * Each is a CI environment secret, never in the Worker: the Worker never calls GitHub.
 *
 * NATURAL KEY (S-15 §6.3): an open or merged PR for (package, version) — winget allows "only one
 * pull request per package version". The CLI reads GitHub for it before writing anything; the
 * ledger row's natural key is `pr:<package>:<version>`.
 *
 * Pure data and pure functions (`test/boundaries.test.ts`).
 */

import type { CiAllowList, CiParam } from "./ci.js";

export const PR_STORE_IDS = ["winget", "homebrew", "scoop", "flathub"] as const;
export type PrStoreId = (typeof PR_STORE_IDS)[number];

/** The pseudo-tool a PR step names: the CLI's GitHub client, never a spawned binary. */
export const PR_TOOL = "github";

/** The commands every PR-plane store declares. */
export const PR_COMMANDS = ["pull-request", "status"] as const;
export type PrCommand = (typeof PR_COMMANDS)[number];

/**
 * A file a `pull-request` step may write: a path template whose `{param}` placeholders are the
 * command's parameters (`{param|segments}`: its dot-separated parts as directories; `{param|first}`:
 * its first character, lower-cased) and `{locale}`, any BCP 47-shaped locale.
 */
export interface PrPathRule {
  readonly template: string;
  readonly why: string;
}

export interface PrPlaneStore {
  /** The `store_operations.store` id and the storefront adapter's id. */
  readonly store: PrStoreId;
  readonly label: string;
  /** The outlet kinds whose identity binds parameters. */
  readonly outletKinds: readonly string[];
  /** How the console names the repository (`{field}`: the outlet identity's). */
  readonly repo: string;
  /**
   * True: the PR comes from a fork in the token's account (an upstream Polaris Key does not own:
   * winget). False: a branch in the repository itself (the own tap and bucket, the Flathub app
   * repository, where the maintainer has write access).
   */
  readonly fork: boolean;
  readonly list: CiAllowList;
  /** Command → the storefront operations it performs. */
  readonly commandOps: Readonly<Record<PrCommand, readonly string[]>>;
  /** What a `pull-request` may write. */
  readonly paths: readonly PrPathRule[];
  /** The parameters of the natural key: the package (cask, app, app id), then the version. */
  readonly naturalKey: readonly [string, string];
  /** Labels the verifier reports: a moderator's request for changes, and validation trouble. */
  readonly labels: {
    readonly needsAuthor: readonly string[];
    readonly validationPrefix: string | null;
    readonly validationOk: readonly string[];
  };
  /** Argv lines that must match no command (the conformance suite runs each). */
  readonly never: readonly (readonly string[])[];
  /** Lower-case substrings no literal token may contain. */
  readonly neverTokens: readonly string[];
}

// ── Shared patterns ─────────────────────────────────────────────────────────────────────────

/** A release version: also a path segment, so no `/`, no `..` start, no option. */
const VERSION = String.raw`[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}`;
/** `@polaris-key/manifest` `WINGET_ID_RE`. */
const WINGET_ID = String.raw`[A-Za-z0-9][A-Za-z0-9-]{0,31}(?:\.[A-Za-z0-9][A-Za-z0-9-]{0,31}){1,7}`;
/** `HOMEBREW_TAP_PATTERN`: never the Homebrew organisation. */
const HOMEBREW_TAP = String.raw`(?![Hh][Oo][Mm][Ee][Bb][Rr][Ee][Ww]/)[A-Za-z0-9][A-Za-z0-9-]{0,38}/homebrew-[A-Za-z0-9._-]{1,90}`;
/** `HOMEBREW_CASK_PATTERN`. */
const CASK = String.raw`[a-z0-9][a-z0-9.@-]{0,99}`;
/** `SCOOP_BUCKET_PATTERN`: never the ScoopInstaller organisation. */
const SCOOP_BUCKET = String.raw`(?![Ss][Cc][Oo][Oo][Pp][Ii][Nn][Ss][Tt][Aa][Ll][Ll][Ee][Rr]/)[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\.)[A-Za-z0-9._-]{1,100}`;
/** A Scoop app name (the manifest's file name in the bucket). */
const SCOOP_APP = String.raw`[a-z0-9][a-z0-9._-]{0,63}`;
/** A Flatpak application id (reverse-DNS, at least two dots' worth of segments). */
const FLATPAK_ID = String.raw`[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){1,7}`;
/** A locale in a path (`{locale}`). */
export const PR_LOCALE_PATTERN = String.raw`[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}`;

const param = (
  name: string,
  pattern: string,
  more: Omit<CiParam, "param" | "pattern"> = {},
): CiParam => ({ param: name, pattern, ...more });

/** `pull-request` and `status` over the same repository and natural-key parameters. */
function prCommands(
  repo: readonly (string | CiParam)[],
  rest: readonly (string | CiParam)[],
  why: string,
): CiAllowList {
  const argv = (verb: PrCommand) => [verb, "--repo", ...repo, ...rest];
  return {
    tool: PR_TOOL,
    commands: {
      "pull-request": {
        argv: argv("pull-request"),
        confirm: "plain",
        why,
      },
      status: {
        argv: argv("status"),
        confirm: "plain",
        why: "read the pull request's state and review labels (the verifier; it writes nothing)",
      },
    },
  };
}

const COMMAND_OPS = {
  "pull-request": ["uploadBuild", "release", "writeListingText"],
  status: ["status"],
} as const;

const NO_LABELS = {
  needsAuthor: [],
  validationPrefix: null,
  validationOk: [],
} as const;

// ── winget ────────────────────────────────────────────────────────────────────────────────────

export const WINGET_PR: PrPlaneStore = {
  store: "winget",
  label: "winget",
  outletKinds: ["winget"],
  repo: "microsoft/winget-pkgs",
  fork: true,
  list: prCommands(
    ["microsoft/winget-pkgs"],
    [
      "--package",
      param("package", WINGET_ID, {
        identity: { field: "packageIdentifier", match: "equal" },
      }),
      "--version",
      param("version", VERSION),
    ],
    "one version's multi-file manifest (schema 1.12.0), from a fork, for moderator review: every version is reviewed, so the flow shows the PR and never promises a date",
  ),
  commandOps: COMMAND_OPS,
  paths: [
    {
      template:
        "manifests/{package|first}/{package|segments}/{version}/{package}.yaml",
      why: "the version manifest",
    },
    {
      template:
        "manifests/{package|first}/{package|segments}/{version}/{package}.installer.yaml",
      why: "the installer manifest: HTTPS direct installer URLs from the release",
    },
    {
      template:
        "manifests/{package|first}/{package|segments}/{version}/{package}.locale.{locale}.yaml",
      why: "the default and extra locale manifests, from the listing model",
    },
  ],
  naturalKey: ["package", "version"],
  labels: {
    needsAuthor: ["Needs-Author-Feedback"],
    validationPrefix: "Validation-",
    validationOk: ["Validation-Completed"],
  },
  never: [
    [
      "pull-request",
      "--repo",
      "microsoft/winget-cli",
      "--package",
      "Vlad.Dice",
      "--version",
      "1.0.0",
    ],
    [
      "pull-request",
      "--repo",
      "microsoft/winget-pkgs",
      "--package",
      "Vlad.Dice",
    ],
    ["merge", "--repo", "microsoft/winget-pkgs", "--pr", "1"],
    ["close", "--repo", "microsoft/winget-pkgs", "--pr", "1"],
    ["delete-branch", "--repo", "microsoft/winget-pkgs", "--branch", "master"],
  ],
  neverTokens: ["merge", "close", "delete", "--force", "winget-cli"],
};

// ── Homebrew (own tap) ──────────────────────────────────────────────────────────────────────

export const HOMEBREW_PR: PrPlaneStore = {
  store: "homebrew",
  label: "Homebrew tap",
  outletKinds: ["direct"],
  repo: "{homebrewTap}",
  fork: false,
  list: prCommands(
    [
      param("repo", HOMEBREW_TAP, {
        identity: { field: "homebrewTap", match: "equal" },
      }),
    ],
    [
      "--cask",
      param("cask", CASK, {
        identity: { field: "homebrewCask", match: "equal" },
      }),
      "--version",
      param("version", VERSION),
    ],
    "the cask in the product's own tap; never homebrew/cask, which has notability rules and needs the owner",
  ),
  commandOps: COMMAND_OPS,
  paths: [{ template: "Casks/{cask}.rb", why: "the cask" }],
  naturalKey: ["cask", "version"],
  labels: NO_LABELS,
  never: [
    [
      "pull-request",
      "--repo",
      "Homebrew/homebrew-cask",
      "--cask",
      "dice",
      "--version",
      "1.0.0",
    ],
    [
      "pull-request",
      "--repo",
      "homebrew/homebrew-core",
      "--cask",
      "dice",
      "--version",
      "1.0.0",
    ],
    ["merge", "--repo", "vlad/homebrew-games", "--pr", "1"],
    ["delete-repo", "--repo", "vlad/homebrew-games"],
  ],
  neverTokens: ["merge", "close", "delete", "--force", "homebrew/"],
};

// ── Scoop (own bucket) ──────────────────────────────────────────────────────────────────────

export const SCOOP_PR: PrPlaneStore = {
  store: "scoop",
  label: "Scoop bucket",
  outletKinds: ["direct"],
  repo: "{scoopBucket}",
  fork: false,
  list: prCommands(
    [
      param("repo", SCOOP_BUCKET, {
        identity: { field: "scoopBucket", match: "equal" },
      }),
    ],
    ["--app", param("app", SCOOP_APP), "--version", param("version", VERSION)],
    "the Scoop feed's manifest, with checkver and autoupdate, in the product's own bucket",
  ),
  commandOps: COMMAND_OPS,
  paths: [{ template: "bucket/{app}.json", why: "the app manifest" }],
  naturalKey: ["app", "version"],
  labels: NO_LABELS,
  never: [
    [
      "pull-request",
      "--repo",
      "ScoopInstaller/Main",
      "--app",
      "dice",
      "--version",
      "1.0.0",
    ],
    [
      "pull-request",
      "--repo",
      "scoopinstaller/extras",
      "--app",
      "dice",
      "--version",
      "1.0.0",
    ],
    ["merge", "--repo", "vlad/scoop-games", "--pr", "1"],
  ],
  neverTokens: ["merge", "close", "delete", "--force", "scoopinstaller"],
};

// ── Flathub (the app's repository; the first submission is a person's) ─────────────────────

export const FLATHUB_PR: PrPlaneStore = {
  store: "flathub",
  label: "Flathub",
  outletKinds: ["flathub"],
  repo: "flathub/{appId}",
  fork: false,
  list: prCommands(
    [
      param("repo", FLATPAK_ID, {
        prefix: "flathub/",
        identity: { field: "appId", match: "equal" },
      }),
    ],
    ["--version", param("version", VERSION)],
    "an update PR to the app's own repository (updates never need submission review); the first submission to flathub/flathub is opened and shepherded by a person",
  ),
  // The MetaInfo carries the screenshots and the OARS rating too.
  commandOps: {
    "pull-request": [
      ...COMMAND_OPS["pull-request"],
      "writeListingAssets",
      "contentRating",
    ],
    status: COMMAND_OPS.status,
  },
  paths: [
    { template: "{repo}.yml", why: "the manifest (YAML)" },
    { template: "{repo}.yaml", why: "the manifest (YAML)" },
    { template: "{repo}.json", why: "the manifest (JSON)" },
    {
      template: "{repo}.metainfo.xml",
      why: "the MetaInfo: listing text, screenshots, releases, OARS rating, branding",
    },
  ],
  naturalKey: ["repo", "version"],
  labels: NO_LABELS,
  never: [
    ["pull-request", "--repo", "flathub/flathub", "--version", "1.0.0"],
    ["pull-request", "--repo", "vlad/gg.vlad.Dice", "--version", "1.0.0"],
    ["archive", "--repo", "flathub/gg.vlad.Dice"],
    ["close", "--repo", "flathub/gg.vlad.Dice", "--pr", "1"],
  ],
  neverTokens: ["merge", "close", "delete", "archive", "--force", "new-pr"],
};

/** THE PR PLANE: one row per store. */
export const PR_PLANE: readonly PrPlaneStore[] = [
  WINGET_PR,
  HOMEBREW_PR,
  SCOOP_PR,
  FLATHUB_PR,
];

/** A PR-plane store by id, or null. */
export function prPlaneStore(store: string): PrPlaneStore | null {
  return PR_PLANE.find((s) => s.store === store) ?? null;
}

// ── Paths ───────────────────────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The regular expression a path template becomes for the given parameter values, or null when
 * the template names a parameter that has no value.
 */
export function prPathPattern(
  template: string,
  values: Readonly<Record<string, string>>,
): RegExp | null {
  let missing = false;
  const source = template
    .split(/(\{[A-Za-z]+(?:\|[a-z]+)?\})/)
    .map((part) => {
      const m = /^\{([A-Za-z]+)(?:\|([a-z]+))?\}$/.exec(part);
      if (!m) return escapeRe(part);
      const [, name, filter] = m;
      if (name === "locale") return PR_LOCALE_PATTERN;
      const v = values[name!];
      if (v === undefined || v === "") {
        missing = true;
        return "";
      }
      if (filter === "segments") return escapeRe(v.split(".").join("/"));
      if (filter === "first") return escapeRe(v.charAt(0).toLowerCase());
      return escapeRe(v);
    })
    .join("");
  return missing ? null : new RegExp(`^${source}$`);
}

/** The values of a command's named parameters in `argv` (after their prefixes). */
export function prParams(
  list: CiAllowList,
  command: string,
  argv: readonly string[],
): Record<string, string> {
  const rule = list.commands[command];
  const out: Record<string, string> = {};
  if (!rule) return out;
  rule.argv.forEach((a, i) => {
    if (typeof a === "string" || argv[i] === undefined) return;
    out[a.param] = argv[i]!.slice((a.prefix ?? "").length);
  });
  return out;
}

/** Whether `path` is one a `pull-request` with this (already allow-listed) argv may write. */
export function prPathAllowed(
  store: PrPlaneStore,
  argv: readonly string[],
  path: string,
): boolean {
  if (path.length > 512 || path.includes("..") || path.startsWith("/"))
    return false;
  const values = prParams(store.list, "pull-request", argv);
  return store.paths.some(
    (rule) => prPathPattern(rule.template, values)?.test(path) ?? false,
  );
}

/** The ledger natural key of a PR step: `pr:<package>:<version>`. */
export function prNaturalKey(
  store: PrPlaneStore,
  command: string,
  argv: readonly string[],
): string | null {
  const values = prParams(store.list, command, argv);
  const [pkg, version] = store.naturalKey.map((k) => values[k]);
  return pkg && version ? `pr:${pkg}:${version}` : null;
}

/** The repository a step's argv targets (`owner/name`). */
export function prRepo(
  store: PrPlaneStore,
  command: string,
  argv: readonly string[],
): string | null {
  const rule = store.list.commands[command];
  if (!rule) return null;
  const i = rule.argv.indexOf("--repo");
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
}

/**
 * The verifier's reading of a pull request (S-15 §4.4: "PR state and labels such as
 * `Validation-Domain` and `Needs-Author-Feedback`"). Never a date: every winget version is
 * moderator-reviewed, so the console shows the PR and its verdict.
 */
export type PrVerdict =
  | "merged"
  | "closed"
  | "needs-author-feedback"
  | "validation-issue"
  | "in-review";
export const PR_VERDICTS: readonly PrVerdict[] = [
  "merged",
  "closed",
  "needs-author-feedback",
  "validation-issue",
  "in-review",
];

export function prVerdict(
  store: PrPlaneStore,
  pr: { state: "open" | "closed"; merged: boolean; labels: readonly string[] },
): PrVerdict {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.labels.some((l) => store.labels.needsAuthor.includes(l)))
    return "needs-author-feedback";
  const prefix = store.labels.validationPrefix;
  if (
    prefix !== null &&
    pr.labels.some(
      (l) => l.startsWith(prefix) && !store.labels.validationOk.includes(l),
    )
  )
    return "validation-issue";
  return "in-review";
}
