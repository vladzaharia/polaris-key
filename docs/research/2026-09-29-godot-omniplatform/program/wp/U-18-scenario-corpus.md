# U-18 Client scenario corpus `sync-scenarios.json`: reference client state machine and in-memory server in `client-core`, `gen:sync-scenarios -- --check`, the Node runner as the template

| Field       | Value                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                               |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                      |
| Depends on  | [U-01](U-01-cloud-sync-plan.md)                                                                                                                             |
| Unblocks    | [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md) |
| Role        | `pkey-implementer`                                                                                                                                          |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                                                    |
| Gates       | `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; every push and journal rule, and the first-sign-in rule, has a scenario           |
| Human input | none                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                   |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the scenario corpus is written by `gen:corpus` from literal data in `tools/sign-corpus.ts` (Q1), with no `client-core` import; no separate `gen:sync-scenarios`.

## Corrections and decisions (implementation, 2026-10-05)

Recorded by the implementer under the lead's delegation; the code is the fact.

- **Generator.** `buildSyncScenarios` lives in its own module, `tools/sync-scenarios.ts`, imported by `tools/sign-corpus.ts` and written through its `files` map (so the Swift and Godot mirrors and the stray-file guard cover it), as `gen-content-corpus.ts` already is. The drift gate is `pnpm gen:corpus -- --check`; there is no `gen:sync-scenarios` script (plan Q1).
- **No in-memory server.** With literal data, each `respond` step scripts the server's answer (plans/U-01.md §4.1: "no server port per SDK"), so the reference is the client state machine alone, `@polaris-key/client-core/cloud-sync` (subpath only, kept out of the barrel; T5 isolation test `packages/client-core/test/cloudSyncIsolation.test.ts`).
- **Constants.** The `SYNC_*` client constants are defined in `client-core/cloud-sync` until U-05 creates `@polaris-key/protocol/sync`, which then owns them. `gen:constants` gains `SYNC_SCENARIOS_VERSION` in every SDK (the header's `gen:constants` gate).
- **Scope of version 1.** Settings with `lastWrite`, `max`, `min` and `merge`; records only as far as rules 2, 3 and the OR-set need (`revision` puts and `union` add/remove); a collection's `resolve: keepLocal` stands in for a developer conflict hook. "Attach merge with an empty and a non-empty cloud" is pinned for settings by the first-sign-in scenarios; collections and saves attach (`empty: true`, `MergeRequest`) belong to U-08, which appends scenarios under a version bump. Retry backoff and the live poke are host concerns and not modelled: a request-level failure waits for the next trigger.
- **No new error codes.** The scenarios use only `setting-locked` and `setting-unknown` as SDK results and wire codes the Worker does not emit yet as response data; registering them in `errors.json` stays with U-05 and U-06 (plans/U-01.md §2.8), so this package touches neither `errors.json` nor the transcripts.
- **Parity rows** (`config.user.set`, `config.user.observe`, `sync.offline`, `sync.scenarios`) need the `sync` family and the `service` enum additions that U-04 owns; they are left to U-04 with U-06 and are not added here.
- **Prose.** WIRE-CONTRACT-V4 §11.5 (informative) describes the state machine; the docs corpus pages, AGENTS rule 1 and the generated `reference/corpus.mdx` list the file.

## Goal

A language-neutral client scenario corpus, `conformance/corpus/v2/sync-scenarios.json`, generated by a reference client state machine and in-memory server in `client-core`, with a `gen:sync-scenarios -- --check` drift gate and a Node runner that the other SDKs copy.

## Why

HTTP transcripts pin the wire, not what the client does between requests; six offline state machines would otherwise drift ([S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact), [S-17 §7.1](../../notes/S-17-user-data-sync.md#71-risks) risk 2).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/U-01.md`.
- [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact) ("Client scenario corpus"), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-18.
- `packages/client-core/src/config.ts`, `tools/gen-transcripts.mjs`.

## Scope

**In:** the format, the reference client and server, the initial scenario set of [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact) including first-sign-in upload, `403 account_required` with the sign-in offer, principal change (sign-out, a relink that clears the binding, a merge alias) handled like sign-out, the generator and its `--check`, the Node runner.

**Out** (and where it belongs instead):

- Other SDKs' runners (→ U-06, U-20, U-07, U-21).

## Design notes

- Not the signed corpus; an unsigned conformance file with its own drift gate.

## Steps

1. Format and reference implementation. 2. Scenarios. 3. Generator and Node runner.

## Acceptance criteria

- [x] `gen:corpus -- --check` (which writes `sync-scenarios.json`, plan Q1) is clean and wired into the gate.
- [x] Every rule listed in [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact) has at least one scenario; the Node runner passes.
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node exec vitest run syncScenarios
```

## Hand-off

- Every settings, saves and collections SDK package adds a runner.

The role agent sets `--set U-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-18 done`.
