# PX-25 Account v2 follow-up (PX-13): **Make primary** on an email, **Rename** on a passkey, and the products each address brought in, on PX-W19's API

| Field       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                               |
| Size        | 0.2–0.4 engineer-weeks                                                                                                                                   |
| Depends on  | [PX-W19](PX-W19-account-api-gaps.md), [PX-13](PX-13-account-v2.md)                                                                                       |
| Unblocks    | none                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                       |
| Plan mode   | no                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on changed components |
| Human input | none                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                |

## Id

Filed on 2026-10-07 as "PX-13b". `check.mjs` (`ID_RE`) and `workpackages.schema.json` accept a
letter suffix only on Worker-addition ids (`PX-W9b`, `PX-W13b`), not on the front end's
`PX-<nn>`. Rather than widen the pattern, this package takes the next free front-end id
(README §8, phase PX).

## Goal

PX-13's Sign-in methods page draws the three actions PORTAL.md §4.26 shows and PX-13 could not
build without a Worker: **Make primary** on each non-primary email, **Rename** on each passkey,
and the number of products each address brought in.

## Why

PX-13 shipped the page on PX-W12's API. Its review and hand-off left these three for when PX-W19
serves them.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [PORTAL.md §4.26](../../../../design/PORTAL.md#426-account) (the Email and Passkeys rows) and
  the matching mockups in `docs/design/portal/`.
- `wp/PX-13-account-v2.md` (as built) and `wp/PX-W19-account-api-gaps.md` (the routes, codes and
  fields).
- PX-13's `SignInMethods` and its step-up panel in `packages/admin/src/portal/`.
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- **Email rows.** **Make primary** on every verified address that is not the primary. It uses
  PX-13's inline step-up exactly as **Remove** does: on `step_up_required`, sign in again and
  retry. On success the list re-renders from the response. Each row shows how many products the
  address brought in (`productCount`), and nothing when the count is 0.
- **Passkey rows.** **Rename** edits the name inline, with save and cancel and the Worker's
  1-to-64 bound mirrored in the field. A `422` shows inline. The row's title is `name`, then the
  provider name, then "Passkey".
- The footnote's "emailed to <primary email>" follows the new primary.
- Component and e2e tests; copy keys where the portal keeps them.

**Out** (and where it belongs instead):

- The Worker (→ PX-W19).
- Connected products and the export (→ I-11). Link an existing account and Approve a new device
  (→ PX-15).

## Design notes

- Every action needs step-up and none is destructive, so neither action gets a `danger-subtle`
  panel.
- One `h1` per screen; no horizontal scroll at 360 px; both themes.

## Steps

1. Re-read PORTAL.md §4.26 and the mockups; verify this brief against the code and record any
   correction here.
2. Implement the **In** list in small commits prefixed `PX-25:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-25 in-review`.

## Acceptance criteria

- [ ] e2e: make a second address primary (through step-up), rename a passkey and clear the name;
      the per-address counts render.
- [ ] `vitest-axe` passes on every changed component; one `h1` per screen; no horizontal page
      scroll at 360 px.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e`
      reports zero CSP violations.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in
      the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-19 documents sign-in methods.

The role agent sets `--set PX-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-25 done`.
