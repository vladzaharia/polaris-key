# P4-03 CI: files index with gaps blob, per-entry deltas, pack lint and marker in `pkey release publish`

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v1)                                                                                                 |
| Size        | 1–1.5 engineer-weeks                                                                                           |
| Depends on  | [P4-01](P4-01-packs-plan.md), [P2-06](P2-06-publish-cli-action.md), [P3-03](P3-03-feed-composition.md)         |
| Unblocks    | [P4-10](P4-10-chunk-indexes.md), [P5-08](P5-08-platform-pack-transports.md), [D-04](D-04-diceroll-after-p4.md) |
| Role        | `pkey-implementer`                                                                                             |
| Plan mode   | no: it implements the formats in the approved `program/plans/P4-01.md`                                         |
| Gates       | CLI tests; no Worker change. End-to-end submission needs [P4-02](P4-02-pack-deliverables.md) deployed          |
| Human input | none (tests sign with a committed test release key; the Action runs against a fixture product)                 |
| Repo        | `vladzaharia/polaris-key`                                                                                      |

## Goal

`pkey release publish --deliverable <packId>` turns the built payload of each variant into a
CI-signed `kind: pack` release record plus its patch artifacts: the full blob, a `pkey-files/1`
index (with a gaps blob for container payloads), a blob per file, a whole-payload delta and a
per-entry delta set against the **stored** previous release. It strips the two engine files `--export-pack` always adds, lints the payload by type, writes
the marker, uploads only objects the blob store lacks, and submits the record.
`--deliverable app` stamps the `content` block (`contentApi`, pins, per-build `embeds`) into the
app record. `--dry-run` prints everything without uploading or signing. The `polaris-key/publish`
Action exposes the same.

## Why

