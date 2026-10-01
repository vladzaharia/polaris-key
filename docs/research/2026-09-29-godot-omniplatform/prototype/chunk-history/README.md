# chunk-history: chunk size and reuse on real Diceroll release history (S-03)

The harness behind [notes/S-03](../../notes/S-03-chunk-size-real-history.md). It costs every
patch strategy on Diceroll's tagged releases: file-aware FastCDC at 16/32/64/128 KiB, plain FastCDC
at 64 KiB, whole-file and per-entry `zstd --patch-from`, the `file` strategy and a full zstd
download. It does this for every ordered pair of releases (N−1, N−2, N−3 and oldest→latest), with
the real `pkey-chunks/1` size, the planner's request-run rule and chunk bundles of 4, 8 and 16 MiB.
Bundles are laid out two ways: fresh per release, or shared across one deliverable's history.

**Privacy.** Diceroll's assets are private inputs. Everything downloaded or derived (PCKs, the APK
asset tree, recipes, indexes, deltas, per-file results) goes under `data/`, which is git-ignored
here and listed in the root `.prettierignore`. The scripts print aggregates and directory prefixes
only. Commit scripts and numbers, never anything from `data/`.

## Reused code

| From                                                                | Used for                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `../patching/tools/pck.py`                                          | reading PCK v4 directories                                              |
| `../patching/tools/fastcdc.cjs` (unchanged; `FASTCDC_SEGMENTS`)     | every chunk recipe, so the gear table is the one the GDScript port uses |
| `../content/gen/gen.py` (`segments`, `build_index`, bundle packing) | re-implemented in `hist.py` with the bundle target as a parameter       |
| `../content/runners/python/pkey_content.py` (`plan`)                | the planner's choice for every pair                                     |

`../patching/tools/chunk_rerun.py` and `pckdiff.py` are generalised here from one v1/v2 pair to a
release list (`matrix.py`, `noise.py`).

## Requirements

- `gh` with read access to `vladzaharia/diceroll` release assets (to download).
- A read-only Diceroll checkout for commit ranges (`DICEROLL_REPO`, default `~/Repos/diceroll`).
- Python ≥ 3.14 (stdlib `compression.zstd`; no venv needed), zstd CLI ≥ 1.5, Node 22
  (`mise exec node@22`; `NODE` overrides).

## Run

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype/chunk-history
# 1. download (skip the rolling `channels` release)
for t in $(gh release list -R vladzaharia/diceroll --limit 50 --json tagName -q '.[].tagName' | grep '^v'); do
  d=data/rel/${t#v0.1.0-}; mkdir -p $d
  gh release download $t -R vladzaharia/diceroll -D $d \
    -p '*-desktop.pck' -p '*-web.zip' -p '*-android.apk' -p '*-build-manifest.json' -p 'SHA256SUMS.txt'
done
# 2. inventory (verifies SHA256SUMS), change classification, matrix, per-pack estimate, tables
python3 inventory.py
python3 noise.py desktop
python3 matrix.py desktop          # ~10 min on an 18-core M5 Pro; most of it is whole-file --patch-from
python3 matrix.py android          # the APK's assets/ tree (ETC2/ASTC); PAIRS=adjacent limits it to N-1 pairs + oldest
python3 packs.py                   # per-pack slices of the desktop PCK (an estimate)
python3 indexdelta.py desktop      # index raw, as zstd, and as --patch-from of the seed index
python3 report.py desktop android  # the note's tables
```

Everything is cached under `data/out/` (recipes, per-chunk stored sizes keyed by SHA-256, full
blobs, deltas), so re-runs are fast. Delete `data/out/` to measure from scratch.

## Files

| File            | What it does                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `hist.py`       | releases, payload families, file-aware segments, recipes, per-chunk zstd -19, bundle layouts, index size, run rule       |
| `inventory.py`  | per release: version, engine, commit, asset lock, payload bytes and entries; checks `SHA256SUMS.txt`                     |
| `noise.py`      | consecutive-release diff classified as content, version stamp, order-only cache rewrites, or other re-import noise       |
| `matrix.py`     | every pair × every strategy, plus the planner's choice at request weights 16/64 KiB and memory budgets 256/64 MiB        |
| `packs.py`      | the same for the desktop PCK sliced into the proposed packs (base, ui, core3d, audio, foes, nature, extra)               |
| `indexdelta.py` | the target chunk index raw, as one zstd frame, and as a `--patch-from` frame against the seed index                      |
| `report.py`     | prints the note's tables, including the per-pack every-pair table: CONTENT §8.2's rule vs a chunk index, N−1 deltas only |

## Definitions

- **Chunkers.** FastCDC 2016, normalised level 1, `min = avg/4`, `max = avg×4`, as in
  `fastcdc.cjs`. File-aware = one FastCDC run per segment (gap, entry, gap, …), `fileAware` bit set.
  `fa32m`/`fa64m` add the padding rule: a gap shorter than 64 B right after an entry joins that
  entry's segment (header, directory and longer gaps stay separate).
- **Stored size** of a chunk: one zstd -19 frame, or raw when that is not smaller (gen.py's rule).
- **Index bytes:** `64 + 48 × (records + bundles referenced)`, the real `pkey-chunks/1` size.
- **Bundles.** Unique chunks in first-use order, packed until the next one would pass the target
  (gen.py's rule). _Fresh_: every release packs all its chunks anew. _Shared_: a release's new
  bundles hold only chunks no earlier release stored; its index points old chunks at old bundles.
  Repacking of bundles below 50% live data (CONTENT §11) is not modelled; five releases never get
  near it.
- **Requests** = 1 (the index) + request runs; a run continues while the next fetched chunk is in
  the same bundle, directly after the previous fetched one (A7 §4.3; `pkey_content.plan`).
- **Per-entry delta:** files index + gaps blob (zstd -19) + one `zstd -19 --patch-from` frame per
  changed entry (or its zstd blob when smaller) + a zstd blob per new entry.
- **Android family:** every file under `assets/` in the APK, in path order, chunked per file (a
  `layout: tree` payload). Its "full" is zstd -19 of that concatenation.
