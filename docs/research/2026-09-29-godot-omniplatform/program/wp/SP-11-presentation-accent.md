# SP-11 Product presentation accent colour: an optional accent in the product's presentation (manifest rule, discovery and the portal client record), read by every UI kit

> **Dropped 2026-10-05 (lead, delegated decision):** superseded by S-20. The accent colour (and icon) in product presentation is built by [HA-04](HA-04-manifest-presentation.md) (manifest) and [HA-11](HA-11-presentation-discovery-plan.md)–HA-14 (discovery, SDKs and UI kits). Do not build this package separately.

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (UI kits)                                                                            |
| Size        | 0.4–0.8 engineer-weeks                                                                                                              |
| Depends on  | [PX-W13](PX-W13-passthrough-metadata.md)                                                                                            |
| Unblocks    | none                                                                                                                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                               |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-11.md` first; no code before a human approves it                                          |
| Gates       | plan mode; rule 9 (validator rule, mutation table, JSON schema, `bundle:action -- --check`); drift gate; all SDKs; UI-kit snapshots |
| Human input | none                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                           |

## Goal

A product can declare an optional accent colour in its presentation. The manifest validator checks
it, discovery and the portal client record carry it, and every UI kit (React, SwiftUI, Godot,
Compose, and the web components) uses it within the fixed frame.

## Why

The owner's UI-kit answers of 2026-10-05 add an optional accent colour to product presentation as an
all-languages change through plan mode (recorded in
[`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md), "Owner decisions (2026-10-05)"). The UI
kit spec is updated separately.

## Read first

- `AGENTS.md` and `CLAUDE.md` (plan mode); the `authoring-pkey-manifests` skill.
- [`plans/PX-W13.md`](../plans/PX-W13.md) §2.2 (the client record and `presentationFor`), §3 (the
  display rules); `docs/design/PORTAL.md` (branding is data only, inside a fixed frame).

## Scope

**In:** the manifest field and rule 9 entry, its home as a claimable setting (S-18 model C), the
discovery and client-record member, contrast rules against the dark-first frame, and each UI kit's
use of it.

**Out:** full theming or brand kits.

## Steps

1. Plan, then manifest and Worker, then UI kits.

## Acceptance criteria

- [ ] Rule 9 entries exist; `bundle:action -- --check` passes.
- [ ] Every UI kit has a snapshot with and without an accent.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
```

## Hand-off

- The UI-kit build programme uses the accent.

The role agent sets `--set SP-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-11 done`.
