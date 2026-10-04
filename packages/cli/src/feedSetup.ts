/**
 * `pkey feeds setup` (F-12, plans/F-01.md §6.9; `--token-env` from plans/F-20.md §5): print what a
 * client needs to install from one package feed on the registry host. Offline and pure: it calls
 * `@polaris-key/manifest` `renderFeedSetup`, the same function behind the console's Setup tabs,
 * and prints it through `formatFeedSetup`, so the CLI and the console are byte-identical for the
 * same input (the shared goldens in `packages/shared-manifest/test/fixtures/feed-setup/`).
 *
 * The namespace comes as `--namespace <key>=<value>`, repeatable, whose keys are the ecosystem's
 * declared namespace fields (`PACKAGE_ECOSYSTEM_RULES[e].namespace.fields`): a list field takes
 * comma-separated values (`--namespace groupPrefixes=gg.acme,gg.acme.tools`). Nothing here
 * switches on the ecosystem.
 */

import {
  DEFAULT_REGISTRY_ORIGIN,
  PACKAGE_ECOSYSTEMS,
  PACKAGE_ECOSYSTEM_RULES,
  feedSetupProblem,
  formatFeedSetup,
  isFeedTokenEnvName,
  isPackageEcosystem,
  renderFeedSetup,
  type FeedSetupContext,
} from "@polaris-key/manifest";

export const FEEDS_SETUP_USAGE =
  "Usage: pkey feeds setup --ecosystem <" +
  PACKAGE_ECOSYSTEMS.join("|") +
  "> --owner <slug>\n" +
  "              [--namespace key=value ...] [--package name [--version v]]\n" +
  "              [--origin url] [--token-env NAME] [--json]";

export interface FeedsSetupOptions {
  ecosystem?: string;
  owner?: string;
  /** `key=value` pairs, in order. */
  namespace?: readonly string[];
  package?: string;
  version?: string;
  origin?: string;
  tokenEnv?: string;
  json?: boolean;
}

/** The text `pkey feeds setup` prints (or its JSON form with `json`). Throws on a bad input. */
export function feedsSetup(opts: FeedsSetupOptions): string {
  const { ecosystem, owner } = opts;
  if (!ecosystem || !owner) throw new Error(FEEDS_SETUP_USAGE);
  if (!isPackageEcosystem(ecosystem))
    throw new Error(
      `--ecosystem must be one of ${PACKAGE_ECOSYSTEMS.join(", ")}.\n${FEEDS_SETUP_USAGE}`,
    );
  if (opts.version && !opts.package)
    throw new Error(`--version goes with --package.\n${FEEDS_SETUP_USAGE}`);
  if (opts.tokenEnv !== undefined && !isFeedTokenEnvName(opts.tokenEnv))
    throw new Error(
      `--token-env takes an environment variable's name (like PKEY_REGISTRY_TOKEN), never the token itself.`,
    );
  if (opts.tokenEnv !== undefined && ecosystem === "godot")
    throw new Error(
      `--token-env does not apply to godot: the editor and GodotEnv authenticate by a token in the feed's URL, which only the console shows.`,
    );
  const fields = PACKAGE_ECOSYSTEM_RULES[ecosystem].namespace.fields;
  const namespace: Record<string, unknown> = {};
  for (const pair of opts.namespace ?? []) {
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq) : "";
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!field) {
      const keys = Object.keys(fields);
      throw new Error(
        keys.length
          ? `--namespace takes ${keys.map((k) => `${k}=…`).join(" or ")} for ${ecosystem}.`
          : `${ecosystem} feeds have no namespace to set.`,
      );
    }
    const value = pair.slice(eq + 1).trim();
    namespace[key] =
      field.kind === "list"
        ? value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : value;
  }
  const ctx: FeedSetupContext = {
    origin: (opts.origin ?? DEFAULT_REGISTRY_ORIGIN).replace(/\/+$/, ""),
    owner,
    ...(Object.keys(namespace).length ? { namespace } : {}),
    ...(opts.package
      ? {
          package: {
            name: opts.package,
            ...(opts.version ? { version: opts.version } : {}),
          },
        }
      : {}),
    ...(opts.tokenEnv
      ? { credential: { kind: "env" as const, name: opts.tokenEnv } }
      : {}),
  };
  const problem = feedSetupProblem(ecosystem, ctx);
  if (problem !== null) throw new Error(`pkey feeds setup: ${problem}.`);
  const snippets = renderFeedSetup(ecosystem, ctx);
  return opts.json
    ? `${JSON.stringify({ ecosystem, owner, snippets }, null, 2)}\n`
    : formatFeedSetup(snippets);
}
