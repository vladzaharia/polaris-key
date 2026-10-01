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

| Canonical route                                                  | Methods  | Bytes host |
| ---------------------------------------------------------------- | -------- | ---------- |
| `GET /<product>/distribution/install.sh`                         | any      | no         |
| `GET /<product>/distribution/dl/<version>/<binary>-<arch>[.dmg]` | any      | no         |
| `GET /<product>/distribution/builds/<selector>/<buildId>`        | GET/HEAD | yes        |
| `GET /<product>/distribution/files/<releaseId>/<name>`           | GET/HEAD | yes        |
| `GET /<product>/distribution/blobs/sha256/<hash>`                | GET/HEAD | yes        |

What each one does — selector resolution, the location order (R2, then GitHub, then an
external URL), `?checksum=sha256`, `?redirect=1`, `Range`, cache headers — is unchanged from
when Release served them, and is described on
[Artifacts, changelog & install](/docs/services/release/artifacts/). The bytes on GitHub are
still fetched by Release, with its own installation token and its SSRF guard, through the
`releaseCatalog` hook: Distribution holds no GitHub token. R2-held bytes come from the core
blob store, and a `gated/` object is never served by these routes until per-request
authorisation for gated content exists.

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
GitHub installation quota. None of them is put in the edge cache. CORS follows the product's
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

A deliverable with no row of its own inherits the `app` row; a product with no `app` row is
`public`. The refusals are exactly the ones Release answered with: the flat
`download_auth_required` under `authenticated`/`licensed`, the nested `unauthorized`,
`channel_not_allowed` and `version_blocked` under `entitled`
([Eligibility](/docs/services/update/eligibility/) has the full decision).

### One answer for every surface

The appcast, the download routes and the portal's download mint all read the same
`delivery.accessMode()`. Before, the feed and the download read access separately, so a feed
could offer what the download then refused.

- **Downloads.** `dl` and `builds` check their selector; `files` checks the release's stored
  version as one fixed, pinned version, never as a moving channel; `blobs` serves an object
  under `entitled` only if a release of this product carrying that digest passes the `files`
  check, and uses the strictest mode of the deliverables whose releases carry it.
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
every link and resync. An operator who sets a mode claims the row, and resyncs skip it until
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
`entitlement` is stored and shown for a future named entitlement (paid packs); nothing
enforces it yet. `update/settings` no longer accepts `artifactsAccess` and refuses it by name.

A product that turns Distribution on after a manifest change made while it was off keeps the
delivery access it had until its next resync, which re-applies the manifest's mode.

## Delivery URLs

The `delivery` hook's `deliveryUrl({releaseId, buildId | name, outlet?})` mints the canonical
URL of one release file or of a build's payload: on the bytes host when `BLOB_ORIGIN` is set,
otherwise a path on this origin. Both are minted as `…/distribution/files/<releaseId>/<name>`,
pinned to the release by its id, so the URL is immutable. A build URL is never minted from the
release's stored version: a release synced from a GitHub tag such as `latest` or `beta` stores
that tag as its version, and `builds/latest/…` would serve whatever the channel points at now. It
answers `null` for a release, file, build or build payload that does not exist, and for an outlet
that delivers the deliverable by a transport other than `pkey-cdn`. Storefront feeds, the download page, the
updater feeds and pack transports link through it.

## See also

- [Rollouts and halts](/docs/services/distribution/rollouts/) — the outlet-scoped rollout
  controls.
- [Artifacts, changelog & install](/docs/services/release/artifacts/) — what each byte route
  resolves and serves.
- [Public route table](/docs/reference/routes/) — every canonical route and alias.
