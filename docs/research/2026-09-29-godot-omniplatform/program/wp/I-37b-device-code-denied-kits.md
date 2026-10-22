# I-37b Device-code denied in the kits

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) |
| Size        | 0.3–0.5 engineer-weeks                                             |
| Depends on  | [I-37](I-37-device-code-explicit-confirm.md)                       |
| Unblocks    | [I-37c](I-37c-device-poll-denied.md)                               |
| Role        | `pkey-sdk-porter`                                                  |
| Plan mode   | no: [plans/I-37.md](../plans/I-37.md) §8 is the plan               |
| Gates       | drift-gate, all-sdks, corpus                                       |
| Human input | none                                                               |
| Repo        | `vladzaharia/polaris-key`                                          |

## Goal

Teach the SDKs what I-37 added to the browser half of a device-code sign-in. No wire change: the device sees `pending` until approval, and **Deny** is the poll's generic `error`.

> **Superseded in part by [I-37c](I-37c-device-poll-denied.md) ([plans/DENY-01.md](../plans/DENY-01.md)).** `sign-in-denied` now means a refusal only (`error` + `reason: access_denied`); a bare `error` is `sign-in-failed`.

## Scope

**In** (from plan §8):

- **Copy and generators:** `signInHandoff.confirm` becomes "Choose Sign in on {device} on the sign-in page to finish." in `packages/brand/kit-copy/{en,de,es,fr,it}.json` (mockup note M10), then `pnpm gen brand`, `pnpm gen ui-matrix`, `pnpm gen corpus` (the Godot mirror) and the kit goldens.
- **Kits:** Node, Python, Swift and Kotlin map a device-code poll `error` to `sign-in-denied`, as Godot already does; the `errors.json` description widens.
- **Transcript:** new `devicecode-denied.json`, recorded by a Worker scenario and replayed by Node, React, Python, Swift, Kotlin and Godot.
- **Docs:** SDK prose on the attach opt-in in the `your-own-ui` pages and READMEs (retired by I-37: `attachable` is always `false`).

**Out:** any Worker change (→ I-37).

## Acceptance criteria

- [x] The kit copy, goldens and corpus regenerate cleanly (`pnpm gen --check`).
- [x] A denied device-code poll ends in `sign-in-denied` in all six SDKs, proven by the `devicecode-denied` transcript.
- [x] The attach prose says it is retired on device code.
- [x] The green gate passes (`AGENTS.md`), including every gate in the header.
