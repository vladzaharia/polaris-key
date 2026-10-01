> Research note for [Godot on Polaris Key](../README.md), 2026-09-30.
> A working paper kept for its evidence and sources; the README synthesis is the cross-checked position.

# S-03: Chunk size and reuse on real Diceroll PCK history

Run 2026-09-30 on every tagged Diceroll release (five). The harness is
[`prototype/chunk-history/`](../prototype/chunk-history/README.md). It reuses A6's PCK reader and
`fastcdc.cjs` unchanged, gen.py's segment, index and bundle rules, and the reference planner in
`prototype/content/runners/python/pkey_content.py`. No Diceroll bytes, file names or chunk data are
committed. Directory prefixes and Godot's own engine file names appear below; game file names do
not.

Evidence markers: **[M]** measured here, **[V]** primary source read raw, **[S]** summary of
another note, **[I]** inference. Every result row is also labelled **measured**, **emulated** or
**unmeasured** in §8.

## 1. Question

CONTENT §17 Q3 and P4-10 need the default `chunks.params`. They are recorded per release and never
re-chunked, so the default has to be right before P4-10 ships. The questions:

- Which chunker and average size should the default be?
- Which bundle size and bundle layout?
- Does CONTENT §8.2's rule of thumb stand ("full under 4 MiB; full plus one delta for small packs
  that change every release; chunk sync from about 16 MiB up")?

The only evidence so far was A6's single synthetic 36 MiB pair. This note measures real release
history, for both the previous version (N−1) and older versions (N−2 and beyond, and oldest→latest).

## 2. Short answer

1. **Chunk size barely matters. The per-entry index records do.** On the real 85 MB PCK, the
   file-aware averages 16, 32, 64 and 128 KiB land within 5% of each other in every pair class (N−1
   means 1.39–1.47 MB). The index is 45% of those bytes, and it is sized by the ~6,700 entries, not
   by the average. Half its records are the exporter's **alignment-padding gaps** (1–15 bytes after
   each entry), each chunked as its own segment. [M]
