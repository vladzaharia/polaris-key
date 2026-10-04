# F-04 npm feed: packuments, tarballs, dist-tags, deprecation and scope enforcement

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

The npm feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/npm/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). Scoped names only, with the scope equal to the feed's. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

npm clients read a packument and follow `dist.tarball` literally. Eight of our SDK packages are npm packages that ship to GitHub Packages today ([S-12 §6.4](../../notes/S-12-package-feeds.md#64-how-todays-sdks-get-onto-the-feeds)).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the npm row and its notes).
- pacote's registry fetcher (`Accept`, integrity order), npm-package-arg (`escapedName`), the npm registry docs on package metadata ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the npm extractor.

## Scope

**In:**

- `GET` packument (both `%2f` spellings) in full and abbreviated form, chosen by `Accept`; tarballs under `…/-/<file>.tgz`; `dist-tags` from channels; `deprecated` from the state.
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- `dist.integrity` is SHA-512 and `dist.shasum` SHA-1, both from F-03's digests. `dist.tarball` is absolute on `PKG_ORIGIN`.
- npm has no yank: a yanked version stays installable by exact version but leaves `dist-tags`, and gets a `deprecated` message.

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [ ] Matrix green: npm 10 and 11, pnpm 9 and 10, Yarn Berry 4, Bun.
- [ ] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [ ] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [ ] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/npm routeCoverage
gh workflow run registry-clients.yml -f ecosystem=npm
```

## Hand-off

- F-10 publishes our npm packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-04 done`.
