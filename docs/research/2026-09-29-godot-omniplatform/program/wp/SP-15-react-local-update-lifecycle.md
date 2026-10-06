# SP-15 React local client and update lifecycle: a network-free `core.local` adapter, `update.driver` (service-worker hand-off on the web, the host's driver over the bridge), `update.bootguard` slots and confirmation

| Field       | Value                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                              |
| Size        | 1–1.5 engineer-weeks                                                                   |
| Depends on  | [SP-12](SP-12-react-boot-download.md), [SP-14](SP-14-react-update-telemetry.md)        |
| Unblocks    | none                                                                                   |
| Role        | `pkey-sdk-porter`                                                                      |
| Plan mode   | no                                                                                     |
| Gates       | `stage-matrix.json` guard cases; unit tests; `parity:check`; the generated parity page |
| Human input | none                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                              |

## Goal

React gains the three lifecycle rows it lacks: a local-only adapter with no network for tests, previews and kiosk builds; an update hand-off (`client.update.install(decision)` answering an `InstallOutcome`) that takes a waiting service worker on the web and calls the host's driver on the desktop bridge; and the boot guard's slots, counting and confirmation (`markBootAttempt()`, `confirmBoot()`) over client-core's `bootGuardAction`.

## Why

P1-09 ported the launch decision to client-core, but React has no slots, no counter and no confirmation, no updater hand-off, and no local client (program README §9 lists React `core.local` and `update.driver` as gaps). Node implements all three. The parity rows it owns: `core.local`, `update.driver`, `update.bootguard` in `packages/sdk-react/parity.json`; their `note` fields give the current state. It absorbs the parity note's SP-R12 and the driver half of SP-R08 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.15, §3.16 and §5.2.
- Node's `client.update.install`, `markBootAttempt`/`confirmBoot` and its local client, in `packages/sdk-node/src/`.
- `conformance/corpus/v2/stage-matrix.json` (guard cases); P1-09's plan for `bootGuardAction`.

## Scope

**In:**

- `core.local`: an adapter that serves the bundled documents and a fixed licence state with zero network calls.
- `update.driver` on `web`: detect a waiting service worker, hand off with `skipWaiting` and reload, answer `restartRequired`/`handedOff`/`unsupported{reason}`; on `desktop-bridge`, forward to the host's `client.update.install`.
- `update.bootguard`: slots in browser storage (try/catch, memory fallback) on `web`; the host's guard over the bridge on `desktop-bridge`. Events go through SP-14's record call.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Native updater feeds (→ SP-12's `update.feedUrl`).

## Design notes

- **Bridge host.** A new `invoke` verb this package adds to the React desktop adapter needs its host handler too. If [SP-31](SP-31-node-bridge-v4.md) (the Node host on bridge v4) has landed, add the handler in `packages/sdk-node/src/electron/main.ts` and `DEFAULT_INVOKE_VERBS` with a round-trip test, and add the verb to `bridge.ts`'s "WHAT v4 ADDS", in the same PR. If SP-31 has not landed, SP-31 picks the verb up from `main`.
- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- A test that the local adapter makes no `fetch` call at all (a throwing `fetch` stub).

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature core.local` unit tests prove the adapter never touches the network.
- [ ] `@pkey-feature update.driver` tests cover the service-worker hand-off with a fake registration and the bridge forwarding path; the device proof is a recorded run in a browser and in the Electron sample, noted in the PR.
- [ ] `@pkey-feature update.bootguard` tests replay every guard case of `stage-matrix.json` with persisted slots, rollback and confirmation.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- Kit boot screens (UK-\*) read the guard's outcome.

The role agent sets `--set SP-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-15 done`.
