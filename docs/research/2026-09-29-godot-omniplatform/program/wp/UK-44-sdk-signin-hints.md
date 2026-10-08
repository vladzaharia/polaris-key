# UK-44 SDK sign-in hints: `signIn.start({loginHint, nameHint, purpose})` in Node, React (over `client-core`), Python, Swift, Kotlin and Godot, replaying PX-W18's transcripts, with `identity.signin.hints` in every `parity.json`

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                       |
| Size        | 0.5–0.8 engineer-weeks                                                                                             |
| Depends on  | none                                                                                                               |
| Unblocks    | none                                                                                                               |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                               |
| Plan mode   | yes: executes the approved `plans/PX-W18.md` (written in PX-W18)                                                   |
| Gates       | plan mode (executes `plans/PX-W18.md`); transcript replay in every SDK; `parity:check`; `gen:constants -- --check` |
| Human input | none beyond PX-W18's plan approval                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [I-10a](I-10a-sdk-identity-node-react-python.md) and [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [I-10a](I-10a-sdk-identity-node-react-python.md) and [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Hints are an argument of the same signIn.start call I-10a/b introduce.

- Dependencies cleared on closing (they were PX-W18, I-10a and I-10b), so nothing in the graph waits on or through a closed package.
- `planRef` removed on closing (it executed PX-W18's plan, [`plans/PX-W18.md`](../plans/PX-W18.md)).

## Goal

Every SDK with sign-in accepts `loginHint`, `nameHint` and `purpose` when it starts a sign-in and
sends them on the pushed request (and `login_hint` on `authorize`), proven by replaying PX-W18's
transcripts, with `identity.signin.hints` implemented in each `parity.json`.

## Why

[S-24](../../notes/S-24-licence-holders.md) §6.4: the kits' **Add your name and email** (UK-42,
UK-43) needs the members in the headless layer of every SDK. It is the SDK half of a plan-mode
wire change, so it follows PX-W18's approved plan exactly.

## Read first

- AGENTS.md (rules 1–3) and CLAUDE.md.
- `plans/PX-W18.md` (once approved); [PX-W18](PX-W18-signin-hints.md); S-24 §6.4.
- [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md)
  (the sign-in start API they add).

## Scope

**In:** Node (`packages/sdk-node`), React over `packages/client-core`, Python (`sdks/python`),
Swift (`sdks/swift`), Kotlin (`sdks/kotlin`), Godot (`sdks/godot`): the three optional members on
`signIn.start` (snake_case in Python and Godot), validation as the plan says (an invalid hint is
dropped, never an error), transcript replay of `identity-request-hints.json`, each `parity.json`
row at `implemented`.

**Out:** kit UI (→ UK-42, UK-43).

## Steps

1. Node and `client-core` (React) first, then Python, Swift, Kotlin, Godot.
2. Replay the transcripts; update `parity.json`.

## Acceptance criteria

- [ ] All six SDKs send the members exactly as the transcripts record (replay tests).
- [ ] `pnpm parity:check` and `gen:constants -- --check` pass.
- [ ] The green gate passes (AGENTS.md), including every SDK suite.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift test )
sdks/godot/tools/run_tests.sh
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :identity:test :conformance:test )
```

## Hand-off

UK-42 and UK-43 call the members.

The role agent sets `--set UK-44 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-44
done`.
