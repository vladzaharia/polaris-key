> Research note for [Godot on Polaris Key](../README.md), 2026-10-05. Spike S-20 was commissioned
> by the lead after the owner asked on 2026-10-05: "Polaris Key should also host applications'
> assets so that we do not have to require them to host it themselves somewhere (including
> Github). Just pull the files and host them in one of our subdomains."
>
> - **No program brief.** S-20 has none. §9 adds an `HA-` work-package namespace.
> - **What changed in the repo.** This is research and design. No product code changed and nothing
>   was deployed. The only code added is a reference puller under
>   [`prototype/hosted-assets/`](../prototype/hosted-assets/).
> - **External calls.** All of them were read-only GETs with the operator's own GitHub CLI login,
>   against the operator's own repos (§3).
> - **File references.** They are to the tree at `6967347a`:
>   - `W/` = `packages/worker/src/`
>   - `M/` = `packages/worker/migrations/`
>   - `SM/` = `packages/shared-manifest/src/`
>   - `N/` = `docs/research/2026-09-29-godot-omniplatform/notes/`
>   - `P/` = `docs/research/2026-09-29-godot-omniplatform/program/`
> - **PX-W3.** The PX-W3 plan was read on branch `plan/PX-W3` (`48f5a893`).

# S-20: Polaris Key hosts the assets

> **Owner decisions (delegated to Claude, 2026-10-05). These govern the note.** Where any section
> below says otherwise, these win. The owner delegated every decision to the lead "until further
> notice". The lead told this spike to decide each question itself, normally on its own
> recommendation. Each decision below is the recommendation in §10. The `HA-*` packages are
> registered in [`program/workpackages.json`](../program/workpackages.json) as `todo` (ready once
> their dependencies are done). No package waits on an approval except the one plan-mode plan,
> HA-11, which goes through the normal plan gate, held by the lead.
>
> 1. **Scope: host everything.** This covers presentation media, storefront listing art,
>    release files and release-note images. Polaris Key keeps its own copy of every file it
>    serves. A developer's GitHub release or external URL stays a _source_ and a fallback
>    location, never a requirement.
> 2. **A separate image host.** It is `img.plrs.im`, with `img-staging` and `img-dev`. It is
>    the same Worker on a fourth custom domain, `IMG_ORIGIN`. It serves public, inline,
>    cookie-less, immutable images only. `dl.plrs.im` keeps the downloads (§6.5).
> 3. **Pull from any public https host.** There is no host allowlist. The guard in §6.3 applies
>    instead. Repo-relative paths are pulled through the GitHub App installation token. Pulls
>    run only at register, resync, publish or an operator action, never on an end user's
>    request.
> 4. **Image sizes are generated once, at ingest.** The Images binding produces a fixed ladder
>    in WebP, and the original is always kept. There are no on-the-fly transformations. Without
>    the binding, only the original is served.
> 5. **Manifest.**
>    - `.pkey/product` gains `presentation { icon, accent, accentDark }`.
>    - The `.pkey/distribution` `listing` gains `icon`, `header` and `screenshots[]`, each
>      taking an https URL or a repo path.
>    - `iconUrl` and `headerUrl` stay as deprecated aliases.
> 6. **Release mirroring is on by default** for every product, existing ones included.
>    - The GitHub location stays as a fallback.
>    - No signed document changes, because the signed documents carry hashes, not URLs (§4.3).
>    - Product setting: `assets.releases.mirror`, operator-scope.
> 7. **Licensed bytes reuse PX-W3's download ticket.** Presentation media are never gated, and
>    the image host refuses anything that is.
> 8. **Retention.**
>    - Polaris Key never deletes or modifies a developer's source.
>    - Its copies are held by `blob_refs` and fall to the existing collector after the 180-day
>      age lock and the grace period.
>    - When a source disappears, the last good copy keeps serving.
> 9. **Quotas.**
>    - The per-product quotas are registry settings: `assets.quota.mediaBytes`, default 512 MiB,
>      and `assets.quota.releaseBytes`, default 100 GiB.
>    - Per-file caps are code constants, because they are security bounds (S-18 §5.6).
> 10. **Presentation in discovery.** It is an unsigned `core.presentation` member, planned in
>     plan mode (HA-11). Through it, every UI kit defaults to the product's icon and accent with
>     no integrator work.
> 11. **A console upload claims a slot.** This follows S-18's model C: Revert returns the slot
>     to the manifest's source.
> 12. **The two latent defects found here are fixed in HA.** They are the missing Content-Type on
>     R2 puts (HA-01) and the THREAT-MODEL line that says listing assets are never served (HA-07).
>     §4.6 describes both.

Evidence tags, as in the other notes: **[V]** read in the code, the docs or a vendor's primary
page; **[M]** measured; **[S]** summarised from a secondary source; **[I]** inference or design.

## 1. Question

Today the developer hosts much of what Polaris Key shows or ships: icons and header art on raw
GitHub URLs, release files on GitHub Releases, and screenshots and media wherever they like.
What would it take for Polaris Key to pull those files itself, check them, keep them in its own
R2 and serve them from its own subdomains? It must do so without breaking any deployed client
and while respecting these existing decisions:

- the R2 buckets and `dl.plrs.im`;
- S-15 and A-18's listing model;
- S-18's settings registry;
- S-19's licensing model;
- PX-W3's download ticket.

## 2. Short answer

Most of the machinery already exists. The design reuses it.

- **Storage is already right.** P2-01's blob store is content-addressed (`blobs/sha256/<hex>`),
  ref-counted (`blob_refs`), age-locked and served only through the Worker [V]. Hosted assets are
  more refs into the same store.
- **The signed documents do not need to change.** The v4 feed, release record, pack, chunk-index
  and delegation records pin bytes by SHA-256 and never name a host [V] (§4.3).
  - Mirroring every GitHub release file into R2 is a server-side change.
  - `serveArtifact` already ranks an `r2` location ahead of `github` [V].
  - Deployed SDKs, Sparkle, Velopack, App Installer and zsync clients keep working, and start
    receiving our bytes on their next fetch.
- **The real gaps are in presentation media and listing art.**
  - The only external images a developer can declare are `listing.iconUrl`, `headerUrl` and
    `screenshots[]` in `.pkey/distribution` [V].
  - The portal proxies two of them, from GitHub hosts only, at request time [V].
  - The AltStore and SideStore feeds hand all three to end-user devices verbatim [V].
  - Listing art for the stores can only come from files on a CI runner [V].
  - The console has no upload [V].
  - DJDL shows the cost. Its repo is private, so it keeps a second public repo
    (`vladzaharia/djdl-assets`) and a script that pins commit URLs, only so the portal proxy can
    fetch its icon [M] (§5).
- **The design.**
  - One `hosted_assets` table and one ingest path: guard, fetch or receive, cap, sniff, hash, put,
    ref.
  - Three ways in: a pull at register or resync, a console upload, and a CI push.
  - One new host, `img.plrs.im`, for public images at content-addressed, immutable URLs.
  - Release files keep being served from `dl.plrs.im`, now always from R2.
  - Licensed files go through PX-W3's ticket.
- **Plan mode is needed once.** Adding `core.presentation` to discovery, so that UI kits pick up
  the icon and accent unaided, is a discovery-member change. It needs plan mode and touches the
  transcripts and every SDK (HA-11 to HA-14).
- **The rest is not wire work.** Everything else is Worker, manifest (rule 9), console and CLI
  work.
- **Seventeen work packages, fifteen required.** Two are ready now: HA-01, the ingest core, and
  HA-04, the manifest fields. HA-11, the plan, is ready once HA-04 lands.

## 3. Method

