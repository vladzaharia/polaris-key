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

/** The scope's registry tokens page (F-21). */
export function tokensHref(scope: FeedScope): string {
  return scope.kind === "platform"
    ? r.platformFeed("tokens")
    : r.packageFeed(scope.slug, "tokens");
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

/** What the snippets authenticate with (plans/F-20.md §3, the shape F-12's `renderFeedSetup`
 *  takes): nothing; an environment variable (docs, CI); the real token, only in the shown-once
 *  dialog; or a Godot URL token, which travels in the editor's URL. */
export type FeedCredential =
  | { kind: "none" }
  | { kind: "env"; name: string }
  | { kind: "token"; value: string }
  | { kind: "godot-url"; value: string };

/** The environment variable the docs and the Setup tab name the token by. */
export const TOKEN_ENV = "PKEY_REGISTRY_TOKEN";

/** The username every client that needs one sends beside a registry token. */
export const REGISTRY_USERNAME = "__token__";

interface SnippetContext {
  baseUrl: string;
  owner: string;
  namespace: FeedSettings["namespace"];
  pkg?: { name: string; version?: string | null };
}

/**
 * The copy-paste setup for one feed, for its owner, optionally for one package, with or without a
 * registry credential (F-21, plans/F-20.md §6.3). Basic per ecosystem; F-12 moves it into
 * `renderFeedSetup` in `@polaris-key/manifest`, which the CLI's `pkey feeds setup` shares, keeping
 * this `credential` argument.
 */
export function setupSnippets(
  eco: FeedEcosystem,
  ctx: SnippetContext,
  credential: FeedCredential = { kind: "none" },
): Snippet[] {
  if (credential.kind === "none") return anonymousSnippets(eco, ctx);
  return authenticatedSnippets(eco, ctx, credential);
}

function anonymousSnippets(eco: FeedEcosystem, ctx: SnippetContext): Snippet[] {
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

/** How a token is written in each format: the env reference, or the value itself. */
function secretIn(
  credential: Exclude<FeedCredential, { kind: "none" }>,
  format: "sh" | "npmrc" | "yaml" | "toml" | "xml" | "properties",
): string {
  if (credential.kind !== "env") return credential.value;
  const n = credential.name;
  switch (format) {
    case "sh":
      return `"$${n}"`;
    case "npmrc":
    case "yaml":
      return `\${${n}}`;
    case "xml":
      return `\${env.${n}}`;
    case "toml":
    case "properties":
      return `<${n}>`;
  }
}

/** An identifier from the owner slug (Gradle property names, uv's index env names). */
function ident(owner: string): string {
  return owner.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) =>
    c ? c.toUpperCase() : "",
  );
}

