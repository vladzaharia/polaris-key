# F-30 Optional: Cargo sparse-index feed

| Field       | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-3)                         |
| Size        | 1 engineer-weeks                                                |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md) |
| Unblocks    | none                                                            |
| Role        | `pkey-implementer`                                              |
| Plan mode   | no                                                              |
| Gates       | rule 9 (`cargo` in `PACKAGE_ECOSYSTEMS`); rule 10               |
| Human input | none                                                            |
| Repo        | `vladzaharia/polaris-key`                                       |

## Goal

A Cargo sparse-index feed under `cargo/<owner>/`: `config.json`, the index files, and the `dl` template. Published through `pkey`, not `crates/new`.

## Why

Deferred: there is no Rust SDK. The standing rule makes it required the day one ships.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §10](../../notes/S-12-package-feeds.md#10-proposed-work-packages).
- The `cargo` ecosystem needs a rule-9 change to `PACKAGE_ECOSYSTEMS`.

## Scope

**In:**

- What the Goal names, plus its `REGISTRY_PATHS` rows, golden files and a client matrix in
  `registry-clients.yml`.

**Out:**

- Anything that changes tier-1 behaviour.

## Design notes

- The index is fully static; render it with F-02's materialiser.
- `auth-required` waits for F-21.

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

The role agent sets `--set F-30 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-30 done`.
