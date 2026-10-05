# PX-W9 Key-entry counting (G21): per-licence limit setting, atomic counter for app, browser and portal entries, `keyEntries` everywhere, the `key_entry_limit` refusal with `manageUrl`, portal preview and responses

| Field       | Value                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                            |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                             |
| Depends on  | [I-04](I-04-account-contract-plan.md), [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md)                                      |
| Unblocks    | [PX-12](PX-12-login-card-v2.md)                                                                                                                    |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                              |
| Plan mode   | yes: executes the approved [`plans/PX-W9.md`](../plans/PX-W9.md) (approved 2026-10-05), which refines [`plans/I-04.md`](../plans/I-04.md)          |
| Gates       | the PORTAL.md §11 green gate; plan mode; D1 migration (next free number at the final gate); `TABLE_OWNERS`; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                          |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W8.md`](../plans/PX-W8.md):** the wire part (the `manageUrl` member and its builder) is settled in PX-W8.
- **[`plans/PX-W9.md`](../plans/PX-W9.md):** approved on 2026-10-05 with every recommendation accepted except Q3, which the owner overrode: `key_entry_limit` carries `manageUrl`, not `portalUrl`. Scope per Q1 (the counter, the settings rows, I-04 §2.2 step 4, `keyEntries`, the `key_entry_limit` code, two transcripts and the portal surfaces). Dependencies ST-01b and ST-03 added. PX-W9 executes its own plan, not I-04's. The portal uses `keyEntries {used, limit}` on every surface (Q5); every licence key counts, including `addon` keys, and grants never do (Q6).

## Goal

Every license key has `entriesLimit` (product setting, default from policy) and `entriesUsed`, incremented atomically on each successful key entry in the portal and in apps; responses carry `entriesLeft`/`entriesLimit`, and at zero apps get the refusal (with PX-W8's `manageUrl`) while the portal forces the account upgrade, only for products with Identity on.

## Why

Key entries turn anonymous keys into accounts ([PORTAL.md §4.6](../../../../design/PORTAL.md#46-key-entry-the-account-upgrade-skippable-then-forced), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G21). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.6](../../../../design/PORTAL.md#46-key-entry-the-account-upgrade-skippable-then-forced), [PORTAL.md §3.1](../../../../design/PORTAL.md#31-model), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `plans/I-04.md`; `wp/I-09-key-entry-attach.md`
- `packages/worker/migrations/` and `TABLE_OWNERS`

## Scope

**In:**

- Limit setting, atomic counter, portal responses, the app refusal per I-04's plan.

**Out** (and where it belongs instead):

- The wire field `manageUrl` (→ PX-W8)
- UI meter and forced upgrade (→ PX-12)

## Design notes

- **Plan mode:** executes I-04's approved plan.
- Key-entry limits apply only to products with Identity on; without Identity the upgrade is always skippable (§3.1 table).
- **Overlap with the re-cut S-16/S-17 graph:** I-09 also names the entry counter. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W9:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W9 in-review`.

## Acceptance criteria

- [ ] A concurrency test proves the counter never over-counts or under-counts.
- [ ] Installs are unaffected: regression tests on refresh and offline grace.
- [ ] The migration and `TABLE_OWNERS` entry land together.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-12 renders the entries meter and the forced upgrade.

The role agent sets `--set PX-W9 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W9 done`.
