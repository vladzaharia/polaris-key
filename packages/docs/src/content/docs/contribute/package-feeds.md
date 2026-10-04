---
title: "Adding a package feed"
description: "The FeedAdapter contract every package feed on the registry host implements, what stays shared, and the checklist the adapter conformance suite enforces for a new ecosystem."
sidebar:
  order: 7
---

The registry host (`pkg.plrs.im`) serves six package feeds today: npm, PyPI, Swift, Maven, OCI and
Godot. Each one is a **feed adapter**: one directory under
`packages/worker/src/services/distribution/registry/<ecosystem>/` whose `index.ts` exports one
`FeedAdapter` (`registry/adapter.ts`). The protocol's complexity stays inside that directory. The
contract around it stays the same for every feed, and a test suite checks it.

The operator side of the feeds is on [Package feeds](/docs/services/distribution/package-feeds/)
and [Feeds in the console](/docs/admin/feeds/). This page is for the person adding the seventh
feed.

## What an adapter owns, and what it does not

An adapter declares:

| Member         | What it is                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecosystem`    | The ecosystem id, one of `@polaris-key/manifest` `PACKAGE_ECOSYSTEMS`.                                                                                                                            |
| `hostPrefix`   | Where every path of the feed starts: `/<ecosystem>/`, or `/v2/` for OCI. `feedPath(owner)` is the feed's base under it.                                                                           |
| `routes`       | Every route, each built by `feedRoute` (`registry/serve.ts`).                                                                                                                                     |
| `renderer`     | A pure `render(pkg, ctx)` producing the index documents, and `stamp`: whether the render stamp covers the package's rows alone (`package`) or the feed settings too (`package+feed`).             |
| `ingest`       | The ecosystem's one declaration in `@polaris-key/manifest` (`PACKAGE_ECOSYSTEM_RULES`): name grammar, normalisation, file types, metadata keys and namespace rules.                               |
| `settings.ext` | The per-ecosystem extension settings an operator may set, each with its value check.                                                                                                              |
| `capabilities` | What the protocol can express: yank, deprecate, `yankPolicy`, `channels`, `signing`, `immutableVersions`, `delete`, `search`, `authChallenge`. The admin API exposes it and the console reads it. |
| `setup`        | The clients the docs name, and the inputs the setup snippet needs (`baseUrl`, `registryHost`, `owner`, `namespace.<key>`, `package.name`, `package.version`).                                     |
| `openapi`      | The feed's OpenAPI paths, as `[path, methods, owner]` rows. `routeCoverage` reads them as its registry table.                                                                                     |
| `harness`      | The `registry-clients` client scripts that exercise the feed with real tools.                                                                                                                     |

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

The shape is deliberately the same as the planned storefront adapters (the store connectors):

| Piece                    | Package feeds                                                 | Storefronts (planned)                    |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------- |
| The adapter interface    | `FeedAdapter`, one directory per ecosystem                    | a storefront adapter, one per store      |
| A capability declaration | `FeedAdapter.capabilities`, exposed by the admin API          | what the store can express, the same way |
| A shared gate            | the access ladder (`feedRoute` and `authorizeFeedRead`)       | the shared gate in front of every store  |
| A shared ledger          | the render queue and its stamps (`registry_render_queue`, R2) | the shared run ledger                    |
| A conformance suite      | `test/feedAdapters.test.ts`                                   | its own suite, on the same model         |

When you build the storefront side, mirror this one so the codebase has one recognisable way to
integrate an external ecosystem.

## The checklist

`packages/worker/test/feedAdapters.test.ts` enforces every item it can. A new adapter that skips
one fails CI.

1. **Ingest rules (rule 9).** Add the ecosystem to `PACKAGE_ECOSYSTEMS` and write
   `packages/shared-manifest/src/ecosystems/<ecosystem>.ts`, exporting one
   `PackageEcosystemRules`. Register it in `PACKAGE_ECOSYSTEM_RULES`; the mapped type makes it a
   compile error until you do. The enum is part of the published JSON Schemas, so the schema and
   the mutation table change with it. Run `pnpm --filter @polaris-key/manifest test`.
2. **The host.** Add the ecosystem to `REGISTRY_ECOSYSTEMS` in `core/registryHost.ts` (Cargo, Go
   and NuGet are already there, reserved: take yours out of `RESERVED_ECOSYSTEMS`). If the
   protocol needs a content type that is not on `REGISTRY_HOST_TYPES`, stop: that list is a
   THREAT-MODEL review trigger.
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
8. **Settings and setup.** List the extension settings in `settings.ext`, and the setup
   snippet's inputs in `setup.inputs`. A `namespace.<key>` input must be a namespace field of the
   ingest rules.
9. **The harness.** Add `packages/worker/scripts/registry-clients/clients/<client>.sh` for each
   real client (plus a fixture or seed), and a matrix row with `ecosystem: <ecosystem>` in
   `.github/workflows/registry-clients.yml`. List the clients in `harness.clients`. The harness
   runs against a local Worker only: nothing is ever published to a public registry.
10. **Conformance data.** Add a sample package to `SAMPLES` and the path-parameter samples to
    `PARAMS` in `test/feedAdapters.test.ts`. The suite fails without them.
11. **Golden documents.** Write the feed's own tests under `packages/worker/test/registry/`,
    with golden files for every document.
12. **The console and the docs.** The console's display tables (`packages/admin` `model.ts`:
    labels, icons, clients, yank wording) are keyed by `FeedEcosystem`, so TypeScript asks for
    the new entries. Add the feed to
    [Package feeds](/docs/services/distribution/package-feeds/), and add the ecosystem to the
    registry section of `docs/security/THREAT-MODEL.md`: adding an adapter is a review trigger.

Then run the full green gate from `AGENTS.md`.
