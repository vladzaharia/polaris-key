---
sidebar:
  order: 3
title: "The truth store"
description: "release_metadata, release_artifacts, release_channels, and release_health — populated by resync and GitHub release events, read by the portal and entitled gating."
---

What versions a product has published, what each one contains, what each channel currently
points at, and whether any of it looks broken — Polaris Key's belief about all of it lives
in four D1 tables collectively called the **truth store**. They are populated exclusively
by [a sync](/docs/services/release/github-sync/); nothing in them is ever hand-edited. The
customer portal and the console's Releases view answer from this store precisely so those
requests never cost a live GitHub call.

The store is a read path for humans, not for the device-facing routes. `GET
/<product>/release/dl/…`, the appcast, the version check, the changelog, and the install
script all resolve live against GitHub on every request that isn't already sitting in the
edge cache — see [Artifacts](/docs/services/release/artifacts/) and
[Appcast](/docs/services/update/appcast/). The store and those live routes describe the
same underlying GitHub state and are kept in step by the same sync, but they are two
independent paths to it, not one reading from the other.

## The four tables, plus one

| Table               | One row per                             | Written by                |
| ------------------- | --------------------------------------- | ------------------------- |
| `release_metadata`  | published GitHub release                | resync, `release` webhook |
| `release_artifacts` | release asset                           | resync, `release` webhook |
| `release_channels`  | channel name                            | resync, `release` webhook |
| `release_health`    | release or channel, as a health subject | resync, `release` webhook |

