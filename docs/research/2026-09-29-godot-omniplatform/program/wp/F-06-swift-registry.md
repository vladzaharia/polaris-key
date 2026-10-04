# F-06 Swift registry: SE-0292 endpoints, `/identifiers`, signed releases and the compatibility suite

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                |
| Size        | 1.5–2 engineer-weeks                                                   |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)        |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md) |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | rule 10; CI on a macOS runner                                          |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

The Swift registry feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/swift/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). Signed releases carry their CMS signature in the metadata and the archive headers. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

SwiftPM installs from the registry with an archive whose `Package.swift` is at the root, which fixes the monorepo-subdirectory problem of `sdks/swift`. Its default `onUnsigned: prompt` is why the owner decided to sign.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the Swift registry row and its notes).
- SwiftPM's `Registry.md`, SE-0292, SE-0378, `RegistryClient.swift`, and the registry compatibility test suite ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- [`plans/F-01.md`](../plans/F-01.md) §5.3 (Swift signing).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the Swift registry extractor.

## Scope

**In:**

- `GET /{scope}/{name}`, `/{version}`, `/{version}/Package.swift` (with `swift-version`), `/{version}.zip`, `/identifiers?url=`; `POST /login` answering 501 until F-21.
- `Content-Version: 1`, `Accept` checks (400, 415), `problem+json`, the `Link` headers, and the signature fields and headers.
- The `requireSigned` refusal at ingest, shared with F-03.
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- Serve the **signed** manifest copies uploaded by the CLI, never copies re-extracted from the zip.
- Test signing with a throwaway CA generated inside the test. Never commit a key.
- Answer plan question Q1 empirically: record whether the recommended certificate chain verifies on macOS and Linux SwiftPM with `onUntrustedCertificate: error`.

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [ ] Matrix green: the swiftlang compatibility suite; `swift package resolve` and `swift build` on macOS with `onUnsigned: error`; a Linux container build.
- [ ] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [ ] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [ ] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/swift routeCoverage
gh workflow run registry-clients.yml -f ecosystem=swift
```

## Hand-off

- F-10 publishes our Swift registry packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-06 done`.
