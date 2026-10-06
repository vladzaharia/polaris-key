/**
 * THE FEED ADAPTER CONTRACT — the one shape every package feed on the registry host implements.
 *
 * A feed (npm, PyPI, Swift, Maven, OCI, Godot, Cargo, Go; NuGet later) is one directory,
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
 * ONE INTEGRATION PATTERN. `FeedAdapter` extends `Adapter<Id, Op>` from `core/adapters/contract.ts`,
 * the base the storefront adapters (A-18a, notes/S-15 §6.1) extend too: an adapter interface, a
 * capability declaration (one `Support` per operation) the console reads, and a shared gate (here
 * the access ladder) and ledger (here the render queue and its stamps) the adapter cannot bypass.
 * Each feed writes a `FeedAdapterSpec` and `defineFeedAdapter` derives the base's parts.
 */

import type {
  FeedSetupDeclaration,
  PackageEcosystem,
  PackageEcosystemRules,
} from "@polaris-key/manifest";
import type {
  Adapter,
  Capabilities,
  Support,
} from "../../../core/adapters/contract.js";
import type {
  OwnerlessRegistryRoute,
  RegistryRoute,
} from "../../../core/registryHost.js";
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

/** The operations a feed declares support for (notes/S-15 §6.1). */
export const FEED_OPS = [
  "render",
  "serve",
  "auth",
  "yank",
  "unyank",
  "deprecate",
  "setup",
] as const;
export type FeedOp = (typeof FEED_OPS)[number];

