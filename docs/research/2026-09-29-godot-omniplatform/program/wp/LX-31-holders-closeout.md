# LX-31 Licence holders close-out: glossary (floating, assigned), the New License and bulk-keys docs pages, THREAT-MODEL T-H1–T-H5, and one e2e path from the console wizard through a kit activation to the portal

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (S-24: licence holders)                                                                                |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                            |
| Depends on  | [LX-29](LX-29-new-license-wizard.md), [LX-30](LX-30-console-holder-surfaces.md), [PX-23](PX-23-portal-floating-keys.md), [UK-42](UK-42-activation-holders-web.md) |
| Unblocks    | none                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                |
| Gates       | docsLinks; generated docs; THREAT-MODEL; console and portal e2e                                                                                                   |
| Human input | none                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                         |

## Goal

The glossary, the docs site and the threat model describe floating and assigned licences, the New
License wizard and bulk keys as built, and one end-to-end test proves the whole path: create in the
console, activate without an account in a kit, add a name and email, and see it in the portal.

## Why

[S-24](../../notes/S-24-licence-holders.md) changes vocabulary (AGENTS.md rule 4: the glossary
wins) and adds threat rows T-H1–T-H5 (§7.5). The packages are split across the console, the portal
and the kits, so only an end-to-end path shows they agree.

## Read first

- AGENTS.md (rules 4 and 11, docs conventions).
- [S-24](../../notes/S-24-licence-holders.md) §5, §7.5, §8, §9, §10.
- `packages/docs/src/content/docs/start/concepts.md`, `services/license/*`, `users/portal.md`,
  `docs/security/THREAT-MODEL.md`.

## Scope

**In:**

- Glossary: **floating licence** ("a licence in no account: whoever has the key uses it; not
  concurrent use") and **assigned licence** ("a licence with a holder: in an account, or waiting for
  its email"); retire "unowned licence" (S-19 §7.1) in favour of floating.
- Docs pages: issuing a licence (the wizard, holders, delivery), bulk keys (batches, the CSV,
  Disable unused), and the customer side (activating without an account, adding it to an account).
- THREAT-MODEL T-H1–T-H5.
- E2E: console wizard → key → kit (React reference app) activation without an account → Add your
  name and email (card, test email code) → portal Library shows the licence with "Key ending …" and
  the device.

**Out:** feature code (owned by the packages it depends on).

## Steps

1. Glossary and docs pages; console help links in the two tables if a slug changes.
2. THREAT-MODEL rows.
3. The e2e path.

## Acceptance criteria

- [ ] The glossary defines floating and assigned; no page says "unowned".
- [ ] The docs build and `check:links` pass.
- [ ] The e2e path passes in CI.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

Closes S-24's program slice.

The role agent sets `--set LX-31 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-31
done`.