function authenticatedSnippets(
  eco: FeedEcosystem,
  ctx: SnippetContext,
  credential: Exclude<FeedCredential, { kind: "none" }>,
): Snippet[] {
  const { baseUrl, owner } = ctx;
  const plain = anonymousSnippets(eco, ctx);
  const host = hostOf(baseUrl);
  const T = (f: Parameters<typeof secretIn>[1]) => secretIn(credential, f);
  const envNote =
    credential.kind === "env"
      ? `Set ${credential.name} to a registry token first.`
      : undefined;
  switch (eco) {
    case "npm": {
      const ns = ctx.namespace as Record<string, unknown>;
      const scope = (typeof ns.scope === "string" && ns.scope) || "@scope";
      const path = baseUrl.replace(/^https?:/, "");
      return [
        {
          title: "npm and pnpm: the scope and its token",
          ...(envNote ? { description: envNote } : {}),
          filename: ".npmrc",
          language: "text",
          code: `${scope}:registry=${baseUrl}\n${path}:_authToken=${T("npmrc")}`,
        },
        {
          title: "Yarn Berry",
          filename: ".yarnrc.yml",
          language: "text",
          code: `npmScopes:\n  ${scope.replace(/^@/, "")}:\n    npmRegistryServer: "${baseUrl}"\n    npmAuthToken: "${T("yaml")}"\n    npmAlwaysAuth: true`,
        },
        ...plain.slice(1),
      ];
    }
    case "pypi": {
      const name = ctx.pkg?.name ?? "<package>";
      const env = `UV_INDEX_${ident(owner).toUpperCase()}`;
      const withCreds = baseUrl.replace(
        /^https:\/\//,
        `https://${REGISTRY_USERNAME}:${credential.kind === "env" ? `\${${credential.name}}` : credential.value}@`,
      );
      return [
        {
          title: "uv: an explicit index that always authenticates",
          ...(envNote ? { description: envNote } : {}),
          filename: "pyproject.toml",
          language: "toml",
          code: `[[tool.uv.index]]\nname = "${owner}"\nurl = "${baseUrl}"\nexplicit = true\nauthenticate = "always"`,
        },
        {
          title: "uv: the credentials",
          language: "sh",
          code: `export ${env}_USERNAME=${REGISTRY_USERNAME}\nexport ${env}_PASSWORD=${T("sh")}`,
        },
        {
          title: "pip",
          language: "sh",
          code: `pip install --index-url "${withCreds}" ${name}`,
        },
      ];
    }
    case "oci":
      return [
        {
          title: "Log in once per machine",
          description:
            "docker, podman, crane and oras hold one credential per registry host.",
          language: "sh",
          code: `echo ${credential.kind === "env" ? T("sh") : `'${credential.value}'`} | docker login ${host} -u ${REGISTRY_USERNAME} --password-stdin`,
        },
        ...plain,
      ];
    case "swift": {
      const ci = credential.kind === "env" ? " --no-confirm" : "";
      return [
        plain[0]!,
        {
          title: "Log in",
          description:
            "SwiftPM keeps one credential per registry host (the keychain, or ~/.netrc on Linux).",
          language: "sh",
          code: `swift package-registry login ${baseUrl.replace(/\/$/, "")} --token ${T("sh")}${ci}`,
        },
        ...plain.slice(1),
      ];
    }
    case "maven": {
      const id = ident(owner);
      return [
        {
          title: "Gradle: password credentials for this feed",
          filename: "settings.gradle.kts",
          language: "text",
          code: `maven {\n  name = "${id}"\n  url = uri("${baseUrl}")\n  credentials(PasswordCredentials::class)\n}`,
        },
        {
          title: "Gradle: the credentials",
          ...(envNote ? { description: envNote } : {}),
          filename: "~/.gradle/gradle.properties",
          language: "text",
          code: `${id}Username=${REGISTRY_USERNAME}\n${id}Password=${T("properties")}`,
        },
        {
          title: "Maven",
          filename: "~/.m2/settings.xml",
          language: "text",
          code: `<server>\n  <id>${id}</id>\n  <username>${REGISTRY_USERNAME}</username>\n  <password>${T("xml")}</password>\n</server>`,
        },
      ];
    }
    case "godot": {
      if (credential.kind !== "godot-url")
        return [
          {
            title: "The Godot editor needs a Godot editor URL token",
            language: "text",
            code: "Create a token with “Godot editor URL” on: the editor sends no credentials, so the token goes in its URL.",
          },
        ];
      const base = `${baseUrl}t/${credential.value}/`;
      return [
        {
          title:
            "Godot 4.6 and earlier: Editor Settings → Asset Library → Available URLs",
          language: "text",
          code: `${base}asset-library/api`,
        },
        {
          title: "Godot 4.7 and later: the asset store URL",
          language: "text",
          code: `${base}store/api/v1`,
        },
        {
          title: "GodotEnv",
          language: "text",
          code: `${base}index.json`,
        },
      ];
    }
  }
}

/** A byte count as an operator types it: whole MiB when it divides evenly. */
export function bytesToMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function mibToBytes(mib: number): number {
  return Math.round(mib * 1024 * 1024);
}