/** What one ecosystem's protocol is, beyond which operations it supports. */
export interface FeedProtocol {
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

/** A feed's capability declaration: the shared base's `ops`, `rate` and `limits`, and its protocol. */
export interface FeedCapabilities extends Capabilities<FeedOp>, FeedProtocol {}

/**
 * The capabilities as the admin API exposes them (`capabilities` on every feed and package) and
 * the console reads them instead of switching on the ecosystem's name: the declaration, with
 * `yank` and `deprecate` answered from `ops`.
 */
export interface FeedCapabilityView extends FeedProtocol {
  /** A yank (and so an unyank) exists in the protocol. */
  readonly yank: boolean;
  /** A deprecation message (and so an undeprecate) exists in the protocol. */
  readonly deprecate: boolean;
  readonly ops: Readonly<Record<FeedOp, Support>>;
}

/** One per-ecosystem extension setting (`dist_registry_feeds.ext_json`): its value check. */
export type FeedExtCheck = (value: unknown) => boolean;

/**
 * An input the setup snippets for a feed read (`@polaris-key/manifest` `FeedSetupInput`, F-12): the
 * feed's base URL, the bare registry host (docker), the owner slug, a namespace key the ingest
 * rules declare (`namespace.scope`), or the package and version being shown.
 */
export type { FeedSetupInput } from "@polaris-key/manifest";

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
export interface FeedAdapter<
  E extends PackageEcosystem = PackageEcosystem,
> extends Adapter<E, FeedOp> {
  /** The same value as `id`: the ecosystem, one of `@polaris-key/manifest` `PACKAGE_ECOSYSTEMS`. */
  readonly ecosystem: E;
  /** The name audit summaries and the console use (`PyPI`, `OCI`). */
  readonly label: string;
  /** Every path of the feed starts here: `/<ecosystem>/`, or `/v2/` for OCI. */
  readonly hostPrefix: string;
  /** The feed's base path for one (already URL-encoded) owner, under `hostPrefix`. */
  feedPath(owner: string): string;
  /** Every read route, each built by `feedRoute`. */
  readonly routes: readonly RegistryRoute[];
  /** The feed's credential routes (F-21: Swift's `POST …/login`), each built by `feedAuthRoute`. */
  readonly authRoutes?: readonly RegistryRoute[];
  /** The feed's owner-less routes (F-21: OCI's `GET /v2/token`), whose owners are in the query. */
  readonly ownerlessRoutes?: readonly OwnerlessRegistryRoute[];
  readonly renderer: FeedRenderer;
  /** The ecosystem's one ingest declaration in `@polaris-key/manifest`. */
  readonly ingest: PackageEcosystemRules<E>;
  /** The extension settings an operator may set, and each one's check. */
  readonly settings: { readonly ext: Readonly<Record<string, FeedExtCheck>> };
  readonly capabilities: FeedCapabilities;
  /**
   * The ecosystem's ONE setup declaration in `@polaris-key/manifest` (`FEED_SETUP[ecosystem]`):
   * the clients the docs and the console name, the inputs its snippets read, and the snippets
   * themselves (`renderFeedSetup`, shared by the console and `pkey feeds setup`).
   */
  readonly setup: FeedSetupDeclaration;
  /** The feed's OpenAPI paths; `routeCoverage` reads them as its registry table (rule 10). */
  readonly openapi: readonly FeedOpenApiRow[];
  /**
   * The registry-clients harness: each of `clients` is a `clients/<name>.sh` and a CI matrix row
   * of this ecosystem; each of `local` is a `clients/<name>.sh` that needs a tool CI does not
   * have (a desktop editor, say), run by hand and recorded on the PR, with no matrix row.
   */
  readonly harness: {
    readonly clients: readonly string[];
    readonly local?: readonly string[];
  };
}

/** A version-state operation the protocol has, or why it has none. */
export type FeedVerb = true | { readonly unsupported: string };

/**
 * What a feed writes (`registry/<ecosystem>/index.ts`); `defineFeedAdapter` derives the rest. The
 * capabilities are the protocol facts plus `yank` and `deprecate`: `true`, or the reason the
 * protocol has no such state.
 */
export interface FeedAdapterSpec<E extends PackageEcosystem> extends Omit<
  FeedAdapter<E>,
  "id" | "capabilities"
> {
  readonly capabilities: FeedProtocol & {
    readonly yank: FeedVerb;
    readonly deprecate: FeedVerb;
  };
}

function verbSupport(verb: FeedVerb): Support {
  return verb === true
    ? { mode: "api", plane: "worker", rules: [] }
    : { mode: "unsupported", reason: verb.unsupported };
}

/**
 * A feed adapter from its spec: `id` is the ecosystem; `ops` declares `serve` behind the access
 * ladder with the feed's read route names as its rules, `auth` (F-21: registry tokens, judged by
 * the same ladder) with its credential routes as its rules, `render` and `setup` in the Worker,
 * and the version verbs as the spec says; `limits` are the ingest rules' file
 * and name ceilings. Feeds have no upstream to rate-limit them.
 */
export function defineFeedAdapter<E extends PackageEcosystem>(
  spec: FeedAdapterSpec<E>,
): FeedAdapter<E> {
  const { yank, deprecate, ...protocol } = spec.capabilities;
  const worker = (rules: readonly string[]): Support => ({
    mode: "api",
    plane: "worker",
    rules,
  });
  return {
    ...spec,
    id: spec.ecosystem,
    capabilities: {
      ...protocol,
      ops: {
        render: worker([]),
        serve: worker(spec.routes.map((r) => r.name)),
        auth: worker([
          ...(spec.authRoutes ?? []).map((r) => r.name),
          ...(spec.ownerlessRoutes ?? []).map((r) => r.name),
        ]),
        yank: verbSupport(yank),
        unyank: verbSupport(yank),
        deprecate: verbSupport(deprecate),
        setup: worker([]),
      },
      rate: { kind: "none" },
      limits: {
        maxFiles: spec.ingest.maxFiles,
        maxNameLength: spec.ingest.name.maxLength,
      },
    },
  };
}

/** The admin API's view of an adapter's capabilities. */
export function feedCapabilityView(adapter: FeedAdapter): FeedCapabilityView {
  const {
    ops,
    rate: _rate,
    limits: _limits,
    ...protocol
  } = adapter.capabilities;
  return {
    ...protocol,
    yank: ops.yank.mode !== "unsupported",
    deprecate: ops.deprecate.mode !== "unsupported",
    ops,
  };
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
