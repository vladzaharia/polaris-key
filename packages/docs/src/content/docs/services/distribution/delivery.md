---
sidebar:
  order: 2
title: "Byte delivery and delivery access"
description: "Every download Distribution serves — the installer, the direct download, builds, files and blobs — their permanent aliases, the bytes host, and the one delivery-access answer."
---

Release writes the records; **Distribution serves the bytes**. Every download a product
offers — the curl-pipe installer, the direct download, and the build, file and blob routes —
is a Distribution route, and who may download a deliverable is Distribution's **delivery
access**: one answer that the downloads, the Sparkle appcast and the customer portal all read.

## The byte routes

| Canonical route                                                       | Methods  | Bytes host |
| --------------------------------------------------------------------- | -------- | ---------- |
| `GET /<product>/distribution/install.sh`                              | any      | no         |
| `GET /<product>/distribution/dl/<version>/<binary>-<arch>[.dmg]`      | any      | no         |
| `GET /<product>/distribution/builds/<selector>/<buildId>`             | GET/HEAD | yes        |
| `GET /<product>/distribution/files/<releaseId>/<name>`                | GET/HEAD | yes        |
| `GET /<product>/distribution/blobs/sha256/<hash>`                     | GET/HEAD | yes        |
| `GET /<product>/distribution/packs/<pack>/<variant>/payload/<sha256>` | GET/HEAD | yes        |

