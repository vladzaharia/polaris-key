# F-32 Optional: NuGet v3 feed (required if X-01 goes ahead)

| Field       | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-3)                         |
| Size        | 1.5 engineer-weeks                                              |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md) |
| Unblocks    | none                                                            |
| Role        | `pkey-implementer`                                              |
| Plan mode   | no                                                              |
| Gates       | rule 9 (`nuget` in `PACKAGE_ECOSYSTEMS`); rule 10               |
| Human input | the X-01 go/no-go decision, which makes this package required   |
| Repo        | `vladzaharia/polaris-key`                                       |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive when X-01 goes ahead or a product declares a nuget package deliverable; it inherits F-33 and F-34 for free when revived. WinGet is a distribution channel (A-19, A-26), not a feed. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> NuGet v3 feed. Revive when X-01 goes ahead or a product declares a nuget package deliverable; it inherits F-33 and F-34 for free when revived. WinGet is a distribution channel (A-19, A-26), not a feed.

## Goal

A NuGet v3 feed under `nuget/<owner>/v3/index.json`: the service index, `PackageBaseAddress`, registrations and a small dynamic `SearchQueryService`, with nuspec extraction in the CLI.

## Why

Deferred while the C# SDK ([X-01](X-01-dotnet-sdk.md)) is unbuilt. It **becomes required if X-01 goes ahead** (the standing rule; the X-01 brief already says so).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §10](../../notes/S-12-package-feeds.md#10-proposed-work-packages).
- The `nuget` ecosystem needs a rule-9 change to `PACKAGE_ECOSYSTEMS`.

## Scope

**In:**

- What the Goal names, plus its `REGISTRY_PATHS` rows, golden files and a client matrix in
  `registry-clients.yml`.

**Out:**

- Anything that changes tier-1 behaviour.

## Design notes

- Lower-case ids. `nuget.config` source mapping is the strict router.
- If X-01 is taken, the lead flips `optional` to `false` and sequences this package before X-01's first release.

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

The role agent sets `--set F-32 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-32 done`.
