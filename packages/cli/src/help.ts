/**
 * `pkey`'s help and shell completion (UK-14; docs/design/UI-KITS.md §1.4, §5.1 Node row): one
 * command table drives the grouped overview (`pkey`, `pkey help`, `pkey --help`), each command's
 * own help (`pkey <command> --help`, `pkey help <command>`) and the bash, zsh and fish completion
 * scripts, so none of them can drift from the others. The layout follows the Node SDK kit's help
 * (`@polaris-key/node`'s cli/help.ts): a header, the usage, groups under strong headings with the
 * terms in two columns, the common options, a muted footer; 80 columns, legible at 60.
 *
 * pkey is a developer tool: its words are English and live here, not in the kit's copy catalog.
 */

import { CHANNELS, SERVICE_SLUGS, isOutletKind } from "@polaris-key/manifest";
import { cellWidth, wrapSpans, type Line } from "@polaris-key/node/terminal";
import { ADMIN_TOKEN_ENV, DEFAULT_BASE_URL } from "./bundle.js";
import { CI_TOKEN_ENV } from "./oidc.js";
import { LOGO_COLS, LOGO_STAR_GLYPH, logoLines, logoMode } from "./logo.js";
import type { Term } from "./terminal.js";
import { CLI_VERSION } from "./version.js";

/** The channels `pkey channel add` takes: those with an outlet kind. */
export const ADDABLE_CHANNELS: readonly string[] = CHANNELS.filter((c) =>
  isOutletKind(c.outlet.kind),
).map((c) => c.id);

export type GroupId =
  | "account"
  | "manifest"
  | "sdk"
  | "bundles"
  | "ci"
  | "distribution"
  | "feeds"
  | "listing"
  | "transport"
  | "storefront"
  | "shell";

/** The overview's groups, in order, with their headings. */
export const GROUPS: ReadonlyArray<readonly [GroupId, string]> = [
  ["account", "Account"],
  ["manifest", "Manifest"],
  ["sdk", "SDK and tools"],
  ["bundles", "Offline bundles"],
  ["ci", "CI release"],
  ["distribution", "Distribution"],
  ["feeds", "Feeds"],
  ["listing", "Listing and assets"],
  ["transport", "Transport"],
  ["storefront", "Channels"],
  ["shell", "Shell"],
];

/** A paragraph of a command's help; `subs` limits it to those subcommands' help. */
interface Para {
  subs?: readonly string[];
  text: string;
}

/** The two values a command can take from the working directory and the environment. */
export type ContextKey = "product" | "baseUrl";

export interface PkeyCommand {
  /** The word after `pkey`. */
  name: string;
  group: GroupId;
  /** Whether the command has `--json`: declared by every command, never inferred (P0-45). */
  json: boolean;
  /**
   * Flags that never take a value, so they never swallow the next word (`validate --json dir`).
   * Parse reads the union over the table.
   */
  valueless?: readonly string[];
  /**
   * The values `--product` and `--base-url` default to when absent: `product` from the nearest
   * `.pkey/product`, `baseUrl` from `PKEY_BASE_URL`. Only a command that takes the flag lists it.
   */
  context?: readonly ContextKey[];
  /**
   * The publish Action's inputs 0.9 removed that this command used to receive, as input name to the
   * flag that replaces it. `action.ts` refuses each with that flag (`REMOVED_INPUTS`); a test holds
   * each flag to the command's usage and keeps the eight current inputs out of the table.
   */
  action?: Readonly<Record<string, string>>;
  /** One line: what the command is for (its help's header, and completion's description). */
  summary: string;
  /** The overview's rows: the words as typed after `pkey`, and what they do. */
  rows: ReadonlyArray<readonly [string, string]>;
  /** The literal words below the command (completion and per-subcommand help). */
  tree?: Readonly<Record<string, readonly string[]>>;
  /** The usage lines, one logical line each (wrapped when printed). */
  usage: readonly string[];
  about?: readonly Para[];
  /** Paragraphs for the docs reference page only (shapes too long for a terminal). */
  reference?: readonly Para[];
  /** Environment variables the command reads; `subs` limits one to those subcommands' help. */
  env?: readonly EnvVar[];
}

interface EnvVar {
  name: string;
  text: string;
  subs?: readonly string[];
}

/** An Action input that picks the step (or carries the map) rather than becoming a flag. */
export const STEP = "(step)";

const CI_PARA =
  "A CI command runs in GitHub Actions with permissions: id-token: write, or with " +
  `${CI_TOKEN_ENV}. The CI commands exchange the job's GitHub OIDC token for a short-lived ` +
  "pkeyci_ token themselves; no secret is stored in the repository. --product defaults to " +
  "the nearest .pkey/product and --base-url to $PKEY_BASE_URL, else key.plrs.im. See " +
  "/docs/build/ci/.";

const CI_ENV: EnvVar = {
  name: CI_TOKEN_ENV,
  text:
    "Optional for the CI commands: a static pkeyci_ token an operator issued, for CI that is " +
    "not GitHub Actions. Unset in Actions, where the job's OIDC token is exchanged instead.",
};

const TOKEN_ENV: EnvVar = {
  name: ADMIN_TOKEN_ENV,
  text:
    "Used instead of the sign-in pkey login saved: a personal token (pkeyp_...) or an admin " +
    "API token (pkeya_...) with the bundles:mint scope, sent as Authorization: Bearer. Make an " +
    "API token in the console under API tokens; its value is shown once, when you make it. It " +
    "can be revoked on its own and ends on the date you chose. Do not commit it or export it " +
    "into a shared shell.",
};

const ciEnvFor = (subs: readonly string[]): EnvVar => ({ ...CI_ENV, subs });

const STORE_SUBS = ["winget", "homebrew", "scoop", "flathub"] as const;

