# SP-65b End-to-end CI: React `usePolarisFetch`, native clients, `requireSignIn` legs

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08)) |
| Size        | 0.3 engineer-weeks                                                               |
| Depends on  | [SP-65](SP-65-end-to-end-ci-client-backend-pkey-dev.md)                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                           |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no                                                                               |
| Gates       | `ci`                                                                             |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Split 2026-10-22 (triage)

Filed from [SP-65](SP-65-end-to-end-ci-client-backend-pkey-dev.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size about 1.5 days). SP-65 carries what is on staging; this package carries the rest.

On staging already: SP-65 slice 1 (f98532eab) on staging: the `e2e-backend` lane, Node Express/Hono/Next and Python FastAPI/Flask legs, and the stale case for four of them.

## Goal

End-to-end CI: React `usePolarisFetch`, native clients, `requireSignIn` legs. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [SP-65](SP-65-end-to-end-ci-client-backend-pkey-dev.md), its Progress and Split notes.

## Scope

**In:**

- The legs SP-65 left: React `usePolarisFetch`, the native-client legs, and the `requireSignIn` end-to-end legs against `pkey dev`, as new lanes in the `e2e-backend` job (and a row in `tools/ci-scope.json`). Low priority; the Django/DRF leg and the Next stale case stay in SP-65.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything SP-65 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A React `usePolarisFetch` leg runs against `pkey dev` in CI
- [ ] Native-client legs run in their lanes
- [ ] `requireSignIn` end-to-end legs pass
- [ ] `tools/ci-scope.json` routes the new lanes
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-65b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-65b done`.