Patch artifacts are computed in CI, recorded by release and served by distribution; the Worker
never computes deltas or chunk boundaries
([README §3.7](../../README.md#37-content-packs-across-release-distribution-and-update),
[CONTENT §11](../../CONTENT.md#11-server-side-by-service) "CI tooling"). On the measured 36 MiB
Godot pack, per-entry deltas cut a v1→v2 update from 9.80 MB to 0.60 MB and the `file` strategy to
0.99 MB ([CONTENT §8.3](../../CONTENT.md#83-godot-measured-pure-gdscript-472)). Data-only is
enforced here first and again on the device ([CONTENT §12](../../CONTENT.md#12-security)).

## Read first

- `AGENTS.md`; the approved `program/plans/P4-01.md` (record, files index, blob refs, delta
  descriptors, marker, pin source: authoritative).
- [notes/A7 §3.2–§3.3](../../notes/A7-xlang-content.md#32-delta-artifacts-pkey-patch1-fields-the-vectors-use)
  (delta and files-index formats, publish rules, path rules);
  [notes/A6 §2.2, §2.4](../../notes/A6-godot-patching.md#24-binary-deltas-applied-from-gdscript)
  and [§5](../../notes/A6-godot-patching.md#5-key-gdscript-snippets) (the PCK v2–v4 directory
  layout, what CI must produce, "against the stored base bytes").
- [CONTENT §4.2](../../CONTENT.md#42-initial-type-registry) (`godot.pck`, `files.tree` rules),
  [§7](../../CONTENT.md#7-transports) (marker), [§9](../../CONTENT.md#9-formats).
- Reference code in `docs/research/2026-09-29-godot-omniplatform/prototype/`: `content/gen/gen.py`
  (A7's CI stand-in: files index, gaps blob, per-file and whole `--patch-from` deltas, the zstd CLI
  calls), `content/gen/pck.py` (PCK reader and writer; the reader parses only the v3/v4 layout, and the
  writer's defaults stamp format 4, engine 4.7.2 and pack flags 2), and `patching/tools/` (A6's
  offline tools).
- [notes/S-05 §4.1, §4.6 and §5](../../notes/S-05-godot-platform-mechanics.md#5-recommendation-rules-the-named-briefs-adopt)
  (the entry-count limits, the admission list and the strip step) and
  `prototype/platform-mechanics/tools/strip_pack.py`; `f_uid/` holds real `--export-pack` output
  to copy the fixtures from.
- [P2-06](P2-06-publish-cli-action.md): the `pkey release` commands, signing, upload tickets and
  the Action this extends. Code: `packages/cli/src/index.ts` (command switch at line 66),
  `packages/cli/test/`.

## Scope

**In:**

- `--deliverable <packId>` for `godot.pck` and `files.tree`, one payload per declared variant,
  located through the `.pkey/release` artifact map (P2-04).
- **Check the header, strip, then lint by type.** `godot.pck`: first read the header and fail
  unless it is a PCK v2–v4 with no encrypted directory, no sparse bundle and no encrypted entry.
  Then remove `project.binary` and `.godot/global_script_class_cache.cfg`, which `--export-pack`
  always adds, and write the stripped PCK back in place with the source header's format version,
  engine version and pack flags (see below). Then lint: only the entries S-05's (f) rule admits
  (below); the header's engine version inside `requires.engine`; **warn above 1,000 entries and
  fail above 20,000** (the mount stall grows with entry count, S-05 §4.1).
  `files.tree`: A7 §3.3 path rules, no symlinks. Every failure names the path.
- **Files index.** `layout: container` for PCKs (offsets from the PCK directory, ascending,
  non-overlapping; one zstd gaps blob of every uncovered byte); `layout: tree` with `treeDigest`.
  Each entry carries the blob reference P4-01 decided.
- **Objects.** The full blob (one zstd frame with its content size); one blob per file (zstd, or
  raw when not smaller); a whole-payload `zstd --patch-from` delta and a per-entry delta set
  against the last `patch.deltaBases` releases, fetched from the blob store **by hash**; the
  `pkey-patch/1` descriptors P4-01 decided.
- **Publish rules.** Refuse a `zstd-patch-from` delta whose base starts `37 A4 30 EC` (skip that
  delta and report it); record `memBytes` and the window per P4-01; keep the signed record under
  the payload cap.
- **Record, signing, upload, submit** through P2-06's machinery: dedupe by hash, so an unchanged
  file costs nothing; `provenance` (commit, workflow run).
- **Marker** in P4-01's format, written next to each variant's payload as a build output the app
  export embeds.
- **App records.** `--deliverable app` stamps `content.contentApi` from
  `deliverables.app.content`, `pins` from the embedded packs' markers plus explicit
  `--pin <packId>@<version>` flags, and `embeds` per build (or P4-01's alternative).
- `--dry-run` report: lint results, objects (new vs deduplicated), bytes per strategy, pins,
  refusals the Worker would raise that the CLI can see. Action inputs for all of it.

**Out** (and where it belongs instead):

- Chunk indexes and chunk bundles (→ [P4-10](P4-10-chunk-indexes.md)); lazy hot-pair deltas
  (→ P4-17).
- Platform transport steps: `xcrun ba-package`, PAD modules, Steam depots (→ P5-08).
- Content-key signing (→ P4-19); `provides`/`removes` and the content-interface fingerprint
  (→ P4-20).
- `archive.*` conversion and `godot.zip` (no work package owns them yet; P4-16's type list omits
  them).
- Worker-side checks (→ [P4-02](P4-02-pack-deliverables.md)); serving (→ P4-05).

## Design notes

- **Never re-export.** Deltas are built against the stored bytes of the previous release, fetched
  by the hash its record pins, so a non-deterministic Godot re-import cannot break them (A6 §2.1:
  a clean re-import changes `.godot/uid_cache.bin`).
- **zstd.** Use the zstd CLI (`zstd -19`, `zstd -19 --patch-from=<base>`), the tool every A6/A7
  vector was built with; check `zstd --version` ≥ 1.5.5 and fail clearly otherwise. The Action
  installs it. Compressed bytes may differ across zstd versions; content addressing makes that
  harmless, but never re-publish an object under an existing hash.
- **The admission list** ([notes/S-05 §5 (f)](../../notes/S-05-godot-platform-mechanics.md#5-recommendation-rules-the-named-briefs-adopt),
  measured in §4.6). A `godot.pck` payload may contain only: (1) entries under one of the
  deliverable's `handler.prefixes`, including their `.remap` and `.import` files; (2) the
  `.godot/exported/…` and `.godot/imported/…` files that those `.remap` and `.import` files point
  to (A7 §3.3's example is `.godot/imported/t512_05.png-….s3tc.ctex`; a script-free
  `--export-pack` writes `.godot/exported/<n>/export-<md5>-<name>.res` and `.scn`); and (3)
  `.godot/uid_cache.bin`, which is what makes the pack's `uid://` references resolve when P4-08
  mounts it with `replace_files=true`. Everything else fails with its path, in particular
  `project.binary`, `.godot/global_script_class_cache.cfg`, scripts (`.gd`, `.gdc`, `.cs`, and a
  `.remap` that points to one), native libraries and `.gdextension` files. This answers the
  `uid_cache.bin` question: it ships. Keep the list in one documented form and reuse the same
  fixture PCKs in the device-side check of [P4-08](P4-08-godot-packs.md), so the two cannot drift.
- **The strip step.** `--export-pack` always adds `project.binary` and
  `.godot/global_script_class_cache.cfg`, even to a project with no scripts, and a pack mounted with
  either replaces the main pack's copy (S-05 §4.6: `get_global_class_list()` went from 6 to 0).
  `publish` removes exactly those two entries before it lints, hashes and indexes the payload,
  rebuilds the PCK directory, preserving the header's format version, engine version and pack
  flags, as `prototype/platform-mechanics/tools/strip_pack.py` does (after checking the header is an
  unencrypted, non-sparse PCK v2–v4), writes the result back in place (so the embedded copy is the
  one the marker pins) and reports the strip in `--dry-run`. It removes nothing else; any other
  forbidden entry is a lint failure. `strip_pack.py` refuses v2, because the research `pck.py`
  reader assumes the v3/v4 layout (a directory offset after the file base). A v2 PCK has no
  directory offset: its directory follows 16 reserved words straight after the header (Godot
  4.7.2 `core/io/file_access_pack.cpp`). The CLI must parse that layout, or refuse v2. After the
  rewrite, re-read the output and check that its header and every kept entry's path, size, MD5 and
  flags match the source; `strip_pack.py` does this.
- **Container rebuild is type-neutral** (gap₀, file₀, gap₁, …): the CLI must prove its index and
  gaps blob rebuild the payload byte for byte before it publishes.
- **Per-entry deltas** only for files whose path exists in the base with a different hash; added
  files ship as blobs; removed files simply vanish. Skip a per-file delta that is not smaller than
  the file's blob.
- **Marker placement.** Beside the payload, never inside it (it would change the hash it pins).

## Steps

1. Test fixtures: a tiny PCK v4 writer in the test helpers (port `prototype/content/gen/pck.py`)
   producing v1 and v2 with changed, added and removed entries, one forbidden script, and one
   path outside the prefixes; an unstripped `--export-pack` pack (with `project.binary` and the
   class cache); 2,001- and 20,001-entry packs; a small tree pair.
2. PCK directory reader, the strip step and the type lints.
3. Files index, gaps blob, per-file blobs; the byte-for-byte rebuild self-check.
4. Deltas via the zstd CLI; descriptors; the magic-base refusal.
5. Record assembly, signing, marker, upload, submit, `--dry-run`; the app `content` stamping.
6. Action inputs and its README; CLI docs page under `build/`.

## Acceptance criteria

- [ ] For the fixture v1→v2 PCK: the files index validates against A7 §3.3, and gaps plus files
      rebuild v2 byte for byte (SHA-256 equal).
- [ ] Every per-entry delta decodes with `zstd -d --patch-from=<old entry>` to the new entry's
      SHA-256; the whole-payload delta decodes to v2.
- [ ] Lint rejects the script, a native library and the out-of-prefix path, each with its path; a
      clean pack passes; a `.godot/imported/` artefact of an in-prefix source, a
      `.godot/exported/` file named by an in-prefix `.remap`, and `.godot/uid_cache.bin` pass.
- [ ] A fixture with `project.binary` and `.godot/global_script_class_cache.cfg` is stripped of
      exactly those two entries, written back, and then passes; the record hashes the stripped
      bytes.
- [ ] A 2,001-entry fixture passes with a warning; a 20,001-entry fixture fails.
- [ ] A base starting `37 A4 30 EC` produces no `zstd-patch-from` delta and a dry-run warning.
- [ ] Publishing v2 after v1 uploads only new objects (a test counts upload calls).
- [ ] The signed record verifies with the test release key, stays under the payload cap for a
      625-entry fixture, and every zstd reference carries `size`.
- [ ] `--deliverable app --dry-run` prints `contentApi`, pins from embedded markers and `--pin`,
      and `embeds` per build.
- [ ] Once P4-04 has landed: the CLI's files index and descriptors for the corpus's v1/v2
      payloads have the same structure as the corpus's (a test over the committed blobs).
- [ ] The green gate passes.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/cli build
mise exec node@22 -- pnpm typecheck
zstd --version   # ≥ 1.5.5 on the machine running the tests
```

## Hand-off

P4-10 adds `pkey-chunks/1` and chunk bundles to the same command, reusing its directory reader
(file-aware chunking needs PCK entry offsets) and upload path. P4-08's device-side directory check
must agree with this lint. Diceroll (D-04) publishes through this command. Then
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-03 done`.