- **Code inventory.** Four parallel read-only code sweeps covered presentation, listing,
  releases, and feeds/docs/email/infrastructure. The findings that matter were then re-read by
  hand: `W/core/blobs.ts:270-285`, `W/services/distribution/blobAccess.ts:110-240`,
  `W/services/distribution/connectors/play/storefront.ts:535-548`,
  `docs/security/THREAT-MODEL.md:920-935`, `W/core/discovery.ts:80-130`,
  `packages/worker/wrangler.toml:100-200`, and the PX-W3 plan on `plan/PX-W3`.
- **Vendor pages, read 2026-10-05 [V].**
  - Cloudflare Images: the binding, and pricing.
  - Workers: limits, the `global_fetch_strictly_public` flag, and the known issue on fetch to IP
    addresses.
  - R2: upload limits.
- **Measurements [M].**
  - **Environment:** macOS 27.0 on arm64 (a laptop on a residential connection), Node v22.13.1
    via `mise exec node@22`, gh 2.92.0, curl (system).
  - **What was measured:**
    - DJDL's release inventory, through the GitHub REST API;
    - DJDL's listing art, with curl and `shasum`;
    - the reference puller against both;
    - one private release asset, pulled with the installation-equivalent token and checked
      against GitHub's `digest`.
  - **What these numbers do not measure:** pulls from a Worker. They size the data and prove the
    checks; they do not predict edge throughput.

Exact commands (scratch output lives outside the repo):

```sh
gh api --paginate 'repos/vladzaharia/djdl/releases?per_page=100' \
  --jq '.[] | [.tag_name, (.assets|length), ([.assets[].size]|add // 0), ([.assets[]|select(.digest==null)]|length), .immutable] | @tsv'
gh api repos/vladzaharia/djdl/contents/.pkey/distribution.yaml --jq .content | base64 -d
curl -sS -o icon.png -w '%{http_code} %{size_download} %{content_type} %{time_total}\n' \
  https://raw.githubusercontent.com/vladzaharia/djdl-assets/3bb6289e…/listing/icon.png
cd docs/research/2026-09-29-godot-omniplatform/prototype/hosted-assets
mise exec node@22 -- node pull.mjs --self-test
mise exec node@22 -- node pull.mjs <icon-url> --cap 1048576 --sha256 1e7d7d72…
mise exec node@22 -- node pull.mjs <header-url> --cap 262144
mise exec node@22 -- node pull.mjs https://github.com/vladzaharia/djdl-assets/raw/3bb6289e…/listing/icon.png
gh api -H 'Accept: application/octet-stream' repos/vladzaharia/djdl/releases/assets/<id>   # timed, hashed
```

## 4. Inventory: every place Polaris Key points at a file the developer hosts

The columns are:

- **Source**: where the URL or bytes come from.
- **Fetcher**: who dereferences it.
- **Signed?**: whether it appears in a JWS.
- **Today**: today's behaviour.

All rows are [V] unless marked.

### 4.1 Product presentation

| #   | Item                                                               | Source                                                                                                                                                                                                                                   | Fetcher                                                                            | Signed? | Today                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | Product icon                                                       | `.pkey/distribution` `listing.iconUrl` (`SM/distribution.ts:472-578`; https, at most 2048 chars, **no host check**). Stored raw in `dist_listing.listing_json` (`M/0063`) and `dist_outlets.listing_json` (`M/0036:34`) on every resync. | Worker: portal proxy `GET /media/<p>/icon` (`W/services/identity/portal/media.ts`) | no      | Fetched at request time only when the host is GitHub (`isAllowedStorageHost`, `W/http.ts:64`). Up to 3 checked redirects, 5 s, 1 MiB cap, magic-number sniff (no SVG). Kept in the Cache API, never stored. Any other host is **silently not shown**. `.pkey/product` has no image field and reserves the slugs `media`/`avatar` (`SM/index.ts:1182`). |
| P2  | Header and hero art                                                | `listing.headerUrl`                                                                                                                                                                                                                      | same proxy, `/media/<p>/header`, 5 MiB cap                                         | no      | Same as P1.                                                                                                                                                                                                                                                                                                                                            |
| P3  | Screenshots                                                        | `listing.screenshots[]` (at most 16, https)                                                                                                                                                                                              | nobody in the portal; end-user AltStore clients (L5)                               | no      | Not proxied. Not imported into the listing model ("asset URLs are not imported", `W/services/distribution/listing/sources.ts:241-302`).                                                                                                                                                                                                                |
| P4  | Accent                                                             | `listing.tintColor` (`#rrggbb`); `dist_listings.tint`/`tint_dark` (`M/0065:30`)                                                                                                                                                          | portal (`presentationFor`, `W/services/identity/portal/library.ts:106-125`)        | no      | Portal only. **No UI kit reads it.**                                                                                                                                                                                                                                                                                                                   |
| P5  | `products.branding_json` / `portal_product_settings.branding_json` | `M/0001:22` (always null); `M/0008:57` (free-form admin PATCH, unvalidated)                                                                                                                                                              | portal reads it as a fallback                                                      | no      | No image field in use.                                                                                                                                                                                                                                                                                                                                 |
| P6  | Portal Library, product page, Discover                             | `presentationFor` → same-origin `/media/<p>/{icon,header}` or null                                                                                                                                                                       | browser, `img-src 'self' data:` (`W/securityHeaders.ts:42`)                        | no      | Falls back to the tint plus the first letter (`ProductArt.tsx`). Discover is still a placeholder (PX-W10). The activate preview forces both images to null (`selfService.ts:235-249`).                                                                                                                                                                 |
| P7  | Console                                                            | none                                                                                                                                                                                                                                     | none                                                                               | no      | **No product icon anywhere and no image upload.**                                                                                                                                                                                                                                                                                                      |
| P8  | SDK UI kits                                                        | integrator-supplied logo (React `theme.logo`, Swift `logoOverride`, Kotlin `logo`, Godot bundled marks only); product **name** from discovery (`settings_controller.gd:144`)                                                             | none                                                                               | no      | **No kit shows the product icon or accent without integrator work.**                                                                                                                                                                                                                                                                                   |
| P9  | Emails                                                             | the hard-coded Polaris Key lockup at `${CONSOLE_ORIGIN}/assets/branding/…` (`W/services/identity/portal/email.ts:116`)                                                                                                                   | the mail client                                                                    | no      | No product logo in any email.                                                                                                                                                                                                                                                                                                                          |
| P10 | Brand pages, bytes landing, docs                                   | same-origin `/assets/branding` and `data:` only                                                                                                                                                                                          | browser                                                                            | no      | Nothing developer-hosted. No `og:image` anywhere.                                                                                                                                                                                                                                                                                                      |
| P11 | Avatars (planned, G33/PX-W16)                                      | identity provider avatar URLs                                                                                                                                                                                                            | Worker (planned: fetch, re-encode, R2, `/media/avatar/:asset`)                     | no      | Not built. `accounts.avatar_key` is reserved (`M/0068_a:29`). HA-01's ingest is the natural substrate.                                                                                                                                                                                                                                                 |

### 4.2 Storefront listing assets (S-15 / A-18)

