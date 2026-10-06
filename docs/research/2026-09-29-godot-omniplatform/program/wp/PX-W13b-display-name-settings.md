# PX-W13b Display-name policy settings: `identity.reservedDisplayTerms` (platform) and `identity.displayNameApproved` (product) wired into the reserved-name check and the shared-manifest validator (rule 9)

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                 |
| Size        | 0.3–0.6 engineer-weeks                                                                                                  |
| Depends on  | [PX-W13](PX-W13-passthrough-metadata.md), [ST-04](ST-04-settings-resolver.md), [LX-05b](LX-05b-reserved-names-error.md) |
| Unblocks    | none                                                                                                                    |
| Role        | `pkey-implementer`                                                                                                      |
| Plan mode   | no                                                                                                                      |
| Gates       | rule 9 (validator option, mutation table, JSON schema); THREAT-MODEL                                                    |
| Human input | none                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                               |

## Goal

The two display-name policy settings PX-W13 registered ahead of their reader take effect: a
platform list of extra reserved terms, and an operator's per-product approval of a name that uses
one. The validator, the Worker's ingest and listing checks, and the sign-in card's render-time
re-check all read them, so the three answer alike.

## Why

PX-W13 (plans/PX-W13.md §3 and §8 Q4, as amended 2026-10-05) shipped `reserved_display_name` on
the code's term list (`RESERVED_DISPLAY_TERMS`) with the severity switch
`identity.reservedDisplayNames`. It registered the other two settings `pending`, because nothing
could read a product setting until ST-04's resolver existed. A third party's legitimate name
("Steam Deck Companion") has no way through except the approval, and the platform cannot add a
term without a release.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- `plans/PX-W13.md` §3 (the rules table) and §8 Q4; `wp/PX-W13-passthrough-metadata.md`
  (corrections: where the checks run).
- The two registry entries: `identity.reservedDisplayTerms` in
  `packages/worker/src/core/settings/platform.ts` and `identity.displayNameApproved` in
  `packages/worker/src/services/identity/settings.ts`.
- `wp/ST-04-settings-resolver.md` (As built): `resolvePlatformSetting`, `resolveProductSetting`,
  `writeSetting()`.
- `packages/shared-manifest/src/displayName.ts` and its tests; `docs/security/THREAT-MODEL.md`.

## Scope

**In:**

- **Validator (`@polaris-key/manifest`).** `checkDisplayName` and the manifest validator accept
  options for extra reserved terms (added to the code list, which stays the floor) and an
  approval that clears `reserved_display_name` for this product (`invalid_display_text` is never
  cleared). Rule 9: a mutation-table entry for any new or changed rule, the JSON schema
  unchanged (`accepts`), `pkey validate` keeps the code floor when no options are given.
- **Worker.** The reserved-name check (`core/reservedDisplayNames.ts`) reads
  `identity.reservedDisplayTerms` through `resolvePlatformSetting` and
  `identity.displayNameApproved` through `resolveProductSetting`, and passes both to every caller:
  manifest ingest (link, resync, the deploy hook), the console's listing claims
  (`services/distribution/listing/admin.ts`) and the card's render-time re-check
  (`services/identity/passthrough/client.ts`). Remove both entries' `pending` and name their
  readers.
- **Console.** Both fields render from the registry (label, description, confirm level):
  the terms list in Platform → Settings under Identity & access, the approval on the product's
  sign-in settings, operator-only. Writes go through `writeSetting()` (ST-05's generic API, or a
  route that calls it in strict mode if ST-05 has not landed).
- **Tests and THREAT-MODEL.** An extra platform term is reserved at ingest, on a listing claim
  and in the card's re-check; an approved product passes all three and an unapproved one does
  not; approval is operator-only, audited and L1 to grant. The THREAT-MODEL row for spoofed app
  names (PX-W13) gains the two settings: terms only add to the floor, and an approval clears one
  product, never the platform.

**Out** (and where it belongs instead):

- Flipping `identity.reservedDisplayNames` to `error` (PX-W13's follow-up, after the window).
- The card's design (PX-14).

## Steps

1. Verify this brief against the code (PX-W13's corrections name where each check runs) and
   record any correction here.
2. Validator options with tests and the rule 9 entries.
3. Wire the Worker's check through the resolver; remove `pending`; tests.
4. Console fields from the registry; THREAT-MODEL row; the green gate.

## Acceptance criteria

- [ ] An extra platform term is reserved at ingest, on a listing claim and in the card's
      re-check (tests).
- [ ] An approved product's name passes all three; the approval is operator-only, audited, L1.
- [ ] Both registry entries are live (no `pending`) with readers; `settings-coverage`,
      `settings-registry` and `schema-parity` pass.
- [ ] THREAT-MODEL amended; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

The role agent sets `--set PX-W13b in-review` when it hands off. After review, the lead adds the
last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W13b done`.