/** Every command, in overview order. */
export const COMMANDS: readonly PkeyCommand[] = [
  {
    name: "login",
    group: "account",
    json: true,
    valueless: ["json", "no-browser"],
    context: ["baseUrl"],
    summary: "Sign in to the console from this terminal",
    rows: [["login", "Sign in to the console from this terminal"]],
    usage: ["pkey login [--base-url url] [--no-browser] [--json]"],
    about: [
      {
        text:
          "Shows a code, opens the console's approval page in your browser (not over SSH, " +
          "without a display or with --no-browser: it prints the link instead) and waits. Check " +
          "that the code in your browser matches the one here before you approve: it is how " +
          "you know the request is yours. On approval a personal token (admin, 7 days) goes " +
          "to your operating system's credential store, bound to the origin that issued it. " +
          "The token is never printed. Keys: Enter opens the page again, c copies the code " +
          "(not over SSH), Esc cancels.",
      },
      {
        text:
          "A second pkey login ends the token it replaces once the new one is saved; if you " +
          "cancel, are denied, run out of time or lose the network, the old sign-in keeps " +
          "working. It refuses (exit 4) in CI, where PKEY_ADMIN_TOKEN is the credential; " +
          "without a credential store; and when you already have the most personal tokens " +
          "allowed (revoke one at Personal tokens, then run it again). A code canceled in the " +
          "browser exits 4; an expired code, an unreachable console or a credential store that " +
          "won't save exits 1. Esc and Ctrl+D cancel and exit 1; Ctrl+C exits 130. A base " +
          "URL that is not https is exit 2 (http works only on localhost).",
      },
      {
        text:
          "--json prints one line when the code is ready, " +
          '{"v":1, "command":"login", "event":"started", "host", "code", "url", "expiresIn", ' +
          '"replaces"}, then one result line, {"v":1, "command":"login", "event":"result", ' +
          '"ok", "exit"} with name, email, roles, token (no secret), storedIn and replaced on ' +
          "success, or error and message. error is denied, expired, token_limit, cancelled, " +
          "interrupted, refused, network, server-error, store-failed, usage or internal. " +
          "It never prompts or opens a browser.",
      },
    ],
  },
  {
    name: "whoami",
    group: "account",
    json: true,
    context: ["baseUrl"],
    summary: "Show who pkey is signed in as",
    rows: [["whoami", "Show who pkey is signed in as"]],
    usage: ["pkey whoami [--base-url url] [--json]"],
    about: [
      {
        text:
          "Prints the person, their roles and when the sign-in ends. The token is never " +
          "printed. It reads the sign-in stored for the origin (--base-url), or " +
          `${ADMIN_TOKEN_ENV} when that is set to a personal token (pkeyp_).`,
      },
      {
        text:
          "--json prints one line, the result line: " +
          '{"v":1, "command":"whoami", "event":"result", "ok", "exit", "host", "name", ' +
          '"email", "roles", "token"}, with role ids. A refusal is {"ok":false, "exit":4, ' +
          '"error", "message"}: not-signed-in, sign-in-ended, sign-in-refused, ' +
          "no-credential-store, keychain-refused, admin-api-token, env-token-refused or " +
          "redirect. A failure is exit 1: network, server-error or not-a-console. A base " +
          "URL that is not https is exit 2, error usage.",
      },
    ],
    env: [
      {
        name: ADMIN_TOKEN_ENV,
        text: "A personal token (pkeyp_), used instead of the stored sign-in.",
      },
    ],
  },
  {
    name: "logout",
    group: "account",
    json: true,
    context: ["baseUrl"],
    summary: "Revoke the stored sign-in and remove it",
    rows: [["logout", "Revoke the stored sign-in and remove it"]],
    usage: ["pkey logout [--base-url url] [--json]"],
    about: [
      {
        text:
          "Revokes the stored token on the server, then removes it from the credential " +
          "store. The stored sign-in is per operating-system user and origin (--base-url). " +
          "If the server can't be reached, or won't revoke the token, the stored copy is " +
          "still removed, and pkey says the token works until its end date and where to " +
          "revoke it. That exits 1. It refuses (exit 4) while " +
          `${ADMIN_TOKEN_ENV} is set: pkey only ends a sign-in it stored.`,
      },
      {
        text:
          "--json prints one line, the result line: " +
          '{"v":1, "command":"logout", "event":"result", "ok", "exit", "host", "revoked", ' +
          '"cleared"}. ' +
          "When the token still works it adds error (network, redirect, revoke-refused or " +
          "server-error), message, tokenEndsAt and revokeUrl.",
      },
    ],
  },
  {
    name: "init",
    group: "manifest",
    json: false,
    summary: "Scaffold .pkey/ in this directory",
    rows: [["init", "Scaffold .pkey/ in this directory"]],
    usage: [
      "pkey init [--product slug] [--name name] [--modules slugs] " +
        "[--release-owner owner] [--release-repo repo] [--starter-tier free|none] [--force]",
    ],
    about: [
      {
        text:
          "Writes product.yaml and schema.yaml, and release.yaml when Release is on. It stops " +
          "when product.yaml or schema.yaml exists, unless you pass --force, which overwrites them. On a terminal it asks what the product " +
          "is for and whether to start with a Free tier; --modules and --starter-tier answer instead.",
      },
      {
        text:
          `--modules takes service slugs (${SERVICE_SLUGS.join(", ")}); the default is ` +
          "license,config. --starter-tier none leaves out the Free tier (default free, with License). The old names licensing, releases, oidc and edgeMint still work. " +
          "--product (or --slug) defaults to the directory name, --name to that name in title case.",
      },
    ],
  },
  {
    name: "validate",
    group: "manifest",
    json: true,
    valueless: ["json", "fix"],
    summary: "Check .pkey/ with the rules the platform applies",
    rows: [
      ["validate [path]", "Check .pkey/ with the rules the platform applies"],
    ],
    usage: ["pkey validate [path] [--fix] [--json]"],
    about: [
      {
        text:
          "Checks .pkey/ with the rules the platform applies. Prints the verdict, the " +
          "features it turns on and the secrets it needs, then each warning and error with " +
          "the file and field it points at. Exits 1 when it is invalid. path is relative to " +
          "here; the default is here.",
      },
      {
        text:
          "--fix moves a field written in an old spelling to its new place when that place " +
          "is empty. It keeps your comments, never overwrites a value, and prints each move.",
      },
      {
        text: "--json prints one line instead; its shape is at /docs/reference/cli/#validate.",
      },
    ],
    reference: [
      {
        text:
          "--json prints one JSON line on stdout, the terminal kits' result line, its fields " +
          'beside the envelope\'s: {"v":1,"command":"validate","event":"result","ok","exit","valid",' +
          '"modules","requiredSecrets","warnings","errors"}, each warning and error as ' +
          '{"code","message","at","file"}. With --fix, "fixed" lists the moves. When no manifest ' +
          'can be read it is {"v":1,"command":"validate","event":"result","ok":false,"exit":1,' +
          '"error":"no-manifest","message"}, or "error":"unreadable-manifest" when a file is ' +
          "not valid JSON or YAML.",
      },
    ],
  },
  {
    name: "doctor",
    group: "manifest",
    json: true,
    valueless: ["json"],
    context: ["product", "baseUrl"],
    summary: "Check .pkey/ and the live product",
    rows: [["doctor", "Check .pkey/ and the live product"]],
    usage: ["pkey doctor [--product slug] [--base-url url] [--json]"],
    about: [
      {
        text:
          "pkey doctor checks the product in four parts and always runs all of them: Manifest " +
          "(.pkey/, the services the server enables, who is signed in, polaris-key.json), Keys " +
          "(the signing and release key ids), Integration (per feature and platform Verified, " +
          "Waiting or Not seen yet, with CI and Commerce) and Left to do, each with its fix. " +
          "The product is --product, else the nearest .pkey/product; discovery is its " +
          ".well-known/polaris.json under the base URL (--base-url, else $PKEY_BASE_URL, " +
          "else key.plrs.im). Outside a repository it still checks sign-in, the base URL " +
          "and polaris-key.json.",
      },
      {
        text:
          "Signed in is pkey login, or $PKEY_ADMIN_TOKEN. Signed out, or refused access, is a " +
          "warning, and signed out makes no console request. The summary counts what is to do " +
          "and what is a warning, then the run time. It exits 1 while anything is to do: a " +
          "manifest error, a failed discovery or an open console step.",
      },
      {
        text:
          "--json prints one result line with the same facts: " +
          '{"v":1, "command":"doctor", "event":"result", "ok", "exit", "product", "baseUrl", ' +
          '"facts", "summary", "services", "signing", "keys"}. Each fact is ' +
          '{"id", "state", "detail"} with id manifest, discovery, services, signing-keys or ' +
          "config-file and state ok, warn or todo; a network failure also carries " +
          '"code":"network". "summary" is {"todo", "warnings"}. "signedIn" has state in, ' +
          'out, ended or unreadable and when it ends; "integration" has state ok, skipped, ' +
          "denied or unavailable, and ok carries features, platforms, ci, commerce and todo.",
      },
    ],
  },
  {
    name: "manifest",
    group: "manifest",
    json: false,
    summary: "Write the .pkey/ JSON Schemas for editors",
    rows: [["manifest schemas", "Write the .pkey/ JSON Schemas for editors"]],
    tree: { schemas: [] },
    usage: ["pkey manifest schemas --out dir"],
    about: [
      {
        text:
          "pkey manifest schemas writes the .pkey/ JSON Schemas into a directory, for editors " +
          "in a repository with no node_modules.",
      },
    ],
  },
  {
    name: "sdk",
    group: "sdk",
    json: false,
    summary: "Print an SDK snippet, or one SDK's config file",
    rows: [["sdk", "Print an SDK snippet, or one SDK's config file"]],
    usage: [
      "pkey sdk --product slug [--base-url url] [--kid kid --public-key key]",
      "pkey sdk add node|react|python|swift|kotlin|godot --expect kid@sha256:fingerprint[,...] " +
        "[--product slug] [--base-url url] [--out path] [--force] " +
        "[--release-key kid=key ...] [--package kotlin.package]",
      "pkey sdk --lang node|react|python|swift|kotlin|godot [--product slug] [--base-url url] " +
        "[--write [--out path] [--force]] [--kid kid --public-key key] " +
        "[--release-key kid=key ...] [--package kotlin.package] [--dev [--url origin]]",
    ],
    valueless: ["dev"],
    about: [
      {
        text:
          "pkey sdk add writes the SDK's config file and prints the install and the start. It " +
          "refuses unless discovery serves exactly the pins --expect names, by fingerprint " +
          "(copy them from the console's Integration page): it never trusts discovery first. " +
          "Without --lang, pkey sdk prints a Node example with the pins given. With --lang it " +
          "reads the product's discovery (and, in the product's repo, .pkey/release's " +
          "releaseKeys) and prints that SDK's config file; --write writes it to the SDK's " +
          "default path or --out, and --force replaces a file pkey sdk did not write. For Godot " +
          "the file is polaris_key.tres beside project.godot: the product, base URL, pins, " +
          "release keys and services go into it and its other properties stay. --dev " +
          "reads the product, origin and release keys from a running pkey dev (--url, else " +
          "./polaris-key.json) instead.",
      },
    ],
  },
  {
    name: "dev",
    group: "sdk",
    json: true,
    valueless: ["json", "auto-approve", "builtin", "no-write"],
    summary: "Run a local Polaris Key to build against",
    rows: [
      ["dev", "Run a local Polaris Key with a seeded product and test keys"],
      ["dev expire|disable|revoke|restore key", "Change a test key's state"],
      ["dev fill-seats key", "Fill a test key's device limit"],
      ["dev config name json", "Set a config value on the test keys"],
      ["dev release version", "Publish a signed release"],
      ["dev offline|online", "Drop requests, or answer them again"],
      ["dev keys|status", "Print the test keys, or the server's state"],
    ],
    tree: {
      keys: [],
      status: [],
      expire: [],
      disable: [],
      revoke: [],
      restore: [],
      "fill-seats": [],
      config: [],
      release: [],
      offline: [],
      online: [],
    },
    usage: [
      "pkey dev [--port n] [--auto-approve] [--builtin] [--out file | --no-write] [--json]",
      "pkey dev keys|status [--url origin] [--json]",
      "pkey dev expire|disable|revoke|restore|fill-seats key [--url origin]",
      "pkey dev config name json [--key key] [--url origin]",
      "pkey dev release version [--channel stable|beta|name] [--url origin]",
      "pkey dev offline|online [--url origin]",
    ],
    about: [
      {
        text:
          "pkey dev runs the Worker's real router in this process (Node 22.13 or newer; no " +
          "account, no secrets, no install) on 127.0.0.1:8787. It seeds the product in " +
          "./.pkey/, else the built-in Tidewater Studio, with throwaway signing and release " +
          "keys, a license key for each state (ok, expired, disabled, revoked, " +
          "device-limit-full, key-entry-limit, floating), a fake identity provider, and a " +
          "signed release on stable and beta. It writes polaris-key.json and prints the pins; " +
          "nothing outlives the process. --auto-approve signs people in without the approval " +
          "page; --builtin ignores ./.pkey/. The control commands act on a running server: " +
          "--url names it (default: the baseUrl in ./polaris-key.json, else " +
          "http://127.0.0.1:8787). Run Polaris Key locally: /docs/build/local/.",
      },
    ],
  },
  {
    name: "trust",
    group: "sdk",
    json: false,
    summary: "Show a signing key pinned in every SDK's config file",
    rows: [["trust", "Show a signing key pinned in every SDK's config file"]],
    usage: ["pkey trust --kid kid --public-key key"],
  },
  {
    name: "mirror",
    group: "sdk",
    json: false,
    summary: "Write typed catalog mirrors for each language",
    rows: [["mirror", "Write typed catalog mirrors for each language"]],
    usage: [
      "pkey mirror --lang ts,python,swift,gdscript,kotlin [--out-dir dir] [--catalog file | " +
        "--product slug [--base-url url]] [--package kotlin.package] [--check]",
    ],
    about: [
      {
        text: "--check writes nothing and exits 1 when a mirror is stale (a CI drift gate).",
      },
    ],
  },
  {
    name: "bundle",
    group: "bundles",
    json: true,
    valueless: ["json"],
    context: ["product", "baseUrl"],
    summary: "Mint an offline activation bundle for one device",
    rows: [["bundle", "Mint an offline activation bundle for one device"]],
    usage: [
      "pkey bundle --product slug --device id --grace-days n [--no-config] [--license id] " +
        "[--base-url url] [--out file] [--force] [--json]",
    ],
    about: [
      {
        text:
          "pkey bundle mints one offline activation bundle and writes it to a file (default " +
          "<product>-<first 8 of device id>.pkeybundle; --base-url defaults to " +
          `${DEFAULT_BASE_URL}). Copy that file to the air-gapped device and import it there.`,
      },
      {
        text:
          "--base-url must be https:, or http:// on localhost or 127.0.0.1 for local " +
          "development: the token is sent to whatever origin you name, so any other origin " +
          "is refused before anything is sent. The file is written with mode 0600, is never " +
          "created over an existing one without --force, and is never written through a " +
          "symbolic link.",
      },
      {
        text:
          "--json prints one line, the result: the bundle id, the file, the device, the grace " +
          "days and the documents it carries; on a failure, the error and its message.",
      },
    ],
    env: [TOKEN_ENV],
  },
  {
    name: "migrate",
    group: "bundles",
    json: true,
    valueless: ["json"],
    context: ["baseUrl"],
    summary: "Dry-run a data migration and read its report",
    rows: [
      ["migrate list", "List the data-migration jobs and their latest runs"],
      [
        "migrate dry-run job",
        "Plan a job and store the report; changes no data",
      ],
      ["migrate report run", "Show a stored report"],
    ],
    tree: { list: [], "dry-run": [], report: [] },
    usage: [
      "pkey migrate list [--base-url url] [--json]",
      "pkey migrate dry-run job [--base-url url] [--json]",
      "pkey migrate report run [--base-url url] [--json]",
    ],
    about: [
      {
        text:
          "pkey migrate reads a deployment's data-migration runner: the jobs, a run's report and a " +
          "dry run (which changes no data). A job's changes are applied, and undone, from the " +
          "console, pinned to a report this command printed: both need a recent sign-in that an " +
          "admin API token cannot give.",
      },
    ],
    env: [
      {
        name: ADMIN_TOKEN_ENV,
        text:
          "Instead of the sign-in `pkey login` saved: a personal token (`pkeyp_...`), or an admin " +
          "API token (`pkeya_...`) with the `migrations:report` scope. Mint one in the console: " +
          "/manage -> API tokens -> New token. An API token reaches the migration job list, " +
          "reports and dry runs, and nothing else.",
      },
    ],
  },
  {
    name: "auth",
    group: "ci",
    json: false,
    context: ["product", "baseUrl"],
    summary: "Exchange the job's OIDC token for a CI token",
    rows: [
      ["auth github-oidc", "Exchange the job's OIDC token for a CI token"],
    ],
    tree: { "github-oidc": [] },
    usage: ["pkey auth github-oidc --product slug [--base-url url]"],
    about: [
      {
        text:
          "pkey auth github-oidc exchanges the Actions job's OIDC token for a pkeyci_ token, " +
          `masks it, and writes ${CI_TOKEN_ENV} to $GITHUB_ENV for the job's later steps.`,
      },
      { text: CI_PARA },
    ],
    env: [CI_ENV],
  },
  {
    name: "ci",
    group: "ci",
    json: true,
    summary: "Set up publishing from GitHub Actions",
    rows: [["ci init", "Write the release workflow and a release key"]],
    tree: { init: [] },
    usage: [
      "pkey ci init [--channel c] [--dir d] [--action-ref sha] [--force] [--json]",
    ],
    about: [
      {
        text:
          "ci init writes .github/workflows/release.yml (a v* tag publishes to --channel, " +
          "default stable, from --dir, default dist) and refuses an existing file without " +
          "--force. When .pkey/release declares no release key it makes one: the public half " +
          "goes into .pkey/release, the private half into a 0600 file under " +
          "$XDG_CONFIG_HOME/pkey/release-keys (default ~/.config), outside the repo. It " +
          "prints the gh secret set line and never runs gh. The Action is pinned to " +
          "--action-ref, a full commit SHA; without it the workflow holds " +
          "a commit-sha placeholder for you to replace.",
      },
    ],
  },
  {
    name: "release",
    group: "ci",
    json: false,
    context: ["product", "baseUrl"],
    action: {
      product: "--product",
      deliverable: "--deliverable",
      version: "--version",
      tag: "--tag",
      channel: "--channel",
      dir: "--dir",
      source: "--source",
      meta: "--meta",
      delegation: "--delegation",
      "min-supported-seq": "--min-supported-seq",
      "content-stamp": "--content-stamp",
      embedded: "--embedded",
      pins: "--pin",
      out: "--out",
      bases: "--bases",
      "script-extensions": "--script-extensions",
      "script-types": "--script-types",
    },
    summary: "Publish, sign and move releases from CI",
    rows: [
      ["release publish", "Publish an app or pack release from build output"],
      ["release content-stamp", "Write the pkey-content.json a build embeds"],
      ["release revoke", "Revoke a pack release or a delegation"],
      ["release keys generate", "Generate a release key or a content key"],
      ["release delegate", "Let a content key sign data-only pack releases"],
      ["release promote", "Point a release track at a release"],
      [
        "release pin|unpin",
        "Hold a release track on one release, or let it move",
      ],
      ["release yank", "Withdraw a release"],
    ],
    tree: {
      publish: [],
      "content-stamp": [],
      revoke: [],
      keys: ["generate"],
      delegate: [],
      promote: [],
      pin: [],
      unpin: [],
      yank: [],
    },
    usage: [
      "pkey release publish --product slug --version v --dir path [--deliverable app] " +
        "[--tag vX.Y.Z] [--channel c] [--source r2|github] [--meta builds.json] " +
        "[--base-url url] [--release-key-file pem] [--min-supported-seq n] [--no-record] " +
        "[--content-stamp file | --embedded dir --pin pack@v ...] " +
        "[--content-interface registry.json [--strict]] [--dry-run]",
      "pkey release publish --product slug --version v --dir path --deliverable packId " +
        "[--out dir] [--bases dir] [--release-key-file pem] [--base-url url] [--dry-run] " +
        "[--content-key-file pem --delegation sha256] [--provides ids.json] " +
        "[--removes id[,id...] ...] [--script-extensions ext[,ext...]] " +
        "[--script-types Type[,Type...]]",
      "pkey release content-stamp --product slug --out pkey-content.json [--embedded dir] " +
        "[--pin packId@version ...] [--hold packId@version[=reason] ...] [--base-url url]",
      "pkey release revoke packId@version --reason text --product slug " +
        "[--replacement version] [--release-key-file pem] [--base-url url] [--dry-run]",
      "pkey release revoke --delegation sha256|file --reason text --product slug " +
        "[--release-key-file pem] [--base-url url] [--dry-run]",
      "pkey release keys generate --kid kid --out file [--force]",
      "pkey release keys generate --content --out file",
      "pkey release delegate --product slug --prefix packId --types type,... --public-key key " +
        "[--expires-in days] [--notes text] [--release-key-file pem] [--base-url url] " +
        "[--dry-run]",
      "pkey release promote|pin releaseId --channel c --product slug [--deliverable id]",
      "pkey release unpin --channel c --product slug [--deliverable id]",
      "pkey release yank releaseId --reason text --product slug",
    ],
    about: [
      {
        subs: ["publish"],
        text:
          "pkey release publish matches the files under --dir against .pkey/release's " +
          "deliverables.app.artifacts map (<file>.sig and <file>.sha256 ride along as " +
          "sidecars), hashes them, uploads what Polaris Key does not already hold, and submits " +
          "the release descriptor. --dry-run prints the descriptor and the server's verdict and " +
          "uploads and writes nothing.",
      },
      {
        subs: ["publish", "keys"],
        text:
          "With a release key (PKEY_RELEASE_KEY, or --release-key-file) it also signs the " +
          "release record (pkey-release+jws) under the .pkey/release releaseKeys entry whose " +
          "public key matches, checks it, and submits it with the descriptor; a dry run prints " +
          "the record unsigned. pkey release keys generate writes a new private release key to " +
          "--out and prints its releaseKeys entry.",
      },
      {
        subs: ["publish", "content-stamp"],
        text:
          "When .pkey/release declares packs, an app publish states its pins: --content-stamp " +
          "is the pkey-content.json pkey release content-stamp wrote before the export (from " +
          "the pkey-marker/1 markers under --embedded, verified, and --pin packId@version " +
          "resolved through Polaris Key), and each build's embeds come from the artifact map; " +
          "both go into the descriptor, which the record is moved from.",
      },
      {
        subs: ["publish"],
        text:
          "--deliverable <packId> publishes a pack: per declared variant, the payload at " +
          '<dir>/<variant key or "default">/ (one .pck file, or the tree), checked, stripped ' +
          "of project.binary and the class cache, linted, indexed (pkey-files/1), with a full " +
          "object, file blobs, a gaps object and deltas against the releases --bases keeps " +
          "(zstd >= 1.5.5 on PATH), and for a PCK variant of 4 MiB or more a pkey-chunks/1 " +
          "chunk index with chunk bundles shared along the --bases chain (patch.strategies " +
          "chunk, discovery release.chunks); it signs the pack record, uploads in stage rounds, " +
          "submits it, and writes a marker beside each payload. --out keeps the record, " +
          "payloads and chunk indexes for the next publish's --bases.",
      },
      {
        subs: ["publish"],
        text:
          "A godot.pck lint (P4-28) refuses a resource that references an app script or a UID " +
          "outside the pack's uid cache unless .pkey/release lists it in " +
          "deliverables.app.content.attachable (the device's PKeyOptions.pack_attachable), and " +
          "refuses as scripts .gd, .gdc, .cs plus --script-extensions (bare extensions of a " +
          "GDExtension script language) and the class names --script-types gives (the device " +
          "asks its engine for both).",
      },
      {
        subs: ["publish"],
        text:
          "Save compatibility (P4-20): a pack release signs the content ids it provides, from " +
          "--provides or the pack's declared provides.from (default .pkey/provides.json; " +
          "provides.required fails a publish without it); Polaris Key refuses a release that " +
          "stops providing an id its predecessor provided at a live contentApi level both " +
          "support, unless --removes acknowledges it. An app publish with --content-interface " +
          "hashes that registry (canonical JSON, SHA-256), stores it with the release and warns " +
          "when it changed since the channel's current app release while contentApi did not " +
          "(--strict fails instead, before anything is uploaded).",
      },
      {
        subs: ["content-stamp"],
        text:
          "pkey release content-stamp --hold packId@version[=reason] keeps a compatible pack at " +
          "one release for this app release (written into the stamp's holds; never a pinned " +
          "pack).",
      },
      {
        subs: ["revoke"],
        text:
          "pkey release revoke signs a kind: revocation release record with the release key " +
          "and submits it: devices stop using that pack release, and --replacement names the " +
          "release of the same pack they take instead. Revocations are permanent; a later " +
          "revoke of the same release supersedes the replacement or reason, never the revoked " +
          "status.",
      },
      {
        subs: ["keys", "delegate", "publish"],
        text:
          "pkey release keys generate --content writes a new content key (no kid) and prints " +
          "its public key; pkey release delegate signs a kind: delegation record with the " +
          "release key that lets that key sign data-only pack releases (files.tree, data.json, " +
          "l10n.table) of compatible or standalone packs under --prefix (whole segments) for " +
          "--expires-in days (default 180, at most 366). A content team then publishes with " +
          "PKEY_CONTENT_KEY (or --content-key-file) and --delegation <sha256>: the files must " +
          "pass the data-only rule, and the record is signed under the kid pkd1-<sha256>.",
      },
      {
        subs: ["revoke", "delegate"],
        text:
          "pkey release revoke --delegation revokes a delegation and every pack release signed " +
          "under it.",
      },
      {
        subs: ["publish"],
        text:
          '--meta is a JSON file {"<buildId>": {"buildNumber", "minOS", "requires"}}. An ipa or ' +
          "apk payload's facts (bundle id, versions, entitlements; package, version code, ABIs, " +
          "signer) are read into the descriptor for the storefront feeds.",
      },
      { text: CI_PARA },
    ],
    env: [CI_ENV],
  },
  {
    name: "distribution",
    group: "distribution",
    json: false,
    context: ["product", "baseUrl"],
    summary: "Channel ids for a build, store reports and rollouts",
    rows: [
      ["distribution outlet-ids", "Print a build channel's store ids as JSON"],
      [
        "distribution report",
        "Report a store's availability, submission or key",
      ],
      ["distribution rollout", "Start or change a channel rollout"],
      [
        "distribution pause|resume|halt|complete",
        "Pause, resume, halt or complete that rollout",
      ],
    ],
    tree: {
      "outlet-ids": [],
      report: ["availability", "submission", "key"],
      rollout: [],
      pause: [],
      resume: [],
      halt: [],
      complete: [],
    },
    usage: [
      "pkey distribution outlet-ids --outlet id",
      "pkey distribution report availability|submission --product slug --outlet id " +
        "(--release id | --version v [--deliverable id]) --state s [--build id] " +
        "[--since epoch] [--platform-ref json] [--detail json]",
      "pkey distribution report key --product slug --purpose p --sha256 hex [--outlet id]",
      "pkey distribution rollout --product slug --outlet id --channel c --release id --bp n " +
        "[--deliverable id]",
      "pkey distribution pause|resume|halt|complete --product slug --outlet id --channel c " +
        "[--release id] [--deliverable id]",
    ],
    about: [
      {
        subs: ["outlet-ids"],
        text:
          "pkey distribution outlet-ids prints the build outlet's store ids from " +
          ".pkey/distribution as one JSON object of strings (steamAppId, itchGameId, flatpakId, " +
          "snapName, caskToken, homebrewFormula, msixFamilyName, bundleId), for CI to pass to a " +
          "Godot export as PKEY_OUTLET_IDS. With no .pkey/distribution it prints {}.",
      },
      {
        subs: ["report"],
        text:
          "pkey distribution report tells Polaris Key what a store says until its connector " +
          "exists: availability (pending, processing, in-review, approved, live, rejected, " +
          "removed) and the submission state (prepared, submitted, in-review, approved, " +
          "rejected, pending-developer-release, released, cancelled) of a release on an outlet. " +
          "report key sends the SHA-256 fingerprint the job signed with (colons allowed); one " +
          "that is not in the product's key inventory is flagged for an operator and the " +
          "command exits 1.",
      },
      {
        subs: ["rollout", "pause", "resume", "halt", "complete"],
        text:
          "rollout, pause, resume, halt and complete drive the outlet rollout; --bp is basis " +
          "points (2500 = 25%), and they need a token an operator granted " +
          "distribution:rollout.",
      },
      {
        subs: ["report", "rollout", "pause", "resume", "halt", "complete"],
        text: CI_PARA,
      },
    ],
    env: [
      ciEnvFor(["report", "rollout", "pause", "resume", "halt", "complete"]),
    ],
  },
  {
    name: "feeds",
    group: "feeds",
    json: true,
    valueless: ["no-browser"],
    context: ["product", "baseUrl"],
    summary: "Package-feed setup and feed pruning",
    rows: [
      ["feeds setup", "Print the setup for one package feed"],
      ["feeds setup --write", "Sign in and set up your package tools"],
      ["feeds prune", "Delete main builds below the newest stable"],
    ],
    tree: { setup: [], prune: [] },
    usage: [
      "pkey feeds setup --ecosystem npm|pypi|swift|maven|oci|godot|cargo|go --owner slug " +
        "[--namespace key=value ...] [--package name [--version v]] [--origin url] " +
        "[--token-env NAME] [--json]",
      "pkey feeds setup --write [--owner slug] [--no-browser] [--base-url url] [--json]",
      "pkey feeds prune --product slug [--deliverable id] [--apply] [--json] [--base-url url]",
    ],
    about: [
      {
        subs: ["prune"],
        text:
          "pkey feeds prune deletes each package's builds of main and dev (X-main.N, X-dev.N, " +
          "PyPI X.devN) below its newest stable release, the backfill of the Worker's automatic " +
          "feed cleanup, which is on by default after a one-time dry-run notice. It " +
          "is a dry run unless --apply: it prints what would go, per package, with counts and " +
          "bytes. With --apply it also lists any version skipped (held since the plan, so kept) " +
          "and exits non-zero if any version failed. The token needs release:yank, which an " +
          "operator grants.",
      },
      {
        subs: ["setup"],
        text:
          "pkey feeds setup prints the copy-paste setup for one package feed on the registry " +
          "host (default https://pkg.plrs.im), the same snippets the console's Setup tab shows: " +
          "strict routing only (the npm scope, uv explicit = true, Gradle exclusiveContent, " +
          "SwiftPM --scope, a fully qualified image reference, the Godot editor URLs). " +
          "--namespace sets the feed's namespace (scope=@acme, " +
          "groupPrefixes=gg.acme,gg.acme.tools); --token-env NAME adds the credential lines, " +
          "reading the registry token from that environment variable. Offline: nothing is sent " +
          "anywhere.",
      },
      {
        subs: ["setup"],
        text:
          "pkey feeds setup --write signs in with a code and a read-only personal token that you " +
          "approve in Polaris Locker, then sets up the tools it finds on PATH. It changes only " +
          "the lines it owns, in files under your home directory at 0600, and keeps the first " +
          "version of a changed file as <file>.pkey-backup. It refuses (exit 4) in CI and " +
          "without a terminal, where you print the setup instead; --owner limits it to one " +
          "product's feeds. A Godot feed is skipped: the editor needs its own URL, made in " +
          "Polaris Locker under Packages.",
      },
      { subs: ["prune"], text: CI_PARA },
    ],
    env: [ciEnvFor(["prune"])],
  },
  {
    name: "listing",
    group: "listing",
    json: true,
    context: ["product", "baseUrl"],
    summary: "Import a Godot listing, or derive every store's assets",
    rows: [
      ["listing import", "Import a Godot project into the product's listing"],
      ["listing assets", "Derive every store's icons, art and screenshots"],
    ],
    tree: { import: [], assets: [] },
    usage: [
      "pkey listing import --godot project --product slug [--preset name ...] " +
        "[--locale code] [--overwrite] [--apply [--fields a,b]] [--json] [--base-url url]",
      "pkey listing import --godot project --dry-run [--preset name ...]",
      "pkey listing assets --out dir [--icon png] [--key-art png] [--key-art-portrait png] " +
        "[--wordmark png] [--screenshots dir] [--focal x,y] [--focal-portrait x,y] " +
        "[--background #rrggbb] [--accept store/class/name ...] [--pad store/class/name ...] " +
        "[--locale code] [--upload --product slug [--base-url url] [--dry-run]]",
    ],
    about: [
      {
        subs: ["import"],
        text:
          "pkey listing import reads the Godot project and imports it into the product's shared " +
          "listing: the diff first, written only with --apply. --base-url must be https:, or " +
          "http:// on localhost or 127.0.0.1 for local development: your token is sent to " +
          "whatever origin you name, so any other origin is refused before anything is sent. " +
          "Run pkey login once; the import uses that sign-in.",
      },
      {
        subs: ["assets"],
        text:
          "pkey listing assets derives every store's icons from one square icon master (Play " +
          "512, the Microsoft tile 300, Steam's 184 JPG and 256 icons, Flathub, Snap, winget " +
          "and F-Droid; Android's adaptive layers only when the mark sits inside the central 66 " +
          "of 108 dp), composes every store's art from logo-free key art and the wordmark (Play " +
          "and F-Droid feature graphics, Steam's capsules and library set, the Microsoft super " +
          "hero, poster and box art, the itch.io cover, the Snap banner; cropped around --focal, " +
          "the wordmark only on slots that allow a title), and fits each screenshot under " +
          "--screenshots (one directory per size class) for the App Store, Play, the Microsoft " +
          "Store and Steam. A screenshot that does not fit gets a crop or pad proposal, used " +
          "only for the images named with --accept or --pad. Everything goes under --out with " +
          "report.json (the fit report), preview.html and one ZIP pack per store. --upload " +
          "stores the masters, outputs and packs in the listing model (the token needs " +
          "distribution:listing); nothing is pushed to a store. Needs the sharp library.",
      },
      { subs: ["assets"], text: CI_PARA },
    ],
    env: [
      {
        name: ADMIN_TOKEN_ENV,
        subs: ["import"],
        text:
          "Instead of the sign-in `pkey login` saved: a personal token (`pkeyp_...`). The import " +
          "refuses an admin API token (`pkeya_...`).",
      },
      ciEnvFor(["assets"]),
    ],
  },
  {
    name: "assets",
    group: "listing",
    json: false,
    context: ["product", "baseUrl"],
    action: { assets: STEP },
    summary: "Host a file in a presentation or listing slot",
    rows: [["assets push", "Host a file in a presentation or listing slot"]],
    tree: { push: [] },
    usage: [
      "pkey assets push file --slot slot [--locale code] --product slug [--base-url url] " +
        "[--dry-run]",
    ],
    about: [
      {
        text:
          "pkey assets push hosts a file that is not on the web in a slot: presentation.icon, " +
          "listing.icon, listing.header, listing.screenshot:<1-16> or a listing image slot " +
          "(icon-master, play:feature-graphic, ...). Polaris Key hosts a copy and serves it " +
          "from its image host; PNG, JPEG, WebP, GIF or AVIF only (never SVG), up to 10 MiB " +
          "for icon slots and 20 MiB for the rest. A slot an operator uploaded in the console, " +
          "or one a manifest declares, is kept as it is (console, then manifest, then CI). The " +
          "token needs assets:write, an opt-in scope, and Release must be on (the upload " +
          "ticket comes from its uploads route).",
      },
      { text: CI_PARA },
    ],
    env: [CI_ENV],
  },
  {
    name: "transport",
    group: "transport",
    json: false,
    context: ["product", "baseUrl"],
    action: {
      transport: STEP,
      deliverable: "--deliverable",
      version: "--release",
      dir: "--from",
      "content-api": "--content-api",
      variant: "--variant",
      "transport-out": "--out",
      "gradle-project": "--project",
      "pad-delivery": "--delivery",
      "steam-depot": "--depot",
      "steam-branch": "--branch",
      "steam-setlive": "--setlive",
      "asc-expect-resource": "--expect-resource",
      "transport-report": "--no-report",
    },
    summary: "Package a published pack for a store transport",
    rows: [
      [
        "transport apple-ba package",
        "Package a pack for Apple Background Assets",
      ],
      [
        "transport apple-ba upload",
        "Upload that asset pack to App Store Connect",
      ],
      ["transport play-pad modules", "Write Play Asset Delivery modules"],
      ["transport steam-depot vdf", "Write a content-only SteamPipe build"],
    ],
    tree: {
      "apple-ba": ["package", "upload"],
      "play-pad": ["modules"],
      "steam-depot": ["vdf"],
    },
    usage: [
      "pkey transport apple-ba package --deliverable packId --release v --from dir " +
        "[--content-api n] [--variant key] [--out dir] [--platforms iOS[,macOS]] " +
        "[--no-archive] [--no-report]",
      "pkey transport apple-ba upload --deliverable packId --release v [--dir dir] " +
        "[--from dir] [--content-api n] [--expect-resource id] [--lock file] " +
        "[--wait minutes] [--no-report]",
      "pkey transport play-pad modules --deliverable packId --release v --from dir " +
        "--project dir [--delivery fast-follow|on-demand] [--default-texture fmt] " +
        "[--variant key] [--no-report]",
      "pkey transport steam-depot vdf --deliverable packId --release v --from dir --depot id " +
        "(--branch b | --channel c) [--setlive] [--app id] [--out dir] [--no-report]",
    ],
    about: [
      {
        text:
          "pkey transport packages a published pack release (the --out cache of pkey release " +
          "publish --deliverable <packId>, re-hashed against its record and linted again, so a " +
          "pack with scripts never reaches a store) for the transport .pkey/distribution routes " +
          "it through, writes the pkey-marker/1 marker beside the payload, and reports the " +
          "transport's availability: apple-ba package writes Manifest.json for asset pack " +
          "<pack>-c<contentApi> (dots become hyphens; every apple-ba pack is mapped at once and " +
          "a collision, double hyphen or id over 64 characters is refused before anything is " +
          "written) and runs xcrun ba-package (macOS); apple-ba upload sends it to App Store " +
          "Connect with CI's key (ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY or ASC_KEY_PATH) " +
          "and records the asset pack's resource id in .pkey/asset-packs.json (commit it; a " +
          "later upload into any other resource is refused); play-pad modules writes " +
          "com.android.asset-pack modules (a #tcf_ directory per texture variant) into a Godot " +
          "Android Gradle build and patches it; steam-depot vdf writes a content-only SteamPipe " +
          "build (SetLive on named branches only).",
      },
      { text: CI_PARA },
    ],
    env: [CI_ENV],
  },
  {
    name: "channel",
    group: "storefront",
    json: true,
    context: ["product", "baseUrl"],
    summary: "Declare a delivery channel and sync it from CI",
    rows: [
      ["channel add <id>", "Declare a channel in .pkey/distribution"],
      [
        "channel sync",
        "Open the declared channels' store pull requests and upload their builds",
      ],
    ],
    tree: { add: [], sync: [] },
    usage: [
      "pkey channel add <id> [--field name=value ...] [--outlet-id id] [--json]",
      "pkey channel sync [--channel c] [--version v] [--dir d] [--deliverable packId [--from dir]] [--product slug] [--base-url url] [--dry-run] [--json]",
    ],
    about: [
      {
        subs: ["add"],
        text:
          "channel add declares one channel in .pkey/distribution, creating the file when " +
          "absent and keeping the comments already there, with a comment on every field. " +
          `Channels: ${ADDABLE_CHANNELS.join(", ")}. --field sets one of the channel's fields (a ` +
          "value starting [ or { is JSON); the answer names the ones still unset. " +
          "--outlet-id names the entry when you declare a channel twice. Nothing is " +
          "written if the id is taken or .pkey/ would stop validating.",
      },
      {
        subs: ["sync"],
        text:
          "channel sync runs what each declared channel needs: a pull request for " +
          "winget, Homebrew, Scoop and Flathub, as pkey storefront <store> pr does, and " +
          "with --dir an itch.io push per platform, a Snap upload and the F-Droid " +
          "repository build, from the files .pkey/release maps (no fitting file is a " +
          "skip). --channel is the release track (default stable); --version is what " +
          "itch.io records (default: the tag in GITHUB_REF_NAME). A channel whose " +
          "credential is unset is skipped, naming the variable (PKEY_PR_TOKEN, " +
          "BUTLER_API_KEY, SNAPCRAFT_STORE_CREDENTIALS, PKEY_FDROID_KS_PASS, " +
          "PKEY_FDROID_KEYSTORE, PKEY_FDROID_ALIAS); Flathub is skipped until its first " +
          "submission (pkey storefront flathub init). A failed step fails the command " +
          "after the rest ran. It needs PKEY_CI_TOKEN, or permissions: id-token: write " +
          "in GitHub Actions. snap metadata stays a pre-build step. --dry-run runs " +
          "nothing and prints each checked command. --deliverable <packId> plans that " +
          "pack's store transports instead of the channels: Background Assets (package, " +
          "upload; needs macOS and ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY or " +
          "ASC_KEY_PATH), a Steam depot (vdf, build; needs STEAM_USERNAME, " +
          "STEAM_CONFIG_VDF, the secret your workflow writes to ~/Steam/config/config.vdf, and steamcmd) and Play Asset Delivery, which is always " +
          "skipped: run pkey transport play-pad modules before the build. A transport " +
          "that skips leaves the pack on the Polaris Key CDN. It runs the rest from " +
          "--from, the pack publish's --out directory, for the pack release --version; " +
          "a step after one that failed is skipped. --dry-run prints each command, the " +
          "Steam account as $STEAM_USERNAME.",
      },
    ],
  },
  {
    name: "storefront",
    group: "storefront",
    json: true,
    context: ["product", "baseUrl"],
    action: {
      storefront: STEP,
      "itch-platform": "--platform",
      "storefront-outlet": "--outlet",
    },
    summary: "Run store CLIs from CI and open store pull requests",
    rows: [
      ["storefront itch push", "Push a build to itch.io with butler"],
      ["storefront snap metadata", "Write the listing into snapcraft.yaml"],
      [
        "storefront snap upload",
        "Upload a snap to the release tracks it declares",
      ],
      [
        "storefront snap upload-metadata",
        "Send the snap's summary, description and icon",
      ],
      [
        "storefront fdroid",
        "Build, sign and register a channel's F-Droid repo",
      ],
      ["storefront exec", "Run another allow-listed store command"],
      ["storefront allow-list", "Print the commands each store's CI admits"],
      [
        "storefront <store> pr",
        "Open the winget, Homebrew, Scoop or Flathub PR",
      ],
      ["storefront <store> status", "Read that pull request's state"],
      ["storefront flathub init", "Write a first Flathub submission"],
    ],
    tree: {
      itch: ["push"],
      snap: ["metadata", "upload", "upload-metadata"],
      fdroid: [],
      exec: [],
      "allow-list": [],
      winget: ["pr", "status"],
      homebrew: ["pr", "status"],
      scoop: ["pr", "status"],
      flathub: ["pr", "status", "init"],
    },
    usage: [
      "pkey storefront itch push --platform windows|linux|mac|android --dir dir --version v " +
        "[--channel c] [--outlet id] [--dry-run] [--no-report]",
      "pkey storefront snap metadata --yaml snapcraft.yaml [--dry-run]",
      "pkey storefront snap upload --snap file.snap --channel c[,c...] [--outlet id] " +
        "[--dry-run] [--no-report]",
      "pkey storefront snap upload-metadata --snap file.snap [--dry-run] [--no-report]",
      "pkey storefront fdroid --product slug --channel c --out dir [--keystore path --alias a] " +
        "[--ks-pass-env NAME] [--apksigner path] [--icon png] [--base-url url] [--dry-run]",
      "pkey storefront exec store command --op operation [--outlet id] [--tool-path path] " +
        "-- argv...",
      "pkey storefront allow-list [--store s] [--json]",
      "pkey storefront winget|homebrew|scoop|flathub pr [--channel c] [--outlet id] " +
        "[--dry-run [--out dir]] [--portable path] [--command name] [--license l] " +
        "[--app name] [--project-license spdx] [--no-report]",
      "pkey storefront winget|homebrew|scoop|flathub status [--channel c] [--version v] " +
        "[--outlet id] [--no-report]",
      "pkey storefront flathub init [--out dir] [--channel c] [--outlet id] " +
        "[--command path] [--runtime-version v]",
    ],
    about: [
      {
        subs: ["itch", "snap", "exec", "allow-list"],
        text:
          "pkey storefront runs a store's vendor CLI from CI, and only as a command its CI " +
          "allow-list admits (pkey storefront allow-list prints them): itch push is butler push " +
          "<dir> <user/game>:<platform[-channel]> --userversion <v>, the target from the itch " +
          "outlet's identity (BUTLER_API_KEY in the environment); snap upload is snapcraft " +
          "upload <snap> --release=<snap channels>, only the channels the snap outlet's " +
          "channels map declares, and snap upload-metadata sends the summary, description and " +
          "icon the snap carries, which snap metadata writes into snapcraft.yaml from the " +
          "listing model before the build (SNAPCRAFT_STORE_CREDENTIALS, a scoped " +
          "export-login). exec runs any other allow-listed command (steamcmd +run_app_build, " +
          "whose script may set live only a named branch; msstore publish, refused while the " +
          "console has a staged draft; BuildPatchTool -mode=UploadBinary). Each step is " +
          "reported back to Polaris Key before and after it runs (distribution:report), so the " +
          "store's ledger shows it beside console steps; a step already done in the same run " +
          "is skipped. --dry-run checks and prints the command lines.",
      },
      {
        subs: ["fdroid"],
        text:
          "pkey storefront fdroid builds the channel's F-Droid repository (index-v2.json, " +
          "entry.json, a diff) from Polaris Key's releases, signs entry.jar with apksigner and " +
          "the CI-held repo key (the password in $PKEY_FDROID_KS_PASS), uploads it and " +
          "registers it; the token needs distribution:feeds. Without --keystore it writes the " +
          "unsigned files and stops.",
      },
      {
        subs: STORE_SUBS,
        text:
          "pkey storefront <store> pr writes winget's manifests (schema 1.12.0), the cask " +
          "and the formula in your own Homebrew tap (direct.homebrewTap; a formula installs a " +
          ".tar.gz or .zip build for macOS and Linux, and --command names its executable, " +
          "default the formula's name), the Scoop feed's manifest in your own " +
          "bucket (direct.scoopBucket) or Flathub's updated manifest and MetaInfo for the " +
          "channel's newest release, and opens one pull request per version with the GitHub " +
          "token in PKEY_PR_TOKEN (a CI secret, never argv); Homebrew and Scoop, without it, " +
          "take a one-hour GitHub App token for the tap or bucket (CI token with the " +
          "distribution:pr scope); a PR already open or merged for " +
          "the version is recorded and nothing is written. status reads the pull request's " +
          "state and review labels. flathub init writes the first submission's files, which a " +
          "person opens against flathub/flathub's new-pr branch.",
      },
      { text: CI_PARA },
    ],
    env: [CI_ENV],
  },
  {
    name: "completion",
    group: "shell",
    json: false,
    summary: "Print a shell completion script",
    rows: [["completion bash|zsh|fish", "Print a shell completion script"]],
    tree: { bash: [], zsh: [], fish: [] },
    usage: ["pkey completion bash|zsh|fish"],
    about: [
      {
        text:
          "The script is generated from pkey's own command table: the commands, their " +
          'subcommands and their flags. bash: eval "$(pkey completion bash)" in ~/.bashrc. ' +
          'zsh: eval "$(pkey completion zsh)" in ~/.zshrc, after compinit. fish: pkey ' +
          "completion fish > ~/.config/fish/completions/pkey.fish.",
      },
    ],
  },
  {
    name: "help",
    group: "shell",
    json: false,
    summary: "Show this help, or one command's",
    rows: [["help [command]", "Show this help, or one command's"]],
    usage: ["pkey help [command]"],
    about: [
      {
        text:
          "pkey <command> --help (or -h) prints the same as pkey help <command> and runs " +
          "nothing. Colour is used only on a terminal; NO_COLOR, --no-color and a pipe give " +
          "plain text, and --ascii (or TERM=dumb) ASCII symbols.",
      },
    ],
  },
];