| #   | Item                                                                                                        | Source                                                                                                                                                           | Fetcher                                                                                                                                                                            | Signed?                                                            | Today                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Masters (`icon-master`, adaptive layers, `key-art`, `wordmark`, `screenshot:<class>`)                       | **local files on a CI runner** given to `pkey listing assets` (`packages/cli/src/listingAssets.ts`). The Godot import resolves icon paths and only reports them. | CLI (sharp) → upload ticket → `staging/` → `POST /<p>/distribution/listing/assets` → `blobs/sha256/` + `blob_refs` `listing-asset`                                                 | no (`M/0065` header: "nothing here is signed or on the wire")      | Already in R2, content-addressed. `dist_listing_assets.source` is `admin\|import`, but **nothing writes `admin`**: there is no console upload (`listing/admin.ts:148-160` lists only). |
| L2  | Derived store art (Play, Microsoft, Steam, itch, Snap, Flathub, winget, F-Droid slots, `pack:<store>` ZIPs) | composed by the CLI from L1                                                                                                                                      | CLI → R2. Pushers: Play `playUploadImage` (no production caller), Microsoft `replaceListingImages` (raw bytes, no slot mapping), Apple denied (A-18m), Steam a manual pack (A-18g) | no                                                                 | In R2. Gaps: the Play pusher maps master screenshot slots instead of the fitted `play:screenshot:<class>:<n>` rows, and no download route exists for packs.                            |
| L3  | Store-side images seen on import (ASC `templateUrl`, Play `images.list`)                                    | the vendor CDNs                                                                                                                                                  | reported only (`SnapshotAsset.ref`, `W/core/storefront/listingImport.ts:88-104`)                                                                                                   | no                                                                 | **Never fetched or stored.** Migrating a live store listing therefore needs a person.                                                                                                  |
| L4  | Trailers and video (`trailer-master`, `youtube-url`)                                                        | none                                                                                                                                                             | none                                                                                                                                                                               | no                                                                 | The slots exist, but `blob`/`sha256` are NOT NULL, which does not fit a URL. Nothing writes them.                                                                                      |
| L5  | AltStore/SideStore source `iconURL`, `headerURL`, `screenshots`, `tintColor`                                | manifest `listing` verbatim (`W/services/distribution/feeds/render.ts:192-218`)                                                                                  | **end-user devices hotlink the developer's URL**                                                                                                                                   | no (unsigned JSON, strong ETag)                                    | Any https host. Not checked or copied.                                                                                                                                                 |
| L6  | Flathub MetaInfo `<screenshots>` (A-18i, todo)                                                              | needs public https URLs (`P/wp/A-18i-pr-plane-generators.md:45`)                                                                                                 | Flathub                                                                                                                                                                            | no                                                                 | **Unresolved: the blob store has no public URL for listing art.** HA-02 resolves it.                                                                                                   |
| L7  | F-Droid icons                                                                                               | `pkey feeds fdroid --icon <png>` (local file)                                                                                                                    | Worker serves from R2 under a `feed` ref                                                                                                                                           | the index is covered by CI's `entry.jar`, Polaris Key holds no key | Hosted already. Does not read `fdroid:*` listing slots.                                                                                                                                |
| L8  | Godot asset-library `icon_url`                                                                              | the `godot-icon` payload in the release (sha256)                                                                                                                 | Worker at `/godot/<owner>/icons/<sha256>.png`                                                                                                                                      | the payload hash is inside `pkey-release+jws`                      | Hosted already.                                                                                                                                                                        |

### 4.3 Release deliverables and update feeds

| #   | Item                                                                                       | Source                                                                                                                                                                 | Fetcher                                                                                                                                                                        | Signed?                                                                                                                                                                                   | Today                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | GitHub release files                                                                       | release webhook → `syncReleaseStoreReport`. `release_artifacts.source_url = browser_download_url` (`W/services/release/store.ts:1247`). Location `{provider:"github"}` | Worker: `serveGithubLocation` streams with the installation token (`W/services/release/source.ts:194-240`); `?redirect=1` 302s only for a public repo and a public deliverable | no URL in any signed doc. Signed **records** carry name, role, sha256, size and contentType (`shared-protocol/src/release.ts:25-62`, "without the locations (they change after signing)") | Works, but every byte crosses GitHub at request time. The legacy `/dl/<selector>/<binary>-<arch>` path is resolved live against GitHub.                                                                                                                                              |
| R2  | Descriptor locations `r2`, `github`, `store`, `external`                                   | the unsigned `pkey-release.json` (`SM/descriptor.ts:70-110`, "every location is pinned by the artifact's SHA-256")                                                     | `serveArtifact` (`W/services/distribution/bytes.ts:461-551`) in `LOCATION_RANK` order: r2 (hash-pinned, ref held), then github, then **external → 302 to the stored URL**      | no                                                                                                                                                                                        | `external` is followed blindly (a 302). Polaris Key never copies it.                                                                                                                                                                                                                 |
| R3  | Portal `/download/<token>`                                                                 | `downloadTarget` (`W/services/identity/portal/api.ts:321-391`)                                                                                                         | browser                                                                                                                                                                        | no                                                                                                                                                                                        | 302 to GitHub's `browser_download_url`. **For a private repo that URL 404s for an anonymous browser.** A non-public file held only in R2 becomes `not_hosted` (`portal/downloads.ts:87-90,250`). PX-W3 (plan approved in substance, decision 18) closes the R2 half with `?ticket=`. |
| R4  | Sparkle appcast enclosure                                                                  | legacy: console `/release/dl/...` (`W/services/update/feed.ts:235`). Extended (P3-09): `deliveryUrl` on dl                                                             | Sparkle                                                                                                                                                                        | EdDSA over the archive **bytes** only. The appcast itself is unsigned.                                                                                                                    | `SUFeedURL` is pinned in shipped apps to the **console** host, so a dl change is transparent and a console move is not. Identical bytes keep `edSignature` valid wherever they are hosted.                                                                                           |
| R5  | Velopack, App Installer, zsync, `/version`                                                 | `W/services/update/updaterFeeds.ts`, `updaterRender.ts`                                                                                                                | the updater frameworks                                                                                                                                                         | no (hash fields in the bodies)                                                                                                                                                            | Velopack `FileName` is relative and 302s from the console to dl. App Installer `packageUri` is on dl. The zsync `URL:` is rewritten per request.                                                                                                                                     |
| R6  | v4 signed channel feed, packs, deltas, chunks                                              | `feed.jws` (`shared-protocol/src/update.ts:18-100`); pack, chunk and delegation records (`shared-protocol/src/packs.ts`)                                               | SDKs via the discovery templates `builds`/`blobs` (`W/services/distribution/index.ts:197-214`)                                                                                 | **yes, but hashes only.** The one URL, `outlets.<id>.listingUrl`, is a store page (prefix-allowlisted).                                                                                   | Nothing to change. Host-independent by design (P3-01 plan: "the record never says where bytes are").                                                                                                                                                                                 |
| R7  | Storefront feeds (AltStore `downloadURL`, Obtainium, Scoop, Flathub) and the download page | `fileDeliveryUrl` on dl (`W/services/distribution/delivery.ts:69-88,234-270`)                                                                                          | clients, third-party buckets                                                                                                                                                   | F-Droid only (CI key)                                                                                                                                                                     | Already ours **when the file is in R2**. For GitHub-only files they still go through our routes and the Worker streams from GitHub.                                                                                                                                                  |
| R8  | Package feeds (`pkg.plrs.im`)                                                              | R2 only; S-12 §4.2 "do not proxy upstream"                                                                                                                             | package clients                                                                                                                                                                | no                                                                                                                                                                                        | Fully hosted already. Nothing to do.                                                                                                                                                                                                                                                 |

### 4.4 Release notes, docs links and email

| #   | Item                                                       | Source                                                                                                                                       | Fetcher                                                                                                                                                                                      | Signed?                                                                                                                       | Today                                                                                 |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| N1  | Release notes markdown, which may contain `![](https://…)` | descriptor `notes` (at most 20,000 chars, `SM/descriptor.ts:310,546`), else the GitHub release body (`W/services/release/descriptor.ts:739`) | portal What's New, the dl page and store notes strip images (`!alt` remains, `page/model.ts:330`); **AltStore emits the raw notes** (`feeds/render.ts:162,204`), so devices fetch the images | **yes**: `notes` is inside `pkey-release+jws` (`descriptorToRecord`, `SM/descriptor.ts:490`); pack records also carry `notes` | Images are either mangled or hotlinked. The signed text must never be rewritten.      |
| N2  | Website, support, privacy, EULA links                      | `listing.website`/`supportUrl`; `dist_listings.urls_json`                                                                                    | the user's browser, the stores                                                                                                                                                               | no                                                                                                                            | These are links, not files. **Out of scope:** a web page is not an asset we can host. |
| N3  | npm packument `homepage`/`repository`                      | the packed `package.json`                                                                                                                    | npm clients                                                                                                                                                                                  | no                                                                                                                            | Links. Out of scope.                                                                  |
| N4  | Email images                                               | Polaris Key's own lockup                                                                                                                     | the mail client                                                                                                                                                                              | no                                                                                                                            | Hosted already. A product logo becomes possible after HA-02 (§6.9).                   |

