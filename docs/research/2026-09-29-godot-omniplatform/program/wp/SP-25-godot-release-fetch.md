# SP-25 Godot verified download (`release.fetch`): a public fetch API over `PKeyDownload`, If-Range on resume, and the `releaseFetch` mapping in `suite_transcripts`

| Field       | Value                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                            |
| Size        | 0.4–0.6 engineer-weeks                                                               |
| Depends on  | none                                                                                 |
| Unblocks    | none                                                                                 |
| Role        | `pkey-godot-engineer`                                                                |
| Plan mode   | no                                                                                   |
| Gates       | the Godot runner with `suite_transcripts`; `parity:check`; the generated parity page |
| Human input | none                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                            |

## Goal

`PKeyCore.release.fetch(target, to)` downloads a build with the device bearer, resumes with `Range` and `If-Range`, checks size and SHA-256 and maps the 401 body code; the updater's sidecar and APK paths use it; `suite_transcripts` maps `releaseFetch` and replays `release-fetch-gated.json`.

## Why

`core/download.gd` streams with Range resume and the updater verifies, but there is no public call and a resume sends no `If-Range`. The parity rows it owns: `release.fetch` in `sdks/godot/parity.json`; their `note` fields give the current state. It absorbs the parity note's the Godot half of §3.6 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.6.
- `sdks/godot/addons/polaris_key/core/download.gd`; the updater.
- `conformance/transcripts/release-fetch-gated.json`; Node's `client.release.fetch`.

## Scope

**In:**

- The public API and `If-Range`.
- The updater on the shared path.
- The transcript mapping.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Feed URLs (→ SP-26).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- Keep the redirect-auth rule: the bearer never follows a cross-origin redirect (Godot's measured redirect leak).

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature release.fetch` replays all three steps of `release-fetch-gated.json`.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- SP-26 and the updater use the public fetch.

The role agent sets `--set SP-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-25 done`.
