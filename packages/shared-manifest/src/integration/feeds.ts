/**
 * F-37.2: the combined feed setup, pure.
 *
 * - `renderCombinedFeedSetup`: every feed's snippets in ecosystem order, with one `~/.netrc` entry
 *   per registry host in place of each Go feed's own.
 * - `userConfigPlan`: what `pkey feeds setup --write` does to the user's own configuration, as
 *   data: each step is a file edit (`{tool, file, edit}`) or a command (`{tool, exec}`). The CLI
 *   applies it (merging, mode 0600, HOME-only); nothing here reads a file or runs a process.
 *
 * The token is only ever a file value, a command's stdin or the content of a `tokenFile` the CLI
 * writes to a 0600 temp file and deletes. It is never in `argv`.
 */

import { PACKAGE_ECOSYSTEMS, type PackageEcosystem } from "../packages.js";
import {
  feedSetupBaseUrl,
  feedSetupProblem,
  formatFeedSetup,
  renderFeedSetup,
  type FeedSetupContext,
  type FeedSetupCredential,
  type FeedSnippet,
} from "../feedSetup.js";

/** One feed to set up: its ecosystem, its owning product's slug and its namespace. */
export interface CombinedFeed {
  readonly ecosystem: PackageEcosystem;
  readonly owner: string;
  readonly namespace?: Readonly<Record<string, unknown>>;
}

export interface CombinedFeedContext {
  /** The registry origin, `https://pkg.plrs.im`. */
  readonly origin: string;
  readonly credential?: FeedSetupCredential;
}

function ordered(feeds: readonly CombinedFeed[]): CombinedFeed[] {
  const rank = (f: CombinedFeed) => PACKAGE_ECOSYSTEMS.indexOf(f.ecosystem);
  return [...feeds].sort(
    (a, b) => rank(a) - rank(b) || a.owner.localeCompare(b.owner),
  );
}

function ctxOf(feed: CombinedFeed, ctx: CombinedFeedContext): FeedSetupContext {
  const c = ctx.credential ?? { kind: "none" };
  return {
    origin: ctx.origin,
    owner: feed.owner,
    ...(feed.namespace ? { namespace: feed.namespace } : {}),
    credential:
      feed.ecosystem === "godot" && c.kind === "token"
        ? { kind: "godot-url", value: c.value }
        : c,
  };
}

function netrcSnippet(
  host: string,
  c: FeedSetupCredential,
): FeedSnippet | null {
  const shared = {
    id: "netrc",
    clients: "pip, uv, Poetry, the go command",
    title: "The feed credentials, once per host",
    description:
      "pip, uv, Poetry and the go command read a .netrc entry's login and password as HTTP Basic credentials for the host.",
    language: "sh" as const,
  };
  if (c.kind === "env")
    return {
      ...shared,
      code: `printf 'machine %s login __token__ password %s\\n' ${host} "$${c.name}" >> ~/.netrc`,
    };
  if (c.kind === "token")
    return {
      ...shared,
      filename: "~/.netrc",
      language: "text",
      code: [`machine ${host}`, "login __token__", `password ${c.value}`].join(
        "\n",
      ),
    };
  return null;
}

/**
 * Every feed's setup snippets in ecosystem order (then owner), as `formatFeedSetup` prints them,
 * each feed under a `# <ecosystem> feed: <owner>` heading. A Go feed's netrc snippet gives way to
 * one entry per host at the end. Throws on a feed `renderFeedSetup` refuses.
 */
export function renderCombinedFeedSetup(
  feeds: readonly CombinedFeed[],
  ctx: CombinedFeedContext,
): string {
  const blocks: string[] = [];
  let netrc = false;
  for (const feed of ordered(feeds)) {
    let snippets = renderFeedSetup(feed.ecosystem, ctxOf(feed, ctx));
    if (feed.ecosystem === "go" || feed.ecosystem === "pypi") netrc = true;
    if (feed.ecosystem === "go")
      snippets = snippets.filter((s) => s.id !== "netrc");
    blocks.push(
      `# ${feed.ecosystem} feed: ${feed.owner}\n\n${formatFeedSetup(snippets)}`,
    );
  }
  const hosts = new Set<string>();
  if (netrc) hosts.add(new URL(ctx.origin).host);
  const entries = [...hosts]
    .map((h) => netrcSnippet(h, ctx.credential ?? { kind: "none" }))
    .filter((s): s is FeedSnippet => s !== null);
  if (entries.length) blocks.push(formatFeedSetup(entries));
  return blocks.join("\n").replace(/\n+$/, "\n");
}

