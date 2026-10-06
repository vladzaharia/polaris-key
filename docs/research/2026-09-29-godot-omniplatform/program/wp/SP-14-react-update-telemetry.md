# SP-14 React update-health recording (`telemetry.updates`): a record call on the adapter, `update_offered` journalled by the browser update path, renderer events forwarded to the host

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                      |
| Size        | 0.3–0.5 engineer-weeks                                                                         |
| Depends on  | none                                                                                           |
| Unblocks    | [SP-15](SP-15-react-local-update-lifecycle.md)                                                 |
| Role        | `pkey-sdk-porter`                                                                              |
| Plan mode   | no                                                                                             |
| Gates       | transcript replay (`telemetry-report-updates.json`); `parity:check`; the generated parity page |
| Human input | none                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                      |

## Goal

React records update-health events: the bearer-mode `BearerSession` queue (which already drains at most 16 per `POST /<p>/devices/report`) is fed by an adapter `recordUpdateEvent` call, the browser update path journals `update_offered`, and the desktop renderer forwards its events to the host's journal.

## Why

The row is half built: the queue and the drain exist, but nothing records an event, so a real app never reports one. The parity rows it owns: `telemetry.updates` in `packages/sdk-react/parity.json`; their `note` fields give the current state. It absorbs the parity note's the `updates` half of SP-R11 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.13; `plans/SP-00.md` (the `telemetry-report-updates.json` transcript).
- `packages/sdk-react/src/browser/bearer/session.ts`; Node's update-health journal in `packages/sdk-node/src/`.

## Scope

**In:**

- An adapter record call on both runtimes, with the event names of P6-03.
- `update_offered` journalled where the browser update path sees an offer.
- Desktop renderer events forwarded to the host's journal over the bridge.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- The service-worker update hand-off itself (→ SP-15).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- The events ride bearer mode only; a cookie session keeps the registry's `web` N/A note honest (bearer mode removes it).

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [x] `@pkey-feature telemetry.updates` tests replay `telemetry-report-updates.json` (17 events drain as 16 then 1) through a recorded event, not a hand-filled queue.
- [x] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [x] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [x] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- SP-15 journals the update and boot-guard events through this call.

The role agent sets `--set SP-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-14 done`.
