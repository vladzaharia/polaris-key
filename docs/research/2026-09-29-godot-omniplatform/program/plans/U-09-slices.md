# U-09.2+ slices: the rest of the Cloud Sync records store (2026-10-28)

**This is a plan. It contains documents only, no code.** The slices change code once the lead
dispatches them.

- **Base:** `integ/next-stage` @`dc601f591c`, read-only.
- **Executes:** `plan-cloud-sync.md` U-09 ⚑ (l.567), C14, §2.3–§2.5, §2.9; `plans/U-01b.md` §2.2;
  V5 §13.3–§13.7 and §13.10.
- **Size:** 13 slices of up to 60 min each, about 1.3 engineer-weeks across three lanes.

## 0. Facts (the code wins)

- **U-09.1 (`1f6db739ae`)** shipped sealed settings:
  - `ct`, `encryption_mismatch` and the `max`/`min` CAS register;
  - `meta.encryption_since`, which is C14's `meta.e2e_since` under another name, so it is done;
  - discovery `encryption`.
- **U-09.1 did not touch the schema.** `sqlStore.ts:31` still says `SCHEMA_VERSION = 2`, and there
  is no `kid` column.
- **The Worker refuses every record today:**
  - `classify.ts:152` and `push.ts` `applyOne` answer `collection_unknown`;
  - discovery says `collections: false`;
  - the pull's `usage.records` is a hard-coded `0` (`pull.ts:134`);
  - the directory flush writes `records = 0` (`directory.ts:220`);
  - the aggregate's `byKind.records` is `0` (`scheduled.ts:112`).
- **What already exists for records:**
  - catalog: `CloudSyncCollection`, `resolveCollection` and the templates. There is no function
    that maps a concrete name to its declaration (`prefix.*`).
  - protocol: `RecordTarget`, the ops, a sealed record change with `ct`, and `SyncUsage.records`.
- **client-core:**
  - The machine already writes records: CAS rule 3, `add`/`remove` with `observedSeq` = the
    cursor, and E2E `max`/`min` re-push. Scenarios: `one-outstanding-cas`, `union-add-remove`,
    `record-max-field-conflict`.
  - `hostCodec.ts` seals settings only. A record mutation is refused with `invalid-options`.
- **G1, a contract drift.** All four machine ports send a `merge` record edit as
  `setMember`/`removeMember`, but V5 §13.3 says `setField`/`removeField`. The ports are
  client-core `cloud-sync.ts:808`, Python `machine.py:515`, Swift `CloudSyncMachine.swift:518` and
  Kotlin `MachineRecordPuts.kt:36`. No scenario pins a `merge` record. Godot has no machine port
  yet.
- **D1 needs no new table.** `sync_directory.records` and `sync_product_usage.record_bytes`
  already exist (0131). The directory keeps bytes as one total, so it has no per-kind bytes.
- **Swift `TranscriptTests.swift:1005` requires every `cloudsync-*` transcript to replay.** A
  records transcript would fail Swift until U-23.
- **`features.json` `sync.records`** gives its transcript proof `wp` as U-10. It should be U-09.

