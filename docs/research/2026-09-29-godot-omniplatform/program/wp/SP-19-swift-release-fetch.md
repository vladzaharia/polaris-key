# SP-19 Swift verified download (`release.fetch`): Range and If-Range resume, the 401 body code mapped, and the fetch moved onto the client's transport so `release-fetch-gated.json` replays

| Field       | Value                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                            |
| Size        | 0.4–0.6 engineer-weeks                                                               |
| Depends on  | none                                                                                 |
| Unblocks    | none                                                                                 |
| Role        | `pkey-sdk-porter`                                                                    |
| Plan mode   | no                                                                                   |
| Gates       | `swift test` with the transcript replayer; `parity:check`; the generated parity page |
| Human input | none                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                            |

## Goal

`client.update.fetch(version:buildId:size:sha256:to:)` resumes a partial download with `Range` and `If-Range` (on the payload SHA-256), maps a 401 to the body's code rather than always `download_auth_required`, and streams through the client's transport, so the Swift transcript replayer runs all three steps of `release-fetch-gated.json`.

## Why

The fetch streams and verifies size and SHA-256 but cannot resume, misreads 401 bodies, and bypasses the transport, so the transcript cannot replay. The parity rows it owns: `release.fetch` in `sdks/swift/parity.json`; their `note` fields give the current state. It absorbs the parity note's the Swift half of §3.6 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.6.
- `sdks/swift/Sources/PolarisKeyUpdate/Install.swift` (the fetch).
- `conformance/transcripts/release-fetch-gated.json`; Node's `client.release.fetch` as the reference.

## Scope

**In:**

- Resume from `<to>.part` with `Range` and `If-Range`; restart on a 200.
- The 401 body code mapped through `errors.json`.
- Streaming through the client transport (testable with the replay transport).
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- The update hand-off (SP-S10 in the note).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- A `200` to a ranged request means the representation changed: discard the partial and restart.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature release.fetch` tests replay all three steps of `release-fetch-gated.json` (200, 206, 401).
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
( cd sdks/swift && swift build && swift test )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- Swift's update hand-off and the SwiftUI update banner build on it.

The role agent sets `--set SP-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-19 done`.
