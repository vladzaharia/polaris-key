---
title: "Adding a package feed"
description: "The FeedAdapter contract every package feed on the registry host implements, what stays shared, and the checklist the adapter conformance suite enforces for a new ecosystem."
sidebar:
  order: 7
---

The registry host (`pkg.plrs.im`) serves seven package feeds today: npm, PyPI, Swift, Maven, OCI,
Godot and Cargo. Each one is a **feed adapter**: one directory under
`packages/worker/src/services/distribution/registry/<ecosystem>/` whose `index.ts` exports one
`FeedAdapter` (`registry/adapter.ts`), built with `defineFeedAdapter`. The protocol's complexity stays inside that directory. The
contract around it stays the same for every feed, and a test suite checks it.

The operator side of the feeds is on [Package feeds](/docs/services/distribution/package-feeds/)
and [Feeds in the console](/docs/admin/feeds/). This page is for the person adding the eighth
feed.

## What an adapter owns, and what it does not

An adapter declares:

| Member         | What it is                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecosystem`    | The ecosystem id, one of `@polaris-key/manifest` `PACKAGE_ECOSYSTEMS`.                                                                                                                                                                                                                                                                                                  |
| `hostPrefix`   | Where every path of the feed starts: `/<ecosystem>/`, or `/v2/` for OCI. `feedPath(owner)` is the feed's base under it.                                                                                                                                                                                                                                                 |
| `routes`       | Every route, each built by `feedRoute` (`registry/serve.ts`).                                                                                                                                                                                                                                                                                                           |
| `renderer`     | A pure `render(pkg, ctx)` producing the index documents, and `stamp`: whether the render stamp covers the package's rows alone (`package`) or the feed settings too (`package+feed`).                                                                                                                                                                                   |
| `ingest`       | The ecosystem's one declaration in `@polaris-key/manifest` (`PACKAGE_ECOSYSTEM_RULES`): name grammar, normalisation, file types, metadata keys and namespace rules.                                                                                                                                                                                                     |
| `settings.ext` | The per-ecosystem extension settings an operator may set, each with its value check.                                                                                                                                                                                                                                                                                    |
| `capabilities` | Whether the protocol can yank and deprecate (with the reason when it cannot), and its protocol facts: `yankPolicy`, `channels`, `signing`, `immutableVersions`, `delete`, `search`, `authChallenge`. `defineFeedAdapter` turns them into the shared base's `ops`. The admin API exposes them and the console reads them.                                                |
| `setup`        | The ecosystem's one setup declaration, `FEED_SETUP[<ecosystem>]` in `@polaris-key/manifest`: the clients the docs name, the inputs the snippets read (`baseUrl`, `registryHost`, `owner`, `namespace.<key>`, `package.name`, `package.version`) and the snippets themselves, which `renderFeedSetup` renders for the console's Setup tabs and `pkey feeds setup` alike. |
| `openapi`      | The feed's OpenAPI paths, as `[path, methods, owner]` rows. `routeCoverage` reads them as its registry table.                                                                                                                                                                                                                                                           |
| `harness`      | The `registry-clients` client scripts that exercise the feed with real tools.                                                                                                                                                                                                                                                                                           |

An adapter never re-implements the shared pieces:

- **The access ladder and the Cache API.** `feedRoute` puts `serveFeedRead` around every route,
  so the platform kill switch, the owner's `packageFeeds`, the feed's `enabled` and its access
  mode are checked before the cache and before the route's own work. A refusal is the host's one
  not-found or the client's native `401`.
- **Render-on-write.** The framework (`registry/materialise.ts`) writes the adapter's documents
  to R2 under `registry/<ecosystem>/<owner>/`, stamps them, and keeps them fresh. Core reads
  the render queue (`core/registryQueue.ts` `drainRenderQueue`) after every request that
  enqueued a render and on every cron tick, and hands the rows to Distribution's
  `registryMaterialiser`, which runs the adapters' renderers. The cron then self-checks stale
  stamps. Reads compare the stored stamp with D1 (`catalogSource.ts` `freshRegistryObject`), so a
  feed is never stale between a publish and the drain.
- **Release's state.** Packages are read only through the `releaseCatalog` hook
  (`catalogSource.ts`). Distribution never imports Release (rule 6).
- **The console's model.** `admin/lib/feedModel.ts` reads labels, base URLs, namespace and
  extension validation and capabilities from the adapters. It has no per-ecosystem switch.

## One integration pattern

`FeedAdapter` extends `Adapter<Id, Op>` from `packages/worker/src/core/adapters/contract.ts`, the
base the storefront adapters extend too (`packages/worker/src/core/storefront/adapter.ts`, A-18a).
Both families have the same pieces:

| Piece                    | Package feeds                                                                            | Storefronts (A-18a)                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The adapter interface    | `FeedAdapter`, one directory per ecosystem                                               | `StorefrontAdapter`, one declaration per store (`core/storefront/stores/`), one registry line |
| A capability declaration | `capabilities.ops`: one `Support` per operation, plus the protocol facts                 | `capabilities.ops`: one `Support` per store op                                                |
| A shared gate            | the access ladder (`feedRoute` and `authorizeFeedRead`)                                  | the store-agnostic write gate (`core/storefront/gate.ts`) and a rule table per store          |
| A shared ledger          | the render queue and its stamps (`registry_render_queue`, R2)                            | `store_operations`                                                                            |
| A conformance suite      | `test/feedAdapters.test.ts` (and items 3 and 7 of `test/storefront/conformance.test.ts`) | `test/storefront/conformance.test.ts`, over every storefront adapter                          |

A feed's operations are `render`, `serve`, `auth`, `yank`, `unyank`, `deprecate` and `setup`. A
feed writes a `FeedAdapterSpec`, and `defineFeedAdapter` derives the base's parts from it: `serve`
is an `api` operation whose rules are the feed's read route names, `auth` (registry tokens, F-21,
judged by the same ladder) is an `api` operation whose rules are the feed's credential routes
(`authRoutes`, built by `feedAuthRoute`, such as Swift's `POST …/login`) and owner-less routes
(`ownerlessRoutes`, such as OCI's `GET /v2/token`), and `yank` and `deprecate` are `true` or
`{ unsupported: "<reason>" }`. A new feed declares its native challenge as
`capabilities.authChallenge`, gets token checks from the ladder without code of its own, and adds
an authenticated setup for its clients to the console's snippets and to `--auth` runs of its
harness clients. The
admin API exposes the result (`feedCapabilityView`), so the console renders a feed tile and a
storefront tile the same way.

## The checklist

`packages/worker/test/feedAdapters.test.ts` enforces every item it can. A new adapter that skips
one fails CI.

1. **Ingest rules (rule 9).** Add the ecosystem to `PACKAGE_ECOSYSTEMS` and write
   `packages/shared-manifest/src/ecosystems/<ecosystem>.ts`, exporting one
   `PackageEcosystemRules`. Register it in `PACKAGE_ECOSYSTEM_RULES`; the mapped type makes it a
   compile error until you do. The enum is part of the published JSON Schemas, so the schema and
   the mutation table change with it. Run `pnpm --filter @polaris-key/manifest test`.
2. **The host.** Add the ecosystem to `REGISTRY_ECOSYSTEMS` in `core/registryHost.ts` (Go and
   NuGet are already there, reserved: take yours out of `RESERVED_ECOSYSTEMS`). If the protocol
   needs a content type that is not on `REGISTRY_HOST_TYPES`, stop: that list is a THREAT-MODEL
   review trigger. Seed the ecosystem's row in `dist_registry_policy` with a migration (F-30's
   `0072_cargo_registry_policy.sql`): the access ladder reads a missing row as the platform
   switch off, so without it the feed never answers.
3. **The directory.** Create `registry/<ecosystem>/` with `render.ts` (pure documents),
   `routes.ts` (every route through `feedRoute`) and `index.ts` (the `FeedAdapter`). Keep every
   protocol quirk in this directory.
4. **Register it.** Add one line to `FEED_ADAPTERS` in `registry/index.ts`. `RENDERERS`,
   `DISTRIBUTION_REGISTRY_ROUTES` and `mount.ts` `REGISTRY_ROUTES` follow.
5. **OpenAPI (rule 10).** Document every path in `packages/worker/openapi/polaris-key.v3.yaml`
   under a path-level `servers` override naming `https://pkg.plrs.im`, with tag `registry`. List
   the same paths in `openapi`. `routeCoverage` checks the spec against them in both directions.
