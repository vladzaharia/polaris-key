> Research note for [Godot on Polaris Key](../README.md), 2026-10-03. Spike S-12 (no brief in
> `program/`: the lead dispatched it directly, with the owner's direction quoted in §1). A working
> paper kept for its evidence and sources; the README synthesis is the cross-checked position. It is
> a design spike: nothing was deployed, no registry account was used and no product code changed.
> Specifications were read on 2026-10-03; repository facts are from `main` at `25e6209c`.

# S-12: package feeds — Polaris Key as an npm, PyPI, Swift, Maven, OCI and Godot registry

Evidence tags, as in the other notes:

- **[V]**: a primary source read raw (a specification, a client's source file, a Cloudflare limits
  page), fetched on 2026-10-03;
- **[M]**: measured in this repository (code read, a file that does or does not exist);
- **[S]**: a secondary summary (an index or wiki over a project's code);
- **[I]**: inference or recommendation.

## 1. Question

The owner's direction (2026-10-03), taken as decided:

- Polaris Key distributes releases three ways: **direct artifacts** (CLI, apps), **app stores**
  (Distribution's outlets) and **package feeds**. Package feeds are package-manager registries that
  Polaris Key serves. They host our own SDKs and packages in place of the default public
  registries, so releases can be private and can require authentication later.
- **Required ecosystems** are those we ship an SDK for, plus OCI:
  - npm: client-core, node, react, manifest, jws, protocol, catalog and cli;
  - PyPI: the Python SDK;
  - the Swift Package Registry: the Swift SDK;
  - Maven/Gradle: the Kotlin/Android AAR and its Godot binding;
  - Godot: the Godot SDK addon;
  - Docker/OCI, which the owner asked for explicitly.
- **Optional, and can be deferred:** NuGet (the C# SDK is the optional, unbuilt X-01), Cargo and Go
  (no SDK yet).
- **Standing rule:** when an SDK is added for a new ecosystem, that ecosystem's feed becomes
  required.
- **Hosting:** self-hosted on the Cloudflare Worker and R2, reusing open-source protocol code where
  the licence allows. The repository is MIT.
- **Access:** public read now, auth later. Adding auth must be a configuration change, not a
  rewrite.
- **Console:** one shared Feeds page set used in two scopes:
  - platform-wide, beside Home and Products;
  - per product, when that product has feeds enabled.
  - Each scope has a Feeds overview and one page per feed with its own settings.

The spike answers five questions:

1. **Protocol per ecosystem:** read and publish protocols, static versus dynamic endpoints, client
   auth, client configuration, scoping and upstream fallback.
2. **Hosting:** which hostname.
3. **Data model and the SDKs:** how feeds map to products, releases and channels, and how today's
   SDKs get onto them.
4. **Open-source reuse.**
5. **Security and cost.**

It ends with a work-package breakdown and the owner decisions.

## 2. Short answer

| #   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | **Every required ecosystem's read side is a handful of GETs whose bodies can be precomputed.** npm, PyPI (PEP 691 JSON), Maven, Swift, Godot and OCI pull need no server-side computation per request beyond mapping a URL to an object, a few headers (`Content-Version`, `Docker-Content-Digest`, `Link`) and, for search-shaped endpoints (Godot), a filter over a small list. Publishing through each native client (`npm publish`, `twine`, `docker push`, `swift package-registry publish`, Maven `PUT`s) is a second, larger protocol per ecosystem. The recommendation is not to build it first: CI publishes through the **existing release pipeline** (`pkey release publish`, trusted publishing, upload tickets straight into R2), and the Worker renders each feed from Release's truth.                                                                                                                                                                                        | [V], [M], [I] |
| 2   | **A new host, `pkg.plrs.im`: the same Worker on a third custom domain, with its own host-isolation dispatcher.** `dl.plrs.im` cannot carry feeds without weakening a test-pinned boundary. Its dispatcher refuses every JSON, XML and `text/*` success body, and its root `/` is the landing page, while OCI needs `/v2/` at the host root. The console host holds the session cookies and must not serve tenant-supplied package bytes. `pkg.plrs.im` is same-site with the console, as `dl.plrs.im` is, and takes the same compensations: no cookie in or out, `nosniff`, a `sandbox` CSP on every answer, never script or SVG, and HTML only as an inert, script-free document (the PyPI HTML fallback). Layout: `/<ecosystem>/<owner>/…`, with OCI at `/v2/<owner>/<repository>/…`.                                                                                                                                                                                                      | [M], [V], [I] |
| 3   | **A package is a Release deliverable of a new kind, `package`, and a package version is a release of it.** Release records it; Distribution renders the feeds. History, channels (→ npm dist-tags and OCI moving tags), yank, audit, trusted publishing, upload tickets and blob refs all come from code that exists. Package releases carry ecosystem integrity (sha512, sha256, digests) and no `pkey-release+jws` record, so the wire contract and corpus do not change. **Platform-owned packages** (our SDKs) belong to a **reserved system product** rather than a nullable product, because `audit.product`, `blob_refs.product`, CI tokens, trusted publishers and `dist_access` are all `NOT NULL` product-scoped today. Today the SDKs ship four different ways: GitHub Packages for npm, PyPI, a git tag for Swift and a GitHub Release for Godot, and the Kotlin AAR is not published at all. Each one moves onto the feeds by packing in CI and running `pkey release publish`. | [M], [I]      |
| 4   | **Reuse is mostly reference, not vendoring.** `cloudflare/serverless-registry` (Apache-2.0, maintained, last push 2026-09-11) is the one Workers-native fit. It needs credentials for every request, and its `docker push` path is bounded by the Worker request-body limit (100 MB on Free and Pro). The plan reuses it for the deferred native-push package and writes the thin pull path to fit the dispatcher. Two conformance suites are used as CI tools, not vendored: the OCI distribution-spec suite and Swift's registry compatibility suite. The npm, PyPI, Maven and Godot read paths are each a few hundred lines. Avoid FSL-licensed `vsr`, GPL-licensed `pulp` and unlicensed projects.                                                                                                                                                                                                                                                                                       | [V], [I]      |
| 5   | **Security:** content-addressed bytes that are never overwritten; versions that are never reused, even after a yank; per-owner URL prefixes, so one tenant can never shadow another; required namespaces (an npm scope, a Swift scope, a Maven groupId, an OCI owner prefix); no upstream proxying; and every SDK name also claimed on its public registry. **Cost:** a few dollars a month even at millions of installs. R2 egress is free, Class B reads cost $0.36 per million and storage $0.015 per GB-month, and OCI layers dominate storage.                                                                                                                                                                                                                                                                                                                                                                                                                                          | [V], [I]      |

**Recommendation: go.** Tier 1 has 12 work packages, about 16–23 engineer-weeks, and covers every
required ecosystem and the console. Tier 2 has 4 packages, about 6.5–8 weeks: registry auth and
native-client publish. Tier 3 has 3 packages, about 3.5–4 weeks: Cargo, Go and NuGet. All three are
designed for now but not built (§10).

## 3. Method

- **Code read:**
  - `packages/worker/src/core/bytesHost.ts`, `core/blobs.ts`, `core/ciScope.ts` and
    `core/ciVocabulary.ts`;
  - `services/distribution/{bytes,access,blobAccess}.ts` and `feeds/index.ts`;
  - `admin/authz.ts` and `mount.ts`;
  - the migrations for `audit` and `blob_refs`;
  - `packages/cli/src/{publish,s3}.ts`;
  - the release workflows;
  - the SDK packaging files;
  - `docs/security/THREAT-MODEL.md` §3;
  - `docs/design/ADMIN.md` §2–§7;
  - `packages/admin/src/console/nav.ts`;
  - the docs generator's `TABLE_OWNERS`.
- **Specifications read:** every ecosystem's specification, plus the clients' own source where the
  specification leaves the behaviour open: pip's and uv's `Accept` handling, pacote's packument
  request, the Godot editor's asset-library plugin and SwiftPM's URL building. Sources are listed
  in §13.
- **Open-source candidates:** the licence, last push and fit of each, from the GitHub API on
  2026-10-03.
- **Cloudflare limits and pricing:** read from the official pages on 2026-10-03.
- **Not done:** no prototype was deployed and no live client was pointed at a test registry. Each
  ecosystem work package carries a real-client matrix as an acceptance criterion instead (§10).

## 4. Per-ecosystem protocol

### 4.1 Summary table

| Ecosystem       | Tier | Minimal read (install)                                                                                                                                                                       | Static (precomputed into R2)                                                | Dynamic in the Worker                                                                                                                                                                                | Native publish protocol                                                                       | Client auth (for later)                                                                                                                          | Pointing a client at us                                                                                                                                                                    | Scoping                                                                |
| --------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| npm             | 1    | `GET /{name}` (scoped: `/@scope%2fname`) → packument JSON; `GET` the absolute `dist.tarball`                                                                                                 | packument, tarballs                                                         | `%2f`/`%2F` → one key; optional `Accept` negotiation (a full packument as `application/json` satisfies pacote's `install-v1; q=1.0, application/json; q=0.8, */*`)                                   | `PUT /{name}` with base64 `_attachments`; the registry merges and refuses an existing version | `//host/path/:_authToken=` → `Authorization: Bearer`                                                                                             | `.npmrc`: `@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/`                                                                                                                     | scope ↔ exactly one registry                                           |
| PyPI            | 1    | `GET /simple/<normalized>/` → PEP 691 JSON (`application/vnd.pypi.simple.v1+json`, API 1.1); files with `hashes`, `core-metadata`, `yanked`; `GET` file URL; `GET <file>.metadata` (PEP 658) | project pages (JSON and HTML forms), files, `.metadata`                     | trailing-slash and PEP 503 normalisation redirects; pick JSON or HTML by `Accept`; the **exact** `Content-Type` (pip and uv refuse plain `application/json`)                                         | legacy `POST` multipart (`:action=file_upload`); PEP 694 is still Draft                       | Basic (URL credentials, netrc, keyring; a token as user or password); uv `UV_INDEX_<NAME>_USERNAME/PASSWORD`                                     | `pip.conf` `index-url` (plus `extra-index-url` for PyPI, with the confusion caveat); uv `[[tool.uv.index]] explicit = true` + `[tool.uv.sources]`                                          | none in the protocol (normalised names); uv `first-index` default      |
| Swift (SE-0292) | 1    | `GET /{scope}/{name}`, `/{scope}/{name}/{version}`, `…/{version}/Package.swift`, `…/{version}.zip`; `GET /identifiers?url=`                                                                  | release lists, release metadata, manifests, source archives                 | `Content-Version: 1`, `Content-Type`, the `Link` headers (`latest-version`, `alternate` manifests), `Accept` checks (400/415), `problem+json` errors, `/identifiers` lookup, `POST /login` (SE-0378) | `PUT /{scope}/{name}/{version}` multipart (`source-archive`, signatures)                      | `swift package-registry login` (token → Bearer, or Basic); `SWIFTPM_REGISTRY_TOKEN` in CI                                                        | `swift package-registry set --scope polaris-key https://pkg.plrs.im/swift/polaris-key` → `.swiftpm/configuration/registries.json`; `.package(id: "polaris-key.PolarisKey", from: "1.0.0")` | scope → registry mapping                                               |
| Maven / Gradle  | 1    | `GET {group/as/path}/{artifact}/{version}/{artifact}-{version}[-classifier].{ext}` + `.pom`, `.module`; `maven-metadata.xml`; checksum sidecars                                              | everything                                                                  | nothing required; checksum sidecars rendered from stored digests                                                                                                                                     | plain `PUT` of each file; the client merges `maven-metadata.xml` (racy)                       | Gradle `PasswordCredentials` or `HttpHeaderCredentials`; Maven `settings.xml` `<server>`                                                         | Gradle `exclusiveContent { forRepository { maven { url = uri("https://pkg.plrs.im/maven/polaris-key/") } }; filter { includeGroup("im.plrs.key") } }`; Maven `<repository>`                | groupId (reverse DNS; enforced only by Central)                        |
| OCI / Docker    | 1    | `GET /v2/` (200 = registry); `GET\|HEAD /v2/<name>/manifests/<tag\|digest>`; `GET\|HEAD /v2/<name>/blobs/<digest>` (Range); `tags/list`                                                      | blobs, manifests by digest                                                  | `/v2/` at the **host root**; tag → digest; per-manifest `Content-Type`; `Docker-Content-Digest`; HEAD sizes; the `WWW-Authenticate` challenge when auth exists                                       | `POST …/blobs/uploads/` → `PATCH` (ordered `Content-Range`) → `PUT ?digest=`; `PUT` manifest  | `docker login` → Basic, or the Bearer token flow (`realm`, `service`, `scope`; anonymous pull tokens allowed)                                    | the image reference itself: `docker pull pkg.plrs.im/polaris-key/pkey:1.2.3`                                                                                                               | repository path; first segment = owner                                 |
| Godot           | 1    | ≤ 4.6: `GET {api}/configure`, `asset?…`, `asset/{id}` (with `download_url`, `download_hash`); 4.7+: `search/query/?…`, `assets/{publisher}/{asset}/`, `releases/{publisher}/{asset}/`        | `configure`, `asset/{id}`, `assets/…`, `releases/…`, zips, a GodotEnv index | the two search endpoints (query strings over a short list)                                                                                                                                           | none: both official stores are manual (legacy review queue; the new store's API is read-only) | none: the editor sends no credentials, so a gated feed needs tokenised URLs                                                                      | Editor Settings: `asset_library/available_urls` (≤ 4.6) or `asset_store/available_urls` (4.7+); GodotEnv `addons.json` `"source": "zip"`                                                   | `{publisher}/{asset}`                                                  |
| Cargo (sparse)  | 3    | `GET config.json`; index files `1/`, `2/`, `3/x/`, `ab/cd/`; `GET` the `dl` template                                                                                                         | everything                                                                  | only the `/api/v1/*` publish, yank and owners API                                                                                                                                                    | `PUT /api/v1/crates/new` (length-prefixed JSON + `.crate`)                                    | credential providers only; the raw token in `Authorization`; `auth-required: true` in `config.json`; asymmetric tokens were removed from nightly | `.cargo/config.toml` `[registries] polaris-key = { index = "sparse+https://pkg.plrs.im/cargo/polaris-key/" }`; `registry = "polaris-key"` per dependency                                   | explicit `registry =` per dependency                                   |
| Go (GOPROXY)    | 3    | `$base/$module/@v/list`, `.info`, `.mod`, `.zip`, `@latest`                                                                                                                                  | everything ("even … a file:// URL can be a module proxy")                   | nothing (`!`-case encoding is part of the stored key)                                                                                                                                                | none: files are written                                                                       | `.netrc` per host; `GOAUTH` (Go 1.24+) for headers                                                                                               | `GOPROXY=https://pkg.plrs.im/go/polaris-key,direct`, `GONOSUMDB=<module prefix>`; zero-config public use needs a `go-import` **HTML** `<meta>` on the module path's host                   | module path = a domain the owner controls                              |
| NuGet v3        | 3    | service `index.json`; `PackageBaseAddress` (`/{id}/index.json`, `.nupkg`, `.nuspec`); `RegistrationsBaseUrl/3.6.0`                                                                           | service index, flat container, registrations                                | lowercase ids; `SearchQueryService` (dynamic by design)                                                                                                                                              | `PUT` multipart with `X-NuGet-ApiKey`; `DELETE` unlists                                       | `packageSourceCredentials` (Basic); API keys                                                                                                     | `nuget.config` `<packageSources>` (URL ending `index.json`) + `<packageSourceMapping>`                                                                                                     | package source mapping; id prefix reservation exists only on nuget.org |

Notes on the rows:

- **npm** [V]. pacote sends
  `application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*` and verifies
  `dist.integrity` first, falling back to `dist.shasum`. `dist.tarball` is followed literally, so it
  must be an absolute URL on our host. Nothing in npm is HTML.
- **PyPI** [V]. pip's `_ensure_api_header` accepts only `text/html`,
  `application/vnd.pypi.simple.v1+html` and `application/vnd.pypi.simple.v1+json`. uv answers
  anything else with `UnsupportedMediaType`. Both list JSON first in `Accept`. PEP 708 (tracks and
  alternate locations) is **Rejected**, so nothing can rely on it. Fragment hashes protect only
  against corruption: pip says they "do not satisfy `--require-hashes`".
- **Swift** [V].
  - SwiftPM's default `onUnsigned` is `prompt`, which breaks unattended builds of unsigned packages
    (owner decision D3, §11).
  - SwiftPM pins checksums on first use (TOFU), so a release's archive must never change.
  - SwiftPM appends request paths to the registry URL's own path, so a path-prefixed base works:
    `RegistryClient.swift`, `urlComponents.path += "/" + components…`.
- **OCI** [V]. The reference grammar `name := [domain '/'] remote-name` puts no path in the domain,
  and every endpoint is the absolute `/v2/…`, so a path-prefixed registry does not work with docker
  or podman. Redirects are allowed. A client "MUST NOT forward `Authorization` headers across host
  boundaries".
- **Godot** [V]. Godot 4.7 renamed the setting to `asset_store/available_urls`, moved to the new
  Asset Store API, and **stopped verifying hashes**: the editor passes an empty sha256 to
  `add_release`. ≤ 4.6 compares `download_hash` against the downloaded file's SHA-256 when the field
  is set. The SDK supports 4.4–4.7 (P1-12), so the feed serves **both** API shapes.
- **Go** [V]. With `GOPRIVATE`/`GONOSUMDB`, the go command "accepts the hash … without verifying
  it" against sum.golang.org. `GOPRIVATE` also disables the proxy, so the right settings are
  `GONOSUMDB` with `GOPROXY`.

### 4.2 Upstream mirroring: do not proxy

**Recommendation: no feed proxies or mirrors a public upstream** [I]. Reasons:

1. **Dependency confusion is the failure mode of a merged namespace.**
   - A proxying feed answers for names it does not own. A client pointed only at us then gets
     whichever of "ours" or "theirs" the merge logic picks.
   - Without a proxy, the client's own routing decides, and every required client has a precise
     router:
     - npm scopes ("a scope only ever points to one registry");
     - uv `explicit` indexes and its `first-index` default;
     - Gradle `exclusiveContent`;
     - SwiftPM scope mapping;
     - OCI's fully qualified references;
     - Cargo `registry =`;
     - NuGet source mapping.
2. **We would become a distributor of third-party code**, with the licence, malware-takedown and
   storage costs that brings.
3. **Cost and availability:** a proxy turns every cache miss into an upstream fetch on our Worker.

pip has no per-package routing: `--extra-index-url` picks the "best" match across all indexes. The
setup snippets therefore recommend uv with an explicit index. For pip, the mitigation is §8.3:
every name we serve is also claimed on PyPI by us.

The per-feed settings carry `upstream: "none"` as their only value today (§7.3), so a future
pull-through cache, if ever wanted for OCI, would be a setting rather than a schema change.

## 5. Hosting

### 5.1 What the existing hosts allow

| Host                              | What it is                                                     | Can it serve feeds?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key.plrs.im` (console)           | the session origin (`__Host-pkey_admin`, `__Host-pkey_portal`) | **No.** Feeds serve tenant-supplied bytes: tarballs, `Package.swift`, POMs. A host-only cookie is still sent to its own host. The console's storefront feeds are JSON the Worker renders, not tenant files.                                                                                                                                                                                                                                                                                                                                                                              |
| `dl.plrs.im` (bytes host)         | byte routes only, owner-accepted same-site                     | **No, without weakening a recorded boundary.** `refusedType` refuses every success body whose type is not on `BYTES_HOST_TYPES` (archives and installers), and `EXECUTABLE_TYPE`/`NEVER_SERVED` refuse `json`, `xml` and `text/*` outright [M]. Feeds need JSON (npm, PyPI, Swift, OCI manifests, Godot), XML (Maven) and `text/x-swift`. `GET /` is the landing page, and OCI needs `/v2/` at the root, which would put a second protocol's routing in that dispatcher. THREAT-MODEL §3 records "JSON and `text/*` all become not-found" as a compensation for the same-site deviation. |
| **`pkg.plrs.im` (new, proposed)** | the same Worker on a third custom domain                       | **Yes.** See §5.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 5.2 `pkg.plrs.im`: the registry host

**Layout** [I]:

```
https://pkg.plrs.im/
  v2/<owner>/<repository>/…              OCI (the only root-level protocol)
  npm/<owner>/…                          npm registry base
  pypi/<owner>/simple/…                  PyPI simple index (+ /files/…)
  swift/<owner>/…                        Swift registry base (scope lives in the path after it)
  maven/<owner>/…                        Maven repository root
  godot/<owner>/asset-library/api/…      Godot ≤ 4.6 Asset Library API
  godot/<owner>/store/api/v1/…           Godot 4.7+ Asset Store API
  godot/<owner>/index.json               GodotEnv / scripted installs
  cargo/<owner>/ · go/<owner>/ · nuget/<owner>/v3/index.json     (tier 3, reserved now)
```

- **Ecosystem first, then owner.** `/v2/` is then simply the OCI ecosystem's prefix. Ecosystem
  names can never collide with product slugs, and the owner segment isolates tenants (§8.3). The
  owner is a product slug, or the reserved system product for platform packages (§6.2).
- **No path needs the host root except OCI's `/v2/`.** The npm, PyPI, Maven and NuGet research found
  no root requirement, and SwiftPM appends to the base path [V].

**Host isolation** [I]. Add `core/registryHost.ts`, modelled line for line on `core/bytesHost.ts`,
with its route list `REGISTRY_ROUTES` declared in `mount.ts` beside `BYTE_ROUTES`. Every route
names `service: "distribution"` and runs only while Distribution and the owner's feed are enabled.
It keeps the bytes host's compensations unchanged:

- the `Cookie` header is stripped and `Set-Cookie` is dropped;
- every answer carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox;
default-src 'none'; frame-ancestors 'none'` and `Referrer-Policy: no-referrer`;
- a route's own `Access-Control-*` headers are dropped. Registries need no CORS: their clients are
  not browsers;
- a throw becomes the platform's JSON 500, never Cloudflare's HTML page.

**It widens one rule, deliberately:** the type allowlist.

- **Allowed:**
  - the registry JSON types: `application/json`, `application/vnd.pypi.simple.v1+json`,
    `application/vnd.swift.registry.v1+json`, `application/problem+json`, and
    `application/vnd.oci.*+json` and `application/vnd.docker.distribution.*+json` for manifests;
  - `text/x-swift` for `Package.swift`;
  - `image/png` and `image/jpeg` for Godot icons;
  - the archive types (`application/zip`, `application/gzip`, `application/x-tar`,
    `application/octet-stream`).
- **Never served:** HTML except as below, SVG, any script type, and XML as a type.
- **XML** is tenant-supplied for POMs and nuspecs, and our own for `maven-metadata.xml`. It goes out
  as `application/octet-stream` with `attachment`. Maven and Gradle do not read the response type,
  but that is [I] until the F-07 client matrix confirms it.
- **The one HTML answer** is the PyPI simple page, sent only when a client's `Accept` does not list
  the JSON type: pip before 22.2, and possibly Poetry.
  - It is generated from the same data as the JSON, with every value escaped.
  - It is admitted through the bytes host's `inertDocumentPolicy` check: `sandbox` without
    `allow-scripts`, `default-src 'none'`, no forms.
  - A per-feed setting can switch it off.

**Why a separate host, not a widened `dl.plrs.im`** [I]:

- `dl.plrs.im`'s promise ("no JSON, no text, bytes only") stays exactly as the threat model
  records it.
- The registry host's wider type list is reviewed once, in its own threat-model section.
- WAF, rate-limit and cache rules can differ per host.
- If the owner ever wants feeds on a separate registrable domain, only DNS and one environment
  variable (`PKG_ORIGIN`) change.

**Same-site analysis** [I]:

- `pkg.plrs.im` is same-site with `key.plrs.im`, as `dl.plrs.im` already is. The risk is script
  running on the sibling: it could issue same-site requests carrying `SameSite` cookies, or plant
  `Domain=plrs.im` cookies.
- No answer on the host runs script: `sandbox` CSP, `nosniff` and the type allowlist.
- No cookie crosses: the `__Host-` cookies carry no `Domain`, and there is a test against any
  `Domain=` attribute.
- Registry credentials will travel only in `Authorization` headers (§7), never in cookies, so CSRF
  does not apply.
- The `__Host-` session model is used **on the console** to mint registry tokens, never on
  `pkg.plrs.im`.
- Residual risk, as for `dl.plrs.im`: the guarantees hold only while nothing on `plrs.im` serves
  attacker-influenced active HTML.

**Bytes stay on the registry host.** The package bytes (tarballs, wheels, zips, layers) are served
under the feed's own URL prefix from the shared content-addressed store (`blobs/sha256/<hex>`), not
redirected to `dl.plrs.im`.

- Clients send credentials only to the registry's own URL: npm's nerf-dart scoping, pip's netloc
  match, NuGet 6.7's PreAuthenticate under the service-index path, and OCI's "MUST NOT forward
  `Authorization` across hosts" [V].
- Keeping the bytes on the same host means auth later needs no redirect design.
- Bytes are deduplicated with release artifacts automatically.

### 5.3 Static versus dynamic: render on write

Each ecosystem's index documents depend only on Release's state: versions, yank state, channel
pointers, and per-version metadata the CLI extracted. The documents are packuments, PEP 691 pages,
Swift release lists, `maven-metadata.xml`, OCI tag lists and the Godot asset JSON.

**Recommendation: materialise them on write** [I].

- On every publish, promote, yank or settings change for a package, Distribution re-renders that
  package's documents and writes them to R2 under a mutable `feeds/<ecosystem>/<owner>/…` prefix.
  That prefix is outside the content-addressed, bucket-locked `blobs/`.
- On read, the Worker:
  1. reads the owner's feed settings (one D1 row, held per isolate for about 30 s);
  2. runs the access check (§7);
  3. streams the R2 object with a strong ETag.
- Public answers go through the Cache API: `max-age=60` for indexes, a year with `immutable` for
  content-addressed bytes.
- The storefront feeds render per request (`feeds/cache.ts`). Registry indexes are read orders of
  magnitude more often than they change, and each read then costs one R2 Class B operation and no
  D1 selection.
- A `feeds:rebuild` admin action and a cron self-check re-render from D1, so a lost or stale object
  is recoverable.

## 6. Data model

### 6.1 A package is a deliverable; a package version is a release

**Current state** [M]:

- `DELIVERABLE_KINDS` is `["app", "pack"]` in `@polaris-key/manifest`.
- `RECORD_KINDS` (the signed `pkey-release+jws` kinds) is `app | pack | revocation | delegation`.
- `pkey release publish` already does everything a package publish needs: it matches files, hashes
  them, gets an OIDC trusted-publishing token, buys an upload ticket, PUTs single-part to R2 with an
  R2-verified SHA-256, and submits a descriptor the Worker validates with the same function.

**Proposal** [I]:

- **A third deliverable kind, `package`,** declared in `.pkey/release` with:
  - an `ecosystem` (`npm | pypi | swift | maven | oci | godot`, later `cargo | go | nuget`);
  - the ecosystem `name`: `@polaris-key/node`, `polaris-key`, `polaris-key.PolarisKey`,
    `im.plrs.key:polaris-key-platform`, `pkey`, `polaris_key`;
  - `artifacts[].match`, as today.
- **A version is a release of that deliverable,** so the following come from existing code with no
  new concept:
  - history, audit, yank, upload tickets, blob refs, trusted publishing and CI scopes
    (`release:publish`);
  - **channels**, rendered as npm dist-tags and OCI moving tags: the `stable` channel → `latest`,
    other channels → their own tag.
- **No signed record** for package releases: they carry ecosystem integrity instead (§8.1). The
  CLI does not sign them and the Worker refuses a `record` on a `package` deliverable.
  - `RECORD_KINDS`, `PROTOCOL_VERSION` and the corpus are unchanged.
  - The signed channel feed (P3-03), the Update service, rollouts, readiness and the distribution
    matrix exclude `package` deliverables, the way a pack-only rule excludes the app today.
  - F-01's plan lists every `deliverable.kind` switch that must learn the third value.
- **Ecosystem metadata is extracted by the CLI and validated by the Worker,** which never unzips an
  archive (the P2b-05 rule, [M]). The CLI extractors read:
  - `package/package.json` from an npm tarball (its dependencies, engines, bin, exports);
  - `*.dist-info/METADATA` from a wheel, uploaded as its own blob for PEP 658;
  - `Package.swift` and `Package@swift-*.swift` from `swift package archive-source`;
  - the POM and Gradle `.module` from a Maven publication directory;
  - the image index and manifests from an OCI image layout;
  - `plugin.cfg` from the Godot zip.
- **Integrity the Worker computes itself.** It streams each object once at registration through
  `crypto.DigestStream`. SHA-1 and SHA-512 are needed for npm; their support in `DigestStream`
  needs a workerd test, [I]. SHA-256 is already the key and is checked by R2.
- **Immutability.** `(owner, ecosystem, name, version)` is unique forever. A yanked or deleted
  version leaves a tombstone, and its version string can never be published again (npm's rule).

**Why not a separate package store with its own publish route** [I]:

- It would duplicate channels, yank, audit, upload tickets and the descriptor validator.
- It would break the program's rule that Release is "the record of everything that exists"
  (README §3.4).
- It would give the console a second release history to draw.

### 6.2 Platform-owned packages: a reserved system product

Our SDKs belong to no customer product. Two options:

- **A nullable owner product.** It does not fit the schema [M]. `audit.product`, `blob_refs.product`,
  `dist_access`, the CI token and trusted-publisher tables, and the release tables are all
  `TEXT NOT NULL REFERENCES products(slug)`. Every guard, from `requireCiScope` (a token "is never
  valid for another product") to the blob holders rule, is keyed by product. A null owner would
  need a parallel path through each one, which means a rewrite of the security model.
- **A reserved system product.** **Recommended** [I].
  - **The row.** A migration seeds one product row, slug **`polaris-key`**, flagged
    `products.system = 1`, and adds `polaris-key` to `RESERVED_PRODUCT_SLUGS`, so it can never be
    registered or deleted.
  - **The repository.** Its repository is this monorepo, with a `.pkey/` at the repository root
    declaring the SDK packages. That is dogfooding, and it keeps rule 5: platform packages are data
    too.
  - **What it reuses.** Trusted publishing from `vladzaharia/polaris-key`, audit, blob refs and
    access all work unchanged.
  - **Where it appears.** The console hides it from the product switcher and the Products registry,
    and shows its feeds only in the platform scope, labelled "Platform".
  - **Owner prefix.** Its owner segment is `polaris-key`, so our URLs read
    `pkg.plrs.im/npm/polaris-key/` and `pkg.plrs.im/polaris-key/pkey`.

**Fit with rule 6 and `TABLE_OWNERS`** [I]:

- All feed code lives in `services/distribution/registry/`.
- The host dispatcher (`core/registryHost.ts`) is Core, exactly as `bytesHost.ts` is. It imports no
  service: the routes come from `mount.ts`.
- New tables are Distribution's in the docs generator's `TABLE_OWNERS`: `feed_settings`,
  `feed_policy` and `package_versions_meta` (the extracted metadata and digests). The `products.system`
  column is Core's.
- The platform-scope admin endpoints span products. They are registered by the composition root
  (`mount.ts`) and implemented in Distribution, through a small new registry seam
  (`platformAdmin?` on a service module), so Core still imports no service.

### 6.3 "Feeds enabled" per product

**Decision** [I]: an **operator-owned Distribution sub-capability**, `packageFeeds`, toggled on
Core → Services under Distribution. Each ecosystem is then enabled on its own feed page
(`feed_settings.enabled`). The alternatives are rejected:

- **Not a new service slug.** Services are generated into every SDK's constants (`gen:services`) and
  advertised in discovery. No SDK consumes package feeds, and feeds are delivery, which is
  Distribution's job ("distribution serves bytes").
- **Not a manifest field.** Turning on a public registry under our hostname is security-relevant,
  like the outlet capability bits, which are operator-owned and never manifest-writable. The
  manifest still **declares** package deliverables (§6.1), which brings rule 9 (validator,
  mutation-table entry, JSON Schema) into F-03. It never **enables** a feed.

A package deliverable whose feed is not enabled is recorded by Release and simply not served.

### 6.4 How today's SDKs get onto the feeds

| SDK                                                                                     | Today [M]                                                                                                                                          | On the feeds [I]                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm: client-core, node, react, manifest, jws, protocol, catalog, cli                    | Changesets `changeset publish` to GitHub Packages (`release.yml`, `registry-url: https://npm.pkg.github.com`); all at `0.0.0`                      | after `changeset version`, `pnpm pack` each public package, then `pkey release publish --deliverable npm.<name>`. `brand` and `zstd-wasm` are also public names and can join. Workspace `workspace:*` ranges are rewritten by `pnpm pack`, so the packed `package.json` is what the packument shows                                    |
| Python `polaris-key`                                                                    | `release-python.yml`: `python -m build`, `pypa/gh-action-pypi-publish` to PyPI on a tag                                                            | the same build, then `pkey release publish` of the wheel and sdist (METADATA extracted for PEP 658). Keep PyPI in parallel (D2)                                                                                                                                                                                                        |
| Swift `PolarisKey`                                                                      | `release-swift.yml` validates and creates a GitHub release from a `swift-v*` tag. **`Package.swift` is at `sdks/swift/`, not the repository root** | `swift package archive-source` in `sdks/swift` gives a registry archive with `Package.swift` at its root, which **fixes the monorepo-subdirectory problem**. SwiftPM's git-URL dependency needs the manifest at the repository root, so the registry is the clean install path. Identity: `polaris-key.PolarisKey`. Signing follows D3 |
| Kotlin AAR (`im.plrs.key:polaris-key-platform`) and the Godot binding AAR (P5-06, done) | `group = "im.plrs.key"` in `sdks/kotlin/build.gradle.kts`; no `maven-publish` configured, so nothing is published                                  | add `maven-publish` with a local file repository (`build/repo`), then `pkey release publish` the publication directory: AAR, POM, `.module`, sources jar. The Worker derives `maven-metadata.xml` and the checksums                                                                                                                    |
| Godot addon                                                                             | `release-godot.yml` builds reproducible canonical and Asset Library zips and a GitHub Release; store uploads are manual                            | `pkey release publish` of the canonical zip; `plugin.cfg` gives version and name. Served on both editor API shapes and the GodotEnv index                                                                                                                                                                                              |
| OCI                                                                                     | no image today                                                                                                                                     | the first image is a small `pkey` CLI image (Node 22 slim plus `pkey.mjs`) for CI users, built with `docker buildx --output type=oci` and published as an image layout. Owner confirmation is not needed to build the feed                                                                                                             |

## 7. Access: public now, auth as configuration

### 7.1 The seam that exists from day one

Every registry read goes through one function, `authorizeFeedRead(principal, owner, ecosystem,
package)`. Its inputs:

- **The principal,** from `feedPrincipal(req)`. Today it always returns `anonymous`, but the
  credential extractor behind it is built and tested in F-02:
  - `Authorization: Bearer <t>`, used by npm, SwiftPM tokens, Gradle header credentials and Go
    `GOAUTH`;
  - a raw `Authorization: <t>` (Cargo);
  - `Authorization: Basic base64(user:t)`, used by pip and uv, Maven, Gradle, NuGet, `docker login`,
    Swift Basic and Go netrc. The token is the password, or the username when the password is
    empty, as pip's token form sends it.
- **The mode,** resolved as the stricter of two values:
  - the feed's `access_mode` (`public | authenticated | licensed | entitled`, the same ladder and
    `stricter()` as `services/distribution/access.ts`);
  - the package deliverable's own `dist_access` row, which already exists per deliverable.

Public mode admits `anonymous`. Every other mode refuses it today, with each client's native
challenge:

- `401` with `WWW-Authenticate: Basic realm="pkg.plrs.im"` for most clients;
- the Bearer `realm`/`service`/`scope` challenge for OCI;
- `auth-required: true` in Cargo's `config.json`.

The cache rule is in the same function. Only a `public` answer is edge-cacheable. Anything else is
`private, no-store` and never enters the Cache API, so a cache key can never mix principals.

### 7.2 What auth adds later (tier 2, F-20/F-21)

**Registry tokens.** A new credential prefix, proposed as `pkeyr_`. A new prefix touches AGENTS.md
rule 8's naming list, so F-20 is plan-mode. Tokens are minted in two places:

- **in the console** (platform admin, `__Host-pkey_admin`): CI and developer tokens per owner, with
  scopes `read` or `publish`, optionally narrowed to one ecosystem and an expiry. They are hashed at
  rest like `pkeyci_` tokens;
- **in the customer portal** (`__Host-pkey_portal`): a licensee mints a read token **bound to their
  licence**. `licensed` and `entitled` feeds and packages then reuse the delivery-access decision
  that byte routes already make (`blobAccess.ts`: "a usable licence", "the pack's gate").

Existing `pkeyci_` tokens are also accepted for reads by the same product's CI.

**Per-client additions:**

- an OCI token endpoint (`/v2/token`) that exchanges Basic credentials for a short-lived pull or push
  JWT, and mints anonymous pull tokens for public repositories (the distribution token spec allows
  this);
- Swift's `POST /login`;
- Cargo's `auth-required`;
- for Godot, **tokenised listing URLs**: the editor sends no credentials, so a gated Godot feed is a
  per-user secret URL (the AltStore per-user-source pattern, already a known gap in the program
  README §9).

**What changes for an operator:** the feed's access mode in its settings, and minting tokens. No
route, renderer or stored document changes. Index documents are materialised per feed, and the
access check happens before the R2 read, so the same objects serve every mode.

## 8. Security and cost

### 8.1 Integrity

| Ecosystem | What the client verifies [V]                                                                                   | Where it comes from [I]                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm       | `dist.integrity` (`sha512-<base64>`), else `dist.shasum` (SHA-1 hex)                                           | the Worker streams the tarball once at registration                                                                                                |
| PyPI      | `#sha256=` fragments / `hashes.sha256` (corruption only; `--require-hashes` is the user's own pin)             | the blob key                                                                                                                                       |
| Swift     | release `checksum` (SHA-256 hex, MUST), `Digest: sha-256=` (SHOULD), optional CMS signature; TOFU fingerprints | the blob key; signature per D3                                                                                                                     |
| Maven     | `.sha512`, `.sha256`, `.sha1`, `.md5` sidecars (Gradle tries them in that order)                               | rendered from digests computed at registration                                                                                                     |
| OCI       | every blob and manifest by digest; `Docker-Content-Digest`                                                     | the digest **is** the blob key (`blobs/sha256/<hex>`): an exact match with the existing store                                                      |
| Godot     | ≤ 4.6: `download_hash` SHA-256 when present; 4.7+: nothing                                                     | the blob key. Document that 4.7+ installs rely on TLS alone. The Polaris Key SDK's own update path verifies signed records, not the store download |

### 8.2 Immutability

- Content-addressed bytes are never overwritten. This is today's `blobs/sha256/` store under its
  bucket lock, with refs held by the package release, so the blob collector keeps them.
- A version string is unique forever, with tombstones.
- Index lines change only in their yank or deprecation fields.
- OCI version tags (`1.2.3`) are immutable. Only channel tags (`latest`, `beta`) move.

Yank semantics follow each protocol [V]:

- npm → `deprecated` message (npm has no yank that keeps lockfiles working);
- PyPI → PEP 592 `yanked`;
- Swift → the version disappears from the release list but stays fetchable;
- Maven → no protocol notion: listed in the console only, with an optional removal from
  `maven-metadata.xml` `<versions>`;
- OCI → the tag is removed and the digest stays;
- Godot → the version is removed from listings;
- Cargo → `yanked: true`;
- NuGet → unlisted.

There is no delete in tier 1.

> Amended 2026-10-06 (lead decision): feed retention prunes builds of main; see THREAT-MODEL
> "Feed retention". When a version is published on `stable`, a product that opted in (the
> platform's own feeds always do) deletes that package's `main`-channel prereleases below it,
> leaving a tombstone so the version number is still never reused. No other version is deleted.

### 8.3 Dependency confusion

1. **Tenants cannot shadow each other.** Every URL carries the owner segment, and a product's token
   or trusted publisher can publish only under its own owner (the `requireCiScope` rule [M]).
2. **A namespace is required per feed.** It is set in feed settings and enforced at publish:
   - npm: scoped names only, and the scope must equal the feed's scope (`@polaris-key`);
   - Swift: the feed's scope;
   - Maven: a groupId prefix;
   - OCI: repositories under the owner;
   - PyPI: names must match a configured prefix or list, because PyPI has no namespaces.
3. **Every name a public-read feed serves is also claimed on its public registry by the owner.** The
   names are `@polaris-key` on npmjs, `polaris-key` on PyPI (published today) and `im.plrs.key` on
   Maven Central. Swift has no public registry to squat, and the scope is ours by URL. The feed
   settings record the claim (a URL and a confirmation); D2 asks whether to keep publishing there.
4. **No upstream proxy** (§4.2). The setup snippets always use the client's strict router: npm
   scope, uv `explicit = true`, Gradle `exclusiveContent`, SwiftPM `--scope`, `nuget.config` source
   mapping.

### 8.4 Abuse and limits

- **Per-feed `max_package_bytes`.** Defaults: 50 MiB for npm, PyPI, Swift, Maven and Godot; 5 GiB
  per OCI blob, which is the ticket's single-PUT ceiling [M].
- **Platform ceilings** live in `feed_policy`.
- **The reads rate-limit lane** is shared with the storefront feeds' pattern: a cost budget that
  fails open.
- **Publishing** is only through trusted publishing or `pkeyci_` tokens with `release:publish`, as
  today.

### 8.5 Cost model (Cloudflare list prices, read 2026-10-03 [V])

- **R2:**
  - Standard storage costs $0.015 per GB-month.
  - Class A operations (writes) cost $4.50 per million, Class B (reads) $0.36 per million.
  - Egress is free.
  - Each month includes 10 GB-month, 1 million Class A and 10 million Class B for free.
- **Workers Standard:**
  - $5 a month minimum, with 10 million requests included, then $0.30 per million.
  - 30 million CPU milliseconds included, then $0.02 per million.
- **Request body limit:** 100 MB on Free and Pro, 200 MB on Business, up to 5 GB on Enterprise.

| Scenario (per month)                                                        | Estimate [I]                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1 M installs across npm, PyPI and Maven (≈ 3 index reads + 1 artifact each) | 4 M Worker requests (inside the included 10 M); ≤ 4 M Class B ≈ $1.44, less with Cache API hits |
| 50 OCI image versions × 300 MB                                              | 15 GB ≈ $0.23 storage; pulls are free egress                                                    |
| Publishing (one release per SDK per week, ≈ 20 objects each)                | well inside the 1 M free Class A                                                                |

Storage is dominated by OCI layers. The `retention` setting exists for untagged OCI manifests; no
published version is ever removed by retention. Edge caching of public immutable bytes keeps
Class B reads to the cache-miss rate.

> Amended 2026-10-06 (lead decision): feed retention prunes builds of main; see THREAT-MODEL
> "Feed retention". The OCI `retention` setting above still removes nothing, but the builds of
> main below a stable release are deleted and their bytes reclaimed by the blob collector once
> nothing else references them, which bounds the storage the `main` channel's builds hold.

## 9. Open-source reuse

GitHub API, 2026-10-03 [V]. "Vendor" means copying code into the repository, which MIT, BSD and
Apache-2.0 allow, keeping the LICENSE and any NOTICE.

| Ecosystem    | Candidate                                                                                                | Licence                                             | Maintenance                              | Fit and decision [I]                                                                                                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCI          | **cloudflare/serverless-registry**                                                                       | Apache-2.0 (no NOTICE file)                         | active; last push 2026-09-11; 1461 stars | Workers + R2. It refuses every request without credentials ("It will refuse any requests if you don't setup credentials"), supports Basic only and pushes through the Worker body limit. **Reference for the pull path; vendor its upload state machine (chunked `PATCH`, R2 multipart) in F-23** with the Apache header kept |
| OCI          | opencontainers distribution-spec conformance suite                                                       | Apache-2.0                                          | maintained with the spec                 | **CI tool** for F-08 (pull workflow), not vendored                                                                                                                                                                                                                                                                            |
| OCI          | google/go-containerregistry (`crane`), regclient                                                         | Apache-2.0                                          | active                                   | client tools for the F-08 matrix and for producing image layouts in CI                                                                                                                                                                                                                                                        |
| Swift        | swiftlang/swift-package-registry-compatibility-test-suite; SwiftPM's `Examples/package-registry` (Vapor) | Apache-2.0                                          | 2026-06 / merged 2026-07-09              | **conformance suite for F-06** on a macOS runner; the Vapor example is a wire reference                                                                                                                                                                                                                                       |
| npm          | Thomascogez/npflared                                                                                     | MIT                                                 | active (2026-10-02), "early stage"       | reference only: our packument comes from Release rows, not its D1 schema                                                                                                                                                                                                                                                      |
| npm          | vltpkg `vsr`                                                                                             | FSL-1.1-MIT on npm (inconsistent in the repository) | active                                   | **avoid** (FSL is not OSI and restricts commercial use for two years)                                                                                                                                                                                                                                                         |
| PyPI         | chriskuehl/dumb-pypi (Apache-2.0); bckohan/ghr-pypi (MIT)                                                | permissive                                          | active                                   | reference for static PEP 503/691 generation; ours is a small renderer                                                                                                                                                                                                                                                         |
| PyPI         | 12458/pripy                                                                                              | **none**                                            | 2026-04                                  | **cannot vendor**                                                                                                                                                                                                                                                                                                             |
| Maven        | reposilite                                                                                               | Apache-2.0                                          | active                                   | JVM server, not applicable; the layout is static                                                                                                                                                                                                                                                                              |
| Godot        | godotengine/godot-asset-library                                                                          | MIT                                                 | maintenance mode (last push 2026-06-26)  | its `API.md` is the ≤ 4.6 contract; the 4.7 store contract is its live OpenAPI 1.1.0                                                                                                                                                                                                                                          |
| Godot        | chickensoft-games/GodotEnv                                                                               | MIT                                                 | active (2026-10-01)                      | **client** for scripted installs (`"source": "zip"`), used in the F-09 matrix                                                                                                                                                                                                                                                 |
| Cargo (T3)   | integer32llc/margo                                                                                       | Apache-2.0                                          | active (2026-08-24)                      | static sparse-index generator; format reference for F-30                                                                                                                                                                                                                                                                      |
| NuGet (T3)   | emgarten/Sleet                                                                                           | MIT                                                 | active                                   | static v3 feed on S3-compatible storage; layout reference for F-32                                                                                                                                                                                                                                                            |
| Go (T3)      | athens, goproxy                                                                                          | MIT                                                 | active                                   | unnecessary: a Go proxy is static files                                                                                                                                                                                                                                                                                       |
| multi-format | pulp                                                                                                     | **GPL-2.0**                                         | active                                   | **incompatible** for vendoring                                                                                                                                                                                                                                                                                                |

## 10. Proposed work packages

A new phase, **F: Package feeds**, with ids `F-01…`. Nothing is added to `workpackages.json`. The
lead adds the packages after owner review.

**Conventions:**

- ⚑ marks plan-mode (`pkey-wire-planner` writes `plans/<ID>.md` and stops for approval).
- Sizes are engineer-weeks.
- Every Worker package runs the full green gate, the workerd lane, and its THREAT-MODEL and
  `packages/docs` updates.
- **Program dependencies, all already done:**
  - P2-01 (blob store);
  - P2-02 (trusted publishing, upload tickets);
  - P2-03 and P2-04 (release data model and descriptor);
  - P2b-04 (delivery access);
  - P5-06 (the AAR).

### Tier 1: every required ecosystem and the console

| ID       | Title                                                                                                                                                                                                                                                                                                                                                           | Role                                                       | Plan              | Depends on                                    | Size    | Gates                                                  | Human input                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------- | --------------------------------------------- | ------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| **F-01** | ⚑ Plan: the package-feed model. Covers: the `package` deliverable kind and every `kind` switch it touches; the system product; `feed_settings` / `feed_policy`; the registry host's rules; the admin API contract; the `packageFeeds` sub-capability; the CLI extractor contract                                                                                | `pkey-wire-planner`                                        | ⚑ (planning only) | —                                             | 1–1.5   | —                                                      | D1, D2, D3 answered                                               |
| **F-02** | Registry host `pkg.plrs.im`. Covers: `core/registryHost.ts` and `REGISTRY_ROUTES`; the type allowlist; the inert-document rule; `feedPrincipal` / `authorizeFeedRead`, anonymous-only, with the credential extractor tested; the materialiser and Cache API; the client-matrix CI harness against `wrangler dev`; THREAT-MODEL section                          | `pkey-implementer`                                         | per F-01          | F-01                                          | 1.5–2   | workerd lane, threat model                             | the `pkg.plrs.im`, `pkg-staging`, `pkg-dev` custom domains        |
| **F-03** | Package releases. Covers: the manifest `package` deliverable (rule 9); descriptor validation; ingest and the migration (`products.system`, the system product seed, `feed_settings`, `feed_policy`, `package_versions_meta`); Worker-side digests; tombstones; yank/deprecate; channel→tag mapping; `pkey release publish` package mode with the six extractors | `pkey-implementer`                                         | per F-01          | F-01                                          | 2–3     | rule 9, migration, `TABLE_OWNERS`, action-bundle drift | —                                                                 |
| **F-04** | npm feed: packument and abbreviated forms, tarballs, dist-tags, deprecation, scope enforcement. Matrix: npm 10/11, pnpm, Yarn Berry, Bun                                                                                                                                                                                                                        | `pkey-implementer`                                         | no                | F-02, F-03                                    | 1–1.5   | —                                                      | —                                                                 |
| **F-05** | PyPI feed: PEP 691 JSON (API 1.1), PEP 658/714 metadata, PEP 592 yank, normalisation, inert HTML fallback. Matrix: pip (current and 22.2), uv, Poetry                                                                                                                                                                                                           | `pkey-implementer`                                         | no                | F-02, F-03                                    | 1–1.5   | —                                                      | —                                                                 |
| **F-06** | Swift registry: SE-0292 endpoints, `Content-Version`, `Link`, `/identifiers`, `/login`, problem+json, signature headers per D3. Swift compatibility suite and `swift build` on macOS                                                                                                                                                                            | `pkey-implementer`                                         | no                | F-02, F-03                                    | 1.5–2   | —                                                      | D3 (and a signing certificate if D3 is "sign")                    |
| **F-07** | Maven feed: layout, generated `maven-metadata.xml`, checksum sidecars, `.module`, XML-as-octet-stream check. Matrix: Gradle 8/9 (`exclusiveContent`), Maven 3.9                                                                                                                                                                                                 | `pkey-implementer`                                         | no                | F-02, F-03                                    | 1       | —                                                      | —                                                                 |
| **F-08** | OCI pull and image-layout publish: `/v2/`, manifests and indexes by tag or digest, blobs with Range, `tags/list`, anonymous public pull; `pkey` publishes an OCI layout through tickets. Conformance pull suite; docker, podman and crane                                                                                                                       | `pkey-implementer`                                         | no                | F-02, F-03                                    | 1.5–2.5 | —                                                      | —                                                                 |
| **F-09** | Godot feed: ≤ 4.6 Asset Library API (with `download_hash`), 4.7 Asset Store API, GodotEnv index, PNG icons. Matrix: GodotEnv install; HTTP contract tests on both editor shapes; one manual editor check per shape                                                                                                                                              | `pkey-implementer` (editor check by `pkey-godot-engineer`) | no                | F-02, F-03                                    | 1–1.5   | —                                                      | —                                                                 |
| **F-10** | Our SDKs onto the feeds. Covers: the root `.pkey/` for the system product; `release.yml` (npm pack → publish), `release-python.yml`, `release-swift.yml` (`archive-source`), `release-godot.yml`, Kotlin `maven-publish` and its workflow; the first OCI image (`pkey`); the adopter docs page "Install from Polaris Key feeds"                                 | `pkey-implementer`                                         | no                | F-04 to F-09                                  | 1.5–2   | action-bundle drift, docs links                        | trusted-publisher registration for the monorepo in production; D2 |
| **F-11** | Console: Feeds, both scopes. Covers: the overview page, the reusable per-feed page template (Packages, Setup, Settings with the common sections, Activity), the package record with yank/deprecate, and the admin API in §10.2. Built on the ADMIN.md templates and components                                                                                  | `pkey-implementer`                                         | no                | F-03 (data), ADMIN chunk 3 (component system) | 2–3     | console CSP parity, docs links, help-link tables       | —                                                                 |
| **F-12** | Console: per-ecosystem settings panels and setup snippets: npm scope, PyPI prefixes and HTML fallback, Swift scope and signing, Maven groupIds, OCI retention, Godot publisher. The shared snippet renderer is also used by `pkey feeds setup`                                                                                                                  | `pkey-implementer`                                         | no                | F-11, F-04 to F-09                            | 1–1.5   | console CSP parity                                     | —                                                                 |

Tier 1 totals 16–23 engineer-weeks. Its critical path is F-01 → F-03 → F-08 → F-10, about 6–9
weeks. F-04 to F-09 run in parallel on disjoint directories (`services/distribution/registry/<eco>/`).

**Hotspots:**

- F-02's type allowlist and `REGISTRY_ROUTES`: rebase before review;
- F-03's migration: numbered at rebase, per the program rule;
- the CLI bundle (F-03, F-10): one at a time.

### Tier 2: designed now, built after tier 1

| ID       | Title                                                                                                                                                                                                            | Role                | Plan | Depends on | Size  | Why later                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---- | ---------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-20** | ⚑ Plan: registry credentials. Covers: `pkeyr_` (rule 8), console and portal minting, licence binding, the per-client mapping, the OCI token service, Swift `/login`, Cargo `auth-required`, tokenised Godot URLs | `pkey-wire-planner` | ⚑    | F-02       | 1     | public read is the owner's "now"; the §7.1 seam means nothing in tier 1 is redone                                                                  |
| **F-21** | Registry auth: tokens, the access-mode switch per feed, the console token UI, portal tokens                                                                                                                      | `pkey-implementer`  | F-20 | F-20, F-11 | 2–3   | as above                                                                                                                                           |
| **F-22** | Native-client publish adapters (optional): `npm publish` `PUT`, `twine` legacy upload, `swift package-registry publish`, Maven `PUT`s, each translated into the same release descriptor                          | `pkey-implementer`  | no   | F-21       | 2     | needs publish tokens (F-21) and contradicts "no long-lived secrets in CI" unless scoped; `pkey` covers CI today                                    |
| **F-23** | Native `docker push` (optional): the serverless-registry upload state machine over R2 multipart                                                                                                                  | `pkey-implementer`  | no   | F-08, F-21 | 1.5–2 | each request is bounded by the zone's body limit (100 MB on Free and Pro), so large layers fail; the F-08 ticket path has a 5 GiB per-blob ceiling |

### Tier 3: optional ecosystems, deferred

Each fits the core without change. The ecosystem enum is open, `/<eco>/<owner>/` is reserved on
the host, the materialiser is a per-ecosystem plug-in, `feed_settings.ext_json` carries the
ecosystem's extras, and the CLI extractor list is extensible.

| ID       | Title             | Size  | Deferred because                                                                                                                                                                        |
| -------- | ----------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-30** | Cargo sparse feed | 1     | no Rust SDK. Otherwise cheap: a fully static index; publish through `pkey`, not the binary `crates/new` API                                                                             |
| **F-31** | Go module proxy   | 1–1.5 | no Go SDK. Zero-config public use also needs a `go-import` HTML `<meta>` on the module path's host, plus `GONOSUMDB` friction; the CLI must compute the `h1:` dirhash                   |
| **F-32** | NuGet v3 feed     | 1.5   | the C# SDK is the optional, unbuilt X-01. It needs a dynamic search endpoint and nuspec extraction. It **becomes required if X-01 is taken** (the X-01 brief is amended in this branch) |

**Rule for the future, proposed for program README §7:** when an SDK ships for a new ecosystem,
that ecosystem's feed becomes a required work package, sequenced before the SDK's first release.

### 10.1 Console design (F-11, F-12), against `docs/design/ADMIN.md`

**IA (§2).**

- **Platform scope.** "Feeds" becomes a platform link beside Home and Products: a new
  `GLOBAL_PAGES` entry in `packages/admin/src/console/nav.ts` (`page: "feeds"`, `path: "feeds"`, a
  lucide `PackageOpen` icon, no section bit, `data-service="core"`). Its URLs:
  - `#/feeds`
  - `#/feeds/:ecosystem[/:tab]`
  - `#/feeds/:ecosystem/packages/:owner/:name[/:tab]`
- **Product scope.** A **Feeds** page in the Distribution section, shown only when the product's
  `packageFeeds` sub-capability is on. Its URLs:
  - `#/p/:slug/distribution/feeds`
  - `#/p/:slug/distribution/feeds/:ecosystem[/:tab]`
  - `#/p/:slug/distribution/feeds/:ecosystem/packages/:name[/:tab]`
- **The existing "Outlets & feeds" page keeps its name.** It covers storefront feeds. The sidebar
  label for package feeds is "Package feeds", to avoid the collision.
- **S-13's instance-wide Settings/Version page** is separate and not designed here. The platform
  links become Home, Products, Feeds and Platform, in whatever order S-13 settles.

**Templates (§3), shared by both scopes.** Two components cover the two scopes and two page
kinds: `<FeedsOverview scope>` and `<FeedPage scope ecosystem>`, with a
`FeedScope = {kind: "platform"} | {kind: "product", slug}` that picks the API base and hides the
Owner column in product scope. Both are built on chunk 3's `DataTable`, `StatTile`, `PageTabs`,
`SaveBar`, `CopyField`, `StatusPill` and `Timeline`.

- **Overview: T2 collection with a summary strip.**
  - Summary strip: feeds enabled, total packages, last publish.
  - One row per ecosystem, or a card under 768 px. Columns: status (`StatusPill`: Enabled, Off,
    Not available), package count, last publish, access mode (a pill: Public, Token, Licensed,
    Entitled) and registry URL with copy.
  - First-run empty state in product scope: "Turn on package feeds in Services".
- **Per-feed page: T3 record with route tabs.**
  - **Packages:** a nested T2. Columns: name, Owner (platform scope only), latest version, channel
    tags, versions count, last publish. Rows link to the package record.
  - **Setup:** copy-paste snippets for the scope's owner, rendered by one pure function shared with
    `pkey feeds setup`:
    - `.npmrc`;
    - `pip.conf` and uv `pyproject.toml`;
    - `swift package-registry set` and `registries.json`;
    - Gradle `exclusiveContent` and Maven `<repository>`;
    - `docker pull` (and `docker login` once auth exists);
    - Godot Editor Settings URLs per editor version, and GodotEnv `addons.json`.
  - **Settings:** a nested T4. See below.
  - **Activity:** the A-2 timeline filtered to `target_kind = feed`.
- **Settings tab sections.** Each section is one resource with its own SaveBar (ADMIN §3 T4: never
  one Save across two endpoints).
  - General: enabled.
  - Access: the mode; Token, Licensed and Entitled are visible but disabled with "Available when
    registry auth ships" until F-21.
  - Namespace: the scope, prefix or groupId.
  - Limits: the size limit.
  - Retention: OCI untagged only.
  - Yank policy: per the protocol's capability.
  - Upstream: "None", the only option, with an explanation.
  - Public-name claims.
  - The ecosystem panel from F-12.
  - In platform scope, an extra **Platform policy** section edits `feed_policy`: the ecosystem kill
    switch and ceilings.
- **Package record: T3.**
  - Tabs: Versions (T2), Setup, History.
  - Version columns: version, channel tags, published (time and **publish source**: a trusted
    publisher run with a link to the GitHub run, a static CI token id, or the console), size,
    integrity (each digest in a `CopyField`), status (Live, Yanked, Deprecated).
  - Row actions follow ADMIN §5.2, are shown only where the protocol supports them, and each is a
    `caution` confirm naming the client effect:
    - Yank / Unyank;
    - Deprecate with a message (npm).
  - There is **no delete** (§8.2).

**Permissions (§5.10).** `admin/authz.ts` has one privilege level: platform admin. It says
"Per-product admin does not exist and is not planned" [M]. Both scopes are therefore platform-admin
only, and every write control reads `useCan(...)`. **Audit:** every mutation writes an `audit` row,
under the owning product, with platform-policy changes under the system product (`audit.product` is
`NOT NULL`). The actions are `feed.settings.update`, `feed.policy.update`,
`package.version.yank`, `package.version.unyank` and `package.version.deprecate`.

### 10.2 Admin API (F-11)

Admin routes are **narrative-only** under rule 10: `adminApi` is in `NARRATIVE_ONLY` in
`routeCoverage.test.ts` [M]. So there is no OpenAPI entry. Each route needs a worker test, an audit
row when it mutates and the `docs/admin` narrative update (ADMIN §7.3). There is one handler set,
parameterised by scope:

| Method | Platform scope (`/manage/api`)                               | Product scope (`/manage/api/products/:slug/distribution`) | Notes                                                                                           |
| ------ | ------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/feeds?scope=platform`                                      | `/feeds`                                                  | overview rows; the platform scope aggregates every owner with Distribution on                   |
| GET    | `/feeds/:eco`                                                | `/feeds/:eco`                                             | settings, stats, `registryUrl`, namespace (snippets are rendered client-side from these)        |
| PUT    | `/feeds/:eco/settings` (system owner) · `/feeds/:eco/policy` | `/feeds/:eco/settings`                                    | `expectedVersion`, 409 on mismatch (the A-6 pattern); audited                                   |
| GET    | `/feeds/:eco/packages?q=&owner=&cursor=`                     | `/feeds/:eco/packages?q=&cursor=`                         | paged                                                                                           |
| GET    | `/feeds/:eco/packages/:owner/:name`                          | `/feeds/:eco/packages/:name`                              | versions with source, size, digests, status                                                     |
| POST   | `…/versions/:version/{yank,unyank,deprecate}`                | same                                                      | refused with `reason: "unsupported_by_ecosystem"` where the protocol has no such state; audited |
| POST   | `/feeds/:eco/rebuild`                                        | `/feeds/:eco/rebuild`                                     | re-materialise from D1 (§5.3); audited                                                          |

The product-scope routes are Distribution admin routes like today's `…/distribution/access`. The
platform-scope routes go through the `platformAdmin` seam (§6.2). Both call the same
`listFeeds(db, scope)`, `readFeed(db, scope, eco)` and so on.

## 11. Decisions for the owner

1. **D1 · Registry hostname.**
   - **Recommended:** `pkg.plrs.im`, the same Worker on a third custom domain, same-site with the
     console under the bytes host's compensations (§5.2).
   - **Alternative:** a separate registrable domain, for full cookie-site isolation at the cost of a
     second domain.
   - Either way, the owner creates the custom domains: production, staging and dev.
2. **D2 · Public registries in parallel.**
   - **Recommended:** keep publishing the SDKs to npmjs (`@polaris-key`), PyPI and Maven Central as
     well. The public names stay claimed (§8.3) and adopters keep zero-config installs.
   - **Alternative:** feeds only, with placeholder packages holding the public names.
   - The npm JS SDKs currently target GitHub Packages, which F-10 would retire either way.
3. **D3 · Swift signing.**
   - **Recommended:** sign Swift registry releases (CMS, `X-Swift-Package-Signature`) with an
     X.509 code-signing identity. SwiftPM's default `onUnsigned: prompt` otherwise stops unattended
     builds.
   - **Alternative:** ship unsigned and document a per-host `registries.json`
     `signing.onUnsigned: "silentAllow"` override for adopters.

## 12. Briefs changed

- [`program/wp/X-01-dotnet-sdk.md`](../program/wp/X-01-dotnet-sdk.md): an amendment applying the
  standing rule. If X-01 is taken, the NuGet feed (F-32) becomes required.
- **Proposed, not applied (lead's call):**
  - program README §7 gains the rule for the future (§10);
  - program README §6 "Cloudflare" gains the `pkg.plrs.im` custom domains;
  - README §3.8 "Routes" gains package feeds as Distribution's third delivery way;
  - `start/concepts.md` gains "package feed" and "package (deliverable kind)" in F-01's first
    implementing PR (rule 4).
- **Not changed:** S-12 has no `workpackages.json` entry or brief, so
  `check.mjs --set S-12 in-review` does not apply; the lead adds the F series after owner review.

## 13. Sources

All fetched 2026-10-03.

**npm**

- npm registry docs, package metadata:
  <https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md>
- npm-package-arg (`escapedName`): <https://raw.githubusercontent.com/npm/npm-package-arg/main/lib/npa.js>
- pacote registry fetcher (`Accept`, integrity):
  <https://raw.githubusercontent.com/npm/pacote/main/lib/registry.js>
- libnpmpublish:
  <https://raw.githubusercontent.com/npm/cli/latest/workspaces/libnpmpublish/lib/publish.js>
- `.npmrc` auth and scopes: <https://docs.npmjs.com/cli/v11/configuring-npm/npmrc>,
  <https://docs.npmjs.com/cli/v11/using-npm/scope>
- package names: <https://docs.npmjs.com/cli/v11/configuring-npm/package-json>

**PyPI**

- Simple Repository API: <https://packaging.python.org/en/latest/specifications/simple-repository-api/>
- PEPs: <https://peps.python.org/pep-0691/>, <https://peps.python.org/pep-0714/>,
  <https://peps.python.org/pep-0694/> (Draft), <https://peps.python.org/pep-0708/> (Rejected)
- pip collector (`Accept`, `_ensure_api_header`):
  <https://raw.githubusercontent.com/pypa/pip/main/src/pip/_internal/index/collector.py>
- pip docs: <https://pip.pypa.io/en/stable/topics/authentication/>,
  <https://pip.pypa.io/en/stable/cli/pip_install/>,
  <https://pip.pypa.io/en/stable/topics/secure-installs/>
- uv: <https://raw.githubusercontent.com/astral-sh/uv/main/crates/uv-client/src/registry_client.rs>,
  <https://docs.astral.sh/uv/concepts/indexes/>
- PyPI upload API: <https://docs.pypi.org/api/upload/>

**Swift**

- Registry server specification:
  <https://github.com/swiftlang/swift-package-manager/blob/main/Documentation/PackageRegistry/Registry.md>
  and `PackageRegistryUsage.md`
- SE-0378 (registry auth):
  <https://github.com/swiftlang/swift-evolution/blob/main/proposals/0378-package-registry-auth.md>
- SwiftPM `RegistryClient.swift` (path appending):
  <https://raw.githubusercontent.com/swiftlang/swift-package-manager/main/Sources/PackageRegistry/RegistryClient.swift>

**Maven / Gradle**

- Maven: <https://maven.apache.org/repository/layout.html>,
  <https://maven.apache.org/guides/mini/guide-naming-conventions.html>,
  <https://maven.apache.org/settings.html>,
  <https://maven.apache.org/guides/mini/guide-mirror-settings.html>
- Gradle: <https://docs.gradle.org/current/userguide/supported_repository_protocols.html>,
  <https://docs.gradle.org/current/userguide/filtering_repository_content.html>

**OCI**

- Distribution spec: <https://github.com/opencontainers/distribution-spec/blob/main/spec.md>
- Token auth: <https://github.com/distribution/distribution/blob/main/docs/content/spec/auth/token.md>
- Reference grammar: <https://github.com/distribution/reference/blob/main/reference.go>
- serverless-registry: <https://github.com/cloudflare/serverless-registry>

**Godot**

- Editor source: `editor/asset_library/asset_library_editor_plugin.cpp` and
  `editor/settings/editor_settings.cpp` (branches `4.6`, `4.7`, `master`) in
  <https://github.com/godotengine/godot>
- Legacy API: <https://github.com/godotengine/godot-asset-library/blob/master/API.md>
- Asset Store: <https://store.godotengine.org/api/v1/> (OpenAPI 1.1.0)
- GodotEnv: <https://github.com/chickensoft-games/GodotEnv>

**Go, Cargo, NuGet (tier 3)**

- Go: <https://go.dev/ref/mod>
- Cargo: <https://github.com/rust-lang/cargo/tree/master/doc/book/src/reference> (`registries.md`,
  `registry-index.md`, `registry-web-api.md`, `registry-authentication.md`, `unstable.md`)
- NuGet:
  - <https://learn.microsoft.com/en-us/nuget/api/overview>
  - <https://learn.microsoft.com/en-us/nuget/api/package-base-address-resource>
  - <https://learn.microsoft.com/en-us/nuget/api/registration-base-url-resource>
  - <https://learn.microsoft.com/en-us/nuget/api/package-publish-resource>
  - <https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping>
- NuGet restore internals: DeepWiki over NuGet.Client [S]

**Cloudflare**

- <https://developers.cloudflare.com/r2/pricing/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>

**Repository (at `25e6209c`)**

- Worker: `packages/worker/src/core/{bytesHost,blobs,ciScope,ciVocabulary}.ts`,
  `services/distribution/{bytes,access,blobAccess}.ts`, `services/distribution/feeds/index.ts`,
  `admin/authz.ts`, `mount.ts`, migrations `0001_init.sql` (`audit`) and `0026_blob_store.sql`
  (`blob_refs`), `test/routeCoverage.test.ts`
- CLI: `packages/cli/src/{publish,s3}.ts`
- Workflows: `.github/workflows/release{,-python,-swift,-godot}.yml`
- SDKs: `sdks/kotlin/build.gradle.kts`, `sdks/swift/Package.swift`
- Console and docs: `packages/admin/src/console/nav.ts`, `packages/docs/scripts/gen-reference.mjs`
  (`TABLE_OWNERS`)
- Design and security: `docs/design/ADMIN.md`, `docs/security/THREAT-MODEL.md` §3
