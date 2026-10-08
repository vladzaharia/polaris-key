# I-24a Named-user seats, server half: `profile.user` and the `license.maxUsers` / `license.devicesPerUser` policy keys in the contract, `licenseDocCases` rows and `licenseUserCases`, client-core readers, seat-holder and invite tables, `device_limit` with `scope: "user"`, console and portal seat panels

| Field       | Value                                                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (later)                                                                                                                                                                                                                |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                      |
| Depends on  | [I-24](I-24-named-user-seats.md), [I-05](I-05-accounts-core.md), [I-08](I-08-app-passthrough.md), [I-09](I-09-key-entry-attach.md)                                                                                                                                                        |
| Unblocks    | [I-24b](I-24b-named-user-seats-sdks.md), [LX-24](LX-24-per-seat-features.md)                                                                                                                                                                                                              |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                     |
| Plan mode   | yes: executes the approved [`plans/I-24.md`](../plans/I-24.md) §2, §3, §4, §6 and the client-core part of §5                                                                                                                                                                              |
| Gates       | plan mode; corpus (`licenseDocCases`, new `licenseUserCases`, Swift and Godot mirrors, `gen:corpus -- --check`); `errors.json` (rule 3) and transcripts (rule 1); migration and `TABLE_OWNERS`; rule 10 (OpenAPI and `routeCoverage`); generated docs pages; THREAT-MODEL; `test:workerd` |
| Human input | none (the plan was approved on 2026-10-05)                                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                 |

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package: **seat-holder licences become candidates** in `rankAnchorCandidates`, with
origin "seat". On a full per-user slot the row is `full`, and the sign-in refusal
`device_limit` with `scope: "user"` becomes that full row. On seat-holder licences the card offers
only the **Free a device** link, never the inline Replace, until this package defines how a seat
holder releases their own devices.

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive when a product asks; its wire rows then join the next licensing train. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Named-user seats: not an owner ask and would add licensing-train members (C-45). Revive when a product asks; its wire rows then join the next licensing train.

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- `profile.user` is SP-54's; I-24a adds only its policy keys.

## Goal

A licence can hold named-user seats: the Worker signs `profile.user = {"subject":"ps_…"}` into the
licence document of a device that holds a seat, injects `license.maxUsers` and
`license.devicesPerUser` on named-user licences, refuses the per-user cap as `device_limit` with
`scope: "user"`, and the console and portal manage holders and invites. Every licence without
named-user seats keeps byte-identical documents.

## Why

Team and named-user seats are S-16 J10 and S-19 §7.3.1. [`plans/I-24.md`](../plans/I-24.md) fixes the
contract and was approved by the owner on 2026-10-05 with every recommendation accepted, including
the split into I-24a (this package) and I-24b (the SDKs) (Q8).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); the `authoring-pkey-manifests` skill.
- [`plans/I-24.md`](../plans/I-24.md), including its "Owner decisions (2026-10-05)" header.
- [`plans/I-09.md`](../plans/I-09.md) §2.4 (inline anchor rule and its candidate hook) and
  [`plans/I-04.md`](../plans/I-04.md).
- `docs/security/WIRE-CONTRACT-V4.md` §3.2, §12; `tools/sign-corpus.ts`.

## Scope

**In:** plans/I-24.md §2 (contract), §3 (catalog and manifests), §4 (corpus, transcripts, parity),
§6 (tables, Core, routes, pages, THREAT-MODEL), and the client-core readers `licenseUserOf(doc)` and
`licenseNamedUsersOf(doc)` from §5.

**Out:** the six SDKs and four UI kits (→ I-24b); per-seat feature assignment (→ LX-24).

## Design notes

- Q1–Q8 of the plan are answered as recommended: an explicit holder list with single-use invites
  (join link at the root path `/join/<token>`), the owner holds an implicit seat, `profile.user`
  carries `subject` only, only seat-holding devices get the claim, `device_limit` with
  `scope: "user"`, the seat user's own account layer, key-bound devices stay "unassigned".
- Key entry on a new device of a named-user licence answers `account_required` with
  `signInUrl` = `<origin>/signin?product=<slug>` (root path, owner 2026-10-05).
- `PROTOCOL_VERSION` stays 4 and `corpusVersion` stays 2.

## Steps

1. Contract text and `errors.json` codes.
2. Corpus generator rows and mirrors.
3. client-core readers.
4. Migrations, Core and routes.
5. Transcripts, console and portal panels, docs pages, THREAT-MODEL.

## Acceptance criteria

- [ ] Every command in plans/I-24.md §9 marked I-24a passes.
- [ ] A licence with no named-user seats produces byte-identical documents (snapshot test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- I-24b relies on the readers, the codes and the transcripts; LX-24 keys on `license_seat_holders`.

The role agent sets `--set I-24a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-24a done`.