6. **Capabilities.** Declare them honestly. The suite checks them against the feed's routes,
   settings, renders and the access ladder:
   - `search` must be true exactly when a route is a search;
   - `yankPolicy` must be true exactly when `settings.ext` has `yankHidesFromIndex`;
   - `signing` must be true exactly when `settings.ext` has `requireSigned`;
   - `authChallenge` must be what `authorize.ts` `challengeFor` sends;
   - `channels: "none"` must render the same whatever the tags, and `"latest"` must ignore every
     tag but `latest`;
   - `delete` stays false and `immutableVersions` true in tier 1.
7. **The render stamp.** Declare `stamp: "package"` only when the documents never read the feed
   settings. The suite renders the sample under two different settings and fails if a
   `package`-stamped renderer's output changes.
8. **Settings and setup.** List the extension settings in `settings.ext`. Write the ecosystem's
   setup in `packages/shared-manifest/src/feedSetup.ts` (`FEED_SETUP`, a compile error until it
   exists): its clients, its `inputs` (a template that reads an undeclared input throws, and a
   `namespace.<key>` input must be a namespace field of the ingest rules), its feed path, which
   must equal the adapter's `feedPath`, and its snippets, strict routers only. Point the adapter's
   `setup` at it, and add a case and golden to
   `packages/shared-manifest/test/fixtures/feed-setup/`; the CLI's and the console's tests read
   the same goldens. The console's ecosystem panel renders `settings.ext` keys it finds in
   `FEED_EXTENSION_FIELDS` (`packages/admin` `model.ts`), so a new key needs an entry there.
9. **The harness.** Add `packages/worker/scripts/registry-clients/clients/<client>.sh` for each
   real client (plus a fixture or seed), and a matrix row with `ecosystem: <ecosystem>` in
   `.github/workflows/registry-clients.yml`. List the clients in `harness.clients`. A client
   whose tool CI cannot run (a desktop editor) goes in `harness.local` instead: it keeps its
   script, has no matrix row, and its run is recorded on the PR. The harness runs against a
   local Worker only: nothing is ever published to a public registry.
10. **Conformance data.** Add a sample package to `SAMPLES` and the path-parameter samples to
    `PARAMS` in `test/feedAdapters.test.ts`. The suite fails without them.
11. **Golden documents.** Write the feed's own tests under `packages/worker/test/registry/`,
    with golden files for every document.
12. **The console and the docs.** The console's display tables (`packages/admin` `model.ts`:
    labels, icons, namespace copy, panel titles, yank wording) are keyed by `FeedEcosystem`, so TypeScript asks for
    the new entries. Add the feed to
    [Package feeds](/docs/services/distribution/package-feeds/), and add the ecosystem to the
    registry section of `docs/security/THREAT-MODEL.md`: adding an adapter is a review trigger.

Then run the full green gate from `AGENTS.md`.
