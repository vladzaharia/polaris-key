# SP-00 SDK parity registry and corpus plan: the nine proposed parity ids with allowed N/As, `ui.cli` for Node and Python, `commerce.receipt` required on Node and Python, new transcripts and corpus rows, `copy.en.json` and its emitters, honest `planned` manifests

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (wave 1)                                                                         |
| Size        | 1–1.6 engineer-weeks                                                                                                            |
| Depends on  | [P1b-01](P1b-01-parity-registry.md)                                                                                             |
| Unblocks    | [SP-10](SP-10-signed-browser-session.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-02b](UK-02b-ui-fixtures-parity.md)          |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                            |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-00.md` first; no code before a human approves it                                      |
| Gates       | plan mode; `pnpm parity:check -- --check`; `pnpm gen:corpus -- --check`; generated parity docs page; `gen:constants -- --check` |
| Human input | none                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                       |

## Goal

One registry and corpus change makes the SDK parity pass measurable: the proposed parity ids exist
with their allowed N/As, every SDK's `parity.json` states them honestly as `planned` with the SP task
named, and the new transcripts and corpus rows exist for the SDK tasks to prove against.

## Why

[`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5.0 makes SP-00 the first package of the
pass. The owner approved it on 2026-10-05, to proceed through plan mode ("Owner decisions
(2026-10-05)" in the note).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §3, §5.0, §6 and its owner decisions;
  [`PARITY.md`](../../PARITY.md) §5.
- `conformance/parity/`, `tools/sign-corpus.ts`, `tools/gen-sdk-constants*`.

## Scope

**In:**

- Proposed ids `core.copy`, `ui.boot`, `portal.links`, `release.fetch`, `update.feeds`,
  `release.distribution`, `config.local`, `telemetry.updates` and `crash.tags`, with allowed N/As.
- `ui.kit`'s `headless` N/A for Node and Python replaced by a `ui.cli` expectation.
- `commerce.receipt` **required** on Node and Python (owner, 2026-10-05: reverses LX-20's Python
  `allowedNa`).
- Transcripts for activation refusals, `boot-cold-register.json`, `release-fetch-gated.json`,
  `distribution-download-model.json`, and `telemetry-report.json` with `updates`; a G11 row in
  `gate-matrix.json`; `copy.en.json` and its emitters.

**Out:**

- `portal-links.json` as a client-built URL corpus. The owner decided that SDKs do **not** build
  portal URLs client-side and wait for the server's `manageUrl` (PX-W8). `portal.links` is redefined
  over server-supplied links.
- The Apple platform values (→ SP-08); the signed browser-session document (→ SP-10).

## Steps

1. Write the plan; wait for approval.
2. Registry, then corpus and transcripts, then manifests.

## Acceptance criteria

- [x] `pnpm parity:check -- --check` and `pnpm gen:corpus -- --check` pass.
- [x] Every new id is `planned` in every SDK with its SP task named.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm parity:check -- --check
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- The per-SDK SP tasks of the note (§5.1–§5.7) tag their tests with these ids.

The role agent sets `--set SP-00 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-00 done`.