/** The options most commands take, closing the overview. */
export const COMMON_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["--product slug", "The product to act on; default from .pkey/product"],
  [
    "--base-url url",
    "The Polaris Key origin; default $PKEY_BASE_URL, else key.plrs.im",
  ],
  ["--dry-run", "Check and print; upload and write nothing"],
  ["--json", "One JSON object on stdout, where a command has it"],
  ["--no-color", "Plain text (also NO_COLOR=1, or a pipe)"],
  ["--ascii", "ASCII symbols only"],
  ["-h, --help", "Help for pkey, or for one command"],
  ["-V, --version", "Print pkey's version (first word only)"],
];

/** The exit codes every command shares (the reference page and the README render this). */
export const EXIT_CODES: ReadonlyArray<readonly [string, string]> = [
  ["0", "Success."],
  [
    "1",
    "Failure: an invalid manifest, a request the server rejected, a server or network error. The message says what to do next.",
  ],
  [
    "2",
    "Usage: an unknown command or subcommand, or a missing or misused flag. The message shows the command's usage.",
  ],
  [
    "4",
    "Refused, by pkey login, whoami and logout: not signed in, no credential store, or a token the server won't accept. The message names the fix.",
  ],
];

/**
 * Flags that take no value, whatever command they are on: parse never lets one swallow the
 * next word (`init --force dir`). A command's own `valueless` adds to this list.
 */
