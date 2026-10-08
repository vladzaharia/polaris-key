# SP-49 Python typed surface for 0.9

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08))    |
| Size        | 0.8–1.2 engineer-weeks                                                                |
| Depends on  | [SP-35](SP-35-sdk-api-registry-api-json-0-9.md)                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                  |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-49.md` first; no code before it is approved |
| Gates       | `plan-mode`                                                                           |
| Human input | none                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                             |

## Goal

Python typed surface for 0.9, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-49) and §10.4.

## Scope

**In:** `Literal` discriminators on every result kind and status; generic `get_config(key, fallback: T) -> T`; typed keywords on `create()` and `from_config()`; a typed `AsyncClient` with cache-only reads synchronous; a client `Protocol` for the kit; snake_case public fields with one time unit, landing with SP-35's renames (no aliases).

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- Plan mode: `plans/SP-49.md` first, after SP-35's names. Lands with SP-35's renames, with no aliases.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Mypy `--strict` and pyright pass on the README's patterns, including `if r.kind == "device-limit": r.manage_url`.
- [ ] A misspelt `AsyncClient` method fails type-checking.
- [ ] The `api.json` surface test covers both clients.
- [ ] The release notes list every rename.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-49 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-49 done`.
