# MK-L2 Locker portal mockups: re-skin the 13 portal.\* mockups to Polaris Locker

| Field       | Value                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | MK: Locker mockup re-skins                                                                                                                                          |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                                              |
| Depends on  | none                                                                                                                                                                |
| Unblocks    | [PX-28a](PX-28a-license-page-v2.md), [PX-31a](PX-31a-account-v3-shell.md), [PX-32a](PX-32a-storefront-decision-panel.md), [PX-34](PX-34-library-discover-locker.md) |
| Role        | `pkey-implementer`                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                  |
| Gates       | docs-links; prettier                                                                                                                                                |
| Human input | none                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                           |

## Goal

Re-skin the portal mockups to the Locker identity so BUILT reviews of P2 compare against Locker.

Executes the row(s) named in the [Locker UX map](../locker-ux-waves.md); do not restate it.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- the [Locker UX map](../locker-ux-waves.md) rows and section 5 for this package.
- `docs/design/mockups/screens/portal/portal.*.html`; `docs/design/PORTAL.md`.

## Owner rules (cite, do not restate)

- **Locker branding on every end-user surface**: the Polaris Locker lockup, `data-brand="locker"`, `polaris.locker`, no host line, and no Key mark, name or violet on a customer surface. **Polaris Key only on developer and admin surfaces.** Coral is for identity only (BRAND §15, D9a); the primary action is neutral ink.
- **No switch**: the customer origin is Locker and old URLs 301 (A5). Drop any "once `customer.host` is on" or soak language.
- plans/LK-00.md §15–§16 holds the rules. The mockups still draw Key in places: follow section 5 of the [Locker UX map](../locker-ux-waves.md), not the pixels.

## Scope

Re-skin the 13 `portal.*.html` files: the Locker lockup in place of the Key lockup, the nav `aria-label` named for the place (not "Portal"), the footer host line "Polaris Key · key.plrs.im" removed, polaris.locker, ink primary, `--pk-text-strong` focus ring, no violet. Apply map section 5 items 1, 11, 13 and 15. Update the PORTAL.md wording that describes the Key lockup or a solid violet primary.

**Out** (and where it belongs instead):

- Auth screens (→ MK-L1) and any built code (→ the PX packages).

## Acceptance criteria

- [ ] All 13 portal mockups carry the Locker lockup and no Key mark, host line or violet primary.
- [ ] `pnpm gen --check design-mockups` and `pnpm format` pass; `check.mjs` is clean.
- [ ] `pkey-ux-reviewer` passes one MOCKUP-mode review.

## Hand-off

The role agent sets `--set MK-L2 in-review` when it hands off; the lead sets done after review. Base: integ/next. It can share a builder with MK-L1.
