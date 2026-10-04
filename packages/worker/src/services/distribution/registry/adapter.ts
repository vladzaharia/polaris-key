/**
 * THE FEED ADAPTER CONTRACT — the one shape every package feed on the registry host implements.
 *
 * A feed (npm, PyPI, Swift, Maven, OCI, Godot; Cargo, Go and NuGet later) is one directory,
 * `registry/<ecosystem>/`, whose `index.ts` exports one `FeedAdapter`. Everything specific to the
 * ecosystem stays behind it: its URL layout, its documents, its negotiation, its quirks. What is
 * shared stays in this directory and is never re-implemented by a feed:
 *
 *   - the access ladder and the Cache API (`serve.ts` `feedRoute`, `authorize.ts`): every route an
 *     adapter lists is built by `feedRoute`, so no feed can answer before the ladder;
 *   - render-on-write (`materialise.ts`): the adapter supplies a pure `render` and says what its
 *     render stamp covers; the framework writes R2, stamps, drains the queue and self-checks;
 *   - Release's package state (`catalogSource.ts`), read only through the `releaseCatalog` hook;
 *   - the ingest rules (`@polaris-key/manifest` `PACKAGE_ECOSYSTEM_RULES`): the adapter points at
 *     its ecosystem's ONE declaration there, which the manifest validator, Release's ingest and
 *     the console's settings validation all read;
 *   - the console (`admin/lib/feedModel.ts`): labels, base URLs, namespace and extension
 *     validation and the capabilities the admin API exposes are read from the adapter, never
 *     switched on the ecosystem name.
 *
 * `registry/index.ts` lists the adapters (`FEED_ADAPTERS`); `mount.ts` spreads their routes into
 * the registry host's allowlist. `test/feedAdapters.test.ts` is the conformance suite every
 * adapter must pass — routes through the ladder, capabilities consistent with routes, settings
 * and renders, deterministic renders, the standard refusals, the OpenAPI rows and the
 * `routeCoverage` table (both derived from `openapi`), and a harness client in the workflow
 * matrix. A new adapter that skips a piece fails CI. The checklist is
 * `/docs/contribute/package-feeds/`.
 *
 * The shape is deliberately parallel to the planned storefront adapters (store connectors): an
 * adapter interface, a capability declaration the console reads, and a shared gate (here the
 * access ladder) and ledger (here the render queue and its stamps) the adapter cannot bypass.
 */

import type {
  PackageEcosystem,
  PackageEcosystemRules,
} from "@polaris-key/manifest";
import type { RegistryRoute } from "../../../core/registryHost.js";
import type { ChallengeKind } from "./authorize.js";
import type {
  RegistryPackage,
  RegistryRenderer,
  RenderContext,
  RenderedObject,
} from "./materialise.js";

/**
 * How Release's channels surface in the protocol (`RegistryPackage.tags`): every channel as an
 * npm dist-tag, every channel as a tag (OCI tags, Godot's index), only the stable head as the
 * protocol's "latest" (Maven `<release>`, Swift's `latest-version` link), or not at all (PyPI).
 */
export type FeedChannels = "dist-tags" | "tags" | "latest" | "none";

/**
 * What one ecosystem's protocol can express. The admin API exposes it on every feed and package
 * (`capabilities`), and the console reads it instead of switching on the ecosystem's name.
 */
export interface FeedCapabilities {
  /** A yank (and so an unyank) exists in the protocol. */
  readonly yank: boolean;
  /** A deprecation message (and so an undeprecate) exists in the protocol. */
  readonly deprecate: boolean;
  /** The feed's `yankHidesFromIndex` setting applies (the protocol has a list to leave). */
  readonly yankPolicy: boolean;
  readonly channels: FeedChannels;
  /** The protocol carries a package signature (Swift's CMS); the `requireSigned` setting applies. */
  readonly signing: boolean;
  /** A published version's bytes never change (every tier-1 protocol). */
  readonly immutableVersions: boolean;
  /** A version can be deleted through the feed. Never in tier 1: a yank changes state instead. */
  readonly delete: boolean;
  /** The feed answers a search route. */
  readonly search: boolean;
  /** The challenge a non-public feed answers an anonymous client with (§6.6 step 5). */
  readonly authChallenge: Exclude<ChallengeKind, "not-found">;
}

