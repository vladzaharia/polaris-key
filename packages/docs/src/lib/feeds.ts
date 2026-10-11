/**
 * Which feed, scope and package `<InstallSteps>` asks `feedsSetup()` for, per SDK (docs plan §4).
 * Kept out of the component so a test can feed the same mapping to the CLI's own function.
 */
import { SDK_LABELS, type SdkId } from "./docs";

/** An SDK, or "cli" for the `pkey` command-line tool (npm feed). */
export type InstallTarget = SdkId | "cli";

export interface FeedTarget {
  /** The feed's ecosystem, as `pkey feeds setup --ecosystem` takes it. */
  ecosystem: string;
  /** `key=value` namespace pairs, as `pkey feeds setup --namespace` takes them. */
  namespace: string[];
  /** The package to install. */
  package: string;
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
  ...SDK_LABELS,
  cli: "the pkey CLI",
};