## 1. Gaps in V5 §13 (★ text, U-09.2)

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                   | Owner approval?                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| G2  | **Sealed `merge` and `union` record shapes.** Proposed:<br>• pull change: `{record, fields: [{field, ct, editedHlc}], version, editedHlc}` and `{record, elements: [{element, ct}], version}`, with no `ct`;<br>• conflict copy: `server {fields, version, editedHlc}`;<br>• server mode: `value` is the live object, or the array in order of each element's first surviving add tag | **yes (D2)**: new normative shapes                       |
| G3  | The `max`/`min` register (§13.3, U-09.1) covers records too: in E2E `set` carries `baseVersion`. In server mode the server compares `conflictField`                                                                                                                                                                                                                                   | covered: §13.10.5 and plan §1.6 already say so by policy |
| G4  | **The envelope `k` for records is unspecified.** All records of a collection share `K_coll(c)`, so a Worker could swap `ct` between them. Proposed `k`:<br>• value: `k = id`;<br>• field: `id ‖ U+0000 ‖ field`;<br>• element: `id ‖ U+0000 ‖ canonicalJson(e)`<br>These are plaintext names, as with members. `envelopeCases` rows follow in U-09.2b                                 | **yes (D1)**: crypto binding                             |
| G5a | Matching a concrete name to a collection: an exact name wins over a pattern, and the longest `prefix.*` wins among patterns. `maxRecords` applies per concrete collection                                                                                                                                                                                                             | **yes**, with D1/D2 (SDKs must match the same way)       |
| G5b | `quota_exceeded` with `scope: "collection"` means `maxRecords` (or the 16 save slots) is reached, and only a create can hit it                                                                                                                                                                                                                                                        | covered (already in §13.3)                               |
| G5c | `delete` passes on a collection whose `requires` the device no longer has                                                                                                                                                                                                                                                                                                             | **yes (D4)**                                             |
| G5d | Discovery says `collections: true` only when the catalog declares at least one collection                                                                                                                                                                                                                                                                                             | covered (`U-01.md:230`)                                  |

## 2. Worker design (built by U-09.3–.9)

### 2.1 DO schema v3 (C14)

It is one more `MIGRATIONS` entry in `sqlStore.ts` (`SCHEMA_VERSION = 3`) and is applied lazily.

```
records       (collection, id, version, hlc, client_id, value_json, kind 'value'|'fields'|'set',
               deleted, floor_hlc, floor_client, kid, PK (collection, id)) WITHOUT ROWID
              + INDEX records_version (version), INDEX records_live (collection, deleted)
record_fields (ord PK AUTOINCREMENT, collection, id, field, value_json, removed, hlc, client_id,
               kid, UNIQUE (collection, id, field))          -- mirrors setting_members
set_elements  (collection, id, element_key, element_json, add_tag, kid,
               PK (collection, id, element_key, add_tag)) WITHOUT ROWID
ALTER TABLE settings | tombstones | setting_members ADD COLUMN kid TEXT
[D3 = park] parked_records (collection, id, from_subject, kind, value_json, fields_json,
               elements_json, hlc, client_id, kid, parked_at, PK (collection, id, from_subject))
```

- **`kid`** is the hex of the envelope's bytes 1–16. It is set on each sealed write and is `NULL`
  for plaintext. Old rows are not backfilled (D6).
- **`element_key`** is `x:…` in E2E mode. In server mode it is the lowercase hex SHA-256 of the
  element's canonical JSON.
- **`hlc` when no `editedHlc` came.** A `revision` write without `editedHlc` stores the server's
  HLC at `serverNow`, so its tombstone still has one.

### 2.2 Engine (`engine/records.ts`, new)

- **Per policy:**
  - `revision` (and `lastWrite` with `baseVersion`): a number is CAS, `"*"` is create-only, and
    an absent one is unconditional.
  - `lastWrite`: the `editedHlc` order.
  - `max`/`min`: by `conflictField` in server mode (a tie falls back to `lastWrite`; a missing or
    non-number field is `op_invalid_for_policy`), and the G3 register in E2E.
  - `merge`: per-field LWW cells with a floor.
  - `union`: `add` adds tag `seq`; `remove` drops the tags at or below `observedSeq` (no
    `observedSeq` is `value_invalid`).
  - `delete`: a record tombstone with an HLC.
- **Policy change.** The server reads the policy at push time and converts at write: an object
  becomes field cells and back, and an array becomes elements and back. Nothing is converted on a
  read.
- **Budgets and quota:**
  - A record is at most 64 KiB: canonical JSON in server mode; in E2E, the sum of
    `envelopeBytes − 113` over its value, fields or elements. Over is `value_invalid`.
  - An element is at most 1 KiB.
  - The quota charges stored bytes.
  - `StoreUsage` gains `records` and `recordBytes`. Both are inside `bytes`.