const VALUELESS = [
  "--dry-run",
  "--force",
  "--no-config",
  "--write",
  "--check",
  "--overwrite",
  "--apply",
  "--no-record",
  "--strict",
  "--content",
  "--upload",
  "--no-archive",
  "--no-report",
  "--setlive",
];

export function findCommand(name: string): PkeyCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Every flag the table declares valueless, which parse reads so no flag is listed twice. */
export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
  ...VALUELESS.map((f) => f.slice(2)),
  ...COMMANDS.flatMap((c) => c.valueless ?? []),
]);

/**
 * What is wrong with a command table, one sentence each (empty when it is sound). The table is
 * the one place a command exists, so the checks are: every name once, every group known, every
 * row and usage line under its own command, a declared `--json` is in some usage line, a
 * declared `context` flag is in some usage line, and each Action input maps to a flag the
 * command's usage names.
 */
export function checkRegistry(
  commands: readonly PkeyCommand[] = COMMANDS,
  groups: ReadonlyArray<readonly [GroupId, string]> = GROUPS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const known = new Set(groups.map(([id]) => id));
  for (const c of commands) {
    if (seen.has(c.name)) problems.push(`${c.name} is registered twice`);
    seen.add(c.name);
    if (!known.has(c.group))
      problems.push(`${c.name} is in group ${c.group}, which has no heading`);
    for (const [term] of c.rows)
      if (term.split(" ")[0] !== c.name)
        problems.push(
          `${c.name}: row "${term}" does not start with the command`,
        );
    for (const u of c.usage)
      if (!u.startsWith(`pkey ${c.name}`))
        problems.push(
          `${c.name}: usage "${u}" does not start with pkey ${c.name}`,
        );
    const usage = c.usage.join(" ");
    const has = (flag: string, text = usage) =>
      new RegExp(`${flag}(?![\\w-])`).test(text);
    const described = `${usage} ${(c.about ?? []).map((p) => p.text).join(" ")}`;
    if (c.json && !has("--json"))
      problems.push(`${c.name} declares --json but no usage line shows it`);
    for (const f of c.valueless ?? [])
      if (!has(`--${f}`))
        problems.push(`${c.name}: valueless --${f} is in no usage line`);
    const ctx = { product: "--product", baseUrl: "--base-url" } as const;
    for (const k of c.context ?? [])
      if (!has(ctx[k], described))
        problems.push(
          `${c.name}: context ${k} but its help never mentions ${ctx[k]}`,
        );
    for (const [input, flag] of Object.entries(c.action ?? {}))
      if (flag !== STEP && !has(flag))
        problems.push(
          `${c.name}: Action input ${input} maps to ${flag}, in no usage line`,
        );
  }
  return problems;
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────

/** Below this many columns a help row stacks: the term, then its description under it. */
const STACK_COLUMNS = 50;

/**
 * Two columns: each term strong, its description muted and wrapped under its own column, never
 * past the terminal's width. Below 50 columns, or when the description column would be narrower
 * than 16 cells, each term stacks above its description (two cells further in).
 */
function twoColumns(
  term: Term,
  rows: ReadonlyArray<readonly [string, string]>,
  column: number,
  indent = 2,
): string[] {
  const { painter, caps } = term;
  const stacked =
    caps.columns < STACK_COLUMNS || caps.columns - (indent + column + 2) < 16;
  const descCol = stacked ? indent + 2 : indent + column + 2;
  const width = Math.max(1, caps.columns - descCol);
  const out: string[] = [];
  for (const [t, text] of rows) {
    const name = painter.style(t, ["strong"]);
    const fits = !stacked && cellWidth(t) <= column;
    // A term wider than the line wraps at its spaces, continued two cells further in; a stacked
    // command that wrapped indents its description by four, so the two read apart without bold.
    const termLines = fits
      ? []
      : wrapSpans(
          [{ text: t, style: ["strong"] }],
          Math.max(1, caps.columns - indent - 2),
        );
    const col = stacked && termLines.length > 1 ? indent + 4 : descCol;
    const lines = wrapSpans(
      [{ text, style: ["muted"] }],
      Math.max(1, caps.columns - col),
    );
    termLines.forEach((l, i) =>
      out.push(
        `${" ".repeat(i === 0 ? indent : indent + 2)}${painter.line(l)}`,
      ),
    );
    lines.forEach((l, i) => {
      const body = painter.line(l);
      out.push(
        i === 0 && fits
          ? `${" ".repeat(indent)}${name}${" ".repeat(column - cellWidth(t) + 2)}${body}`
          : `${" ".repeat(col)}${body}`,
      );
    });
  }
  return out;
}

/** The term column: the widest term that fits the cap (longer terms take a line of their own). */
function termColumn(
  term: Term,
  terms: readonly string[],
  cap = term.caps.columns < 70 ? 18 : 26,
): number {
  return Math.min(
    cap,
    Math.max(0, ...terms.map(cellWidth).filter((w) => w <= cap)),
  );
}

/**
 * The logo header: the art on the left, the text block to its right, centred on the art's rows;
 * the block wraps to what the art leaves of the line.
 */
function logoHeader(term: Term, art: Line[], block: Line[]): string[] {
  const gap = 2;
  const room = Math.max(1, term.caps.columns - LOGO_COLS - gap);
  const text = block.flatMap((l) => (l.length ? wrapSpans(l, room) : [l]));
  const top = Math.max(0, Math.floor((art.length - text.length) / 2));
  const rows = Math.max(art.length, top + text.length);
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const left = art[r] ?? [];
    const right = text[r - top] ?? [];
    const pad = LOGO_COLS + gap - cellWidth(left.map((x) => x.text).join(""));
    const spans: Line = right.length
      ? [...left, { text: " ".repeat(pad) }, ...right]
      : left;
    out.push(term.painter.line(spans));
  }
  return out;
}

