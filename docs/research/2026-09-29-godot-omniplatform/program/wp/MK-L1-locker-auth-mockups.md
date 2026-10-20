# MK-L1 Locker auth mockups: re-skin the identity.\* and portal.signin mockups to Polaris Locker

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | MK: Locker mockup re-skins                                                                    |
| Size        | 0.4–0.7 engineer-weeks                                                                        |
| Depends on  | none                                                                                          |
| Unblocks    | [I-38a](I-38a-hosted-worker-pages-locker.md), [PX-14a](PX-14a-card-header-licence-consent.md) |
| Role        | `pkey-implementer`                                                                            |
| Plan mode   | no                                                                                            |
| Gates       | docs-links; prettier                                                                          |
| Human input | none                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                     |

## Goal

Re-skin the sign-in mockups to the Locker identity so BUILT reviews of P1 compare against Locker, not Key.

Executes the row(s) named in the [Locker UX map](../locker-ux-waves.md); do not restate it.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- the [Locker UX map](../locker-ux-waves.md) rows and section 5 for this package.
- `docs/design/mockups/screens/identity/` and `portal.signin.html`; `docs/design/SIGN-IN.md`.

## Owner rules (cite, do not restate)

- **Locker branding on every end-user surface**: the Polaris Locker lockup, `data-brand="locker"`, `polaris.locker`, no host line, and no Key mark, name or violet on a customer surface. **Polaris Key only on developer and admin surfaces.** Coral is for identity only (BRAND §15, D9a); the primary action is neutral ink.
- **No switch**: the customer origin is Locker and old URLs 301 (A5). Drop any "once `customer.host` is on" or soak language.
- plans/LK-00.md §15–§16 holds the rules. The mockups still draw Key in places: follow section 5 of the [Locker UX map](../locker-ux-waves.md), not the pixels.

## Scope

Re-skin `identity.{sign-in,device-code,device-code-states,device-confirm,consent,finish,key-step,refusals}.html` and `portal.signin.html`: the Locker lockup, `data-brand="locker"`, polaris.locker, ink primary, `--pk-text-strong` focus ring, no Key mark or violet. Apply map section 5 items 2 to 6, 8 to 13 to the HTML and to `docs/design/SIGN-IN.md` (trust receipt reads "Polaris Locker signs you in for <App>…", `polaris.locker/device`, finish terms and "Shown in Polaris Locker and in emails", "Can't reach Polaris Locker" on the customer card only, emails, key verdict, passthrough brand row). L683 (console) stays Key. The terms document's name is for the lead or owner to confirm: mark it in the PR.

**Out** (and where it belongs instead):

- Screens, built code and the portal files (→ MK-L2, PX-12, PX-14a, I-38a).
- Rebuilding the mockup index or the generated mockups: regenerate with `pnpm gen design-mockups` if its sources changed.

## Acceptance criteria

- [ ] Every touched mockup renders with the Locker lockup and no Key mark, host line or violet primary.
- [ ] `pnpm gen --check design-mockups` and `pnpm format` pass; `check.mjs` is clean.
- [ ] `pkey-ux-reviewer` passes one MOCKUP-mode review of the re-skinned screens (screenshots, dark and light).

## Hand-off

The role agent sets `--set MK-L1 in-review` when it hands off; the lead sets done after review. Base: integ/next. Do it first: BUILT reviews of P1 compare against these files.
