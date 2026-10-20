# LK-07b Customer emails on the Locker identity (I-39 folded onto LK-07's templates)

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                                 |
| Size        | 0.5–0.8 engineer-weeks                                                             |
| Depends on  | [LK-07](LK-07-worker-pages-and-mail.md), [UK-58](UK-58-brand-expression-tokens.md) |
| Unblocks    | none                                                                               |
| Role        | `pkey-implementer`                                                                 |
| Plan mode   | no                                                                                 |
| Gates       | email-snapshots; ui-snapshots                                                      |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Goal

Every customer email (sign-in code, magic link, confirm email, notices, licence key, download link) uses the ink action button, neutral callouts and the centred Locker lockup, with an HTML snapshot per template. Replaces [I-39](I-39-emails-brand-v2.md); the I-39 to I-38 dependency is dropped.

Executes the row(s) named in the [Locker UX map](../locker-ux-waves.md); do not restate it.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- the [Locker UX map](../locker-ux-waves.md) rows and section 5 for this package. (section 1, row 'Sign-in emails'; section 2, row 'Customer non-auth mail').
- SIGN-IN.md §3.15; plans/LK-00.md §7.11; [I-39](I-39-emails-brand-v2.md) for its original scope.

## Owner rules (cite, do not restate)

- **Locker branding on every end-user surface**: the Polaris Locker lockup, `data-brand="locker"`, `polaris.locker`, no host line, and no Key mark, name or violet on a customer surface. **Polaris Key only on developer and admin surfaces.** Coral is for identity only (BRAND §15, D9a); the primary action is neutral ink.
- **No switch**: the customer origin is Locker and old URLs 301 (A5). Drop any "once `customer.host` is on" or soak language.
- plans/LK-00.md §15–§16 holds the rules. The mockups still draw Key in places: follow section 5 of the [Locker UX map](../locker-ux-waves.md), not the pixels.

## Scope

Builds on LK-07's rewritten `templates.ts`; starts the moment LK-07 merges and does not need P0-38. Sender "Polaris Locker" / "<App> via Polaris Locker"; subject lines say Locker; "Open in Polaris Locker" on the licence-key email. Operator and member mail stays Key.

**Out** (and where it belongs instead):

- The sender, lockup and base templates (→ LK-07).

## Acceptance criteria

- [x] Every customer template has an HTML snapshot; no Key mark, name or violet in customer mail.
- [ ] (self-look done in Chromium, 600/390 x light/dark/style-stripped, axe clean bar landmark rules; reviewer pending) `pkey-ux-reviewer` passes the rendered emails (BUILT mode: render each template and view it in a browser, dark and light clients' colour schemes).
- [ ] The scoped green gate passes (AGENTS.md); the header's gates hold.

## Hand-off

The role agent sets `--set LK-07b in-review` when it hands off; the lead sets done after review. Branch from integ/next after the packages in Depends on have merged.

## Notes (2026-10-20)

- LK-07 had already done the ink button, the 230 x 64 Locker lockup and the sender. LK-07b adds the neutral callout (`EmailContent.callout`; the "Wasn't you?" line is one; the deletion date is one), a plain-text part that opens with the heading, and `test/customerEmailHtml.test.ts` (HTML snapshot for 25 messages, brand rules, text mirrors HTML; `LK07B_DUMP=<dir>` writes each for browser review).
- No email mockup files exist under docs/design/mockups; the spec used was SIGN-IN §3.4/§3.15, EXPERIENCE §11.1 and BRAND §15.