/** What `pkey` will act on here: the header's "Here" line (`context.ts` resolves it). */
export interface HelpHere {
  product: { slug: string; name?: string; source: "flag" | "manifest" } | null;
  baseUrl: string;
}

/** A URL as people say it: no scheme, no trailing slash (`https://key.plrs.im/` is key.plrs.im). */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

const LABEL_WIDTH = 7;

/**
 * The "Here" line: the product and where it came from, then the base URL, wrapped to `width`
 * with the continuation under the value. Outside a repository it says why there is no product
 * and the one way to name it.
 */
function hereLines(here: HelpHere, width: number, separator: string): Line[] {
  const product = here.product;
  const room = Math.max(1, width - LABEL_WIDTH);
  const text = product
    ? `${product.name ? `${product.name} (${product.slug})` : product.slug} from ${
        product.source === "manifest" ? ".pkey/product" : "--product"
      }`
    : "no product: no .pkey/product here or above; pass --product";
  const lines = wrapSpans([{ text }], room);
  // The base URL follows on the last line when it fits there, else it takes a line of its own.
  const url = shortUrl(here.baseUrl);
  const tail = lines.at(-1) ?? [];
  const used = cellWidth(tail.map((x) => x.text).join(""));
  const joined = ` ${separator} ${url}`;
  if (used + cellWidth(joined) <= room)
    tail.push({ text: joined, style: ["muted"] });
  else lines.push([{ text: `${separator} ${url}`, style: ["muted"] }]);
  return lines.map(
    (l, i): Line => [
      i === 0
        ? { text: "Here".padEnd(LABEL_WIDTH), style: ["muted"] }
        : { text: " ".repeat(LABEL_WIDTH) },
      ...l,
    ],
  );
}

