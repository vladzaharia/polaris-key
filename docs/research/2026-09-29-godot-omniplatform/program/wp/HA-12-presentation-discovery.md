# HA-12 Discovery `core.presentation` in the Worker: contract text, `shared-protocol` type, transcripts and mirrors

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 5: presentation in SDKs)                   |
| Size        | 0.4–0.6 engineer-weeks                                                                                             |
| Depends on  | [HA-11](HA-11-presentation-discovery-plan.md), [HA-02](HA-02-media-host.md), [HA-07](HA-07-serve-hosted-copies.md) |
| Unblocks    | [HA-13](HA-13-sdks-presentation.md), [HA-14](HA-14-godot-presentation.md)                                          |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                              |
| Plan mode   | yes: executes the approved [`plans/HA-11.md`](../plans/HA-11.md)                                                   |
| Gates       | plan mode; corpus and transcripts (rule 1); drift gates; generated docs                                            |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

Discovery emits `core.presentation` per the approved plan. The contract text and the protocol types document it. Transcripts are regenerated with their mirrors.

## Why

This is the server half of decision 10 ([S-20 §6.9](../../notes/S-20-hosted-assets.md#69-sdks-and-ui-kits-icon-and-accent-with-zero-integrator-work)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- `plans/HA-11.md` (approved).
- `src/core/discovery.ts`, `packages/shared-protocol`, `packages/worker/test/transcripts/`.

## Scope

**In:**

- Exactly the plan's Worker, contract and transcript steps.

**Out** (and where it belongs instead):

- SDKs (→ HA-13, HA-14).

## Design notes

- Follow the plan. Any deviation goes back to the planner.

## Steps

1. Per the plan.

## Acceptance criteria

- [ ] `pnpm gen:transcripts -- --check` and `pnpm gen:corpus -- --check` are green after regeneration.
- [ ] Discovery for a product with no presentation omits the member (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

SDK porters replay the new transcripts.

The role agent sets `--set HA-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-12 done`.
