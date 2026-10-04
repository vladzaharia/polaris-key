---
sidebar:
  order: 10
title: "Package feeds"
description: "The registry host, pkg.plrs.im: package feeds for npm, PyPI, SwiftPM, Maven and Gradle, OCI and Godot clients, with one access check before every cached answer."
---

Package feeds let a product publish libraries and tools to the package managers its users
already run. They answer on their own host, **`pkg.plrs.im`** (`pkg-staging.plrs.im` and
`pkg-dev.plrs.im` in the other environments): the same Worker as the console, on a third custom
domain beside `key.plrs.im` and the bytes host `dl.plrs.im`.

## URL layout

Every feed is under its owner (the product slug), so a product never shadows another's names.
OCI is the exception the protocol forces: its root is `/v2/`, and the repository name starts with
the owner.

| Ecosystem | Base URL                                   | Clients                                    |
| --------- | ------------------------------------------ | ------------------------------------------ |
| npm       | `https://pkg.plrs.im/npm/<owner>/`         | npm, pnpm, Yarn Berry, Bun                 |
| PyPI      | `https://pkg.plrs.im/pypi/<owner>/simple/` | pip, uv, Poetry                            |
| Swift     | `https://pkg.plrs.im/swift/<owner>/`       | SwiftPM                                    |
| Maven     | `https://pkg.plrs.im/maven/<owner>/`       | Gradle, Maven                              |
| OCI       | `https://pkg.plrs.im/v2/<owner>/…`         | docker, podman, crane                      |
| Godot     | `https://pkg.plrs.im/godot/<owner>/`       | the Godot editor's asset library, GodotEnv |

`GET /` is a static page naming the host, and `GET /v2/` is OCI's base answer (`200`,
`Docker-Distribution-API-Version: registry/2.0`). Cargo, Go and NuGet names are reserved and
answer the not-found.

## What the host promises

The host is a sibling of the console, so it keeps every guarantee of the bytes host and widens
only the types it may serve:

- **No cookies.** None is read or set. The console's session cookies are host-only, so a browser
  never sends them here.
- **No CORS, GET and HEAD only.** Registry clients are not browsers. `OPTIONS` and every other
  method answer `405`.
- **Inert answers.** Every answer carries `X-Content-Type-Options: nosniff`, a `sandbox`
  `Content-Security-Policy` with no sources, `Referrer-Policy: no-referrer` and
  `Cross-Origin-Resource-Policy: same-origin`. A success must have a type on the host's
  allowlist: registry JSON, `text/x-swift` (always an attachment), PNG, JPEG and archive types.
  XML files (POMs, `maven-metadata.xml`) go out as `application/octet-stream` attachments. The
  only HTML is PyPI's simple page for clients that do not ask for JSON, under a policy that
  forbids script, forms and framing.
- **One not-found.** An unknown owner, a service or feed that is off and a missing object all
  answer the same `404`, so whether a feed exists cannot be probed.

## Who may read

Every read runs one access check before the edge cache is consulted:

1. the platform's switch for the ecosystem;
2. the owner's Distribution and its package-feeds switch, then the feed's own switch;
3. the access mode: the stricter of the feed's mode and the package's delivery access
   (`public`, `authenticated`, `licensed`, `entitled`).

