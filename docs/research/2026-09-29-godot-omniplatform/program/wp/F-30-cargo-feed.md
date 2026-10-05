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

- [x] The client matrix is green. `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Corrections (recorded while implementing, against the code)

- **auth-required no longer waits.** F-21 is done, so the feed ships it: a non-public feed answers
  `config.json` 401, Cargo retries with its token (the ladder's existing `raw` credential), and the
  admitted answer carries `auth-required: true`. Cargo refuses an authenticated registry unless a
  credential provider is named, so the setup snippet adds `credential-provider = "cargo:token"`
  (found by the harness's `--auth` run with real Cargo).
- **"Published through pkey" needs a CLI extractor.** `packages/cli/src/package/cargo.ts` reads the
  `.crate`'s normalised `Cargo.toml` (new direct dependency `smol-toml`, already in the lockfile)
  into the metadata the index renders from; the Worker never unpacks a crate.
- **A policy row is required.** The access ladder reads a missing `dist_registry_policy` row as
  off, so migration `0074_cargo_registry_policy.sql` seeds Cargo's (on, 50 MiB). The contribute
  checklist now says so for the next feed.
- **Beyond the brief's file list,** adding an ecosystem also touched the console's per-ecosystem
  tables (`FeedEcosystem`, labels, icon, yank copy, namespace copy) and the portal's label, which
  TypeScript requires; the CI matrix has two rows (Cargo stable and 1.74, the first with sparse
  auth).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

## Hand-off

- Optional: the lead takes this package only on an owner go decision.

The role agent sets `--set F-30 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-30 done`.