### 4.5 Infrastructure that exists

- **Worker and hosts.** There is one Worker, `polaris-key`. It serves three custom domains per
  environment: `key*`, `dl*` and `pkg*.plrs.im`. The bindings and vars involved:
  - R2 `BLOBS` → `polaris-key-blobs-<env>`;
  - `BLOB_ORIGIN`, `PKG_ORIGIN` and `CONSOLE_ORIGIN`;
  - compatibility flags `["nodejs_compat"]`. **`global_fetch_strictly_public` is not set.**

  Source: `packages/worker/wrangler.toml:1-5,100-200` [V].

- **Bucket rules** [V]:
  - no public or r2.dev domain;
  - a 180-day age lock on `blobs/`, `bundles/`, `deltas/` and `gated/`;
  - `staging/` expires after 1 day;
  - `registry/` is unlocked.
- **Bytes-host isolation.** It is implemented in `W/core/bytesHost.ts` and test-pinned:
  confinement to byte routes, sandbox CSP, `nosniff`, forced `attachment`, no cookies [V].
- **Existing fetch guards** [V]:
  - the portal media proxy (above);
  - `W/core/readCapped.ts`;
  - GitHub's `redirect: "manual"` plus re-check.

  There is no private-range check. The only allowlist is a hostname allowlist.

### 4.6 Defects found along the way

1. **No Content-Type is stored on R2 objects.** [V]
   - `putVerified` calls `bucket.put(key, value, { sha256, onlyIf })` with no `httpMetadata`
     (`W/core/blobs.ts:276-281`). The CLI's S3 PUT sends none either.
   - `playImageFromListingAsset` therefore reports `application/octet-stream`
     (`connectors/play/storefront.ts:543`).
   - The Play gate allows only PNG and JPEG (`rules/googlePlay.ts:351`).
   - The unit tests pass `"image/png"` directly, so a real Play image push would very likely be
     refused [I].

   **Fix in HA-01:** store the sniffed type on every new put, and sniff on read for objects
   stored earlier.

2. **The THREAT-MODEL says listing assets are never served, but the code serves them.**
   - `docs/security/THREAT-MODEL.md:927` says "No route serves these objects."
   - The generic `GET /<p>/distribution/blobs/sha256/<hex>` route classifies any non-pack ref
     as "app-side" (`blobAccess.ts:116-129`). It then serves the object under the app's
     delivery mode, so `public` means anyone who knows the digest (`blobAccess.ts:228-240`).
   - This is read in the code and not exercised [V/I]. It is low-harm: listing art is meant to
     be public, and the digest is unguessable. But it contradicts the threat model, and
     pre-release screenshots may be sensitive.

   **Fix in HA-07:** make the threat model true by excluding the `listing-asset` and
   `hosted-asset` ref kinds from the app-side blob route. These images are served from the
   image host instead.

3. **Licensed bytes on dl do not reach SDKs.** This is noted, not fixed in HA.
   - Every SDK sends the device Bearer only when the URL's origin equals `baseUrl`'s
     (sdk-node `update/client.ts:778`, Swift `UpdateClient.swift:537`, and the others).
   - Discovery advertises `builds`/`blobs` on `BLOB_ORIGIN`.
   - So non-public deliverables only work through the console-host aliases [V].

   It does not get worse with mirroring, but the lead should route it to the P2b/P3 owners. See
   §10.2 Q14.

## 5. Results of the measurements [M]

| Measurement                                                                              | Result                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DJDL repository visibility                                                               | `private: true`                                                                                                                                                                                                                                                                                                           |
| DJDL listing source                                                                      | `.pkey/distribution.yaml`: `iconUrl` and `headerUrl` are `raw.githubusercontent.com/vladzaharia/djdl-assets/<commit>/listing/{icon,header}.png`. The comment explains that a separate public repo and `scripts/publish-listing-art.sh` exist **because the portal proxy only fetches unauthenticated from GitHub hosts**. |
| DJDL icon                                                                                | 200, 126,268 B, `image/png`, 512×512 RGB, sha256 `1e7d7d72…64aa4`, curl 0.28 s                                                                                                                                                                                                                                            |
| DJDL header                                                                              | 200, 569,622 B, `image/png`, 1920×1080 RGB, sha256 `edde2645…d61bc`, curl 0.19 s                                                                                                                                                                                                                                          |
| Puller self-test (`pull.mjs --self-test`)                                                | 12/12 guard cases as expected: scheme, credentials, port, IPv4/IPv6 literal, single-label, `*.plrs.im`, `.local`                                                                                                                                                                                                          |
| Puller, icon with `--sha256` and a 1 MiB cap                                             | `ok`, 688 ms, sniffed `image/png`, hash matched                                                                                                                                                                                                                                                                           |
| Puller, header with a 256 KiB cap                                                        | `refused:too-large`, from the declared `Content-Length` before any body was read                                                                                                                                                                                                                                          |
| Puller, `github.com/<o>/<r>/raw/<sha>/…`                                                 | one 302 hop to `raw.githubusercontent.com`, re-guarded, `ok`, 804 ms                                                                                                                                                                                                                                                      |
| Puller, README served as `text/plain` with `--kind image`                                | `refused:not-an-image` (the sniff, not the declared type, decides)                                                                                                                                                                                                                                                        |
| DJDL releases (all, paginated)                                                           | 12 releases, 72 assets, 2,868,291,647 B (2.67 GiB). **0 assets without a GitHub `digest`.** `immutable: false` on all.                                                                                                                                                                                                    |
| DJDL v0.3.8 assets                                                                       | 6 files, 240,017,828 B. The largest is `djdl-arm64` at 115,533,392 B.                                                                                                                                                                                                                                                     |
| Private asset pull, `djdl-arm64.dmg` via the API with `Accept: application/octet-stream` | 43,728,703 B in 2.11 s (19.8 MiB/s from this laptop). sha256 `27ddd241…42b0da` equals GitHub's `digest`.                                                                                                                                                                                                                  |
| Polaris Key's own repo releases                                                          | 0 releases (`[0,0]`). Nothing to mirror.                                                                                                                                                                                                                                                                                  |

What these numbers mean [I]:

- **Cost.** Mirroring DJDL's whole history costs 2.67 GiB of R2, about $0.04 a month at R2's
  storage price. One 240 MB release adds about 0.23 GiB.
- **Digests are always there.** GitHub now publishes a `sha256:` digest for every asset, even on
  non-immutable releases, so a mirror can verify before it promotes. That holds for DJDL's whole
  history.
- **Sizes are well inside the limits.** The largest DJDL file is 110 MiB. R2's single-put limit
  is 4.995 GiB [V], and Workers enforce no limit on the size of a _subrequest_ body [V].
  - A pull from GitHub into R2 streams through `putVerified` (`FixedLengthStream` plus
    `DigestStream`, as `W/core/blobs.ts:196-281` already does) without buffering.
  - A file over 4.995 GiB would need multipart, which is out of scope until a product needs it.

## 6. Design: Polaris Key hosts it

### 6.1 Vocabulary (rule 4)

- **Hosted asset**: Polaris Key's own copy of a developer file, plus the record of where it came
  from. It is never "mirror" in UI copy, though "mirroring" is fine for the release-file process.
- **Source**: where the developer keeps the original. It can be a URL, a repo path, a GitHub
  release asset, an upload or a CI push.
