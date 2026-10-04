/**
 * The Feeds area's model (F-11, plans/F-01.md §6.9): scopes, links, labels and the setup
 * snippets, shared by both scopes' pages.
 *
 * One component set serves two places: Platform → Package feeds (the system product's feeds, our
 * SDKs, plus the platform policy) and a product's Distribution → Package feeds. `FeedScope` picks
 * the API base and the links, and hides what a product scope has no use for (the Owner column,
 * the platform policy).
 */

import {
  Bird,
  Braces,
  Coffee,
  Container,
  Gamepad2,
  Hexagon,
  type LucideIcon,
} from "lucide-react";
import type {
  FeedEcosystem,
  FeedOffReason,
  FeedScope,
  FeedSettings,
} from "../../../api.js";
import { r } from "../../routes.js";

export type { FeedScope };

/** The platform's own product (`@polaris-key/manifest` SYSTEM_PRODUCT_SLUG). */
export const SYSTEM_PRODUCT_SLUG = "polaris-key";

export const PLATFORM_SCOPE: FeedScope = { kind: "platform" };

/** The tier-1 ecosystems, in the console's order. */
export const ECOSYSTEMS: readonly FeedEcosystem[] = [
  "npm",
  "pypi",
  "oci",
  "swift",
  "maven",
  "godot",
];

export function isEcosystem(v: string | undefined): v is FeedEcosystem {
  return v !== undefined && (ECOSYSTEMS as readonly string[]).includes(v);
}

export const ECOSYSTEM_LABELS: Record<FeedEcosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  oci: "Docker / OCI",
  swift: "Swift",
  maven: "Maven / Gradle",
  godot: "Godot",
};

/** The clients each feed answers, as the docs list them. */
export const ECOSYSTEM_CLIENTS: Record<FeedEcosystem, string> = {
  npm: "npm, pnpm, Yarn Berry, Bun",
  pypi: "pip, uv, Poetry",
  oci: "docker, podman, crane",
  swift: "SwiftPM",
  maven: "Gradle, Maven",
  godot: "The Godot editor's asset library, GodotEnv",
};

export const ECOSYSTEM_ICONS: Record<FeedEcosystem, LucideIcon> = {
  npm: Hexagon,
  pypi: Braces,
  oci: Container,
  swift: Bird,
  maven: Coffee,
  godot: Gamepad2,
};

/** Access modes as the Feeds pages name them (a registry client presents a token, not a device). */
export const FEED_ACCESS_LABELS: Record<string, string> = {
  public: "Public",
  authenticated: "Token",
  licensed: "Licensed",
  entitled: "Entitled",
};

export const FEED_ACCESS_DESCRIPTIONS: Record<string, string> = {
  public: "Any client can install, with no credentials.",
  authenticated: "Clients presenting a registry token.",
  licensed: "Clients presenting a token tied to an active license.",
  entitled: "Clients whose license grants the package's entitlement flag.",
};

/** Why a feed does not answer, in words. */
export const OFF_REASONS: Record<FeedOffReason, string> = {
  "platform-off": "The platform has this ecosystem switched off.",
  "no-owner": "The platform's feeds are not set up.",
  "distribution-off": "Distribution is off for this product.",
  "package-feeds-off": "Package feeds are off for this product.",
  "not-set-up": "This feed has no settings yet.",
  "feed-off": "This feed is switched off.",
};

/** What a yank does to clients, per protocol (notes/S-12 §8.2). */
export const YANK_EFFECTS: Record<FeedEcosystem, string> = {
  npm: "npm has no yank that keeps lockfiles working. Deprecate a version instead: it stays installable and npm prints the message.",
  pypi: "A yanked version stays installable when pinned exactly (PEP 592); resolvers skip it otherwise.",
  oci: "A yank removes the version tag. The image stays pullable by digest.",
  swift:
    "A yanked version leaves the release list and stays fetchable for existing Package.resolved pins.",
  maven:
    "Maven has no yank. The console marks the version yanked; with Hide yanked versions on, it also leaves maven-metadata.xml.",
  godot: "A yanked version leaves the asset listings.",
};

/** The feed page in this scope (its default tab, or `tab`). */
export function feedHref(
  scope: FeedScope,
  eco: FeedEcosystem,
  tab?: string,
): string {
  return scope.kind === "platform"
    ? r.platformFeed(eco, tab)
    : r.packageFeed(scope.slug, eco, tab);
}

/** The Feeds overview in this scope. */
export function overviewHref(scope: FeedScope): string {
  return scope.kind === "platform"
    ? r.platformFeeds()
    : r.packageFeeds(scope.slug);
}

/** A package record in this scope (platform: under its owner). */
export function packageHref(
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
  tab?: string,
): string {
  return scope.kind === "platform"
    ? r.platformFeedPackage(eco, owner, name, tab)
    : r.packageFeedPackage(scope.slug, eco, name, tab);
}

