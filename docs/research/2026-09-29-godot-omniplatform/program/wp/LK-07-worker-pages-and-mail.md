# LK-07 Worker pages and customer mail on the Locker identity

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | LK: Polaris Locker                                                             |
| Size        | 1–1.25 engineer-weeks                                                          |
| Depends on  | [LK-01](LK-01-brand-locker-kit.md), [LK-03](LK-03-customer-host-and-origin.md) |
| Unblocks    | [LK-11](LK-11-cutover.md)                                                      |
| Role        | `pkey-implementer`                                                             |
| Plan mode   | no                                                                             |
| Gates       | email-snapshots, workerd                                                       |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

## Goal

Worker pages and customer mail on the Locker identity. Executes `plans/LK-00.md` §7.11–7.12; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §7.11–7.12 (plus its §0, §1, A1 and A2 notes).
- `.claude/agents/pkey-ux-reviewer.md` (the quality bar).

## Scope

Exactly `plans/LK-00.md` §7.11–7.12. Anything else is another package's row in §9.

Re-scoped by Amendment A3: operator mail (ungated), the download page and the bytes and registry landings (gated); see `plans/LK-00.md` §14.6.

## Acceptance criteria

- [ ] email snapshots updated and reviewed; worker `test:workerd` passes
- [ ] pkey-ux-reviewer passes the pages
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-07 in-review` when it hands off; the lead sets `done` after review.

## Delivered (LK-07, 2026-10-19)

Re-scoped per plans/LK-00.md §14.2 and §14.6, then by the owner direction above (customer side only, gated).

- Operator and member mail (ST-27 alerts; invites have no template yet) stays Polaris Key: owner direction 2026-10-19 overrides A3 §14.2/§14.4 (Polaris Locker is the customer site; key.plrs.im is the Polaris Key Console side). `EmailSender.audience: "operator"` keeps it Key even while `customer.host` is on; A3's ungated operator-mail change was built, then reverted.
- Customer mail: every `templates.ts` template and the sign-in mails in `send.ts` are built in both brands; `deliverEmail` sends the Locker one (sender "Polaris Locker", "<App> via Polaris Locker", Locker copy and lockup) while `customer.host` is on. Off is byte for byte (existing snapshots unchanged). "Locker" joins the reserved sender names.
- Pages: `applyPageBrand` (in `dispatchWith`) rewrites any Key brand page to the Locker shell while the switch is on, so the 90-odd synchronous `renderBrandPage` callers never read it; the console and docs paths are excluded. `renderBrandPage({ brand: "locker" })` draws the same page (test: rewrite equals render). The Locker stylesheet has its own CSP hash.
- Delivery surfaces: the bytes and registry landings and the download page take the Locker shell (title, lockup, data: favicon) with the Star Cut as the Delivery symbol, gated; own CSP hashes, `img-src data:` only for the Locker download page.
- Assets: the console build emits the Locker lockup PNGs and favicon set under `/assets/branding/locker/`.

Notes for the next owner:

- I-39 edits the same templates and has not started: whichever lands second carries the other (new templates must be wrapped in `dual(...)` and use `b.name`).
- The body words of the sign-in pages (`portal/auth.ts` and `productOidc/pages.ts` join-offer copy, "A Polaris Key account already uses ...") stay Key until LK-04 and LK-06, which own those files; the shell around them is Locker.
- The landing pages and the download page are `public` cached (3600 s for landings): a flip of the switch shows within the cache lifetime.
- LK-14 also emits `/assets/branding/locker/` from `vite.config.ts` (console favicon and manifest); reconcile the file lists when the second one lands.