`public` feeds are open to everyone. Any other mode answers the client's native `401`
(`WWW-Authenticate: Basic` for npm, PyPI, Maven, Swift and Godot; OCI's `Bearer` challenge),
because registry credentials are not issued yet. Settings are held for 30 seconds per isolate,
so turning a feed off or tightening its mode reaches every answer within that window, even one
the edge has cached as immutable.

## Caching

| Answer                                                             | `Cache-Control`                                 | `ETag`             |
| ------------------------------------------------------------------ | ----------------------------------------------- | ------------------ |
| Content-addressed bytes (tarballs, wheels, zips, OCI blobs, icons) | `public, max-age=31536000, immutable`           | the SHA-256        |
| Index documents (packuments, simple pages, metadata, tag lists)    | `public, max-age=60, stale-while-revalidate=60` | the body's SHA-256 |
| Not-found and refusals                                             | `no-store`                                      | none               |
| Any non-public feed                                                | `private, no-store`                             | none               |

A new version shows up within about a minute. Index documents are rendered when a package
changes and kept in the blob bucket under `registry/`; a document that goes missing is rendered
again on the next read.

## OCI images

The OCI feed serves container images (and any OCI artifact built as an image) to `docker`,
`podman`, `crane` and every other client of the
[OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md).
A repository's full name is `<owner>/<repository>`, where `<repository>` is the package
deliverable's declared `name` (lower-case path components such as `tools/pkey`):

```sh
docker pull pkg.plrs.im/polaris-key/tools/pkey:latest
podman pull pkg.plrs.im/polaris-key/tools/pkey:1.4.0
crane pull --platform linux/arm64 pkg.plrs.im/polaris-key/tools/pkey:beta pkey.tar
```

**What it answers.** Pulls only, anonymous while the feed is public:

| Request                                                    | Answer                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`/`HEAD /v2/<owner>/<repository>/manifests/<tag>`      | the manifest or image index the tag points to, with its own media type and `Docker-Content-Digest`; cached for 60 s                              |
| `GET`/`HEAD /v2/<owner>/<repository>/manifests/sha256:<…>` | the same bytes by digest, immutable                                                                                                              |
| `GET`/`HEAD /v2/<owner>/<repository>/blobs/sha256:<…>`     | a config or layer, immutable, with `Range` (206) and `If-Range`; only digests this repository published                                          |
| `GET /v2/<owner>/<repository>/tags/list[?n=&last=]`        | the tags in lexical order; with `n`, a `Link: …; rel="next"` header names the next page                                                          |
| anything else under `/v2/`                                 | OCI's error JSON (`NAME_UNKNOWN`, `MANIFEST_UNKNOWN`, `BLOB_UNKNOWN`); push methods are 405 `UNSUPPORTED`; `/v2/token` is 404 until tokens exist |

Every answer carries `Docker-Distribution-API-Version: registry/2.0`. A feed that is not public
answers 401 with OCI's `Bearer` challenge; registry credentials are not issued yet.

**Tags.** Each version is a tag of its own name, and it never moves. Each channel is a moving tag:
`stable` is `latest`, and every other channel (`beta`, a manual channel) a tag of its own name,
pointing at the newest version the channel serves. A channel spelled like an existing version is
not tagged, because the version tag wins.

**Yanks and deprecations.** OCI has neither, so a **yanked** version loses its tag (it leaves the
tag list and `pull <name>:<version>` fails) but still pulls **by digest**, so a deployment pinned
to `name@sha256:…` keeps working. A **deprecated** version is served exactly like a live one.

**Publishing.** Declare the package in `.pkey/release` and publish an
[OCI image layout](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) with
`pkey release publish`; the version is also the image's tag, so it has no `+`:

```jsonc
"deliverables": {
  "oci.pkey": { "kind": "package", "ecosystem": "oci", "name": "tools/pkey",
                "artifacts": { "layout": { "match": "image/**" } } }
}
```

```sh
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,tar=false,dest=image .
pkey release publish --product polaris-key --deliverable oci.pkey --dir image --version 1.4.0 --channel stable
```

The CLI reads the layout's `index.json` (exactly one entry: a multi-arch image is one image
index), walks every manifest it references, and uploads each blob once through the upload ticket.
Each blob is at most the feed's ceiling (5 GiB by default), a release is at most 4,096 objects,
and its descriptor at most 64 KiB, which in practice bounds an image to a few hundred blobs.

**Setup snippet.** The console's Setup tab and `pkey feeds setup` (F-12) render this feed from
three values: the registry host (`pkg.plrs.im`, or the environment's), the owner and the
repository; the fully qualified reference `<host>/<owner>/<repository>:<tag>` is the whole
setup, because an OCI client never falls back to another registry for a qualified name.

## Local testing

`pnpm --filter @polaris-key/worker registry:clients` stands up a seeded local Worker on the
registry host (`wrangler dev --env test`, local D1 and R2) and runs real clients against it. The
same harness runs in CI as `registry-clients.yml`.
