# P4-16 More pack types in every SDK: `l10n.table`, `data.json`, `audio.bank`, `ml.model`, `custom.*`

| Field       | Value                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v3)                                                                                                       |
| Size        | 1–1.5 engineer-weeks                                                                                                 |
| Depends on  | [P4-06](P4-06-client-core-packs.md), [P4-07](P4-07-python-swift-packs.md), [P4-08](P4-08-godot-packs.md)             |
| Unblocks    | none                                                                                                                 |
| Role        | `pkey-sdk-porter` (the Godot handlers may go to `pkey-godot-engineer`)                                               |
| Plan mode   | no                                                                                                                   |
| Gates       | none in the graph; in practice rule 9 (the v1 validator accepts only `godot.pck` and `files.tree`, and P4-01 names this package to widen it); per-type corpus vectors would need a plan |
| Human input | none                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                            |

## Goal

Each SDK ships handlers for the v3 pack types it supports, per the [CONTENT §13](../../CONTENT.md#13-per-sdk-integration)
table, implementing the full handler contract with the type-specific verification of
[CONTENT §4.2](../../CONTENT.md#42-initial-type-registry). Every other (SDK, type) pair returns a
typed "unsupported here" result that the parity registry allows. `custom.<name>` works end to end
in every SDK through `registerHandler`, and the CLI lints the new types at publish.

| SDK         | Handlers added here                                 |
| ----------- | --------------------------------------------------- |
| Godot       | `godot.zip`, `l10n.table`, `data.json`, `audio.bank`, `custom.*` |
| Swift       | `ml.model`, `data.json`, `l10n.table`, `custom.*`   |
| Node        | `ml.model`, `custom.*`                              |
| Python      | `ml.model`, `data.json`, `custom.*`                 |
| React / web | `data.json`, `l10n.table`, `custom.*`               |

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
- Widen the `.pkey/release` `type` rule that P4-02 limited to `godot.pck` and `files.tree` (rule 9: validator rule,
  mutation-table entry, schema, regenerated `validation-codes.mdx`).
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

- [ ] Each SDK has tests per new handler: stage, verify, activate, rollback, uninstall, and one
      rejection each (wrong locale, `formatVersion` too new, model memory above budget, bank
      middleware mismatch).
- [ ] A `custom.dialogue` pack installs end to end in every SDK against a fake server with a
      game-registered handler, and its payload passes the same path rules as `files.tree`.
- [ ] Unsupported (SDK, type) pairs return the typed N/A the parity registry allows;
      `pnpm parity:check` passes (once P1b-01 has landed).
- [ ] `pnpm --filter @polaris-key/cli test` covers the new lints.
- [ ] If the manifest `type` rule changed, `schema-parity.test.ts` passes with the new entries.
- [ ] The green gate passes (`AGENTS.md`), including pytest, `swift test` and the Godot runner.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

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
