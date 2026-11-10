# CC-23L Plan: account-free local pairing (local links)

| Field       | Value                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CC                                                                                                                                                                                                                                                      |
| Size        | 0.1–0.2 engineer-weeks                                                                                                                                                                                                                                  |
| Depends on  | none                                                                                                                                                                                                                                                    |
| Unblocks    | [CC-29](CC-29-local-links.md), [CC-29.15](CC-29.15-local-pairing-kit-api.md), [CC-29b](CC-29b-local-links-android-godot.md), [CC-29K](CC-29K-local-links-kit-screens.md), [CC-29D](CC-29D-local-links-docs.md), [CC-29S](CC-29S-local-links-signoff.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                                                                                                                     |
| Plan mode   | yes                                                                                                                                                                                                                                                     |
| Gates       | plan-mode, human-approval, threat-model, protocol-version                                                                                                                                                                                               |
| Human input | none                                                                                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                               |

## Goal

The plan for account-free local pairing ("local links") in v0.11: a new mode (`q` for the QR or code pairing, `l` for later LAN sessions) that extends the optional CC-23. It is a wire change (AGENTS.md rule 2), so the build slices of CC-29 run in plan mode against it.

## Why

Owner decision 2026-11-03: two devices with no account on one LAN pair by a short code or a QR. The plan is the lead's working document and is not committed to the repository.

## Read first

- `AGENTS.md` (always).
- `docs/security/WIRE-CONTRACT-V5.md` §15.4-§15.11

## Acceptance criteria

- [ ] The plan is approved; CC-29 builds against it.
- [ ] Registered as `done` because CC-29.0 (V5 §15.12) is merged on `next`.

## Hand-off

The role agent sets `--set CC-23L in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-23L done`.
