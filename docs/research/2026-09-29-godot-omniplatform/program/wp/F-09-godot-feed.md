# F-09 Godot feed: the ≤ 4.6 Asset Library API, the 4.7 Asset Store API and the GodotEnv index

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                |
| Size        | 1–1.5 engineer-weeks                                                   |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)        |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md) |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | rule 10 (its `REGISTRY_PATHS` rows and spec entries)                   |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

The Godot feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/godot/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). It serves both editor API shapes, because the SDK supports Godot 4.4 to 4.7. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

Godot 4.7 renamed the setting and moved to a new Asset Store API that verifies no hash. Releases up to 4.6 compare `download_hash`. The Godot addon ships through a GitHub Release and manual store uploads today.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the Godot row and its notes).
- The godot-asset-library `API.md`, the 4.7 Asset Store OpenAPI, the editor's `asset_library_editor_plugin.cpp`, and GodotEnv ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the Godot extractor.

## Scope

**In:**

- The ≤ 4.6 API (`configure`, `asset` search, `asset/<id>` with `download_hash`); the 4.7+ `search/query/`, `assets/…` and `releases/…`; `index.json` for GodotEnv; zips and PNG icons under content-addressed paths.
- The search endpoints filter a short list in memory. They are the only per-request computation.
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- Document that 4.7+ installs rely on TLS alone.
- The manual editor check is done by `pkey-godot-engineer`, one install per editor shape, and recorded in the PR.

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [ ] Matrix green: GodotEnv `"source": "zip"`; HTTP contract tests on both shapes; manual editor installs.
- [ ] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [ ] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [ ] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/godot routeCoverage
gh workflow run registry-clients.yml -f ecosystem=godot
```

## Hand-off

- F-10 publishes our Godot packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-09 done`.
