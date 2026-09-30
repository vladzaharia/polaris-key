# S-03 Spike: chunk size and reuse on real Diceroll PCK history

| Field       | Value                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                                                                               |
| Size        | 0.5–0.75 engineer-weeks                                                                                                                                                 |
| Depends on  | none                                                                                                                                                                    |
| Unblocks    | none in the graph; informs [P4-10](P4-10-chunk-indexes.md) (the default chunker parameters), [P4-03](P4-03-ci-patch-artifacts.md) and [P4-11](P4-11-chunk-sync-sdks.md) |
| Role        | `pkey-spike-runner`                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                      |
| Gates       | none beyond `pnpm format` on the files it adds                                                                                                                          |
| Human input | read access to `vladzaharia/diceroll` releases (a token that can download its release assets)                                                                           |
| Repo        | `vladzaharia/polaris-key` (reads `vladzaharia/diceroll` release assets; writes nothing there)                                                                           |

## Goal

A research note, `notes/S-03-chunk-size-real-history.md`, reports what each patch strategy costs on
five to ten **real** Diceroll releases, for both the previous-version case (N−1→N) and the
any-older-version case (N−2, N−5 and the oldest→N). It compares file-aware FastCDC at 16, 32, 64
and 128 KiB average, plain FastCDC at 64 KiB, per-entry and whole-file `zstd --patch-from`, and a
full zstd download. For each it gives bytes to download, index size, request runs and chunk bundles
touched. It recommends the default `chunks.params` for P4-10 and confirms or changes the planner's
size thresholds (full under 4 MiB, chunk sync from about 16 MiB).

## Why

