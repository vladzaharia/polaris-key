# SP-43 Sync outcomes: reasons, same-second documents, a sync status

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08))    |
| Size        | 1.5–2 engineer-weeks                                                                  |
| Depends on  | [SP-35](SP-35-sdk-api-registry-api-json-0-9.md)                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                  |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-43.md` first; no code before it is approved |
| Gates       | `plan-mode`, `corpus`, `all-sdks`, `threat-model`                                     |
| Human input | none                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                             |

## Goal

Sync outcomes: reasons, same-second documents, a sync status, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-43) and §10.4.

## Scope

**In:** every SDK's sync result gives each document a reason (network, server with status, rejected with the verify step, replay) and an `offline` flag; Godot's `ok` follows `classify()`; React's `refresh()` returns the outcome and the hooks expose the last sync. A re-served document with identical bytes counts as unchanged. The Worker issues documents of one type to one device with a strictly increasing `iat`. Every client exposes a sync status (last attempt, last success, last error code, offline) and emits one `sync` event when that status changes. The plan names the corpus cases and every SDK that follows; no signed-shape change; `PROTOCOL_VERSION` unchanged.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- Sync status is state; one `sync` event fires when it changes (§10.4). Plan mode: `pkey-wire-planner` writes `plans/SP-43.md` first, naming the corpus cases and every SDK that follows.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] An identical document served twice reports unchanged in all six SDKs.
- [ ] A config change in the same second as the last issue arrives and emits its event.
- [ ] Offline reports `network` and `offline`.
- [ ] A tampered document reports `rejected`.
- [ ] Names in `api.json`.
- [ ] THREAT-MODEL records that the anti-replay floor is unchanged for differing payloads.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-43 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-43 done`.
