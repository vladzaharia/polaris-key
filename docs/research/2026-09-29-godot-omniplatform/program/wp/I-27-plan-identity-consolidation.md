# I-27 Plan the identity consolidation

| Field       | Value                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation K: Corpus lane (wire trains, serial))                                                                                                                                                |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                                                                                    |
| Depends on  | none                                                                                                                                                                                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-08](I-08-app-passthrough.md), [I-09](I-09-key-entry-attach.md), [I-30](I-30-connections-one-oidc-relying-party.md), [I-33](I-33-profile-v2-screen-name-birth-date.md), [I-35](I-35-one-identity-manifest-block-joint-lx-36.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                                                                                                                                       |
| Plan mode   | yes: [`plans/I-27.md`](../plans/I-27.md), approved 2026-10-08; the packages in its §8 build it, including the new I-32b and I-32c                                                                                                                                         |
| Gates       | `plan-mode`, `rule-9`                                                                                                                                                                                                                                                     |
| Human input | none                                                                                                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-00** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial).

- Owner 2026-10-07: no compatibility window. What this package replaces (a route, mode, shape, Action input or CLI form) is removed in the same release; the one exception is a path that native app binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes), removed once DJDL has shipped a build on 0.9 (`tracks.md` rule 6).

## Approved 2026-10-08

The plan is approved, with the owner's answers to Q1 (auto-link, narrowly) and Q3 (no Pocket ID sunset). Its post-approval docs step (§8: the I-08, I-09 and PX-14 briefs as single specs, and SIGN-IN.md's precedence notes folded into one text) goes with the §12 brief changes, which the lead applies; neither blocks the packages this one unblocks.

## Goal

Plan the identity consolidation, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-00** in [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.2, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.2, §4.1, §4.2, §4.3, for **IX-00**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- Amends plans/I-04.md §2.5, §2.8, §3.6 rule 4 and plans/I-09.md §3: the connection model (scope, audience, verified domains, enforce, email*verified trust and auto-link rules); the OAuth 2.1 shape of I-08's authorize and token (client_id, scope, nonce, login_hint) reused by I-21, naming the transcripts re-recorded (redirect-web-\*) and every SDK that follows (I-10a, I-10b), with no signed shape change; the first-licence skip of LicenseChoice (decided under the brief, D4); the identity.keyEntry key shape (I-09 implements the setting, I-35 adds only the manifest block); granular consent; profile fields (screen name, optional birth date); the pkeyp* credential (rule 8, scopes, lifetimes) jointly with F-33 and ST-34; console on accounts jointly with ST-28; the identity: manifest block and license.access jointly with LX-36; the retirement list and sunset rules; SIGN-IN.md and the I-08, I-09 and PX-14 briefs rewritten as single current specs.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track K (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-00**; DX consolidation K: Corpus lane (wire trains, serial).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Write `plans/I-27.md` and stop for human approval; name the corpus regeneration and every SDK that follows where the wire is touched.
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Plan approved; names the corpus and transcript impact and SDKs
- [ ] No amendment layers left in SIGN-IN.md
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-27 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-27 done`.