Chunker parameters are recorded per release and history is never re-chunked
([CONTENT §11](../../CONTENT.md#11-server-side-by-service), CI tooling), so the default has to be
right before P4-10 ships. The only evidence so far is one synthetic pair: file-aware 64 KiB
downloaded 985 KB, and 16 KiB saved only 5% more at 1.8× the index size
([notes/A6 §2.3](../../notes/A6-godot-patching.md#23-chunk-based-reassembly-e8s-thin-client);
[CONTENT §17](../../CONTENT.md#17-open-questions-and-spikes) Q3). The design sketch already assumes
`chunking: { alg: fastcdc, avg: 65536, fileAware: true }`
([README §3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative)). Real history
adds effects the synthetic pair lacks: clean re-imports rewrite some files (A6 found
`.godot/uid_cache.bin` differs), engine bumps, and a much larger pack (~73 MB, notes/A4 §2.1). The
any-older-version advantage of chunk sync over pairwise deltas was argued, not measured
([notes/A6 §7](../../notes/A6-godot-patching.md#7-what-could-not-be-re-run-and-limits)).

## Read first

- `AGENTS.md` and `.claude/agents/pkey-spike-runner.md`.
- [CONTENT §8](../../CONTENT.md#8-patching) (ladder, planner, request weight, rule of thumb) and [§9](../../CONTENT.md#9-formats) (`pkey-chunks/1`, files index).
- [notes/A6 §2.3](../../notes/A6-godot-patching.md#23-chunk-based-reassembly-e8s-thin-client) and [§3](../../notes/A6-godot-patching.md#3-method--pack-type-matrix); [notes/A7 §3.1](../../notes/A7-xlang-content.md#31-pkey-chunks1-binary-little-endian) and [§4](../../notes/A7-xlang-content.md#4-install-planner-language-neutral-specification) (index format, run grouping, planner).
- [notes/E8 §2.4–§2.5](../../notes/E8-content-delivery.md#25-cloudflare-and-r2-facts-that-constrain-the-chunk-transport) and [§6](../../notes/E8-content-delivery.md#6-open-questions-to-verify-before-building) Q6.
- [notes/A4 §1.2](../../notes/A4-diceroll-mapping.md#12-manifest-schema-1) and [§1.13](../../notes/A4-diceroll-mapping.md#113-export-presets-that-matter): the release carries `Diceroll-<v>-desktop.pck`, exported from the S3TC-only Linux preset.
- Code to reuse: `prototype/patching/tools/` (`pck.py`, `fastcdc.js` with `FASTCDC_SEGMENTS` for
  file-aware mode, `chunk_rerun.py`, `pckdiff.py`, `manifest.py`) and `prototype/content/gen/`
  (`gen.py` emits real `pkey-chunks/1` indexes and chunk bundles; `planref.py` is the reference
  planner).

## Scope

**In:**

- Download `Diceroll-<v>-desktop.pck` from five to ten tagged releases with `gh release download`
  (skip the rolling `channels` release). Record version, engine, size and entry count of each.
- If time allows, a second texture family: the PCK inside the web zip or the Android APK.
- Generalise `chunk_rerun.py` from one pair to a version list and to the pairs above.
- Per pair and chunker: missing chunks, missing raw bytes, missing bytes as zstd-per-chunk, the
  real `pkey-chunks/1` size (64 + 48 × (chunks + bundles) bytes), request runs under the shared
  run-grouping rule, and bundles touched at 4, 8 and 16 MiB bundle sizes.
- Per pair: per-entry and whole-file `--patch-from` sizes (zstd CLI 1.5.x at `-19`, window at least
  the larger file) and the full zstd size; the plan `planref.py` chooses at request weights of
  16 KiB and 64 KiB.
- Per release: how many changed entries changed only because of re-import noise (same source,
  different bytes), from `pckdiff.py` plus the release's commit range.

**Out** (and where it belongs instead):

- CI chunking and chunk bundles (→ P4-10); per-entry deltas in CI (→ P4-03); chunk sync in SDKs
  (→ P4-11).
- Any change to Diceroll's repo or releases (read-only here; → D-04).
- Measuring on devices (→ S-04).

## Design notes

- **Privacy.** Diceroll's assets are private inputs (age-encrypted in its CI, notes/A4 §4.2). Commit
  scripts and aggregate numbers only: no PCK, no extracted file, no chunk data, no file paths
  beyond directory prefixes. Add the working directory to `.gitignore` and `.prettierignore`, as
  `prototype/patching/out/` is.
- **Same chunker everywhere.** Use `fastcdc.js` as it is (its gear table is fixed and shared with
  the GDScript port); record its parameters (`min = avg/4`, `max = avg×4`, normalised level 1).
- Count index bytes with the real binary format, not A6's 40 B/chunk estimate.
- The request weight and run rule are the planner's (CONTENT §8.1: 16 KiB default). Report the
  choice at 64 KiB too, since high-latency and background sessions raise it.
- Keep "first install" separate: a full download plus recording the seed index (CONTENT §8.1).
- The desktop PCK is one ~73 MB container of everything. Where useful, also slice it by the
  proposed pack prefixes (notes/A4 §2.3 stages: `ui`, `core3d`, `audio`, `foes`, `nature`,
  `extra`) to estimate per-pack results; say that this is an estimate.

## Steps

1. Get the token from the human; list releases; download the desktop PCKs into a git-ignored
   directory.
2. Run `pckdiff.py` across consecutive releases; classify changes (content, re-import noise,
   engine bump).
3. Run the chunker matrix and the delta sizes for every pair; build real indexes and bundles with
   `gen.py`-derived code for the chosen candidates.
4. Run `planref.py` on each pair's menu at both request weights.
5. Write the note and `prototype/chunk-history/README.md`.

## Acceptance criteria

- [ ] `notes/S-03-chunk-size-real-history.md` exists with the provenance blockquote, question,
      short answer, method, environment, results, recommendation, affected briefs and sources, with
      evidence tags.
- [ ] One table per pair class (N−1, N−2, N−5, oldest) with every chunker and delta row: bytes,
      index bytes, request runs, bundles touched per bundle size.
- [ ] The recommendation gives the default `chunks.params` (algorithm, average, min, max,
      file-aware), a bundle size, and whether the 4 MiB / 16 MiB thresholds stand; each backed by a
      row in the tables.
- [ ] The re-import-noise finding is quantified and, if material, turned into a proposed rule for
      P4-03 (CI determinism or lint).
- [ ] `prototype/chunk-history/` holds the scripts and a README; `git status` shows no Diceroll
      bytes committed.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm format
git status --porcelain docs/research/2026-09-29-godot-omniplatform/prototype/chunk-history/  # scripts only
```

## Hand-off

P4-10 takes the default chunker parameters and bundle size, which it writes into the release
record's `chunks.params` and never changes for history. P4-03 takes any CI determinism rule. P4-11
and the planner corpus (`plan-matrix.json`) take the request-weight observations. If the answer
differs from the README §3.12 sketch, propose the edit in the report. Set the status with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set S-03 done`.
