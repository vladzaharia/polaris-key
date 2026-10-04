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

## Steps

1. Renderer or adapter, then routes, then matrix, then docs.

## Acceptance criteria

- [ ] The client matrix is green. `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

## Hand-off

- Optional: the lead takes this package only on an owner go decision.

The role agent sets `--set F-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-23 done`.
