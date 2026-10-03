# P4-16 More pack types in every SDK: `l10n.table`, `data.json`, `audio.bank`, `ml.model`, `custom.*`

| Field       | Value                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v3)                                                                                                                                                                          |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                    |
| Depends on  | [P4-06](P4-06-client-core-packs.md), [P4-07](P4-07-python-swift-packs.md), [P4-08](P4-08-godot-packs.md)                                                                                |
| Unblocks    | none                                                                                                                                                                                    |
| Role        | `pkey-sdk-porter`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                      |
| Gates       | none in the graph; in practice rule 9 (the v1 validator accepts only `godot.pck` and `files.tree`, and P4-01 names this package to widen it); per-type corpus vectors would need a plan |
| Human input | none                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                               |

## Goal

Each SDK ships handlers for the v3 pack types it supports, per the [CONTENT §13](../../CONTENT.md#13-per-sdk-integration)
table, implementing the full handler contract with the type-specific verification of
[CONTENT §4.2](../../CONTENT.md#42-initial-type-registry). Every other (SDK, type) pair returns a
typed "unsupported here" result that the parity registry allows. `custom.<name>` works end to end
in every SDK through `registerHandler`, and the CLI lints the new types at publish.

| SDK         | Handlers added here                                              |
| ----------- | ---------------------------------------------------------------- |
| Godot       | `godot.zip`, `l10n.table`, `data.json`, `audio.bank`, `custom.*` |
| Swift       | `ml.model`, `data.json`, `l10n.table`, `custom.*`                |
| Node        | `ml.model`, `custom.*`                                           |
| Python      | `ml.model`, `data.json`, `custom.*`                              |
| React / web | `data.json`, `l10n.table`, `custom.*`                            |

`files.tree` (and, for Godot, `godot.pck`) come from v1 (P4-06, P4-07, P4-08). If a v1 package
did not deliver `files.tree` in an SDK that CONTENT §13 lists for it, add it here. `godot.zip` is
here because P4-08 routes it here; P4-03 notes that no v1 package owns it.

## Why

v1 and v2 carry Godot PCKs and file trees. Localisation, event data, audio banks and ML models are
what make packs useful beyond Diceroll's art ([CONTENT §6.8](../../CONTENT.md#68-diceroll-worked-through):
French localisation as a `standalone` `l10n.table`, events as `data.json`), and README P4's v3
outcome is "localisation, events and supporter packs". Types are plugins (CONTENT principle 4),
so this is per-SDK handler work over the shared transport, patching, signing and GC.

## Read first

- `AGENTS.md`; [PARITY §2.2](../../PARITY.md#22-typed-unsupported-here) (typed N/A) and
  [§5.6](../../PARITY.md#56-packs) (`packs.handlers`).
- [CONTENT §4.1](../../CONTENT.md#41-handler-contract-every-sdk) (hooks), [§4.2](../../CONTENT.md#42-initial-type-registry)
  (payload, activation, strategies, type checks), [§8.3](../../CONTENT.md#83-godot-measured-pure-gdscript-472)
  ("loose files hot-load cheaply"), [§13](../../CONTENT.md#13-per-sdk-integration).
- [README §5.7](../../README.md#57-packs-at-runtime) (Godot handlers and hot activation).
- The handler registry and `registerHandler` in `client-core` (P4-06), Python and Swift (P4-07) and
  Godot (P4-08); the CLI pack lint (P4-03) in `packages/cli/src/`; the `type` rule in the
  `.pkey/release` validator (P4-02) in `packages/shared-manifest/src/index.ts`.

## Scope

**In:**

- The handlers in the table, each implementing `formats()`, `plan`, `stage`, `verify`,
  `activate`, `deactivate` (hot types), `rollback`, `uninstall` and `roots()`.
- Type-specific verification (below) and typed N/A results for unsupported pairs.
- `custom.<name>` end to end: registration, opaque file or tree payload, the game's activation.
- CLI lints per new type in `pkey release publish`.
- Widen the `.pkey/release` `type` rule that P4-02 limited to `godot.pck` and `files.tree`
  (rule 9: validator rule, mutation-table entry, schema, regenerated `validation-codes.mdx`).
- `parity.json` entries and tagged tests for each SDK.

**Out** (and where it belongs instead):

- `unity.addressables` (→ [X-01](X-01-dotnet-sdk.md)).
- Per-type verify vectors in the content corpus, which CONTENT §16 lists for v3: a corpus change
  needs a plan and no package owns it yet (see the report). Unit tests per SDK cover this here.
- Delivering an `archive.zip`/`archive.tar` _as an archive_ (stored entries, deterministic re-zip)
  when a consumer needs the archive itself: not scheduled. Archives are build inputs that CI
  delivers as `files.tree` (CONTENT §4.2).
- Middleware integrations (FMOD, Wwise) beyond version checks and file placement.

## Design notes

- **Type checks** (CONTENT §4.2):
  - `godot.zip`: as `godot.pck` (engine, directory check, restart activation), but tolerated, not
    preferred: zips cannot express removals, ignore `replace_files` and cannot be mounted at an
    offset. Strategy `full`; `chunk` only for stored entries. The CI lint requires stored entries
    and the same data-only rules as P4-03's `godot.pck` lint.
  - `l10n.table`: a BCP-47 locale matching the variant, and a key-schema version the handler
    supports. Hot activation; in Godot through `TranslationServer` (remove the previous
    translation on swap). Strategy: full, compressed on the wire; delta only for large tables.
  - `data.json`: the JSON Schema version (`formatVersion`) must be one the handler lists. Hot.
    Parse strictly (the Godot parser accepts trailing commas and keeps the last duplicate key;
    reuse the strict parser P1-02 added). Tiny, frequently tuned values belong in managed config,
    not a pack; say so in the docs.
  - `audio.bank`: the middleware version. Hot if the middleware can reload, otherwise restart.
    Strategy: chunk, then full.
  - `ml.model`: runtime, quantisation, and RAM/VRAM needs against the device's `memBudget`. Hot:
    swap the path only after a host-supplied load test passes. Chunk with a larger average chunk
    (a CI parameter), then full.
  - `custom.<name>`: the server treats the payload opaquely; the game registers the handler
    (`PolarisKey.update.packs.register_handler("custom.dialogue", MyHandler.new())` in Godot;
    `registerHandler` elsewhere). Transport, patching, signing and GC come for free.
- **Hot types** stage into a versioned directory and swap a pointer (the `files.tree` pattern),
  so rollback is re-pointing. Godot hot types load from `user://` in 0.1–4 ms (CONTENT §8.3).
- **Capabilities.** Each handler's `formats()` feeds the `types` capability the planner and
  telemetry read. An unsupported type yields the registry's typed reason (`runtime`, `platform`,
  `dependency` or `version`), never a silent skip.
- **Path rules and data-only** from v1 still apply to every tree-shaped payload; `custom.*` does
  not relax them.
- **CI lints** (added to P4-03's lint): `l10n.table` locale tag valid and matching the variant;
  `data.json` strict JSON with a declared `formatVersion`; `ml.model` declares runtime and memory
  needs; `audio.bank` declares the middleware and version; `custom.*` has no content lint beyond
  path rules and size.
- **Signing.** Nothing changes here. Content-key delegation for data-only types is P4-19, and
  whether each new type counts as data-only is decided there.

## Steps

1. Confirm what v1 delivered per SDK (handler registry, `files.tree`, `registerHandler`), then
   write each missing handler against a shared fixture set (one small payload per type).
2. Godot handlers (hot activation via `TranslationServer`, `FileAccess`, `load_from_file`).
3. Swift, Python, Node and React handlers.
4. CLI lints; widen the manifest `type` rule if needed.
5. `parity.json`, docs for adopters (types and their checks), the green gate.

## Acceptance criteria

- [x] Each SDK has tests per new handler: stage, verify, activate, rollback, uninstall, and one
      rejection each (wrong locale, `formatVersion` too new, model memory above budget, bank
      middleware mismatch).
- [x] A `custom.dialogue` pack installs end to end in every SDK against a fake server with a
      game-registered handler, and its payload passes the same path rules as `files.tree`.
- [x] Unsupported (SDK, type) pairs return the typed N/A the parity registry allows;
      `pnpm parity:check` passes (once P1b-01 has landed).
- [x] `pnpm --filter @polaris-key/cli test` covers the new lints.
- [x] If the manifest `type` rule changed, `schema-parity.test.ts` passes with the new entries.
- [x] The green gate passes (`AGENTS.md`), including pytest, `swift test` and the Godot runner.
- [x] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift test )
# Godot: the headless runner on the editor and a release template
```

## Hand-off

- Diceroll's `diceroll.l10n` (`standalone`, `l10n.table`) and `diceroll.events.*` (`data.json`
  alongside `godot.pck`) rely on the Godot handlers (D-04 and later Diceroll work).
- **P4-19** decides which of these types a delegated content key may sign.
- **X-01** adds `unity.addressables` against the same handler contract.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-16 done`.

## Plan amendments (P4-19)

The approved [`plans/P4-19.md`](../plans/P4-19.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Corrections from implementation

The code is the fact; where this brief and the code differ, the code (and this section) wins.

- **Support matrix.** `data.json` and `l10n.table` ship in every SDK, and `ml.model` in React and
  Node too. The TypeScript handlers are client-core code shared by Node and React, and a
  `runtime` N/A for a type the runtime can plainly hold would be untrue (PARITY §2.2). Python
  gained `l10n.table` for the same reason. The typed N/As are `godot.zip` and `audio.bank`
  outside Godot, and `ml.model` in Godot.
- **Registry.** There are five new feature ids, `packs.type.godot.zip`, `packs.type.l10n.table`,
  `packs.type.data.json`, `packs.type.audio.bank` and `packs.type.ml.model`. They keep the type's
  dots because the id pattern forbids hyphens, and each has a `unit` proof and the runtime N/As
  above. `custom.*` stays under `packs.handlers`. There is one new client code,
  `pack-type-check-failed`. Its `detail` is one of `json`, `table`, `locale`, `descriptor`,
  `runtime`, `quantization`, `memory`, `load-test`, `middleware`, `size`, `check` (a check that
  threw, or a detail outside the token pattern) or `unreadable`, or a game handler's own token.
  A `formatVersion` the handler does not list stays `pack-type-unsupported`.
- **Handler contract mapping (CONTENT §4.1).**
  - `formats()` is `supports(formatVersion)` plus the `packs.type.*` capability.
  - `plan` and `stage` stay the engine's, and are type-neutral.
  - `verify` is the engine's verification plus a new optional `check(staged)`. It runs over
    every newly staged payload after the hashes, the path rules and (for a delegated release)
    the data-only rule.
    - TS, Python and Swift run it after `storage.commit` and before the state commit. A refusal
      abandons the install, discards staging and lets GC collect the stored payload.
    - Godot runs it on the staging directory before commit, through the existing `check_tree` and
      `check_output`.
    - It never runs on a `noop` reuse or an embedded baseline.
  - `activate` gets lazy access to the installed payload: TS's second argument, Swift's
    `activate(_:payload:)`, Python's `reads_payload`. Godot reads `install.location` directly.
  - Rollback is the engine's re-pointing with deactivate/activate. Uninstall and `roots()` are
    the engine's GC; there is no separate `uninstall` hook.
- **Type metadata lives in the payload, not the record.**
  - `ml.model` carries a `model.json` at its root: `runtime`, `file`, `memBytes`, optional
    `vramBytes` and `quantization`.
  - `audio.bank` carries a `bank.json`: `middleware`, `version`, optional `banks`.
  - `l10n.table`'s locale is read from each table (the PO `Language:` header, a CSV locale
    column, a JSON table's `locale`) and matched to the variant's `locale` axis. Its "key-schema
    version" is the record's `formatVersion`.
  - New members in the signed pack record would have been a signed-document change (plan mode).
- **Formats and layouts.**
  - Every new type is tree layout except `godot.zip`, which is a container. The CLI publishes
    them as trees, so the brief's `chunk` preference for `audio.bank` and `ml.model` does not
    apply: chunk indexes are container-only, and file-level reuse covers trees.
  - A `data.json` document must be a JSON object, because V4 §1.2's strict parser reads objects
    only.
  - An `l10n.table` file's format is judged by its bytes: `{` means JSON, `#`, `msgid` or
    `msgctxt` means PO, anything else is CSV. A JSON table's messages are ordered by the UTF-8
    bytes of their ids, because member order is not portable.
  - No SDK loads a `.translation` resource, since a resource load is not a parse.
  - Godot builds `Translation` objects in code and never hands a pack's `Plural-Forms` formula
    to `Expression`. Plurals use `add_plural_message` on 4.6+; 4.4.1 gets the singular form.
- **Built-in vs host-registered.** `data.json` and `l10n.table` are built in everywhere; Godot
  also has `godot.zip` built in. `ml.model` (`MlModelHandler`) and `audio.bank`
  (`PKeyAudioBankHandler`) are registered by the host with its budget or middleware. Without
  one, a pack of either type is `pack-type-unsupported`, while `supports()` still answers that
  the SDK holds the type.
- **`godot.zip`.**
  - Godot's `PackedData` tries the PCK source before the ZIP source whatever the extension, and
    the PCK source accepts `GDPC` at the head or the tail. This was measured on 4.7.2: a `.zip`
    with a PCK appended mounted that PCK's hidden files.
  - The same reader also searches a self-contained export's embedded-PCK offset inside the file
    it opens, and minizip follows a ZIP64 locator found before the end record.
  - So the CLI lint and the Godot check both refuse: `GDPC` anywhere in the bytes; anything
    before the first local header; zero entries; an archive or entry comment; ZIP64 or its
    locator; encryption and data descriptors; compressed entries; local headers disagreeing with
    central ones; overlapping data; and non-normal or repeated paths (directory entries
    included). The `godot.pck` admission list then runs over the entries.
  - `mount()` refuses a `godot.zip` install not stored at `.zip`, and a `godot.pck` one not at
    `.pck`.
  - A zip container is stored as `store/<sha256>.zip`, named by its leading `PK` bytes, because
    Godot's ZIP source opens only `.zip`/`.pcz`. `mount()` mounts `godot.pck` and `godot.zip`
    installs in one `mountOrder` queue.
- **Godot base class.** `PKeyPackHandler.check_tree` runs the v1 tree rule
  (`PKeyPck.tree_check`) and then a new overridable `check_payload`, so a game's `custom.*`
  handler keeps the v1 rule.
- **Manifest (rule 9).**
  - `type` takes the v3 types or `custom.<name>` (`^custom\.[a-z][a-z0-9-]{0,31}$`).
    `godot.zip` is a mounted type, like `godot.pck`.
  - `formatVersion` (new) is required for `data.json`, allowed for `l10n.table`, `ml.model`,
    `audio.bank` and `custom.*`, and refused for the others (`invalid_pack_format_version`).
  - `l10n.table` locale variants must be BCP-47 (`invalid_pack_locale`).
  - Every non-mounted type defaults to `hot`.
  - The protocol's `PACK_TYPES` (the v1 vocabulary) is unchanged.
- **Byte-exact everywhere.** Paths, ids and locale columns are compared by UTF-8 bytes and
  ASCII case only, never by Unicode canonical equivalence or case folding. Swift's
  `compareUTF8Bytes` (`PolarisKeyCore`) had returned "equal" for canonically equivalent strings;
  it no longer does. A second leading BOM is kept as U+FEFF, so it is part of the first CSV
  header cell.
- **Shared fixture set.** The per-type corpus vectors stay out (plan mode).
  `packages/client-core/test/fixtures/pack-type-cases.json` is the shared unit-case set. Python
  and Swift read it, and Godot keeps a byte-identical copy that a client-core test checks.

**Follow-ups found, not fixed here:**

1. The Godot `godot.pck` handler's `supports()` accepts only `formatVersion == 1`. The CLI signs
   the PCK header's format version (2–4), as WIRE-CONTRACT-V4 §2.5.1 says. P4-08/P4-03 should
   reconcile them.
2. The Godot engine puts a type check's `detail` token only in the error message (the `path` is
   in `detail.path`). Fixing it is one line in `engine.gd`'s check block, deferred because P4-26
   is editing that file.
3. Swift `data.json` documents still decode into `JSONValue`, which keeps one of two canonically
   equivalent member names. The check's verdict is unchanged, because duplicates are judged by
   scalars, but `documents(packId)` loses a member.
4. The Godot `l10n.table` handler registers singular forms only on 4.4 and 4.5. Plurals use
   `add_plural_message` from 4.6, and a pack's `Plural-Forms` formula is never evaluated.
5. Swift cannot tell whether a handler implements `check`, so TS, Python and Swift all read the
   staged payload back for every handler. A store that cannot return what it just committed is refused as
   `unreadable`, `files.tree` included.
