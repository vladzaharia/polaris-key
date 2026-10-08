# SP-48 Python 0.8.x patch: fail-open, leak and error-model fixes

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 0.8–1.2 engineer-weeks                                                             |
| Depends on  | none                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                             |
| Role        | `pkey-sdk-porter`                                                                  |
| Plan mode   | no                                                                                 |
| Gates       | none beyond the green gate                                                         |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Goal

Python 0.8.x patch: fail-open, leak and error-model fixes, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-48) and §10.4.

## Scope

**In:** `CoreContext.request` maps transport errors to `network-error` (cause chained) and 5xx to `server-error`; `update.check` and `release` stop collapsing to `not_found`; `create()` rejects unknown `expected_services`; `repr=False` on every token field; `AsyncClient` gate coroutines refuse truthiness; `client.license.deactivate()` emits the licence event like the root; `InsecureBaseUrlError` and `DeviceManagementUnsupportedError` subclass `PolarisError`; an empty key refused locally; sign-in errors carry the server message; listener exceptions logged; lazy imports.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- A truthiness guard now; the 0.9 reshape is SP-49's (§10.4).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Every public network method, patched to raise `ConnectError` and then return 503, gives `network-error` or `server-error` and leaks no httpx exception.
- [ ] `create(expected_services=['licence'])` raises.
- [ ] No public result's repr contains `pkeyt_`.
- [ ] `if aclient.is_licensed():` raises instead of passing.
- [ ] One licence event per deactivate from either entry point.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-48 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-48 done`.
