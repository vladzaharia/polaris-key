# F-22 Optional: native-client publish adapters (`npm publish`, `twine`, `swift package-registry publish`, Maven `PUT`)

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-2)                                  |
| Size        | 2 engineer-weeks                                                         |
| Depends on  | [F-21](F-21-registry-auth.md)                                            |
| Unblocks    | none                                                                     |
| Role        | `pkey-implementer`                                                       |
| Plan mode   | no                                                                       |
| Gates       | rule 10 (the native publish routes); THREAT-MODEL (publish tokens in CI) |
| Human input | none                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                |

## Goal

Native clients publish directly: `npm publish` (`PUT` with `_attachments`), `twine` (the legacy multipart upload), `swift package-registry publish` (`PUT` multipart) and Maven `PUT`s. Each is translated into the same release descriptor and ingested by F-03's path, authorised by a `publish`-scoped `pkeyr_` token.

## Why

Some adopters will want their usual tooling. `pkey release publish` already covers CI ([S-12 §10 tier 2](../../notes/S-12-package-feeds.md#tier-2-designed-now-built-after-tier-1)).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §10](../../notes/S-12-package-feeds.md#10-proposed-work-packages).
- F-21's tokens.

## Scope

**In:**

- What the Goal names, plus its `REGISTRY_PATHS` rows, golden files and a client matrix in
  `registry-clients.yml`.

**Out:**

- Anything that changes tier-1 behaviour.

## Design notes

- This contradicts "no long-lived secrets in CI" unless tokens are short-lived and narrowly scoped. Say how in the PR.
- Request bodies are bounded by the zone's limit (100 MB on Free and Pro).

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

The role agent sets `--set F-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-22 done`.
