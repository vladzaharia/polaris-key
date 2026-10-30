# ST-30c Console sign-in: passkey step-up, break-glass link, known-operator chip, v1 reader removal, lockup

| Field       | Value                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity) |
| Size        | 0.1–0.15 engineer-weeks                                                                                                  |
| Depends on  | [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md)                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                   |
| Role        | `pkey-implementer`                                                                                                       |
| Plan mode   | no                                                                                                                       |
| Gates       | `threat-model`, `security-review`                                                                                        |
| Human input | none                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                |

## Split 2026-10-22 (triage)

Filed from [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size 4–6 h). ST-30 carries what is on staging; this package carries the rest.

On staging already: ST-30 slices 1, 2a and 2b on staging (138001ae0, c2a62586d, bd8e77752): the card, cookie v2, `consoleSubject`, migration 0128, SM-1/3b/3c/4/5, `rootRuleHolds`, the `mbr_` audit actor.

## Goal

Console sign-in: passkey step-up, break-glass link, known-operator chip, v1 reader removal, lockup. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md), its Progress and Split notes.

## Scope

**In:**

- The remainder of ST-30 (security-relevant): SM-3(a)/(d) passkey step-up enrolment and "Use for the console"; the break-glass link with its audit row and exit facts; the known-operator chip; deleting the `session.ts:5` "full platform authority" comment; removing the v1 cookie reader after the deploy that issued v2; the larger lockup on the console card. The members/roles docs, RUNBOOK lockout recovery and rule 11 text are NOT here: they moved to ST-35.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything ST-30 already shipped.

## Verified against the code (ST-30c.1)

- **C5.** The "full platform authority" invariant was `session.ts:1-6`. ST-30c.1 rewrote that header
  (v2 pointer, the break-glass realm with no account; the v1 reader was removed in ST-30c.8). `docs.ts`
  is on `can(platform, docs)`, not on a group.
- **C6.** The card lockup is already 52 px since 81d8c9e04. ST-30c.2 confirms it against frame 13
  rather than enlarging it.
- **C7.** `docs/RUNBOOK.md:2105` already holds the break-glass exit facts (at least 30 days from the
  deploy, 14 days with no `rbac.breakglass` row, two accounts with a Superadmin binding and a strong
  passkey). The clock starts at the release that carries ST-30c.1.
- **C8.** SEC-adminsession is not implemented, so the 8 h `ADMIN_SESSION_TTL_SECONDS` is reused and
  never hardcoded. Break-glass has its own `BREAK_GLASS_TTL_SECONDS` = 3600.
- **C9.** The sign-in card is script-free (strict CSP); D-S2 applies to later slices.
- **C10.** Console step-up is `stepUpAt` (`isSteppedUp`, `STEP_UP_MAX_AGE_SECONDS`), not a flag.
- **C11.** About 110 test files mint v1 cookies, which is why ST-30c.7 exists.
- **ST-31.8 review note.** `convertInvites(..., via: "passkey")` has no caller yet. ST-30c.5 must pass
  `via` honestly when its passkey sign-in lands. Break-glass skips every ST-31.8 gate and
  conversion, and a test pins that it converts no invite.
- **Done in ST-30c.1.** The break-glass cookie realm, flow flag, callback branch, audit row, the
  Superadmin notice (`console/lib/operatorNotices.ts`, moved out of `bindings.ts`) and
  `requireAccountSession` (`console/lib/accountSession.ts`). ST-34's personal-token rows are not on
  this base; they adopt `requireAccountSession` when the chains merge. The link on the card is
  ST-30c.2, so the "explicit link" acceptance item stays open until then.
- **Done in ST-30c.2.** The card (known-operator chip from `__Host-pkey_console_hint`, Change at
  `?change=1`, the quiet "Emergency sign-in" link and the break-glass start card), the shell banner
  (`/me.breakGlass`) and N1 to N3 from the ST-30c.1 review: the break-glass cookie carries only the
  `PLATFORM_ADMIN_GROUP` group, and `refuseBreakGlass` refuses the admin API, service (CI) and
  registry token mints with reason `break_glass_session`. Corrections: (1) the UX review measured the lockup at about 80 % of frame 13 on desktop, so it is now the native 64 px
  (222x64, `13.875rem x 4rem`) from 30 rem with "Console" at 1.25rem / 500, and 52 px on phones, all in rem; (2) the base has no account-bound console
  screen to hide (no "Yours" tab, no account settings; personal tokens here is the Superadmin list and
  revoke), so the only account-bound shell entry hidden is "My library"; ST-34 and ST-30c.4 hide their
  screens with `me.breakGlass` when they land; (3) `pageBudget` fails on this base for
  `UpdateChannelsPage.tsx` (639 lines, ceiling 631), not a file of this slice.
- **Done in ST-30c.3.** `GET /manage/api/me/methods`, `POST /me/passkeys/options`, `POST /me/passkeys`
  and `POST /me/methods/:id/strong` (`console/handlers/myMethods.ts`; Identity's `listConsoleMethods`,
  `consolePasskeyCeremony`, `markConsoleMethodStrong`). The console RP id is the host of
  `CONSOLE_ORIGIN` (`consoleRpId`); `consoleEligible` is a not-yet-strong passkey whose `rp_id` equals it.
  Corrections: (1) all three writes are `stepUp: true` rows (the dispatcher answers 403
  `step_up_required`), and I-16 still checks `authenticatedAt` behind it (401), fed the epoch when the
  session has no step-up; (2) an already-strong link answers 409 reason `already_strong`; (3) the
  account copy of the notice (`consoleMethodStrongNotice`) is separate from I-16's own
  sign-in-method-added mail, so enrolment mails the account twice. No migration, wire or errors.json change.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] SM-3(a)/(d): a person can enrol a passkey and mark it "Use for the console"
- [x] Break-glass is an explicit link with an audit row and documented exit facts
- [x] The known-operator chip shows from a last-operator hint
- [x] The `session.ts:5` comment is deleted; the v1 cookie reader is removed (ST-30c.8, 2026-10-28; gate: v0.9.16 deploy at 2026-10-23T21:05Z, `deploy.yml` success; ships in 0.10.1)
- [x] The console card has the larger lockup (64 px from 30 rem, 52 px on phones, matching frame 13; ST-30c.2 after the UX review)
- [ ] THREAT-MODEL rows for each; security review signed
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set ST-30c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-30c done`.

## ST-30c.8 note (2026-10-28)

Removed the v1 cookie reader: `issueSession`, `verifySession`, the `pkey.admin.v1|` tag and the v1 branch of `sessionFromRequest` (a v1 token is no session, answered as a cookie-less request), the IdP-subject sign-out mark for v1 in `POST /logout`, and `consoleMemberIdForIdpSub`. Corrections to the plan: about 17 test files still minted v1 cookies on staging (connect, sync, commerce, channels and others landed after ST-30c.7), so they moved to `consoleTestSession`; v1-negative cases use `forgeV1Cookie` (`test/consoleSessionHelper.ts`). THREAT-MODEL rows updated, including SEC-RB1's N1 (closed). No route, error code or wire change.
