# HA-11 Plan: `core.presentation` in discovery (name, developer, accent, accent dark, icon sizes and URL template) and UI-kit defaults across all SDKs

| Field       | Value                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 5: presentation in SDKs)                    |
| Size        | 0.3–0.5 engineer-weeks                                                                                              |
| Depends on  | [HA-04](HA-04-manifest-presentation.md)                                                                             |
| Unblocks    | [HA-12](HA-12-presentation-discovery.md), [HA-13](HA-13-sdks-presentation.md), [HA-14](HA-14-godot-presentation.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                 |
| Plan mode   | yes: the plan needs approval before code                                                                            |
| Gates       | plan mode; plan approval by the lead (delegated)                                                                    |
| Human input | none                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                           |

## Goal

`plans/HA-11.md` specifies the discovery member, its contract text, the transcript regeneration, the SDK order and every UI kit's default behaviour, ready for the lead's approval.

## Why

Discovery members are contract surface and recorded in transcripts, so adding one is plan-mode work ([S-20 §7](../../notes/S-20-hosted-assets.md#7-wire-and-plan-mode-impact)). It is what gives UI kits the product icon and accent with no integrator work (decision 10).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- CLAUDE.md plan mode; AGENTS.md rules 1–3.
- S-20 §6.9 and §7.
- `src/core/discovery.ts`, `docs/security/WIRE-CONTRACT-V4.md`, the transcripts, each UI kit's theme.

## Scope

**In:**

- Member shape, optionality and caching rules. `PROTOCOL_VERSION` stays 4 (justify). Transcripts and mirrors. Optional parse case. SDK order: client-core/React, Node, Python, Swift, Kotlin, Godot. UI-kit default rules (an integrator override wins; fallback is the letter tile).

**Out** (and where it belongs instead):

- Implementation (→ HA-12 to HA-14).

## Design notes

- The member is additive. Absent means today's behaviour. The icon is verified against the `sha256` in the member before display.

## Steps

1. Write the plan.
2. Request approval.

## Acceptance criteria

- [ ] `plans/HA-11.md` exists and names every file, corpus step and SDK.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

HA-12 to HA-14 execute the approved plan.

The role agent sets `--set HA-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-11 done`.
