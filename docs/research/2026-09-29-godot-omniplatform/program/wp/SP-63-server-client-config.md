# SP-63 Managed config on a server: `serverClient()` in Node and Python

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08)) |
| Size        | 0.5–0.8 engineer-weeks                                                           |
| Depends on  | none                                                                             |
| Unblocks    | none                                                                             |
| Role        | `pkey-sdk-porter`                                                                |
| Plan mode   | no                                                                               |
| Gates       | `drift-gate`                                                                     |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Goal

Managed config on a server: `serverClient()` in Node and Python, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-63 (optional).

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-63).

## Scope

**In:** `serverClient()` in Node and Python: the normal client with a memory store, a device id stable across restarts (`PKEY_DEVICE_ID` or a volume), the key from `PKEY_LICENSE_KEY`, no device reports, a background refresh and the usual `config.get()`. A server is a device with its own licence (decision 8). Per-user config is not offered.

**Out** (and where it belongs instead):

- A server credential or online checks (out of this program, §13 Q7, Q8).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `serverClient()` reads config with a stable device id and takes no customer seat.
- [ ] It makes no device report.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-63 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-63 done`.
