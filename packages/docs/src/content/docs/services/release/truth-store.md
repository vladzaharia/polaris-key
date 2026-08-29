---
sidebar:
  order: 3
title: "The truth store"
description: "release_metadata, release_artifacts, release_channels, and release_health — populated by resync, read by the portal and entitled gating."
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

| Table               | One row per                             | Written by |
| ------------------- | --------------------------------------- | ---------- |
| `release_metadata`  | published GitHub release                | resync     |
| `release_artifacts` | release asset                           | resync     |
| `release_channels`  | channel name                            | resync     |
| `release_health`    | release or channel, as a health subject | resync     |

A fifth table, `release_config`, anchors all four — it is the one row per product carrying
the linked repository's coordinates, binary name, Sparkle key, and access modes, and it is
what [GitHub sync](/docs/services/release/github-sync/) describes in full. The truth store
is downstream of it, not a replacement for it.

### `release_metadata`

One row per **published, non-draft** GitHub release: its version (parsed from the tag),
title, notes, the GitHub URL, when it was published, and both the metadata and artifacts
access modes that were in effect at sync time. Draft releases never reach this table at
all — see [Release](/docs/services/release/#draft-releases-are-invisible) for why.

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

### `release_channels`

One row per channel name a product declares — the two built-ins, `stable` and `beta`, plus
any operator-defined manual channels — recording which `release_id` that channel currently
resolves to. This is a **moving pointer**: a channel's row is overwritten on every sync to
reflect whatever the same resolution logic the live feed uses currently picks, so the
console can show "what does `beta` ship today" without making a request to GitHub to find
out.

### `release_health`

A status snapshot — `healthy`, `degraded`, or `unknown` — per health _subject_, where a
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
   failure: a product may not ship Sparkle updates at all).
3. **GitHub access** — can the installation token actually list releases right now.
4. **Latest release** — is there a published, non-draft release to evaluate.
5. **macOS arm64 DMG** — present or not. Absence counts as _missing_, unconditionally:
   every macOS product is expected to ship one.
6. **macOS x86_64 DMG** — present or not. Also _missing_ by default; it softens to a warning
   only for a product whose artifact policy turns `requireDmg` off.
7. **Sparkle signature** — either the policy requires signed appcasts and no public key is
   configured at all (_missing_), or a key is configured and the question is whether the
   sibling `.sig` asset for the arm64 DMG is actually present. This check confirms presence;
   the appcast itself additionally _verifies_ it — see
   [Appcast](/docs/services/update/appcast/).
8. **CLI assets** — arm64 and x86_64 bare-binary assets, present or not (each a warning
   unless the artifact policy requires it).

The rolled-up status a product carries is `healthy` when every check passes, `needs-setup`
when something expected is simply missing, and `error` when GitHub access itself failed —
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
  read this store at all. They resolve a request's selector against GitHub directly (see
  [Eligibility](/docs/services/update/eligibility/) for how `entitled` evaluates a caller's
  own license against that live resolution).

## See also

- [GitHub sync](/docs/services/release/github-sync/) — what triggers a write to this store,
  and what "Manifest sync" shows beside "Release health" in the console.
- [Artifacts, changelog & install](/docs/services/release/artifacts/) — the routes that
  serve what this store indexes.
- [D1 data model](/docs/reference/data-model/) — the full column list for every table named
  here.
