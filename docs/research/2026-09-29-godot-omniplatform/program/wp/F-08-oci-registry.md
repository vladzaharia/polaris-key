# F-08 OCI registry pull at `/v2/` and image-layout publish through upload tickets

| Field       | Value                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                             |
| Size        | 1.5–2.5 engineer-weeks                                                                              |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)                                     |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md), [F-23](F-23-docker-push.md) |
| Role        | `pkey-implementer`                                                                                  |
| Plan mode   | no                                                                                                  |
| Gates       | rule 10; workerd lane (Range, HEAD); Action-bundle drift (CLI extractor)                            |
| Human input | none                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                           |

## Goal

The OCI feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/oci/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). `/v2/` sits at the host root and serves anonymous public pulls, and `pkey` publishes an OCI image layout through upload tickets. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

The owner asked for Docker/OCI explicitly. OCI's reference grammar puts no path in the registry host, so it must own `/v2/` at the root ([S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) notes).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the OCI row and its notes).
- The OCI distribution spec, the reference grammar, and `cloudflare/serverless-registry` as a reference for the pull path ([S-12 §9](../../notes/S-12-package-feeds.md#9-open-source-reuse)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the OCI extractor.

## Scope

**In:**

- `GET /v2/`; `GET`/`HEAD` manifests by tag or digest; blobs with `Range`; `tags/list` with pagination; OCI error bodies; `/v2/token` answering 404 until F-21.
- The CLI's OCI extractor: read an image layout, upload every blob through tickets (5 GiB per blob), and describe the index and manifests in the descriptor (up to 4,096 files).
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- Version tags never move; channel tags do. Manifests by digest are immutable.
- The Bearer challenge shape is fixed in plan §6.6 even though tier 1 only refuses.
- Reference only: do not vendor `serverless-registry` here (its upload state machine is F-23's).

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [ ] Matrix green: the OCI conformance pull suite; `docker pull`, `podman pull` and `crane pull`, multi-arch.
- [ ] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [ ] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [ ] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/oci routeCoverage
gh workflow run registry-clients.yml -f ecosystem=oci
```

## Hand-off

- F-10 publishes our OCI packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-08 done`.
