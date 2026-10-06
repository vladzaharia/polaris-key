# SP-26 Godot updater feed URLs (`update.feeds`): App Installer and zsync feeds, the Velopack `releases.<velopackChannel>` file, the channel-alias rewrite and the typed `unsupported (product)`, replaying `feed-url-matrix.json`

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                               |
| Size        | 0.5–0.8 engineer-weeks                                                                  |
| Depends on  | [P3-09](P3-09-updater-feeds.md)                                                         |
| Unblocks    | none                                                                                    |
| Role        | `pkey-godot-engineer`                                                                   |
| Plan mode   | no                                                                                      |
| Gates       | the Godot runner with `feed-url-matrix.json`; `parity:check`; the generated parity page |
| Human input | none                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                               |

## Goal

`PKeyUpdater.feed_url(kind)` answers every row of `feed-url-matrix.json`: appcast, WinSparkle and the Velopack feed directory as today, plus App Installer and zsync, the Velopack `releases.<velopackChannel>` file, the channel-alias rewrite, and the typed `unsupported (product)` when discovery's `update.endpoints` has no template.

## Why

The updater builds three of the five feeds for this build's channel; the matrix expects all five, aliases and the typed refusal. The parity rows it owns: `update.feeds` in `sdks/godot/parity.json`; their `note` fields give the current state. It absorbs the parity note's the Godot half of §3.7 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.7.
- `PKeyUpdater.feed_url`, `PKeyDiscovery.appcast_url_from`.
- `conformance/corpus/v2/feed-url-matrix.json`; Node's `client.update.feedUrl(kind)` (commit 44bbbe6f6: a Velopack template without `releases.` is unsupported).

## Scope

**In:**

- The two missing kinds, the Velopack channel file, the alias rewrite and the typed refusal.
- A corpus suite over the matrix.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Installing through those feeds (P3-10's drivers).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- Build from discovery's templates only; never hard-code a host.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature update.feeds` tests run every `feed-url-matrix.json` row.
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

- Desktop export presets point at these URLs.

The role agent sets `--set SP-26 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-26 done`.