export interface Snippet {
  title: string;
  description?: string;
  filename?: string;
  language: "sh" | "toml" | "text" | "json";
  code: string;
}

/** The registry host's hostname, for clients that take a host rather than a URL (docker). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * The copy-paste setup for one feed, for its owner, optionally for one package. Basic per
 * ecosystem; F-12 replaces it with `renderFeedSetup` from `@polaris-key/manifest`, which the CLI's
 * `pkey feeds setup` shares, and adds each ecosystem's variants.
 */
export function setupSnippets(
  eco: FeedEcosystem,
  ctx: {
    baseUrl: string;
    owner: string;
    namespace: FeedSettings["namespace"];
    pkg?: { name: string; version?: string | null };
  },
): Snippet[] {
  const { baseUrl, owner, namespace, pkg } = ctx;
  const ns = namespace as Record<string, unknown>;
  const version = pkg?.version ?? null;
  switch (eco) {
    case "npm": {
      const scope =
        (typeof ns.scope === "string" && ns.scope) ||
        (pkg?.name.startsWith("@") ? pkg.name.split("/")[0]! : "@scope");
      return [
        {
          title: "Point the scope at this feed",
          filename: ".npmrc",
          language: "text",
          code: `${scope}:registry=${baseUrl}`,
        },
        {
          title: "Install",
          language: "sh",
          code: `npm install ${pkg ? `${pkg.name}${version ? `@${version}` : ""}` : `${scope}/<package>`}`,
        },
      ];
    }
    case "pypi": {
      const name = pkg?.name ?? "<package>";
      return [
        {
          title: "uv: an explicit index",
          description:
            "explicit = true keeps every other dependency on its usual index.",
          filename: "pyproject.toml",
          language: "toml",
          code: `[[tool.uv.index]]\nname = "${owner}"\nurl = "${baseUrl}"\nexplicit = true\n\n[tool.uv.sources]\n${JSON.stringify(name)} = { index = "${owner}" }`,
        },
        {
          title: "pip",
          language: "sh",
          code: `pip install --index-url ${baseUrl} ${name}${version ? `==${version}` : ""}`,
        },
      ];
    }
    case "oci": {
      const repo = pkg?.name ?? "<repository>";
      const tag = version ?? "latest";
      return [
        {
          title: "Pull",
          language: "sh",
          code: `docker pull ${hostOf(baseUrl)}/${owner}/${repo}:${tag}`,
        },
      ];
    }
    case "swift": {
      const scope =
        (typeof ns.scope === "string" && ns.scope) ||
        (pkg ? pkg.name.split(".")[0]! : "<scope>");
      const id = pkg?.name ?? `${scope}.<Package>`;
      return [
        {
          title: "Register the scope",
          language: "sh",
          code: `swift package-registry set --scope ${scope} ${baseUrl}`,
        },
        {
          title: "Depend on the package",
          filename: "Package.swift",
          language: "text",
          code: `.package(id: "${id}", from: "${version ?? "1.0.0"}")`,
        },
      ];
    }
    case "maven": {
      const groups = Array.isArray(ns.groupPrefixes)
        ? (ns.groupPrefixes as string[])
        : [];
      const group =
        groups[0] ?? (pkg ? pkg.name.split(":")[0]! : "<group.prefix>");
      const filters = (groups.length ? groups : [group])
        .map(
          (g) =>
            `      includeGroupByRegex("${g.replace(/\./g, "\\\\.")}(\\\\..*)?")`,
        )
        .join("\n");
      const coord = pkg
        ? `${pkg.name}:${version ?? "<version>"}`
        : `${group}:<artifact>:<version>`;
      return [
        {
          title: "Gradle: this feed, for its groups only",
          filename: "settings.gradle.kts",
          language: "text",
          code: `dependencyResolutionManagement {\n  repositories {\n    exclusiveContent {\n      forRepository { maven { url = uri("${baseUrl}") } }\n      filter {\n${filters}\n      }\n    }\n    mavenCentral()\n  }\n}`,
        },
        {
          title: "Depend on the artifact",
          filename: "build.gradle.kts",
          language: "text",
          code: `implementation("${coord}")`,
        },
      ];
    }
    case "godot":
      return [
        {
          title:
            "Godot 4.6 and earlier: Editor Settings → Asset Library → Available URLs",
          language: "text",
          code: `${baseUrl}asset-library/api`,
        },
        {
          title: "Godot 4.7 and later: the asset store URL",
          language: "text",
          code: `${baseUrl}store/api/v1`,
        },
      ];
  }
}

/** A byte count as an operator types it: whole MiB when it divides evenly. */
export function bytesToMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function mibToBytes(mib: number): number {
  return Math.round(mib * 1024 * 1024);
}
