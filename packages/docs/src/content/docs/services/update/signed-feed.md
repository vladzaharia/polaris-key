---
title: "Signed feed"
description: "The signed channel feed (pkey-feed+jws), the CI-signed release records it pins, floors that prompt, and the seq ceiling recovery."
sidebar:
  order: 3
---

Wire contract v4 splits an update into two signed documents with two signers. **CI signs what
exists**: a release record (`pkey-release+jws`) per release, signed with a release key that lives
only in CI. **The Worker signs which and when**: the channel feed (`pkey-feed+jws`), signed with
the product key, which says which release each platform should be on, its floor, and what each
outlet is doing. An SDK fetches the feed, fetches the record it pins, verifies both and decides.
A compromised Worker can choose among CI-signed releases, but it cannot make one up.

## Release records

`pkey release publish` builds the record from the release descriptor (the descriptor moved into a
signed payload: `product` becomes `aud`, `publishedAt` and file locations are dropped), signs it
with the key in `PKEY_RELEASE_KEY`, verifies it with the same claims every v4 SDK runs, and submits
it beside the descriptor. The Worker refuses the publish, and stores nothing, unless the record
passes every check — `release_record_rejected` with the reason:

| Reason                | What failed                                                                    |
| --------------------- | ------------------------------------------------------------------------------ |
| `typ`                 | the JWS is not `pkey-release+jws`                                              |
| `kid`                 | the key is not one of the product's declared `releaseKeys`                     |
| `product-key`         | the declared key is one of the product's own signing keys                      |
| `signature`           | the signature does not verify under wire v4's strict rules                     |
| `claims`              | the payload fails the record claims (`aud`, `seq`, builds, …)                  |
| `scheme`              | the version does not parse under the deliverable's scheme (SemVer 2.0 grammar) |
| `descriptor-mismatch` | the record is not the descriptor it was submitted with                         |
| `seq`                 | the record's `seq` is not the release's (ask the upload route again)           |

Records are stored once and never rewritten, and served by their SHA-256 at
`GET /<product>/release/records/<sha256>` under the release metadata access mode. Declare the
keys in [`.pkey/release` `releaseKeys`](/docs/build/manifest/authoring/#release-keys-releasekeys).
A release published without a record is never a feed target.

## The channel feed

`GET /<product>/update/<channel>/feed.jws?platform=<platform>` answers one channel, for every
platform at once:

- **`channel`** is the canonical channel (`latest` → `stable`, `staging` → `beta` unless the
  product declares a manual `staging`). It keys the client's `seq` floor, so an alias can never
  give one channel two floors.
- **`targets`**: per platform, the channel's release for that platform, if it has a record,
  pinned by the record's hash, `seq` and version; `critical` when it is the channel's pointer
  release and the policy says so; and the platform's **floor**.
- **`outlets`** per target, keyed by your outlet ids: what is live on each outlet, whether it is
  halted, a partial rollout the client evaluates for itself, the store listing URL, and any
  capability you narrowed in the console.
- **`seq`** moves only when the content changes (a pointer move, a floor, a rollout, a halt, a new
  release); every caller of a channel gets the same bytes, re-signed at most every 450 s, valid
  for 900 s. A channel that has never offered anything (an unused `pr-<n>` or manual channel)
  answers an empty feed at `seq` 1 and is not stored.

Nothing in the feed is device-specific: rollout buckets are computed on the device, and the
feed carries no device, licence or bucket.

## Which outlet an install is

The decision reads the feed entry of the install's own outlet, so every SDK first works out
where the install came from. A host that names its outlet (`update.outlet`) always wins.
Otherwise the SDK combines the build stamp (the outlet a Godot export was stamped with) with what
the device can see:

- **attested** evidence the platform vouches for — an App Store or TestFlight receipt and signing
  certificate on macOS, iOS `AppDistributor`, `/.flatpak-info` — names the outlet even over the
  stamp;
- **declared** and **heuristic** evidence — an installer or launcher that says so (Android's
  install source, the Steam library, the itch receipt, a snap or AppImage environment, a
  Homebrew, WinGet or Scoop path) — can only move the stamp to an outlet that updates no more
  widely, and a launcher signal counts only when it names this product (the Steam app id, itch
  game id, Flatpak app id and so on, which CI stamps from `pkey distribution outlet-ids`);
- a contradiction (a Developer ID build stamped `app-store`, Android's installer forged by the
  shell) gives **unknown**, which is never offered an update.

Detection runs at every launch, reads markers only (never a list of installed applications) and
never sends a raw signal anywhere. The rules are one function, pinned row for row by
`outlet-matrix.json` in every SDK.

## Floors prompt, they never block

A floor — the channel's `min_supported`, a release published with
`pkey release publish --min-supported-seq <n>`, or a pack floor — reaches every install of that
platform below it as an update prompt **the player cannot dismiss**. Play continues: no floor
stops an app from running, even on an outlet that has nothing newer to offer. When an old build
must stop working, use License's [compatibility window](/docs/services/license/document/), which
the licence document enforces on the device.

One answer does stop play: a CI-signed revocation of a **required** pack with no usable
replacement (`pkey release revoke`). The decision then answers `blocked {revoked-content}` (or
makes an offer mandatory with `contentBlock: revoked-content`), and the boot value is
`required`: the boot stops at a confirmed `blocked`, with the host's own copy — "Some of this
game's content was withdrawn by its developer and can't be used. Update the app to keep
playing." A revoked optional pack is simply unmounted.

| Answer                                                                            | Boot value |
| --------------------------------------------------------------------------------- | ---------- |
| `blocked {revoked-content}`, or any answer with `contentBlock: "revoked-content"` | `required` |
| `packs`                                                                           | `none`     |
| `blocked {content-floor}`, and any answer with `contentBlock: "content-floor"`    | `optional` |
| `none`, and a `platform` answer that is not mandatory                             | `none`     |
| everything else                                                                   | `optional` |

Only the release key held in CI can sign a revocation, so the Worker can never cause this
answer on its own.

## Recovering after a signer compromise

Anyone who held the product key can sign a feed at the largest possible `seq`, and installs that
fetch it then refuse the honest Worker's feeds until it expires and they freeze. After any
suspected product-key or Worker compromise, rotate the product key and run
`pnpm --filter @polaris-key/worker feed:seq-ceiling --product <slug>`: from then on every channel
of the product, including ones nobody has asked for yet, is signed at the ceiling with a newer
`issuedAt`, which every install accepts. The steps are in `docs/RUNBOOK.md`, "Recovering the
update feeds after a signer compromise".
