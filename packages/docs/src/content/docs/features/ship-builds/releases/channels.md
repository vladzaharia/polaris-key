---
sidebar:
  order: 5
title: "Release tracks and policy"
description: "How a release track resolves per platform, and how operators and CI promote, pin, yank and set floors."
type: "concept"
lastReviewed: "2026-10-16"
---

A release track answers one question for each deliverable: which release does it serve on this
platform and architecture? The answer comes from the truth store,
not from the order GitHub happens to list releases in, and it is the same answer on every
surface: the [build routes](/docs/features/ship-builds/releases/artifacts/#builds-files-and-blobs), the
download route, the [appcast](/docs/features/ship-builds/updates/appcast/) and the version check.

In the console, release tracks are under **Ship builds → Channels**.

## Resolution rules

The rules apply to every deliverable, the product's `app` and each pack alike.

1. **Candidates** are the deliverable's releases that are members of the release track or of a
   release track it includes, plus the release track's pointer. A release is a member of the release track it
   was published to (the release descriptor's `channel`). A release with no recorded release track
   is derived from GitHub: a prerelease belongs to `beta`, anything else to `stable`, and a
   tag matching a manual release track's regex belongs to that release track as well.
2. **Includes.** `dev` includes `beta` and `beta` includes `stable` unless the release track's policy
   says otherwise, so the `dev` release track serves the newest build of any of the three. Includes
   are followed transitively. `stable`, `beta` and `dev` exist for every product without a
   declaration. A product that already published to `dev` without declaring it now gets
   `beta` and `stable` builds on it too; declare `includes: []` on `dev` to keep it to its own
   builds. A `dev` the product declares itself (its own rule or its own `includes`) keeps priority over the built-in one.
3. **Yanks.** A yanked release is removed from the candidates. Only an explicit pin can serve
   it, and so can a version selector such as `1.2.3`, which names one release explicitly.
4. **Order.** The newest candidate is the highest version in the deliverable's version scheme
   (`semver`, `semver+build` or `4part`), and the later publication wins a tie. For the
   app, a tag listed in `ignoreTags` is never a candidate, and a tag outside
   `stableTagPattern` is a candidate only through a manual release track's own regex.
5. **Pins.** A pinned release track serves only releases at or below its pointer. An unpinned
   release track serves the newest candidate.
6. **Per platform.** Only releases with a build for the requested platform (or build id) and
   a matching architecture remain. `universal` and `any` match every architecture. A release
   missing the iOS build therefore does not blank iOS: iOS falls back to the newest release
   that has one. Whether that build is live in a particular store is a separate question,
   answered by distribution.

Release track names are canonical. `latest` means `stable`, and `staging` is the legacy spelling of
`beta` unless the product declares a manual release track named `staging`. Policy rows always store
the canonical name, never `staging`.

## The policy row

Each (deliverable, release track) pair may have one policy row:

| Field          | Meaning                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pointer`      | A release that is a member of the release track. With `pinned`, the release track's ceiling.                                                                                                            |
| `pinned`       | Freeze the release track at or below the pointer.                                                                                                                                                       |
| `includes`     | Release tracks this one includes (the manifest's declaration).                                                                                                                                          |
| `minSupported` | The device floor the signed feed carries. An install below it gets an update prompt it can't dismiss ([floors prompt](/docs/features/ship-builds/updates/signed-feed/#floors-prompt-they-never-block)). |
| `critical`     | Marks the pointer release critical, so it skips rollout buckets.                                                                                                                                        |
| `source`       | `manifest` until an operator or CI changes the row, then `admin`.                                                                                                                                       |

`minSupported` is not the anti-rollback floor. That one is the highest version a sync has
seen on a release track; it keeps its own endpoint (`POST …/release/channels/<channel>/floor`) and
is described on the truth store. The two never share a
name.

Any operator or CI change claims the row (`source` becomes `admin`), so a resync never undoes
it. "Revert" hands the row back to the manifest, and the next resync applies the manifest's
declaration again.

## Pointers and pins

| Operation | Effect                                                                             |
| --------- | ---------------------------------------------------------------------------------- |
| promote   | Sets the pointer. The release becomes a member; the pin flag is left as it is.     |
| pin       | Sets the pointer and pins the release track to it. A yanked release may be pinned. |
| unpin     | Clears the pin. The pointer stays a member of the release track.                   |

A yanked release cannot be promoted. Unyank it first, or pin it explicitly.

A pin is the one deliberate way below the anti-rollback floor: a pinned release track serves its
pointer exactly, with no floor check, even when the pointer is yanked or older than the floor.
That is why pin needs the same `release:promote` scope as promote and is audited with its
actor.

## Yanks

A yank withdraws a release from every moving selector — `latest`, `stable`, `beta`, manual
release tracks — on every surface. When each surface stops offering it is set out under
[Caching](#caching): the download, build, file and blob routes stop on the next request, but
for a public product the edge-cached version check and appcast can keep the old answer for up
to two and five minutes. Nothing is deleted, and the release still resolves by version and by
pin. A yank needs a reason, which is kept with the actor and the time.

On the download route, the appcast and the version check, a yanked release that held up its
release track's anti-rollback floor lowers that floor rather than removing it. The floor drops to
the newest unyanked release the truth store holds below it, so the release track falls back to that
release instead of answering not-found. That release then holds the release track up like any
floor: if it is later deleted upstream, the release track answers not-found rather than falling
further. A floor with no unyanked release below it holds nothing up.

### Package versions

A [package](/docs/build/manifest/release/#package-deliverables) version's yank is also its
feed state: the version is marked yanked (with the reason, which PyPI shows as its PEP 592 yank
reason) and its feeds re-render. Unyank returns it to live. A package version can also be
**deprecated**, a warning the feeds show (npm's `deprecated`) while the version stays
installable:

```text title="Request"
/manage/api/products/<product>/release/releases/<releaseId>/deprecate
  POST    {"message": "use 2.x"}   deprecate
  DELETE                           undeprecate
```

Deprecation applies to package versions only (404 otherwise) and never to a yanked one (409:
unyank it first); it is audited as `release.package.deprecate` / `release.package.undeprecate`.
A yank overrides a deprecation, and an unyank leaves the version live. None of this frees the
version: a package version is never published again, whatever its state. Moving a release track's
pointer for a package deliverable re-renders its feeds too (`stable` is the feeds' `latest`
tag; every other release track is a tag of its own name).

## Who can change it

**CI**, with a `pkeyci_` token issued for the product:

```text title="Request"
POST /<product>/release/channels/<channel>/promote   {"releaseId": "v1.4.0", "deliverable": "app"}
POST /<product>/release/channels/<channel>/pin       {"releaseId": "v1.3.2"}
POST /<product>/release/channels/<channel>/unpin     {}
POST /<product>/release/releases/<releaseId>/yank    {"reason": "crashes on launch"}
```

Promote, pin and unpin need the `release:promote` scope, and a yank needs `release:yank`. A
missing or unknown token answers 401. A token issued for another product looks exactly like an
unknown one. A token without the scope answers 403 with `reason: missing_scope`. These are CI
routes and answer no CORS.

**Operators**, in the console (all under `/manage/api/products/<slug>/release/`):

| Method and path                                                  | Does                                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET channels`                                                   | Every deliverable's release tracks, policies, sources, and what each resolves to now, overall and per platform.                    |
| `PUT channels/<channel>`                                         | Set `pointer`, `pinned`, `minSupported`, `critical`; for a pack, a floor per line with `contentApi`.                               |
| `POST channels/<channel>/revert`                                 | Hand the row back to the manifest.                                                                                                 |
| `POST releases/<releaseId>/yank`                                 | Yank an app or pack release, with `reason`.                                                                                        |
| `DELETE releases/<releaseId>/yank`                               | Lift the yank.                                                                                                                     |
| `GET releases`                                                   | App releases with their builds, artifact roles, SHA-256s, locations, yank, pack pins and record `signer` (the release key).        |
| `GET deliverables`                                               | The app and every pack, with the declaration, gate and latest release ([Packs](/docs/features/ship-builds/packs/#in-the-console)). |
| `GET deliverables/<id>/releases`                                 | A pack's releases and the app releases that pin each.                                                                              |
| `GET deliverables/<id>/releases/<releaseId>/files?variant=<key>` | One variant's files, read from its files index ([Packs](/docs/features/ship-builds/packs/#in-the-console)).                        |

Every change writes an audit row naming its actor (`admin` for the console session's subject,
`ci:<subject>` for a CI token), and invalidates the product's cached resolutions. See
[Caching](#caching) for when each surface reflects it.

## Caching

The download route, the appcast, the version check and the console's release health check
resolve a release track against GitHub at most once per 90 seconds. A sync, a resync, any policy
change and any floor change drop those cached resolutions immediately. What the 90 seconds
alone bounds is a change nobody told the worker about, such as a release deleted on GitHub
with no webhook. A release track that resolves to nothing is never cached.

That does not make every surface change on the next request. When a yank, pin, unpin or
promote reaches each surface:

| Surface                                                 | Sees the change                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Build, file and blob routes; the download route         | On the next request, within KV's propagation delay across locations.      |
| Version check (`/update/version`), for a public product | Up to 120 seconds later in each Cloudflare location, from its edge cache. |
| Appcasts, for a public product                          | Up to 300 seconds later in each Cloudflare location, from its edge cache. |
| Version check and appcasts, for a non-public product    | On the next request, as for the download route.                           |

The edge cache is keyed by product, surface, selector and architecture only, and a policy
change does not purge it: adding a KV read to every cache hit would cost the edge cache the
property that makes it a defence against request floods. Moving-selector responses also carry
`Cache-Control: public, max-age=120` (appcasts `max-age=300`), so a browser or proxy that keeps
one can hold the old answer for as long. Plan an emergency yank with these windows in mind: a
client that checks for updates within them can still be offered the yanked release.

## See also

- [Artifacts, changelog & install](/docs/features/ship-builds/releases/artifacts/) — the routes these rules
  serve.
- [Public route table](/docs/reference/routes/) — the CI routes with their schemas.
