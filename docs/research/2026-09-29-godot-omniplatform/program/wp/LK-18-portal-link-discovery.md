# LK-18 Discovery core.portal: the terminal kits' product page link from the customer origin, left out while the product's portal is off

| Field       | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                                                               |
| Size        | 0.4–0.7 engineer-weeks                                                                                           |
| Depends on  | [LK-17](LK-17-hard-cutover.md), [UK-51](UK-51-terminal-drop-in-contract.md), [HA-13](HA-13-sdks-presentation.md) |
| Unblocks    | none                                                                                                             |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                            |
| Plan mode   | yes                                                                                                              |
| Gates       | x                                                                                                                |
| Human input | none                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                        |

## Goal

Closes bug-ledger row B-115. Executes `plans/DISC-01.md`; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `plans/DISC-01.md`.

## Scope

Exactly `plans/DISC-01.md` (decisions D1 to D9 approved as recommended): the contract section 5.7, `ProductPortal`, `portal-matrix.json` and the `discovery-portal` transcript, client-core `./portal`, the Node and Python terminal kits, the Worker's `core.portal`, the `ui.cli.portal` parity feature, and the docs. Widget-kit Renew and Manage defaults are out of scope.

## Acceptance criteria

- [x] Each terminal kit's `status` on a portal-off product draws "Contact {developer}"
- [x] Against a Worker without the member, the link is byte-identical to today's
- [x] `pnpm gen --check` clean; the `plans/DISC-01.md` section 11 commands pass, filtered to what the change touches

## Hand-off

The role agent sets `--set LK-18 in-review` when it hands off; the lead sets `done` after review.