- **Slot**: the role a hosted asset fills: `presentation.icon`, `listing.header`,
  `listing.screenshot:<n>`, an A-18 slot such as `play:feature-graphic`, `notes-image:<hash>` or
  `release-file`.

HA-15 adds these terms to the glossary.

### 6.2 Data model (HA-01, migration)

```sql
CREATE TABLE hosted_assets (
  product       TEXT NOT NULL,
  slot          TEXT NOT NULL,             -- presentation.icon | listing.header | listing.screenshot:3 | <A-18 slot> | notes-image:<urlhash>
  locale        TEXT NOT NULL DEFAULT '',
  origin        TEXT NOT NULL,             -- manifest | console | ci | release-mirror
  source_kind   TEXT NOT NULL,             -- url | repo | upload | ci | github-asset
  source_ref    TEXT,                      -- the URL, "<path>@<commit>", or the GitHub asset id
  source_etag   TEXT,                      -- the validator last seen at the source (If-None-Match on re-sync)
  sha256        TEXT,                      -- of the stored original; null while pending or failed
  size          INTEGER,
  content_type  TEXT,                      -- sniffed, never the declared type
  width         INTEGER, height INTEGER,   -- images only (Images .info, free)
  variants_json TEXT,                      -- [{w, format: "image/webp", sha256, size}] (HA-03)
  status        TEXT NOT NULL,             -- pending | ready | failed | stale (source gone, last good copy kept)
  error         TEXT,                      -- the guard or ingest reason code
  checked_at    INTEGER, modified_at INTEGER NOT NULL,
  PRIMARY KEY (product, slot, locale)
);
```

- The bytes live at `blobs/sha256/<sha256>`, the same content-addressed store P2-01 uses.
- `variants_json` is `[{w, format: "image/webp", sha256, size}]`. `format` is a MIME type, as
  `content_type` is, and `"image/webp"` is its only value. HA-03 is the only writer; the image
  host (HA-02) reads it with the same parser.
- A `blob_refs` row with `ref_kind = 'hosted-asset'` holds each original and each variant. Its
  `ref_id` is `<slot>@<locale>`.
- A replaced or removed slot drops its refs in the same batch. The P4-14 collector reclaims the
  object after the age lock and `BLOB_GC_GRACE_DAYS`.
- When a source disappears, the row keeps its last good `sha256` with `status = 'stale'`.
- `dist_listing_assets` stays the store-facing model (A-18b). HA-07 writes `source = 'manifest'`
  rows into it from the matching hosted assets, so the A-18d and A-18e pushers can use
  manifest-declared art. That is a new `source` value, which needs a migration CHECK change.

### 6.3 Ingest: one path, three ways in

`core/hostedAssets.ts` (HA-01) exposes `ingest(product, slot, input)`. The input is either a
`ReadableStream` with a declared size, or a `Pull` request. Every route converges on these
steps:

1. **Guard the source (Pull only).** `core/safeFetch.ts` checks, in this order:
   - https only; port 443; no userinfo; at most 2048 chars;
   - no IP literal (Workers cannot dial one anyway [V]);
   - no single-label host;
   - **deny `plrs.im` and every `*.plrs.im`**: without `global_fetch_strictly_public`, a fetch
     to our own custom domain routes to "origin" and 522s or bypasses the front door [V];
   - deny `.local`, `.internal`, `.localhost` and `.home.arpa`.

   Then:
   - `redirect: "manual"`, at most 3 hops, each re-guarded;
   - a 30 s timeout;
   - a byte cap checked against `Content-Length` first and then while streaming;
   - `If-None-Match` with `source_etag` on re-sync, where a 304 means no work.

   **Private ranges.** The Worker resolves nothing itself. Cloudflare's edge does not route
   subrequests to RFC 1918 or loopback addresses, and refuses Cloudflare-owned IPs (error 1024)
   [V]. So the remaining SSRF surface is "public hosts the operator named". That surface is
   bounded by who can name them: manifest authors and console operators of that product, never
   end users.

   [`prototype/hosted-assets/pull.mjs`](../prototype/hosted-assets/pull.mjs) is the
   reference, and its self-test table becomes HA-01's unit test.

2. **Cap per slot.** These are code constants (security bounds, S-18 §5.6):

   | Slot                   | Cap                                  |
   | ---------------------- | ------------------------------------ |
   | icon                   | 10 MiB                               |
   | header and screenshots | 20 MiB                               |
   | notes images           | 5 MiB                                |
   | video (HA-17)          | 512 MiB                              |
   | release files          | 4.995 GiB, R2's single-put limit [V] |

3. **Sniff.** The type comes from the magic number:
   - images: PNG, JPEG, WebP, GIF, AVIF; **never SVG, never HTML**;
   - video (HA-17): MP4;
   - release files: any type. They keep the descriptor's `contentType` and are served as
     `attachment` on dl.
4. **Hash.** The stream is hashed with `crypto.DigestStream` while it is put, and the hash is
   compared to the expected value when one exists. The expected value is:
   - the manifest's optional `sha256`;
   - GitHub's `digest`;
   - the descriptor's `sha256`;
   - the CI ticket's hash.
5. **Put.** `putVerified` writes to `blobs/sha256/<hex>` and now sets
   `httpMetadata.contentType`, which fixes §4.6 #1. If the object already exists, the
   content-addressed key means the bytes are deduplicated and only the ref is added.
6. **Describe.** For images, the Images binding's `.info()` gives the dimensions. It is free
   [V].
7. **Vary.** For images, HA-03 builds the variant ladder (§6.6).
8. **Ref.** The `blob_refs` rows and the `hosted_assets` row are written in one D1 batch, then
   audited.

**Ways in:**

| Way                                   | Trigger                                                                                                                                                       | Runs where                                                                                                                                                                                                                         | Package |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Pull a URL**                        | Manifest register or resync, when a declared asset ref changed; console "Refresh"; a nightly re-check of `stale` and `failed` rows (existing cron, one batch) | A Queue `pkey-assets-<env>`, consumed by the main script. The deltas Worker precedent kept CPU-heavy work in a separate script. Pulls are I/O-bound, so they need no separate script.                                              | HA-05   |
| **Pull a repo path**                  | Same, for a ref like `./art/icon.png` or `art/icon.png`, resolved **at the commit being synced**                                                              | Fetched with the GitHub App installation token the resync already holds (`GET /repos/{o}/{r}/contents/{path}?ref=<sha>`, raw media type). This works for **private repos**, which removes DJDL's djdl-assets workaround.           | HA-05   |
| **Mirror a release file**             | Release webhook, sync, or descriptor ingest with a `github` or `external` location                                                                            | The same queue. GitHub assets are fetched with the installation token and `Accept: application/octet-stream`, then verified against `digest` and the descriptor's `sha256`. An `r2` location is then appended to `locations_json`. | HA-08   |
| **Upload in the console**             | Operator on the product's Presentation page or a Storefront slot                                                                                              | `POST /admin/products/:p/assets/:slot`, a streaming body (Workers accept 100 MB on the Free and Pro plans [V], well over every image cap), with a short-lived staging key, verify and promote                                      | HA-06   |
| **Push from CI** (`pkey`, the Action) | `pkey assets push <file> --slot <slot>`; the publish Action's new `assets:` input (a glob-to-slot map); `pkey listing assets --upload` keeps working          | The existing upload ticket (`staging/<product>/<ticketId>/<hex>`, P2-02), then `POST /<p>/assets` with CI scope `assets:write` (new vocabulary entry)                                                                              | HA-06   |

**Precedence when a slot has several sources** (S-18 model C):

1. A console upload claims the slot, and Revert drops the claim.
2. Otherwise the manifest.
3. Otherwise a CI push.

CI never overwrites a console claim, the same rule as `dist_listing_assets.source = admin`
today.

### 6.4 Re-sync semantics