/** The grouped overview: `pkey`, `pkey help`, `pkey --help`. */
export function renderHelp(term: Term, here?: HelpHere): string {
  const { painter, symbols } = term;
  const line = (spans: Line) => painter.line(spans);
  const allRows = COMMANDS.flatMap((c) => c.rows);
  const column = termColumn(term, [
    ...allRows.map(([t]) => t),
    ...COMMON_OPTIONS.map(([t]) => t),
  ]);
  const art = logoLines(term);
  const mode = logoMode(term);
  const name: Line = [
    ...(mode === "star"
      ? [{ text: `${LOGO_STAR_GLYPH} `, style: ["strong"] }]
      : []),
    { text: "pkey", style: ["strong"] },
    { text: ` ${CLI_VERSION}`, style: ["muted"] },
  ];
  const tagline: Line = [
    {
      text: `${mode === "art" ? "" : ` ${symbols.separator} `}Polaris Key platform CLI`,
      style: ["muted"],
    },
  ];
  const usage: Line = [
    { text: "Usage", style: ["muted"] },
    { text: "  pkey <command> [options]" },
  ];
  const room = art
    ? Math.max(1, term.caps.columns - LOGO_COLS - 2)
    : term.caps.columns;
  const hereBlock = here ? hereLines(here, room, symbols.separator) : [];
  const out: string[] = art
    ? logoHeader(term, art, [name, tagline, [], ...hereBlock, usage])
    : [
        ...wrapSpans([...name, ...tagline], term.caps.columns).map(line),
        "",
        ...hereBlock.map(line),
        line(usage),
      ];
  for (const [group, heading] of GROUPS) {
    const rows = COMMANDS.filter((c) => c.group === group).flatMap(
      (c) => c.rows,
    );
    if (!rows.length) continue;
    out.push("", line([{ text: heading, style: ["strong"] }]));
    out.push(...twoColumns(term, rows, column));
  }
  out.push("", line([{ text: "Options", style: ["strong"] }]));
  out.push(...twoColumns(term, COMMON_OPTIONS, column));
  out.push(
    "",
    ...wrapSpans(
      [
        {
          text: "Run pkey <command> --help for a command's options.",
          style: ["muted"],
        },
      ],
      term.caps.columns,
    ).map(line),
    ...wrapSpans(
      [
        {
          text: `Every command and flag: ${shortUrl(here?.baseUrl ?? DEFAULT_BASE_URL)}/docs/reference/cli`,
          style: ["muted"],
        },
      ],
      term.caps.columns,
    ).map(line),
  );
  return `${out.join("\n")}\n`;
}

