# SP-10 Signed browser-session document for React cookie mode, kept for first-party apps beside bearer mode (wire item W10)

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (wire items)                                |
| Size        | 0.4–0.8 engineer-weeks                                                                     |
| Depends on  | [SP-00](SP-00-parity-registry-plan.md)                                                     |
| Unblocks    | none                                                                                       |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                      |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-10.md` first; no code before a human approves it |
| Gates       | plan mode; corpus; drift gate; `PROTOCOL_VERSION` review; `test:workerd`                   |
| Human input | none                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                  |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive only if a first-party app needs cookies; it would run as a fourth wire train after W-LX. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Owner decision 7: retire cookie mode for bearer mode plus I-08's web redirect, avoiding a signed W10 document. Revive only if a first-party app needs cookies; it would run as a fourth wire train after W-LX.

- Optional now (was required).

## Goal

The browser-session document that React's cookie mode reads is signed and verified like every other
document, so cookie mode can stay as the long-term first-party mode beside bearer mode.

## Why

Wire item W10 in [`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §6 was conditional on
keeping cookie mode. The owner decided on 2026-10-05 that React uses bearer mode cross-origin or in
Tauri, and the cookie when first-party (the note's owner decisions, Q1), so the condition holds.

## Read first

- `AGENTS.md` and `CLAUDE.md` (plan mode); the note's §3.17; `packages/sdk-react/src/browser/`;
  `docs/security/WIRE-CONTRACT-V4.md`.

## Scope

**In:** a plan for the signed shape (`typ`, corpus section, version constants, mirrors), the Worker
change and the React verifier; the compatibility story for deployed React apps.

**Out:** bearer mode itself (an SP-R task, no wire change).

## Steps

1. Plan, then contract, corpus, Worker and React.

## Acceptance criteria

- [ ] `gen corpus --check` passes with the new section and mirrors.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen corpus --check
```

## Hand-off

- React's cookie mode verifies the session document.

The role agent sets `--set SP-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-10 done`.
