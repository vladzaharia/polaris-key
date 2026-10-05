# PS-09 Optional: `email_domain` obtain path: `.pkey/product` `autoIssue.emailDomains`, verified emails only, the same rule at product sign-in

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 4: more paths) |
| Size        | 0.5–0.8 engineer-weeks                                                                         |
| Depends on  | [PS-03](PS-03-obtain-path-engine.md)                                                           |
| Unblocks    | none                                                                                           |
| Role        | `pkey-implementer`                                                                             |
| Plan mode   | no                                                                                             |
| Gates       | rule 9 (mutation-table entry); THREAT-MODEL (S4); workerd                                      |
| Human input | none                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                      |

## Goal

Optional: `.pkey/product` `autoIssue.emailDomains` lets a product auto-issue to verified emails at listed domains, at product sign-in and in the storefront alike.

## Why

PORTAL.md §4.16 already promises "For everyone with a fennick.studio email"; [S-21 §6.3](../../notes/S-21-polaris-storefront.md#63-the-eligibility-engine-obtain-paths-ps-03).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `packages/shared-manifest/src/index.ts` and `schemas/v1/product.schema.json` (`autoIssue`); `test/schema-parity.test.ts`; `oidc.ts` (`identityTier`).

## Scope

**In:**

- Manifest field (≤ 20 lower-case domains, no wildcards), validator rule and mutation-table entry; registry entry update for `license.autoIssue`.
- `identityTier` honours it for verified emails only (so sign-in and storefront agree); `email_domain` path and copy.

**Out** (and where it belongs instead):

- Wildcard or sub-domain matching.

## Design notes

- Only emails that passed the email gate count; the domain is the part after the last `@`.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-09:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-09 in-review`.

## Acceptance criteria

- [ ] Schema parity passes with the new rule; tests for verified, unverified and look-alike domains.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test && mise exec node@22 -- pnpm --filter @polaris-key/worker test obtain oidc
```

## Hand-off

None.

The role agent sets `--set PS-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-09 done`.
