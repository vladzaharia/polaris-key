/**
 * The Feeds area's model (F-11, F-12, plans/F-01.md §6.9): scopes, links, labels, the setup
 * snippets and the ecosystem panels' extension fields, shared by both scopes' pages.
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
  Cog,
  Container,
  Gamepad2,
  Hexagon,
  type LucideIcon,
} from "lucide-react";
import {
  FEED_SETUP,
  feedSetupProblem,
  renderFeedSetup,
  type FeedSetupCredential,
  type FeedSnippet,
} from "@polaris-key/manifest";
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

/** The ecosystems, in the console's order. */
export const ECOSYSTEMS: readonly FeedEcosystem[] = [
  "npm",
  "pypi",
  "oci",
  "swift",
  "maven",
  "godot",
  "cargo",
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
  cargo: "Cargo",
};

/** The clients each feed answers: its setup declaration's (`@polaris-key/manifest` FEED_SETUP). */
export const ECOSYSTEM_CLIENTS: Record<FeedEcosystem, string> =
  Object.fromEntries(
    ECOSYSTEMS.map((e) => [e, FEED_SETUP[e].clients.join(", ")]),
  ) as Record<FeedEcosystem, string>;

export const ECOSYSTEM_ICONS: Record<FeedEcosystem, LucideIcon> = {
  npm: Hexagon,
  pypi: Braces,
  oci: Container,
  swift: Bird,
  maven: Coffee,
  godot: Gamepad2,
  cargo: Cog,
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
  cargo:
    "A yanked version stays in the index marked yanked: an existing Cargo.lock still builds, and new resolutions skip it.",
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

export type { FeedSnippet };

/** What the snippets authenticate with (plans/F-20.md §3): nothing; an environment variable
 *  (docs, CI); the real token, only in the shown-once dialog; or a Godot URL token, which travels
 *  in the editor's URL. `@polaris-key/manifest`'s `FeedSetupCredential`, the shape
 *  `renderFeedSetup` and `pkey feeds setup --token-env` share. */
export type FeedCredential = FeedSetupCredential;

/** The environment variable the docs and the Setup tab name the token by. */
export const TOKEN_ENV = "PKEY_REGISTRY_TOKEN";

/** The username every client that needs one sends beside a registry token. */
export const REGISTRY_USERNAME = "__token__";

/**
 * The copy-paste setup for one feed, for its owner, optionally for one package, with or without a
 * registry credential (F-21, plans/F-20.md §6.3): `@polaris-key/manifest` `renderFeedSetup`, the
 * function `pkey feeds setup` prints, so the console and the CLI are byte-identical for the same
 * input. The inputs each ecosystem's snippets read are its declaration
 * (`FEED_SETUP[eco].inputs`), never a switch here. Answers `null` when the stored settings (or
 * the token) cannot be rendered (a namespace ingest would refuse).
 */
export function feedSetupSnippets(
  eco: FeedEcosystem,
  ctx: {
    /** The registry host's origin (`registryOrigin`, or a package's base URL's origin). */
    origin: string;
    owner: string;
    namespace: FeedSettings["namespace"];
    pkg?: { name: string; version?: string | null };
  },
  credential: FeedCredential = { kind: "none" },
): FeedSnippet[] | null {
  const context = {
    origin: new URL(ctx.origin).origin,
    owner: ctx.owner,
    namespace: ctx.namespace,
    ...(ctx.pkg
      ? {
          package: {
            name: ctx.pkg.name,
            ...(ctx.pkg.version ? { version: ctx.pkg.version } : {}),
          },
        }
      : {}),
    ...(credential.kind === "none" ? {} : { credential }),
  };
  if (feedSetupProblem(eco, context) !== null) return null;
  return renderFeedSetup(eco, context);
}

/** A byte count as an operator types it: whole MiB when it divides evenly. */
export function bytesToMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function mibToBytes(mib: number): number {
  return Math.round(mib * 1024 * 1024);
}

/**
 * How the ecosystem panel (F-12) edits one extension setting, keyed by the setting's name, never
 * by ecosystem: the panel renders the keys the feed's adapter declares (`FeedDetailDto.extensions`)
 * and saves them into `ext_json`. A key the adapter declares but this table lacks is not shown.
 */
export type FeedExtensionInput =
  | { kind: "switch"; default: boolean }
  | { kind: "number"; min: number; max: number; unit: string }
  | {
      kind: "select";
      options: readonly { value: string; label: string }[];
      default: string;
      /** The stored value is a number (`categoryId`). */
      numeric?: boolean;
    }
  | { kind: "text"; placeholder: string; maxLength: number; pattern?: RegExp }
  | { kind: "repositoryMap"; placeholder: string };

export interface FeedExtensionField {
  label: string;
  help: string;
  input: FeedExtensionInput;
}

export const FEED_EXTENSION_FIELDS: Record<string, FeedExtensionField> = {
  htmlFallback: {
    label: "HTML pages",
    help: "Answer clients that cannot take PEP 691 JSON with the inert PEP 503 HTML page. Off, they get 406.",
    input: { kind: "switch", default: true },
  },
  requireSigned: {
    label: "Require signed releases",
    help: "Ingest refuses a release without a SwiftPM signature. Always on for the platform's own packages.",
    input: { kind: "switch", default: true },
  },
  repositoryUrls: {
    label: "Repository URLs",
    help: "Which source repositories are which package, for SwiftPM's identifier lookup. One per line: the identity, then the URL.",
    input: {
      kind: "repositoryMap",
      placeholder: "acme.Kit https://github.com/acme/kit",
    },
  },
  retainUntaggedDays: {
    label: "Untagged manifests",
    help: "Recorded with the feed: nothing removes an untagged image manifest, so every one is kept whatever this holds. A published version is never removed.",
    input: { kind: "number", min: 0, max: 3650, unit: "days" },
  },
  categoryId: {
    label: "Category",
    help: "The asset library category every addon of this feed is listed under.",
    input: {
      kind: "select",
      numeric: true,
      default: "5",
      options: [
        { value: "1", label: "2D Tools" },
        { value: "2", label: "3D Tools" },
        { value: "3", label: "Shaders" },
        { value: "4", label: "Materials" },
        { value: "5", label: "Tools" },
        { value: "6", label: "Scripts" },
        { value: "7", label: "Misc" },
      ],
    },
  },
  supportLevel: {
    label: "Support level",
    help: "The support level the editor shows for every addon of this feed.",
    input: {
      kind: "select",
      default: "community",
      options: [
        { value: "official", label: "Official" },
        { value: "community", label: "Community" },
        { value: "testing", label: "Testing" },
      ],
    },
  },
  license: {
    label: "License",
    help: "Shown as each addon's license. Empty shows Unspecified.",
    input: { kind: "text", placeholder: "MIT", maxLength: 64 },
  },
  minGodotVersion: {
    label: "Oldest editor",
    help: "Editors older than this, or of another major version, see no addons. Empty lists them to every editor.",
    input: {
      kind: "text",
      placeholder: "4.4",
      maxLength: 8,
      pattern: /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/,
    },
  },
};

/** The ecosystem panel's section title, per protocol. */
export const FEED_PANEL_TITLES: Record<FeedEcosystem, string> = {
  npm: "npm",
  pypi: "Simple API",
  swift: "Signing and identifiers",
  maven: "Maven",
  oci: "Retention",
  godot: "Asset listing",
  cargo: "Sparse index",
};
