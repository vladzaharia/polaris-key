---
sidebar:
  order: 5
title: "Channels and policy"
description: "How a channel resolves per platform, and how operators and CI promote, pin, yank and set floors."
---

A channel answers one question for each deliverable: which release does it serve on this
platform and architecture? The answer comes from the [truth store](/docs/services/release/truth-store/),
not from the order GitHub happens to list releases in, and it is the same answer on every
surface: the [build routes](/docs/services/release/artifacts/#builds-files-and-blobs), the
download route, the [appcast](/docs/services/update/appcast/) and the version check.

## Resolution rules

The rules apply to every deliverable, the product's `app` and each pack alike.

1. **Candidates** are the deliverable's releases that are members of the channel or of a
   channel it includes, plus the channel's pointer. A release is a member of the channel it
   was published to (the release descriptor's `channel`). A release with no recorded channel
   is derived from GitHub: a prerelease belongs to `beta`, anything else to `stable`, and a
   tag matching a manual channel's regex belongs to that channel as well.
2. **Includes.** `beta` includes `stable` unless its policy says otherwise, so the beta
   channel serves the newest of either. Includes are followed transitively.
3. **Yanks.** A yanked release is removed from the candidates. Only an explicit pin can serve
   it, and so can a version selector such as `1.2.3`, which names one release explicitly.
4. **Order.** The newest candidate is the highest version in the deliverable's version scheme
   (`semver`, `semver+build` or `4part`), with ties going to the later publication. For the
   app, a tag listed in `ignoreTags` is never a candidate, and a tag outside
   `stableTagPattern` is a candidate only through a manual channel's own regex.
5. **Pins.** A pinned channel serves only releases at or below its pointer. An unpinned
   channel serves the newest candidate.
6. **Per platform.** Only releases with a build for the requested platform (or build id) and
   a matching architecture remain. `universal` and `any` match every architecture. A release
   missing the iOS build therefore does not blank iOS: iOS falls back to the newest release
   that has one. Whether that build is live in a particular store is a separate question,
   answered by distribution.

Channel names are canonical. `latest` means `stable`, and `staging` is the legacy spelling of
`beta` unless the product declares a manual channel named `staging`. Policy rows always store
the canonical name, never `staging`.

## The policy row

Each (deliverable, channel) pair may have one policy row:

| Field          | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `pointer`      | A release that is a member of the channel. With `pinned`, the channel's ceiling.      |
| `pinned`       | Freeze the channel at or below the pointer.                                           |
| `includes`     | Channels this one includes (the manifest's declaration).                              |
| `minSupported` | The device floor the signed feed will carry. Stored and returned, not yet enforced.   |
| `critical`     | Flags the current pointer release as critical. Stored and returned, not yet enforced. |
| `source`       | `manifest` until an operator or CI changes the row, then `admin`.                     |

`minSupported` is not the anti-rollback floor. That one is the highest version a sync has
seen on a channel; it keeps its own endpoint (`POST …/release/channels/<channel>/floor`) and
is described on [the truth store](/docs/services/release/truth-store/). The two never share a
name.

Any operator or CI change claims the row (`source` becomes `admin`), so a resync never undoes
it. "Revert" hands the row back to the manifest, and the next resync applies the manifest's
declaration again.

## Pointers and pins

| Operation | Effect                                                                         |
| --------- | ------------------------------------------------------------------------------ |
| promote   | Sets the pointer. The release becomes a member; the pin flag is left as it is. |
| pin       | Sets the pointer and pins the channel to it. A yanked release may be pinned.   |
| unpin     | Clears the pin. The pointer stays a member of the channel.                     |

A yanked release cannot be promoted. Unyank it first, or pin it explicitly.

A pin is the one deliberate way below the anti-rollback floor: a pinned channel serves its
pointer exactly, with no floor check, even when the pointer is yanked or older than the floor.
That is why pin needs the same `release:promote` scope as promote and is audited with its
actor.

## Yanks

A yank withdraws a release from every moving selector — `latest`, `stable`, `beta`, manual
channels — on every surface. How soon each surface stops offering it is set out under
[Caching](#caching): the download, build, file and blob routes stop on the next request, but
for a public product the edge-cached version check and appcast can keep the old answer for up
to two and five minutes. Nothing is deleted, and the release still resolves by version and by
pin. A yank needs a reason, which is kept with the actor and the time.

On the download route, the appcast and the version check, a yanked release that held up its
channel's anti-rollback floor lowers that floor rather than removing it. The floor drops to
the newest unyanked release the truth store holds below it, so the channel falls back to that
release instead of answering not-found. That release then holds the channel up like any
floor: if it is later deleted upstream, the channel answers not-found rather than falling
further. A floor with no unyanked release below it holds nothing up.

### Package versions

A [package](/docs/build/manifest/authoring/#package-deliverables) version's yank is also its
feed state: the version is marked yanked (with the reason, which PyPI shows as its PEP 592 yank
reason) and its feeds re-render. Unyank returns it to live. A package version can also be
**deprecated**, a warning the feeds show (npm's `deprecated`) while the version stays
installable:

```http
POST   /manage/api/products/<product>/release/releases/<releaseId>/deprecate   {"message": "use 2.x"}
DELETE /manage/api/products/<product>/release/releases/<releaseId>/deprecate
```

Deprecation applies to package versions only (404 otherwise) and never to a yanked one (409:
unyank it first); it is audited as `release.package.deprecate` / `release.package.undeprecate`.
A yank overrides a deprecation, and an unyank leaves the version live. None of this frees the
version: a package version is never published again, whatever its state. Moving a channel's
pointer for a package deliverable re-renders its feeds too (`stable` is the feeds' `latest`
tag; every other channel is a tag of its own name).

## Who can change it

**CI**, with a `pkeyci_` token issued for the product:

```
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

| Method and path                                                  | Does                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET channels`                                                   | Every deliverable's channels, policies, sources, and what each resolves to now, overall and per platform.                      |
| `PUT channels/<channel>`                                         | Set `pointer`, `pinned`, `minSupported`, `critical`.                                                                           |
| `POST channels/<channel>/revert`                                 | Hand the row back to the manifest.                                                                                             |
| `POST releases/<releaseId>/yank`                                 | Yank, with `reason`.                                                                                                           |
| `DELETE releases/<releaseId>/yank`                               | Lift the yank.                                                                                                                 |
| `GET releases`                                                   | App releases with their builds, artifact roles, SHA-256s, locations and yank, plus their pack pins.                            |
| `GET deliverables`                                               | The app and every pack, with the declaration, gate and latest release ([Packs](/docs/services/release/packs/#in-the-console)). |
| `GET deliverables/<id>/releases`                                 | A pack's releases and the app releases that pin each.                                                                          |
| `GET deliverables/<id>/releases/<releaseId>/files?variant=<key>` | One variant's files, read from its files index ([Packs](/docs/services/release/packs/#in-the-console)).                        |

Every change writes an audit row naming its actor (`admin` for the console session's subject,
`ci:<subject>` for a CI token), and invalidates the product's cached resolutions. See
[Caching](#caching) for how soon each surface reflects it.

## Caching

The download route, the appcast, the version check and the console's release health check
resolve a channel against GitHub at most once per 90 seconds. A sync, a resync, any policy
change and any floor change drop those cached resolutions immediately. What the 90 seconds
alone bounds is a change nobody told the worker about, such as a release deleted on GitHub
with no webhook. A channel that resolves to nothing is never cached.

That does not make every surface change on the next request. How soon a yank, pin, unpin or
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

- [Artifacts, changelog & install](/docs/services/release/artifacts/) — the routes these rules
  serve.
- [The truth store](/docs/services/release/truth-store/) — the rows resolution reads.
- [Public route table](/docs/reference/routes/) — the CI routes with their schemas.
