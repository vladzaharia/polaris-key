---
sidebar:
  order: 6
title: "Packs"
description: "Content packs as release deliverables: declaring them, the pinned, compatible and standalone bindings, contentApi, publishing a pack in stage rounds and one record, pins, holds, resolved pack sets, floors per contentApi line, embedded baselines and the delivery gate."
---

A **pack** is content an app loads at run time — a Godot resource pack (`godot.pck`), a
directory of files (`files.tree`), translation tables, JSON data, audio banks, a model, or a type
the game defines (see [Pack types](#pack-types)) — released on its own versions, like the app. Release records
every pack release, which app releases pin which pack releases, and what each build embeds.
Distribution serves the bytes; the SDKs install them. The terms are on the
[concepts page](/docs/start/concepts/#packs).

A pack's **binding** decides which of its releases an app release runs with:

- **`pinned`**: each app release pins the exact pack release it ships with, and the pack changes
  on a device only with an app release.
- **`compatible`**: each pack release declares the app `contentApi` levels it supports; Release
  resolves the newest compatible release for every contentApi level still live, so content ships
  between app releases.
- **`standalone`**: the newest release, for every level; the pack depends only on its own type's
  format (localisation tables, data with its own schema version).

Packs carry data only, never code.

## Declaring packs

Packs are declared in `.pkey/release` beside the app; the field reference is on
[Authoring manifests](/docs/build/manifest/authoring/#pack-deliverables).

```yaml
deliverables:
  app:
    kind: app
    content: { contentApi: 3 }
    artifacts:
      - {
          id: macos,
          platform: macos,
          arch: universal,
          format: dmg,
          match: "Diceroll-*-macos.dmg",
          embeds: [diceroll.core3d],
        }
  diceroll.core3d:
    kind: pack
    type: godot.pck
    baseline: embedded
    required: true
    delivery: essential
    handler: { mountOrder: 2, prefixes: ["res://assets/kaykit/"] }
    variants: { texture: [s3tc, etc2, astc] }
    requires: { engine: godot-4.7 }
```

- At most 64 packs. Each resync writes one deliverable row per pack (kind `pack`).
- `deliverables.app.content.contentApi` is required once any pack exists: the content shape the
  app's code expects, stamped into every app release.
- A build's `embeds` names the packs it ships inside it; omitted means every
  `baseline: embedded` pack, `[]` none (a lean web build).

A compatible and a standalone pack, with the app routing event packs to their own channel:

```yaml
deliverables:
  app:
    kind: app
    content:
      contentApi: 4
      packChannels: { "diceroll.events.*": events }
  diceroll.foes:
    kind: pack
    type: godot.pck
    binding: compatible
    requires:
      engine: godot-4.7
      contentApi: { app: ">=4 <5" }
      packs: { diceroll.lore: ">=1.2.0 <2.0.0" }
    conflicts: [diceroll.legacy-foes]
    handler: { prefixes: ["res://foes/"] }
  diceroll.l10n:
    kind: pack
    type: files.tree
    binding: standalone
    variants: { locale: [en, fr, de] }
  diceroll.events.halloween:
    kind: pack
    type: files.tree
    binding: compatible
    channels: [events]
    requires: { contentApi: { app: ">=3" } }
```

- `requires.contentApi` is keyed by the app deliverable (`app`): one to four comparators
  (`>=`, `<=`, `>`, `<`, `=` or a bare level) that must all hold. A `compatible` pack declares
  it; a `standalone` one never does.
- `requires.packs` names other compatible or standalone packs, each with a version range under
  that pack's scheme. `conflicts` names packs this one never shares a set with.
- A pack's `channels` are where its releases may be published beyond `stable` and `beta`;
  `content.packChannels` maps a pack id or a `prefix.*` to the channel every app channel
  consumes for those packs.
- These are the defaults CI signs into **each variant** of a pack record (`requires`,
  `conflicts`). The record is the truth: resolution reads the signed values, so a release keeps
  the range it was published with.

## Pack types

A pack's `type` names the handler a device installs it with. Transport, patching, signing,
revocation and garbage collection are the same for every type; the handler adds the type's own
checks over the verified payload before it commits, and what activation does. A payload that
fails them is refused with `pack-type-check-failed` (its `detail` names the check, its `path` the
file), nothing is activated and the staged bytes are discarded. `pkey release publish` runs the
same checks, with the device's own functions, before it signs anything.

| Type            | Payload                                            | Activation              | Checks (device and publish)                                                                                                                                                                                                                                     | SDKs                                   |
| --------------- | -------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `godot.pck`     | one `.pck`, uncompressed entries                   | restart                 | the PCK header (engine, format) and the admission list over `handler.prefixes`                                                                                                                                                                                  | Godot                                  |
| `godot.zip`     | one `.zip` of stored entries                       | restart                 | read strictly (nothing before the first entry, no comment, no ZIP64, encryption or data descriptor, stored entries only, normal paths), then the `godot.pck` admission list                                                                                     | Godot                                  |
| `files.tree`    | a directory of files                               | hot                     | the path rules                                                                                                                                                                                                                                                  | all                                    |
| `l10n.table`    | PO, CSV or JSON tables                             | hot                     | every file a table the plain parsers read; each table's locale a well-formed BCP-47 tag and, in a `locale` variant, that locale (`locale`, `table`); `formatVersion` listed by the handler                                                                      | all                                    |
| `data.json`     | JSON documents (balance tables, event definitions) | hot                     | every file strict JSON with an object at the top, whatever its name (`json`); the declared `formatVersion` listed by the handler                                                                                                                                | all                                    |
| `audio.bank`    | FMOD or Wwise banks and a `bank.json`              | hot (host reloads)      | `bank.json` declares `middleware` and `version`; the device runs that middleware at the same `major.minor` (`descriptor`, `middleware`)                                                                                                                         | Godot (others: the game's own handler) |
| `ml.model`      | GGUF, ONNX or safetensors and a `model.json`       | hot (after a load test) | `model.json` declares `runtime`, `file` and `memBytes` (optional `vramBytes`, `quantization`); the host's runtimes, quantisations and RAM/VRAM budget, then its load test over the staged file (`descriptor`, `runtime`, `quantization`, `memory`, `load-test`) | Node, React, Python, Swift             |
| `custom.<name>` | a file or a tree                                   | the game's handler      | the path rules; anything else is the game's                                                                                                                                                                                                                     | all, through `registerHandler`         |

- **Handlers parse, never evaluate.** A table or document is read by a plain parser; nothing is
  passed to a script engine, a resource loader or `load_resource_pack` (only `godot.pck` and
  `godot.zip` are mounted, and a content key can never sign either). In Godot, translations are
  built with `Translation.add_message` and registered with `TranslationServer`, never loaded as a
  `.translation` resource.
- **When the checks run.** Over every newly staged payload, before it commits. A release whose
  exact payload is already installed is reused without a second check, and so is a rollback to
  the previous release: the bytes were checked when first admitted. An embedded baseline is
  CI-built and release-signed, and is not re-checked either.
- **Godot plurals.** Godot 4.6 and later register a PO file's plural forms; 4.4 and 4.5 register
  the singular form only. A pack's `Plural-Forms` formula is never evaluated: Godot's own plural
  rules for the locale apply.
- **Format by content.** An `l10n.table` file is a JSON table when it starts with `{`, a PO file
  when it starts with `#`, `msgid` or `msgctxt`, and CSV otherwise (a key column, then one column
  per locale), whatever its name.
- **Tiny, frequently tuned values belong in managed config**, not a `data.json` pack: config is a
  signed document with enforced and default states, delivered with no install at all. A pack suits
  data large or structured enough to version and patch as content.
- **Under a content key** ([delegation](#content-keys-delegation)) only `files.tree`, `data.json`
  and `l10n.table` can be signed, in tree layout, and every file passes the data-only extension
  allow-list. `.translation` is not on it, so a delegated `l10n.table` is PO, CSV or JSON text.
- **Which SDK holds what** is a typed answer: `supports("packs.type.<type>")` returns the
  registry's `runtime` N/A where an SDK ships no handler (`godot.zip` outside Godot, `audio.bank`
  outside Godot, `ml.model` in Godot), and installing such a pack raises `pack-type-unsupported`.
  `data.json` and `l10n.table` handlers are built in; `ml.model` and `audio.bank` need the host to
  register one with its budget or middleware, since only the host knows them.

## The delivery gate

Who may download a pack is the **pack's own** delivery access row (Distribution → Access), owned
by an operator from the start and never inherited from the app's. Its licence flag
(`entitlement`) is the pack's **gate**. `.pkey/release`'s `entitlement` only **asserts** it: a
publish whose gate differs from the assertion is refused, so a paid pack the operator has not
gated yet fails closed, and no push can gate, un-gate or re-flag a pack. CI learns the gate from
the uploads preflight, stages every object under it (`gated/` exactly when it is set) and signs
it into the pack record. While Distribution is off, every pack publish is refused
(`distribution_disabled`).

## Publishing a pack

A pack release **is** its CI-signed record (`pkey-release+jws`, `kind: pack`): no descriptor.
Every object it names — the whole payload, each variant's files index and gaps, its deltas — and
every file blob its indexes name is a blob of the product's store. Publishing is:

1. **Preflight**: `POST /<product>/release/publish/uploads` with `releases` and no `objects`
   answers each release's `seq`, an existing release's `recordSha256` and the pack's gate,
   without issuing a ticket.
2. **Stage rounds**: for each batch of at most 256 objects, an `uploads` ticket, the uploads,
   then `POST /<product>/release/publish/stage` `{ticket, deliverable}`. A round verifies each
   staged object, refuses one whose `gated` flag differs from the gate, promotes it and records
   a `pack-upload` reference of the pack: the product now holds those bytes. A pack's ticket
   names its pack (`deliverable`), and an object is `present`, so skipped, only when **that pack**
   uploaded it; one another pack of the product holds is uploaded again (its stored bytes are
   not rewritten), so a renamed pack, or two packs sharing bytes, earns its own references.
3. **The record**: `POST /<product>/release/publish/submit` `{record, ticket?, dryRun?}`. A small
   pack can carry its objects in this ticket and publish in one request.

`pkey release publish --deliverable <packId>` (and the `polaris-key/publish` Action) runs all
three: it strips and lints each variant's payload, builds the objects and deltas, signs the
record and writes a marker beside each payload; `pkey release content-stamp` writes the stamp an
app build embeds. See [Publishing a pack](/docs/build/ci/#publishing-a-pack).

Ingest checks the record against the declaration and the store, refusing with
`release_record_rejected` and a `reason`, in this order: the checks every record shares (`typ`,
`kid`, `product-key`, `signature`, `claims`), then `pack-unknown` (not a declared pack),
`scheme`, `seq` (not above the pack's last), `pack-type`, `pack-variant` (an axis or value the
declaration lacks), `pack-requires` (a variant's signed `requires.contentApi`, `requires.packs`
or `conflicts` disagrees with the binding or names an undeclared pack), `pack-channel` (a channel
the pack does not publish to), `pack-entitlement` (not the gate, or not the assertion),
`pack-index`, `pack-object`, and finally the resolution check below
(`pack-unsatisfiable`). Each files index is read from the blob store, decoded and parsed one at a time,
at most 8 MiB each and 64 MiB per record; every object and file blob must be stored with its
recorded length under the product's own references and the pack's prefix. A pack release's id is
`<packId>@<version>`; its variants are builds (`build_id` the variant key, `default` for none)
and its objects artifact rows (`payload`, `files-index`, `files-gaps`, `delta`, `patch`,
`patch-data`, `chunk-index`).

### Chunk indexes and shared bundles

Every container variant (a `godot.pck`) of 4 MiB or more gets a **chunk index** when the pack's
`patch.strategies` lists `chunk` (the default lists every strategy; an explicit `[delta, file]`
opts out) and the Worker's discovery advertises `release.chunks`. CI cuts the payload into
chunks of about 64 KiB with FastCDC (`fastcdc-2016-nc1`), never across two entries of the PCK,
stores each chunk as one `zstd -19` frame (or raw when that is not smaller) and packs them into
**bundles** of about 4 MiB. The variant's signed `chunks` names the `pkey-chunks/1` index, which
lists every chunk's hash, length, bundle and offset; an SDK that has an earlier release's index
fetches only the chunks it lacks, in a few `Range` requests (P4-11). The parameters are frozen
per release and signed as `chunks.params`; they are not configurable.

Bundles are **shared along a chain**: one pack, one variant key, one gating class. CI keeps each
published index in its `--out` cache (`<variant>/chunks.<sha256>`) and, on the next publish with
`--bases`, continues the chain from the newest proven cached release of the same gating class: a
chunk that index already holds keeps its location, provided an upload ticket reports its bundle
`present`; every other chunk goes into new bundles. So an N−1 update is the index plus about one
bundle run. A lost cache, a gate change or a missing bundle only costs storage: those chunks are
packed fresh from the payload. A gated and a free pack never share a bundle. An index above
8 MiB is not published: the variant ships without `chunks` and the publish warns.

Bundles are blobs (`blobs/sha256/<hex>`, or under `gated/`), uploaded in stage rounds like every
other pack object and served by the blob route with `Range`; they get no artifact rows. Ingest
also refuses, as `pack-index`, a chunk index over 8 MiB or of an unknown `format` (before
anything is read) or one client-core's `parseChunkIndex` rejects against the variant's payload;
and, as `pack-object`, an index or a bundle in its table that is not stored with that length and
held by **this pack's** own upload (`pack-upload`) under the pack's prefix: a reference held by
another pack, or by a release, does not count. A dry run lists an index neither stored nor staged,
and a bundle not yet held, in `unverified`. The blob collector keeps every bundle a live
release's index names, an older release's bundle included (see
[Garbage collection](/docs/services/distribution/delivery/#garbage-collection)); each live
chunked variant costs the collector two index reads from its per-tick budget (its files index and
its chunk index). Repacking bundles whose live share has dropped has no owner yet.

## App releases: content, pins and embeds

An app release carries `content` — its `contentApi`, the pack releases it **pins** (by record
hash, `seq` and version) and the packs it **expects** (with `required` and `delivery`) — and each
build its `embeds`. They live in the release descriptor and move unchanged into the signed
record, so the record's packs are exactly the descriptor's. Ingest refuses with
`release_record_rejected`:

| Reason            | When                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| `content-api`     | the product declares packs and the release has no `content`                      |
| `pin-unknown`     | a pin names no ingested record                                                   |
| `pin-mismatch`    | the pinned record is not that pack, version or `seq`                             |
| `pin-yanked`      | the pinned pack release is yanked                                                |
| `pin-revoked`     | the pinned pack release is revoked (P4-13)                                       |
| `pin-missing`     | an expected, `required` or embedded-baseline pack has no pin, or a pin no expect |
| `pin-gated`       | a `required` expect pins a gated pack release                                    |
| `embeds`          | a build embeds a pack the release does not pin                                   |
| `pack-unreadable` | a declared pack's stored declaration does not read back; resync the manifest     |

Every expected **pinned** pack is pinned; an expected compatible or standalone pack needs no pin
(it comes from the resolved sets) unless a build embeds it as a baseline. Release mirrors the
pins into `release_pins` (never edited afterwards), the `contentApi` and `packChannels` into the
release and each build's `embeds`. **Yanking** a pinned pack release stops new pins; app
releases that already pin it keep it until an app release replaces it.

An app release may also **hold** a compatible pack at one release (`content.holds`, a pin's
shape plus an optional `reason`): "1.5.2 keeps `foes@1.4.3` because 1.4.4 breaks a quest". Holds
are signed like pins; devices apply them over the resolved set, and Release mirrors them into
`release_holds`.

## Resolution: compatible and standalone packs

On every publish, pointer move, floor change, yank and resync, Release re-resolves the product's
**pack sets** and replaces them in one batch:

1. **Live app releases**: every non-yanked app release a channel serves (with its `includes`,
   so beta ⊇ stable) that carries a contentApi and is at or above the channel's floor. The floor
   decides, never store availability: Release never reads Distribution.
2. **Selectors**: one set per (channel, app deliverable, live contentApi level, platform of the
   live builds, engine those builds declare — empty when they declare none). During an engine
   bump the players of the older engine keep their set and the newer engine gets its own.
   Variants are projected per **group**: packs with the same variant axes, merged with every pack
   a dependency or conflict ties them to. Each group is a row per combination of its own axes
   (`locale=fr`, `texture=astc`, empty for a group without axes), and a device's set is one row
   per group, the one its variant projects onto. Rows grow as the sum over groups, not the product
   of every pack's axes.
3. **Per pack**, the newest release (by its version scheme, ties by `seq`) on the pack's channel
   (the app channel, or the one `packChannels` routes it to) that passes, in order: its
   `requires.contentApi.app` range holds the level (compatible only); it runs on the selector's
   engine; it carries the row's variant; it is at or above the pack's floor.
   Yanked releases resolve only as a pinned pointer.
4. **The solver** keeps `requires.packs` ranges and `conflicts`, backtracking highest-first in
   pack-id order, one **component** at a time (packs a dependency or conflict links): a pack is
   left out only when its own component cannot keep it, and then as few packs as possible. One
   work budget covers the whole resolution; past it (or past 4,096 rows) a publish fails
   (`pack-sets-bound`) rather than guess.

A pack nothing satisfies at a selector is stored in the set's `unsatisfied` list with a reason —
`no-release`, `content-api`, `engine`, `variant`, `content-floor`, `dependency` or `conflict` —
so a floor with no backport deliberately blocks an old content line. Each set has a
content-addressed `packSetId` (the same function devices use for their active set), shared by
identical sets. `pinned` packs never enter a set: they are in the app's own signed record.

A trigger whose resolution fails — the bound, or an error — never refuses the yank, floor change,
pointer move or resync that caused it. It **fails closed**: the product's sets are cleared, so no
stale set (which might still hold a release just yanked) survives, an audit row
`release.pack_sets.failed` is written, and the response carries `packSets: {ok: false, reason}`.
Two triggers racing cannot leave the older resolution stored: each write claims the generation it
resolved from, and the loser re-resolves.

## Floors per contentApi line

A pack floor is set per contentApi line, so a fix can be backported to an older content line
instead of stranding its players: "foes ≥ 1.3.4 for contentApi 3". It is operator-owned: the
console's `PUT …/release/channels/{channel}` with `{deliverable, contentApi, minSupported}`
(`minSupported: null` clears it). A floor that leaves a line with no release is never refused;
the set stores `content-floor` instead. A pack's level-free `minSupported` applies as well.

## Publish checks, both ways

Both checks re-resolve with the release in place and refuse with `release_record_rejected`, the
message naming the selector and the constraint:

| Reason                   | When                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pack-unsatisfiable`     | a pack release lacks the variant of a live selector it is meant for, is passed over for an older release because it breaks a dependency or a conflict, or breaks a live app release's holds (a release for a coming engine is not) |
| `pin-requires`           | a pinned release's signed requirements exclude the app release (its contentApi range, or no variant for a build's engine)                                                                                                          |
| `hold-unknown`           | a hold names no ingested record                                                                                                                                                                                                    |
| `hold-mismatch`          | the held record is not that pack, version or `seq`                                                                                                                                                                                 |
| `hold-yanked`            | the held pack release is yanked                                                                                                                                                                                                    |
| `hold-revoked`           | the held pack release is revoked (P4-13)                                                                                                                                                                                           |
| `hold-binding`           | the held pack is not `compatible`                                                                                                                                                                                                  |
| `hold-requires`          | the held release's signed requirements exclude the app release                                                                                                                                                                     |
| `hold-unsatisfiable`     | the app release's set with its holds substituted breaks a dependency or a conflict                                                                                                                                                 |
| `content-unsatisfied`    | a `required` compatible or standalone pack has no release at one of the app release's selectors                                                                                                                                    |
| `pack-channels-conflict` | the app release's `packChannels` differs from another live app release's on the same channel and contentApi (a mapping change needs a contentApi bump)                                                                             |
| `pack-sets-bound`        | resolution cannot finish inside its bounds                                                                                                                                                                                         |

During an engine bump (CONTENT §6.8 row 7) an app release on the new engine is refused
`content-unsatisfied` only for a **`required`** pack with no release for that engine yet; an
optional one is simply listed `unsatisfied` (`engine`) until its release exists, and the players
of the older engine keep their set throughout.

Either submit, dry run or not, answers `packSets`: the resulting sets with the selectors and app
releases that receive them, and every selector whose set changed. `dryRun: true` writes nothing.

## Save compatibility

Saves reference **content ids**, never paths, so a pack release that silently stops shipping an
id breaks players' saves. Three guards turn that into a CI failure (P4-20, CONTENT §6.7 item 8).

**1. `provides` and `removes` at publish.** A pack release may list the content ids it provides.
CI writes the list as a JSON array (for example `.pkey/provides.json`, generated from the game's
content registry) and `pkey release publish --deliverable <packId>` signs it, sorted, into the
record's `provides`. Ids are opaque: printable ASCII without spaces, 1–128 characters, at most
4,096 distinct (Diceroll's ~1,200 ids take about 22 KB of the 64 KiB record). The pack's
declaration names the file and whether it is mandatory:

```yaml
diceroll.foes:
  kind: pack
  type: godot.pck
  binding: compatible
  requires: { contentApi: { app: ">=4" } }
  provides: { required: true, from: .pkey/provides.json }
```

`--provides <file>` overrides `from`. Polaris Key compares each release with the deliverable's
previous one, at every live contentApi level both support:

| Reason             | When                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `provides-dropped` | an id the previous release provided is neither provided nor acknowledged in `removes`; the message names the ids and the levels             |
| `pack-provides`    | `provides` or `removes` is not a list of distinct content ids, or the release has no `provides` while the pack declares `provides.required` |

To retire an id on purpose, acknowledge it for that one release: `--removes foe.troll` (repeat
the flag, or separate ids with commas). A release whose contentApi range shares no live level
with its predecessor's is a contentApi bump, and nothing is compared. Two releases without a
range (`pinned`, `standalone`) are always on one line. A `removes` id the previous release never
provided, or one this release still provides, comes back in the answer's `warnings`. The check
runs on the dry run too, before anything is promoted.

The comparison is per channel: a release is compared only with its own channel's previous
release (`stable` when it names none), so a beta release never moves stable's baseline. Beta
players also receive stable releases through `includes`, so when a stable release outranks beta's
newest (1.1.0 graduating past 1.1.0-beta.1), ids only beta provided are **not** protected. That is
intentional: a prerelease channel carries no save-compatibility promise, and comparing across
channels would force false `removes`. Polaris Key answers a warning instead (`beta currently
serves foe.dragon …, which djdl.foes@1.1.0 does not provide; beta players will lose it when this
release outranks beta's`), and `pkey release publish` prints it.

**2. `isAvailable` and `packFor` on the device.** Every SDK answers from the verified records'
`provides`, so a game can show "Continue (downloading 12 MB…)":

- `isAvailable(contentId)` (Godot `is_available`) is true when a pack in the **active** set provides
  the id: mounted this boot for a restart pack, active for a hot one, embedded baselines included.
- `packFor(contentId, targets?)` (Godot `pack_for`, Python `pack_for`) names the pack and release in
  the **target** set (the content stamp's pins, or a `packs` decision's install list) that provides
  it, reading only records, so the game can `estimate` and `ensure` that pack.

A revoked release, a target whose record cannot be fetched or verified, and a pack the licence
is not entitled to never answer.

**3. The content-interface fingerprint.** `contentApi` bumps are a discipline. On the app publish,
`--content-interface <registry.json>` hashes an explicit registry of what the code references
(for Diceroll, its content-id registry and the path prefixes it loads) as the SHA-256 of its
canonical JSON, stores it with the release as unsigned metadata (never in the signed record),
and compares it with the channel's current app release: a changed fingerprint with an unchanged
contentApi is a warning, and `--strict` fails the publish before anything is uploaded. Deriving
the registry from a Godot project automatically is still an open question; export it yourself.

## Revocations

A revocation (P4-13, `kind: revocation`) is a release record signed in CI by a **release key**,
never by a product key and never by a delegated content key. It names the revoked pack record by
hash (`revokes`) and may name a replacement of the same pack. `pkey release revoke
<packId>@<version> [--replacement <version>] --reason <text>` signs and submits it on the same
submit route; it needs no ticket and no descriptor. Ingest checks, in order, refusing with
`release_record_rejected`:

| Reason                                | When                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `revocation-body`                     | the body is unusable: not a pack id, `revokes` not 64 hex, a bad replacement, or a `reason` outside 1–512 bytes                                        |
| `revocation-target`                   | the target is not a stored `kind: pack` record of that pack, version and `seq`                                                                         |
| `revocation-stale`                    | the target already has a revocation with a newer `issuedAt` (ties: the higher record hash)                                                             |
| `revocation-replacement`              | the replacement is not a stored, non-yanked, non-revoked record of the same pack                                                                       |
| `revocation-replacement-incompatible` | the replacement does not cover the target: a variant key or engine is missing, or a live (or pinning or holding) contentApi level is outside its range |

Revocations are permanent: a resubmit of the same bytes changes nothing, and a newer revocation
of the same target updates the stored one (adding or changing the replacement) but can never
remove the revoked status. Ingest also yanks the target, so even a rolled-back Worker stops
serving it (and the console refuses to lift that yank, `release_revoked`), and resolution drops revoked releases from every candidate list. The feed lists the
revocations in force; devices fetch each record and verify it against their pinned release keys.

## Content keys (delegation)

A release key can delegate a **content key** (P4-19): a key that may sign pack releases only of
data-only types (`files.tree`, `data.json`, `l10n.table`), only for compatible or standalone packs
under one pack-id scope, and only inside a signing window of at most 366 days. The grant is a
CI-signed `kind: delegation` release record; `.pkey/release` does not declare content keys (an
unsigned manifest cannot grant trust, so `release.contentKeys` only warns). The format is on
[Pack byte formats](/docs/build/wire/packs/#delegated-content-keys-and-the-data-only-rule).

The CLI flow, with no key ever stored by the Worker:

1. **Generate the content key**: `pkey release keys generate --content --out content.pem` writes an
   Ed25519 PKCS#8 PEM (mode 0600, never over an existing file) and prints its public key. Keep the
   PEM in the content team's CI environment as `PKEY_CONTENT_KEY`.
2. **Delegate**: `pkey release delegate --prefix <packId> --types files.tree,data.json
--public-key <b64url> [--expires-in <days>] [--notes <text>] [--dry-run]`, run with
   `PKEY_RELEASE_KEY`. It reads the product's delegations first, refuses a key any delegation
   already names (one key, one delegation) or a declared release key, takes the next `seq`, signs,
   self-checks and submits. It prints the delegation hash, the content kid (`pkd1-…`) and the
   window. The default window is 180 days. When the submit fails after signing, the signed
   delegation is written to `./pkey-delegation-<sha256>.jws` so it can still be revoked.
3. **Publish content**: `pkey release publish` for a pack, with `PKEY_CONTENT_KEY` (or
   `--content-key-file`) and `--delegation <sha256>`. It verifies the delegation against the
   declared release keys, checks the key, scope, type and binding, runs the data-only rule and the
   tree lints over every file, signs with the derived kid and submits through the usual uploads
   preflight and ticket. It warns within 14 days of the window's end, and refuses a release key and
   a content key together. The publish Action takes `content-key` and `delegation` instead of
   `release-key`.
4. **Revoke**: `pkey release revoke --delegation <sha256 | file> --reason <text>`, with the release
   key. Given a file holding a delegation the Worker never stored, it submits the delegation
   alongside the revocation, so a delegation minted outside CI can still be revoked.

`POST /{product}/release/publish/delegations` (publisher bearer, scope `release:publish`, body
`{"deliverable"?: "<scope root>"}`) lists the product's delegations: each one's hash, scope root,
`seq`, key fingerprint (the hex SHA-256 of the raw key), window, origin (`submit` or `revocation`)
whether it is revoked, its `version` and its compact JWS (`jws`), plus `nextSeq` when a scope
root is given. It needs no blob store. The CLI reads a stored delegation's JWS here, behind the
publisher token, for a content-key publish and for `revoke --delegation <sha256>`, so both work on
a product whose release metadata is not public.

Ingest refuses, with `release_record_rejected`: a delegation whose body is unusable or lists a
non-delegable type (`delegation-body`), whose key is a release key, a product key or any stored
delegation's key (`delegation-key`), whose `seq` does not follow (`seq`), or whose window is not
open (`delegation-window`); a delegated pack release whose delegation is unknown or revoked
(`delegation-unknown`, `delegation-revoked`), whose key is a product or release key, that is
outside the scope, types or tree layout (`delegation-scope`), outside the window or backdated by
more than a day (`delegation-window`), of a pinned pack (`delegation-binding`) or holding a file the
extension allow-list refuses (`delegation-data-only`); and an app release that pins or holds a
delegated release (`pin-delegated`, `hold-delegated`). Revoking a delegation yanks every release
signed under it, and the feed lists the revocation with `kind: "delegation"`.

Rotate by generating a new key, delegating it, re-publishing what must survive, then revoking the
old delegation; renewing an expiring window is the same flow, and installed releases need no
re-publish. Adopt delegation only once every live app build you care about embeds an SDK that
verifies it: older builds simply never install delegated releases.

## In the console

Packs appear in the Release section beside the app; there is no separate content section.

- **Deliverables** lists the app and every declared pack: kind, pack type, binding, whether it is
  required, its embedded baseline, its delivery, its gate and its latest release. A `pinned` pack
  that no app release pins is flagged **Not pinned by any app release**: it reaches no device
  yet. (A compatible or standalone pack reaches devices through the resolved sets instead, so it
  is not flagged.) When the gate differs from the entitlement the latest release signed
  (an operator gated or un-gated the pack after publishing), both are shown; devices follow the
  signed one until the next publish.
- **A pack's page** lists its releases newest first, with version, `seq`, channel and yank, and
  for each release **which app releases pin it** (an app release that is itself yanked is
  marked). A yanked pack release keeps its pins, so check this column before yanking. Expanding a
  release shows each variant's engine, payload size, full-download bytes and its delta menu (each
  delta's base version and download bytes), as the signed record gives them, and a variant's
  files on request.
- **Compatibility** sets app releases against pack releases, each cell pinned, held, compatible,
  incompatible or revoked, with the live contentApi levels and per-outlet liveness, and
  simulates what a device running one app release on one outlet gets
  ([Compatibility and the device simulator](/docs/services/release/compatibility/)).
- **Releases**: an app release's expanded row shows its `contentApi`, the pack release it pins
  for each pack (with `required`, `delivery` and whether the pinned release is yanked) and an
  **Embeds** column, the packs each build ships embedded.

- **Content keys** lists each delegation: its scope, types, `seq`, window and status (`active`,
  `closed` or `revoked`), the release key that signed it, the content key's fingerprint, how many
  releases it signed and its revocation. Each pack release also shows its signer: the release key,
  or the delegation it was signed under. Minting and revoking are CI acts, so there are no
  controls.

Everything here is read-only. The console never shows where a pack's objects are stored, only
their sizes and hashes. Its admin routes, all under `/manage/api/products/<slug>/release/` and
behind the same platform-admin session as the rest of the console:

| Method and path                                                  | Answers                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET deliverables`                                               | `deliverables[]` (the app first, then packs by id) with their declaration, `gate` and `latest`, and `gateKnown` (false while Distribution is off).                                                                                                                         |
| `GET deliverables/<id>/releases`                                 | A pack's `releases[]`, newest first (at most 100), each with its `variants[]` (sizes and `deltas[]`), `yank` and `pinnedBy[]`. 404 for the app or an unknown id.                                                                                                           |
| `GET deliverables/<id>/releases/<releaseId>/files?variant=<key>` | One variant's files (`variant` empty for an unvaried pack), read from its files index one index per request: `files[]` (path, size, SHA-256, offset, blob size and codec; at most 2,000) and `total`. 404 when the release is not that pack's or its index cannot be read. |
| `GET releases`                                                   | The app's releases ([Channels](/docs/services/release/channels/)), each with its `contentApi` and `pins[]` and each build's `embeds`.                                                                                                                                      |

## Reading packs

Other services read packs through Release's catalog hook: the declared packs, a pack release with
its variants and objects, a variant's files (read from its index), what an app release pins,
which app releases pin a pack release, and what a build embeds; and, for resolution, a channel's
live contentApi levels, its stored pack sets, its floors per contentApi line, what an app release
holds and which app releases hold a pack release; and the chunks a variant reads from bundles
(read from its chunk index). Discovery's Release fragment carries `packs: true` on a Worker that
ingests packs; `pkey release publish` refuses to publish a pack or stamp `content` without it.
It carries `chunks: true` on a Worker that ingests chunk indexes; without it the publish omits
`chunks`.

## Delivering packs

Distribution serves a pack's objects by SHA-256 on the blob route, under the pack's own
delivery access and, for a gated pack, its current gate; a pack's files are never served by the
`files` or `builds` routes. For a browser, a container's payload and its deltas are also served
decoded by the payload URL, with Compression Dictionary Transport
([Web deltas](/docs/services/distribution/delivery/#web-deltas-the-payload-url)). Each outlet's transport for the pack (`pkey-cdn`, `web` or
`embedded` in v1) decides where it is live. See
[Pack bytes](/docs/services/distribution/delivery/#pack-bytes) and
[Availability](/docs/services/distribution/availability/).

## Installing packs on a device

A build learns its pins from the **content stamp** (`pkey-content.json`) it ships, never from the
network: a build without one has no packs. The SDK fetches each pinned pack record by hash,
verifies it against the app's pinned release keys, picks the variant for the device, plans the
cheapest way from what is installed (a delta, the changed files, or the whole payload), verifies
every byte against the record and swaps the installed release atomically. Embedded baselines are
verified once from their markers and then count as installed. Devices report the id of the pack
set they run (`content.packSetId`) on `devices/report`.

The install state is never trusted from storage. Every load re-verifies each pack record and
re-hashes the active and previous payloads. When the state document itself cannot be trusted,
the SDK reports it as `state().stateIssue` and emits a `state-issue` pack event:

- **`torn`**: the document exists but does not parse (a write cut short). It is kept aside as
  `state.json.torn`. The payloads that existed when the hold started are never collected until
  an operator calls `recoverState()`; anything installed and later dropped during the hold is
  collected as usual. The installs the torn document named are not recovered: `ensure`
  reinstalls them, reusing their content-addressed payloads.
- **`unreadable`**: the document could not be read (an I/O or permission error, not a missing
  file). Nothing is fetched, written, installed or collected in that process: `ensure`,
  `estimate`, `confirm` and `rollback` raise `pack-state-unreadable` until a restart can read it.

A payload whose check fails with an I/O error stays in the state and on disk, out of use for that
load, and comes back on the next load that can read it.

Revocations reach a device through the signed feed. The update check fetches each revocation that
names a release the device runs, pins, holds or would take from the feed, verifies it against
the pinned release keys, and the pack engine keeps the winner per target in a sibling
`revocations.json` beside `state.json` (at most 256 targets). A revoked release is never
installed, activated or mounted (`pack-revoked`), embedded baselines included; a revoked
optional pack is unmounted and play continues, and a revoked **required** pack with no usable
replacement stops the boot (see [Signed feed](/docs/services/update/signed-feed/)). A torn
`revocations.json` puts the stamp's packs in `relearn`: their embedded copies are refused until
a fresh feed re-teaches their revocations, or `recoverState()`. A product that has never had a
revocation has no `revocations.json` and nothing is refused.

- Node: `client.update.packs` — see the [Node SDK](/docs/build/sdks/node/).
- Web: `createBrowserPacks` (OPFS storage) — see the [React SDK](/docs/build/sdks/react/).
- Python: `client.update.packs` — see the [Python SDK](/docs/build/sdks/python/). zstd comes from
  the standard library's `compression.zstd` on Python 3.14 and from `zstandard` (a dependency
  below 3.14) on 3.9–3.13.
- Swift: `update.packs` from the cross-platform `PolarisKeyPacks` target (macOS and iOS, libzstd
  1.5.7) — see the [Swift SDK](/docs/build/sdks/swift/).
- Godot: `PolarisKey.update.packs` — see the [Godot SDK](/docs/build/sdks/godot/). A pure-GDScript
  port over the same conformance vectors, with the `godot.pck` handler: a rebuilt pack is checked
  against the same admission list as the publish lint before it commits (including the
  reference check: an app script or UID a pack attaches must be listed in
  `PKeyOptions.pack_attachable`, as in `deliverables.app.content.attachable`), and mounted at a boot
  from `user://pkey/store/<sha256>.pck`. `--patch-from` frames are decoded by Godot's own delta
  decoder, so `zstd-patch-from` is advertised on Godot 4.6 and later only. The content stamp is
  `res://pkey_packs/pkey-content.json`, beside the embedded baselines.
- The [pack-type](#pack-types) handlers: `DataJsonHandler` and `L10nTableHandler` are built in
  (register your own instance for its `documents(packId)` or `tables(packId)` and its
  `onActivate` callback, or for other format versions), and `MlModelHandler` is registered by the
  host with `runtimes`, `ramBytes`, optional `vramBytes`, `quantizations` and a `loadTest`, after
  which `model(packId)` names the live model. Python spells them `DataJsonHandler`,
  `L10nTableHandler` and `MlModelHandler(runtimes=…, ram_bytes=…, load_test=…)`. In Godot,
  `PKeyDataJsonHandler`, `PKeyL10nTableHandler` (through `TranslationServer`) and
  `PKeyGodotZipHandler` are built in, and the game registers
  `PKeyAudioBankHandler.new({"middleware": "fmod", "version": "2.02.22", "reload": …})`. A game's
  `custom.<name>` handler is registered with `registerHandler` (`register_handler` in Python and
  Godot) and may refuse a staged payload from its `check`.
- Every SDK runs the content decision and keeps revocations (P4-13, P4-23, P4-24). In Godot,
  `PolarisKey.update.decide()` runs it whenever the build ships a content stamp, the revocations
  live in `user://pkey/content/revocations.json`, and `PKeyBoot` stops at BLOCKED with the
  revoked-content copy when a required pack is revoked with no fix.