- **Unchanged ref.** When a resync sees the same asset ref string, nothing is enqueued, unless
  the row is `failed` or `stale` and its back-off has elapsed.
- **Changed ref.** A changed ref string, or a repo path whose blob SHA at the new commit differs,
  enqueues a pull. The slot keeps serving the old copy until the new one is `ready`, then swaps
  atomically.
- **Failed pull.**
  - The old copy keeps serving, if there is one.
  - `status` becomes `failed` with a reason code.
  - The console shows the failure on the product's Presentation page. Validation surfaces it as
    a warning, `asset_unreachable`, never an error, so a temporarily unavailable CDN never
    blocks a register.
- **Removed slot.** The ref is dropped and the GC collects later. Content-addressed URLs already
  in caches and unsigned feeds therefore keep working through the age lock (≥ 180 days).

### 6.5 Hosts: why a separate `img.plrs.im`

| Option                                       | Pros                                                                                                                                                                                                                                                                                                                            | Cons                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key.plrs.im/media/...` (today's proxy path) | Same origin, so no CSP change                                                                                                                                                                                                                                                                                                   | Tenant bytes on the origin that holds the console, the portal SPA and the `__Host-` cookies (THREAT-MODEL §3, P2-01's whole reason for a bytes host). Every image request carries cookies. Not usable from email or third parties without exposing the console host. |
| `dl.plrs.im/<p>/media/...`                   | Exists. Cookie-less (host-only cookies). Already hardened.                                                                                                                                                                                                                                                                      | Its policy is _downloads_: forced `attachment`, licensed tickets and per-deliverable access modes. Adding inline public images either weakens that policy or forks it per route. Putting dl in `img-src` would also allow every byte route as an image source.       |
| **`img.plrs.im` (chosen)**                   | One policy for one kind of byte: public, immutable, inline image types only, `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, no cookies, a sandbox CSP. CSP `img-src` names exactly this host. CDN cache rules can be aggressive. A separate rate limit. Never gated, so it needs no auth code. | A fourth custom domain in three environments. The Worker creates the DNS records on deploy, so there are no new buckets and no new Worker.                                                                                                                           |

**Image host routes** (HA-02, `core/imgHost.ts`, confined like `bytesHost.ts`):

- **`GET /<p>/a/<sha256>` and `GET /<p>/a/<sha256>/<w>.webp`.** These are content-addressed and
  immutable (`Cache-Control: public, max-age=31536000, immutable`). They are served only when
  `<p>` holds a `hosted-asset` ref to that hash. This is the same per-product tenancy check
  `blobResponse` already enforces.
- **`GET /<p>/icon`, `/<p>/header` and `/<p>/screenshots/<n>`.** These are stable aliases that
  302 to the current content-addressed URL, cached for 300 s. They are for consumers that cannot
  be re-rendered when the asset changes: emails already sent, third-party AltStore mirrors, and
  SDKs without discovery.
- **Response headers:** `nosniff`, `Content-Type` from the sniffed type, and
  `Content-Security-Policy: default-src 'none'; sandbox`.
- **Refused:** anything that is not an image or video, any `gated/` key, and any non-hosted ref.

### 6.6 Image processing (HA-03)

- **Ladder.** At ingest, the Images binding (`env.IMAGES.input(stream).transform({ width })
.output({ format: "image/webp" })`) [V] generates a fixed ladder:

  | Slot        | Widths (px)             |
  | ----------- | ----------------------- |
  | icon        | 64, 128, 256, 512, 1024 |
  | header      | 640, 1280, 1920         |
  | screenshots | 480, 960, 1920          |

  The ladder never upscales. Each variant is stored content-addressed and listed in
  `variants_json`. The original is always kept and served at `/a/<sha256>`, for stores that
  need exact pixels.

- **Billing.** Binding calls are billed per _unique_ transformation per calendar month, with
  5,000 a month free on the Free plan [V]. Generating at ingest means one charge per asset per
  width, once. A product with an icon, a header and 10 screenshots costs at most 5 + 3 + 30 = 38
  transformations at each change. The same bytes in two slots of one family (the listing icon
  falling back to `presentation.icon`) share one ladder within the product (2026-10-06 follow-up).
- **Why not on the fly.** Transforming on the fly through `/cdn-cgi/image` would multiply the
  unique transformations by every requested size, and would put Images on the request path.
- **Fallback.** Without the binding (the test environment, or the account's free allowance used
  up, which returns error 9422 [V]), `variants_json` stays empty and every consumer uses the
  original. HA-03's tests run without the binding and with a stub. While the binding is bound,
  HA-05 retries an empty ladder from the stored original with the pulls' back-off (2026-10-06
  follow-up); it never pulls the source again.
- **Store-exact art.** The CLI's sharp-based derivation (A-18d) stays the tool for store-exact
  art (store sizes, composition, crop proposals). The Worker ladder is for display only.

### 6.7 Licensed versus public bytes

