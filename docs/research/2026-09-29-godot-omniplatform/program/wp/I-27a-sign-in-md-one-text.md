# I-27a SIGN-IN.md as one current text

| Field       | Value                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation K: Corpus lane (wire trains, serial)) |
| Size        | 0.2–0.4 engineer-weeks                                                                                                     |
| Depends on  | [I-27](I-27-plan-identity-consolidation.md)                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                     |
| Role        | `pkey-implementer`                                                                                                         |
| Plan mode   | no; executes the docs step of [`plans/I-27.md`](../plans/I-27.md) §8 (approved 2026-10-08)                                 |
| Gates       | `docs-links`                                                                                                               |
| Human input | none                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                  |

## Goal

`docs/design/SIGN-IN.md` reads as one current text: no amendment layers, no precedence notes, and every rule stated once, as the approved plans now have it. Done when every acceptance criterion holds.

## Why

SIGN-IN.md gained a layer for each decision round (§F, §G, the 2026-10-05 owner decisions, I-27). A reader has to work out which layer wins. I-27 §8 asks for one text; the I-08, I-09 and PX-14 briefs were already rewritten as single specs.

## Read first

- `AGENTS.md` (always).
- [`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) in full.
- [`plans/I-27.md`](../plans/I-27.md) (§2.1, §2.2, §2.4, §8 and the owner decisions), [`plans/I-04.md`](../plans/I-04.md) §F and §G, [`plans/UK-02b.md`](../plans/UK-02b.md) (D1, Q2: the License-off ending in §3.17 item 4).
- `wp/I-08-app-passthrough.md`, `wp/I-09-key-entry-attach.md`, `wp/PX-14-passthrough-header.md`: the single specs the text must agree with.

## Scope

**In:**

- Fold every amendment and precedence note into the section it changes; delete what a later decision superseded. Keep the frame numbers, the D- and O- decision ids and the copy keys stable, so briefs and kits that cite them still resolve.
- `ui.signin` replaces `ui.kit.signin` wherever the text names the parity row (UK-02b D1).

**Out** (and where it belongs instead):

- Copy catalog changes (→ the package that owns the copy); the briefs (already rewritten).

## Design notes

- Terse: each fact once, in plain terms; no history ("previously", "was").

## Steps

1. List every layered passage and the decision that resolves it.
2. Rewrite in place; check every inbound link and anchor; hand off.

## Acceptance criteria

- [x] No amendment layers left in SIGN-IN.md.
- [x] Every frame number, D- and O- id and copy key cited elsewhere in the repo still resolves (`git grep`).
- [x] `pnpm format` and the docs link check pass.

## Verify

```sh
mise exec node@22 -- pnpm exec prettier --check docs/design/SIGN-IN.md
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set I-27a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-27a done`.
