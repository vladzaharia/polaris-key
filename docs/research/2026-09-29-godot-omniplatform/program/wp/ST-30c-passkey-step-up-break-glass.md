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

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] SM-3(a)/(d): a person can enrol a passkey and mark it "Use for the console"
- [ ] Break-glass is an explicit link with an audit row and documented exit facts
- [ ] The known-operator chip shows from a last-operator hint
- [ ] The `session.ts:5` comment is deleted; the v1 cookie reader is removed (one release after 8 h)
- [ ] The console card has the larger lockup
- [ ] THREAT-MODEL rows for each; security review signed
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set ST-30c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-30c done`.
