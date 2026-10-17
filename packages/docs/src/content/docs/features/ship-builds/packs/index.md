---
title: "Packs"
description: "Content that ships on its own versions: bindings, pack types, the delivery gate, how pack sets resolve, what a build embeds and how a device installs."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 1
---

A pack is content an app loads at run time: a Godot resource pack, a directory of files, translation tables, JSON data, audio banks, a model, or a type your game defines. It is released on its own versions, like the app. Release records every pack release, which app releases pin which pack releases and what each build embeds. Distribution serves the bytes and the SDKs install them. Packs carry data, never code. To publish one, see [Ship a pack](/docs/features/ship-builds/packs/ship-a-pack/).

## Bindings

A pack's binding decides which of its releases an app release runs with.

| Binding      | Which release runs                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinned`     | The exact release each app release pins. The pack changes on a device only with an app release                                                      |
| `compatible` | The newest release that declares support for the app's `contentApi` level. Content ships between app releases                                       |
| `standalone` | The newest release for every level. The pack depends only on its own type's format, such as localization tables or data with its own schema version |

`contentApi` is the content shape the app's code expects. It is required in `deliverables.app.content` once any pack exists, and stamped into every app release. A product declares at most 64 packs.

## Pack types

A pack's `type` names the handler a device installs it with. Transport, patching, signing, revocation and garbage collection are the same for every type. The handler adds the type's own checks over the verified payload before it commits. A payload that fails is refused with `pack-type-check-failed`, with the check in `detail` and the file in `path`, and the staged bytes are discarded. `pkey release publish` runs the same checks with the device's own functions before it signs anything.

| Type            | Payload                                      | Activation             | SDKs                                 |
| --------------- | -------------------------------------------- | ---------------------- | ------------------------------------ |
| `godot.pck`     | One `.pck` with uncompressed entries         | Restart                | Godot                                |
| `godot.zip`     | One `.zip` of stored entries                 | Restart                | Godot                                |
| `files.tree`    | A directory of files                         | Hot                    | All                                  |
| `l10n.table`    | PO, CSV or JSON tables                       | Hot                    | All                                  |
| `data.json`     | JSON documents with an object at the top     | Hot                    | All                                  |
| `audio.bank`    | FMOD or Wwise banks and a `bank.json`        | Hot, the host reloads  | Godot. Others use the game's handler |
| `ml.model`      | GGUF, ONNX or safetensors and a `model.json` | Hot, after a load test | Node, React, Python, Swift, Kotlin   |
| `custom.<name>` | A file or a tree                             | The game's handler     | All, through `registerHandler`       |

- **Handlers parse, never evaluate.** Nothing goes to a script engine or resource loader. Only `godot.pck` and `godot.zip` are mounted, and a content key can never sign either.
- **When the checks run.** Over every newly staged payload. A release whose payload is already installed is reused without a second check, and so is a rollback. An embedded baseline is CI-built and release-signed and isn't re-checked.
- **Tiny, often-tuned values belong in managed config**, not a `data.json` pack. Config is a signed document with Enforced and Default states, delivered with no install.
- **Which SDK holds what** is a typed answer. `supports("packs.type.<type>")` returns the registry's `runtime` N/A where an SDK ships no handler, and installing such a pack raises `pack-type-unsupported`. The `data.json` and `l10n.table` handlers are built in. `ml.model` and `audio.bank` need the host to register one with its budget or middleware.
- **Godot plurals.** Godot 4.6 and later register a PO file's plural forms. 4.4 and 4.5 register the singular only. A `Plural-Forms` formula is never evaluated.

## The delivery gate

Who may download a pack is the pack's own delivery access, set by an operator and never inherited from the app's. Its license flag, the `entitlement`, is the pack's gate. `.pkey/release` only asserts it: a publish whose gate differs from the assertion is refused, so a paid pack the operator hasn't gated yet fails closed, and no push can gate, ungate or re-flag a pack. While Distribution is off, every pack publish is refused with `distribution_disabled`.

## App releases: pins, holds and embeds

An app release carries its `contentApi`, the pack releases it pins by record hash, `seq` and version, and the packs it expects. Each build lists its `embeds`. They live in the release descriptor and move unchanged into the signed record. Yanking a pinned pack release stops new pins, and app releases that already pin it keep it until an app release replaces it.

An app release may also hold a compatible pack at one release, for example "1.5.2 keeps `foes@1.4.3` because 1.4.4 breaks a quest". Holds are signed like pins, and devices apply them over the resolved set.

## Resolution

On every publish, pointer move, floor change, yank and resync, Release re-resolves the product's pack sets.

1. **Live app releases.** Every non-yanked release a channel serves, at or above the channel's floor, that carries a `contentApi`.
2. **Selectors.** One set per channel, app deliverable, live `contentApi` level, platform and engine. During an engine bump, the older engine keeps its set.
3. **Per pack.** The newest release on the pack's channel whose `requires.contentApi` range holds the level, that runs on the engine, carries the variant and is at or above the pack's floor.
4. **The solver.** It keeps `requires.packs` ranges and `conflicts`, backtracking highest-first, leaving out as few packs as possible. Past its work budget, or 4,096 rows, a publish fails with `pack-sets-bound` rather than guess.

A pack nothing satisfies is listed in the set's `unsatisfied` with a reason: `no-release`, `content-api`, `engine`, `variant`, `content-floor`, `dependency` or `conflict`. So a floor with no backport deliberately blocks an old content line. A floor is set per `contentApi` line, so a fix can be backported to an older line: "foes 1.3.4 or later for contentApi 3". It is operator-owned and set on the channel. If a resolution fails, it never refuses the yank, floor change or resync that caused it. It fails closed: the product's sets are cleared, `release.pack_sets.failed` is audited and the response carries `packSets: { ok: false, reason }`.

## Save compatibility

Saves reference content ids, never paths, so a pack release that silently stops shipping an id breaks saves. Three guards turn that into a CI failure.

- **`provides` and `removes`.** A release lists the ids it provides in a JSON array, and `pkey release publish` signs it into the record. Ids are printable ASCII without spaces, 1 to 128 characters, at most 4,096. Polaris Key compares each release with the previous one on its channel at every live `contentApi` level both support. A dropped id fails the publish with `provides-dropped` unless acknowledged with `--removes <id>`.
- **`isAvailable` and `packFor` on the device.** Every SDK answers from the verified records, so a game can show "Continue (downloading 12 MB…)". `isAvailable(contentId)` is true when a pack in the active set provides the id. `packFor(contentId)` names the pack and release in the target set that provides it.
- **The content-interface fingerprint.** `--content-interface <registry.json>` hashes an explicit registry of what the code references and compares it with the channel's current app release. A changed fingerprint with an unchanged `contentApi` is a warning, and `--strict` fails the publish. Export the registry from your project yourself.

## Revocations and content keys

A revocation is a release record signed in CI by a release key, never by a product key or a delegated content key. It names the revoked pack record by hash and may name a replacement. A revoked release is never installed, activated or mounted (`pack-revoked`). A revoked optional pack is unmounted and play continues. A revoked required pack with no usable replacement stops the boot. Revocations are permanent, and ingest also yanks the target.

A release key can delegate a content key that may sign only data-only types (`files.tree`, `data.json`, `l10n.table`), only for compatible or standalone packs under one pack-id scope, and only inside a signing window of at most 366 days. The grant is a CI-signed delegation record. `.pkey/release` can't declare content keys, because an unsigned manifest can't grant trust. Adopt delegation only once every live build you care about embeds an SDK that verifies it: older builds never install delegated releases. The byte formats are in [Packs](/docs/reference/protocol/packs/).

## In the console

Packs appear in the Release section beside the app. **Deliverables** lists the app and every declared pack with its binding, latest release, gate and how many app releases pin it. A `pinned` pack no app release pins is marked **Not pinned**. A pack's record has four tabs: **Releases**, **Channels**, **Delivery** and **Files**. **Releases** shows which app releases pin each release, so check it before yanking. **Delivery** edits the gate. **Compatibility** sets app releases against pack releases and simulates what a device gets ([Compatibility](/docs/features/ship-builds/releases/compatibility/)). **Content keys** lists each delegation. Delegating and revoking are CI acts, so there are no controls. Apart from yanks, channel policy and the gate, everything is read-only.

## Delivering and installing

Distribution serves a pack's objects by SHA-256 on the blob route, under the pack's own delivery access and, for a gated pack, its current gate. A pack's files are never served by the `files` or `builds` routes. See [Delivery](/docs/features/ship-builds/channels/delivery/).

A build learns its pins from the content stamp (`pkey-content.json`) it ships, never from the network. The SDK fetches each pinned pack record by hash, verifies it against the app's pinned release keys, picks the variant, plans the cheapest way from what is installed (a delta, the changed files, or the whole payload), verifies every byte against the record and swaps the installed release atomically. When a strategy fails it falls back to the next and emits a `fallback` progress event.

Install state is never trusted from storage. Every load re-verifies each pack record and re-hashes the active and previous payloads. A state document that doesn't parse is `torn`: it is kept aside as `state.json.torn`, and `recoverState()` releases the hold. One that can't be read is `unreadable`, and `ensure`, `estimate`, `confirm` and `rollback` raise `pack-state-unreadable` until a restart can read it.

| SDK    | Entry                                               | Page                               |
| ------ | --------------------------------------------------- | ---------------------------------- |
| Node   | `client.update.packs`                               | [Node](/docs/build/sdks/node/)     |
| Web    | `createBrowserPacks`, with OPFS storage             | [React](/docs/build/sdks/react/)   |
| Python | `client.update.packs`                               | [Python](/docs/build/sdks/python/) |
| Swift  | `update.packs`, from the optional `PolarisKeyPacks` | [Swift](/docs/build/sdks/swift/)   |
| Godot  | `PolarisKey.update.packs`                           | [Godot](/docs/build/sdks/godot/)   |

## Lazy deltas

CI builds whole-payload deltas only against the last few releases. For a product an operator opted in, a consumer Worker generates a missing delta off the request path when at least 25 devices (configurable) moved between the same two payloads of a container pack within 7 days. It refuses a pair when a payload is over 32 MiB, when the delta would not save 30% and 1 MiB, or past the product's daily cap (20 by default). A lazy delta is in no signed record: the channel feed offers it, and the device checks every byte against the pack's CI-signed record and falls back on any failure.

## Next steps

- [Ship a pack](/docs/features/ship-builds/packs/ship-a-pack/): declare and publish.
- [Platform pack transports](/docs/features/ship-builds/packs/transports/): the app stores.
- [Packs](/docs/reference/protocol/packs/): the byte formats.
