# PS-11 Storefront close-out: docs, glossary, THREAT-MODEL S1–S11, ADMIN.md and PORTAL.md amendments, `discover_enabled` readers retired

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 5: close-out) |
| Size        | 0.4–0.6 engineer-weeks                                                                        |
| Depends on  | [PS-05](PS-05-storefront-portal-ui.md), [PS-06](PS-06-console-polaris-key-storefront.md)      |
| Unblocks    | none                                                                                          |
| Role        | `pkey-implementer`                                                                            |
| Plan mode   | no                                                                                            |
| Gates       | docs help-link drift gate; THREAT-MODEL; migration (readers retired, column kept)             |
| Human input | none                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                     |

## Goal

The storefront is documented for users and operators, the glossary has its terms, THREAT-MODEL carries S1–S11, ADMIN.md and PORTAL.md are amended, and nothing reads `discover_enabled` any more.

## Why

[S-21 §6.9, §11](../../notes/S-21-polaris-storefront.md#69-threat-model-deltas-ps-11-writes-them).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `packages/docs/src/content/docs/users/portal.md`, `services/identity/portal.md`, `start/concepts.md`; `docs/security/THREAT-MODEL.md`; `docs/design/{ADMIN,PORTAL}.md`.

## Scope

**In:**

- Docs pages (users: Discover and the storefront page; admin: the Polaris Key panel); glossary: Polaris Key storefront, obtain path, library entry.
- THREAT-MODEL section "The Polaris Key storefront (PS-01…PS-09)" with S1–S11 and residuals.
- PORTAL.md §4.16 "Who sees what" with the listing modes; ADMIN.md panel.
- Remove the `discover_enabled` dual-read (the column stays; dropping it is a later contract step).

**Out** (and where it belongs instead):

- Commerce docs (→ S-22).

## Design notes

- Rule 4: the concepts page wins; "product", "tier", "device".

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-11:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-11 in-review`.

## Acceptance criteria

- [ ] `check:links` passes; THREAT-MODEL section present; no reader of `discover_enabled` remains (grep).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

None.

The role agent sets `--set PS-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-11 done`.
