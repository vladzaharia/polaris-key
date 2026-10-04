# F-31 Optional: Go module proxy feed

| Field       | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-3)                         |
| Size        | 1–1.5 engineer-weeks                                            |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md) |
| Unblocks    | none                                                            |
| Role        | `pkey-implementer`                                              |
| Plan mode   | no                                                              |
| Gates       | rule 9 (`go` in `PACKAGE_ECOSYSTEMS`); rule 10                  |
| Human input | none                                                            |
| Repo        | `vladzaharia/polaris-key`                                       |

## Goal

A Go module proxy under `go/<owner>/`: `@v/list`, `.info`, `.mod`, `.zip` and `@latest`, with the CLI computing the `h1:` dirhash.

## Why

Deferred: there is no Go SDK. Zero-config public use also needs a `go-import` HTML `<meta>` on the module path's host, which the registry host will not serve.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §10](../../notes/S-12-package-feeds.md#10-proposed-work-packages).
- The `go` ecosystem needs a rule-9 change to `PACKAGE_ECOSYSTEMS`.

## Scope

**In:**

- What the Goal names, plus its `REGISTRY_PATHS` rows, golden files and a client matrix in
  `registry-clients.yml`.

**Out:**

- Anything that changes tier-1 behaviour.

## Design notes

- Document `GOPROXY` together with `GONOSUMDB`, not `GOPRIVATE`, which disables the proxy.

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

The role agent sets `--set F-31 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-31 done`.