/** A usage line's units: a word, a flag with its value, or a whole bracket or paren group. */
function usageUnits(text: string): string[] {
  const raw: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth -= 1;
    if (ch === " " && depth === 0) {
      if (cur) raw.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) raw.push(cur);
  // A flag keeps its value beside it (`--product slug`).
  const units: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const u = raw[i]!;
    const next = raw[i + 1];
    if (
      u.startsWith("-") &&
      next !== undefined &&
      !/^[-[(]/.test(next) &&
      !u.includes("[")
    ) {
      units.push(`${u} ${next}`);
      i += 1;
    } else units.push(u);
  }
  return units;
}

/**
 * One usage line wrapped to the terminal at unit boundaries, continuation lines indented. A unit
 * is never broken or shortened, even when it is wider than the line.
 */
function usageLines(
  term: Term,
  cmd: PkeyCommand,
  text: string,
  indent = 2,
): string[] {
  const { painter, caps } = term;
  const cont = indent + 4;
  const units = usageUnits(text);
  // The literal command words ("pkey release publish") read strong; placeholders do not.
  const isIn = (word: string | undefined, words: readonly string[]) =>
    word !== undefined && word.split("|").every((w) => words.includes(w));
  let lead = 2;
  if (cmd.tree && isIn(units[2], Object.keys(cmd.tree))) {
    lead = 3;
    const next = cmd.tree[units[2]!.split("|")[0]!] ?? [];
    if (isIn(units[3], next)) lead = 4;
  }
  const lines: string[][] = [[]];
  let w = indent;
  units.forEach((u, i) => {
    const cur = lines[lines.length - 1]!;
    const uw = cellWidth(u);
    if (cur.length > 0 && w + 1 + uw > caps.columns) {
      lines.push([]);
      w = cont;
    }
    const target = lines[lines.length - 1]!;
    w += (target.length > 0 ? 1 : 0) + uw;
    target.push(i < lead ? painter.style(u, ["strong"]) : u);
  });
  return lines.map(
    (l, i) => `${" ".repeat(i === 0 ? indent : cont)}${l.join(" ")}`,
  );
}

/** Which subcommands a usage line is for: its word after the command, when that is in the tree. */
function usageSubs(cmd: PkeyCommand, text: string): string[] | null {
  if (!cmd.tree) return null;
  const word = text.split(" ")[2] ?? "";
  const subs = word.split("|");
  return subs.every((s) => s in cmd.tree!) ? subs : null;
}

/** The subcommand words a row's term names (`release pin|unpin` → pin, unpin). */
function rowSubs(term: string): string[] {
  return (term.split(" ")[1] ?? "").split("|");
}

/** Paragraph text wrapped to the terminal, indented. */
function paragraph(term: Term, text: string, indent = 2): string[] {
  const width = Math.max(1, term.caps.columns - indent);
  return wrapSpans([{ text }], width).map(
    (l) => `${" ".repeat(indent)}${term.painter.line(l)}`,
  );
}

/**
 * One command's help (`pkey <command> --help`, `pkey help <command>`): its usage lines and the
 * paragraphs that explain it. With a subcommand (`pkey release publish --help`) only that
 * subcommand's lines and paragraphs; an unknown subcommand gets the whole command.
 */
export function renderCommandHelp(
  term: Term,
  cmd: PkeyCommand,
  sub?: string,
): string {
  const { painter, symbols } = term;
  const line = (spans: Line) => painter.line(spans);
  const known = sub !== undefined && cmd.tree !== undefined && sub in cmd.tree;
  const usage = cmd.usage.filter((u) => {
    if (!known) return true;
    const subs = usageSubs(cmd, u);
    return subs === null || subs.includes(sub!);
  });
  const about = (cmd.about ?? []).filter(
    (p) => !known || !p.subs || p.subs.includes(sub!),
  );
  const row = known
    ? cmd.rows.find(([t]) => rowSubs(t).includes(sub!))
    : undefined;
  const title = known ? `pkey ${cmd.name} ${sub}` : `pkey ${cmd.name}`;
  const out: string[] = [
    // The title and its summary wrap to the terminal like every other line.
    ...wrapSpans(
      [
        { text: title, style: ["strong"] },
        {
          text: ` ${symbols.separator} ${row ? row[1] : cmd.summary}`,
          style: ["muted"],
        },
      ],
      term.caps.columns,
    ).map(line),
    "",
    line([{ text: "Usage", style: ["strong"] }]),
  ];
  for (const u of usage) out.push(...usageLines(term, cmd, u));
  for (const p of about) out.push("", ...paragraph(term, p.text));
  const env = (cmd.env ?? []).filter(
    (e) => !known || !e.subs || e.subs.includes(sub!),
  );
  if (env.length) {
    const rows = env.map((e) => [e.name, e.text] as const);
    out.push("", line([{ text: "Environment", style: ["strong"] }]));
    out.push(
      ...twoColumns(
        term,
        rows,
        termColumn(
          term,
          rows.map(([n]) => n),
        ),
      ),
    );
  }
  out.push(
    "",
    line([{ text: "Run pkey help for every command.", style: ["muted"] }]),
  );
  return `${out.join("\n")}\n`;
}

// ── Completion ───────────────────────────────────────────────────────────────────────────────

export type CompletionShell = "bash" | "zsh" | "fish";
export const COMPLETION_SHELLS: readonly CompletionShell[] = [
  "bash",
  "zsh",
  "fish",
];

/** The flags every command takes. */
const GLOBAL_FLAGS = ["--help", "-h", "--no-color", "--ascii"];

/** The flags a command's usage lines name, then the global ones. */
function commandFlags(cmd: PkeyCommand): string[] {
  const named = cmd.usage.flatMap(
    (u) => u.match(/--[a-z][a-z0-9-]*/g) ?? ([] as string[]),
  );
  return [...new Set([...named, ...GLOBAL_FLAGS])];
}

/** Every completion position: the words typed so far → the words that may come next. */
function completionTree(): Array<{
  path: string[];
  words: Array<{ word: string; text: string }>;
}> {
  const nodes: Array<{
    path: string[];
    words: Array<{ word: string; text: string }>;
  }> = [
    {
      path: [],
      words: COMMANDS.map((c) => ({ word: c.name, text: c.summary })),
    },
  ];
  const describe = (cmd: PkeyCommand, words: string[]): string => {
    const term = [cmd.name, ...words].join(" ");
    const row =
      cmd.rows.find(([t]) => t === term) ??
      (words.length === 1
        ? cmd.rows.find(([t]) => rowSubs(t).includes(words[0]!))
        : undefined);
    return row?.[1] ?? "";
  };
  for (const cmd of COMMANDS) {
    if (cmd.name === "help") {
      nodes.push({
        path: ["help"],
        words: COMMANDS.filter((c) => c.name !== "help").map((c) => ({
          word: c.name,
          text: c.summary,
        })),
      });
      continue;
    }
    if (!cmd.tree) continue;
    nodes.push({
      path: [cmd.name],
      words: Object.keys(cmd.tree).map((w) => ({
        word: w,
        text: describe(cmd, [w]),
      })),
    });
    for (const [w, next] of Object.entries(cmd.tree))
      if (next.length)
        nodes.push({
          path: [cmd.name, w],
          words: next.map((n) => ({ word: n, text: describe(cmd, [w, n]) })),
        });
  }
  return nodes;
}

const sq = (s: string) => s.replace(/'/g, "'\\''");

/** A completion script for `shell`, generated from the command table. */
export function completionScript(shell: CompletionShell): string {
  const tree = completionTree();
  if (shell === "bash") {
    const flagCases = COMMANDS.map(
      (c) => `      ${c.name}) words="${commandFlags(c).join(" ")}" ;;`,
    );
    const wordCases = tree.map(
      (n) =>
        `      "${n.path.join(" ")}") words="${n.words.map((w) => w.word).join(" ")}" ;;`,
    );
    return [
      '# pkey completion for bash. Add to ~/.bashrc:  eval "$(pkey completion bash)"',
      "_pkey_complete() {",
      '  local cur="${COMP_WORDS[COMP_CWORD]}" words=""',
      '  local sofar="${COMP_WORDS[*]:1:COMP_CWORD-1}"',
      '  if [[ "$cur" == -* ]]; then',
      '    case "${COMP_WORDS[1]}" in',
      ...flagCases,
      `      *) words="${GLOBAL_FLAGS.join(" ")}" ;;`,
      "    esac",
      "  else",
      '    case "$sofar" in',
      ...wordCases,
      "    esac",
      "  fi",
      '  COMPREPLY=( $(compgen -W "$words" -- "$cur") )',
      "}",
      "complete -o default -F _pkey_complete pkey",
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    const flagCases = COMMANDS.map(
      (c) =>
        `      ${c.name}) opts=(${commandFlags(c)
          .map((f) => `'${sq(f)}'`)
          .join(" ")}) ;;`,
    );
    const wordCases = tree.map(
      (n) =>
        `    '${sq(n.path.join(" "))}') cmds=(${n.words
          .map((w) => `'${sq(w.text ? `${w.word}:${w.text}` : w.word)}'`)
          .join(" ")}) ;;`,
    );
    return [
      "#compdef pkey",
      '# pkey completion for zsh. Add to ~/.zshrc (after compinit):  eval "$(pkey completion zsh)"',
      "_pkey_complete() {",
      "  local -a cmds opts",
      "  local cur=$words[CURRENT]",
      '  local sofar="${(j: :)words[2,CURRENT-1]}"',
      "  if [[ $cur == -* ]]; then",
      "    case $words[2] in",
      ...flagCases,
      `      *) opts=(${GLOBAL_FLAGS.map((f) => `'${f}'`).join(" ")}) ;;`,
      "    esac",
      "    compadd -- $opts",
      "    return",
      "  fi",
      "  case $sofar in",
      ...wordCases,
      "    *) _files; return ;;",
      "  esac",
      "  _describe 'command' cmds",
      "}",
      "compdef _pkey_complete pkey",
      "",
    ].join("\n");
  }
  const lines = [
    "# pkey completion for fish. Save as ~/.config/fish/completions/pkey.fish:",
    "#   pkey completion fish > ~/.config/fish/completions/pkey.fish",
    "# True when exactly these words follow pkey on the command line so far.",
    "function __pkey_at",
    "    set -l t (commandline -opc)",
    "    test (count $t) -eq (math (count $argv) + 1); or return 1",
    "    for i in (seq (count $argv))",
    '        test "$t[(math $i + 1)]" = "$argv[$i]"; or return 1',
    "    end",
    "end",
    "complete -c pkey -f",
    ...tree.flatMap((n) =>
      n.words.map(
        (w) =>
          `complete -c pkey -n '${sq(["__pkey_at", ...n.path].join(" "))}' -a '${sq(w.word)}'${w.text ? ` -d '${sq(w.text)}'` : ""}`,
      ),
    ),
    "complete -c pkey -n '__pkey_at validate' -a '(__fish_complete_directories)'",
    ...COMMANDS.flatMap((c) =>
      commandFlags(c)
        .filter((f) => f.startsWith("--") && !GLOBAL_FLAGS.includes(f))
        .map(
          (f) =>
            `complete -c pkey -n '__fish_seen_subcommand_from ${c.name}' -l '${sq(f.slice(2))}'`,
        ),
    ),
    "complete -c pkey -s h -l help -d 'Help for pkey, or for one command'",
    "complete -c pkey -l no-color -d 'Plain text'",
    "complete -c pkey -l ascii -d 'ASCII symbols only'",
    "",
  ];
  return lines.join("\n");
}