// ── the write plan ────────────────────────────────────────────────────────────

/** A merge into one user-level file; the CLI keeps every line it does not name. */
export type FeedEdit =
  /** A text line: replace the first line that starts with `prefix`, else append `line`. */
  | { readonly kind: "line"; readonly prefix: string; readonly line: string }
  /** A `key: value` under `path` in a YAML file (`value` is a string or a boolean). */
  | {
      readonly kind: "yaml";
      readonly path: readonly string[];
      readonly value: string | boolean;
    }
  /** `key = value` in the TOML table `[table]`; `key` and `value` are TOML source. */
  | {
      readonly kind: "toml";
      readonly table: string;
      readonly key: string;
      readonly value: string;
    }
  /** `key=value` in a Java properties file. */
  | { readonly kind: "property"; readonly key: string; readonly value: string }
  /** A `.netrc` entry, keyed by its machine. */
  | {
      readonly kind: "netrc";
      readonly machine: string;
      readonly login: string;
      readonly password: string;
    };

interface StepBase {
  /** The client's name. */
  readonly tool: string;
  /** Skip the step unless one of these is on PATH. */
  readonly onPath: readonly string[];
  readonly ecosystem: PackageEcosystem;
  readonly owner: string;
  /** The step carries the token: do not print its edit or command. */
  readonly secret: boolean;
}

export interface FileStep extends StepBase {
  /** Relative to the user's home directory, `/`-separated. */
  readonly file: string;
  readonly edit: FeedEdit;
}

export interface ExecStep extends StepBase {
  readonly exec: {
    /** Never holds the token. */
    readonly argv: readonly string[];
    /** Piped to the command's stdin. */
    readonly stdin?: string;
    /** The CLI writes `content` to a 0600 temp file, appends `flag` and its path to argv, runs, deletes. */
    readonly tokenFile?: { readonly flag: string; readonly content: string };
  };
}

export type PlanStep = FileStep | ExecStep;

export interface PlanSkip {
  readonly ecosystem: PackageEcosystem;
  readonly owner: string;
  readonly reason: string;
}

export interface UserConfigPlan {
  /** In order: file edits before the commands that read them. */
  readonly steps: readonly PlanStep[];
  /** Feeds the plan does not write, each with the reason. */
  readonly skipped: readonly PlanSkip[];
}

export function isExecStep(step: PlanStep): step is ExecStep {
  return "exec" in step;
}

/**
 * The user-level writes for these feeds with one registry token. Throws on a feed or token
 * `feedSetupProblem` refuses. A feed it cannot write goes in `skipped` (Godot's token rides in its
 * URL, which only the console shows; a scoped ecosystem without its scope has nothing to route).
 */