- **Presentation media and listing art** are always public. HA-07 removes these ref kinds from
  the app-side `blobs` route (§4.6 #2), so they are served only from the image host.
- **Release files** keep their deliverable's `dist_access` mode:
  - public: anyone, on dl;
  - `authenticated`, `licensed`, `entitled`:
    - devices use their Bearer on the console-host aliases (unchanged; see §4.6 #3);
    - the portal uses PX-W3's `?ticket=` on dl.
- **HA-09.** It changes the portal's `downloadTarget` order. A mirrored R2 copy plus a ticket
  wins over GitHub's `browser_download_url`. This fixes the private-repo 404 in §4.3 R3 for every
  product whose files are mirrored. Until PX-W3 merges, HA-09 waits, and nothing regresses.
- **No new signing.** The ticket is PX-W3's (`pkey-download-ticket/1`). It is not reused for
  media.

### 6.8 Migration and no-break guarantees

**Release files.**

- **Backfill.** HA-08 adds a backfill. An operator action, and a one-shot cron batch on first
  deploy, enqueue every `release_artifacts` row that has a GitHub or external location and no
  `r2` location.
- **DJDL.** The backfill moves 72 files, 2.67 GiB [M].
- **What deployed clients see.**
  - Signed feeds and records are untouched, because they hold hashes.
  - Byte URLs on dl and the console aliases do not change, only the bytes behind them, which
    are hash-identical.
  - `edSignature` stays valid.
  - Velopack's relative `FileName` is unaffected.
- **The `/release/dl/...` aliases.** The legacy console alias and the legacy
  `/dl/<selector>/<binary>-<arch>` path prefer the R2 copy whenever the GitHub asset's
  `digest` matches one.

**Presentation.**

- **Pull on first resync.** On the first resync after HA-05 deploys, the existing
  `iconUrl`/`headerUrl`/`screenshots` values, DJDL's included, are pulled automatically.
  **DJDL needs no change.**
- **Optional DJDL simplification.** DJDL can later move its art into its private repo (for
  example `icon: .pkey/art/icon.png`) and retire `djdl-assets` and the publish script.
- **The `/media/<p>/{icon,header}` portal route** stays during the deprecation window and
  302s to the image host's stable alias. The SPA switches to the media URLs from
  `presentationFor` (HA-07).
- **AltStore and SideStore sources** emit image-host URLs on their next render. Third-party
  copies of an old source keep the developer's URL, which works as long as the developer keeps
  it.

**Polaris Key itself.**

- It has no GitHub releases [M], so there is nothing to mirror.
- The system product (`admin/systemProduct.ts`) has no manifest. HA-15 gives it a
  `presentation.icon` from `@polaris-key/brand`'s key mark, uploaded through the same ingest
  path, so it is data and not code (rule 5).

**Rollback.** The kill switch is the platform setting `assets.hosting.enabled` (HA-10), which
does the following when turned off:

- every consumer falls back to today's behaviour: proxy, hotlink and GitHub streaming;
- stored copies stay;
- `r2` locations stay valid because they are hash-pinned.

### 6.9 SDKs and UI kits: icon and accent with zero integrator work

**The member.** Discovery (`/<p>/.well-known/polaris.json`, unsigned) gains:

```json
"core": {
  "presentation": {
    "name": "DJDL",
    "developerName": "…",
    "accent": "#2ED6E6",
    "accentDark": "#…",
    "icon": {
      "sha256": "1e7d…",
      "sizes": [64, 128, 256, 512],
      "url": "https://img.plrs.im/djdl/a/1e7d…/{w}.webp",
      "original": "https://img.plrs.im/djdl/a/1e7d…"
    }
  }
}
```

**Why plan mode.** Discovery members are part of the contract surface the PX-W3 plan lists, and
the transcripts record discovery. The member is additive and optional:

- older SDKs ignore it;
- an SDK that reads it must tolerate its absence.

HA-11 writes the plan; HA-12 implements it in the Worker and the transcripts. The plan must name
the following:

- **`WIRE-CONTRACT-V4.md`.** Add discovery text. `PROTOCOL_VERSION` stays 4 (additive, no
  verification semantics).
- **`shared-protocol`.** Add the discovery type.
- **Transcripts.** `pnpm gen:transcripts`, with the mirrors in Swift and Godot.
- **Corpus.** No signed-document case, so `gen:corpus --check` stays green. Optionally a
  `presentation` parse case.
- **SDKs, in this order:**
  1. client-core and React;
  2. Node;
  3. Python;
  4. Swift;
  5. Kotlin;
  6. Godot.
- **UI kits.** React `PolarisLogin`/`screenLogo`, Swift `PolarisTheme`, Kotlin `PolarisTheme`
  and Godot `pkey_ui_theme`. Each defaults its logo to the icon and its accent to `accent` /
  `accentDark` when the integrator passes nothing. An integrator override always wins.
- **Caching.** The icon is fetched once and cached by `sha256`, then verified against it. A
  failure falls back to today's letter tile, never an error.

### 6.10 Quotas and settings (S-18 registry, HA-10)

| Key                         | Scope                                 | Type / default                    | Notes                                                                                                                                                                           |
| --------------------------- | ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets.hosting.enabled`    | platform                              | switch, default **on**, `runtime` | Kill switch (§6.8). Not a security gate, because turning it off only reverts to today's behaviour, so the deny-list test allows it.                                             |
| `assets.releases.mirror`    | product (operator-owned)              | switch, default **on**            | Off keeps GitHub-only serving for that product. It is not in the manifest, because the manifest author does not pay for storage.                                                |
| `assets.quota.mediaBytes`   | product (operator), inherits platform | integer, 512 MiB                  | Counted over distinct `hosted-asset` originals and variants that are not release files. An ingest over quota fails with `asset_quota_exceeded`, and the old copy keeps serving. |
| `assets.quota.releaseBytes` | product (operator), inherits platform | integer, 100 GiB                  | Counted over mirrored release files. Over quota, mirroring stops (GitHub keeps serving) and the console warns.                                                                  |

Per-file caps, the ladder, the guard lists and timeouts are code constants. They are security
bounds or vendor limits, and S-18 §5.6 keeps those out of settings.

### 6.11 Retention and deletion

- **Sources.** Polaris Key never deletes, renames or writes to a developer's repo, release,
  bucket or URL. It only reads.
- **Copies.** Our copies are deleted only by the existing collector, when no ref holds them,
  after the 180-day age lock and `BLOB_GC_GRACE_DAYS`.
- **Product deletion.** Deleting a product drops its refs, which follows the normal GC path.
- **Ask the developer.** The console shows "Polaris Key hosts a copy; your original is
  unchanged" on each slot.

### 6.12 Threat-model deltas (HA-15 writes them)

| Delta                 | What it adds                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New outbound fetcher  | Guard §6.3; named only by product operators and manifest authors; never on end-user input; audit row per pull.                                                                                                                                                           |
| New host              | `img*` (img.plrs.im), with the isolation in §6.5.                                                                                                                                                                                                                        |
| Content risk          | **Content risk.** No SVG or HTML is accepted, every type is sniffed, CSP is sandboxed, and `nosniff` is set. An operator can host illegal or abusive images. The existing operator terms apply, and HA-06 includes delete-a-copy so an operator can drop a slot at once. |
| Amplification         | Pulls are queued, deduplicated by ref, and run at most once per resync per slot.                                                                                                                                                                                         |
| Listing-asset serving | §4.6 #2 fixed.                                                                                                                                                                                                                                                           |

## 7. Wire and plan-mode impact

| Change                                                                         | Plan mode?                       | Corpus / SDK impact                                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Mirroring release files, extra `r2` locations                                  | **no**                           | none. The signed docs carry hashes (§4.3 R6); `locations` are excluded from records by design.                       |
| Image host, `hosted_assets`, ingest, console, CLI                              | no                               | none. Rule 10 (new routes), rule 3 (Action bundle), THREAT-MODEL.                                                    |
| Manifest `presentation`, listing `icon`/`header`/`screenshots` with repo paths | no (manifest, not wire)          | rule 9 (validator, schemas, mutation table), generated docs reference, Action rebundle.                              |
| Discovery `core.presentation`                                                  | **yes** (HA-11 → HA-12 to HA-14) | transcripts plus mirrors; the contract text; every SDK's discovery type; UI kits. `PROTOCOL_VERSION` stays 4.        |
| Release-note images                                                            | no                               | the signed `notes` text is **never rewritten**. Rendering surfaces map URLs to hosted copies at render time (HA-16). |

## 8. Interactions with other plans

- **P2-01 / P4-14.** These provide the storage and GC. HA adds a ref kind and Content-Type
  metadata.
- **A-18.**
  - HA-07 feeds hosted manifest art into `dist_listing_assets` (`source='manifest'`).
  - HA-06 provides the missing `admin` writer.
  - HA-02 gives A-18i (Flathub) its public screenshot URLs.
  - A-18j's slot board should render image-host URLs and use HA-06's upload. That is a note for
    its brief, below.
- **PX-W3.** HA-09 consumes the ticket; nothing in PX-W3 changes.
- **PX-W1 / PX-W10 / PX-W16.** The media proxy becomes R2-backed (HA-07). Discover tiles get real
  icons. Avatars (PX-W16) should reuse `core/hostedAssets.ts` with an `avatar` slot space, which
  is noted for its brief.
- **S-18.** HA-10 registers four entries once ST-03 lands.
- **S-19.** No interaction beyond PX-W3.
- **I-18 (email).** It may add the product icon from the image host's stable alias. This is
  optional, and not an HA package.

## 9. Work packages (`HA-`)

| ID    | Title (short)                                                                                  | Deps                | Role                | Plan mode | Est. (wk) |
| ----- | ---------------------------------------------------------------------------------------------- | ------------------- | ------------------- | --------- | --------- |
| HA-01 | Hosted-asset core: `hosted_assets`, `safeFetch`, ingest, Content-Type on puts                  | none                | pkey-implementer    | no        | 1–1.5     |
| HA-02 | Image host `img.plrs.im` (`img-staging`, `img-dev`)                                            | HA-01               | pkey-implementer    | no        | 0.6–1     |
| HA-03 | Image variant ladder via the Images binding                                                    | HA-01               | pkey-implementer    | no        | 0.5–0.8   |
| HA-04 | Manifest: `presentation`, listing `icon`/`header`/`screenshots` (URL or repo path)             | none                | pkey-implementer    | no        | 0.6–0.9   |
| HA-05 | Pull on register and resync (queue, URL and repo paths, re-sync, nightly re-check)             | HA-01, HA-04        | pkey-implementer    | no        | 1–1.5     |
| HA-06 | Console upload, `pkey assets push`, Action `assets:`, Presentation page                        | HA-02, HA-05        | pkey-implementer    | no        | 1–1.5     |
| HA-07 | Serve hosted copies everywhere (portal, feeds, download page, listing model, THREAT-MODEL fix) | HA-02, HA-03, HA-05 | pkey-implementer    | no        | 1–1.5     |
| HA-08 | Release-file mirroring and backfill                                                            | HA-01, HA-05        | pkey-implementer    | no        | 1–1.5     |
| HA-09 | Portal licensed downloads prefer mirrored copies (ticket)                                      | HA-08, PX-W3        | pkey-implementer    | no        | 0.2–0.4   |
| HA-10 | Hosting settings and quotas in the registry                                                    | ST-03, HA-05, HA-08 | pkey-implementer    | no        | 0.4–0.6   |
| HA-11 | Plan: `core.presentation` in discovery                                                         | HA-04               | pkey-wire-planner   | yes       | 0.3–0.5   |
| HA-12 | Discovery presentation in the Worker, contract text, transcripts                               | HA-11, HA-02, HA-07 | pkey-implementer    | yes       | 0.4–0.6   |
| HA-13 | SDKs and UI kits read presentation (client-core, React, Node, Python, Swift, Kotlin)           | HA-12               | pkey-sdk-porter     | yes       | 1–1.5     |
| HA-14 | Godot SDK and UI kit read presentation                                                         | HA-12               | pkey-godot-engineer | yes       | 0.5–0.8   |
| HA-15 | Migration, docs, glossary, THREAT-MODEL close-out                                              | HA-07, HA-08, HA-10 | pkey-implementer    | no        | 0.4–0.6   |
| HA-16 | _Optional:_ release-note images hosted and rendered                                            | HA-05, HA-07        | pkey-implementer    | no        | 0.4–0.6   |
| HA-17 | _Optional:_ store video and trailer slots                                                      | HA-06               | pkey-implementer    | no        | 0.5–0.8   |

- **Ready now:** HA-01 and HA-04. They have no dependencies, and P2-01, the substrate, is done.
- **Next:** HA-11 is ready once HA-04 is done. HA-02, HA-03 and HA-08 are ready once HA-01 is
  done.
- **The critical path** to "no developer hosts anything" is HA-01 → HA-05 → HA-07, plus HA-08.
  That is about 4–6 engineer-weeks.

## 10. Risks and owner questions

### 10.1 Risks

- **Abuse.** Polaris Key now stores whatever an operator points it at. This is mitigated by
  quotas, type sniffing, per-slot caps, audit rows, the operator terms and delete-a-copy.
- **Pull throughput from the edge is not measured.** It is mitigated by the queue, retries,
  back-off and keeping the GitHub location as a fallback.
- **Images free tier.** A busy month could exceed 5,000 unique transformations. If so, new
  variants fail with 9422 [V] and consumers fall back to the original. Nothing breaks.
- **Defect #3 (§4.6).** It limits what mirroring buys SDK clients of licensed deliverables. It is
  not caused by HA.

### 10.2 Owner questions: all decided (delegated to Claude, 2026-10-05)

Each question shows the recommendation (adopted) in bold and the alternative considered.

1. **Q1. Scope.** **All hosted assets, release files included (D1).** The alternative,
   presentation only, was rejected: the owner's message names GitHub explicitly.
2. **Q2. Host for presentation media.** **A separate `img.plrs.im` (D2).** The alternatives,
   `dl.plrs.im` or a same-origin key path, are compared in §6.5.
3. **Q3. Pull policy.** **Any public https host behind the guard (D3).** The alternative is an
   operator-maintained allowlist. It was rejected because "just pull the files" means
   arbitrary CDNs, and the remaining risk is bounded by who can name a URL.
4. **Q4. Image processing.** **Pre-generated ladder with the Images binding (D4).** The
   alternatives were on-the-fly `/cdn-cgi/image` and CLI-only sharp. On the fly costs more
   unique transformations and sits on the request path. CLI-only does not cover pulled or
   uploaded images.
5. **Q5. Manifest home.** **`.pkey/product` `presentation` for the icon and accent. Listing art
   stays in `.pkey/distribution` (D5).** A product without the distribution service still has an
   icon.
6. **Q6. Mirror by default?** **Yes, for all products including existing ones (D6).** It cannot
   break clients (hash-pinned) and removes a runtime dependency on GitHub.
7. **Q7. Where the mirror switch lives.** **An operator product setting, not in the manifest
   (D6).**
8. **Q8. Licensed files.** **PX-W3's ticket. Media are never gated (D7).**
9. **Q9. Retention.** **Never touch sources. Copies follow the existing GC (D8).**
10. **Q10. Quota defaults.** **512 MiB media and 100 GiB releases per product (D9).** At R2's
    price, 100 GiB costs about $1.50 a month.
11. **Q11. Presentation in discovery (plan mode).** **Yes (D10).** The alternative was asking
    integrators to pass the logo, which is today's behaviour and the thing the owner wants
    gone.
12. **Q12. Console uploads and manifest values.** **The console claims the slot, and Revert
    returns it to the manifest (D11).**
13. **Q13. Defects #1 and #2.** **Fix them inside HA-01 and HA-07 (D12).**
14. **Q14. Defect #3** (no SDK Bearer on dl). **Out of HA's scope. The lead should open a
    follow-up with the P2b and P3 owners.** The recommended direction is that discovery
    advertises console-host templates for non-public deliverables. It is recorded here so it
    is not lost.

## 11. Brief changes

- **New:** `P/wp/HA-01…HA-17` briefs. They are registered in `workpackages.json` under the new
  `HA` phase, and the `check.mjs` and schema id patterns now accept `HA-`.
- **A-18i** (Flathub screenshots need public URLs). Add a hand-off note: the URLs come from
  HA-02's image host, via HA-07's `source='manifest'` rows or HA-06 uploads. **Edited in this
  branch.**
- **A-18j** (console storefronts). Its slot board uses HA-06's upload route and renders
  image-host URLs. **Edited in this branch.**
- **PX-W16** (avatars). Reuse `core/hostedAssets.ts` (`avatar` slot space) rather than a second
  fetcher. **Edited in this branch.**
- **PX-W3.** No change. HA-09 depends on it.
- **Proposed for the report** (not edited here): README §11 gains a decision row for "Polaris
  Key hosts every asset it serves; sources are inputs, not requirements" (S-20 D1).

## 12. Sources

- **Code** [V]: the files cited inline, at `6967347a`. The PX-W3 plan is at `plan/PX-W3`
  `48f5a893`.
- **Cloudflare, read 2026-10-05** [V]:
  - Images binding: developers.cloudflare.com/images/optimization/binding/
  - Images pricing: developers.cloudflare.com/images/pricing/ (5,000 unique transformations a
    month on Free; $0.50 per 1,000 on Paid)
  - Images binding unique-transformation billing:
    developers.cloudflare.com/changelog/post/2026-07-01-binding-unique-transformations/
  - Workers limits: developers.cloudflare.com/workers/platform/limits/ (request body 100 MB on
    Free and Pro; no response-body limit)
  - Workers compatibility flags, `global_fetch_strictly_public`:
    developers.cloudflare.com/workers/configuration/compatibility-flags/
  - Workers known issues, fetch to IP addresses:
    developers.cloudflare.com/workers/platform/known-issues/
  - Workers errors 1024 and 1042: developers.cloudflare.com/workers/observability/errors/
  - R2 upload limits: developers.cloudflare.com/r2/objects/upload-objects/ and
    developers.cloudflare.com/r2/platform/limits/ (single put 4.995 GiB; multipart parts 5 MiB to
    5 GiB, at most 10,000)
- **GitHub REST API** [M]: the releases list (asset `digest`, `immutable`), contents, and the
  release asset download with `Accept: application/octet-stream`. These are the operator's own
  repos.
- **Measurement scratch** (TSV of DJDL releases, downloaded images): kept in the session's
  scratch directory, not committed. §5 reproduces every number.