A GitHub `release` delivery re-runs only this half of a resync — see
[Release events refresh the truth store](/docs/services/release/github-sync/#release-events-refresh-the-truth-store).

A floor table, `release_channel_floors`, sits beside them. A sync raises it and an operator
lowers it (see [below](#release_channel_floors)). Four more tables, the
[release model](#the-release-model), record what a GitHub release list cannot say:
deliverables, builds, the operator-owned channel policy and yanks.

A further table, `release_config`, anchors them all — it is the one row per product carrying
the linked repository's coordinates, binary name, Sparkle key, and access modes, and it is
what [GitHub sync](/docs/services/release/github-sync/) describes in full. The truth store
is downstream of it, not a replacement for it.

### `release_metadata`

One row per **published, non-draft** GitHub release: its version (parsed from the tag),
title, notes, the GitHub URL, when it was published, and both the metadata and artifacts
access modes that were in effect at sync time. Draft releases never reach this table at
all — see [Release](/docs/services/release/#draft-releases-are-invisible) for why.

Three columns place the release in the [release model](#the-release-model): `deliverable_id`
(`app` for everything the GitHub sync writes), `seq` (its position in the deliverable's
publication order) and `channel` (the channel it was published to; `NULL` means "derive from
GitHub", as every synced release does today).

### `release_artifacts`

One row per release asset, classified two ways on ingest so every reader agrees on what an
asset _is_ without re-deriving it: a **kind** (`dmg`, `pkg`, `archive`, `checksum`,
`signature`, `cli`, or `other`, read from the filename) and an **architecture** (`arm64` or
`x86_64`, read through the exact same name-matching logic the download route itself uses —
so the store can never claim an asset is available in a shape the download route would
then refuse to serve). The `content_type` recorded here is never the uploader's declared
value; it is the same fixed choice the download gateway serves the bytes as, because this
origin also hosts the admin console and the customer portal and a mislabelled artifact is a
content-sniffing risk on that origin, not just a cosmetic one.

Each artifact also carries a **role** (`payload`, `signature`, `checksum`, and the chunked and
delta roles later packages use), filled from the kind on ingest: a `.sig` is a `signature`, a
`.sha256` a `checksum`, anything else a `payload`.

That is the classification for a product that declares no **artifact map**. A product that
declares one (`deliverables.app.artifacts` in `.pkey/release`) has every file classified by the
map instead: the file an entry matches is that build's payload, with the entry's platform and
arch, its `.sig` and `.sha256` sidecars join the same build, `build_id` names the build, and
`sha256` is GitHub's own digest of the bytes. A file no entry matches has no build, platform or
arch — under a map nothing is sniffed. See
[Artifacts](/docs/services/release/artifacts/#declared-artifacts-and-release-descriptors).

A release with an ingested **release descriptor** belongs to the descriptor: its `build_id`,
`role`, `sha256`, `storage_key` and `locations_json` (hash-pinned places the bytes can be
fetched from), its builds, and its classification are the descriptor's, and the sync refreshes
only the GitHub-derived serving columns. The map does not apply to it: a GitHub file the
descriptor does not name, recorded by a later sync, joins no build and takes the role its name
implies. `release_metadata.metadata_json.descriptor` records
the ingested descriptor's hash (or why a `pkey-release.json` was refused), and survives every
resync.

A sync is planned from a read and applied later, in one batch, so a descriptor can be ingested
in between — CI publishing while a release webhook's sync is in flight. Every statement the
sync planned for an undescribed release re-checks, when it runs, whether the release has an
ingested descriptor by then, and if so writes what it would have written for a described
release: the map's builds are not written and no file's classification is touched. A stale
plan never overwrites a described release.

### `release_channels`

One row per channel name a product declares — the two built-ins, `stable` and `beta`, plus
any operator-defined manual channels — recording which `release_id` that channel currently
resolves to. This is a **moving pointer**: a channel's row is overwritten on every sync to
reflect whatever the same resolution logic the live feed uses currently picks, so the
console can show "what does `beta` ship today" without making a request to GitHub to find
out. That logic is the candidate filter and version ordering described on Update's
[Eligibility](/docs/services/update/eligibility/#which-tags-are-candidates-and-which-one-wins)
page: `release.stableTagPattern` and `release.ignoreTags` decide which tags count, and the
highest semver wins. Creation order does not.

The table's `policy_json` column is read by nothing and every sync writes it as `NULL`.
Operator-owned channel policy lives in [`release_channel_policy`](#release_channel_policy).

### `release_channel_floors`

One row per floored channel: the highest version that channel has resolved to during a sync,
and the tag it came from. The sync only ever raises a floor. When the release list now offers
something lower, because the floor's release was deleted or unpublished, the channel row is
left pointing at nothing and its `release_health` subject is `blocked`, rather than following
the list down. The live routes enforce the same floor, and an operator lowers or clears it
deliberately. See
[Channel floors](/docs/services/update/eligibility/#channel-floors-no-silent-downgrade).

The sync reads at most 1,000 releases. For a repository with more, a floor release on a page
the sync did not reach is looked up by its tag, exactly as the live route does, so the store's
row and the live answer agree; a shorter list is the whole repository, so a floor release
missing from it is gone and costs no extra call. A floor can outlive the configuration that
made it (a manual channel since removed, or a `beta` floor recorded before a channel workflow
was set). Such a stranded floor can still be cleared, but not lowered.

This is the sync's anti-rollback **high-water mark**. It is not the channel policy's
`min_supported`, the device floor the signed feed will carry: folding the one into the other
would raise every channel's device floor to its newest version.
This table is the one part of the store the device-facing routes read. It costs one D1 read
per moving selector.

### `release_health`

A status snapshot — `healthy`, `degraded`, `blocked`, or `unknown` — per health _subject_, where a
subject is either a specific release (do its assets look complete) or a channel (does it
currently resolve to anything at all). This is the coarse, always-on signal written on
every sync; the richer, on-demand checklist described in
[Health checks](#health-checks) below is a separate, deeper read triggered from the
console.

The console renders `release_channels` two ways for a reason: as badges on the release
each channel currently points at ("what does this release serve"), and as a separate list
of every channel name ("what does `beta` ship right now"). The second view exists because
the first can't show a dangling pointer — a channel row referencing a `release_id` the
store no longer holds has no release row to attach a badge to, and that gap is itself worth
seeing.

## The release model

The GitHub sync records what a GitHub release says. These four tables record what it cannot:
which deliverable a release belongs to, its per-platform builds, how an operator has steered a
channel, and which releases are withdrawn. The release descriptor, the release routes, the
`releaseCatalog` hook Distribution reads through, and the signed release record are their writers and readers; the GitHub
sync only keeps them consistent.

| Table                    | One row per              | Written by                   |
| ------------------------ | ------------------------ | ---------------------------- |
| `release_deliverables`   | deliverable of a product | resync, descriptor           |
| `release_builds`         | build of a release       | descriptor                   |
| `release_channel_policy` | (deliverable, channel)   | manifest resync, operator/CI |
| `release_yanks`          | yanked release           | operator/CI                  |

Platform, arch, format and role are free text in D1 with no `CHECK`: the vocabularies grow, and
changing a `CHECK` means rebuilding the table. The worker validates them against the lists
`@polaris-key/manifest` exports (`RELEASE_PLATFORMS`, `RELEASE_ARCHES`, `ARTIFACT_ROLES`,
`DELIVERABLE_KINDS`).

### `release_deliverables`

One row per thing a product releases: its `app` (kind `app`, id `app`) or a pack (kind `pack`,
with a pack type), plus the manifest's declaration of it. Every product with a release
configuration has an `app` row; the sync creates it if it is missing and never changes it.

### `release_builds`

One row per compiled build of a release: platform, arch, format, build number (text, since
not every build number is an integer), minimum OS, and variant and requirements as JSON.
`build_id` is the artifact-map entry's id (`macos`, `apk`), unique within a release;
`release_artifacts.build_id` points at it.

### `release_channel_policy`

One row per deliverable and channel: the **pointer** (`NULL` follows the newest eligible
release; promote sets it), **pinned** (freezes the channel at the pointer, so a pin needs a
pointer), **includes** (the manifest-declared channels this one also offers, `["stable"]` for
`beta`), **min_supported** (the device floor) and **critical** (flags the pointer release).
`source` is `manifest` or `admin`, the `services_source` precedent: any operator or CI change
sets `admin`, after which a resync leaves the row alone, until "revert to manifest" hands it
back.

### `release_yanks`

One row per yanked release, with a reason, a time and an actor. A yanked release resolves only
through an explicit pin. Yanking never deletes the release, and unyanking deletes only this
row. A release deleted on GitHub is not a yank; it simply stops being listed.

### What a resync owns

The sync upserts only the columns GitHub is the source of. On `release_metadata` it writes
`deliverable_id` and `channel` on insert only, and gives a new release the next `seq` for its
deliverable, in publication order. On `release_artifacts` it fills `role` only while it is
`NULL`, and never touches `sha256`, `storage_key`, `metadata_json`, `build_id` or
`locations_json`. A release descriptor's facts therefore survive every later resync. `seq` is
unique per deliverable, and the deploy-time index assertion checks the index that makes it so.

## Idempotence, and why nothing is ever deleted

Every write to every one of these tables is an **upsert** keyed on the row's natural
identity (product + release id, product + release id + artifact id, and so on), so
resyncing an unchanged repository is a no-op in content and safe to run as often as a
webhook fires. Nothing is ever `DELETE`d. Two reasons, one structural and one deliberate:

- **Structural.** `release_download_tokens` — the short-lived tokens the customer portal
  mints for a gated download — carries foreign keys into both `release_metadata` and
  `release_artifacts`. A delete-then-reinsert pass would fail D1's foreign-key enforcement
  the moment a single live download token existed for that row.
- **Deliberate.** A release withdrawn upstream leaves its row behind — stale, but inert.
  The portal still gates every download behind a live license check regardless of what the
  row says, and the artifact URL the row holds is GitHub's own, which will 404 on its own
  once the asset is actually gone. A stale row costs nothing and simplifies the write path;
  a wrongly-deleted row would break a foreign key it doesn't need to.

What the sync does record is that the release is gone. When it has read the release list to
its end (no unread page under the 10-page cap) and a stored release is not among the published
ones — deleted, or unpublished back to a draft — that release's `release_health` subject is
written `degraded` with `{"absentUpstream": true}`. A capped read marks nothing. A release
that reappears upstream gets its ordinary health row back on the next sync.

`release_artifacts.source_url` is always GitHub's own `browser_download_url` and nothing
else — never a value derived from the uploader's filename or content, and never anything
supplied at request time. That column is exactly what the customer portal's gated download
redirects to, so keeping its origin fixed to "GitHub told us this, verbatim" is what keeps
that redirect from being something a request could steer.

## Access modes, stored narrower than they're enforced

`release_metadata` and `release_artifacts` each carry an access-mode column, copied from
`release_config` at sync time — with one deliberate narrowing: an effective mode of
`entitled` is stored as `licensed` instead of copied verbatim. The reason is _who reads
these particular columns_: the customer portal, which authenticates a human through a
portal session, not a device through a bearer token. There is no per-device license grant
to evaluate on that path, so an `entitled` decision — which depends on a specific device's
channel and version entitlements — isn't expressible there at all. `licensed` is the
strictest thing the portal _can_ honestly enforce (does this account hold any usable
license), which makes the substitution a tightening, never a downgrade.

The full `entitled` check — channel membership and version-window enforcement against a
specific caller's own license — runs on the live, device-facing release and update routes,
where a device token actually exists to evaluate it against. See Update's
[Eligibility](/docs/services/update/eligibility/) page for that check in full.

## Health checks

`GET` the release admin API's health endpoint (surfaced in the console as **Release
health**) runs a live checklist, in order, stopping early once a prerequisite is missing:

1. **Release config** — are the GitHub owner, repo, installation id, and binary name all
   present at all.
2. **Sparkle public key** — configured or not (a missing key is a warning here, not a
   failure: a product may not ship Sparkle updates at all). Checked only for a product that
   _ships DMGs_ (below).
3. **GitHub access** — can the installation token actually list releases right now.
4. **Channel floors** — one `channel-regressed` error per floored channel whose floor release
   is gone, naming the floor and what the release list now offers (see
   [Channel floors](/docs/services/update/eligibility/#channel-floors-no-silent-downgrade)).
   A non-stable floor the pages already read do not reach costs one more resolution; if that
   GitHub lookup fails (quota or an upstream error), the check is a
   `channel-floor-unverified-<channel>` warning instead, and the rest of the report stands.
5. **Latest release** — what `stable` resolves to, through the same resolution function the
   download route, the appcast and the version check use: candidate filter, semver order,
   page cap and floor included.
6. **macOS arm64 DMG** — present or not. Absence counts as _missing_ by default: a product
   that ships DMGs is expected to have both architectures. It softens to a warning for a
   product whose artifact policy turns `requireDmg` off but whose latest release carries a
   DMG anyway.
7. **macOS x86_64 DMG** — present or not. Same rule as the arm64 check.
8. **Sparkle signature** — either the policy requires signed appcasts and no public key is
   configured at all (_missing_), or a key is configured and the question is whether the
   sibling `.sig` asset for the arm64 DMG is actually present. This check confirms presence;
   the appcast itself additionally _verifies_ it — see
   [Appcast](/docs/services/update/appcast/).
9. **CLI assets** — arm64 and x86_64 bare-binary assets, present or not (each a warning
   unless the artifact policy requires it).

A product **ships DMGs** when its artifact policy requires one (the default, so a product with
no policy is checked exactly as before) or its latest release already contains a `.dmg`. For a
product that does neither — a Linux or Godot build, say — checks 2 and 6 to 8 are skipped
entirely rather than reported as missing, so it is not told it "needs setup" for artifacts it
never builds.

The rolled-up status a product carries is `healthy` when every check passes, `needs-setup`
when something expected is simply missing, and `error` when GitHub access itself failed or
a channel has regressed below its floor —
distinct from `not-configured`, which means there is no release configuration at all yet
to check.

## Who reads this

- **The customer portal** queries `release_metadata` and `release_artifacts` directly to
  list a product's releases and to mint and redeem the short-lived tokens behind a gated
  download — never a live GitHub call on a request a customer is waiting on.
- **The console's Releases view** reads all four tables through the release admin API: the
  metadata and artifact rows for the releases table itself, `release_channels` for the
  channel map, and `release_health` for each release's status badge. It leads the view,
  with the live [health checklist](#health-checks) and the sync-state card
  alongside it, describing how the belief was formed rather than standing in for it.
- **The live release and update routes** — including the `entitled` access check — do not
  read this store, except for one `release_channel_floors` lookup per moving selector. They resolve a request's selector against GitHub directly (see
  [Eligibility](/docs/services/update/eligibility/) for how `entitled` evaluates a caller's
  own license against that live resolution).

## See also

- [GitHub sync](/docs/services/release/github-sync/) — what triggers a write to this store,
  and what "Manifest sync" shows beside "Release health" in the console.
- [Artifacts, changelog & install](/docs/services/release/artifacts/) — the routes that
  serve what this store indexes.
- [D1 data model](/docs/reference/data-model/) — the full column list for every table named
  here.
