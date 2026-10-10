# P4-32 HTTP transcript for the chunk-bundle Range + If-Range fetch

| Field       | Value                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v2)                                                                                                |
| Size        | 0.5–1 engineer-weeks                                                                                          |
| Depends on  | [P4-11](P4-11-chunk-sync-sdks.md)                                                                             |
| Unblocks    | none                                                                                                          |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                          |
| Plan mode   | yes: execute the approved `plans/P4-32.md`; the plan's approval is this package's plan-mode gate              |
| Gates       | plan mode; transcript drift gate; parity rule 6 (all SDKs that implement `packs.apply.chunk`); generated docs |
| Human input | none beyond the plan's three decisions                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                     |

## Goal

Close P4-11's open follow-up. Record a Worker scenario for a chunk-bundle fetch on the blobs
route with `Range` and `If-Range` and add it to `conformance/transcripts/`. The scenario covers:

- a `206` with an exact `Content-Range` and `ETag`;
- a `206` clipped at the end of the object;
- the `200` the Worker answers when `If-Range` misses.

Then add a `transcript` proof to `packs.apply.chunk`, and replay the transcript in the Node, React,
Python, Swift and Godot replayers. Kotlin follows with P6-08.

## Why

Each SDK's fake-server tests cover the `Range`, `If-Range`, `ETag` and `Content-Range` exchange,
but nothing yet holds every SDK to the Worker's real answers (PARITY §4.2). This package adds
conformance evidence only. The wire contract does not change: WIRE-CONTRACT-V4 §11.4 already
fixes the chunk-run rule.

## Read first

- [`plans/P4-32.md`](../plans/P4-32.md) is the plan. Where it and this brief differ, the plan
  wins.
- The follow-up note in [P4-11](P4-11-chunk-sync-sdks.md) and P5-08's "Not done here".
- `packages/worker/test/transcripts/` (`format.ts`, `recorder.ts`, `scenarios/`).
- The blob code: `blobResponse` in `packages/worker/src/core/blobs.ts`, and
  `packages/worker/test/packTransports.test.ts` (`stage()`, `access()`).
- Every replayer, as listed in `packages/docs/src/content/docs/contribute/corpus.md` under
  "HTTP transcripts".

## Scope

**In:**

- The `chunkRange` action and `content-range` in the transcript format.
- The new scenario, `packs-chunk-range`.
- The registry proof.
- The five replayer mappings, each with a doctored case.
- The internal visibility changes the plan names (React `browserObjectFetch`, Swift
  `PacksClient.fetchObject`).
- The regenerated parity docs page.

**Out:**

- Any Worker source, client-core source or contract change.
- The Kotlin mapping, which belongs to P6-08 unless P6-08 has merged first.
- A binary-body transcript format.

## Steps

1. Branch from main after the plan PR has merged.
2. Implement plan §4–§6, then run `pnpm build && pnpm gen transcripts`.
3. Run plan §9's acceptance commands, then the full green gate.
4. Report to the lead. The lead reviews, merges and sets the status.

## Acceptance

- [x] `pnpm gen transcripts --check` passes. The only new files are
      `packs-chunk-range.json` and its Swift and Godot mirrors. Existing transcripts are
      byte-identical.
- [x] `pnpm parity:check` passes with `packs.apply.chunk` proven by its transcript in Node,
      React, Python, Swift and Godot (and Kotlin, below).
- [x] Each of the five replayers passes the transcript and fails its doctored `content-range`
      case.
- [x] Kotlin's `:conformance:test` passes. Per the owner's approval of the plan, P6-08 (merged
      into this branch) implements `packs.apply.chunk`, so Kotlin replays the transcript instead
      of skipping it, with the same doctored `content-range` case.
- [x] `pnpm --filter @polaris-key/docs gen:check` passes, and the full green gate passes.
