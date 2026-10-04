# F-12 Console: per-ecosystem settings panels and the shared setup-snippet renderer (`pkey feeds setup`)

| Field       | Value                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                                                                                                                                  |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                     |
| Depends on  | [F-11](F-11-console-feeds.md), [F-04](F-04-npm-feed.md), [F-05](F-05-pypi-feed.md), [F-06](F-06-swift-registry.md), [F-07](F-07-maven-feed.md), [F-08](F-08-oci-registry.md), [F-09](F-09-godot-feed.md) |
| Unblocks    | none                                                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                                       |
| Plan mode   | no: follows [`plans/F-01.md`](../plans/F-01.md) §6.9                                                                                                                                                     |
| Gates       | console CSP parity; Action-bundle drift (`pkey feeds setup`)                                                                                                                                             |
| Human input | none                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                |

## Goal

Each feed's Settings tab carries its ecosystem panel:

- npm scope;
- PyPI prefixes and names, and the HTML fallback;
- Swift scope, `requireSigned` and repository URLs for `/identifiers`;
- Maven group prefixes;
- OCI untagged retention;
- Godot publisher and category.

Each Setup tab shows the snippets rendered by `renderFeedSetup`, the same pure function `pkey feeds
setup --ecosystem <e> --owner <slug>` prints.

## Why

S-12 specified one settings model with per-ecosystem extensions, and setup snippets that always
use the client's strict router ([S-12 §8.3](../../notes/S-12-package-feeds.md#83-dependency-confusion)).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.4 (`ext_json`, `namespace_json`), §6.7 (strict routers), §6.9.
- The F-04 to F-09 docs sections, which list each feed's snippet inputs.
- **[correction, feed-adapter contract]** Each feed now declares its snippet inputs and clients
  in its `FeedAdapter` (`packages/worker/src/services/distribution/registry/<ecosystem>/index.ts`,
  `setup.inputs` and `setup.clients`), its namespace fields in `@polaris-key/manifest`
  `PACKAGE_ECOSYSTEM_RULES`, and its capabilities (which the admin API exposes) in
  `capabilities`. Render from those declarations rather than from a per-ecosystem table, and
  fill the console's `FEED_PANELS` slot without switching on the ecosystem where a declaration
  answers. See `/docs/contribute/package-feeds/`.

## Scope

**In:**

- The six panels.
- `renderFeedSetup` in `@polaris-key/manifest`, with golden snippets.
- `pkey feeds setup`.
- The pip `--extra-index-url` warning.

**Out:**

- The common sections (→ [F-11](F-11-console-feeds.md) builds them).
- Token snippets (→ F-21).

## Design notes

- The snippets use only the strict routers: npm scope, uv `explicit = true`, Gradle
  `exclusiveContent`, SwiftPM `--scope`, fully qualified OCI references, and the Godot settings
  name per editor version.

## Steps

1. `renderFeedSetup` and its goldens.
2. The panels.
3. The CLI command and the bundle.

## Acceptance criteria

- [x] The CLI and console snippets are byte-identical for the same input (one shared test).
- [x] Each panel saves its own `ext_json` or `namespace_json` with `expectedVersion`.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test -- feedSetup
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
```

## Corrections (recorded while implementing, against the code)

Where the code disagreed with this brief or plans/F-01.md §6.9, the code was the fact. No wire
shape, corpus, migration, route or `PROTOCOL_VERSION` changes.

1. **The setup declaration moved into `@polaris-key/manifest`.** The brief points at each
   adapter's `setup.inputs` and `setup.clients`, but `renderFeedSetup` must live in the manifest
   package (§6.9), which cannot import the Worker. `FEED_SETUP[<ecosystem>]`
   (`packages/shared-manifest/src/feedSetup.ts`) now holds the clients, the inputs, the feed path
   and the templates; each adapter's `setup` points at it (`setup: FEED_SETUP.npm`), and
   `test/feedAdapters.test.ts` checks the identity, the feed path and the base URL against the
   adapter. A template reads its inputs only through the declared list (an undeclared read
   throws), so the declaration still drives the render. Maven gained `owner` as an input (its
   Gradle repository name and Maven server id).
2. **The namespace "panels" were already F-11's Namespace section.** npm scope, PyPI names and
   prefixes, Maven group prefixes and the Godot publisher are `namespace_json`, edited by F-11's
   common Namespace section. F-12 did not duplicate them in `FEED_PANELS`; it rewrote that section
   to render one row per namespace field the ingest rules declare (no ecosystem switch; the
   per-protocol copy stays a display table). `FEED_PANELS` holds one `EcosystemPanel` for every
   ecosystem, which renders the extension settings (`ext_json`) the adapter declares; npm and
   Maven declare none beyond Maven's `yankHidesFromIndex` (the Yank policy section's), so they
   show no panel. The admin API's feed detail gained `extensions` (the adapter's `settings.ext`
   keys) for it, and the edit controls are keyed by setting in `FEED_EXTENSION_FIELDS`.
3. **Two settings the brief names were not settable.** Swift's `repositoryUrls` (read by
   `GET /identifiers`) and Godot's `license` and `minGodotVersion` (read by the renderer, listed
   in the docs) were missing from their adapters' `settings.ext`, so the admin API refused them.
   They are added, each with its value check.
4. **Credentials are in (plans/F-20.md §3 and §5).** F-20 put the `credential` argument and
   `pkey feeds setup --token-env` into F-12 when F-12 lands first. `renderFeedSetup` takes
   `{kind: none | env | token | godot-url}` with the per-client lines of F-20 §6.3; the CLI
   exposes only `env`. F-21 still owns the token UI that uses `token` and `godot-url`.
5. **The Feeds sub-navigation (owner decision, 2026-10-04).** The row of feed links stays, as a
   proper sub-navigation bar: Overview, a separator, then each ecosystem with its icon, on a
   rule, the current page filled, bold and underlined. Not a dropdown in the title.
6. **OCI retention is a setting only.** `retainUntaggedDays` is stored and edited, but nothing
   removes untagged manifests yet (no job reads it). Proposed follow-up for the OCI feed's owner
   (F-08 lineage): a retention sweep.

## Hand-off

- F-21 extends the snippets with credentials.

The role agent sets `--set F-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-12 done`.
