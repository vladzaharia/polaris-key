/**
 * `sdkFit`: which SDK, host and framework an app should integrate with, from the platforms the
 * product intends and what a linked repo's manifests declare (SP-33a; the SDK usability review
 * §4.3 and the framework drop-ins plan §10). Pure: the caller reads the repo and hands over names.
 *
 * Hosts decide the lane. An `app` has screens and takes the drop-in kit; a `cli` takes the
 * terminal kit; a `server` has no screens and takes the library (`lane: "server"`).
 */

import type { SdkLang } from "./sdkConfig.js";

export type SdkId = SdkLang;
export const SDK_IDS: readonly SdkId[] = [
  "node",
  "react",
  "python",
  "swift",
  "kotlin",
  "godot",
];

export type SdkHost = "app" | "server" | "cli";

/**
 * The finer target a host runs on, where the SDK forks by it: Node (`cli`, `electron`,
 * `server`), Kotlin (`android`, `desktop`), Python (`cli`, `qt`, `none`). Null where an SDK has
 * one target.
 */
export type SdkTarget =
  | "cli"
  | "electron"
  | "server"
  | "android"
  | "desktop"
  | "qt"
  | "none";

/** What the product says it ships on (the manifest's deliverables, or the wizard's platforms). */
export type FitPlatform =
  | "web"
  | "windows"
  | "macos"
  | "linux"
  | "ios"
  | "android"
  | "godot"
  | "server";

/**
 * What a repo declares, as dependency names per ecosystem. The caller reads `package.json`,
 * `pyproject.toml` or `requirements*.txt`, Gradle files and `Package.swift`, and passes the names.
 */
export interface RepoSignals {
  npm?: readonly string[];
  python?: readonly string[];
  gradle?: readonly string[];
  swift?: readonly string[];
  /** A `project.godot` is present. */
  godot?: boolean;
}

export interface SdkFit {
  sdk: SdkId | null;
  host: SdkHost | null;
  target: SdkTarget | null;
  /** The server or CLI framework the repo declares, when one is recognised. */
  framework: string | null;
}

const NPM_SERVER: Record<string, string> = {
  express: "express",
  hono: "hono",
  next: "next",
  fastify: "fastify",
  "@nestjs/core": "nest",
  koa: "koa",
};
const NPM_CLI: Record<string, string> = {
  commander: "commander",
  yargs: "yargs",
  "@oclif/core": "oclif",
  ink: "ink",
};
const PY_SERVER: Record<string, string> = {
  fastapi: "fastapi",
  starlette: "starlette",
  flask: "flask",
  django: "django",
  djangorestframework: "drf",
};
const PY_CLI: Record<string, string> = {
  click: "click",
  typer: "typer",
  textual: "textual",
};
const PY_QT = ["pyside6", "pyqt6", "pyqt5", "pyside2"];
const GRADLE_SERVER: Record<string, string> = {
  "io.ktor:ktor-server-core": "ktor",
  "org.springframework.boot": "spring",
};
const GRADLE_CLI: Record<string, string> = {
  "com.github.ajalt.clikt": "clikt",
  "info.picocli": "picocli",
};
const SWIFT_SERVER: Record<string, string> = { vapor: "vapor" };

/** A dependency name as `pyproject.toml` or `requirements.txt` writes it: lower case, no extras. */
function pyName(n: string): string {
  return (n.toLowerCase().split(/[\s[<>=!~;@(]/)[0] ?? "").replace(/_/g, "-");
}

/** The first of `names` whose key (or a key it starts with) is in `table`. */
function first(
  names: readonly string[],
  table: Record<string, string>,
): string | null {
  for (const n of names)
    for (const [key, framework] of Object.entries(table))
      if (n === key || n.startsWith(`${key}:`) || n.startsWith(`${key}.`))
        return framework;
  return null;
}

/**
 * Pick the SDK, host and framework. A server or CLI framework in the repo beats the platforms; with
 * no repo, the platforms decide, and a product with no platform gets `sdk: null` (the developer
 * picks).
 */
export function sdkFit(
  platforms: readonly FitPlatform[],
  repo: RepoSignals = {},
): SdkFit {
  const npm = repo.npm ?? [];
  const py = (repo.python ?? []).map(pyName);
  const gradle = repo.gradle ?? [];
  const swift = (repo.swift ?? []).map((s) => s.toLowerCase());
  const has = (p: FitPlatform): boolean => platforms.includes(p);

  // A repo's own dependencies are the strongest signal.
  const npmServer = first(npm, NPM_SERVER);
  const npmCli = first(npm, NPM_CLI);
  const pyServer = first(py, PY_SERVER);
  const pyCli = first(py, PY_CLI);
  const gradleServer = first(gradle, GRADLE_SERVER);
  const gradleCli = first(gradle, GRADLE_CLI);
  const swiftServer = first(swift, SWIFT_SERVER);

  if (npmServer)
    return {
      sdk: "node",
      host: "server",
      target: "server",
      framework: npmServer,
    };
  if (pyServer)
    return {
      sdk: "python",
      host: "server",
      target: "none",
      framework: pyServer,
    };
  if (gradleServer)
    return {
      sdk: "kotlin",
      host: "server",
      target: "desktop",
      framework: gradleServer,
    };
  if (swiftServer)
    return {
      sdk: "swift",
      host: "server",
      target: null,
      framework: swiftServer,
    };

  if (repo.godot || has("godot"))
    return { sdk: "godot", host: "app", target: null, framework: null };

  if (npm.includes("electron"))
    return { sdk: "node", host: "app", target: "electron", framework: null };
  if (npmCli)
    return { sdk: "node", host: "cli", target: "cli", framework: npmCli };
  if (pyCli)
    return { sdk: "python", host: "cli", target: "cli", framework: pyCli };
  if (gradleCli)
    return {
      sdk: "kotlin",
      host: "cli",
      target: "desktop",
      framework: gradleCli,
    };
  if (py.some((n) => PY_QT.includes(n)))
    return { sdk: "python", host: "app", target: "qt", framework: null };
  if (npm.includes("react") || npm.includes("react-dom"))
    return { sdk: "react", host: "app", target: null, framework: null };
  if (
    gradle.some((g) => g.startsWith("androidx.") || g.startsWith("com.android"))
  )
    return { sdk: "kotlin", host: "app", target: "android", framework: null };

  // No repo signal: the platforms.
  if (has("android"))
    return { sdk: "kotlin", host: "app", target: "android", framework: null };
  if (has("ios"))
    return { sdk: "swift", host: "app", target: null, framework: null };
  if (has("web"))
    return { sdk: "react", host: "app", target: null, framework: null };
  if (has("macos") && !has("windows") && !has("linux") && swift.length > 0)
    return { sdk: "swift", host: "app", target: null, framework: null };
  if (has("server"))
    return { sdk: "node", host: "server", target: "server", framework: null };
  if (has("windows") || has("macos") || has("linux"))
    return { sdk: "node", host: "app", target: "electron", framework: null };
  return { sdk: null, host: null, target: null, framework: null };
}