What each one does — selector resolution, the location order (R2, then GitHub, then an
external URL), `?checksum=sha256`, `?redirect=1`, `Range`, cache headers — is unchanged from
when Release served them, and is described on
[Artifacts, changelog & install](/docs/services/release/artifacts/). The bytes on GitHub are
still fetched by Release, with its own installation token and its SSRF guard, through the
`releaseCatalog` hook: Distribution holds no GitHub token. R2-held bytes come from the core
blob store. `builds` and `files` serve the **app** deliverable only and never a `gated/`
object; a pack's bytes are served by the blob route ([Pack bytes](#pack-bytes)) and, decoded
for a browser, by the payload URL ([Web deltas](#web-deltas-the-payload-url)).

### Permanent aliases

Every older spelling keeps working forever. The router rewrites an alias to exactly the
route its canonical spelling produces, so the two cannot answer differently:

| Alias                                    | Canonical                                     |
| ---------------------------------------- | --------------------------------------------- |
| `/<product>/install.sh`                  | `/<product>/distribution/install.sh`          |
| `/<product>/release/install.sh`          | `/<product>/distribution/install.sh`          |
| `/<product>/release/dl/…`                | `/<product>/distribution/dl/…`                |
| `/<product>/release/builds/…`            | `/<product>/distribution/builds/…`            |
| `/<product>/release/files/…`             | `/<product>/distribution/files/…`             |
| `/<product>/release/blobs/sha256/<hash>` | `/<product>/distribution/blobs/sha256/<hash>` |

Published `curl … | sh` lines, the download URLs the SDKs build, the appcast's enclosure URLs
and the installer's own download base all use the `/release/…` spellings, and keep doing so:
the installer script is byte-identical under every spelling. Discovery advertises the
canonical URLs in the `distribution` fragment (`download`, `install`, `builds`, `blobs`);
the `release` fragment keeps its old keys, which name the aliases.

### The bytes host

`builds`, `files` and `blobs` — both spellings — also answer on the bytes host
(`BLOB_ORIGIN`, `https://dl.plrs.im` in production), with that host's hardening:
`nosniff`, a `sandbox` Content-Security-Policy, no cookies, and an inert-type allowlist.
The installer and the direct download are console-host routes only.

### With Distribution off

Byte delivery needs Distribution. A product that runs Release without it serves **no
downloads**: every byte route and every alias answers not-found. On the console host that is
the platform's registry not-found body (`{"error":{"code":"not_found"}}`), the same answer a
disabled service or an unknown path gets; on the bytes host it is that host's flat
`{"error":"not_found"}`, the same answer an absent route gets. A disabled service cannot be
told apart from a missing one on either host.

Every product that had Release on when Distribution shipped had Distribution switched on by a
migration, so nothing that served downloads stopped. A manifest that later enables Release
without Distribution loses its downloads by choice.

### Rate limits, caching and CORS

The byte routes count against the same per-client lanes as before (the artifact lane for
bytes, the metadata lane for the installer), because the budget defended is one product's
GitHub installation quota. A request counts before its access is decided, so a refused one spends the budget too. None of them is put in the edge cache. CORS follows the product's
`web.origins` for the canonical paths and, through the rewrite, for every alias; the bytes host
applies it in its own dispatcher.

## Delivery access

Who may download a deliverable is stored per deliverable in `dist_access`:

| Mode            | Who may download                                                      |
| --------------- | --------------------------------------------------------------------- |
| `public`        | anyone                                                                |
| `authenticated` | a device whose licence is usable                                      |
| `licensed`      | a device whose licence is usable (identical to `authenticated` today) |
| `entitled`      | a device whose own licence covers the requested channel and version   |

A deliverable with no row of its own inherits the `app` row; a product with no `app` row reads
as `entitled` (fail-closed). The refusals are exactly the ones Release answered with: the flat
`download_auth_required` under `authenticated`/`licensed`, the nested `unauthorized`,
`channel_not_allowed` and `version_blocked` under `entitled`
([Eligibility](/docs/services/update/eligibility/) has the full decision).

### One answer for every surface

The appcast, the download routes and the portal's download mint all read the same
`delivery.accessMode()`. Before, the feed and the download read access separately, so a feed
could offer what the download then refused.

- **Downloads.** `dl` and `builds` check their selector; `files` checks the release's stored
  version as one fixed, pinned version, never as a moving channel; `blobs` authorises the
  object's holders: an app artifact is served under `entitled` only if a release of this
  product carrying that digest passes the `files` check, under the strictest mode of the
  deliverables whose releases carry it, and a pack's object under the pack's own access and
  gate ([Pack bytes](#pack-bytes)).
- **The appcast** is gated by the `app` deliverable's delivery access.
- **The portal.** A customer has licences, not a device token, so each mode is asked of the
  account's linked licences: `licensed` needs a usable one, `entitled` one whose grant holds the
  release's channel (stable for a GitHub-derived release) and whose window holds its version.
  A public artifact with no GitHub download URL is redirected to its bytes-host URL; a
  non-public one never is, because the browser has no device token to present there.

The `release_config.artifacts_access` column the mode used to live in is no longer read; the
migration copied every product's value into its `app` row.

### Who owns it

The `app` row follows `.pkey/release` `access.artifacts`: Distribution's ingest writes it on
every link and resync, even while Distribution is off, so the row is already right when an
operator turns Distribution on. A manifest with no release block only seeds a missing row as
`public` (the default the old column took on link); it never rewrites an existing one, so
dropping `.pkey/release` leaves a `licensed` product `licensed`, as the old column did. An operator who sets a mode claims the row, and resyncs skip it until
it is handed back — the same rule as every other operator-owned setting, and the reason an
`entitled` mode, which no manifest can express, survives a push. A pack's row has no manifest
spelling; it is operator-owned from the start.

The console's **Update settings** page edits the app's delivery access as **Artifact access**,
with its own owner badge and revert. The admin API (narrative-only, not in the wire spec):

| Method | Path                                                     | Does                                                        |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/manage/api/products/<slug>/distribution/access`        | the app's mode in force, and every stored row               |
| PUT    | `/manage/api/products/<slug>/distribution/access`        | `{ "mode", "deliverable"?, "entitlement"? }`: set and claim |
| POST   | `/manage/api/products/<slug>/distribution/access/revert` | hand the `app` row back to the manifest                     |

Writes are audited as `distribution.access.update` and `distribution.access.revert`.
A pack row's `entitlement` is the pack's **gate**: the licence flag the blob route demands for
its gated objects ([Pack bytes](#pack-bytes)); the app row's is stored and not enforced.
`update/settings` no longer accepts `artifactsAccess` and refuses it by name.

Turning Distribution on in the console runs no ingest, which is why the row is kept current
while Distribution is off: a product whose manifest says `licensed` is `licensed` the moment
Distribution answers, including when the manifest tightened the mode while Distribution was
off. A product with no row at all (no ingest has run since the migration) reads as `entitled`,
never `public`: a missing answer refuses rather than opens.

## Delivery URLs

The `delivery` hook's `deliveryUrl({releaseId, buildId | name, outlet?})` mints the canonical
URL of one release file or of a build's payload: on the bytes host when `BLOB_ORIGIN` is set,
otherwise a path on this origin. Both are minted as `…/distribution/files/<releaseId>/<name>`,
pinned to the release by its id, so the URL is immutable. A build URL is never minted from the
release's stored version: a release synced from a GitHub tag such as `latest` or `beta` stores
that tag as its version, and `builds/latest/…` would serve whatever the channel points at now. It
answers `null` for a release, file, build or build payload that does not exist, for a release
that is not the app's (a pack's objects are reached by SHA-256 on the blob route), and for an
outlet that delivers the deliverable by a transport other than `pkey-cdn`. Storefront feeds, the
download page and the updater feeds link through it.

## Pack bytes

Every object a pack release names — each variant's `full` payload, its files index and gaps,
its deltas — and every file blob its index names is served by the **blob route**, by the
SHA-256 of its stored bytes (and, for a browser, a container's payload and deltas also by the
[payload URL](#web-deltas-the-payload-url), under the same decision): `files/<packRelease>/…` and
`builds/…?deliverable=<pack>` answer not-found. A device takes the hash from the verified
record or index, so it can check `ETag` and `Repr-Digest` before it decodes anything.

The responses are the blob route's: `GET` and `HEAD`, one `Range` (a multi-range request gets
the whole `200`), `If-Range` on the strong `ETag` (the SHA-256) evaluated by the Worker, a
`Repr-Digest: sha-256=:…:` for the whole object, and **no `Content-Encoding`**: zstd objects
are opaque bytes the client decodes, served `application/octet-stream` with `no-transform` so
no proxy recompresses them. CORS for the web transport is the product's `web.origins`; a
cross-origin `If-Range` is preflighted, and the bytes host allows `Range` and `If-Range`.

**Who may fetch** is decided per request from the object's holders in this product (another
product's copy never counts):

| The object                                     | Requires                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| under `gated/`, while its pack is gated        | a device whose licence holds the pack's **current** gate flag                    |
| under `blobs/`, or a pack un-gated since       | the pack's mode: `public` anyone; `authenticated` or `licensed` a usable licence |
| the same, pack mode `entitled` with a gate     | the gate's flag                                                                  |
| the same, pack mode `entitled` and **no gate** | nobody: `403 delivery_gate_missing` until a gate or a looser mode is set         |

The gate is the `entitlement` of the pack's own access row, read at each request: renaming the
flag moves who may download at once. Neither the manifest's assertion nor a record's
`entitlement` (a publish-time snapshot) decides it, and the app's version window never applies
to a pack. Refusals are `401 unauthorized` without a usable licence and `403 not_entitled`
without the flag. Only an object whose every holder is `public` is cached publicly
(`public, max-age=31536000, immutable`); anything else, and everything under `gated/`, is
`private, no-store`.

Objects never move between prefixes. A pack gated after a release keeps that release's `blobs/`
objects on the public path under its mode (their earlier responses were cacheable and cannot be
recalled; a gate protects the bytes published after it); a pack un-gated later serves its
`gated/` objects under its mode, still `private, no-store`. Dedupe is per prefix, so a gated and
a free pack never share stored bytes by accident.

## Web deltas: the payload URL

`GET /<product>/distribution/packs/<pack>/<variant>/payload/<sha256>` serves one **container**
variant's payload (`<sha256>` is its `payload.sha256`, `<variant>` the variant key such as
`texture=s3tc`, or `default`) to a browser, using Compression Dictionary Transport (RFC 9842).
The blob route keeps every object opaque (no `Content-Encoding`, so `Range` and the stored hash
stay intact); a browser, though, keeps a response as a dictionary after decoding it, and a
`--patch-from` delta's base is the decoded payload. So this second URL:

- streams the stored `full` frame with **`Content-Encoding: zstd`** (only when the request
  accepts `zstd`; `406` otherwise, and the SDK takes the blob route), or raw for `codec: none`;
- adds **`Use-As-Dictionary`** with a match pattern covering exactly that pack and variant's
  payload URLs, for an ungated payload of at most 100 MiB (Chromium's limit);
- answers **`Content-Encoding: dcz`** when `Available-Dictionary` is the `from` of a published
  `zstd-patch-from` delta to the requested payload: an 8-byte magic, the 32-byte `from`, then the
  stored artifact, unchanged (no base byte is read, and the stored artifact stays the portable
  bare frame). Another dictionary, or none, gets the full payload, and with **`?via=dcz`** (what
  the SDK sends) `409` with no body, so a miss never becomes a silent full download;
- sends `Vary: Accept-Encoding, Available-Dictionary` on every answer, full-body only
  (`Accept-Ranges: none`).

Who may fetch is the blob route's decision for the `full` object and, for `dcz`, for the delta
artifact. Caching follows it, with one difference: an ungated payload that is not public (the
pack needs a licence) is `private, max-age=31536000, immutable`, so the authorised browser may
keep it as a dictionary and no shared cache may. A **gated** payload is `private, no-store` and
never a dictionary: gated packs always take the WASM path. The payload is found among the pack's
200 newest releases; an older one, a tree variant or an unknown hash is the plain not-found.
Cloudflare passes the dictionary headers through and varies its cache on them; it never computes
a delta itself. What each browser ends up doing is in the
[React SDK](/docs/build/sdks/react/#what-the-web-gets-payload-urls-and-compression-dictionary-transport).

## Pack transports

`.pkey/distribution`'s `transports` resolve to one stored transport per (deliverable, outlet),
packs included: a deliverable's own entry, else `transports.packs` for a pack, else the
default. v1 acts on three: `pkey-cdn` and `web` (the blob route above) and `embedded` (a
baseline inside the app build). Any other transport (`apple-ba`, `play-pad`, `steam-depot`,
`msix-optional`, `flatpak-ext`) is stored and listed with `supported: false` — the console's
matrix labels it "not delivered by Polaris Key" — and nothing is derived or served for it; a
device whose outlet names one plans nothing for that pack (`plan.transport_unsupported`),
never a silent CDN fallback. [Availability](/docs/services/distribution/availability/) has
when each is live.

## Garbage collection

The blob store is content-addressed, so it would grow forever without a collector. Core's
collector runs on the nightly maintenance cron:

1. **Per product**, it drops the refs no live reference needs: a dead pack release's
   `pack-object` refs, and `pack-upload` refs to keys no live release's record, files index or
   chunk index names. Live means pinned or held by a live app release, in a current pack set,
   the previous release of a set member, a pack pointer, named by a rollout, listed on an outlet,
   a revocation's replacement, newer than every live release, or one of the three newest.
   While a pack rollout is not complete, every release of that pack below its target is live
   too (a gate's fallback). Revoked releases are never live. `artifact` and `feed` refs are never
   dropped, nor is any ref to a key a live release names. A ref is dropped only once older than
   the grace period and only when the whole live set was read that night; a ref the collector
   took from a release that is live again is restored.
2. It **marks** objects no product references and clears the mark of re-referenced ones.
3. It **sweeps** objects unreferenced for the grace period (30 days, `BLOB_GC_GRACE_DAYS`, at
   least one) **and** older than the 180-day bucket lock, at most 1,000 per night: it claims
   each, deletes it from R2, then deletes its row. A delta whose endpoint is gone or unreferenced
   goes after one day.

`BLOB_GC_MODE=off` stops it. Every dropped or restored ref and every deletion is logged in
`blob_gc_log`, and each product's drops are audited (`core.blob_gc.refs_dropped`). The console's
dry run is `GET /manage/api/products/<slug>/blob-gc`, and `…/blob-gc/bundles` shows each chunk
bundle a live release's index names with its live-data ratio (the share of its bytes live
indexes still read). A pack's chunk bundles are blobs, so a bundle stays as long as any live
release's chunk index names it, even after the release that uploaded it is dead; a live variant
whose chunk index cannot be read keeps every `pack-upload` ref that night.

## See also

- [Rollouts and halts](/docs/services/distribution/rollouts/) — the outlet-scoped rollout
  controls.
- [Artifacts, changelog & install](/docs/services/release/artifacts/) — what each byte route
  resolves and serves.
- [Public route table](/docs/reference/routes/) — every canonical route and alias.

## Package feeds switch

Each product has an operator-owned **package feeds** switch (F-03): on, its
[package feeds](/docs/start/concepts/#packages) answer on `pkg.plrs.im`; off, every feed read
for that product stops at once and looks like an unknown owner. A manifest never sets it.

```http
GET /manage/api/products/<product>/distribution/package-feeds
PUT /manage/api/products/<product>/distribution/package-feeds   {"enabled": true, "expectedVersion": 0}
```

`expectedVersion` is the version the operator read (0 before it was ever set); a stale one is a
409 (`version_conflict`) carrying the current state. Turning it on queues a full render of the
product's feeds. Each change is audited as `distribution.package_feeds.update`.
