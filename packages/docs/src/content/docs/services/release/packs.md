---
sidebar:
  order: 6
title: "Packs"
description: "Content packs as release deliverables: declaring them, the pinned binding, contentApi, publishing a pack in stage rounds and one record, pins, embedded baselines and the delivery gate."
---

A **pack** is content an app loads at run time — a Godot resource pack (`godot.pck`) or a
directory of files (`files.tree`) — released on its own versions, like the app. Release records
every pack release, which app releases pin which pack releases, and what each build embeds.
Distribution serves the bytes; the SDKs install them. The terms are on the
[concepts page](/docs/start/concepts/#packs).

v1 ships the **pinned** binding only: each app release pins the exact pack release it ships
with, and a pack changes on a device only with an app release. Packs carry data only, never
code.

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
   a `pack-upload` reference: the product now holds those bytes.
3. **The record**: `POST /<product>/release/publish/submit` `{record, ticket?, dryRun?}`. A small
   pack can carry its objects in this ticket and publish in one request.

Ingest checks the record against the declaration and the store, refusing with
`release_record_rejected` and a `reason`, in this order: the checks every record shares (`typ`,
`kid`, `product-key`, `signature`, `claims`), then `pack-unknown` (not a declared pack),
`scheme`, `seq` (not above the pack's last), `pack-type`, `pack-variant` (an axis or value the
declaration lacks), `pack-entitlement` (not the gate, or not the assertion), `pack-index` and
`pack-object`. Each files index is read from the blob store, decoded and parsed one at a time,
at most 8 MiB each and 64 MiB per record; every object and file blob must be stored with its
recorded length under the product's own references and the pack's prefix. A pack release's id is
`<packId>@<version>`; its variants are builds (`build_id` the variant key, `default` for none)
and its objects artifact rows (`payload`, `files-index`, `files-gaps`, `delta`, `patch`,
`patch-data`).

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
| `pin-missing`     | an expected, `required` or embedded-baseline pack has no pin, or a pin no expect |
| `pin-gated`       | a `required` expect pins a gated pack release                                    |
| `embeds`          | a build embeds a pack the release does not pin                                   |
| `pack-unreadable` | a declared pack's stored declaration does not read back; resync the manifest     |

Release mirrors the pins into `release_pins` (never edited afterwards), the `contentApi` into
the release and each build's `embeds`. **Yanking** a pinned pack release stops new pins; app
releases that already pin it keep it until an app release replaces it.

## Reading packs

Other services read packs through Release's catalog hook: the declared packs, a pack release with
its variants and objects, a variant's files (read from its index), what an app release pins,
which app releases pin a pack release, and what a build embeds. Discovery's Release fragment
carries `packs: true` on a Worker that ingests packs; `pkey release publish` refuses to publish a
pack or stamp `content` without it.
