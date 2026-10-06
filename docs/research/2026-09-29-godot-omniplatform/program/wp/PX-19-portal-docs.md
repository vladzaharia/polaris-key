# PX-19 Portal docs: rewrite `users/portal.md` and `services/identity/portal.md`, developer guidance for listing art and app branding, mark ADMIN.md's portal parts superseded

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                       |
| Size        | 0.1–0.2 engineer-weeks                                                                           |
| Depends on  | [PX-09](PX-09-get-it-complete.md), [PX-14](PX-14-passthrough-header.md)                          |
| Unblocks    | none                                                                                             |
| Role        | `pkey-implementer`                                                                               |
| Plan mode   | no                                                                                               |
| Gates       | the PORTAL.md §11 green gate; `check:links`; generated docs pages regenerated, never hand-edited |
| Human input | none                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                        |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Portal docs: licences are not typed (owner decision 2026-10-05: no 'Account-wide' label): every licence is account-bound and device-limited ("2 of 5 devices", Devices with Remove; SIGN-IN.md D-53), and shows its origin in plain words ("From signing in", "Steam key ending 3WPLDA", "From Steam"), the tier pill and "Lifetime", Replace a device from sign-in vs Remove in the portal (SIGN-IN.md D-08, O-11).

## Goal

The docs describe the redesigned Polaris Key customer site: naming, Library and Discover, Activate license, sign-in methods and Cloud Sync for end users; listing art and app branding data for developers; ADMIN.md's portal parts are marked superseded by PORTAL.md.

## Why

The current pages describe the old portal ([PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17)). PORTAL.md sizes this S (≤ 1 agent-day); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- `packages/docs/src/content/docs/users/portal.md`, `packages/docs/src/content/docs/services/identity/portal.md`
- `docs/design/ADMIN.md` §2.7, §6.10, §7.2
- [PORTAL.md §7](../../../../design/PORTAL.md#7-layout-and-visual-details)

## Scope

**In:**

- The two page rewrites; developer guidance (art sizes per §7, safe bottom-right corner, app branding data); ADMIN.md superseded notes.

**Out** (and where it belongs instead):

- Anything not in PORTAL.md's row for this package (→ the PX package that owns it, per §11).

## Design notes

- **Naming and copy** (owner decisions, PORTAL.md header and Appendix C/E): the product is "Polaris Key" everywhere, never "Polaris Key Portal"; page titles read "<Page> · Polaris Key"; US "license" in UI copy; plain words per §6.1 (never "claim", "redeem", "OIDC", "entitlement").

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-19:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-19 in-review`.

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/docs check:links` passes.
- [ ] Docs drift gates pass if routes are documented (generated pages regenerated, never hand-edited).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

none.

The role agent sets `--set PX-19 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-19 done`.
