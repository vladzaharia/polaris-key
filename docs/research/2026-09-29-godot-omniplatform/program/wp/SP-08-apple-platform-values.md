# SP-08 Canonical platform values `tvos`, `visionos` and `watchos` (wire item W8): `shared-protocol` platform enum, `headers.json` corpus rows, Worker acceptance, Swift sends them, Godot and React follow the enum

| Field       | Value                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (wire items)                                                                                                 |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                      |
| Depends on  | [P1b-04](P1b-04-headers-config-corpora.md)                                                                                                                  |
| Unblocks    | [UK-26](UK-26-visionos-kit.md), [UK-27](UK-27-tvos-kit.md), [UK-33](UK-33-watchos.md), [MO-06](MO-06-portal-device-activation-motion.md)                    |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                       |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-08.md` first; no code before a human approves it                                                                  |
| Gates       | plan mode; corpus (`headers.json`, Swift and Godot mirrors, `gen:corpus -- --check`); all SDKs (`parity:check`, `gen:constants -- --check`); `test:workerd` |
| Human input | none                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                   |

## Goal

`tvos`, `visionos` and `watchos` are canonical platform values: `shared-protocol`'s platform enum and
the `headers.json` corpus carry them, the Worker accepts them in `X-PKey-Platform` and the device
metadata, Swift sends them on those platforms, and Godot and React follow the enum.

## Why

Wire item W8 in [`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §6. The owner chose
canonical values over a mapping to `ios` on 2026-10-05 (the note's owner decisions, Q4).

## Read first

- `AGENTS.md` and `CLAUDE.md` (plan mode); `docs/security/WIRE-CONTRACT-V4.md` §5.2.
- `packages/shared-protocol`, `conformance/corpus/v2/headers.json`, `tools/sign-corpus.ts`.

## Scope

**In:** contract text, enum, corpus rows, Worker acceptance and storage, Swift, Godot and React
enums, and the compatibility story for old Workers (an unknown value today) and old SDKs (`ios`).

**Out:** new update feeds or outlets for these platforms.

## Steps

1. Plan, then contract and corpus, then Worker, then SDKs.

## Acceptance criteria

- [ ] `gen:corpus -- --check` and `parity:check` pass; the Worker accepts the three values.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- Swift's tvOS and visionOS support, and the UI kit's Apple floors (iOS 18, macOS 15), rely on these values.

The role agent sets `--set SP-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-08 done`.
