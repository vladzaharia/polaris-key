# F-23 Optional: native `docker push` over R2 multipart

| Field       | Value                                                          |
| ----------- | -------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-2)                        |
| Size        | 1.5–2 engineer-weeks                                           |
| Depends on  | [F-08](F-08-oci-registry.md), [F-21](F-21-registry-auth.md)    |
| Unblocks    | none                                                           |
| Role        | `pkey-implementer`                                             |
| Plan mode   | no                                                             |
| Gates       | rule 10 (the `/v2/` upload routes); workerd lane; THREAT-MODEL |
| Human input | none                                                           |
| Repo        | `vladzaharia/polaris-key`                                      |

## Goal

`docker push` works against `/v2/`: the upload state machine (`POST` → `PATCH` with ordered `Content-Range` → `PUT ?digest=`, and the manifest `PUT`) over R2 multipart, vendored from `cloudflare/serverless-registry` with its Apache-2.0 header kept.

## Why

F-08 publishes image layouts through tickets. Native push is a convenience for adopters ([S-12 §9](../../notes/S-12-package-feeds.md#9-open-source-reuse)).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §10](../../notes/S-12-package-feeds.md#10-proposed-work-packages).
- F-08's OCI routes and F-21's tokens.

## Scope

**In:**

- What the Goal names, plus its `REGISTRY_PATHS` rows, golden files and a client matrix in
  `registry-clients.yml`.

**Out:**

- Anything that changes tier-1 behaviour.

## Design notes

- Each request is bounded by the zone's body limit (100 MB on Free and Pro), so large layers need chunked `PATCH`.
- Push writes the same release rows as a ticket publish.

## Corrections from the code (F-23 implementation)

- **The push routes are Release's, not Distribution's.** A tag push writes release rows, which
  only Release may (rule 6), so the routes are `service: "release"` (marked `FEED_PUSH_ROUTE`) in
  `services/release/packages/ociPush.ts`, spread into `mount.ts`'s `REGISTRY_ROUTES` as
  `RELEASE_REGISTRY_ROUTES`; their OpenAPI rows (`RELEASE_REGISTRY_OPENAPI`) join
  `routeCoverage`'s `REGISTRY_PATHS`. They read Distribution's feed settings through the
  `delivery` hook, as the ticket publish does.
- **Who pushes.** plans/F-20.md §10 left `publish` to F-22/F-23: F-23 enables it (owner-bound,
  header-presented, implies `read`), and a `pkeyci_` with `release:publish` pushes too. The console
  mint gains **Push images**.
- **Uploads earn refs through a new Core function**, `landUpload` (an upload is not named by its
  hash), and hold objects with the `oci-push` ref, which the bytes host's blob route ignores.
- **Read-after-write.** The conformance suite's push workflow requires a pushed blob to be
  readable from its repository, so the pull blob route serves an object pushed to THAT repository
  by digest, privately, under the feed's ladder.
- **Channel tags are refused on push** (`TAG_INVALID`): a version tag never moves (F-01 §6.7).
- **The serverless-registry sources carry no per-file header**; the vendored file carries the
  project's Apache-2.0 notice and attribution, with the modifications listed.

## Steps

1. Renderer or adapter, then routes, then matrix, then docs.

## Acceptance criteria

- [x] The client matrix is green. `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

## Hand-off

- Optional: the lead takes this package only on an owner go decision.

The role agent sets `--set F-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-23 done`.
