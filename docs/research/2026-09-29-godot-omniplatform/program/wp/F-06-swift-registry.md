# F-06 Swift registry: SE-0292 endpoints, `/identifiers`, signed releases and the compatibility suite

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                |
| Size        | 1.5–2 engineer-weeks                                                   |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)        |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md) |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | rule 10; CI on a macOS runner                                          |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

The Swift registry feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/swift/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). Signed releases carry their CMS signature in the metadata and the archive headers. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

SwiftPM installs from the registry with an archive whose `Package.swift` is at the root, which fixes the monorepo-subdirectory problem of `sdks/swift`. Its default `onUnsigned: prompt` is why the owner decided to sign.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the Swift registry row and its notes).
- SwiftPM's `Registry.md`, SE-0292, SE-0378, `RegistryClient.swift`, and the registry compatibility test suite ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- [`plans/F-01.md`](../plans/F-01.md) §5.3 (Swift signing).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the Swift registry extractor.

## Scope

**In:**

- `GET /{scope}/{name}`, `/{version}`, `/{version}/Package.swift` (with `swift-version`), `/{version}.zip`, `/identifiers?url=`; `POST /login` answering 501 until F-21.
- `Content-Version: 1`, `Accept` checks (400, 415), `problem+json`, the `Link` headers, and the signature fields and headers.
- The `requireSigned` refusal at ingest, shared with F-03.
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- Serve the **signed** manifest copies uploaded by the CLI, never copies re-extracted from the zip.
- Test signing with a throwaway CA generated inside the test. Never commit a key.
- Answer plan question Q1 empirically: record whether the recommended certificate chain verifies on macOS and Linux SwiftPM with `onUntrustedCertificate: error`.

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [x] Matrix green: the swiftlang compatibility suite; `swift package resolve` and `swift build` on macOS with `onUnsigned: error`; a Linux container build.
- [x] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [x] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [x] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registrySwift routeCoverage
gh workflow run registry-clients.yml -f ecosystem=swift
```

## Corrections (recorded while implementing, against the code)

Where the brief or plans/F-01.md disagreed with the code, the code was the fact. No wire shape,
corpus file or `PROTOCOL_VERSION` changes.

1. **`POST /login` (501) and Swift's 405 live in `core/registryHost.ts`.** The host dispatcher
   answers every non-GET/HEAD method before any route runs (F-02), so a route cannot answer a
   POST. `registryMethodNotAllowed` gained Swift's branch: 501 for `POST /swift/<owner>/login`,
   405 `problem+json` for anything else, both with `Content-Version: 1` and decided from the
   path alone, before an owner loads. Swift's not-found carries `Content-Version: 1` too.
   `REGISTRY_PATHS` documents login as a `host` row.
2. **`RenderContext.bucket`** (optional, additive) lets the Swift renderer embed the CMS
   signature (base64) in the release metadata and read each `Package@swift-*.swift`'s declared
   tools version for the `alternate` links. `materialise` passes its bucket.
3. **No URL is rendered.** The list omits each release's optional `url` (§4.1 lets the client
   expand the template on the host it asked) and every `Link` header is built from
   `PKG_ORIGIN` when answering, so renders never depend on the origin.
4. **Yank, deprecate, channels.** A yanked version keeps its list entry with a `problem` (410
   Gone), which SwiftPM treats as unavailable; its metadata, manifests and archive stay served,
   because a Swift archive never changes after publish (TOFU, plan §6.7). The protocol has no
   deprecation, so a deprecated version is listed as available. `latest-version` names the
   `latest` tag (the stable channel's head) when it is available, else the highest stable
   version; a beta prerelease resolves only for a prerelease requirement (SwiftPM's rule). A
   declared package with nothing published is the not-found.
5. **The `requireSigned` refusal was already F-03's** (`swift-unsigned`, `ingest.ts`, tested in
   `packageReleases.test.ts`); F-06 added no ingest code.
6. **`/identifiers` reads `ext_json.repositoryUrls` as `{"scope.Name": [url, …]}`**, compared
   without scheme, user, `.git` or case, and lists only packages the feed holds that the reader
   may read. F-12 owns writing the setting.
7. **Versions match case-insensitively** (the swiftlang compatibility suite flips the case of
   the whole path, the version included).
8. **The compatibility suite's upstream manifest no longer resolves** (its example server's
   Vapor/postgres-nio/service-lifecycle pins conflict). `clients/swift-compat.sh` builds the
   pinned commit `5d873abb` with `swift/compat-Package.swift`, which keeps only the CLI's
   dependencies. `create-package-release` is not run (publishing is F-22's).
9. **The harness seeds through wrangler's platform proxy**, not `pkey release publish`: the
   local Worker cannot presign uploads against a real R2 account. `clients/swift.seed.mjs` signs
   the fixtures with SwiftPM's own `--dry-run` signer and a throwaway CA generated per run, then
   writes the rows and SHA-256-checked blobs ingest would. `run.mjs` gained a per-client seed hook
   (`clients/<client>.seed.mjs`, or its family's), and F-02's base seed gained the active
   `product_keys` row `loadProductPublic` needs (without it every ecosystem route was the
   not-found).
10. **Q1, answered empirically for a private root.** A chain of a throwaway EC P-256 root and a
    `codeSigning` leaf verifies with `onUnsigned: error` and `onUntrustedCertificate: error` on
    SwiftPM 6.4 (macOS 27) and in `swift:6.2` (Linux) once the root is trusted, and is refused
    ("the signer … is not trusted") when it is not. The production certificate chain still needs
    the owner's certificate to test. For F-10: `--private-key-path` takes a **PKCS#8 DER** key and
    `--cert-chain-paths` DER certificates, so `SWIFT_REGISTRY_SIGNING_KEY` (plan §5.3: PEM) must be
    converted (`openssl pkcs8 -topk8 -nocrypt -outform DER`) before signing; `--url` is required even
    with `--dry-run`, and the scratch directory must exist.
11. **Verify.** The worker suite is `test/registrySwift.test.ts`, so the filter is
    `registrySwift` (not `registry/swift`). `registry-clients.yml` had no `ecosystem` input; it
    gained one (a client-name prefix), so `gh workflow run registry-clients.yml -f ecosystem=swift`
    runs the three Swift rows (`swift`, `swift-compat` on macOS, `swift-linux` on Ubuntu).
12. **The render queue is not drained yet** (F-02 shipped `drainRegistry` behind an interface and
    F-03 the queue; neither wired `dispatch.ts`/`scheduled.ts`). Swift documents are rendered on
    a miss, but after a publish, yank or channel move an existing render stays stale until the
    drain is wired. Proposed follow-up below; F-06 does not touch the composition root.

## Hand-off

- F-10 publishes our Swift registry packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-06 done`.
