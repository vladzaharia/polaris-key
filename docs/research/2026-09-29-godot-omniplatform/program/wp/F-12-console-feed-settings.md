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

- [ ] The CLI and console snippets are byte-identical for the same input (one shared test).
- [ ] Each panel saves its own `ext_json` or `namespace_json` with `expectedVersion`.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test -- feedSetup
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
```

## Hand-off

- F-21 extends the snippets with credentials.

The role agent sets `--set F-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-12 done`.
