/**
 * Which feed, scope and package `<InstallSteps>` asks `feedsSetup()` for, per SDK (docs plan §4).
 * Kept out of the component so a test can feed the same mapping to the CLI's own function.
 */
import { type SdkId } from "./docs";

/** An SDK, or "cli" for the `pkey` command-line tool (npm feed). */
export type InstallTarget = SdkId | "cli";

export interface FeedTarget {
  /** The feed's ecosystem, as `pkey feeds setup --ecosystem` takes it. */
  ecosystem: string;
  /** `key=value` namespace pairs, as `pkey feeds setup --namespace` takes them. */
  namespace: string[];
  /** The package to install. */
  package: string;
  /**
   * The version `feedsSetup()` writes into the install line, where the client takes a range. Only
   * Swift has one: without it the generated line is `from: "1.0.0"`, which matches no release
   * while the feed's newest is 0.9.x. `from:` takes the newest release at or above it and below
   * the next major, so the line stays valid as 0.9 patches ship. Move it with the version line
   * (the 1.0 readiness review).
   */
  version?: string;
}

export const FEEDS: Readonly<Record<InstallTarget, FeedTarget>> = {
  node: {
    ecosystem: "npm",
    namespace: ["scope=@polaris-key"],
    package: "@polaris-key/node",
  },
  react: {
    ecosystem: "npm",
    namespace: ["scope=@polaris-key"],
    package: "@polaris-key/react",
  },
  python: { ecosystem: "pypi", namespace: [], package: "polaris-key" },
  swift: {
    ecosystem: "swift",
    namespace: ["scope=polaris-key"],
    package: "polaris-key.PolarisKey",
    version: "0.9.0",
  },
  kotlin: {
    ecosystem: "maven",
    namespace: ["groupPrefixes=im.plrs.key"],
    package: "im.plrs.key:polaris-key-sdk",
  },
  godot: { ecosystem: "godot", namespace: [], package: "polaris_key" },
  cli: {
    ecosystem: "npm",
    namespace: ["scope=@polaris-key"],
    package: "@polaris-key/cli",
  },
};

export const INSTALL_LABELS: Readonly<Record<InstallTarget, string>> = {
  node: "the Node SDK",
  react: "the React SDK",
  python: "the Python SDK",
  swift: "the Swift SDK",
  kotlin: "the Kotlin SDK",
  godot: "the Godot add-on",
  cli: "the pkey CLI",
};