- **Same as settings.** `encryptionSince` is set by the first accepted sealed record write too
  (`push.ts` `sealedAt`, U43-F4's rule). `heldData()` and `isEmpty()` count records.

### 2.3 Pull, classify, discovery

- **Pull.** One page of 500 across settings, tombstones and records in `version` order (a merge
  of two paged cursors, never a full load). Record changes and tombstones use the §13.4 and G2
  shapes, and `usage.records` is real.
- **Classify** (`handlers/classify.ts`). The collection matcher is
  `matchCollection(catalog, name)`, added to `shared-catalog/src/cloudSync.ts`. Then, in order:
  1. no declaration is `collection_unknown`;
  2. `requires` not granted by `syncAccess(...).entitlements` is `entitlement_required` (not for
     `delete`, D4);
  3. in E2E, a record id, field or element that is not blinded is `encryption_mismatch`, and so is
     `value` where `ct` was expected, or the reverse;
  4. a server-mode schema failure is `value_invalid` (a field against `schema.properties[field]`);
  5. an op the policy does not allow is `op_invalid_for_policy`.
- **Discovery.** `collections: true` per G5d.

### 2.4 Export, merge and delete

- **Export.** `ExportDocument.records?` is optional, so an older export reads as `[]`.
  `parseExportDocument` checks it as input.
- **Absorb.**
  - `lastWrite`, `max`, `min`, `merge` and `union` join by stamps, cells or tags, as settings do.
  - Colliding `revision` records follow D3.
  - Non-colliding rows copy over.
- **Delete.** `deleteAll` already drops every table.
- **Housekeeping** (`maintenance.ts`) prunes record tombstones and removed field cells under the
  90-day watermark, as it does for settings.
- **Directory.** It writes `records` and `record_bytes`, and `scheduled.ts` fills `byKind.records`
  and `record_bytes`.
- **D1 migration** `00XX_sync_directory_record_bytes.sql` (the lead assigns the number) is one
  statement: `ALTER TABLE sync_directory ADD COLUMN record_bytes INTEGER NOT NULL DEFAULT 0`. Its
  rollback is `packages/worker/scripts/rollback/00XX_sync_directory_record_bytes.down.sql`.
  - **No new D1 table, so no `TABLE_OWNERS` row.** `sync_directory` is already `sync`'s
    (`owners.ts:172`), and `tableCrossings` is unchanged.
  - DO tables are not in `TABLE_OWNERS`.

## 3. Slices

★ marks a slice that touches V5 §13 text, the corpus, `shared-protocol` or `client-core`. Every
slice is Sonnet 5.5, has a 60-minute time box, and branches `wp/U-09.N-<slug>` from
`integ/next-stage`.

| Slice     | Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Files                                                                                                                                                                              | Tests and generators                                                                                                                            | Deps                                              | Security                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------- |
| **.2 ★**  | Contract text G2–G5 in V5 §13.3, §13.4, §13.5, §13.7 and §13.10.4, with "(U-09)" serving notes. Protocol: `SyncSealedField`, `SyncSealedElement`, record variants of `SyncSealedChange` and `SyncServerCopy` (`fields`, `elements`). OpenAPI `SyncChange`, `SyncMutation` (`field`, `element`, `observedSeq`) and the server copy                                                                                                                                                                               | `docs/security/WIRE-CONTRACT-V5.md`, `packages/shared-protocol/src/sync.ts`, `packages/worker/openapi/polaris-key.v3.yaml`                                                         | protocol tests; `pnpm build` then `pnpm gen action-bundle`; `gen constants --check`; `gen docs-reference --check`; docs `check:links`; prettier | **owner approval of D1, D2, D4 and G5a**          | text reviewed in U-09.R (G4) |
| **.2b ★** | `sync-vectors.json` `envelopeCases` rows for the three record names of G4 (seal, open, a swapped `id`, a swapped field). Append-only, so `syncVectorsVersion` stays 1                                                                                                                                                                                                                                                                                                                                           | `tools/corpus/syncVectors.ts`, `tools/corpus/reference/syncVectors.ts`                                                                                                             | `pnpm gen corpus` (Godot mirror); Node and browser runners                                                                                      | .2; holds the corpus lane                         | yes (crypto binding)         |
| .3        | DO schema v3 (§2.1). `StoredRecord` and the `SyncStore` record methods: `getRecord`, `putRecord`, `deleteRecordRow`, `recordsPageAfter`, `recordsPageThrough`, `liveRecordCount(c)`. `StoreUsage.records` and `recordBytes`, in the memory store and the SQL store. No behaviour change                                                                                                                                                                                                                         | `do/sqlStore.ts`, `engine/{types,memoryStore,store}.ts`                                                                                                                            | `cloudSyncDo.test.ts` (v2→v3 migration, a v4 store refused); store unit tests on both stores                                                    | —                                                 | —                            |
| .4        | Scalar records: `revision`, `lastWrite`, `max`, `min` (server mode and E2E register), `delete`, tombstones, the 64 KiB cap, `maxRecords` → `collection`, usage, `encryptionSince`. Wire into `push.ts` `applyOne`                                                                                                                                                                                                                                                                                               | `engine/records.ts` (new), `engine/push.ts`, `engine/usage.ts`                                                                                                                     | `cloudSyncRecords.test.ts` (new) and its `cloudSyncSqlParityRecords.test.ts` twin                                                               | .3                                                | U-09.R                       |
| .5        | `merge` (`record_fields`) and `union` (`set_elements`) in both modes, the policy-change conversion, and the removed-cell prune                                                                                                                                                                                                                                                                                                                                                                                  | `engine/records.ts`, `engine/recordSets.ts` (new)                                                                                                                                  | `cloudSyncRecordsMerge.test.ts` (new), parity twin: a concurrent add survives a stale remove                                                    | .4                                                | U-09.R                       |
| .6        | Classify record targets (§2.3) and `matchCollection`                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `handlers/classify.ts`, `handlers/push.ts`, `shared-catalog/src/cloudSync.ts` (+ export)                                                                                           | `cloudSyncPush.test.ts`, catalog tests; `pnpm build` then `pnpm gen action-bundle` (the catalog is inlined)                                     | .4; G5a text, or the recommended rule if .2 waits | U-09.R                       |
| .7        | Pull: merged paging across both tables, the record change and tombstone shapes (server mode now; E2E fields and elements after .2), `usage.records`, `empty`. Discovery `collections`                                                                                                                                                                                                                                                                                                                           | `engine/pull.ts`, `do/cloudSyncDo.ts`, `index.ts`                                                                                                                                  | `cloudSyncPull*.test.ts`, `discoveryGolden.test.ts` (+ fixture)                                                                                 | .5, .6; the E2E shapes after .2                   | U-09.R (cross-record leaks)  |
| .8        | Export, absorb (D3: the `parked_records` table) and the parser                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `do/{protocol,exportDoc}.ts`, `engine/absorb.ts`, `do/cloudSyncDo.ts`                                                                                                              | `cloudSyncMerge.test.ts`, `cloudSyncDeletion.test.ts` (records erased)                                                                          | .5                                                | U-09.R (privacy)             |
| .9        | Housekeeping, the directory `records` and `record_bytes`, the aggregate, and the D1 migration                                                                                                                                                                                                                                                                                                                                                                                                                   | `maintenance.ts`, `do/directory.ts`, `scheduled.ts`, `migrations/00XX_sync_directory_record_bytes.sql`, `scripts/rollback/…down.sql`                                               | `cloudSyncDirectory`, `cloudSyncAggregate`, `cloudSyncUsageAdmin` tests; `gen docs-reference` (migrations page)                                 | .7                                                | —                            |
| .10       | Transcripts in `test/transcripts/scenarios/cloudSyncRecords.ts` (new), each with `features: ["sync.records"]`: `cloudsync-records-cas` (`*`, a stale CAS, delete), `-merge` (concurrent fields), `-orset` (a concurrent add and a stale remove), `-max` (`conflictField`), `-quota` (scope `collection`, `requires`), `-e2e` (blinded ids, fields and elements; `encryption_mismatch`). In the same slice: fix `features.json` `sync.records` wp → U-09, and make the Swift test filter by `sync.settings` (G6) | the files named, `conformance/parity/features.json`, `sdks/swift/Tests/PolarisKeyTests/TranscriptTests.swift`                                                                      | `pnpm gen transcripts` (Godot mirror); `gen parity --check`; the Node, React, Python, Kotlin and Swift replayers skip records                   | .7, .8, .2; holds the transcripts lane            | —                            |
| **.11 ★** | G1: `merge` records send `setField`/`removeField`, and the apply paths follow, in client-core, Python, Swift and Kotlin. New scenario `record-merge-fields` (append-only; `syncScenariosVersion` stays 4, D7)                                                                                                                                                                                                                                                                                                   | `client-core/src/cloud-sync.ts`, `tools/sync-scenarios.ts`, `sdks/python/…/machine.py`, `sdks/swift/…/CloudSyncMachine.swift`, `sdks/kotlin/core/…/MachineRecordPuts.kt` (+ apply) | `pnpm gen corpus` (Godot mirror); client-core, Python, Swift and Kotlin (`:core:test`, `:conformance:test`) scenario runners                    | none; can start now; holds the corpus lane        | —                            |
| .12       | THREAT-MODEL: T19 extended to `conflictField`; T24 (field and element equality within a collection, concrete collection names in the clear, record counts); T4. A PRIVACY row "Cloud Sync records" (`records`, `record_fields`, `set_elements`, `parked_records`); U-12 keeps the portal export                                                                                                                                                                                                                 | `docs/security/THREAT-MODEL.md`, `docs/PRIVACY.md`                                                                                                                                 | prettier; docs `check:links`                                                                                                                    | .9                                                | —                            |
| **R**     | Security review of .2–.10: cross-record and cross-collection isolation (T5), CAS and OR-set races, the leakage of blinding, budget and quota bypass, absorb and erase, and the G4 binding. Read-only; the write-up stays local                                                                                                                                                                                                                                                                                  | read-only; attack tests in `test/attack/` where a gap is found                                                                                                                     | —                                                                                                                                               | .10                                               | Sonnet 5.5 security          |
| **F**     | One fix round on R                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | per finding                                                                                                                                                                        | the touched tests; `gen transcripts --check`                                                                                                    | R                                                 | —                            |

- **Order and lanes:**
  - **Contract lane:** .2 waits for the owner, then .2b.
  - **Worker lane:** .3 → .4 → (.5 ∥ .6) → .7 → (.8 ∥ .9) → .10 → R → F, then .12.
  - **Corpus lane:** .11 can run now.
  - .3–.6 do not need .2.
- **Worker gates for every slice:** `pnpm --filter @polaris-key/worker test` scoped to `sync`,
  `typecheck`, and `typecheck:workerd` for .3 (DO SQL).
- **Hand-off:** `$PKEY_LEAD/gate.sh` once.

## 4. Approval: what the owner must approve and what is already covered

- **Needs the owner:**
  - .2's new text: D1 (G4 `k`), D2 (G2 shapes), D4 (delete under a lapsed `requires`) and G5a
    (matching precedence);
  - .2b's vectors follow D1.
- **Already covered by the approved plan:**
  - .11 brings four ports in line with the approved §13.3 `setField`/`removeField`;
  - G3, G5b and G5d;
  - the protocol types that follow approved text;
  - the DO v3 tables and the `kid` columns (C14).
- **Not wire-related:** .3–.10 and .12. They read the approved types.

## 5. Decisions for the owner (recommendation first)

1. **D1, the envelope `k` for records.** Recommended: `id`, `id ‖ U+0000 ‖ field` and
   `id ‖ U+0000 ‖ canonicalJson(e)`, with `envelopeCases` rows. Without them a Worker can swap a
   save between slots undetected.
2. **D2, the sealed `merge`/`union` record shapes.** Recommended: `fields` and `elements` arrays,
   as for members (G2).
3. **D3, an account merge with colliding `revision` records.** Recommended: park the absorbed copy
   in `parked_records` (S-17: "never silently overwrite"). It has no wire until U-08 plans one, so
   `cloudsync-merge-parked` stays with U-08, which reverses U-01b:522. The alternative, the newer
   stamp wins with a count in the audit row, loses data.
4. **D4, `delete` under a lapsed `requires`.** Recommended: allow it, as a quota allows deletes.
5. **D5, transcripts.** Recommended: a new `cloudsync-records-quota`, not a re-recording of
   `cloudsync-quota` (plan §2.5). The re-recording would break the `sync.settings` replayers in
   five SDKs.
6. **D6, `kid` columns without a backfill.** Recommended: yes. Production has no sync rows, and
   staging's sealed settings stay `NULL`.
7. **D7, the version of `record-merge-fields`.** Recommended: keep 4. Adding a scenario changes no
   existing expectation.
8. **D8, per-kind bytes in D1 now (.9).** Recommended: yes. Otherwise move it to the "Sync
   residuals" row.

## 6. Clients and Workers already deployed

- **Clients.** No released SDK writes records: `sync.records` is `planned` everywhere. The
  `setMember` ports never shipped with records. The new transcripts are inert until U-22/U-23.
- **Workers:**
  - v0.9.19 in production answers `collection_unknown` and has zero sync products.
  - v3 migrates lazily on first touch. A v2 build refuses a v3 object (`unsupported_schema`), so
    the order is roll forward, pause writes, then switch off.
  - Before the deploy, confirm read-only that `sync_directory` holds 0 rows in production.
  - No new launch gate: records ride Cloud Sync's per-product switch, and E2E records ride
    `launch.syncE2e`.

## 7. What U-09 unblocks

- **U-08** (conflict vocabulary, `MergeRequest`, and the parked-records wire under D3): after .10.
- **U-10** (files, DO v4 on `records`): after .8. It still needs the `SYNC_FILES` R2 buckets
  (OS-7, owner §8y.3).
- **U-22, U-23** (records SDKs): after .10 and .2b. They need a client-core host codec slice for
  records first (U-22.0 ★, covered once D1/D2 are approved).
- **U-11a, U-12:** after .9.

## 8. Repo-side steps for the lead

1. Ask the owner for D1–D8 and approval of .2. Start .3–.6 and .11 meanwhile.
2. In the graph lane:
   - `check.mjs --set U-09 in-progress`;
   - the U-09 brief: a section "Approved plan (U-09-slices.md)". Strike its Goal and Steps
     (`ownerRead`/`server` classes, `inc`, console writes, unlicensed limits: C13), so the brief
     takes its goal and steps from the slices;
   - the U-08 brief: it owns `cloudsync-merge-parked` and the parked-records wire (★);
   - the U-22 brief: add U-22.0 (the client-core host codec for records) and the dependency on
     .2b;
   - the U-10 brief: v4 builds on v3 `records`;
   - then `--sync-briefs`, `--write-index` and prettier.
3. Number the migration at merge (`00XX_sync_directory_record_bytes.sql` and its `.down.sql`).
4. Lane holds: the corpus lane for .11 and .2b, the transcripts lane for .10.
5. Dispatch R (Sonnet security) after .10. One fix round only.