2. **Default:** FastCDC 2016, normalised level 1, file-aware, plus one new segmentation rule: **a
   gap shorter than 64 bytes joins the entry before it**. That rule halves the index (655 → 350 KB)
   and cuts the mean N−1 chunk-sync download by 21% (1.44 → 1.13 MB). It changes no missing-byte
   count and no request count, and a chunk still never spans two entries. [M] The best average
   depends on how the index travels (item 7), so P4-10's plan must settle that before it freezes
   `avgSize` (§4.7, cost table). Percentages are at the 16 KiB request weight:
   - **Index sent raw or as one zstd frame: average 64 KiB** (minimum 16, maximum 256 KiB; the
     sketch's value). 32 KiB is 3.7–4.4% cheaper at N−1, even at N−2 (0.2–0.5%), and 2.2–2.5%
     dearer from N−3 on. [M]
   - **Index sent as a delta of the seed index: average 32 KiB** (minimum 8, maximum 128 KiB). The
     index term then shrinks to 1.4–9 KB at any average, which leaves only missing bytes and
     requests. 32 KiB is **9.7% cheaper at N−1** (741 KB against 821 KB) and 2.2% cheaper at N−2.
     It is 1.4–1.5% dearer at N−3 and oldest. At a 64 KiB weight the N−1 gain is the same 80 KB
     (8.7%), but from N−2 on 32 KiB is 1.7–5.5% dearer (58–335 KB), because it needs more request
     runs. 16 KiB is cheaper still at N−1 (708 KB), but 2.4–2.6% dearer from N−3 on, and its seed
     index is larger (fa16 with the padding rule was not measured). N−1 is the update that mobile
     clients run as chunk sync (item 4), so 32 KiB is the better default unless installs two or
     more releases behind are common on high-latency links. [M]/[I]
3. **Bundles:** share them across one deliverable's history, with new chunks only in each release's
   new bundles, and target **4 MiB**. With shared bundles an N−1 sync is **2 requests** (index plus
   one run); fresh-per-release bundles need 42. The 4, 8 and 16 MiB targets give identical request
   counts in every pair class, because each release's new chunks (0.4–1 MB) fit in one bundle. The
   choice within 4–16 MiB can therefore follow S-02's cache behaviour with no byte cost. [M]
4. **Pairwise deltas still win when they exist and fit in memory.** A whole-file `--patch-from`
   costs 0.57 MB at N−1 and 1.34 MB at oldest→latest, half to two-thirds of chunk sync. It needs
   about 170 MB of decoder memory for this pack, though. At a 64 MiB budget the planner picks chunk
   sync in every pair, and for pairs CI never built a delta for, chunk sync is the only incremental
   path. Full (63.2 MB) never wins for the whole PCK. [M]
5. **The rule of thumb's 16 MiB clause fails on a real pack; its other two clauses are untested.**
   CONTENT §8.2 has three clauses: full under 4 MiB; full plus one delta for small packs that change
   every release; chunk sync from about 16 MiB up. Sliced by the proposed packs (§4.10, an
   estimate), only one content pack changed in this history:
   - **extra** (11.6 MB full, changed once) falls between 4 and 16 MiB, so the rule gives it no
     chunk index. In 5 of 10 pairs the install has no N−1 delta to use, and the rule sends
     11.6 MB where chunk sync sends **83 KB in 2 requests**. An SDK without delta support gets
     11.6 MB under the rule even at N−1 (rc.2→rc.3), against 83 KB by chunk sync. [M]
   - The only content pack under 4 MiB, **ui** (1.0 MB full), never changed. So neither the 4 MiB
     clause nor the "full plus one delta" clause was tested on a real pack. [M]
   - The **base** slice is not a content pack. It is the app's main PCK, which ships inside the
     binary (notes/A4 §2.3, stage 0). It appears here only as an **[I] proxy** for a small pack
     that changes every release (`l10n` or `events`, say). Under the rule the proxy gets its N−1
     delta (0.29–0.72 MB), which is cheaper than chunk sync. From N−2 on it gets full (3.65–3.83
     MB), where a chunk index costs 0.95–1.42 MB in 9–75 requests. The planner takes chunk in all
     6 older pairs at the 16 KiB weight, and in 2 of 6 at 64 KiB. These are [M] on the slice and
     [I] as a pack.

   Proposed: drop the 16 MiB clause, and publish a chunk index plus the N−1 delta for container
   packs in the 4–16 MiB band too (measured on extra). Lowering the floor from 4 MiB to 1 MiB rests
   only on the main-PCK proxy. It is an inference until a real small pack that changes is
   measured. [M]/[I]

6. **Re-import noise exists but is small.** Three of four releases rewrote Godot's order-insensitive
   caches in a new order (`.godot/uid_cache.bin` and `.godot/global_script_class_cache.cfg`, 232–238
   KB raw). Every release gave one hand-written scene a fresh random UID (4 bytes). In chunk-sync
   bytes that is **0–5% of an N−1 update** (0–46 KB). It is worth a warn-only publish lint in P4-03,
   not a gate. [M]
7. **Two cheap wins outside the chunk parameters.** First, store the `pkey-files/1` index as a zstd
   frame: 1.37 MB raw → 0.34 MB. The raw JSON is 64% of today's per-entry-delta and `file` bytes.
   That changes the signed `files` reference, so it is a plan question for P4-01.
   Second, and larger, send the target chunk index as a `--patch-from` delta against the seed index
   the client already holds: **350 KB → 1.4–9 KB** (both [M]). That would make N−1 chunk sync about
   0.79 MB at 64 KiB (0.71 MB at 32 KiB), near the whole-file delta and without its memory cost.
   It is a wire addition, proposed for P4-10's plan (§5, §7). If it is adopted, the default average
   moves to 32 KiB (item 2).

## 3. Method

### 3.1 Environment [M]

| Item          | Value                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host          | Apple M5 Pro (18 cores), 64 GB RAM, macOS 27.0 (26A428). The host was shared with other agents at load averages of 500–1,000, so the timings in `data/out` are not reported as results. Byte counts are deterministic for a given zstd version and do not depend on the load. |
| Region        | none: every step is offline, on local files                                                                                                                                                                                                                                   |
| zstd          | CLI v1.5.7 (full blobs, whole-file and per-entry `--patch-from`); libzstd via Python 3.14.6 `compression.zstd` (per-chunk frames, index compression, index deltas)                                                                                                            |
| Node          | 22.13.1 (`mise exec node@22`), running `prototype/patching/tools/fastcdc.cjs` unchanged                                                                                                                                                                                       |
| Godot         | 4.7.2 in every release (build manifests, PCK headers). The history has no engine bump.                                                                                                                                                                                        |
| Planner       | `pkey_content.plan` from `prototype/content/runners/python/` (the function `planref.py` drives)                                                                                                                                                                               |
| Diceroll repo | read-only local checkout, `git diff --name-only` between tags; release assets via `gh release download`                                                                                                                                                                       |

### 3.2 Inputs [M]

All tagged releases (the rolling `channels` release was skipped). Each asset was verified against
its release's `SHA256SUMS.txt`.

| Release    | Published (UTC)  | Godot | Desktop PCK B | Entries | Full zstd -19 B | Commits since previous | Source files changed |
| ---------- | ---------------- | ----- | ------------: | ------: | --------------: | ---------------------: | -------------------: |
| 0.1.0-rc.1 | 2026-09-29 11:54 | 4.7.2 |    84,789,584 |   6,624 |      62,743,560 |                      — |                    — |
| 0.1.0-rc.2 | 2026-09-29 15:45 | 4.7.2 |    84,806,720 |   6,624 |      62,761,262 |                     13 |                   21 |
| 0.1.0-rc.3 | 2026-09-29 17:41 | 4.7.2 |    85,253,008 |   6,709 |      63,013,757 |                     22 |                  142 |
| 0.1.0-rc.4 | 2026-09-29 22:40 | 4.7.2 |    85,434,364 |   6,733 |      63,185,487 |                     14 |                   71 |
| 0.1.0-rc.5 | 2026-09-30 02:09 | 4.7.2 |    85,439,036 |   6,733 |      63,193,886 |                      7 |                   45 |

Every PCK is version 4, flags 2 (relative file base), 16-byte alignment. The desktop PCK is 85 MB,
not the ~73 MB notes/A4 §2.1 estimated. The web zip's `index.pck` has the same size and entry
count, but different bytes. The Android APK carries the project as an `assets/` tree (6,628–6,737
files, 84.7–85.4 MB decoded) with ETC2/ASTC textures, and is the second texture family (§4.8).

**Only five tagged releases exist**, all published within 15 hours. The brief asked for five to
ten, including N−5. Here the widest pair is N−4 (rc.1→rc.5), reported as "oldest". All five share
one engine and one asset-lock generation apart from rc.2→rc.3 (one kit added). The history is
therefore script-heavy and asset-light; §9 lists what that biases.

### 3.3 What was computed

For every ordered pair of releases (10 pairs; 4 N−1, 3 N−2, 2 N−3, 1 oldest) and the desktop PCK:

- **Chunkers** (`fastcdc.cjs`: FastCDC 2016, normalised level 1, `min = avg/4`, `max = avg×4`):
  - file-aware (`FASTCDC_SEGMENTS`: gap, entry, gap, …, exactly gen.py's `segments`) at 16, 32, 64
    and 128 KiB (`fa16` … `fa128`);
  - plain at 64 KiB (`plain64`);
  - file-aware with alignment padding merged into the preceding entry at 32 and 64 KiB (`fa32m`,
    `fa64m`: a gap shorter than 64 B joins the entry before it; the header, the directory and any
    longer gap stay separate segments).
- **Per chunker:**
  - missing chunks (ids absent from the seed release's recipe), missing raw bytes, and missing
    stored bytes (one zstd -19 frame per chunk, raw when not smaller, gen.py's rule);
  - the real `pkey-chunks/1` size, `64 + 48 × (records + bundles referenced)`;
  - request runs under the planner's rule (A7 §4.3; `requests = 1 + runs`) and bundles touched;
  - both for 4, 8 and 16 MiB bundle targets and for two layouts. _Fresh_ packs every unique chunk
    of each release anew. _Shared_ puts only chunks that no earlier release stored into each
    release's new bundles, and points old chunks at old bundles (P4-10's two options).
- **Deltas** (zstd CLI 1.5.7):
  - whole-file `zstd -19 --patch-from=<old> <new>`. The CLI sets the window to cover the file: the
    frame headers say 80.9–81.5 MiB;
  - per-entry: one `--patch-from` frame per changed entry, or its blob when smaller, a zstd blob per
    new entry, plus the files index and the gaps blob (gen.py's `v1-v2-files` artifact set);
  - `file`: files index, gaps blob and the missing entries as zstd -19 blobs;
  - full: `zstd -19 <new>`.
- **Planner:** `pkey_content.plan` on each pair's menu (both deltas, chunk with shared 4 MiB
  bundles, file, full), per chunker, at request weights 16 KiB and 64 KiB and memory budgets
  256 MiB and 64 MiB. It was also run without delta support.
- **Change classification** (`noise.py`, a generalised `pckdiff.py`):
  - each changed or added entry is mapped to its source (`x.gdc` → `x.gd`;
    `.godot/imported|exported/*` → the `.import`/`.remap` entry that names it);
  - it is then classed as _content_ (source changed in `git diff` between the tags, or new),
    _stamp_ (the CI version stamp in `project.binary` and `build_info.json`), _cache_ (Godot's
    order-insensitive caches, parsed and compared as sets and as sequences), or _noise_ (same
    source, different bytes).
- **Per-pack estimate** (`packs.py`):
  - the desktop PCK is sliced by the proposed packs (Diceroll's content-streaming design §5.1,
    notes/A4 §2.3: base, ui, core3d, audio, foes, nature, extra). The mapping is entry → source →
    asset unit → pack; everything outside `assets/` goes to base;
  - file-aware chunks never cross entries, so a slice's chunks are exactly the recipe's chunks
    inside its entries. Bundles are laid out per slice;
  - a slice is its entries concatenated, without the PCK header and directory, so this is an
    **estimate** of per-pack deliverables;
  - every one of the 10 pairs is costed. The harness builds a whole-slice delta for every pair.
    The planner columns of the main table therefore assume CI published that exact pair's delta,
    oldest→latest included. The every-pair table instead models the realistic policy, an N−1 delta
    only: older pairs get the no-delta plan. It sets that against CONTENT §8.2's rule, which is
    full, or the N−1 delta for an N−1 install, with no chunk index below 16 MiB.

Commands (from `prototype/chunk-history/`; the download loop is in the README):

```sh
python3 inventory.py                 # checksums, versions, sizes, entry counts
python3 noise.py desktop             # change classification
python3 matrix.py desktop            # all 10 pairs × all strategies + planner
python3 matrix.py android            # all 10 pairs (PAIRS=adjacent: N−1 + oldest)
python3 packs.py                     # per-pack estimate
python3 indexdelta.py desktop        # index as zstd and as a delta against the seed index
python3 report.py desktop android    # the tables below
```

## 4. Results (desktop PCK, S3TC family)

Bytes are means over the pairs in a class, with the range in brackets. "Requests" counts the index
plus request runs. Bundles are shared unless a column says fresh. All rows [M].

### 4.1 N−1 (4 pairs: rc.1→rc.2, rc.2→rc.3, rc.3→rc.4, rc.4→rc.5)

| Strategy                              |           Bytes to download | Index B | Requests shared 4/8/16 MiB | Requests fresh 4 MiB | Bundles touched shared 4/8/16 | Bundles touched fresh 4/8/16 | Missing chunks | Missing stored B | Missing raw B |
| ------------------------------------- | --------------------------: | ------: | -------------------------: | -------------------: | ----------------------------: | ---------------------------: | -------------: | ---------------: | ------------: |
| chunk fa16                            |     1,448,577 (1.11–1.65 M) | 777,664 |                  2 / 2 / 2 |                   47 |                     1 / 1 / 1 |                3.2 / 2.2 / 2 |           90.5 |          670,913 |       884,068 |
| chunk fa32                            |     1,393,540 (1.04–1.60 M) | 688,948 |                  2 / 2 / 2 |                 44.2 |                     1 / 1 / 1 |                3.2 / 2.2 / 2 |             76 |          704,592 |       981,028 |
| chunk fa64                            |     1,436,900 (1.07–1.64 M) | 652,276 |                  2 / 2 / 2 |                   42 |                     1 / 1 / 1 |                3.2 / 2.2 / 2 |             69 |          784,624 |     1,233,801 |
| chunk fa128                           |     1,469,328 (1.17–1.67 M) | 637,036 |                  2 / 2 / 2 |                 40.8 |                     1 / 1 / 1 |                3.2 / 2.2 / 2 |           65.2 |          832,292 |     1,396,444 |
| chunk plain64                         |     2,016,374 (1.39–2.58 M) |  49,732 |                  2 / 2 / 2 |                   10 |                     1 / 1 / 1 |                3.2 / 3 / 2.2 |           32.8 |        1,966,642 |     2,588,489 |
| chunk fa32m                           |     1,089,673 (0.74–1.30 M) | 384,772 |                  2 / 2 / 2 |                 44.5 |                     1 / 1 / 1 |                3.2 / 2.2 / 2 |             76 |          704,901 |       981,494 |
| **chunk fa64m**                       | **1,132,951 (0.77–1.34 M)** | 348,100 |                  2 / 2 / 2 |                   42 |                     1 / 1 / 1 |                3.2 / 2.2 / 2 |             69 |          784,851 |     1,234,266 |
| delta, whole-file `--patch-from`      |       567,999 (0.30–0.74 M) |       — |                          1 |                    — |                             — |                            — |              — |                — |             — |
| delta, per-entry `--patch-from`       |     2,152,886 (1.87–2.33 M) |       — |                       61.8 |                    — |                             — |                            — |              — |                — |             — |
| delta, per-entry, files index as zstd |     1,133,513 (0.86–1.31 M) |       — |                       61.8 |                    — |                             — |                            — |              — |                — |             — |
| file, files index as zstd             |     1,181,684 (0.91–1.37 M) |       — |                       61.8 |                    — |                             — |                            — |              — |                — |             — |
| file (files index raw JSON)           |     2,201,056 (1.92–2.40 M) |       — |                       61.8 |                    — |                             — |                            — |              — |                — |             — |
| full (zstd -19)                       |                  63,038,598 |       — |                          1 |                    — |                             — |                            — |              — |                — |             — |

### 4.2 N−2 (3 pairs: rc.1→rc.3, rc.2→rc.4, rc.3→rc.5)

| Strategy                              |           Bytes to download | Index B | Requests shared 4/8/16 MiB | Requests fresh 4 MiB | Bundles touched shared 4/8/16 | Bundles touched fresh 4/8/16 | Missing chunks | Missing stored B | Missing raw B |
| ------------------------------------- | --------------------------: | ------: | -------------------------: | -------------------: | ----------------------------: | ---------------------------: | -------------: | ---------------: | ------------: |
| chunk fa16                            |     1,952,279 (1.76–2.17 M) | 780,160 |               36 / 36 / 36 |                   83 |                     2 / 2 / 2 |                3.7 / 2.7 / 2 |          175.3 |        1,172,119 |     1,507,340 |
| chunk fa32                            |     1,903,109 (1.71–2.12 M) | 691,296 |         34.7 / 34.7 / 34.7 |                   80 |                     2 / 2 / 2 |                3.7 / 2.7 / 2 |            149 |        1,211,813 |     1,635,397 |
| chunk fa64                            |     1,940,555 (1.78–2.14 M) | 654,592 |         32.7 / 32.7 / 32.7 |                 76.7 |                     2 / 2 / 2 |                3.7 / 2.7 / 2 |          136.3 |        1,285,963 |     1,909,579 |
| chunk fa128                           |     1,938,773 (1.81–2.12 M) | 639,344 |         31.3 / 31.3 / 31.3 |                 76.3 |                     2 / 2 / 2 |                3.7 / 2.7 / 2 |          130.3 |        1,299,429 |     1,972,794 |
| chunk plain64                         |     2,810,366 (2.39–3.14 M) |  49,840 |         10.7 / 10.7 / 10.7 |                  9.7 |                     2 / 2 / 2 |              3.7 / 3.7 / 2.7 |           46.7 |        2,760,526 |     3,736,522 |
| chunk fa32m                           |     1,598,525 (1.41–1.81 M) | 386,048 |         34.7 / 34.7 / 34.7 |                 80.3 |                     2 / 2 / 2 |                3.7 / 2.7 / 2 |            149 |        1,212,477 |     1,636,387 |
| **chunk fa64m**                       | **1,635,859 (1.48–1.83 M)** | 349,344 |         32.7 / 32.7 / 32.7 |                 76.7 |                     2 / 2 / 2 |                3.7 / 2.7 / 2 |          136.3 |        1,286,515 |     1,910,569 |
| delta, whole-file `--patch-from`      |     1,010,435 (0.87–1.20 M) |       — |                          1 |                    — |                             — |                            — |              — |                — |             — |
| delta, per-entry `--patch-from`       |     2,600,830 (2.46–2.79 M) |       — |                      126.3 |                    — |                             — |                            — |              — |                — |             — |
| delta, per-entry, files index as zstd |     1,578,124 (1.43–1.77 M) |       — |                      126.3 |                    — |                             — |                            — |              — |                — |             — |
| file, files index as zstd             |     1,641,587 (1.51–1.82 M) |       — |                      126.3 |                    — |                             — |                            — |              — |                — |             — |
| file (files index raw JSON)           |     2,664,294 (2.54–2.85 M) |       — |                      126.3 |                    — |                             — |                            — |              — |                — |             — |
| full (zstd -19)                       |                  63,131,043 |       — |                          1 |                    — |                             — |                            — |              — |                — |             — |

### 4.3 N−3 (2 pairs: rc.1→rc.4, rc.2→rc.5)

| Strategy                              |           Bytes to download | Index B | Requests shared 4/8/16 MiB | Requests fresh 4 MiB | Bundles touched shared 4/8/16 | Bundles touched fresh 4/8/16 | Missing chunks | Missing stored B | Missing raw B |
| ------------------------------------- | --------------------------: | ------: | -------------------------: | -------------------: | ----------------------------: | ---------------------------: | -------------: | ---------------: | ------------: |
| chunk fa16                            |     2,243,462 (2.22–2.27 M) | 780,952 |               79 / 79 / 79 |                  105 |                     3 / 3 / 3 |                    4 / 3 / 2 |          233.5 |        1,462,510 |     1,863,602 |
| chunk fa32                            |     2,191,784 (2.17–2.22 M) | 692,056 |               75 / 75 / 75 |                  103 |                     3 / 3 / 3 |                    4 / 3 / 2 |            198 |        1,499,728 |     1,997,139 |
| chunk fa64                            |     2,213,935 (2.19–2.24 M) | 655,336 |               69 / 69 / 69 |                   99 |                     3 / 3 / 3 |                    4 / 3 / 2 |            183 |        1,558,599 |     2,246,406 |
| chunk fa128                           |     2,197,662 (2.17–2.22 M) | 640,072 |               65 / 65 / 65 |                  100 |                     3 / 3 / 3 |                    4 / 3 / 2 |            176 |        1,557,590 |     2,246,406 |
| chunk plain64                         |     3,137,454 (3.14–3.14 M) |  49,912 |               18 / 18 / 18 |                    9 |               2.5 / 2.5 / 2.5 |                    4 / 4 / 3 |             53 |        3,087,542 |     4,235,874 |
| chunk fa32m                           |     1,887,134 (1.86–1.91 M) | 386,488 |               75 / 75 / 75 |                  103 |                     3 / 3 / 3 |                    4 / 3 / 2 |            198 |        1,500,646 |     1,998,497 |
| **chunk fa64m**                       | **1,909,124 (1.88–1.94 M)** | 349,768 |               69 / 69 / 69 |                   99 |                     3 / 3 / 3 |                    4 / 3 / 2 |            183 |        1,559,356 |     2,247,764 |
| delta, whole-file `--patch-from`      |     1,274,084 (1.25–1.30 M) |       — |                          1 |                    — |                             — |                            — |              — |                — |             — |
| delta, per-entry `--patch-from`       |     2,866,079 (2.84–2.89 M) |       — |                        172 |                    — |                             — |                            — |              — |                — |             — |
| delta, per-entry, files index as zstd |     1,842,362 (1.82–1.87 M) |       — |                        172 |                    — |                             — |                            — |              — |                — |             — |
| file, files index as zstd             |     1,900,112 (1.87–1.93 M) |       — |                        172 |                    — |                             — |                            — |              — |                — |             — |
| file (files index raw JSON)           |     2,923,830 (2.90–2.95 M) |       — |                        172 |                    — |                             — |                            — |              — |                — |             — |
| full (zstd -19)                       |                  63,189,686 |       — |                          1 |                    — |                             — |                            — |              — |                — |             — |

### 4.4 Oldest → latest (rc.1→rc.5, N−4)

| Strategy                              | Bytes to download | Index B | Requests shared 4/8/16 MiB | Requests fresh 4 MiB | Bundles touched shared 4/8/16 | Bundles touched fresh 4/8/16 | Missing chunks | Missing stored B | Missing raw B |
| ------------------------------------- | ----------------: | ------: | -------------------------: | -------------------: | ----------------------------: | ---------------------------: | -------------: | ---------------: | ------------: |
| chunk fa16                            |         2,306,372 | 780,928 |               89 / 89 / 89 |                  107 |                     4 / 4 / 4 |                    4 / 3 / 2 |            242 |        1,525,444 |     1,926,903 |
| chunk fa32                            |         2,254,765 | 692,176 |               85 / 85 / 85 |                  105 |                     4 / 4 / 4 |                    4 / 3 / 2 |            208 |        1,562,589 |     2,060,440 |
| chunk fa64                            |         2,276,595 | 655,360 |               79 / 79 / 79 |                  101 |                     4 / 4 / 4 |                    4 / 3 / 2 |            191 |        1,621,235 |     2,309,707 |
| chunk fa128                           |         2,260,321 | 640,096 |               75 / 75 / 75 |                  102 |                     4 / 4 / 4 |                    4 / 3 / 2 |            184 |        1,620,225 |     2,309,707 |
| chunk plain64                         |         3,139,480 |  49,888 |               22 / 22 / 22 |                    9 |                     3 / 3 / 3 |                    4 / 4 / 3 |             52 |        3,089,592 |     4,238,210 |
| chunk fa32m                           |         1,950,175 | 386,608 |               85 / 85 / 85 |                  105 |                     4 / 4 / 4 |                    4 / 3 / 2 |            208 |        1,563,567 |     2,061,865 |
| **chunk fa64m**                       |     **1,971,841** | 349,792 |               79 / 79 / 79 |                  101 |                     4 / 4 / 4 |                    4 / 3 / 2 |            191 |        1,622,049 |     2,311,132 |
| delta, whole-file `--patch-from`      |         1,335,159 |       — |                          1 |                    — |                             — |                            — |              — |                — |             — |
| delta, per-entry `--patch-from`       |         2,927,042 |       — |                        180 |                    — |                             — |                            — |              — |                — |             — |
| delta, per-entry, files index as zstd |         1,903,343 |       — |                        180 |                    — |                             — |                            — |              — |                — |             — |
| file, files index as zstd             |         1,962,842 |       — |                        180 |                    — |                             — |                            — |              — |                — |             — |
| file (files index raw JSON)           |         2,986,541 |       — |                        180 |                    — |                             — |                            — |              — |                — |             — |
| full (zstd -19)                       |        63,193,886 |       — |                          1 |                    — |                             — |                            — |              — |                — |             — |

### 4.5 Reading the tables

- **Average size.**
  - Missing stored bytes grow with the average: 0.67 → 0.83 MB at N−1, 16 → 128 KiB. The index
    shrinks: 778 → 637 KB.
  - The sum is flat within 5% in every class. fa32 is the minimum everywhere by 1–3%.
  - With request weight counted, the order flips at older pairs. At w = 16 KiB, oldest→latest
    fa64m costs 1,971,841 + 79 × 16,384 = 3.27 M, and fa32m costs 1,950,175 + 85 × 16,384 =
    3.34 M. [M]
  - All of this assumes the client downloads the raw index. Sent as a delta of the seed index, the
    index term almost vanishes and 32 KiB wins at N−1 by ~10% (§4.7, cost table). [M]

- **Where the index goes.** Records per release at fa64 are 13,628 for 7,196 unique chunks. 6,366
  records are the 1–15-byte alignment gaps after entries: 15 distinct ids repeated thousands of
  times, each 48 bytes. The only other gaps are the 112-byte header and the 680,172-byte
  directory. Merging them into the preceding entry leaves 7,262 records
  (fa64m) and changes nothing else. The missing-stored columns of fa64 and fa64m agree to within
  0.1%. [M]
- **Plain vs file-aware.**
  - Plain 64 KiB has a tiny index (50 KB, 1,016 records) but downloads 2.5× the missing bytes. At
    N−1 it is still 1.8× fa64m; at oldest it is 1.6×.
  - A6's finding that file-aware halves the missing bytes holds on real history.
  - Plain's advantage is request count at older pairs: 22 vs 79 at oldest. At a 64 KiB weight that
    is worth 3.7 MB, more than its byte penalty (1.17 MB). The planner would prefer a plain-64 menu
    for very old installs on high-latency links; it cannot have both, since there is one chunker
    per release. [M]/[I]
- **The directory.** The PCK directory (680 KB, one gap segment) changes in every release because
  600–1,383 entry offsets move. At fa64 it costs 121–243 KB of each N−1 update, at fa16 41–173 KB
  (§4.6). A smaller average for the directory segment alone would save roughly 100 KB per update.
  That option was not measured, because it needs a per-segment average that `fastcdc.cjs` lacks.
  [M]/[I]
- **Bundles.**
  - With shared bundles, every release's new chunks (0.4–1 MB) land contiguously in one new bundle,
    so an N−1 sync is always 2 requests and 1 bundle, at any target.
  - Older pairs collect the still-live chunks of each intermediate release's bundle: 2 bundles at
    N−2, 3 at N−3, 4 at oldest. Their request counts (31–89) come from chunks in those bundles
    that later releases superseded, not from the bundle target: the counts are identical at 4, 8
    and 16 MiB.
  - Fresh bundles scatter each release's changed chunks through ~20 bundles of the full payload:
    41–47 requests at N−1. [M]
- **Deltas.**
  - The whole-file delta is 52% (N−1) to 68% (oldest) of the best chunk row. It needs
    `memBytes` ≈ 170 MB, so it drops out at a 64 MiB budget.
  - Per-entry deltas barely beat `file`. With a raw JSON files index both are dominated by that
    index (1.37 MB of 2.15 MB at N−1). With the index as a zstd frame (0.34 MB), per-entry equals
    fa64m chunk sync at N−1 but needs 62 requests instead of 2. [M]

### 4.6 Change classification and re-import noise

| Pair      | Commits | Source files changed | Asset units changed¹ | Offsets moved | Content: entries, B | Stamp: entries, B | Godot caches: entries, B, kind  | Other noise: entries, B |
| --------- | ------: | -------------------: | -------------------: | ------------: | ------------------: | ----------------: | ------------------------------- | ----------------------: |
| rc.1→rc.2 |      13 |                   21 |                    0 |           600 |         15, 292,869 |          2, 1,408 | 2, 232,397, order only          |                  1, 667 |
| rc.2→rc.3 |      22 |                  142 |                    1 |         1,383 |        119, 916,949 |          2, 1,408 | 2, 237,090, grown and reordered |                  1, 667 |
| rc.3→rc.4 |      14 |                   71 |                   31 |           665 |         60, 757,944 |          2, 1,408 | 2, 238,398, grown and reordered |                  1, 667 |
| rc.4→rc.5 |       7 |                   45 |                    0 |           695 |         34, 543,554 |          2, 1,408 | —                               |                  1, 667 |

¹ rc.3→rc.4 changed every unit's lock hash, but only 5 imported entries changed, and each had a
changed or new `.import` in git. The lock-hash change is not a content change. [M]

- **Content** is almost all compiled GDScript (`.gdc`) plus, in rc.3 and rc.4, new SVG icons and a
  few `.godot/imported` textures. Every changed `.gdc` had its `.gd` changed in the range: no
  script noise. [M]
- **Godot's caches.** `.godot/uid_cache.bin` (201–203 KB) and
  `.godot/global_script_class_cache.cfg` (31–35 KB) were rewritten in rc.1→rc.2 with **exactly the
  same set of entries in a different order** (the byte multisets are equal). In rc.2→rc.3 and
  rc.3→rc.4 the order of the entries they already held changed as well as growing. rc.4→rc.5
  left them untouched. This is the non-determinism A6 §2.1 saw, on real CI clean builds. [M]
- **Other noise:** one exported scene changes 4 bytes in every release. Its source has no `uid=` in
  its header, so a clean import assigns a random UID ([I] from the bytes and the source). The
  stamp entries are intended (Diceroll's `tools/ci/stamp_version.py` writes the version). [M]/[V]
- **Cost in chunk sync:** noise is 0–5% of missing stored bytes per N−1 update [M]:

| Pair      | Chunker | Content B | Gap (header, directory) B | Caches, reordered B | Other noise B | Stamp B | Noise share |
| --------- | ------- | --------: | ------------------------: | ------------------: | ------------: | ------: | ----------: |
| rc.1→rc.2 | fa16    |   290,953 |                    40,914 |               8,378 |           322 |     736 |          3% |
| rc.1→rc.2 | fa64    |   291,157 |                   121,470 |               8,378 |           322 |     736 |          2% |
| rc.2→rc.3 | fa16    |   685,104 |                   172,706 |              16,339 |           323 |     739 |          2% |
| rc.2→rc.3 | fa64    |   685,066 |                   242,536 |              45,613 |           323 |     739 |          5% |
| rc.3→rc.4 | fa16    |   741,434 |                    85,183 |              14,105 |           323 |     736 |          2% |
| rc.3→rc.4 | fa64    |   741,450 |                   214,209 |              31,535 |           323 |     736 |          3% |
| rc.4→rc.5 | fa16    |   538,916 |                    85,380 |                   0 |           323 |     737 |          0% |
| rc.4→rc.5 | fa64    |   538,705 |                   214,139 |                   0 |           323 |     737 |          0% |

All of these entries sit in what would be the **base** pack. P4-03's pack lint already keeps
`project.binary` and the class cache out of content packs, and P4-01 decides the UID cache. So the
noise matters for the app's main PCK, not for asset packs. [I]

### 4.7 Index size on the wire

Latest release; index deltas for every ordered pair, as min–max per pair class [M].

| Chunker | Records | Unique | `pkey-chunks/1` raw B | As one zstd -19 frame B | `--patch-from` of the seed index, N−1 B | … N−2 B      | … N−3 B       | … oldest→latest B |
| ------- | ------: | -----: | --------------------: | ----------------------: | --------------------------------------: | ------------ | ------------- | ----------------: |
| fa16    |  16,244 |  9,724 |               780,928 |                 403,022 |                             1,907–7,678 | 5,778–10,501 | 10,843–11,167 |            11,415 |
| fa32    |  14,395 |  7,949 |               692,176 |                 328,000 |                             1,620–6,748 | 5,112–8,924  | 9,222–9,769   |             9,981 |
| fa64    |  13,628 |  7,196 |               655,360 |                 296,055 |                             1,443–6,274 | 4,595–8,367  | 8,646–9,036   |             9,212 |
| fa128   |  13,310 |  6,885 |               640,096 |                 282,861 |                             1,400–6,049 | 4,371–8,073  | 8,380–8,746   |             8,934 |
| plain64 |   1,016 |  1,016 |                49,888 |                  43,596 |                             1,001–2,003 | 1,816–2,486  | 2,447–2,488   |             2,447 |
| fa32m   |   8,029 |  7,934 |               386,608 |                 314,956 |                             1,514–6,386 | 4,782–8,464  | 8,753–9,253   |             9,440 |
| fa64m   |   7,262 |  7,181 |               349,792 |                 283,537 |                             1,372–5,913 | 4,322–7,906  | 8,193–8,512   |             8,722 |

As a delta, the index term stops depending on the average or on the padding rule: every
file-aware row is 1.4–11 KB. The padding rule still matters for the seed (first install, repair)
and for clients that do not hold a seed index. [M]

Bundle ids in this measurement stand in as SHA-256 of the bundle's chunk list, which is as
incompressible as the real ids. Records of unchanged chunks keep their id, length, bundle and
offset under shared bundles, so the target index is almost entirely a copy of the seed index. A
client that stores its seed index (P4-11 already does) could receive the next index as a
`--patch-from` frame 0.4–2.5% of the index's size.

**What the index encoding does to the choice of average.** Chunk-sync cost per pair is missing
stored bytes, plus the index term, plus the request weight _w_ times the requests (shared 4 MiB
bundles). Means per class; the "vs fa64m" columns compare the index-delta cost. fa16 and fa128 have
no padding rule, which only affects their raw and zstd columns. [M] (`report.py`, last table)

| Class  | Chunker | Requests | Index raw, w=16K | Index zstd, w=16K | Index delta, w=16K | vs fa64m | Index delta, w=64K | vs fa64m |
| ------ | ------- | -------: | ---------------: | ----------------: | -----------------: | -------: | -----------------: | -------: |
| N−1    | fa16    |        2 |        1,481,345 |         1,104,492 |            708,066 |   −13.7% |            806,370 |   −12.3% |
| N−1    | fa32m   |        2 |        1,122,441 |         1,051,051 |            741,212 |    −9.7% |            839,516 |    −8.7% |
| N−1    | fa64m   |        2 |        1,165,719 |         1,099,708 |            820,849 |        — |            919,153 |        — |
| N−1    | fa128   |        2 |        1,502,096 |         1,146,497 |            868,319 |    +5.8% |            966,623 |    +5.2% |
| N−2    | fa16    |       36 |        2,542,103 |         2,164,109 |          1,770,285 |    −3.2% |          3,539,757 |    +3.1% |
| N−2    | fa32m   |     34.7 |        2,166,504 |         2,094,951 |          1,787,271 |    −2.2% |          3,491,207 |    +1.7% |
| N−2    | fa64m   |     32.7 |        2,171,070 |         2,104,834 |          1,828,002 |        — |          3,433,634 |        — |
| N−2    | fa128   |     31.3 |        2,452,139 |         2,095,261 |          1,819,192 |    −0.5% |          3,359,288 |    −2.2% |
| N−3    | fa16    |       79 |        3,537,798 |         3,159,874 |          2,767,850 |    +2.6% |          6,650,858 |    +9.2% |
| N−3    | fa32m   |       75 |        3,115,934 |         3,044,484 |          2,738,450 |    +1.5% |          6,424,850 |    +5.5% |
| N−3    | fa64m   |       69 |        3,039,620 |         2,973,359 |          2,698,204 |        — |          6,089,692 |        — |
| N−3    | fa128   |       65 |        3,262,622 |         2,905,386 |          2,631,114 |    −2.5% |          5,825,994 |    −4.3% |
| oldest | fa16    |       89 |        3,764,548 |         3,386,642 |          2,995,035 |    +2.4% |          7,369,563 |    +8.2% |
| oldest | fa32m   |       85 |        3,342,815 |         3,271,163 |          2,965,647 |    +1.4% |          7,143,567 |    +4.9% |
| oldest | fa64m   |       79 |        3,266,177 |         3,199,922 |          2,925,107 |        — |          6,808,115 |        — |
| oldest | fa128   |       75 |        3,489,121 |         3,131,886 |          2,857,959 |    −2.3% |          6,544,359 |    −3.9% |

- With the index **raw or as zstd**, fa64m and fa32m are within 4.4% of each other in every class,
  and fa64m wins from N−3 on. 64 KiB stands. [M]
- With the index **as a delta**, the large index of the small averages no longer costs anything.
  The ranking at N−1 then follows missing bytes: fa16 < fa32m < fa64m < fa128. From N−3 on, and
  at N−2 with w = 64 KiB, it follows request runs: fa128 < fa64m < fa32m < fa16. At w = 16 KiB, fa32m saves 80 KB at N−1 and
  41 KB at N−2, and costs 40–41 KB at N−3 and oldest. At w = 64 KiB it saves the same 80 KB at N−1
  and costs 58 KB at N−2 and 335 KB at N−3 and oldest. [M]
- So the default average is a function of the index encoding, the request weight and how far
  behind installs usually are. P4-10's plan must settle the index-on-wire question first, because
  `chunks.params` is frozen for each release's history. [I]

### 4.8 Second texture family: Android `assets/` tree (ETC2/ASTC)

[M] The APK's `assets/` files (6,628–6,737 files, 84.7–85.4 MB decoded, ETC2/ASTC textures) were
concatenated in path order and chunked per file: a `layout: tree` payload with no gaps. All ten
pairs were run. A tree has no padding, so `fa32m`/`fa64m` equal `fa32`/`fa64` here. Bytes are
means per class; requests are shared / fresh 4 MiB bundles.

| Strategy                              |           N−1 bytes (range) |  N−1 req |           N−2 bytes (range) |     N−2 req |     N−3 bytes |      N−3 req |  Oldest bytes | Oldest req | Index B (latest) |
| ------------------------------------- | --------------------------: | -------: | --------------------------: | ----------: | ------------: | -----------: | ------------: | ---------: | ---------------: |
| chunk fa16                            |     1,085,018 (0.80–1.27 M) |   2 / 47 |     1,548,412 (1.41–1.73 M) |     29 / 86 |     1,810,568 | 57.5 / 111.5 |     1,873,356 |   76 / 119 |          475,504 |
| chunk fa32                            |     1,020,231 (0.72–1.20 M) | 2 / 46.8 |     1,500,726 (1.34–1.70 M) | 28.3 / 85.7 |     1,773,676 | 56.5 / 110.5 |     1,836,559 |   74 / 118 |          386,704 |
| **chunk fa64**                        | **1,000,636 (0.68–1.20 M)** |   2 / 46 | **1,503,092 (1.33–1.71 M)** | 28.3 / 83.7 | **1,784,820** | 56.5 / 107.5 | **1,847,516** |   74 / 115 |          349,984 |
| chunk fa128                           |       991,010 (0.67–1.19 M) | 2 / 45.8 |     1,496,397 (1.33–1.70 M) | 27.7 / 83.3 |     1,775,322 | 54.5 / 107.5 |     1,838,012 |   72 / 115 |          334,720 |
| chunk plain64                         |     1,873,189 (1.00–2.52 M) | 2 / 11.5 |     2,863,629 (2.49–3.36 M) |   11.3 / 14 |     3,360,451 |    17.5 / 16 |     3,362,948 |    21 / 16 |           50,416 |
| delta, whole-file `--patch-from`      |       596,395 (0.37–0.78 M) |        1 |     1,014,034 (0.88–1.20 M) |           1 |     1,273,710 |            1 |     1,334,795 |          1 |                — |
| delta, per-entry, files index as zstd |       889,374 (0.62–1.07 M) |     62.8 |     1,335,180 (1.19–1.53 M) |       127.3 |     1,600,566 |          173 |     1,661,673 |        181 |                — |
| file, files index as zstd             |     1,159,728 (0.89–1.35 M) |     62.8 |     1,619,498 (1.49–1.80 M) |       127.3 |     1,878,014 |          173 |     1,940,720 |        181 |                — |
| full (zstd -19)                       |                  62,502,183 |        1 |                  62,586,425 |           1 |    62,645,193 |            1 |    62,647,242 |          1 |                — |

The ETC2/ASTC family agrees with the desktop result. The file-aware averages sit within 10% at
N−1 and within 4% at N−2 and older, with 64 and 128 KiB marginally ahead. Shared bundles give 2
requests at N−1 against ~46 with fresh ones, and the whole-file delta is 0.6–0.7× the chunk row.
Planner choices are identical to §4.9 in every class. The first install's chunk-store "full" is
again 29% above the full blob (81.0 MB vs 62.6 MB).

### 4.9 Planner choices

[M] Menu: both deltas, chunk (the row's chunker, shared 4 MiB bundles), file (raw JSON files index)
and full. Every chunker row gave the same choice, so one line per class:

| Class  | w = 16 KiB, mem 256 MiB | w = 64 KiB, mem 256 MiB | w = 16 KiB, mem 64 MiB | w = 64 KiB, mem 64 MiB | No-delta SDK, 16 / 64 KiB |
| ------ | ----------------------- | ----------------------- | ---------------------- | ---------------------- | ------------------------- |
| N−1    | delta (whole) ×4        | delta (whole) ×4        | chunk ×4               | chunk ×4               | chunk ×4 / chunk ×4       |
| N−2    | delta (whole) ×3        | delta (whole) ×3        | chunk ×3               | chunk ×3               | chunk ×3 / chunk ×3       |
| N−3    | delta (whole) ×2        | delta (whole) ×2        | chunk ×2               | chunk ×2               | chunk ×2 / chunk ×2       |
| oldest | delta (whole)           | delta (whole)           | chunk                  | chunk                  | chunk / chunk             |

For the whole 85 MB PCK, the request weight never changes the choice. Full costs 63 MB, and the
dearest chunk candidate (fa64m, oldest, 64 KiB weight) costs 7.2 M. The weight matters per pack
(§4.10).

### 4.10 Per-pack estimate (desktop PCK sliced by the proposed packs; an estimate)

The first table covers the five pairs in the original run (the four N−1 pairs and oldest→latest).
Its "Oldest delta" and oldest planner columns assume CI published an rc.1→rc.5 delta. An N−1 plus
hot-pairs policy would not publish that delta, so read the oldest pair under that policy from the
no-delta column, or from the every-pair table below.

| Pack            | Slice B (latest) |     Full B | Pairs unchanged (of 5) | N−1 whole delta B (mean) | N−1 chunk fa64m B (req) | N−1 chunk fa32m B (req) | Oldest delta B | Oldest chunk fa64m B (req) | Planner, N−1, 16 / 64 KiB (no-delta SDK) | Planner, oldest, 16 / 64 KiB (no-delta SDK) |
| --------------- | ---------------: | ---------: | ---------------------: | -----------------------: | ----------------------: | ----------------------: | -------------: | -------------------------: | ---------------------------------------- | ------------------------------------------- |
| base (main PCK) |        4,696,156 |  3,831,699 |                      0 |                  548,354 |           624,569 (2.0) |           618,754 (2.0) |      1,306,609 |             1,417,075 (75) | delta / delta (chunk / chunk)            | delta / delta (**chunk / full**)            |
| ui              |        1,886,686 |  1,028,901 |                      5 |                        0 |          15,952 (index) |          16,288 (index) |              0 |                     15,952 | noop                                     | noop                                        |
| core3d          |       17,401,898 | 15,107,008 |                      5 |                        0 |          65,584 (index) |          73,696 (index) |              0 |                     65,584 | noop                                     | noop                                        |
| audio           |       20,791,064 | 19,605,667 |                      5 |                        0 |          29,440 (index) |          41,392 (index) |              0 |                     29,440 | noop                                     | noop                                        |
| foes            |        5,713,215 |  4,617,142 |                      5 |                        0 |          15,664 (index) |          18,592 (index) |              0 |                     15,664 | noop                                     | noop                                        |
| nature          |       19,994,992 |  8,599,976 |                      5 |                        0 |         129,760 (index) |         134,704 (index) |              0 |                    129,760 | noop                                     | noop                                        |
| extra           |       14,216,323 | 11,588,863 |                      3 |                    7,381 |            61,039 (1.2) |            67,231 (1.2) |         29,524 |                 83,164 (2) | noop ×3, delta ×1 (chunk ×1)             | delta / delta (chunk / chunk)               |

- **Only the base slice (the main PCK, see next point) changed every release.** ui, core3d,
  audio, foes and nature never changed in this history. extra changed once, when a kit was added
  in rc.3. Split into packs, 94% of the PCK's bytes sit in packs that no N−1 update (or at most
  one) touched. [M]
- **base is not a content pack.** It is everything outside `assets/`: the compiled scripts,
  `project.binary`, `build_info.json` and Godot's caches. That is the app's main PCK, which ships
  inside the binary (notes/A4 §2.3, stage 0). CONTENT §15 lists no such pack, README §3.12 does not
  deliver it, and P4-03's lint rejects its contents in any `godot.pck` pack. It is costed here only
  as an **[I] proxy** for a small pack that changes every release (a future `l10n` or `events`
  pack, CONTENT §15). Such a pack would hold data, not scripts, so its change pattern may differ.
  The slice is 4.7 MB raw, 3.83 MB full and 799 entries; its index is small (25–40 KB, 0.7–1.0% of
  full), because a slice has no padding gaps. [M] on the slice, [I] as a pack.
- **No real content pack under 4 MiB changed.** The only one, ui (1.0 MB full), was identical in
  every release. So CONTENT §8.2's 4 MiB clause and its "full plus one delta" clause are untested
  here on a real pack. Only the 16 MiB clause has a real-pack row (extra). [M]

Every pair for the two slices that changed: one real content pack (extra) and the main-PCK proxy
(base). Policy: CI publishes only the N−1 delta. "§8.2 rule" is the bytes under CONTENT §8.2's rule
of thumb: full, or the N−1 delta for an N−1 install, and no chunk index below 16 MiB. The planner columns add a chunk index (fa64m, shared 4 MiB bundles) and
plan at request weights 16 and 64 KiB. [M]

| Pack            | Pair      | Class  |     Full B | N−1 delta B | Chunk fa64m B (req) | §8.2 rule B | Planner, 16 KiB | Planner, 64 KiB |
| --------------- | --------- | ------ | ---------: | ----------: | ------------------: | ----------: | --------------- | --------------- |
| base (main PCK) | rc.1→rc.2 | N−1    |  3,431,325 |     287,496 |         335,557 (2) |     287,496 | delta 287,496   | delta 287,496   |
| base (main PCK) | rc.2→rc.3 | N−1    |  3,652,928 |     666,089 |         769,339 (2) |     666,089 | delta 666,089   | delta 666,089   |
| base (main PCK) | rc.3→rc.4 | N−1    |  3,827,705 |     724,067 |         813,859 (2) |     724,067 | delta 724,067   | delta 724,067   |
| base (main PCK) | rc.4→rc.5 | N−1    |  3,831,699 |     515,763 |         579,520 (2) |     515,763 | delta 515,763   | delta 515,763   |
| base (main PCK) | rc.1→rc.3 | N−2    |  3,652,928 |           — |       1,044,113 (9) |   3,652,928 | chunk 1,044,113 | chunk 1,044,113 |
| base (main PCK) | rc.2→rc.4 | N−2    |  3,827,705 |           — |      1,278,101 (54) |   3,827,705 | chunk 1,278,101 | full 3,827,705  |
| base (main PCK) | rc.3→rc.5 | N−2    |  3,831,699 |           — |        952,261 (30) |   3,831,699 | chunk 952,261   | chunk 952,261   |
| base (main PCK) | rc.1→rc.4 | N−3    |  3,827,705 |           — |      1,327,906 (58) |   3,827,705 | chunk 1,327,906 | full 3,827,705  |
| base (main PCK) | rc.2→rc.5 | N−3    |  3,831,699 |           — |      1,380,739 (72) |   3,831,699 | chunk 1,380,739 | full 3,831,699  |
| base (main PCK) | rc.1→rc.5 | oldest |  3,831,699 |           — |      1,417,075 (75) |   3,831,699 | chunk 1,417,075 | full 3,831,699  |
| extra           | rc.1→rc.2 | N−1    | 11,559,877 |           0 |          53,248 (1) |           0 | noop            | noop            |
| extra           | rc.2→rc.3 | N−1    | 11,588,863 |      29,524 |          83,164 (2) |      29,524 | delta 29,524    | delta 29,524    |
| extra           | rc.3→rc.4 | N−1    | 11,588,863 |           0 |          53,872 (1) |           0 | noop            | noop            |
| extra           | rc.4→rc.5 | N−1    | 11,588,863 |           0 |          53,872 (1) |           0 | noop            | noop            |
| extra           | rc.1→rc.3 | N−2    | 11,588,863 |           — |          83,164 (2) |  11,588,863 | chunk 83,164    | chunk 83,164    |
| extra           | rc.2→rc.4 | N−2    | 11,588,863 |           — |          83,164 (2) |  11,588,863 | chunk 83,164    | chunk 83,164    |
| extra           | rc.3→rc.5 | N−2    | 11,588,863 |           — |          53,872 (1) |           0 | noop            | noop            |
| extra           | rc.1→rc.4 | N−3    | 11,588,863 |           — |          83,164 (2) |  11,588,863 | chunk 83,164    | chunk 83,164    |
| extra           | rc.2→rc.5 | N−3    | 11,588,863 |           — |          83,164 (2) |  11,588,863 | chunk 83,164    | chunk 83,164    |
| extra           | rc.1→rc.5 | oldest | 11,588,863 |           — |          83,164 (2) |  11,588,863 | chunk 83,164    | chunk 83,164    |

- **extra, the one real content pack that changed, is where the rule fails.** It is 11.6 MB full,
  in the 4–16 MiB band that the rule gives no chunk index. At N−1 the rule and the planner agree:
  the install takes the 29.5 KB delta, or nothing. From N−2 on there is no published delta, and in
  5 pairs the rule sends 11.6 MB where chunk sync sends **83 KB in 2 requests**, at either weight.
  An SDK without delta support gets 11.6 MB under the rule at rc.2→rc.3 against 83 KB (first
  table, no-delta column). [M]
- **The main-PCK proxy (base)** fits the second clause at N−1. The rule and the planner both send
  the N−1 delta (0.29–0.72 MB, mean 548,354 B), which beats chunk sync (0.34–0.81 MB). From N−2 on
  the rule sends full (3.65–3.83 MB). At the default 16 KiB weight the planner takes chunk in all 6
  of those pairs (0.95–1.42 MB, 9–75 requests). At 64 KiB it takes chunk in 2 and full in 4,
  because 54–75 runs × 64 KiB outweigh the 2.4–2.6 MB saved. A no-delta SDK gets full under the
  rule even at N−1 (3.43–3.83 MB), against 0.34–0.81 MB in 2 requests by chunk sync. These rows
  are measured on the slice. That a real small, changing pack behaves the same way is [I].
- **A wider delta policy would close the extra gap.** extra's rc.5 bytes equal its rc.3 bytes, and
  its rc.1 bytes equal its rc.2 bytes. CONTENT §11's CI step allows deltas against the last _N_
  releases, and the planner matches a delta's `from` against the installed payload (§8.1). With
  _N_ ≥ 3, the 29.5 KB rc.2→rc.3 delta would serve those 5 pairs. The harness models N−1 only. [I]
- A slice's whole-file delta needs only `memBytes` ≈ 2 × slice (9.4 MB for base), so **per-pack
  deltas fit mobile memory budgets** where the 85 MB PCK's 170 MB does not. [M]/[I]

### 4.11 First install

[M] Full blob (63,193,886 B) plus the seed index: +0.55% (fa64m) or +1.0% (fa64). The same bytes
from the chunk store (every unique chunk as its own zstd frame) are 81.0 MB, **28% more** than one
frame. A6 measured +7% on its synthetic pack. Diceroll's scripts, scenes and meshes compress much
better with a long window. First install must stay `full`, and a repair that refetches many chunks
costs up to 28% more than a full redownload. CONTENT §8.1 is confirmed.

## 5. Recommendation

1. **Default `chunks.params` for P4-10.** It depends on the index-on-wire decision (item 5), which
   P4-10's plan must take first, because the params are frozen per release. With the index sent
   raw or as one zstd frame (row: fa64m in §4.1–§4.4 and §4.7):

   ```json
   {
     "chunker": "fastcdc-2016-nc1",
     "fileAware": true,
     "avgSize": 65536,
     "minSize": 16384,
     "maxSize": 262144,
     "padMerge": 64,
     "bundleTarget": 4194304,
     "bundleLayout": "shared",
     "zstdLevel": 19
   }
   ```

   With the index sent as a delta of the seed index, use `avgSize: 32768`, `minSize: 8192`,
   `maxSize: 131072` and the same other fields (row: fa32m in §4.7's cost table). At the 16 KiB
   request weight it is 9.7% cheaper than 64 KiB at N−1 and 2.2% cheaper at N−2, and 1.4–1.5%
   dearer at N−3 and oldest. At a 64 KiB weight it is still 8.7% cheaper at N−1 but 1.7–5.5% dearer
   from N−2 on. If the plan expects many installs two or more releases behind on high-latency links,
   keep 64 KiB. [M]/[I]

   `padMerge`: a gap segment shorter than 64 bytes that directly follows an entry is chunked
   together with that entry. The header, the directory and longer gaps stay separate segments, and
   a chunk never spans two entries. This is a segmentation rule in CI; clients never chunk, so no
   SDK or format change follows. The parameter name and whether it belongs in `params` are P4-10's
   plan to settle (A7's names are used here).

2. **Bundles:**
   - shared across releases of one deliverable and one gating class. That is P4-10's second option,
     now measured: 2 requests vs 42 at N−1;
   - target 4 MiB. 4, 8 and 16 MiB measured identical in bytes and requests, so S-02's Range and
     cache findings may move it within 4–16 MiB with no byte cost;
   - the repacking of bundles below 50% live data (CONTENT §11) was not exercised: five releases
     never approach it.
3. **Thresholds** (CONTENT §8.2 rule of thumb; §4.10 every-pair table). Measured on a real pack,
   only the 16 MiB clause was tested, and it fails:
   - **The 16 MiB clause fails (measured on extra).** extra is 11.6 MB full, in the 4–16 MiB band
     that gets no chunk index. At N−1 the rule matches the planner (the 29.5 KB delta, or nothing).
     From N−2 on, and for no-delta SDKs, the rule sends 11.6 MB where chunk sync sends 83 KB in 2
     requests. Publish a chunk index for container packs of 4 MiB and up, beside the N−1 delta
     (and hot pairs), and let the cost-based planner choose per device. Keep the whole-file N−1
     delta, which beats chunk sync where it exists. [M]
   - **The 4 MiB clause and the "full plus one delta" clause are untested.** The only real pack
     under 4 MiB (ui) never changed. The main-PCK slice (base) is the only small, changing payload
     measured, and it is not a pack. As an [I] proxy it suggests that a small pack that changes
     every release would also gain from a chunk index at N−2 and older: 0.95–1.42 MB in 9–75
     requests against 3.65–3.83 MB full, taken by the planner in all 6 pairs at the 16 KiB weight
     but only 2 of 6 at 64 KiB.
   - **Lowering the floor from 4 MiB to 1 MiB is an inference only.** It rests on the proxy and on
     overhead arithmetic: chunk sync pays at least the index and two request weights (~130 KB at
     64 KiB), which is a large share of any likely saving below about 1 MiB of full. Measure a real
     small pack that changes (a future `l10n` or `events` pack) before adopting it.
4. **Re-import noise** is quantified (§4.6) and small: 0–5% of N−1 chunk bytes. Proposed P4-03 rule
   (warn, never fail):
   - `--dry-run` and publish list the entries whose bytes changed against the stored base but whose
     byte multiset is identical (order-only rewrite), or which differ in at most 8 bytes at equal
     length;
   - allow-list the CI version stamp (`project.binary`, a build-info file);
   - the Diceroll-side fixes (a `uid=` in hand-written scenes) belong to D-04 and are not needed
     for delivery.
5. **Two adjacent wins to take up** (the second decides item 1's average):

   - store the files index as one zstd frame: 1.37 MB → 0.34 MB, which halves the `file` and
     per-entry-delta rows. This changes the signed record's `files` reference (a `codec` and a
     decoded `size`) and what every SDK downloads and parses. It is a plan-mode decision for P4-01
     (its item 2), not a P4-03 change;
   - send the chunk index as a delta against the client's seed index (P4-10's plan decides, since it
     is a new artifact role). The whole-file delta can remain the desktop N−1 default.

## 6. Proposed edits outside the briefs (not applied)

- **README §3.12** sketch `patch.chunking: {alg: fastcdc, avg: 65536, fileAware: true}`: add the
  padding rule (`padMerge: 64` or an equivalent name) and
  `bundles: {target: 4 MiB, layout: shared}`. Keep `avg: 65536` if the index ships raw or
  compressed; change it to `avg: 32768` if P4-10 adopts the index delta (§5 item 1).
- **CONTENT §8.2** rule of thumb, in two steps:
  - **Measured (extra):** replace "chunk sync from about 16 MiB up" with "every container pack of
    4 MiB or more gets a chunk index beside its N−1 delta, and the planner chooses per device". The
    N−1 behaviour does not change. The evidence is extra's N−2–oldest and no-delta SDK rows in
    §4.10.
  - **Inference only (main-PCK proxy):** lowering that floor to 1 MiB, so that a small pack that
    changes every release also gets a chunk index. This rests on the base slice, which is the app's
    main PCK and not a pack. Leave "full under 4 MiB; full plus one delta for small packs that
    change every release" in place until a real small pack that changes has been measured.

- **CONTENT §8.3 / §11:** the chunk-store "full" is 28% above one zstd frame on real content, not
  7% (§4.11).
- **notes/A4 §2.1:** the desktop PCK is 85 MB (rc.1–rc.5), not ~73 MB.

## 7. Briefs changed in this branch

- **P4-10:** default parameters now include the padding-merge rule, with a pointer to this note;
  the bundle choice is now "shared, 4 MiB target (measured)"; the index delta against the seed is
  added as a plan question; the default average is conditional on that question (64 KiB with a
  raw or zstd index, 32 KiB with an index delta), and the plan must settle it before freezing
  `avgSize`.
- **P4-01:** a plan question under item 2: should the `files` reference gain `codec` and `size`, so
  the index ships as a zstd frame (§4.5)?
- **P4-03:** the files index is stored as P4-01 froze it (no shape change in P4-03); a warn-only
  nondeterminism report is added to the dry run.
- **P4-11:** request-weight observations. With shared bundles an N−1 chunk sync is 2 requests; old
  installs need 33–85 runs, which 64 KiB weights price correctly (shown on the 3.8 MB main-PCK
  slice, a proxy). Chunk sync is the path at mobile memory budgets.

## 8. Measured, emulated, unmeasured

| Row                                                                     | Status                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Release inventory, checksums, sizes, entries, engine                    | measured                                                                               |
| Chunker matrix, index size, runs, bundles touched (desktop, 10 pairs)   | measured (offline; bundle layouts computed, not uploaded)                              |
| Whole-file, per-entry and full zstd sizes                               | measured (zstd CLI 1.5.7)                                                              |
| Planner choices at 16/64 KiB, 256/64 MiB                                | measured with the reference planner (a pure function; no network)                      |
| Re-import-noise classification                                          | measured                                                                               |
| Android asset-tree family (ETC2/ASTC)                                   | measured, all 10 pairs                                                                 |
| Per-pack results                                                        | **emulated**: slices of the desktop PCK, not per-pack exports                          |
| Index as zstd and as a delta of the seed index                          | measured (bundle ids stood in)                                                         |
| Chunk-sync cost per index encoding (§4.7 cost table)                    | measured: matrix rows plus index-delta sizes, combined by `report.py`                  |
| Small content pack (under 4 MiB) that changes every release             | unmeasured: ui never changed; the base main-PCK slice stands in as an [I] proxy        |
| Web PCK family                                                          | unmeasured: same size and entries as desktop; not run through the matrix               |
| Wall-clock times (CI chunking, deltas, client apply)                    | unmeasured: host load 500–1,000; A6/A7 have clean timings                              |
| Real R2/CDN request cost per run; Range behaviour per bundle size       | unmeasured here (S-02)                                                                 |
| Device apply cost of chunk vs delta                                     | unmeasured (S-04; A6 §2.3 on desktop)                                                  |
| N−5 and later history, engine bumps, texture reimports, per-pack export | unmeasured: only five releases exist; re-run `matrix.py` when there are ten (hand-off) |

## 9. Limits

- Five releases from one day, one engine and one asset-lock generation. Asset-heavy releases (a
  new biome, a texture-format change, an engine bump that re-imports everything) are not
  represented. Those would move the chunk and delta rows together. The ranking of chunk sizes is
  unlikely to flip, since the index term dominates, but the magnitudes will grow. [I]
- Chunk bundles were laid out, not uploaded. Request counts assume one Range per run. If the
  transport does multi-range requests or ~1 MB gap-filling (A7 §4.3 option), the older-pair runs
  shrink.
- The per-pack numbers are slices: no per-pack PCK header or directory, and no per-pack export.
  The only slice that changed every release (base) is the app's main PCK, not a content pack, so
  CONTENT §8.2's small-pack clauses are untested.

- Everything is S3TC desktop except §4.8 (all 10 pairs of the Android asset tree).

## 10. Sources

- [V] Diceroll release assets `v0.1.0-rc.1` … `v0.1.0-rc.5` (desktop PCK, web zip, Android APK,
  build manifests, `SHA256SUMS.txt`), via `gh release download`; read-only local checkout for
  `git diff` ranges, `tools/ci/stamp_version.py` and `docs/design/2026-09-29-content-streaming.md`
  §5.1 (pack units).
- [S] notes/A6 §2.1, §2.3 (synthetic pair, file-aware halving, +7% chunk-store full); notes/A7 §3.1,
  §4.3 (index format, run rule); notes/A4 §2.1, §2.3 (pack stages); notes/E8 §2.4–§2.5.
- [V] CONTENT §8.1–§8.2, §9, §11; P4-01, P4-10, P4-03 and P4-11 briefs.
- Code: `prototype/chunk-history/` (this note), `prototype/patching/tools/{pck.py,fastcdc.cjs}`,
  `prototype/content/gen/gen.py`, `prototype/content/runners/python/pkey_content.py`.
