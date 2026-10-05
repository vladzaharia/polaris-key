# PX-W8 `manageUrl` (G15b) on `device_limit` and on the key-entries refusal, jointly with I-04: contract, `errors.json`, corpus and transcripts, client-core and every SDK and UI kit

| Field       | Value                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                                                           |
| Size        | 1–1.6 engineer-weeks                                                                                                                                                                                                              |
| Depends on  | [I-04](I-04-account-contract-plan.md)                                                                                                                                                                                             |
| Unblocks    | [PX-17](PX-17-activate-confirm.md)                                                                                                                                                                                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                             |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                                                 |
| Gates       | the PORTAL.md §11 green gate; plan mode; corpus and transcripts (`gen:corpus -- --check`, `gen:transcripts -- --check`); `gen:constants -- --check`, `parity:check`; every SDK's replayer; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                         |

## Goal

Apps receive a `manageUrl` on `device_limit` and on the key-entries refusal that opens `#/p/:product/free-device?for=…&return=…` or `/activate?key=…&product=…`, specified in I-04's contract and carried through `errors.json`, the corpus and transcripts, client-core, Node, React, Python, Swift, Godot, Kotlin and the SDK UI kits.

## Why

Without it an app can only say "device limit reached" ([PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G15b). This is a wire change: an all-languages event. PORTAL.md sizes this L (5+ agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `plans/I-04.md` once approved; `wp/I-04-account-contract-plan.md`, `wp/I-09-key-entry-attach.md`
- AGENTS.md rules 1–3 and CLAUDE.md plan mode

## Scope

**In:**

- The `manageUrl` field per I-04's approved plan: contract → `errors.json` → corpus and transcripts → client-core → six SDKs → UI kits.

**Out** (and where it belongs instead):

- The key-entry counter itself (→ PX-W9)
- Portal focused flows (→ PX-10)

## Design notes

- **Plan mode:** executes I-04's approved plan (one contract plan for PX-W8, PX-W9, PX-W13 and PX-W17).
- **Overlap with the re-cut S-16/S-17 graph:** I-09 also names the key-entry refusal with a portal URL (`key_entry_limit` with `portalUrl`). PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W8:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W8 in-review`.

## Acceptance criteria

- [ ] `gen:corpus -- --check`, `gen:constants -- --check`, `parity:check` and every SDK's replayer pass.
- [ ] Each SDK and UI kit surfaces `manageUrl` on both refusals (parity tests).
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check && mise exec node@22 -- pnpm parity:check
```

## Hand-off

PX-10's free-device flow and PX-17's deep link are the targets.

The role agent sets `--set PX-W8 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W8 done`.
