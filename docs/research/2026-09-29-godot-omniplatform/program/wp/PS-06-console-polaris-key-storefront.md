# PS-06 Console: Polaris Key hub tile and listing editor through A-18j, the Polaris Key panel (listing, audience, ways to add, group labels), readiness, "Who can see this?" persona preview, analytics card

| Field       | Value                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 3: console)                                                                          |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                 |
| Depends on  | [A-18j](A-18j-console-storefronts.md), [PS-01](PS-01-polaris-key-adapter.md), [PS-02](PS-02-storefront-listing-settings.md), [PS-04](PS-04-storefront-portal-api.md) |
| Unblocks    | [PS-11](PS-11-storefront-closeout.md)                                                                                                                                |
| Role        | `pkey-implementer`                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                   |
| Gates       | console CSP parity; docs help-link drift gate; rule 10 (narrative-only admin routes); THREAT-MODEL (admin mutations)                                                 |
| Human input | none                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                            |

## Goal

In the console, Polaris Key appears as a storefront tile with its capability strip, its listing in the shared Listing editor, a Polaris Key panel (listing state, audience, ways to add, group labels), the readiness checklist, a persona-based "Who can see this?" and a 28-day analytics card.

## Why

[S-21 §6.6](../../notes/S-21-polaris-storefront.md#66-the-console-ps-06).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- [A-18j](A-18j-console-storefronts.md) and its shared tile and badge component; `docs/design/ADMIN.md` T3, T4, §5.8.
- PS-01's declaration and readiness; PS-02's settings; PS-04's analytics.

## Scope

**In:**

- Tile and Listing editor via A-18j (no store-specific code beyond the panel).
- The panel (T4 layout, controls right-aligned), with typed confirmation for audience `everyone`.
- Admin routes (narrative-only): `GET /manage/api/products/<p>/storefronts/polaris-key`, `POST …/preview`, `GET …/analytics`; audit rows.
- Persona preview running PS-03's engine on a synthetic in-memory account; no endpoint takes an email or account id.
- ADMIN.md amendment for the panel; help links in both tables.

**Out** (and where it belongs instead):

- Store connections (nothing to connect). Payment providers (→ S-22).

## Design notes

- No "coming soon" or implementation-status copy; no redundant subtitles; a path whose policy is not configured is absent, not disabled.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-06:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-06 in-review`.

## Acceptance criteria

- [ ] The tile renders from the registry (a test with the registry stubbed).
- [ ] The preview has no input that identifies a real person (reviewer check, test on the route schema).
- [ ] `adminCspParity`, the CSP e2e and `check:links` pass.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

ST-13 moves the panel into the settings hub with the Listing editor.

The role agent sets `--set PS-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-06 done`.
