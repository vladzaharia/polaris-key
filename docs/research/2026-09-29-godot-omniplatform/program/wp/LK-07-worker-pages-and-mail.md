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

- [x] email snapshots updated and reviewed; worker `test:workerd` passes
- [ ] pkey-ux-reviewer passes the pages
- [x] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-07 in-review` when it hands off; the lead sets `done` after review.

## Delivered (LK-07, 2026-10-19)

Re-scoped twice. A3 (plans/LK-00.md §14.2) gated the customer side on `customer.host` and put operator mail on Locker; the owner then directed (2026-10-19) a hard cutover with no switch, and that operator and member mail stays Polaris Key (Polaris Locker is the customer site; key.plrs.im is the Polaris Key Console side). The gate and the ungated operator change were built, then removed.

- Customer mail is Polaris Locker unconditionally: sender "Polaris Locker" and "<App> via Polaris Locker", every `templates.ts` template, the sign-in mails in `send.ts`, "Open in Polaris Locker" (`keyEmailPrimaryLabel`), the Locker lockup (`renderEmail({ brand: "locker" })`, 230 x 64, from `/assets/branding/locker/`), neutral-ink actions (D9a). "Locker" joins the reserved sender names.
- Operator and member mail (ST-27 alerts; invites have no template yet) stays Polaris Key: `EmailSender.audience: "operator"`.
- Worker pages: `renderBrandPage` draws Polaris Locker by default (`data-brand="locker"`, lockup, favicon, title suffix, neutral-ink actions, coral as identity only) under its own stylesheet hash; the console's pages pass `brand: "key"` (`console/auth.ts`). So the platform device pages, the card, passthrough, productOidc and refusal pages are all Locker.
- Customer-page copy: "Polaris Key account" and "Sign in to Polaris Key" become Polaris Locker in `card/{emailSignIn,gate}.ts`, `portal/{auth,methods}.ts`, `productOidc/pages.ts`, `accounts/{platformMigration,merge}.ts`; the passkey RP name is "Polaris Locker".
- Delivery surfaces: the bytes and registry landings and the download page wear the Locker shell (title, lockup, data: favicon) with the Star Cut as the Delivery symbol (`core/assets/lockerShell.ts`).
- Assets: the console build emits the Locker lockup PNGs and favicon set under `/assets/branding/locker/`.
- Re-recorded: email snapshot (`licenseCreateDelivery`), `service-route-oracle-3.json` (27 body digests: the identity pages), the transcripts and their Godot mirror.

Notes for the next owner:

- I-39 edits the same templates and has not started: new customer templates use "Polaris Locker" and `brand: "locker"` (via `buildNotice`).
- Left Polaris Key on purpose: the console and docs shells, operator mail, the system product's name (`console/systemProduct.ts`), audit actor names, developer-facing settings and storefront copy. Left to LK-06: `portalShell()`'s `<title>` in `identity/portal/index.ts`. Left to LK-08a: the kit-copy catalog (`core.codes.*` page text, kit strings).
- The Locker page is larger than the Key one (the lockup's wordmark is outlined paths, ~12 KB per page).
- LK-14 also emits `/assets/branding/locker/` from `vite.config.ts` (console favicon and manifest); reconcile the file lists when the second one lands.