/** One per-ecosystem extension setting (`dist_registry_feeds.ext_json`): its value check. */
export type FeedExtCheck = (value: unknown) => boolean;

/**
 * An input the setup snippet for this feed needs (F-12 renders them, from these declarations):
 * the feed's base URL, the bare registry host (docker), the owner slug, a namespace key the
 * ingest rules declare (`namespace.scope`), or the package and version being shown.
 */
export type FeedSetupInput =
  | "baseUrl"
  | "registryHost"
  | "owner"
  | "package.name"
  | "package.version"
  | `namespace.${string}`;

/** One OpenAPI path the feed answers: `[path, methods, owner]`, where `owner` is a route name of
 *  this adapter, or `host` for a fixed answer the dispatcher gives on the feed's behalf. */
export type FeedOpenApiRow = readonly [
  path: string,
  methods: readonly ("get" | "head" | "post")[],
  owner: string,
];

/** What one ecosystem's renderer is and what its render stamp covers. */
export interface FeedRenderer {
  render(
    pkg: RegistryPackage,
    ctx: RenderContext,
  ): readonly RenderedObject[] | Promise<readonly RenderedObject[]>;
  /**
   * What the stamp hashes: the package's rows alone, or the rows and the feed's settings (Godot's
   * documents carry the publisher and category, so a settings change must make them stale).
   */
  readonly stamp: "package" | "package+feed";
}

/** One package feed. See the file comment for what is the adapter's and what is shared. */
export interface FeedAdapter<E extends PackageEcosystem = PackageEcosystem> {
  readonly ecosystem: E;
  /** The name audit summaries and the console use (`PyPI`, `OCI`). */
  readonly label: string;
  /** Every path of the feed starts here: `/<ecosystem>/`, or `/v2/` for OCI. */
  readonly hostPrefix: string;
  /** The feed's base path for one (already URL-encoded) owner, under `hostPrefix`. */
  feedPath(owner: string): string;
  /** Every route, each built by `feedRoute`. */
  readonly routes: readonly RegistryRoute[];
  readonly renderer: FeedRenderer;
  /** The ecosystem's one ingest declaration in `@polaris-key/manifest`. */
  readonly ingest: PackageEcosystemRules<E>;
  /** The extension settings an operator may set, and each one's check. */
  readonly settings: { readonly ext: Readonly<Record<string, FeedExtCheck>> };
  readonly capabilities: FeedCapabilities;
  readonly setup: {
    /** The clients the docs and the console name. */
    readonly clients: readonly string[];
    readonly inputs: readonly FeedSetupInput[];
  };
  /** The feed's OpenAPI paths; `routeCoverage` reads them as its registry table (rule 10). */
  readonly openapi: readonly FeedOpenApiRow[];
  /** The registry-clients harness: each `clients/<name>.sh` is a matrix row of this ecosystem. */
  readonly harness: { readonly clients: readonly string[] };
}

/** The materialiser's view of an adapter (`RENDERERS`). */
export function rendererOf(adapter: FeedAdapter): RegistryRenderer {
  return {
    ecosystem: adapter.ecosystem,
    render: (pkg, ctx) => adapter.renderer.render(pkg, ctx),
    routes: adapter.routes,
    stamp: adapter.renderer.stamp,
  };
}

/** A boolean extension setting. */
export const extBoolean: FeedExtCheck = (v) => typeof v === "boolean";

/** An integer extension setting within `[min, max]`. */
export function extInteger(min: number, max: number): FeedExtCheck {
  return (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}
