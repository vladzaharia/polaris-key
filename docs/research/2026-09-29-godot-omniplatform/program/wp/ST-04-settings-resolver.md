# ST-04 Settings resolver: source chain over row- and column-backed keys, cache, `writeSetting()`, audit with before, after, origin, reason and key, discovery-vs-enforcement test

| Field       | Value                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 1: foundation)                                                                                                                                                          |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                          |
| Depends on  | [ST-03](ST-03-settings-registry.md), [ST-01b](ST-01b-resync-claims.md)                                                                                                                                          |
| Unblocks    | [I-09](I-09-key-entry-attach.md), [ST-05](ST-05-settings-admin-api.md), [ST-15](ST-15-hardcoded-policy.md), [ST-16](ST-16-platform-defaults.md), [ST-24](ST-24-audit-retention.md), [CM-03](CM-03-merchants.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                              |
| Gates       | `TABLE_OWNERS`; drift gate (`--check`)                                                                                                                                                                          |
| Human input | none                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                       |

## Changed by plan PX-W9 (2026-10-06)

[`plans/PX-W9.md`](../plans/PX-W9.md) revision 2 was approved by the lead under the owner's delegation on 2026-10-06. These notes win over the text of this brief where they differ.

- **Replace `keyEntryLimit()`.** Its body becomes `resolveSetting(product, "identity.keyEntry.limit")`. The
  function is in `core/keyEntries.ts`, and today reads the `product_settings` row and defaults to 10.
  - The signature stays the same, because PX-W9's enforcement and I-09's discovery member both call it.
  - Keep the 1–100 bound and the platform `max` cap.
- **Clear `pending`.** Remove `pending: {wp: "ST-04"}` from the product entry `identity.keyEntry.limit` once the
  console can write it through `writeSetting()`.
- **Read the switch through the resolver.** `identity.keyEntryRefusals` is already an editable platform setting
  (`IDENTITY_KEY_ENTRY_REFUSALS`, PX-W9). Move its read in `core/keyEntries.ts` onto the resolver with no change in
  behaviour.

## Goal

One resolver returns a setting's effective value with its source chain over row- and column-backed keys, and every write goes through `writeSetting()`, which audits before, after, origin, reason and key.

## Why

Each service resolves its own settings today with different precedence ([S-18 §2.3](../../notes/S-18-settings-architecture.md#23-six-precedence-patterns-five-vocabularies)). [S-18 §4.4](../../notes/S-18-settings-architecture.md#44-precedence-and-inheritance) defines one chain; [S-18 §4.6](../../notes/S-18-settings-architecture.md#46-audit-history-and-concurrency) defines the audit shape.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.3](../../notes/S-18-settings-architecture.md#43-storage), [S-18 §4.4](../../notes/S-18-settings-architecture.md#44-precedence-and-inheritance), [S-18 §4.6](../../notes/S-18-settings-architecture.md#46-audit-history-and-concurrency), [S-18 §4.11](../../notes/S-18-settings-architecture.md#411-sdk-surface-per-language), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-04.

## Scope

**In:**

- Resolver: default → deploy var → platform → product (manifest or console) → entity, with policy clamps and ceiling locks; result `{ value, source, chain, lockedBy?, drift? }`.
- Per-isolate cache reusing A-13's 30-second platform cache; product rows read with the product fetch.
- `writeSetting()` with the audit row shape; discovery-vs-enforcement test.

**Out** (and where it belongs instead):

- HTTP routes (→ ST-05); platform defaults' fan-out UI (→ ST-16).

## Design notes

- Column-backed keys keep today's hot-path reads.
- `gen:transcripts --check` must stay unchanged: no wire effect.
- A test asserts no handler writes a registry-backed column directly.

## Steps

1. Resolver with property tests.
2. `writeSetting()` and audit.
3. Switch existing writers one by one.

## Acceptance criteria

- [ ] Resolver property tests cover every source and the policy clamp direction.
- [ ] `gen:transcripts --check` is unchanged.
- [ ] No handler writes a registry-backed column outside `writeSetting()` (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

- ST-05, ST-11, ST-15, ST-16 and ST-24 build on the resolver and `writeSetting()`.

The role agent sets `--set ST-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-04 done`.
