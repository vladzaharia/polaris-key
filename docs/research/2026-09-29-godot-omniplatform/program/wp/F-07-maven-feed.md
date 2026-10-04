# F-07 Maven feed: repository layout, generated `maven-metadata.xml`, checksum sidecars and `.module`

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                |
| Size        | 1 engineer-weeks                                                       |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)        |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md) |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | rule 10 (its `REGISTRY_PATHS` rows and spec entries)                   |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

The Maven feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/maven/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). `maven-metadata.xml` and the checksum sidecars are generated, never uploaded. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

The Kotlin AAR and the Godot Android binding are not published anywhere today. Maven's layout is fully static once the metadata is derived.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the Maven row and its notes).
- The Maven repository layout, Gradle repository filtering and Gradle's checksum order ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the Maven extractor.

## Scope

**In:**

- The static layout for every file of a publication; `maven-metadata.xml` per artifact; `.md5`, `.sha1`, `.sha256` and `.sha512` sidecars for every file and for the metadata; `.module`.
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- XML goes out as `application/octet-stream` with `attachment`. If any matrix client fails on that, **stop and ask**. Never add `xml` to the allowlist.
- `-SNAPSHOT` versions are refused at ingest (F-03).

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [ ] Matrix green: Gradle 8.x and 9.x with `exclusiveContent`, Maven 3.9 with checksum policy `fail`.
- [ ] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [ ] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [ ] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/maven routeCoverage
gh workflow run registry-clients.yml -f ecosystem=maven
```

## Hand-off

- F-10 publishes our Maven packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-07 done`.