export function userConfigPlan(
  feeds: readonly CombinedFeed[],
  ctx: { readonly origin: string; readonly token: string },
): UserConfigPlan {
  const token = ctx.token;
  const host = new URL(ctx.origin).host;
  const files: FileStep[] = [];
  const execs: ExecStep[] = [];
  const skipped: PlanSkip[] = [];
  const netrcDone = new Set<string>();

  for (const feed of ordered(feeds)) {
    const { ecosystem, owner } = feed;
    const problem = feedSetupProblem(ecosystem, {
      origin: ctx.origin,
      owner,
      ...(feed.namespace ? { namespace: feed.namespace } : {}),
      credential: { kind: "token", value: token },
    });
    if (problem !== null) throw new Error(`userConfigPlan: ${problem}`);
    const base = feedSetupBaseUrl(ecosystem, ctx.origin, owner);
    const at = { ecosystem, owner };
    const file = (
      tool: string,
      onPath: string[],
      path: string,
      edit: FeedEdit,
      secret = false,
    ) => files.push({ tool, onPath, file: path, edit, secret, ...at });
    const netrc = (onPath: string[]) => {
      if (netrcDone.has(host)) {
        // One entry serves every client that reads it: any of them on PATH is enough.
        const at = files.findIndex((f) => f.file === ".netrc");
        const prev = files[at]!;
        files[at] = {
          ...prev,
          onPath: [...new Set([...prev.onPath, ...onPath])],
        };
        return;
      }
      netrcDone.add(host);
      file(
        "netrc",
        onPath,
        ".netrc",
        { kind: "netrc", machine: host, login: "__token__", password: token },
        true,
      );
    };

    if (ecosystem === "npm") {
      const scope = feed.namespace?.["scope"];
      if (typeof scope !== "string" || scope === "") {
        skipped.push({ ...at, reason: "the feed has no npm scope to route" });
        continue;
      }
      const bare = scope.slice(1);
      const authPath = base.replace(/^https?:/, "");
      file("npm", ["npm", "pnpm"], ".npmrc", {
        kind: "line",
        prefix: `${scope}:registry=`,
        line: `${scope}:registry=${base}`,
      });
      file(
        "npm",
        ["npm", "pnpm"],
        ".npmrc",
        {
          kind: "line",
          prefix: `${authPath}:_authToken=`,
          line: `${authPath}:_authToken=${token}`,
        },
        true,
      );
      file("yarn", ["yarn"], ".yarnrc.yml", {
        kind: "yaml",
        path: ["npmScopes", bare, "npmRegistryServer"],
        value: base,
      });
      file(
        "yarn",
        ["yarn"],
        ".yarnrc.yml",
        {
          kind: "yaml",
          path: ["npmScopes", bare, "npmAuthToken"],
          value: token,
        },
        true,
      );
      file("yarn", ["yarn"], ".yarnrc.yml", {
        kind: "yaml",
        path: ["npmScopes", bare, "npmAlwaysAuth"],
        value: true,
      });
      file(
        "bun",
        ["bun"],
        ".bunfig.toml",
        {
          kind: "toml",
          table: "install.scopes",
          key: JSON.stringify(scope),
          value: `{ url = ${JSON.stringify(base)}, token = ${JSON.stringify(token)} }`,
        },
        true,
      );
    } else if (ecosystem === "pypi") {
      netrc(["pip", "pip3", "uv", "poetry"]);
    } else if (ecosystem === "go") {
      netrc(["go"]);
    } else if (ecosystem === "maven") {
      const repo = owner.replace(/[^A-Za-z0-9]/g, "_");
      file("gradle", ["gradle"], ".gradle/gradle.properties", {
        kind: "property",
        key: `${repo}Username`,
        value: "__token__",
      });
      file(
        "gradle",
        ["gradle"],
        ".gradle/gradle.properties",
        { kind: "property", key: `${repo}Password`, value: token },
        true,
      );
    } else if (ecosystem === "cargo") {
      file("cargo", ["cargo"], ".cargo/config.toml", {
        kind: "toml",
        table: `registries.${owner}`,
        key: "index",
        value: JSON.stringify(`sparse+${base}`),
      });
      file("cargo", ["cargo"], ".cargo/config.toml", {
        kind: "toml",
        table: `registries.${owner}`,
        key: "credential-provider",
        value: JSON.stringify("cargo:token"),
      });
      execs.push({
        tool: "cargo",
        onPath: ["cargo"],
        exec: {
          argv: ["cargo", "login", "--registry", owner],
          stdin: `${token}\n`,
        },
        secret: true,
        ...at,
      });
    } else if (ecosystem === "oci") {
      execs.push({
        tool: "docker",
        onPath: ["docker"],
        exec: {
          argv: [
            "docker",
            "login",
            host,
            "-u",
            "__token__",
            "--password-stdin",
          ],
          stdin: `${token}\n`,
        },
        secret: true,
        ...at,
      });
    } else if (ecosystem === "swift") {
      execs.push({
        tool: "swift",
        onPath: ["swift"],
        exec: {
          argv: [
            "swift",
            "package-registry",
            "login",
            base.replace(/\/$/, ""),
            "--no-confirm",
          ],
          tokenFile: { flag: "--token-file", content: token },
        },
        secret: true,
        ...at,
      });
    } else {
      skipped.push({
        ...at,
        reason: "needs an editor URL from Polaris Locker, under Packages",
      });
    }
  }
  return { steps: [...files, ...execs], skipped };
}
