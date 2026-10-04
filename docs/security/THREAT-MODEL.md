# Polaris Key — Threat Model

> Status: **v1**, written 2026-08-25 as part of the full security audit.
> This is the document the codebase was missing. When code and this document disagree, that is
> a finding — open a PR to reconcile one or the other.

## 1. What this system is

Polaris Key is simultaneously three things behind one integration:

1. a **licensing system** — issues license keys, mints per-device bearer tokens, enforces seats,
   tiers, expiry and version/channel windows;
2. a **remote-configuration system** — signs and delivers managed config, entitlements, and
   secrets to running clients;
3. a **release-distribution channel** — serves Sparkle appcasts, `install.sh`, DMGs and CLI
   binaries to end-user machines.

That coupling is the single most important fact in this document. It is a real product strength
(one SDK, one integration, one control plane) and a real security liability: **a compromise of the
control plane reaches all three at once.** An attacker who takes the admin plane does not merely
issue themselves a free license — they can rewrite what every installed client is configured to do
and what binary it installs next.

## 2. Assets, ranked by what their loss costs

| #    | Asset                                                                                | Where it lives                                                                                        | Loss impact                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1   | **`PLATFORM_KEK`**                                                                   | Worker secret                                                                                         | Decrypts every tenant's signing key and every product secret. Total platform compromise. Cannot be rotated today (see A9).                                                                                                                                                                                               |
| A2   | **Per-product Ed25519 signing keys**                                                 | `product_keys.enc_private_json`, sealed under A1                                                      | Forge any config doc, entitlement, or secret for that product. **Unrevocable for already-provisioned clients** — see §6.                                                                                                                                                                                                 |
| A3   | **The release channel**                                                              | GitHub App key, webhook secret, `release_config`                                                      | Ship arbitrary code to every installed client. Equal to A1 in practical severity.                                                                                                                                                                                                                                        |
| A4   | **`ADMIN_SESSION_SECRET`**                                                           | Worker secret                                                                                         | Forge admin sessions → reach A2, A3, A5, A6 through the API.                                                                                                                                                                                                                                                             |
| A5   | **Product secrets** (OIDC client secrets, edge-mint signing keys)                    | `product_secrets`, sealed under A1                                                                    | Impersonate the product to its IdP; mint third-party tokens (e.g. Apple MusicKit) at the operator's cost.                                                                                                                                                                                                                |
| A6   | **Customer PII**                                                                     | `licenses`, `portal_accounts` (+ emails, identities), `audit` — plaintext                             | Email, name, OIDC subject, device user-agents, hardware-derived digests. Regulatory and reputational.                                                                                                                                                                                                                    |
| A7   | **Licensing revenue**                                                                | The whole enforcement path                                                                            | The thing the system nominally exists to protect. Deliberately ranked _below_ A1–A5.                                                                                                                                                                                                                                     |
| A8   | **Service availability**                                                             | Worker, D1, KV, DO                                                                                    | A licensing outage can block paying customers from software they already bought.                                                                                                                                                                                                                                         |
| A9   | **The ability to recover**                                                           | Rotation and revocation machinery                                                                     | Not an asset in the usual sense, but its absence converts any A1/A2 loss from an incident into a permanent condition.                                                                                                                                                                                                    |
| A10  | **The blob store** (release bytes)                                                   | R2 bucket `polaris-key-blobs-<env>` (`BLOBS`) + `blob_objects`/`blob_refs` in D1                      | Serve a wrong object under a trusted hash name to every client that downloads it, or lock one in place for 180 days. Equal to A3 in reach.                                                                                                                                                                               |
| A11  | **Outlet credentials** (store API keys)                                              | `outlet_credentials`, sealed under A1 (own AAD kind); minted tokens sealed in KV                      | Act as the operator in App Store Connect, Google Play or Partner Center: upload or release builds, change listings and prices. Equal to A3.                                                                                                                                                                              |
| A11b | **The platform team App Store Connect key** (A-16's `app-store.api-key`, Admin role) | `platform_credentials` sealed under A1 (AAD `_platform`), or the `PLATFORM_ASC_API_KEY` Worker secret | Everything A11 lists for **every** app of the team, plus team membership (invite an Admin: a takeover that outlives revoking the key), signing identity (create or revoke certificates), deleting identifiers and changing prices. **Above A3.** Only the write gate (A-17a) stands between the Worker and those powers. |
| A12  | **CI credentials** (`pkeyci_` tokens, upload tickets)                                | `ci_tokens`/`ci_upload_tickets` (peppered hashes only); held by CI jobs                               | Publish, promote (and, if granted, yank) releases of one product for up to 30 min (minted) or 90 days (static). A route into A3/A10.                                                                                                                                                                                     |
| A13  | **The R2 parent token** and the temporary credentials it mints                       | Worker secrets `R2_PARENT_*`; temp credentials held by CI for ≤ 1 h                                   | The parent can write the whole bucket, locked prefixes included (subject to the age lock). A temp credential: one staging prefix.                                                                                                                                                                                        |
| A14  | **Delegated content keys** (P4-19)                                                   | CI: a GitHub Environment secret (`PKEY_CONTENT_KEY`) per content team                                 | Publish data-only pack releases in one scope (pack-id prefix and types) until the window closes or a CI revocation of the delegation lands.                                                                                                                                                                              |

**A5 is scoped by usage.** Every product secret carries a usage — general (stored `NULL`) or
`edge-mint` — and `openProductSecret` opens a secret only for the usage its caller requires: the
edge-mint route asks for `edge-mint`, the OIDC client-secret path for general, and a mismatch
reads as a missing secret (the value is never unsealed). The usage is written **only** by the admin
API (`PUT …/secrets/<name>` with `"usage"`), audited as `secret.usage`, and never by a `.pkey/`
manifest. The usage is not yet bound into the AEAD associated data; that is stronger but needs
every secret re-sealed. P5-01 did not do it: it took the stronger step for the material that
needed it most, moving store credentials out of `product_secrets` altogether (A11, below), and
left binding the product-secret usage into the AAD as an open follow-up.

**A12 and A13 (P2-02).** A `pkeyci_` token is shown once and stored only as `hashKey` (HMAC under
`KEY_HASH_PEPPER`), like device tokens; tickets likewise. The R2 parent token is an
operator-created API token scoped to one environment's bucket with Object Read & Write; the Worker
uses its secret only to sign temporary credentials locally and never sends it anywhere. A temporary
credential can never exceed its parent, so the parent's bucket scope is the outer bound of every
credential CI holds; revoking the parent kills all of them at once. See "Trusted publishing
(P2-02)" in §3.

**A11 is separated from A5 by AAD, not only by table.** Outlet credentials are sealed under
`pkey:v2:<product>:outlet-credential:<id>`, so a blob copied into `product_secrets` (under any
name, with any usage) fails to open there, and the reverse fails too. See "Outlet credentials
(P5-01)" in §3.

## 3. Trust boundaries

```
                        ┌─────────────────────────────────────────┐
   UNTRUSTED            │              TRUSTED                     │
                        │                                          │
 end-user device ──────►│  Cloudflare Worker (key.plrs.im)          │
  (SDK, fully           │    ├── D1  (relational, authoritative)    │
   attacker-controlled) │    ├── KV  (hot-path hints only)          │
                        │    ├── DO  (atomic rate limiting)         │
 browser (admin/portal)►│    ├── ASSETS (SPA bundles)               │
                        │    └── R2  BLOBS (content-addressed bytes)│
 downloader ───────────►│  same Worker on dl.plrs.im (bytes host:   │
  (any client)          │    byte routes only — see below)          │
 CI (temp creds) ──────►│  R2 staging/<p>/<ticket>/ only (Put+Head) │
 CI (OIDC, pkeyci_) ───►│  /release/publish/*: see §3, §5           │
                        │                                          │
 GitHub (webhooks, ────►│  secrets: PLATFORM_KEK, session secrets,  │
  repo contents,        │           GitHub App key, webhook secret  │
  release assets)       │                                          │
                        └─────────────────────────────────────────┘
 IdP (OIDC claims) ────►│  semi-trusted: see §5
```

**The single load-bearing sentence, stated so a developer can act on it:**

> The server's decision to _send_ something is the only enforcement. Everything the client does
> with what it received is advisory.

Concretely: a bypassed client gate can fake "licensed" locally, but it cannot manufacture
`payload.secrets` or an edge-mint token, because those only exist if the server chose to emit them.
Any feature whose security depends on the client _refusing_ to do something is not secured.

### The blob store and the bytes host (P2-01)

**Asset A10.** Release bytes live in one R2 bucket per environment, content-addressed:
`blobs/sha256/<hex>`, `bundles/sha256/<hex>`, `deltas/<from>/<to>.<method>`, the same layout
under `gated/` for entitlement-gated content, and `staging/<product>/<ticketId>/<hex>` for CI
uploads. Its write paths, and nothing else:

1. **CI → `staging/` only**, with R2 temporary credentials scoped to that prefix (P2-02). CI can
   never write a locked prefix.
2. **The Worker's `BLOBS` binding → locked prefixes**, only through `core/blobs.ts`
   `putVerified`/`promote`. The operator's account token can also write, and is out of the
   Worker's control (as it is for D1).

**Invariants** (code: `packages/worker/src/core/blobs.ts`; tests: `test/blobs.test.ts`,
`test-workerd/blobs.test.ts`):

- **Verify before lock.** A wrong object stored under a hash name would be locked in place, so
  `promote` verifies the staged object first (R2's stored SHA-256, else a streamed re-hash via
  `crypto.DigestStream`), pins the copy to the exact object version it verified, and writes the
  target with R2's `sha256` put option so R2 itself refuses a mismatch. A key named by a hash
  must be named by the expected hash. Writes are create-only (`If-None-Match: *`); the bucket
  lock enforces the same at rest.
- **`blob_objects` is written only after verification**; `blob_refs.storage_key` is a foreign
  key into it, so a ref never names unverified bytes, and an object with a ref cannot be
  deleted from D1.
- **Every read goes through the Worker.** No R2 public domain and no `r2.dev`: only the Worker
  sets `ETag` to the SHA-256, adds `Repr-Digest` (RFC 9530), and checks that **this** product
  holds a ref to the key (`hasRef`) before serving it. A hash is never treated as a secret:
  gated content is authorised per request and served `private, no-store`. The build and file
  routes (Distribution's since P2b-04) serve the `app` deliverable only and refuse a location
  under `gated/` outright, whatever its delivery access; only the blob route reads a `gated/`
  key, and only for a pack, against the pack's current gate (P4-05, "Pack bytes" below). Its
  app side still re-checks the licence under `entitled` against every app release that carries
  the hash (§5; P2-05).
- **Clients verify against the signed manifest, not the headers.** `Repr-Digest` and the ETag
  help resumption; integrity rests on the hash in a signed document.
- **A product earns a `blob_ref` only by proving it had the bytes.** `blob_objects` is shared
  across products (content addressing deduplicates), so it records that _someone_ stored the
  bytes, never _who may serve them_; tenancy is `blob_refs`, and `hasRef` is only as strong as
  the way refs are granted. The rule for every caller of `recordRef` (P2-04, P4-02): a product
  gets a ref to a key only (a) by promoting a verified upload from its **own**
  `staging/<product>/…` prefix — a promote that finds the key `alreadyStored` still required
  the upload — or (b) when it already references that key. Never on the strength of
  `isStored`/`storedKeys`: a tenant (T3) could otherwise take the hash of another product's
  gated build, which that product's signed manifests publish to every customer, be told
  "present", skip the upload, get a ref, and serve the other product's paid bytes from its
  own byte route.
- **Descriptor ingest is the first `recordRef` caller (P2-04).** `ingestReleaseDescriptor`
  (`services/release/descriptor.ts`) writes an `artifact` ref for an `r2` location only when
  the key is in the caller's `promoted` set (P2-02's submit, after promoting from this
  product's staging prefix) or the product already references it, and only when
  `blob_objects` records it with the descriptor's hash and size; anything else is refused
  (`r2_ref_not_owned`, `r2_object_missing`) and nothing is written. A descriptor attached to a
  GitHub release (`pkey-release.json`) arrives with no `promoted` set, so it can name only keys
  the product already holds. Where GitHub holds the bytes, ingest requires an immutable release
  and GitHub's own digest to equal the descriptor's SHA-256, and `source_url` stays GitHub's
  `browser_download_url` (R6-12).
- **Deduplication answers are per product.** An upload ticket's `present` flag (P2-02, P4-03)
  comes from `referencedKeys(db, product, keys)` — the keys _this_ product already
  references — never from `blob_objects` alone, which would also tell a tenant which hashes
  other products hold. `isStored`/`storedKeys` stay internal bookkeeping (promote, GC).

**Lock duration and the GC trade-off.** `blobs/`, `bundles/`, `deltas/` and `gated/` carry an
**age** lock of **180 days**, not an indefinite one. An indefinite lock would make it impossible
for P4-14's collector ever to delete an unreferenced object, so storage would only grow; 180
days is longer than any build a channel can still point at plausibly needs for rollback. The
cost: an object older than 180 days is deletable by anyone holding account-level R2 write
access, so the lock bounds the window in which a compromised Worker or token cannot destroy
published bytes — it is not permanent immutability. `staging/` is unlocked with a 1-day expiry.

**Boundary: the bytes host.** The same Worker answers on `dl.plrs.im` (`dl-staging`, `dl-dev`),
named by `BLOB_ORIGIN`. A request on that host reaches only the byte-route allowlist
(`mount.ts` `BYTE_ROUTES`, dispatched by `core/bytesHost.ts`; the build, file and blob routes,
registered by Release in P2-05 and by Distribution since P2b-04, each matching its canonical
`/<p>/distribution/…` path and its `/<p>/release/…` alias);
`/manage`, `/docs`, the portal, discovery and every product route answer not-found there
(`test/bytesHost.test.ts`). The host does not go through `dispatchService`, so it makes that
function's enablement check itself: every byte route names its service, and one whose service
is disabled for the product never runs and answers the same not-found as an unknown product. The host
match is case-insensitive and ignores trailing dots: the edge routes the fully-qualified
`dl.plrs.im.` to the Worker with the dot kept in the URL, so an exact comparison would hand
that spelling the whole console. Every byte route is product-scoped; CORS on the host is the
same `core/cors.ts` step as the console's covered routes (the product's own `web.origins`,
preflight answered before the route runs, headers added after it returns, never
`Allow-Credentials`), and a route cannot set its own `Access-Control-*` headers: the dispatcher
drops them from every route answer, including for a product with no `web.origins` (for which
`withCors` adds nothing).

The dispatcher never lets a failure escape as the platform's own HTML error page: a throw from
a route, the product load or D1 answers a flat JSON 500 carrying the host's hardening headers
(P2-05). Byte routes get the product WITHOUT its signing key (`ProductPublic`), so a download
never unseals the key under `PLATFORM_KEK`. `blobResponse` derives the host it shapes a
response for from the request URL, never from its caller, so a console route cannot obtain the
bytes host's type and `inline` relaxation; and it refuses a locked-prefix object that has no
stored checksum, since everything `putVerified` writes carries one. The blob route serves a hash
only when `blob_refs` holds a ref from the requesting product, with the same not-found as an
unknown hash. `BLOB_ORIGIN` and the `dl*` route must be configured together: a test refuses a
`wrangler.toml` that deploys the route without the var or points the var at a console host.

**Cached GitHub signed URLs (P2-05).** To make a `Range` chunk cost no GitHub API call, the
signed storage URL GitHub returns for an asset is cached in KV under the product's own key
scope, sealed under `PLATFORM_KEK` like the installation token (R12-03), with a TTL shorter than
the URL's own expiry; its host is re-checked against `isAllowedStorageHost` on every use (R6-08),
and a refused URL is dropped. For a private repository that URL is a bearer credential for the
asset, so it is never sent to a client: the opt-in `?redirect=1` mode redirects only a public
artifact of a public repository, and only to GitHub's own `browser_download_url`.

**Channel policy writes (P2-05).** Promote, pin, unpin and yank change what every surface
serves, so who may make them is part of this boundary:

- **Principals.** A console admin session authorised for the product, through the console's
  session- and CSRF-guarded routes, can do all of them. CI can do them for one product with a `pkeyci_` token: promote,
  pin and unpin need `release:promote`, a yank needs `release:yank`. The token store is P2-02's
  (`core/publisher.ts`): a token minted from a repository's OIDC identity carries the policy's
  scopes, so anyone who can run that repository's declared release workflow in its declared
  environment on a protected ref holds `release:promote` by default, and this paragraph's
  consequences are theirs. `release:yank` is opt-in (an operator edits the policy's scopes). Every write is audited with its actor (`admin:<sub>`
  or `ci:<subject>`).
- **A pin bypasses the anti-rollback floor.** A pinned channel serves its pointer exactly, with
  no floor check (`gateway.ts` `resolveSelectorLive`), and the pointer may be a yanked release.
  A holder of `release:promote` alone can therefore roll a channel below its R6-10 floor, or put
  a yanked build back on it. That is the purpose of a pin (an audited, deliberate rollback), and
  why pin shares promote's scope rather than having a weaker one; it is not a bypass of
  yank's scope, because a yank never stops an explicit pin.
- **A yank lowers the floor, it does not remove it.** A floor whose release is yanked drops to
  the newest unyanked release the truth store holds below it, computed on every resolution
  (`yankedFloorFallback`), so yanking the newest release leaves the channel protected against
  the R6-10 deletion downgrade. `release:yank` cannot be used to strip a channel's floor.
- **External locations are a tenant-chosen redirect.** An artifact location of provider
  `external` makes the build and file routes answer a `302` to that `https://` URL, from
  `dl.plrs.im` and from the console host. The URL is whatever the release descriptor recorded
  in `locations_json`, so it is tenant-controlled in the way R6-12's portal redirect was: the
  platform's hostname vouches for a destination the tenant picked. Only `https:` is followed and
  the response carries no credentials, but the destination is not allowlisted. Today nothing
  writes `locations_json` (the descriptor is P2-04's); P2-04 owns deciding whether external
  URLs need a host allowlist before it does.

**Deviation, recorded: the bytes host is same-site with the console.** The design rule
(research README §3.5, decision 4) was a separate registrable domain, because a `*.plrs.im`
sibling is same-site with `key.plrs.im` and `SameSite` cookies then do not separate the two.
The owner chose `dl.plrs.im` anyway. What that exposes: if anything on `dl.plrs.im` could run
script, it could issue same-site requests to the console carrying `SameSite=Strict` cookies,
and could try to toss `Domain=plrs.im` cookies at it. The compensations, each test-pinned:

- every bytes-host response carries `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'`, so a body a
  browser decides to render gets an opaque origin and runs no script;
- nothing script-executable or renderable is ever served there, and the **dispatcher**
  enforces it for every route answer, whether or not the route used `blobResponse` (which
  applies the same allowlist): a non-error answer must carry a type on the explicit inert
  allowlist (`BYTES_HOST_TYPES`: APK, wasm, zip, archives, installers), and a body with no
  type is refused, so PDF, images, video, HTML, XHTML, SVG, XML, JavaScript, JSON and
  `text/*` all become not-found; an error answer may carry only the platform's JSON error type
  or an allowlisted type; and `Content-Disposition` is forced to `attachment` unless the type
  is allowlisted and the route asked for `inline`;
  the ONE exception is the public download page (P2b-06, below): a route registered as a
  `document` may answer `text/html; charset=utf-8`, and only under its own policy, which the
  dispatcher checks (`inertDocumentPolicy`) and refuses unless it is itself a `sandbox` without
  `allow-scripts` or `allow-same-origin` (so the page still runs no script and has an opaque
  origin) with `default-src 'none'` and nothing but hashed styles;
  the host's landing page is the second and last HTML answer: `GET /` (and `HEAD /`), exactly
  that path, on the bytes host only (`core/bytesLanding.ts`, BRAND §8). It is a static document:
  the Polaris Key Delivery lockup (the Star Cut service mark) as inline SVG, one sentence on what the host is, and links to the
  console and the docs. It is built from the brand package and two validated deployment variables
  (`CONSOLE_ORIGIN`, `BLOB_ORIGIN`), so no request input, product, release, file, token or key
  reaches it, and it reads no D1, KV or R2. The dispatcher admits it through the same check as a
  `document` route (`documentPolicy` → `inertDocumentPolicy`). Its policy is `sandbox` with no
  tokens, `default-src 'none'`, its one stylesheet by SHA-256, `img-src data:` for the inline
  favicon, and `frame-ancestors`, `base-uri` and `form-action` all `'none'`. It has no script,
  no font file and no external request, and the host's `nosniff`, `no-referrer` and cookie
  stripping apply to it as to every answer. Any other method on `/` and every other path
  (`/favicon.ico`, `/index.html` included) keeps the plain not-found, and the byte routes' type
  rule is unchanged, so no blob path can answer `text/html` (`test/bytesHost.test.ts`, and the
  workerd lane for `/`);
- no cookie is read or set on the host: `Cookie` is stripped before a byte route sees the
  request and `Set-Cookie` from every response;
- the console's session cookies are host-only: `__Host-pkey_admin` and `__Host-pkey_portal`
  (the prefix forbids `Domain` and so cannot be shadowed by a sibling), and the per-product
  identity cookie carries no `Domain` either; a test fails if any `Domain=` cookie attribute
  appears in the Worker source. The browser therefore never sends a console cookie to
  `dl.plrs.im`.

Residual risk: the compensations hold only while nothing else is hosted on `dl.plrs.im` or on
any other `plrs.im` sibling that serves attacker-influenced HTML. Hosted web builds (P6-04),
which need HTML and script, cannot live on this host under these rules and need their own
registrable domain.

Residual risk: **delta keys can be squatted.** `deltas/<from>/<to>.<method>` is named by its
endpoints, not by its own content, and is not product-scoped, so `promote` can verify only
that the bytes match the hash the caller supplies. Any tenant can promote arbitrary bytes under
another product's delta key first; the 180-day lock then fixes them in place, and the
legitimate promote answers `conflict`. This must stay an availability problem only: a client
must accept a delta's output only when it matches the signed `to` hash, and so falls back to
the full blob; the delta path for that pair is then denied until the lock lapses. The packages
that publish deltas (P4-03, P4-17) own the fix: product-scoped or content-named delta keys, or
granting a delta ref only under the earn-a-ref rule above, so a squatted key is never served
under the victim product.

### Trusted publishing (P2-02)

**What crosses.** A CI job reaches the Worker with one of two credentials and nothing else: a
GitHub Actions OIDC token (exchanged once, at `POST /<p>/release/publish/token`, for a 30-minute
`pkeyci_` token), or an operator-issued static `pkeyci_` token (≤ 90 days, for a CI that is not
GitHub). Bytes never cross the Worker: with `release:publish` the job gets an upload ticket and R2
temporary credentials, PUTs to `staging/<product>/<ticketId>/`, and submits a descriptor; the
Worker verifies and promotes (`core/blobs.ts`) and ingests (`descriptor.ts`). Code:
`core/publisher.ts`, `services/release/publish.ts`; tests: `test/publisher.test.ts`,
`test/publishRoutes.test.ts`.

**The OIDC token is verified, then judged.** RS256 only; the issuer is the constant
`https://token.actions.githubusercontent.com` (no setting can change it — a configurable issuer
is an attacker-chosen JWKS); the audience is product-bound (`<origin>/<product>/release/publish`),
so a token minted for one product cannot be exchanged at another; `exp`/`nbf` with 60 s skew; the
JWKS is cached in KV and an unknown `kid` refetches at most once a minute. The exchange is
single-use: the token's `jti` goes into `ci_tokens` under a UNIQUE index (in the required-index
assertion), so a replay inserts nothing, atomically. The policy is then applied (§5, "CI OIDC
claims").

**Nobody else can rate-limit a product's CI out.** The exchange has two fail-closed budgets. The
per-IP one (30/min) is charged first, on every request. The per-product one (120/min) is
charged only after the signature, the product-bound audience and the publisher policy have all
passed, just before the token is minted (`exchangeOidcToken`'s `admit` hook). Junk, a token for
another product's audience, or a validly signed GitHub token from someone else's repository
costs the sender only its own per-IP budget, so a flood from any number of addresses cannot
exhaust the product's budget. This keeps the rule the RFC 8628 paragraph below states: no
product-wide bucket an outsider can spend. `test/publishRoutes.test.ts` floods from ten
addresses and then exchanges successfully. Residual: besides the product's own declared
workflow, a replay of one of its still-valid OIDC tokens also spends the product budget, because
the single-use insert comes after the charge. That needs a token leaked from the product's own
runs, within its few-minute lifetime, and 120 replays in a minute deny only the rest of that
minute.

**The repo cannot weaken its own control** (the R6-03 precedent). `.pkey/release` may name only
`publishing.trustedPublisher.workflow` and `.environment`. The repository's numeric id and owner
id are resolved from GitHub at link/resync with the installation token, never read from the
manifest, so a manifest cannot name another repository as its publisher. The protected-ref,
GitHub-hosted-runner and allowed-event checks are platform-fixed. A manifest-owned policy follows
the manifest (and every change is audited as `ci.publisher.manifest`); once an operator claims it
(`PUT …/ci-publisher`, `source = 'admin'`), resync skips it. Scopes are never manifest-settable:
the default grant is `release:publish`, `release:promote`, `distribution:report`, and
`release:yank` exists only if an operator adds it.

**Upload credentials reach one prefix and cannot read or copy.** The temporary credential is an
HS256 JWT signed with the parent secret naming one bucket, `actions: [PutObject, HeadObject]` and
`prefixPaths: [staging/<product>/<ticketId>/]`. No `GetObject` or listing (CI never reads); no
`CopyObject`/`UploadPartCopy`; no multipart. The copy exclusion is load-bearing: `promote`'s
stored-checksum path trusts R2's recorded SHA-256 and never re-hashes the staged bytes, so a
`CopyObject` from `gated/blobs/sha256/<h>` (another product's paid build) into the ticket prefix
would carry that object, with its genuine checksum, into this product's staging, and a promote
would then earn this product a ref to bytes it never had. With no copy action and no read on any
other prefix, the only way to get bytes under the prefix is to PUT them. The multipart exclusion
keeps the stored checksum meaningful: a multipart object's checksum is a hash of part hashes, not
the object's SHA-256, so valid multipart uploads would fail closed (`digest_mismatch`); CI uploads
each object as one PUT with `x-amz-checksum-sha256`. The rules are R2's documented authorisation
model; `test/publisher.test.ts` asserts the minted claims and models those rules, and the
real-R2 confirmation is an operator check (`docs/DEPLOYMENT.md`).

**Earning a ref.** `promote` takes the product it promotes for and refuses, with `bad_key`, a
staging key under any other product's prefix, so a submit can only promote its own product's
uploads; it can only promote objects its ticket lists; the ticket is bound to the product and to
the token that obtained it, expires with the token (≤ 1 h), and is redeemed once. Every staged
object is verified, and the descriptor planned, before anything is promoted.

**A dry run may precede the uploads (P2-06).** `dryRun: true` judges a ticket object that is not
yet staged as if it were, and lists its key in `unverified`; a staged copy that is present must
still verify. Nothing is claimed, promoted or written, so it earns no ref. It is not an oracle:
an unverified key is judged by the ticket alone (the plan's pending set overrides whatever
`blob_objects` holds), and objects outside the ticket are still refused `object_not_in_ticket`.

**The CI client (P2-06).** `pkey release publish` and the `polaris-key/publish` Action
(`packages/cli/src/{oidc,ci,s3,publish}.ts`) hold three secrets for the life of one job: the
`pkeyci_` token, the ticket, and the temporary credential. Inside Actions each is passed to
`::add-mask::` before anything else touches it (tests assert that no other output line carries
one); outside Actions nothing is printed at all. `pkey auth github-oidc` hands the token to later
steps only through `$GITHUB_ENV`, never stdout. The CLI refuses a non-https `--base-url` (other
than `localhost`), so a token never crosses plain HTTP, and requests the OIDC token for the
product-bound audience itself. Retries are limited to what the Worker marks `retryable: true`, a
`429` on the exchange (each attempt with a fresh OIDC token, since the exchange is single-use), and
transient failures of the content-addressed PUT. Supply chain: the Action runs the committed
`actions/publish/dist/index.js`, an esbuild bundle with no install step, whose freshness check
fails CI on any difference from the reviewed source; workflows pin it by commit SHA until a
Marketplace `v1` tag exists.

**Residual risk: an existence oracle on other tenants' bytes.** `blob_objects` is shared, and
`promote` short-circuits a target that already exists (`alreadyStored`: no copy). The submit
route never reads that flag and answers identically either way, and `present` on a ticket
reflects only this product's refs, so no response body says whether another product holds a
hash. The **timing** still differs — a promote that finds the object stored skips a streamed
copy — so a tenant who uploads the bytes of a file can, by timing its own submit, learn whether
some other product already stored the same bytes. It learns nothing it could not compute (it
holds the bytes), gains no ref it did not earn by uploading, and the signal is noisy at small
sizes; it is accepted as residual and revisited if a tenant ever holds a hash whose bare
existence is sensitive.

**Stage rounds: a second way to earn a ref (P4-02).** A pack's objects are promoted in rounds
(`POST /<p>/release/publish/stage`, `services/release/packs/publish.ts`) before its record is
submitted, because one request cannot promote a whole pack inside the subrequest limit. A round
earns refs by exactly P2-01's rule (a): it promotes only the verified objects of a ticket this
token obtained, from the product's own staging prefix, for a pack the product declares, and only
when each object's `gated` flag equals the pack's delivery gate (`gated_mismatch`). Each promoted
object earns a `pack-upload` ref, `(product, key, "pack-upload", <packId>)`. That ref is
possession, not liveness: it lets the blob route serve, under the pack's access mode, an object
no release names yet; no device fetches it, because devices fetch only what a verified record or
index names (P4-14's collector drops a `pack-upload` ref no live index lists).

**Residual risk: the parent token.** A13 can write locked prefixes directly (R2's age lock still
refuses overwrites and deletes within 180 days). It lives only as Worker secrets; nothing logs it,
and no response contains it (the tests assert it). Rotation: create a new token, set the three
secrets in one bulk write, revoke the old token (which kills every outstanding temporary
credential).

### Service boundaries and the descriptor hooks (P2b-01)

**The `distribution` service.** The sixth opt-in service, between Release and Update in the chain
release ← distribution ← update (`distribution_requires_release`, `update_requires_distribution`,
enforced by `validateServices` and the manifest validator; `update_requires_release` is retired as
implied). In P2b-01 it had **no routes** (`handle` returned `null`, so every
`/<p>/distribution/…` path was the same not-found a disabled service gives), no tables, no secrets
and no admin handler; P2b-04 gave it every byte route (below). Its attack surface is the discovery fragment (`{enabled, configured:false,
endpoints:{}}`) and the two hooks below. Everything that will make it valuable to an attacker —
byte serving, outlet credentials, rollouts — arrives in later packages (P2b-02 to P2b-04, P5-01)
and reopens this section. P5-01 has landed the credential custody (below) but no connector, so
Distribution still opens nothing. P2b-02 gave it two tables, a manifest ingest hook and an admin
handler (below); it still has no device-facing route.

**Descriptor hooks are a read-only, fail-closed boundary.** A service may import only Core and
itself (`boundaries.test.ts`; the one exception is still `update → release`). Cross-service reads
go through `core/hooks.ts`: `releaseCatalog` (Release), `delivery` and `outletCapabilities`
(Distribution). Invariants (tests: `test/hooks.test.ts`, `test/boundaries.test.ts`):

- **Enablement first.** Core builds the accessors per request from the registry and the map the
  request was dispatched on, and each checks the **providing** service's flag before calling it:
  while it is off the accessor returns `null` and the provider's code never runs (a spy proves
  it). The same holds in the discovery context and the admin context — the admin API reaches a
  disabled service's own settings on purpose, but not another disabled service's data through
  a hook.
- **One provider per hook.** Zero or several providers make the accessor `null`, never "first
  wins", so which service answers cannot depend on `mount.ts` order.
- **Read-only.** The hook types return plain records and readers; nothing takes or returns a
  `DbStatement`. A hook that wrote would let one service change another's tables, which is an
  import in disguise. Reviewers: a hook method that writes, or that returns a row type rather
  than a Core record, is a boundary violation even though no test can see it.
- **Product-scoped.** Every reader is built for one product and queries only that product's
  rows (`releaseCatalog` reads by `product = ?`, test-pinned). A consumer must never pass a
  product slug into a hook.

**The rollback hazard, and why it is closed.** A newer worker writes `"distribution"` into
`products.services_json`. Before P0-08, an older worker that met an unknown slug discarded the
**whole** record and fell back to the defaults — License + Config on, Release, Update and
Identity **off** — so rolling back past this release would have silently switched off every
product's downloads, feeds and sign-in. P0-08 (in production since v0.3.0) made `parseServices`
carry a well-formed unknown slug through untouched and keep every slug it knows; this package
must not ship to an environment whose previous build lacks it. The `0033` backfill turns
Distribution on wherever Release is on — admin-owned rows included, since Distribution did not
exist when the operator claimed the row — guarded by `json_valid` and by the key being absent, so
it never touches an unreadable row or overrides an explicit `false`.

**Manifest drift.** A repo whose `.pkey/product` names `release` + `update` without
`distribution` (djdl's own shape) fails its next push with `update_requires_distribution`. That
is fail-closed: the refusal applies nothing, the stored (backfilled) set keeps serving, and the
console shows the error.

**Router.** `distribution` joined the service namespaces, so a manual release channel named
`distribution` lost the `/<p>/distribution/appcast.xml` alias (its canonical
`/<p>/update/distribution/appcast.xml` still works). A future service slug always shadows a
channel of the same name; that is the safe direction (a channel can never shadow a service).

### Outlets and outlet capabilities (P2b-02)

**What arrived.** `.pkey/distribution` declares a product's outlets (store identities, listing)
and transports; Distribution's `manifestIngest` applies it into `dist_outlets` and
`dist_transports` on link and resync. The `outletCapabilities` hook now answers for declared
outlets, and the console can narrow an outlet's capabilities
(`/manage/api/products/<slug>/distribution/outlets/…`, audited).

**Outlet capabilities are operator-owned and can only narrow.** `codeUpdates`,
`downloadedScripts` and `commerce` decide whether an installed copy may hot-load code or sell
things itself; a repo widening them by pushing YAML is the R6-03 (`requireSparkleSignature`)
class. So (tests: `shared-manifest` parity mutations, `test/distributionOutlets.test.ts`):

- **Not expressible in the manifest.** A `capabilities` key anywhere in `.pkey/distribution` fails
  validation (`capabilities_not_manifest_writable`) — the push is refused, not partly applied.
- **Never written by an ingest.** No statement of Distribution's `manifestIngest` names
  `capabilities_json` or `capabilities_source`; an operator's narrowing survives every resync.
- **Narrow-only at the API.** `PUT …/capabilities` refuses any value wider than the kind's
  compiled default (`binaryUpdates` self > store > none, a boolean to false, `commerce` to
  `none`), and an unknown key.
- **The kind is guarded, because the defaults are keyed by it.** The manifest owns an outlet's
  `kind`, so re-kinding was the one indirect way to widen. An id that is itself a kind is that
  kind: `app-store: { kind: web }` fails validation (`outlet_kind_mismatch`; the schema pins
  `kind` to the id). A custom id (`altstore-beta`) may pick any kind when first declared — a new
  outlet id has no installed copies yet — but once its row exists, the ingest lets it take a new
  kind only when every default capability of the new kind is equal or narrower than the old
  (`kindsNarrowableTo`, the same order `narrows` uses; `commerce` only to itself or `none`).
  Otherwise the row keeps its kind and the rest of the push applies; a removed row coming back
  is held the same way. Widening needs a new outlet id, so copies installed through the old one
  keep what they had.
- **Clamped on read.** The hook re-checks every stored override field against the default of
  the row's kind and ignores any that would widen, so a stale row or a D1 console edit can only
  make the override narrower. (The clamp bounds the override, not the kind; the kind is guarded
  above.) An unknown kind, an undeclared outlet and a removed outlet all answer `null` — never a
  permissive default.

**The ingest pipeline is a Core-mediated write path, not a hook.** `manifestIngestStatements`
(`core/registry.ts`) runs each **enabled** service's `manifestIngest` and puts the statements in
Release's link/resync batch, so the rows land atomically with the rest of the ingest. Release
receives it from the composition root (the webhook, the console's link route, `ServiceContext.ingest`
for its resync route) and never imports Distribution (rule 6). Resync gates on the product's
**stored** enablement after the manifest's write, so a service an operator turned off live keeps
its rows. A `manifestIngest` returns statements only, so it cannot read — it must be idempotent
SQL and must not name an operator-owned column; reviewers check both. The one exception to
"enabled only" is `manifestIngestAlways` (P2b-04), which Core runs for every registered service
on every ingest; Distribution's `app` delivery-access row is its only user (see "Byte delivery,
delivery access and rollouts" below). It carries the same two rules, plus a third: it may write
only a record that does nothing until its service is turned on.

**The ingest's cost is bounded for untrusted input (the R10 class).** Every row Distribution
writes comes from one push to a third party's repo and lands in the shared D1 batch, so its count
is bounded by the validator, not by the push: at most 32 outlets (`MAX_OUTLETS`), and at most 64
packs (P4-02's `MAX_PACK_DELIVERABLES`, `too_many_pack_deliverables`, refused whole before any
pack is validated). P4-05 routes every deliverable, so a link or resync resolves at most
(1 + 64) × 32 = 2,080 transport rows, where an unbounded 64 KiB `release.yaml` of
`{kind: pack}` entries could have multiplied into ~90,000 statements. They are written as
multi-row inserts of 25 rows (four parameters each, inside D1's 100), so the worst case is 32
outlet upserts, one removal sweep, one transport delete and 84 transport inserts
(`test/distributionOutlets.test.ts`, "the ingest's cost is bounded"). Manifest sync writes one
`release_deliverables` row per pack, at most 64.

**Residual risk.** Identity and listing fields are manifest-owned and written verbatim (validated
patterns, https-only URLs, no control characters); a repo writer can point a listing's `iconUrl`
at any https host. Nothing serves listings yet — when storefront feeds do (P2b-05), they are
untrusted display data and must be escaped by the feed, not trusted. The default capability table
is wire contract v4's `OUTLET_CAPABILITY_DEFAULTS`, which the Worker imports (P3-12) and the
corpus's `outlet-matrix.json` pins; it narrowed seven kinds from P2b-02's proposal, and a stored
override wider than a narrowed default reads back narrowed.

### Byte delivery, delivery access and rollouts (P2b-04)

**Byte serving moved services, and access moved with it.** Distribution now serves every byte:
the installer, the direct download and P2-05's build, file and blob routes, at canonical
`/<p>/distribution/…` paths. The `/<p>/release/{install.sh,dl,builds,files,blobs}/…` spellings
and `/<p>/install.sh` are router aliases that rewrite to the same `{kind:"service"}` route
(`router.ts`, ahead of the namespace check), so an alias cannot answer differently from its
canonical route (`test/distributionDelivery.test.ts` compares status, headers and bytes on both
hosts). Every P2-05 guarantee is preserved in the moved code (`services/distribution/bytes.ts`):
the `fixedVersion` rule (a file's release is checked by its stored version as one fixed, pinned
version, now `core/entitledAccess.ts` `fixedReleaseSelector`, shared with Release), the
non-semver refusal under a bounded window (`accessRefusal`, shared), the per-release check on
the blob route under `entitled`, `hasRef` tenancy, the `gated/` fail-closed, the opt-in
redirect for public artifacts of public repositories only, the same rate-limit buckets, and the
bytes host's hardening. The release/R6/R9/R10 suites run unchanged against the alias paths.

- **Enablement.** The byte routes are `ByteRoute`s with `service: "distribution"`. With
  Distribution off, every byte route and alias is not served on either host: the console's
  registry not-found, and the bytes host's flat not-found, each indistinguishable from an absent
  route. A product that runs Release without Distribution serves no downloads by choice; the
  `0033` backfill turned Distribution on for every Release product, so nothing that served
  downloads stopped.
- **No GitHub token in Distribution.** GitHub-held bytes are streamed by Release through the
  `releaseCatalog` hook's `openSource(ref, req)`, with Release's installation token, its cached
  signed URL and `streamAsset`'s SSRF guard; Release re-reads the artifact row itself, so the
  name, type and `source_url` that reach a header or a redirect are never taken from the caller.
  Distribution imports no Release module (`boundaries.test.ts`). `openSource` is the one hook
  method that returns bytes rather than records; it writes nothing.
- **The bytes host builds hooks.** `dispatchBytesHost` now builds the descriptor hooks for the
  matched product under that product's own enablement (the same `buildHooks` gate
  `dispatchService` uses), so a byte route on `dl.plrs.im` reads Release's catalog only while
  Release is on. `HookContext.product` is the key-free `ProductPublic`.

**One delivery-access answer (`dist_access`).** Who may download a deliverable is
Distribution's, per deliverable, and the three surfaces that hand out bytes all read
`delivery.accessMode()`: the byte routes, Update's appcast (through the gateway's
`artifactsAccess`, which also decides whether the appcast is edge-cacheable), and the portal's
download mint and redemption. Before, the feed and the download read access separately, so the
feed could offer what the download refused. `release_config.artifacts_access` is no longer read;
the `0038` migration copied it into each product's `app` row with its owner, and Release's
`artifactPolicy` fails closed to `entitled` when no delivery access is supplied, never back to
the old column.

- **Ownership.** The `app` row is manifest-owned (`.pkey/release` `access.artifacts`) until an
  operator sets it, which claims it. A manifest with no release block only seeds a missing row
  as `public` (the default `release_config` took on link) and never rewrites an existing one, so
  dropping `.pkey/release` cannot open a `licensed` product — whether the push leaves its
  services on or turns them off for an operator to turn back on ("dropping .pkey/release never
  loosens…"). The ingest skips a claimed row, so `entitled` (no manifest spelling)
  survives a push. A pack row is operator-only: its `entitlement` is the pack's delivery gate
  (P4-01 decision 35). Release's publish routes read it through `delivery.entitlement`, CI signs
  it into each pack record, and the stage round and ingest refuse an object or a record that
  disagrees (`gated_mismatch`, `pack-entitlement`, `pack-object`). `.pkey/release` may assert a
  gate, which can only refuse a publish that differs, so no push gates, un-gates or re-flags a
  pack. `update/settings` refuses `artifactsAccess` by name.
- **Turning Distribution on cannot loosen access.** Enabling a service in the console
  (`core/servicesAdmin.ts`) runs no ingest, so the `app` row must already be right at that
  moment. Distribution writes it through `manifestIngestAlways` (`core/registry.ts`), the one
  ingest hook Core runs WHATEVER the service's enablement: every link and resync of a
  Release-only product keeps the row equal to its manifest's release block, so a `licensed` manifest is
  `licensed` the instant Distribution answers, and a mode tightened while Distribution was off
  is the one in force when it comes back (`test/distributionDelivery.test.ts`, "turning
  Distribution on…"). The hook may write only records that do nothing on their own; no request
  reaches a disabled service.
- **Inheritance fails toward the app, then closed.** A deliverable with no row inherits the `app`
  row; no row at all reads as `entitled`, never `public` — reached only by a product no ingest
  has touched since 0038 backfilled every configured product. A stored mode outside the CHECK
  reads as `entitled` too. The blob route's app side uses the strictest mode of the deliverables
  whose releases carry the digest; a pack's objects follow the pack (below).
- **The portal asks the same question of licences.** A portal account has no device token, so
  `licensed` needs a usable linked licence and `entitled` one whose own grant
  (`core/entitledAccess.ts` `licenseEntitled`, the device decision without the device layer)
  holds the release's stored channel (stable when GitHub-derived) and window. This is stricter
  than the byte routes' fixed-release check, which still reads a fixed release as the stable
  channel (the residual in §5 stands for them). With Distribution off the portal offers and
  mints nothing.
- **R6-12, extended deliberately.** The portal's redirect may now also target this deployment's
  bytes host (`isAllowedDownloadRedirectHost`, separate from the fetch-side
  `isAllowedStorageHost`, which still allows only GitHub's storage hosts): only for a PUBLIC
  deliverable with no GitHub download URL, only `https`, and only the exact `BLOB_ORIGIN`
  hostname, with the URL minted by `delivery.deliveryUrl` from stored records. A non-public
  deliverable is never redirected there.
- **`deliveryUrl` keeps the fixedVersion rule.** Every URL it mints, for a file or for a build,
  is `…/files/<releaseId>/<name>`, pinned to the release by id. It never mints
  `builds/<stored version>/…`: a GitHub-synced release stores its tag as its version, and a tag
  such as `latest`, `beta`, `pr-5` or a manual channel's name would be re-read there as a moving
  selector and serve the channel's current release, cached as moving. A build's URL is its
  payload's, and only when the `files` route resolves that name to that same artifact; otherwise
  `null`.

**Pack bytes (P4-05).** Every object a pack release names, and every file blob its indexes
name, is served by the blob route alone, by its stored SHA-256 (`services/distribution/
blobAccess.ts`); `files/<packRelease>/…` and `builds/…?deliverable=<pack>` answer not-found,
and `deliveryUrl` mints no URL for a pack release. That closes P4-02's interim exposure, under
which `files/` served a pack's ungated objects under the pack's (or the app's) mode and an
`entitled` app window was checked against a pack's version. A hash is never the authorisation;
the object's HOLDERS in this product are:

- **The public path never reads `gated/`.** An object lives under `blobs/sha256/<h>` (published
  while its pack was ungated, or an app artifact) or `gated/blobs/sha256/<h>` (published while
  gated; P4-02's stage round and ingest hold the prefix to the gate). The public key is decided
  by its own holders; the gated key is tried only when the public one is not held or refuses,
  and only a pack's ref (`pack-upload`, `pack-object`) authorises a gated key — an app artifact
  or feed ref there admits nothing. A ref of another product never counts (`refHolders` reads
  this product's rows only); more than 512 distinct holders refuses rather than guess.
- **No byte under `gated/` without the current gate's flag while the pack is gated.** The flag is
  the `entitlement` of the pack's own `dist_access` row, read at each request through
  `delivery.entitlement` — never the manifest's assertion and never a record's `entitlement`,
  which is a publish-time snapshot — and checked by `core/entitledAccess.ts`
  `entitlementFlagRefusal` against the grant the licence document would carry
  (`resolveMergedPayload` + `injectAdminPolicy`): `401 unauthorized` without a usable licence,
  `403 not_entitled` without the flag. Renaming the flag moves who may download at once. Every
  such response is `private, no-store, no-transform` (`blobResponse` forces it for a `gated/` key).
- **A pack's mode, never the app's window.** An ungated object follows the pack's delivery mode
  (`public`; a usable licence under `authenticated`/`licensed`; the gate under `entitled`). The
  app's version window is an app rule and never applies to a pack. `entitled` without a gate is
  **fail-closed**: there is no grant to check, so the object is refused (`403
delivery_gate_missing`) until the operator sets a gate or a looser mode. A pack with no row
  inherits the app's mode, so a paid app's packs are refused until an operator decides; that is
  deliberate (P4-05's answer to P4-01's open question).
- **A gate set after a release leaves that release's `blobs/` objects where they were.** Objects
  never move between prefixes; the earlier public responses were cacheable and cannot be
  recalled, so a gate protects only the bytes published after it is set. A pack un-gated later
  serves its `gated/` objects under its mode, still `private, no-store`.
- **Residual: holder existence.** The route's status tells a caller whether the product holds a
  hash, and how it is gated. What is actually public: the hashes a pack RECORD names (each
  variant's `full`, files index, gaps and deltas) are readable by anyone the record route serves
  under the metadata mode. A FILE BLOB's hash is named only inside a files index, which is itself
  a gated object for a gated pack, so it is disclosed only to a caller who already holds the
  index's bytes. Against a hash so learned: an anonymous request answers `401` where an unknown
  hash may answer `404`; a closed pack (`entitled`, no gate) answers `403
delivery_gate_missing` to anyone; and a licensed caller WITHOUT the flag gets `403
not_entitled` rather than `404`, which confirms the product holds that gated content. None of
  this reveals the bytes or anything about other tenants (another product's refs never count).
- **Refusals are rate-limited and cheap.** The byte routes count a request against the client's
  artifact lane BEFORE the access decision (P4-05 moved it), and a blob decision costs a fixed
  number of reads: one `refHolders` query, one `dist_access` read for every holder's mode and
  gate, at most one read of the releases carrying the digest, and the licence check.
- **Availability reads the same possession, at a bounded cost.** A pack variant is derived `live`
  on `pkey-cdn`/`web` only while every object its record names is stored with its recorded hash
  and length and held by this product (bulk reads for a whole matrix page: one record read per
  pack release plus a fixed set of bulk queries, inside D1's per-invocation cap); `embedded` is derived from the signed pins and the builds' `embeds`. A
  transport v1 does not act on is stored and reported unsupported, never silently served by CDN.

**The payload URL (P4-18).** The one other route that serves a pack's objects is
`/<p>/distribution/packs/<pack>/<variant>/payload/<sha256>` (`services/distribution/payload.ts`;
Compression Dictionary Transport, RFC 9842). It adds no authorisation of its own:

- **The blob route's decision, per object.** The variant's `full` object is decided by
  `decideBlob` exactly as the blob route decides it (its holders, the pack's mode, the current
  gate under `gated/`), and a `dcz` answer also needs the delta artifact decided servable and
  stored with its recorded checksum; otherwise the answer falls back to the full payload (or `409`
  under the SDK's `?via=dcz` guard). It counts against the same artifact rate-limit lane, before
  the decision. Finding the payload reads at most the pack's 200 newest records (pages of 20,
  newest first), so a lookup is bounded per request.
- **Nothing is decoded or composed at the edge.** The stored frame is sent as it is with
  `Content-Encoding: zstd`; a `dcz` body is a 40-byte header derived from the delta's `from` (a
  hash the signed record publishes) followed by the stored artifact. No base byte is read, and
  the stored artifact stays the portable bare frame. `Available-Dictionary` is only compared
  with the `from` of a published delta to the requested payload, so it reveals nothing beyond the
  record. The device verifies the decoded payload's size and SHA-256 against the record (the
  dictionary lives in the evictable HTTP cache), exactly as for every other strategy.
- **Gated bytes are never a dictionary.** A payload served from a `gated/` key (or of a gated
  record) is `private, no-store, no-transform` and carries no `Use-As-Dictionary`. An ungated
  payload is `public, max-age=31536000, immutable, no-transform` when every holder is `public`,
  else `private, max-age=31536000, immutable, no-transform`: the browser of a caller who was
  authorised may keep it (and use it as a dictionary), and no shared cache may. That is the one
  caching difference from the blob route, which answers such a non-public object
  `private, no-store`; the bytes are content-addressed and immutable, and the browser keeping
  them is the same device that keeps them in OPFS. It also covers a pack moved to `entitled`
  later whose earlier releases' objects stay under `blobs/` (objects never move prefix): the
  payload URL serves them, to a caller the gate admits, `private, max-age=31536000, immutable`
  where the blob route says `private, no-store`, so a browser admitted once keeps that copy (and
  its dictionary) after its grant lapses; no one else's cache holds it, and the gate still
  decides every new request.
- **The dictionary's scope is one (pack, variant).** `Use-As-Dictionary`'s match pattern is the
  (pack, variant)'s payload-URL prefix, so a browser never offers one pack's payload for
  another's request, and none is advertised above Chromium's 100 MiB limit.
- **CORS as for the blob route** (`core/cors.ts`'s covered paths, the product's `web.origins`);
  full-body only (`Accept-Ranges: none`); the body is sent with `encodeBody: "manual"` at the edge
  (`index.ts` `preEncoded`), so the runtime never re-encodes it.

**Edge caching stays off.** The byte routes are not cached (no Workers Caching entrypoint, no
`caches.default`), so S-02's open question — whether a public response to a request carrying
`Authorization` is stored or bypassed (Cloudflare's configuration and examples pages disagree;
hand-off row H10) — does not arise. If caching is turned on later, it must run on a named
entrypoint that serves only ungated bytes-host reads, with `Authorization` and `Cookie`
stripped by the default entrypoint and gated requests never routed to it; it must rely on that
routing and stripping, never on an automatic bypass.

**Rollouts and halts (`dist_rollouts`).** Percentage, pause, resume, halt and completion per
outlet and channel. Principals: a console admin session, and CI with a `pkeyci_` token holding
the **opt-in** `distribution:rollout` scope (not in the default grant). Transitions are a fixed
table, applied conditionally on the state read (two concurrent verbs cannot both apply); a
yanked release cannot be rolled out; a verb may pin the release it means (`stale_release`); a
`mirrored` row (a store connector's) refuses every direct edit; every change is audited with its
actor. **What a halt does today:** the storefront feeds that list releases (P2b-05: AltStore,
AltStore PAL, Scoop, Flathub, and the F-Droid generator inputs and APK redirects) honour holds: a
release whose rollout on an outlet is paused, halted or active below 10000 bp is left out of
that outlet's feeds, which list the previous release instead. **Obtainium does not:** its config
is a pointer that names no release. In FDroidRepo mode it follows the `fdroid-repo` outlet's
repository, so it obeys that outlet's holds; in Direct mode it follows the moving
`builds/<channel>/<buildId>` route, which applies yanks and pins but neither holds nor
availability. A hold on the `obtainium` outlet itself changes nothing unless no release
qualifies at all, which turns the config into a not-found. Nothing else reads `dist_rollouts`
until P3-03 composes the signed feed: the Sparkle appcast, `/update/version` and the downloads
keep serving. So a holder of `distribution:rollout` (or an admin) can WITHHOLD one release per
outlet and channel from the storefront feeds that list releases, which for new installs there is
a rollback to the release before it. It cannot EXPOSE a build: a feed lists only releases the
channel already serves, and a yanked release can be neither rolled out nor listed. The
emergency stop for every device is still a yank or a pin (`release:yank`, `release:promote`). The salt
is random per release and the bucket is evaluated on the device, so the Worker serves one feed
to everyone and a rollout leaks nothing about which devices are in it.

### Availability, submissions and the key inventory (P2b-03)

**What arrived.** `dist_availability` (is release R, build B, available on outlet O, and since
when) and `dist_submissions` (where R stands in O's review) — written by CI through
`POST /<p>/distribution/report` until the store connectors exist (P5-02 to P5-04) — and
`dist_keys`, the per-product signing-key inventory, written only by an operator in the console
(`services/distribution/availability.ts`; tests: `test/distributionAvailability.test.ts`,
`test/distributionReportE2e.test.ts`).

- **The principal.** A `pkeyci_` token with `distribution:report`, which is in the DEFAULT grant
  (P2-02): any job that can publish can report. A report is validated whole before anything is
  written — the outlet declared and not removed, the release and build known to Release's
  catalog, the state in the type's vocabulary, `since` not in the future — so a refused report
  writes nothing. Every change is audited as `ci:<subject>`. The route is CI-only (no CORS),
  answers not-found with Distribution off, and is not on the bytes host.
- **What a report can and cannot do.** It can make the console, and later the matrix (P2b-06),
  the storefront feeds (P2b-05) and the signed feed (P3-03), show a WRONG STATE: claim a build is
  `live` on a store where it is not, or `removed` from a self-hosted outlet where it is. Since
  P2b-05 that wrong state also STEERS the storefront feeds: a stored report wins over the derived
  `live` of a self-hosted outlet, so a non-`live` report hides a release from that outlet's
  AltStore, F-Droid or Scoop feed (which then lists the previous one), and a `live`
  report on AltStore PAL lists a release the store may not carry. (An Obtainium config names no
  release: a report on the `obtainium` outlet only matters when it leaves no release at all,
  which turns the config into a not-found; see P2b-04 above.) Both are withholding or
  rollback for new installs, never exposure: a feed lists only releases the channel serves,
  never a yanked one, and only by their pinned delivery URLs, except Obtainium's Direct link,
  which is the moving builds route. It cannot ship code, serve or
  withhold bytes (nothing on the byte path reads these tables), change a rollout, or change a
  key. It is recorded as a §5 semi-trusted input. A consumer that turns
  availability into an offer to a device (P3-03) must treat a CI-sourced `live` as a claim, not
  as proof — the bytes, their digest and the release's signature remain the authority.
- **Derived availability reads only Release's truth.** A self-hosted outlet (`direct`, `web`,
  `altstore`, `obtainium`, `fdroid-repo`, `app-installer`) delivering by `pkey-cdn`, `embedded` or
  `web` reads `live` for a build that is not yanked and whose payload has an R2 or GitHub location,
  through the `releaseCatalog` hook; no report is needed and none can widen it beyond that — a
  stored report can only replace the derived answer for its own outlet. Store kinds never derive,
  since every outlet's default transport is `pkey-cdn`.
- **Fail-closed vocabulary.** States, purposes and sources are enforced on write in code (no CHECK,
  so P5 can grow them); a stored availability state outside the vocabulary reads as `pending`,
  never `live`.

**The key inventory is the independent control.** Its fingerprints are what players, the download
page (P2b-06), F-Droid clients (P2b-05) and AppVerifier check a download against, so a
compromised pipeline must not be able to edit it — otherwise an attacker who can sign with their
own key could also publish that key as the expected one.

- **Operator-only writes.** Only the console's `PUT`/`DELETE …/distribution/keys` (platform-admin
  session, CSRF, audited with the session's subject) create, change or remove an entry
  (`source = 'admin'`). No ingest writes a `dist_keys` ENTRY. The one manifest field that
  reaches the table is `.pkey/release` `releaseKeys` (P3-03; see "Release keys, the strict
  verifier and the signed feed" below): on every link and resync it writes `release`-purpose
  observations (`source = 'ci'`, under the same `MAX_KEY_OBSERVATIONS` cap, past which a new one
  is silently not stored) and refreshes `observed_json` on a matching entry, exactly as a CI key
  report does — but with no per-observation audit row. An unadopted one still flags the purpose
  in the inventory until an operator adopts or dismisses it.
- **CI reports observations, never entries.** A `type: key` report that matches an entry writes
  only that row's `observed_json` (the upsert's `DO UPDATE` names no other operator column). One
  that matches no entry becomes an observation row (`source = 'ci'`), audited as
  `distribution.key.mismatch`; the `delivery` hook's `keys()` never returns observations and
  marks every entry of that purpose `flagged`, and the CLI exits 1. An operator adopts or
  dismisses it. A pipeline that rotates to an attacker's key is therefore visible, not silent.
- **Residual.** An attacker holding a `distribution:report` token can add observation rows and
  mark entries `flagged` — noise an operator clears, and visible in the audit log. The CI routes
  have no rate limit of their own, so observations are capped per product
  (`MAX_KEY_OBSERVATIONS`, 64; past it a new one is refused 409 `too_many_observations`, which
  still fails the job), and availability and submission rows are bounded by the product's
  releases × builds × declared outlets. The `registered` flag is the operator's own record of
  Android developer verification; nothing verifies it against Google.

### Storefront feeds and the F-Droid relay (P2b-05)

**What arrived.** Public per-channel feeds under `/<p>/distribution/` — AltStore/SideStore and
AltStore PAL sources, Obtainium configs, Scoop manifests, Flathub checker JSON — rendered from
Release's truth and Distribution's state, and an F-Droid repository relay serving files CI signed
and registered (`services/distribution/feeds/`; tests: `test/storefrontFeeds.test.ts`). A new
opt-in CI scope, `distribution:feeds`, reads the generator's inputs, registers a repository's
files, and buys an upload ticket for them. A new column, `release_builds.metadata_json`, holds
the descriptor's `builds[].metadata` (IPA entitlements and privacy strings, APK signer).

- **Public by construction, so public only.** None of these clients can authenticate. Every feed
  route, the relay included, exists only while the app deliverable's `dist_access` is `public`.
  Otherwise it answers the plain not-found, so a `licensed` product's release history, notes and
  byte URLs are never listed. Release notes appear only when the metadata access is public too.
  The feeds are served on the console host, never on the bytes host, and are read-only.
- **The relay is not a file host.** It serves only paths registered for (product, `fdroid`,
  channel). Every path passes `isSafeAssetPath` at registration and on every read, so a `%` or a
  dot segment never reaches a lookup. Each file is a content-addressed blob that this product
  holds a `feed` ref to, and `blobResponse` re-checks its stored checksum. On every read the relay
  also applies the blob route's strictest-mode rule (`objectIsPublic`): the strictest `dist_access`
  of the deliverables whose releases carry the object (the app's when none do) must be `public`,
  so an object a pack or other non-public deliverable later carries stops being served at once.
  The content type comes
  from a Worker allowlist keyed by extension (`json`, `jar`, `png`, `jpg`, `jpeg`, `webp`, `asc`);
  CI never supplies it, and HTML, XML and SVG cannot be registered. Every answer carries `nosniff`
  and the sandbox CSP. `application/json` and `image/*` are served on the console origin, which
  holds sessions. With `nosniff` and `sandbox`, no browser runs either as a document. An APK name
  is a 302 to its immutable delivery URL, and only when the registered `index-v2.json` names it
  and the channel's F-Droid feed still selects its release.
- **Refs are earned the P2-02 way, and only feed refs count.** A register promotes only objects of
  the caller's own upload ticket, verified in staging. It skips the ticket only for a key this
  product already holds a `feed` ref to, which an earlier register earned the same way. A release
  artifact's or a pack object's ref does NOT count: the relay serves every file to anyone, and
  the feeds themselves publish payload digests, so accepting any ref would let a token that holds
  only `distribution:feeds` re-serve bytes it never had. A hash alone never earns a ref (§3, the
  blob store). Registration also refuses (`not_public`, 403) any object a non-public
  deliverable's release carries, by the same strictest-mode rule the relay re-applies on every
  read. So a registered file is never a paid pack's payload, whether the caller names its digest
  or uploads the bytes. The channel's file set and its `feed` refs are replaced in one batch.
- **The repo key never reaches the Worker.** CI signs `entry.jar` with `apksigner`. Before it
  uploads, `pkey feeds fdroid` refuses a signature by any key other than the `fdroid-repo` entries
  of the operator-owned key inventory. F-Droid clients pin the fingerprint they were given when
  they added the repository, so a pipeline holding another key cannot get a client to accept its
  index.
- **Cost (DoS).** The feed routes are public and unauthenticated, and they read the D1 database
  that licensing shares across products, so a request's cost is bounded, not proportional to the
  release history. A selection reads the outlet's availability rows and transport once, then two
  queries per scanned release (its builds and its artifacts), none for a store outlet's release
  with no live report, and scans at most the 100 newest releases (`MAX_FEED_SCAN`): about 220 D1
  reads in the worst case, pinned by a ceiling test over a 120-release history. The rendered
  answer is then kept in the Workers Cache API for the five minutes `Cache-Control` already
  promises, keyed by path, `?outlet=` and a stamp of the state a feed must follow at once
  (rollouts, yanks, availability, outlets, registered files, notes access). Extra query parameters
  do not miss it. A cached answer costs the access check and the stamp, under a dozen reads. The
  relay answers an APK name its registered index does not list without any selection. The 60
  requests per minute per IP limit (which fails open) remains a backstop, not the bound. A new
  release can take up to five minutes to appear in a feed; a hold, a yank, a report and an
  access change apply on the next request.
- **Residual.** A `distribution:feeds` token can replace the repository of a channel the product
  already declares (a built-in, a manual rule, or a channel a release was published to:
  `knownChannels`) with any validly shaped files whose bytes it holds itself, and none of them
  can be a non-public deliverable's object. It cannot create a repository: a well-formed channel
  name the product never declared is `unknown_channel` (404) at registration, and every feed
  route, the relay included, is not-found for it, so no file is served and no answer is cached
  under it. A client that pinned the fingerprint rejects an index signed by another key, but
  the token can still break the repository: it can register a stale index or a broken one. That is
  denial of service and a rollback to versions that were listed before, not code execution, since
  the APKs stay pinned by SHA-256 and Android verifies their signatures. The scope is opt-in for
  that reason. Two scopes that existed before P2b-05 now steer these feeds too, with the same
  withholding-or-rollback effect and no exposure: `distribution:rollout` (opt-in) and the console
  can hold one release per outlet and channel out of every feed on that outlet that lists
  releases (P2b-04 above; not Obtainium's config, which only points at a source),
  and `distribution:report`, which is in the DEFAULT grant, decides through availability reports
  which releases the self-hosted feeds list (P2b-03 above). Build metadata is CI's claim: it
  decides what a feed lists, never the bytes behind a URL. A wrong `appPermissions` makes AltStore refuse the install, and a wrong `signerSha256`
  makes F-Droid refuse the APK.

### The public download page (P2b-06)

**What arrived.** A public, cookie-free download page per product (`services/distribution/
page/`; tests: `test/downloadPage.test.ts`): `GET /<p>/distribution/download` and its alias
`GET /<p>`, HTML, served ONLY on the bytes host; and its model, `GET /<p>/distribution/
download.json`, JSON, served only on the console host. It is the first HTML a stranger can load
that shows repo-authored text: the `.pkey/distribution` listings and identities, which any repo
writer can push.

- **Never on the console's origin.** Same-origin script there is a control-plane takeover
  (R1-09), so on the console host both page paths and `/<p>` are the plain not-found (the
  Distribution route returns `null`; the router rewrites `/<p>` to the page path, which answers
  nothing there).
- **Inert on the bytes host.** The bytes host admits HTML only from a `document` route and only
  under a policy the dispatcher checks itself before the answer leaves (`inertDocumentPolicy`,
  `core/bytesHost.ts`): directives limited to `sandbox` (with at most `allow-downloads` and
  `allow-top-navigation-to-custom-protocols`, so a click can download a file or open an
  `altstore://`/`obtainium://` link; never `allow-scripts`, `allow-same-origin`, `allow-forms`
  or `allow-popups`), `default-src 'none'`, `style-src` hash sources, `img-src data:`, and
  `'none'` for `frame-ancestors`, `base-uri` and `form-action`; a status of 200, the exact type
  `text/html; charset=utf-8` and no `Content-Disposition`. Anything else becomes the plain
  not-found. The policy is therefore still a sandbox: the document has an opaque origin and runs
  no script, which is the property §3's same-site compensation rests on, and no request leaves it
  to any host. The page needs no script: platform detection is server-side (UA Client Hints, then
  the User-Agent), and the iPad case (Safari reports a Mac) is a pointer media query.
  `nosniff`, `Referrer-Policy: no-referrer`, the cookie stripping and the HSTS backstop apply as
  to every bytes-host answer. A document route answers no CORS and no preflight.
- **Escaped and Worker-built.** Every string is HTML-escaped (text and double-quoted attributes
  alike); there is no inline handler and no `style=` attribute. Identity fields are re-validated
  against the manifest's shapes before a URL is built from them, store URLs are built from those
  ids, deep links (`altstore://`, `sidestore://`, `altstore-pal://`, `obtainium://`,
  `fdroidrepos://`, `ms-windows-store://`, `steam://`) from Worker-minted feed URLs with
  `encodeURIComponent`, and every `href` passes `safeHref`, which admits only an `https:` URL or
  one of those schemes. A listing's `website` is kept only as a parsed `https:` URL; its icon and
  screenshots are not loaded at all (no third-party request). A listing carrying `<script>`,
  quotes and a `javascript:` URL is pinned to render inert.
- **Public only, by the feeds' rules.** The model exists only while the app deliverable's
  delivery access is `public`, and lists releases exactly as the storefront feeds do (P2b-05,
  the same selection code): the `stable` channel's history, live on the outlet, not yanked, not
  held by a paused, halted or partial rollout, with an immutable delivery URL. A store link
  appears only once the channel has a release reported live there. Entitled-only links
  (TestFlight, Play testing) are never shown. Notes appear only while metadata is public. So a
  non-public deliverable, an undeclared channel or a gated object never reaches the page.
- **Fingerprints come from the operator.** The page shows the key inventory's operator entries
  (never a CI observation, never the Android upload key), and the F-Droid link carries a
  fingerprint only when the inventory holds exactly one `fdroid-repo` entry. A pipeline cannot
  put its own key on the page.
- **Cost (DoS).** Both routes are public: they share the feeds' 60-per-minute-per-IP budget
  (fails open), check delivery access on every request, and keep the built model in the feed
  cache under the feeds' stamp plus the key inventory's. A build is one selection per declared
  outlet over memoised catalog reads (bounded by `MAX_OUTLETS` and `MAX_FEED_SCAN`; a ceiling
  test pins a ten-outlet product). Release notes are repo-writer text and the cache keeps only a
  finished answer, so the notes summary reads at most the first 8,192 characters and uses only
  linear-time patterns (no lazy body between the `pkey:summary` markers, no `\s` at a line
  start); a test pins 20,000-character adversarial notes finishing in well under a second.
- **Residual.** The page is rendered from what CI and the operator recorded: a CI report can make
  a store link appear (a `live` claim) or a self-hosted release disappear, as for the feeds
  above; a wrong listing is the repo writer's own text, shown escaped. A visitor reaching the
  page through a stale link sees a release up to five minutes old. QR codes carry the same URLs
  the links do; one too long for the encoder (an Obtainium app config) is simply not drawn.

### The registry host and package feeds (F-02 to F-11)

**What it is.** `pkg.plrs.im` (with `pkg-staging` and `pkg-dev`) is the same Worker on a third
custom domain, beside the console (`key.plrs.im`) and the bytes host (`dl.plrs.im`). It serves
package feeds to registry clients: npm, PyPI, SwiftPM, Maven and Gradle, OCI and Godot (plans/F-01.md
§6). `PKG_ORIGIN` names it, and `core/registryHost.ts` confines it to `mount.ts`
`REGISTRY_ROUTES`, a static landing page at `/` and OCI's fixed `/v2/` root. F-02 ships the host
and the framework, F-03 the tables and ingest, F-04 to F-09 one feed each (npm, PyPI, Swift,
Maven, OCI, Godot) and F-11 the console's Feeds pages; each part is below. Tests: `test/registryHost.test.ts`, `test/registryFeeds.test.ts`,
`test/feedAdapters.test.ts` (the adapter conformance suite), `test/registryDrain.test.ts`,
`test-workerd/registry.test.ts`, and the curl client of `registry-clients.yml`.

**Same-site exposure.** The host is a `*.plrs.im` sibling of the console, so `SameSite` does not
separate them, exactly as for the bytes host. Its compensations, against `dl.plrs.im`'s:

| Compensation                                  | `dl.plrs.im`                                           | `pkg.plrs.im`                                                                       |
| --------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Only an allowlist of routes answers           | `BYTE_ROUTES`                                          | `REGISTRY_ROUTES`, `/` and `/v2/`; console paths are the not-found                  |
| No cookie read; `Set-Cookie` stripped         | yes                                                    | yes                                                                                 |
| `nosniff`, `Referrer-Policy: no-referrer`     | yes                                                    | yes                                                                                 |
| `sandbox` CSP with no sources on every answer | `BLOB_CSP`                                             | `REGISTRY_CSP` (the same value)                                                     |
| `Cross-Origin-Resource-Policy: same-origin`   | no                                                     | yes                                                                                 |
| CORS                                          | the product's `web.origins`, via `core/cors.ts`        | **none**: route headers dropped, `OPTIONS` is 405                                   |
| Methods                                       | per route                                              | `GET` and `HEAD` only (405 otherwise)                                               |
| Errors and throws                             | flat JSON; JSON 500                                    | flat JSON, `problem+json` (Swift) or OCI error JSON; JSON 500                       |
| Service off for the owner                     | the not-found                                          | the not-found, and the feed ladder below answers it too                             |
| The one HTML answer                           | `/` and the download page, under `inertDocumentPolicy` | `/`, and the PyPI simple page on its one flagged route, under `inertDocumentPolicy` |

The console's session cookies are host-only (`__Host-`, no `Domain`), so a browser never sends
them to `pkg.plrs.im`; `test/registryHost.test.ts` re-asserts that for this host.

**The one deliberate widening: the type allowlist.** `REGISTRY_HOST_TYPES` admits registry JSON
(`application/json`, the npm, PyPI, Swift and OCI/Docker manifest types), `text/x-swift`, PNG,
JPEG and the archive types. Reviewed once, here:

- JSON is not a document a browser runs. With `nosniff` and the sandbox, a JSON body that
  someone opens in a tab is inert text with an opaque origin.
- `text/x-swift` is the only `text/*` type, and it always leaves as `attachment`. PNG and JPEG
  cannot carry script; SVG is never served.
- XML is **not** on the list, at any status. POMs, `.module` files and `maven-metadata.xml` go
  out as `application/octet-stream` attachments. F-07's client matrix (Gradle 8 and 9, Maven
  3.9 with checksum policy `fail`) proves Gradle and Maven ignore the type; a client that did not
  would be a stop-and-ask, never a reason to add `xml`.
- HTML is not on the list. The PyPI simple page (`application/vnd.pypi.simple.v1+html`) is
  admitted only on a route flagged `inertDocument`, at 200, without `Content-Disposition`, and
  only under a policy `inertDocumentPolicy` accepts (`sandbox` with no script token,
  `default-src 'none'`, no forms, no base, no framing). It is rendered from the same data as the
  JSON with every value escaped, and has no `<script>`, `<form>`, `<style>` or `on*`
  attribute. The feed setting `htmlFallback` turns it off.
  - **As built (F-05).** Two routes carry the flag, the project list and the project page
    (`registry/pypi/routes.ts`); the files route does not, so a wheel or sdist can never be
    admitted as HTML. Both send exactly `sandbox; default-src 'none'; frame-ancestors 'none';
base-uri 'none'; form-action 'none'` and `Vary: Accept`, and give HTML only when `Accept`
    lists no PEP 691 JSON type (pip and uv always list it first). Every tenant value on the page
    (the project name, file names, `Requires-Python`, the yank reason) is escaped, and
    `test/registry/pypi.test.ts` pins the page against golden files and against any script,
    form, style, image, base, `on*` attribute or `javascript:`. File URLs are relative and embed
    the SHA-256; a file is served only when its name and hash both match a file of the owner's
    package and the owner holds the blob's ref (`hasRef`). A path naming no project or file
    still runs the feed-level check first, so an unknown name answers exactly what a disabled
    or non-public feed answers for a known one.
- Any other type, or a body without one, becomes the not-found.

**Tenant-supplied text.** Package names, descriptions, `package.json`-derived fields, POMs and
Godot descriptions are tenant input. They are served only inside JSON, as octet-stream
attachments, or escaped inside the inert PyPI page; none is ever rendered as an HTML document.

**The access ladder runs before the cache.** `authorizeFeedRead` checks, in order, the platform
kill switch, the owner's Distribution and `packageFeeds`, the feed's `enabled` and then the mode
(`stricter(feed, deliverable)`). Any "off" answers the same not-found as an unknown owner, so
enablement is not an oracle. The check runs before the Cache API lookup, from a 30-second
per-isolate settings cache, so turning a feed off or tightening a mode stops even an immutable
answer cached at the edge for a year within 30 seconds. Client-side caches (a browser, a package
manager's local store, a proxy the client runs) that already hold an immutable object are outside
the kill switch's reach: the server cannot recall bytes it has already served. A missing settings
table or row fails closed. Tier 1 admits only `public`; every other mode answers the client's native 401
(`Basic`, or OCI's `Bearer` challenge naming a token endpoint that 404s until F-21). The
credential extractor parses every `Authorization` shape and never logs, stores or echoes it.

**Cache poisoning.** Only a `public` decision reaches the Cache API, and only a 200 with a public
`Cache-Control` answering a GET is stored; a HEAD may read the GET entry but never writes it. The key is the normalised path, the query names the route reads and,
for npm and PyPI, `Accept`; any other parameter or header is ignored. Non-public answers are
`private, no-store` and never stored; not-founds and refusals are `no-store`.

**Rendered index documents.** Index documents are rendered from D1 into R2 under `registry/`,
a prefix with no bucket lock and no lifecycle rule, kept apart from the locked `blobs/`,
`bundles/`, `deltas/` and `gated/`. A renderer's object key is checked segment by segment (no
empty, `.` or `..` segment), so it cannot leave its `registry/<ecosystem>/<owner>/` prefix. A
lost object is re-rendered on read; the self-check re-renders a package whose stored stamp
differs from D1.

**The render drain (feed-adapter contract).** The queue Release and the feed settings write
(`registry_render_queue`, Core's) is consumed by Core's `drainRenderQueue`, which hands each
owner's rows to Distribution's `registryMaterialiser` descriptor member. It runs in two places,
neither of which answers anyone: `dispatch.ts` after a request whose own statements enqueued a
render (detected by `watchRenderEnqueues` from the SQL text alone: it reads no data and adds no
query to any other request), inside `waitUntil`; and every cron tick, followed by the self-check
(at most `SELF_CHECK_BUDGET` = 50 re-renders per tick, and only for owners whose `packageFeeds` is
on). A render reads Release only through the `releaseCatalog` hook, writes only under its
`registry/<ecosystem>/<owner>/` prefix, and deletes a queue row only while its `generation` is the
one it read, so a concurrent publish is never lost. A row whose owner is gone, or has Distribution
off, is dropped: no request reaches a disabled service, and the next settings or `packageFeeds`
write enqueues a full render. A drain that fails leaves its rows queued and records the tick as
failed. The drain is an optimisation of freshness, never the guarantee: every read still compares
the stored render's stamp with D1 (`freshRegistryObject`, `readFreshRegistryObject`), so a slow,
failed or racing drain can delay a re-render but cannot make a feed serve a yanked version's
listing or a superseded tag.

**One adapter contract per feed.** Every feed is a `FeedAdapter`
(`registry/adapter.ts`): its routes (`feedRoute` only), renderer, ingest rules (its one
declaration in `@polaris-key/manifest`), settings, capabilities, OpenAPI rows and harness clients.
`test/feedAdapters.test.ts` runs the same checks against every adapter: each route carries the
`feedRoute` mark and answers under its own prefix; an unknown owner and a feed that is off answer
the host's one not-found byte for byte on every route; a non-public feed answers every route with
the challenge the adapter declares (and that `challengeFor` sends); a renderer stamped `package`
must render identically whatever the feed settings, so no stamp can hide a settings change; a
render's keys and types are ones the host admits. A new feed that skips any of this fails CI,
which turns the review of a new ecosystem into reviewing its own protocol code rather than
re-checking the shared gate.

**Every route is built by `feedRoute`.** `registry/serve.ts` `feedRoute` is the only way to
build a registry route: its handler runs the route's read-only lookup (`resolve`, e.g. a package
name to its deliverable), then `serveFeedRead` (the access ladder, then the Cache API, then the
route's work), then an optional `finish` that sees every answer after the ladder (OCI's API
version header, Swift's `Content-Version` and `Accept` checks). `test/registryHost.test.ts`
requires the `feedRoute` mark on every `REGISTRY_ROUTES` entry, so a hand-written handler that
skips the ladder fails the build. The mark stops accidents, not malice (a route could copy the
symbol); review catches the rest.

**How a package version gets in (F-03), and what keeps it out of everything else.**

- **Ingest abuse.** A package release enters only through the trusted-publishing submit
  (`requireCiScope`, the product's own token or OIDC publisher, an upload ticket, staged bytes
  verified by SHA-256 and size before anything is promoted) — never the GitHub sync, which refuses
  a package descriptor. The descriptor is bounded by the 64 KiB cap, at most 64 files (4,096 for
  OCI), metadata at most 16 KiB of a fixed per-ecosystem key set, `r2` locations only. The Worker
  never unzips: the CLI extracts the metadata, and the Worker checks its shape and that it agrees
  with the declaration (name, ecosystem, version). The only bytes it reads are each npm tarball's
  and Maven file's, once, streamed through `createHash` after promotion, for the digests those
  clients verify. A size ceiling per feed, never above the platform's per-ecosystem ceiling
  (`dist_registry_policy`), refuses an oversized release (`package-too-large`).
- **Unique forever.** `(product, ecosystem, normalised name, version)` is the primary key of
  `release_packages`, nothing deletes a row, and a yanked or deprecated version is a tombstone: it
  is never published again (`package-version-taken`), even byte-identical. That is what makes the
  protocol-fixed names (npm tarballs, Swift archives, Maven files) immutable for clients that
  cache by name, and Swift's trust-on-first-use safe.
- **Dependency confusion.** A feed takes only names in its operator-set namespace (npm and Swift
  scope, Maven group prefixes, PyPI names and prefixes, the Godot publisher), enforced at ingest
  (`package-namespace`); an ecosystem with no configured feed takes nothing. Names collide after
  each ecosystem's normalisation (PEP 503; case-insensitive npm, Swift, Maven), in the manifest
  (`package_name_collision`) and in the key. `upstream` is pinned to `none` by a CHECK, so no feed
  proxies a public registry. The residual risk is that no public name is claimed on npmjs or Maven
  Central (owner decision Q2: account-level claims only), which the setup docs warn about.
- **No signed record, no device surface.** A package release is never signed: a submit carrying
  a record with one is refused (`package-unsigned`), so no `pkey-release+jws` ever names a package
  and no SDK verifier sees one. Every device-facing read excludes packages: `releaseCatalog`'s
  `deliverables`, `release` and file/blob resolution, the channel feed and the update decision
  (both app-scoped and record-gated), the appcast, the records route (a forged `package` row is
  never served), the download page and the storefront feeds — each pinned by a test.
- **Supply chain of our own SDKs.** The platform packages belong to the system product
  (`polaris-key`), which only the audited platform bootstrap creates (manual create and link-repo
  refuse the slug; delete and rename refuse the row), published by trusted publishing only. Its
  Swift feed requires signed releases (`swift-unsigned`, never relaxed for the system product);
  the Worker checks presence and the `cms-1.0.0` format, SwiftPM verifies the chain.
- **Our release pipeline (F-10, automated 2026-10-04).** One reusable workflow,
  `publish-package.yml`, is the system product's only trusted publisher: `publish-sdks.yml` calls
  it for every package, GitHub names it in `job_workflow_ref`, and its job runs in the
  `package-registry` environment, whose deployment policy admits `main` and `v*` tags only; the job
  also refuses any other ref, any commit not on main and a channel that does not fit the version,
  and the publisher requires a ruleset-protected ref. Every push to `main` publishes a `-main.N`
  pre-release on the `main` channel (never npm's `latest`), so branch protection on `main` is now
  a publishing control as much as the `v*` tag ruleset. No workflow holds an npm, PyPI, Maven
  Central or registry token, so a compromised dependency of a PR job has nothing to publish with.
  The version is derived from git and stamped in CI; nothing a pull request writes chooses it. The
  Swift signing key lives only in `package-registry`'s secrets: the signing job decodes it into
  the runner's temp directory, never echoes it, and deletes it in an `always()` step; without it
  the job stops rather than publish unsigned. Residual: anyone who can push to `main` or push a
  protected release tag can publish a version (branch protection and the ruleset are the
  controls), and a version once published is immutable, so a bad release is yanked and
  superseded, never replaced.
- **The deploy hook (`POST /webhooks/deploy`, F-10 automation).** It bootstraps the system
  product, links it to the monorepo and applies the root `.pkey/` sent in its body: the package
  deliverables and the trusted publisher every SDK publish relies on. It is authenticated by the
  production deploy job's own GitHub Actions OIDC token, verified like a publisher's (RS256
  against GitHub's JWKS, the fixed issuer, `aud = <origin>/webhooks/deploy`, single-use `jti`
  through `idx_ci_tokens_jti`) and held to a policy only the Worker's configuration sets:
  `PLATFORM_REPOSITORY_ID` and `PLATFORM_REPOSITORY_OWNER_ID` (numeric, against renames), that
  repository's `.github/workflows/deploy.yml` at the triggering ref, a `refs/tags/v*` ref,
  `ref_protected`, a GitHub-hosted runner, the `production` environment. Without those vars the
  route does not exist. The body cannot name another repository (the manifest's provider must be
  the configured one, and the publisher's numeric ids come from the configuration, never the
  manifest), cannot touch another product (the slug must be the system product's, checked before
  anything is written), cannot re-enable a service, `packageFeeds` or a feed an operator switched
  off (the bootstrap only creates), and cannot overwrite an operator-claimed publisher or claimed
  access modes. A per-IP limit (fail closed) bounds unverified calls. Residual: the trust is the
  deploy job's, which already holds `CLOUDFLARE_API_TOKEN`; a token captured from that job could
  be replayed with a different body within its lifetime only if it was never used, and the job
  uses it at once.

**What remains (F-03, F-10).** Strict-router setup snippets keep each feed the only source of
its names. The owner publishes nothing to public registries and claims the public names at
account level only (open question Q2): the residual risk is a
misconfigured adopter resolving an attacker's same-named package from a public registry, which
the setup page warns about. Our SDKs reach the feeds only through trusted publishing, Swift
releases are signed, and the SDKs' own update path still verifies signed records. Godot ≤ 4.6's
`download_hash` and PyPI fragment hashes give integrity, not authenticity, and Godot 4.7+ verifies
no hash at all (below).

**Kill switches.** Per ecosystem, `dist_registry_policy.enabled`; per owner, `packageFeeds`;
per feed, `enabled`. Each takes effect within the settings window. The render queue
(`registry_render_queue`) is Core's, written in the same batch as the change it follows, and
carries ids only.

**The npm feed (F-04).** Version metadata is copied from the stored extract through an
allowlist, `name` and `version` come from the release row (never from the tarball), and every
read enforces the feed's scope: an unscoped name or one under another scope matches no package
and answers the not-found. A yanked version stays installable by exact version (npm has no yank)
but leaves every dist-tag and carries `deprecated`.

**The PyPI feed (F-05).** As built under the type allowlist above: the inert HTML form, escaped
tenant values, and files served only when name, hash and the owner's ref all match.

**The Swift feed (F-06).** SwiftPM pins an archive's checksum on first use (TOFU) and verifies
the `cms-1.0.0` signature the registry relays; the Worker checks only that a signed release
carries a signature of that format, never the certificate chain, so authenticity rests on the
client's trust roots and `onUnsigned`/`onUntrustedCertificate` settings, which the setup page
recommends as `error`. Mitigations on our side: an unsigned release is refused at ingest when the
feed requires signing (always for the system product); the manifests served are the signed
copies the publisher uploaded, by SHA-256, never re-extracted from the archive; a version's
archive, manifests and signature never change after publish, and a yank only marks it
unavailable in the release list (`problem` 410), so a pinned checksum never breaks or moves. The
`text/x-swift` manifests always leave as attachments under the sandbox CSP. `/identifiers` lists
only packages the feed holds and the reader may read, mapped by the operator-owned
`repositoryUrls` setting, so a publisher cannot claim another project's repository URL.
`POST …/login` (501) and `PUT` (405) are decided from the path alone, before any owner is
loaded, so neither probes an owner. Review trigger: Worker-side signature verification, or any
change that lets a version's bytes change after publish.

**Maven (F-07).** `maven-metadata.xml` and every checksum sidecar are derived on the server
(the metadata from Release's state, the sidecars from the digests computed at ingest), never
uploaded, so a publisher cannot ship a checksum that disagrees with its bytes. The paths are
parsed segment by segment (no escapes, no dot segments) and matched exactly against the declared
`groupId:artifactId`; files are looked up by name in the version's own file list and served from
the blob store by SHA-256, so no path reaches another package's or another owner's bytes. A
yank is not a takedown: Maven has no yank, so a yanked version leaves the metadata (no dynamic
version resolves to it) but its files stay downloadable by exact coordinates, as PyPI's PEP 592
yank does. Removing compromised bytes is an operator action outside tier 1's feed (residual).

**OCI pull (F-08).** `/v2/<owner>/<repository…>/{manifests,blobs,tags/list}`
(`services/distribution/registry/oci/`; tests: `test/registryOci.test.ts`,
`test-workerd/registryOci.test.ts`, the OCI rows of `registry-clients.yml`). Read-only: every
other method is 405 `UNSUPPORTED`, and `/v2/token` is the not-found until F-21.

- **No cross-repository reads.** A manifest or blob is served only when its digest is one of the
  files a version of THIS repository published (read through `releaseCatalog.packageVersions`),
  never merely because the bucket holds those bytes for another owner, repository or product.
  The owner is the first path segment and the repository is resolved under it, so one owner's
  repository can never name another's.
- **Bytes are what was verified.** Manifests and blobs are read from `blobs/sha256/<hex>` and
  answered only when R2's stored SHA-256 equals the digest asked for (`blobResponse`'s rule); the
  response's `Docker-Content-Digest` and ETag are that digest. A manifest leaves with its stored
  media type only when that type is one of the four manifest types on `REGISTRY_HOST_TYPES`;
  anything else is not served. Blobs are always `application/octet-stream` attachments.
- **Tags.** Version tags never move (a version is unique forever); channel tags (`latest`,
  `beta`, …) follow Release's channel heads and so never point at a yanked version. A yanked
  version loses its tag but stays pullable by digest, so a pinned reference keeps working; that
  is deliberate, and a yank is therefore not a recall (the same residual as PEP 592).
- **Cache.** Blobs (up to 5 GiB, ranged) bypass the Cache API (`serveFeedRead`'s
  `cacheApi: false`); the access ladder still runs first. Manifests by tag and tag lists are
  60-second index documents, so a channel move or a yank shows within a minute. The rendered tag
  documents carry a stamp of the package's D1 state and are re-rendered on read when it differs,
  so a stale R2 object is never served.

**The Godot feed (F-09).** Both editor API shapes are served. Godot ≤ 4.6 compares the zip it
downloads with `download_hash`, the SHA-256 the feed always sends; **Godot 4.7+ verifies no hash
(the editor hands an empty one to its installer), so a 4.7+ editor install relies on TLS alone**.
The bytes are still content-addressed (`files/<sha256>/…`, `icons/<sha256>.png`), `hasRef`-checked
for the owner and served as `application/zip` or `image/png` attachments with the host's
headers. The Polaris Key SDK's own update path verifies signed records, never the store download.
`plugin.cfg`'s name, author and description leave only as JSON strings; the 4.7 `body_bbcode` and
`body_html` copies are escaped, so the editor renders them as text. The two searches filter the
owner's short list in memory and page their output (at most 500 rows, 100 for 4.7); every
document goes through the same ladder and cache key rules (the repeated `licenses` parameter and
the valueless `reverse` flag are normalised into the key, so variants cannot share an entry). A
package stricter than its feed is left out of every list. The per-package documents are read
fresh: a stored render whose stamp (package rows plus feed settings) differs from D1 is rendered
again before it is served, so a yank is never hidden behind a stale document.

**The Feeds console and its admin API (F-11).** `/manage/api/platform/feeds/*` and
`/manage/api/products/<slug>/distribution/feeds/*` (`admin/handlers/feeds.ts`) sit behind the
same session, CSRF, limiter and platform-admin gates as every admin route (403 otherwise; there
is no per-product admin). Every write is audited with the verified actor: `feed.settings.update`,
`feed.rebuild` and `package.version.{yank,unyank,deprecate,undeprecate}` under the owning
product, `feed.policy.update` and `feed.bootstrap` in `platform_audit`. Settings and policy
writes are optimistic (`expectedVersion`, 409 on a stale version) and validated per ecosystem:
unknown fields, a malformed namespace or extension key, a size above the platform ceiling and
any upstream but `none` are refused, a feed cannot be enabled with an empty namespace, and only
`public` access can be set until registry credentials exist (`access_mode_unavailable`), so no
console save can turn a feed into one that refuses every client. A version verb the protocol
has no state for is refused (`unsupported_by_ecosystem`) rather than recorded as a console-only
fiction; the verbs that apply run Release's own yank, unyank and deprecation (the same batch,
render enqueue and pack-set invalidation as Release's routes). There is no delete. A write drops
its isolate's cached registry settings; other isolates follow within the 30-second TTL. Tests:
`test/adminFeeds.test.ts`.

### App-updater feeds (P3-09)

**What arrived.** Update renders the native updaters' feeds from the CI-signed release records and
Distribution's per-outlet state (`services/update/updaterFeeds.ts`, `updaterRender.ts`,
`artifactBytes.ts`; tests: `test/updaterFeeds.test.ts`): an extended Sparkle appcast (for a
product with records), a WinSparkle appcast, a Velopack feed, an MSIX `.appinstaller` and an
AppImage `.zsync` per channel, and an extended `/update/version`. They are new public routes that
tell an updater which bytes to install, so they sit next to AT-3. Distribution's `delivery` hook
gained two read-only methods, `feedSelection` (P2b-05's selection, offered to Update) and
`feedStamp`. A descriptor `delta` artifact may name its `deltaFrom`, stored in
`release_artifacts.metadata_json`. The `app-installer` outlet identity gained `publisher` and
`updateSettings`.

- **Only signed releases, only through the selection.** A feed lists only releases with a stored
  release record (P3-03's ingest checks), chosen by P2b-05's rules: not yanked, not held by a
  rollout on the outlet, live there, with an immutable delivery URL. So a halt or a yank removes a
  release from every feed on the next request, and the cache stamp moves with them. Every file a
  feed points a client at beside the payload (a Sparkle or Velopack delta, a `.zsync` control
  file, a `.sig` sidecar) must be one the descriptor named for that build, in that role
  (`release_artifacts.build_id` and `role`). A release-level row is never used: that is what the
  GitHub sync writes for an asset the descriptor did not name, with build_id NULL and only
  GitHub's own digest. So whoever can write to the GitHub release without holding the release key
  can neither list a release nor add a file to a listed one.
- **No updater payload is signed or trusted here.** `sparkle:edSignature` is CI's sidecar,
  verified over the payload's stored bytes against the configured Sparkle key before it is
  rendered. The verifier is P0-10's streaming one, so nothing is buffered, and verdicts are
  memoised under the payload's SHA-256, whose stream is pinned to that digest. With a key, an
  unverifiable enclosure is left out. Velopack's `SHA1` is computed by a streaming digest that
  checks the recorded SHA-256 and size first. A `.zsync` control file is read whole (at most
  16 MiB), checked against its recorded SHA-256, and refused unless its `Length:` matches the
  AppImage. A header that names another source or process (`Z-URL:`, `Z-Map2:`, `Recompress:`)
  is refused, so `URL:` is the only place a client is sent. Only that header is rewritten, to our
  own immutable delivery URL. Bytes are read
  only from R2 (a non-gated content address this product holds a ref to) or from GitHub through
  Release's `openSource`, never from an external URL.
- **Access is the appcast's.** Each feed runs the release gateway's access rule. The delivery
  access governs the feeds, and the metadata mode governs the version check. Only a `public`
  answer is cached (Core's feed cache, keyed by path, the inputs the renderer reads, and the
  state stamp) or marked `public`. Any other mode needs a licence on every request and answers
  `private, no-store`. No CORS is added. Responses carry `nosniff` and the platform headers.
  `application/appinstaller`, `application/x-zsync` and XML are served on the console origin
  that holds sessions, with `nosniff` and no HTML type.
- **Cost (DoS).** Every request to the appcasts, the extended version check and the four new
  feeds first reads the product's recorded release ids (one narrow `SELECT DISTINCT release_id`
  on `release_records`, covered by its unique index; never the JWS bytes). A product with no
  record then takes the legacy appcast path, so a legacy appcast costs that one extra read. For a
  product with records, the `updateFeed` per-IP limit (60 per minute, fail-open) runs next, before
  any other read. A cache hit then costs the release config, the delivery access and the stamp:
  the metadata access, the rollouts, one row of availability and outlet counters, the yanks and
  the channel policies. That is eight D1 reads beyond the dispatcher's own product lookup. Only a
  miss renders: one bounded selection (P2b-05's ceiling) plus, per listed build, its `.sig`
  sidecar (Sparkle and WinSparkle, at most three releases), or, for zsync, one `.zsync` control
  file (at most 16 MiB). A signature verification or a SHA-1 streams a payload once per release,
  then is memoised: verdicts for 30 days, negatives for a day, a SHA-1 for a year. A
  non-public answer is never cached, so it pays the render on every request, behind the licence
  check. The cache key carries every input the body depends on. That includes the
  `.appinstaller`'s rendered `Uri`, so one spelling of `?arch=` cannot plant its `Uri` in
  another's cached answer.
- **The Velopack package route (notes/S-11 §5.1).** The Velopack feed names each package by its
  bare `FileName`, because Velopack's Rust core also saves to `packages_dir.join(FileName)` and an
  absolute URL fails that write. The client resolves the name against the feed URL, so
  `GET /<p>/update/<channel>/velopack/<FileName>` answers a `302` to the package's immutable
  delivery URL. It is not a new way in. The name must be one plain `.nupkg` file name (a fixed
  alphabet, no separator, no `..`, no leading dot, no escape) before any read, the D1 read of
  the recorded releases included. The router does not percent-decode, so `%2F`, and a `%2e`
  inside a name, are refused for their `%`. A segment that is wholly `%2e` or `%2e%2e` (any case,
  or mixed with `.`) never reaches the route as a name: the URL parser normalises it to a dot
  segment and resolves it before routing, so the path the router sees has no such segment. The route runs the feed's own pipeline:
  the same `updateFeed` limit, the same access decision (`kind: velopack`), and the same cache rule.
  It redirects only to a package the feed lists for one of the six Velopack targets: the same
  selection (`velopackCandidates`) and the same SHA-1 check over the stored bytes. So a yank or
  halt removes a package from the route on the next request. A caller refused the feed is refused
  the route with the same answer, an unknown name included. `Location` is always our own delivery
  URL, which checks the delivery access again on its own. Under a non-public delivery a client that
  drops `Authorization` on the redirect is refused at the second hop, which fails closed.
- **Residual.** The `deltaFrom`, the App Installer identity and update settings, and the build
  format that picks WinSparkle's installer arguments are CI or manifest claims. A wrong value makes
  an updater fail or fall back to the full package. It never changes which bytes are served,
  because every URL is a hash-pinned delivery URL. `UpdateBlocksActivation` can make App Installer
  block launch on an update, which is a manifest owner's UX choice; `ForceUpdateFromAnyVersion`
  (downgrades) is not offered. The Sparkle rollout mapping is coarse (seven groups), and a
  floor-critical item skips phasing for installs below the floor, as Sparkle defines it.

### Outlet credentials (P5-01)

**What they are.** The keys a store connector authenticates with (A11): an App Store Connect API
key (`.p8`), the App Store Connect webhook secret, a Google service-account key, a
Partner Center client secret. Each is worth as much as the release channel (A3) — whoever holds
one can ship to that store as the operator.

**Reach differs by store.** A Partner Center client secret (`ms-partner-center`) is the widest:
Microsoft's submission API needs the Entra application to hold the Manager role, which covers
every app of the seller account and has no per-app scope. The Microsoft Store connector (P5-04)
uses it read-only and pinned to one Store ID ("Store connectors: Microsoft Store", below), but a
stolen secret is not limited by either.

**Why not a product secret.** Edge-mint opens any product secret an operator marked `edge-mint`
(`services/config/mint.ts`) for **any device of the product**, and under open registration anyone
can be a device. A `.p8` stored as a product secret would be one approval away from a public App
Store Connect token mint. So outlet credentials have their own table, their own AAD kind and one
accessor.

**The boundary**, each line enforced by a test:

- **Own table, own AAD kind.** `outlet_credentials.enc_value_json` is sealed under
  `pkey:v2:<product>:outlet-credential:<credential_id>`. A blob copied into `product_secrets`
  does not open there, a product secret copied in does not open here, and an edge-mint recipe
  naming an outlet credential id answers `misconfigured`
  (`test/attack/R12-outlet-credentials.test.ts`).
- **One accessor, reachable from one service.** `core/outletCredentials.ts` is imported only by
  `src/services/distribution/**`, `core/outletTokens.ts` and the Core admin handler
  (`admin/handlers/outletCredentials.ts`); only the owner, the KEK re-seal sweep and
  `deleteProduct` name the table; only the vault, the owner, the token helpers and the sweep spell
  the AAD kind; and only the owner and the Core admin handler name the writers
  `putOutletCredential` / `pinOutletCredential` / `deleteOutletCredential`
  (`test/outletCredentialReach.test.ts`). In
  particular Config (edge-mint) and `core/products.ts` (`openProductSecret`) cannot reach it, and
  no manifest ingest, resync, service hook — nor a Distribution connector, webhook handler or
  route, even though Distribution may import the module to open — can write or delete a row.
- **Platform-admin, write-only.** `PUT …/outlet-credentials/<id>` (platform admin only, checked
  again in the handler) validates per kind — a `.p8` must be a P-256 PKCS#8 key, a Google key must
  be RSA and name exactly `https://oauth2.googleapis.com/token`, so a stored credential can never
  make the Worker post a signed assertion to a host of the writer's choosing — and echoes the id
  only. `GET` returns metadata (`meta_json`: key id, issuer id, client email, tenant, client and
  seller ids, and the pin below) and health, never a value; the sealed column is never selected.
- **The operator names the app (P5-02f).** A kind whose key reaches more than one store app
  carries an operator-owned **pin** (`OUTLET_CREDENTIAL_PINS`: today `asc-api-key` → `appleId`),
  the one app its connector may read and act on. It is stored in `meta_json` (not secret, not
  sealed), written only by the Core admin handler — with a value, or alone (`{kind, pin}`, which
  touches neither the sealed blob nor its version marker) — and never taken from a value field
  (the kind's projection is written first, the pin over it). A rotation without `pin` keeps the
  stored one. Every change is its own `outlet_credential.pin` audit row with the old and new pin.
  A connector compares it with the manifest's outlet identity (`checkOutletCredentialPin`) before
  it opens anything; a missing pin is refused like a wrong one. The connector section below says
  what that closes.
- **Every use audited, fail closed.** `openOutletCredential(env, db, product, id, use)` appends an
  `outlet_credential.use` row (actor `system:distribution`, the `use`, the outcome) on every call,
  usable or not, and answers `null` — "unusable credential" — for an unknown id, a disabled row,
  the wrong kind, a value that will not open or re-validate, or an invalid `use`.
- **Tokens sealed at rest, checked before any open.** `core/outletTokens.ts` caches Google access
  tokens in KV sealed under the same AAD kind (id `token:<credential_id>:<hash>`; a credential id
  cannot contain `:`, so a token slot can never be opened as a credential). The slot is a hash of
  the scopes and the credential's non-secret **version marker** (`outletCredentialVersion`: a hash
  of the sealed blob, read without decrypting), so a rotated value never serves its predecessor's
  token and the cache is checked before the credential is opened: a hit costs no decryption, no
  audit row and no D1 write. App Store Connect JWTs (≤ 20 minutes) are memoised per isolate only,
  keyed the same way. A failed exchange throws with the HTTP status, never the body. Because a hit
  hands out a store bearer token without an audited open, `core/outletTokens.ts` is itself a
  custody boundary: only `src/services/distribution/**` may import it (the reach test).
- **Rotation and deletion.** The KEK sweep counts and re-seals the table like `product_secrets`;
  deleting a product deletes its rows in the same batch.

**Residual risk.** A11 is still under A1: a `PLATFORM_KEK` compromise opens every outlet
credential. The admin plane (A4) can overwrite a credential (but not read one back). A connector
bug in the Distribution service could misuse an opened value or a cached token; the audit row per
open is the detection, and because token caches are checked first, opens stay at tens a day per
credential, so that signal is not buried. A path that needs the raw value on every request —
verifying an inbound App Store Connect webhook against `asc-webhook-secret` (P5-02) — opens it
every time, and each open is two D1 writes; such a path must authenticate or rate-limit the request
before the open, or it becomes an unauthenticated write amplifier (the R1-04 class). P5-02 does
both what it can before the open: the signature header's shape is checked, and the delivery is
rate-limited per product, fail closed (next section). That bounds the amplification; it does not
keep the signal quiet: anyone can send a well-formed header, so `asc-webhook-secret` can be made
to log up to 60 opens a minute per product, and its "tens a day" baseline does not hold under
attack (next section, Residual). Least privilege per store (App Manager team key; one-app Play service account; Partner
Center Manager role) is documented for operators in `admin/secrets-and-keys.md` but cannot be
verified by the Worker.

### Platform store connections: team-level credentials (A-16)

**What they are.** One credential per store held by the PLATFORM, not by a product (owner
decision 2026-10-04): the App Store Connect team API key (`app-store.api-key`), the team In-App
Purchase key (`app-store.in-app-purchase-key`), the Google Play developer account's service
account (`google-play.service-account`), the seller's Partner Center app
(`microsoft-store.partner-center`) and the Steam group's publisher key (`steam.publisher-key`).
Each reaches **every app of the team, account, seller or group** — so its loss is the union of
every product's outlet credential (A11, ranked with the release channel A3), and the Apple ones
also every app's transaction history. Beside them, non-secret settings shared by every product:
the Apple Team ID (App Attest's default), Google Play's RTDN push identity and the Play Integrity
cloud project number.

**What they are for.** Listing every app the team credential can see (with its release status),
assigning an app to a product from that list, and a product's connector or commerce context
falling back to the team credential when the product has no credential of the kind of its own.

**The boundary**, each line enforced by a test (`test/platformStore*.test.ts`,
`test/outletCredentialReach.test.ts`):

- **Two sources, console first.** (a) `platform_credentials`, sealed under PLATFORM_KEK with the
  AAD `pkey:v2:_platform:platform-credential:<id>` — `_platform` cannot be a product slug and the
  kind is its own, so a blob copied into `outlet_credentials` or `product_secrets` opens nowhere;
  (b) a Worker secret (`PLATFORM_ASC_API_KEY`, `PLATFORM_APP_STORE_SERVER_KEY`,
  `PLATFORM_GOOGLE_SERVICE_ACCOUNT`, `PLATFORM_MS_PARTNER_CENTER`, `PLATFORM_STEAM_PUBLISHER_KEY`)
  read only when no active console row exists. Both are validated by the kind's own
  outlet-credential validator (the Google key must name Google's one token endpoint) on write and
  again on every open. The KEK sweep counts and re-seals the table.
- **The pin is the boundary.** A product may use a team credential ONLY for the one app a
  platform admin assigned to it: its row in `platform_credential_pins` (the `appleId`, bundle id,
  package name, Store ID or Steam app id) must equal the app the product is about to act on.
  It is checked three times: by the connector's setup (no pin or a different pin → inert, the same
  `pin_missing` / `pin_mismatch` reasons and 409s as P5-02f, nothing sent, nothing opened), by the
  token helper BEFORE its memo or sealed cache (a cached team token is the same bearer for every
  product, so a cache hit must never stand in for the pin), and by `openPlatformCredential`
  itself, which refuses a product purpose whose pin does not match and audits the refusal.
  `UNIQUE (credential_id, pin)` makes "one product per app" a table constraint, the assignment
  route also refuses an app another product's OWN credential is pinned to, and the
  outlet-credentials PUT refuses to pin a product's own key to an app the platform serves to
  another product (409 `app_assigned_elsewhere`). Deleting a product deletes its pins.
- **Own credentials first, never a fall-through.** A product holding any active credential of the
  kind uses its own; an own credential that is unpinned or mis-pinned is inert on its own terms
  and never silently switches to the team key.
- **Platform-admin writes, metadata out.** `/manage/api/platform/store-connections/…` is
  platform-admin only (403 otherwise, checked in the handler). Responses carry presence, source
  (`console` / `secret`) and display metadata (key id, issuer id, client email, tenant, client and
  seller ids) — never a key; a 422 names the field, never the value. Only the owner and that
  handler name the writers (`putPlatformCredential`, `deletePlatformCredential`, `setPlatformPin`,
  `clearPlatformPin`); only the owner, the KEK sweep and `deleteProduct` name the tables; only the
  owner, `core/outletTokens.ts` and two reviewed Distribution files (the Microsoft Store token, the
  Steam commerce key, both re-checked by the open) name `openPlatformCredential`.
- **Every use and write audited.** A product open is a `platform_credential.use` row in that
  product's trail; a team-wide open (the apps listing), every credential and setting write and
  every assignment are rows of `platform_audit` (A-12's table, through `appendPlatformAudit`; read
  by `GET /manage/api/platform/activity`, pruned with it after 180 days); an assignment is also
  `outlet_credential.pin` in the product's trail. Audit payloads carry metadata and pins, never
  key material. By design a token served from the per-isolate memo (App Store) or the sealed KV
  cache (Google, Microsoft) is **not** audited — only the open that minted it is — exactly as for
  product outlet credentials; the pin is checked before every such hit.
- **Bounded, redirect-free reads.** The listings use each store's fixed host with
  `redirect: "manual"` and capped bodies: App Store Connect `GET /v1/apps` (at most 5 pages of 200,
  versions and TestFlight versions as includes, at most 20 phased-release reads); Play Reporting
  `apps:search` (at most 3 pages) plus, only on an explicit `?tracks=1` and never from the
  assignment path, at most 10 short edits that are deleted, never committed;
  Partner Center `GET /v1.0/my/applications` (at most 5 pages of 100) plus at most 10 submission
  reads; Steam `GetPartnerAppListForWebAPIKey` on the publisher host (the key in the query string,
  as every Steam call). Results are cached 60 s in KV, keyed by the credential's version marker;
  assignments are joined fresh from D1.

**Residual risk.** A team credential is the widest key the platform holds: a `PLATFORM_KEK`
compromise (A1) or a Worker-secret leak hands an attacker every app of the team, not one product.
The admin plane (A4) can assign any visible app to any product, which is the intended power of a
platform admin; the audit trail is the detection. A Worker secret sits in Cloudflare's secret
store, outside the KEK and the console's rotation; prefer the console credential and keep the
secret for bootstrap. The Play listing's opt-in track read (`?tracks=1`) opens short edits that share the service account's one-open-edit
slot with that account's product connectors: a listing can invalidate an edit a poll holds at that
moment (the poll fails and retries next tick). The Steam publisher key travels in query strings to
Steam's publisher host by Steam's design. Least privilege per store (the
narrowest Play permissions, the Partner Center Manager role, a dedicated Steam publisher key) is
the operator's to configure and cannot be verified by the Worker. For App Store Connect the owner
chose to keep the Admin team key (2026-10-04), so the write gate of A-17a (below) is the control.

### App Store Connect writes: the write gate, the ledger and the budget (A-17a)

**What it is.** `core/asc/` is the substrate every App Store Connect call goes through (notes/S-14
§7): the client (moved here from P5-02's connector), the **write gate** (`writeGate.ts`), the
**operation ledger** (`ledger.ts`, table `asc_operations`), the **before-and-after projection and
audit** (`audit.ts`) and the **budget meter** (`budget.ts`). A-17's provisioning and distribution
flows (A-17b to A-17e) build on it; P5-02's controls already run through it.

**Why it matters (owner decision 1, 2026-10-04).** The Worker holds the team key with the **Admin**
role (A11b): the owner declined a narrower App Manager key. An Admin key can invite users and change
their roles, create certificates (Developer ID included in the type enum) and revoke them, delete
bundle ids, and change prices, for every app of the team. **The write gate is the only control
between a compromised Worker path or a stolen console session and those powers.**

**New outbound actions.** The Worker gains write calls to `api.appstoreconnect.apple.com` (the one
fixed host, P5-02's SSRF rules: `redirect: "manual"`, bounded bodies, `links.next` followed only to
the same origin and `/v1/` or `/v2/`), and A-17c adds test-notification calls to
`api.storekit(-sandbox).apple.com` (P6-01's hosts).

**Controls**, each enforced by a test (`test/ascWriteGate.test.ts`, `test/ascLedger.test.ts`,
`test/ascControls.test.ts`, `test/ascWriteReach.test.ts`, `test/ascDistribute.test.ts`):

- **(a) Deny by default, before the token.** `AscClient` calls `checkAscRequest` before its token
  thunk: a write passes only when an `ASC_WRITE_ALLOW` rule matches its method and path template
  exactly and its JSON:API body (resource type, every attribute key, every relationship name and
  identifier type, `included` types, the rule's value checks: non-consumable IAPs only, the gate's
  capability types, export compliance but never `expired`, the notification and webhook URLs fixed
  to the product's own hook shape on the origin the handler asserts as its own, `hookOrigin`).
  Anything else throws `AscWriteDenied`: no token is minted and nothing is sent. The client
  serialises a body once and gates the parsed form of that exact string, so what is checked is what
  is sent. **No rule is a `DELETE`**, and none touches users, invitations, certificates,
  devices or profiles; reads of `/v1/users*` and `/v1/userInvitations*` are refused too (personal
  data, matched case-insensitively). The approved surface is S-14 §7.5 with the owner's
  corrections (no relationship `DELETE`s).
- **(a″) No way around the client.** A source scan (`test/ascWriteReach.test.ts`) keeps the ASC
  token minters (`ascToken`, `platformAscToken`) and `new AscClient(` to the two files that build
  the gated client (`connectors/asc/run.ts`, `platform.ts`), and the API host
  `api.appstoreconnect.apple.com` to `core/asc/client.ts`, so no raw `fetch` with a bearer token
  can skip the gate. Adding a file to either list is a custody review.
- **(a′) Every spec write classified, in CI.** A pinned copy of the write operations of Apple's
  OpenAPI document 4.5 (`test/fixtures/asc/openapi-writes.json`, generated from the spec with
  SHA-256 `ASC_SPEC_PIN`) must be classified exactly once, allowed or denied with a reason
  (`writeGateDenied.ts`); every denied operation is exercised against the gate. A spec bump fails
  until every new write is classified.
- **(b) No generic proxy.** Each operation is a named handler; no route forwards a method, path or
  body from a request.
- **(c) Pin and ownership.** Product-scope writes resolve the app from the product's pin and
  re-read an existing object's app before writing (P5-02's `proveVersion`, S-14 §7.2). A-17d's
  Distribute handlers (`connectors/asc/distribute.ts`) never take an app id: every `app`
  relationship they create is the pinned app, and every build, beta group, App Store version or
  review submission a request names is re-read with `include=app` and must be the pinned app's,
  all of them before the first write (a request listing one foreign group sends nothing).
- **(d) Typed confirmation.** Release, submit for review and price changes require the operator to
  type the app's name; the handler compares it with Apple's current value and only then asserts
  `typedConfirmation` to the gate, which refuses those operations without it. A first price
  schedule or availability needs the handler's `initial` assertion (its pre-read found none).
  P5-02's `release` control takes `confirm` since A-17a, and the console's **Release this
  version** is an L3 action whose dialog asks for the app's name. A-17d's `distribute/submit`
  uses the same server-side comparison before it opens or touches a review submission;
  cancelling a submission is a plain confirm.
- **(e) Ledger and audit.** Every A-17 step is an `asc_operations` row keyed by
  `sha256(scope, product, op, natural key, Idempotency-Key)`: a replay returns the stored result
  without calling Apple, a reused key with another body is refused, a 5xx or timeout after a write
  is `ambiguous` and the next attempt re-reads the natural key first. Before and after are Apple's
  own reads projected through a per-type allow-list; passwords, secrets, emails, phone numbers,
  testers' names and contact fields are never stored, nor any request or Apple error body (only the
  status and Apple's `errors[].code` token). One audit row per write: `distribution.asc.<op>` in
  the product's trail, `platform.asc.<op>` in `platform_audit` for team scope. A natural key
  containing `@` is refused, so a tester's email never becomes a stored key.
- **(f) Budget meter.** Apple meters per key (3,600 per hour, measured). The team key has one
  platform-wide KV slot fed by the poller, the apps listing and A-17's flows; background work stops
  at 20 % left and the poller at 5 %, while an operator's control is never refused, so one
  product's flow cannot starve every other product's poller.

**Team provisioning (A-17b).** `core/ascProvisioning.ts` and
`admin/handlers/platformStoreProvisioning.ts` (`/manage/api/platform/store-connections/app-store/…`,
platform admins only) are the New-app wizard's team-scope operations: register a bundle id, enable
the wizard's capability types (a subset of the gate's), look an app up by bundle id, and read
certificate and profile expiry. Each write is one ledger step through the gated team client and one
`platform.asc.<op>` row. The handler file imports neither the platform credential module nor a
token minter (the reach scans stay unchanged). Two controls are specific to it: **(d′)** enabling
a capability on a bundle id whose app (or In-App Purchase key bundle-id pin) another product holds
needs that app's name typed in `confirm` (a handler check: the gate cannot know who holds a bundle
id); and the signing read names its fields, so a certificate's content and serial number and a
profile's content are never requested, stored or answered. The wizard's 10-second app detection
(`apps/lookup?poll=1`) is `background` spending and pauses below 20 % of the team budget.

**Product app setup (A-17c, `connectors/asc/provision.ts`).** The setup controls run under the
same gate, ledger and audit, with these choices of their own (`test/ascProvision.test.ts`):

- **The app is the pin's.** A control targets the app `resolveAscSetup` names. With no Apple outlet
  declared yet (the New-app wizard) and no key of the product's own, the platform team key's pin
  for the product names it; a manifest that names an app still wins and a mismatch stays refused.
  A beta group a request names is re-read with `include=app` before a tester is added to it.
- **The notification URL is fixed server-side** as
  `<request origin>/<slug>/distribution/hooks/app-store` (and the gate admits nothing else). Apple
  answers the `PATCH` without keeping it (A-17h), so the control trusts only its verification
  re-read and otherwise answers the App Information deep link; it never reports an echo as
  success.
- **Testers' emails are sent to Apple once and stored nowhere.** A tester's ledger natural key and
  request hash carry an HMAC of the email keyed with `KEY_HASH_PEPPER` and the never-stored
  Idempotency-Key; the answer and the audit summary name no address.
- **The test notification** calls the App Store Server API (`api.storekit(-sandbox).apple.com`)
  through `commerce/apple.ts` with the In-App Purchase key pinned to the bundle id Apple reports
  for the pinned app; it is audited (`distribution.asc.notifications.test`). It can only make Apple
  send a `TEST` to the URL already configured.
- **Defaults are only set, never changed.** Availability (every territory) and the free price are
  sent only when the pre-read finds none (`initial`); an existing price or availability is left
  alone.

**Attack tree: stolen admin session → Apple account.** With the gate in place a stolen session
stays inside A-17's surface: it CAN register bundle ids and enable the gate's capability types,
create TestFlight groups and add testers, create non-consumable IAPs, submit and release (typing the
app's name, which it can read), and point the notification URL and webhook at the product's own
`/<slug>/distribution/hooks/…` path on a Worker host. It CANNOT add or change users, mint or revoke
certificates, register devices, delete anything, or send any request the allow table does not name.

**Residual risk.** The gate is code in the same Worker that holds the key: a compromise of the
Worker's code or of `PLATFORM_KEK` (A1) bypasses it, and then A11b is lost in full. The owner
accepted this instead of a second, App Manager key. The hook URLs are bound to the origin the
handler asserts (the request's own), so a handler that passed a wrong `hookOrigin` would widen that
check. Two concurrent requests under one Idempotency-Key can both proceed (the `find` pre-read and
Apple's own duplicate refusal bound the harm). The 429 response shape has not been observed
(A-17h).

### Store connectors: App Store Connect (P5-02)

**What it is.** `services/distribution/connectors/asc/` keeps a product's App Store and TestFlight
state in Distribution: availability and submissions (`source = asc`), the phased release mirrored
into `dist_rollouts` (`mirrored = 1`), and Background Asset version states as connector objects
(`dist_connector_objects`, unresolved until P5-08 maps asset packs to pack releases). Three entry
points: Apple's signed webhook `POST /<p>/distribution/hooks/asc`, a poller on a 15-minute cron
(`CONNECTOR_POLL_CRON`), and operator controls in the console (`…/distribution/connectors/asc/…`:
phased release pause/resume/complete, release a held version, the TestFlight public link,
register the webhook). It authenticates to Apple with the `asc-api-key` outlet credential (P5-01)
and verifies Apple with `asc-webhook-secret`; it never writes a credential.

**Webhook forgery.** `x-apple-signature: hmacsha256=<hex>` is HMAC-SHA256 over the raw body with
the product's own `asc-webhook-secret`, compared in constant time. A missing header, another
scheme (`sha256=`, `hmacsha1=`, upper case) or a short MAC is refused 401 before anything is
opened or counted; a body over 64 KiB is 413. The secret is per product, so a secret leaked from
one product forges nothing for another. Even a valid signature is only a HINT: the handler never
writes what the payload says. It re-reads the instance from the App Store Connect API with the
product's own key and writes only what that GET says — a forged or replayed payload can at worst
make the Worker re-read a real object.

**Cross-app writes (ownership fails closed, against the app the manifest names).** The `asc-api-key` the brief asks for is a team key,
so it can read every app in the team, and the instance a signed payload names can be any of them.
Before storing or writing anything, every path proves the object is the outlet's app: the GET asks
for `include=app` (the real API puts relationship `data` in a response only when the relationship
is included) and an absent or different `app` is treated as foreign — no connector object, no
availability, outcome `ignored`. App Store versions, builds and build uploads carry `app`
themselves; a beta detail is proven through its build; a Background Asset version or release
through the chain release → version → asset, with `backgroundAssets/{id}?include=app` as the
check, each link read from the primary data of its own GET. A build upload that cannot be proven
writes nothing, whatever its state, and is never followed into the build it names. The poller's
lists are app-scoped by their endpoint (`/v1/apps/{appleId}/…`, `/v1/builds?filter[app]=…`); a
reconciled object that is gone or no longer provable is retired (`terminal = 1`), never updated.
The state-changing controls hold to the same rule before they write, because a team key's write
to another app's version (releasing it, completing its phased release) cannot be undone by a later
re-read: `release` and `phased-release/*` act only on a stored version whose `ascAppId` is the
app the setup names now (a row stored while the outlet named another app is invisible to them),
and first re-read it with `include=app`, sending nothing unless Apple answers that it is this
app's version of that release; `testflight/public-link` proves its beta group with
`betaGroups/{id}?include=app`. The test fake (`test/ascFake.ts`) answers relationships the same way, so a test cannot pass on
data the real API would not send.

**Who picks "the outlet's app".** Every check above compares against `appleId`, which the setup
reads from `dist_outlets.identity_json`. That column is manifest-owned (migration 0036: every
resync rewrites it), so it comes from `.pkey/distribution`, and whoever can push that file picks
the app. The credential is the other way round: an operator stores the `asc-api-key`, it is a
team key, and the operator docs suggest one key may serve several products. The ownership checks
therefore stop a payload, a webhook or a stale row from reaching another app. They do NOT stop a
repo writer of product Q, the actor P2b-02 already treats as a third party, from setting Q's
`appleId` to any other app the team key can see. The next resync then makes the connector, with
the operator's key:

- mirror that app's versions, builds, phased release and held state into Q's tables, Q's
  console view and Q's `delivery()` availability;
- register the webhook (the `webhook` control) on that app;
- point the console controls at that app's versions. The repo writer also publishes Q's
  releases, so they can publish one whose version string matches the other app's
  `PENDING_DEVELOPER_RELEASE` version. A platform admin who then presses `release` or
  `phased-release/complete` on Q releases or completes the other app's version, which cannot be
  undone.

That was a confused deputy over every app the key can see, and P5-02 shipped with it as a
documented residual. **P5-02f closes it with the operator's pin.** The `asc-api-key` carries the
`appleId` a platform admin chose (P5-01 section, "The operator names the app"), and the setup
(`connectors/asc/setup.ts`, `resolveAscSetup`) exists only when the chosen key's pin equals the
manifest's `appleId`. Otherwise the connector is inert, before any token is minted or credential
opened: the poller skips the product (`credential-pin-missing` / `credential-pin-mismatch`), the
webhook answers Core's not-found shape (so a delivery for the old app mirrors nothing), every
control answers 409 `credential_pin_missing` / `credential_pin_mismatch` and sends nothing, and
`GET …/distribution/connectors/asc` shows why (`inert`: the manifest's app, the chosen key, the
pinned app). A repo writer who changes the outlet's `appleId` therefore stops the connector
instead of aiming it; it stays stopped until the manifest names the pinned app again or a
platform admin re-pins, which is audited. The pin is checked on the credential the setup picks (a
bound key before an unbound one), so a second key's matching pin never stands in for it. The
ownership checks above then hold against an app the operator chose, not one the repo chose
(`test/ascPin.test.ts`).

**Replay.** Deliveries are deduplicated on `data.id`: a KV marker (7 days, like the GitHub
webhook) and the `dist_connector_events` primary key. A redelivery answers 200 `{duplicate: true}`
and makes no API call and no write.

**Lost follow-ups.** The webhook answers before it re-reads the instance. A follow-up that fails
records `failed` on the event row and drops the KV marker; one cut off before it records anything
leaves `received`. The poll tick re-drives both (`poll.ts` step 4): up to 5 events a tick, received
in the last 24 hours, `received` ones only 5 minutes on, each re-read through the same ownership
chain as the webhook, the row's outcome moved to what that read came to. An older event waits for
a manual redelivery (Apple allows one resend per delivery, notes/E1 §A1), which the dropped
marker lets through. A delivery the route REFUSED (401, 413, 429) was never stored and is not
re-driven, and Apple does not retry it on its own: notes/E1 documents only the manual resend. App
Store versions, builds and phased release still come back on the next 15-minute tick, because the
poller lists them; a Background Asset version or release that the refused delivery named first
does not, since nothing lists them — it is read when Apple sends its next event for it, or when an
operator resends the delivery from App Store Connect.

**Write amplification.** Each secret open is an audit row and a D1 write (P5-01), so deliveries
are rate-limited per product (`ascWebhook`, 60 a minute) BEFORE the open, and the limiter fails
CLOSED: with the limiter down the route answers 429 rather than letting an unsigned flood write.
Unknown products, products without the connector, and Distribution-off products answer Core's
not-found shape before any of this, byte-identical to an unknown connector. A product that has
the connector set up answers 401 to an unsigned request instead, so the route does tell a prober
which products run it; that is not treated as a secret (the product's App Store listing says as
much), but it is what makes the residual below targetable.

**SSRF.** The client sends requests only to `https://api.appstoreconnect.apple.com/v1/…`. Paths
are built from segments that must match `^[A-Za-z0-9][A-Za-z0-9-]*$` (so a payload's
`instance.id` of `../../users` is refused), the instance type must be one the event may name, and
a JSON:API `links.next` is followed only when it names the same origin and `/v1/`. The bearer
token therefore cannot be sent to a host a payload, a manifest or an operator chooses.

**Bounded, redirect-free reads.** Every request sends `redirect: "manual"` and any 3xx (or opaque
redirect) is an `AscError` with that status, so the bearer JWT is never re-sent to a `Location` a
response names. Bodies are read through `core/readCapped.ts` (`readCappedText`, at most 8 MiB: a
full 200-resource JSON:API page with its `included` set stays well under 1 MiB); an oversized,
truncated or non-object body is `AscError(502)`, the same unreadable answer as malformed JSON. The
JWT is signed locally, so there is no token exchange to redirect. This is the rule all three store
connectors share ("Store connectors: Microsoft Store", Bounded, redirect-free reads, below).

**Errors carry no bodies.** An ASC failure becomes `AscError` with the method, path and HTTP
status only; that line is what reaches `outlet_credentials.last_error`, the cron's thrown
aggregate and a control's `store_refused` refusal.

**Blast radius of a stolen App Manager key.** Apple's App Manager role covers metadata, TestFlight
(groups, testers, public links), App Store versions, phased release and release requests, review
submissions and — through the API — build uploads; it does NOT sign: an `.ipa` must still be
signed with a distribution certificate the key cannot create or export, and App Review still sees
every App Store version. A thief could pause or complete a phased release, release a held
version early, open a public TestFlight link, change metadata, or upload a build signed with
certificates they already hold. Mitigations: the key is custodied by P5-01 (sealed, platform-admin
writes only, every open audited); the connector itself never uploads and never submits for
review; App Store Connect's own activity log is the second record; rotate by revoking the key in
Users and Access and PUTting a new one (the version marker drops cached tokens). Least privilege
(App Manager, not Admin; a separate Developer-role key for CI uploads) is the operator's choice,
documented in `services/distribution/app-store-connect.md`.

**The mirror is not an access control.** A phased release reaches only devices with automatic
updates on, and anyone can download the version by hand, so `dist_rollouts` rows with
`source = asc` are informative for the feed (P3-03) and the console; nothing may gate a download
on them. A mirrored row refuses direct edits (`rollout_mirrored`); the connector overwrites any
operator rollout on the same (deliverable, outlet, channel) and audits that it did. Only one
writer may own that row, or the audit signal drowns: a replaced or removed version's phased
release is not mirrored, an older release never takes the row from a newer one, and of a
Universal Purchase app's platforms only one (iOS when present) writes a release's rows — the same
rule keeps the whole-release TestFlight row on the newest build — so a tick over unchanged store
state writes no row and no audit entry.

**Controls.** Each is a platform-admin console action (session, CSRF, rate limit), runs only when
the key's pin matches the manifest's app (else 409, nothing sent), proves the object is that app's
first (above), sends exactly one documented request (two for webhook registration: create, then ping), writes one audit row
with the session's subject, and re-reads the object. "Register webhook" sends the stored secret
to Apple once; the secret is generated server-side by the Core admin handler
(`PUT …/outlet-credentials/<id>` with `generate: true`) and never returned to anyone.

**Residual.** The `ascWebhook` bucket is per product and counted before the signature is
verified, so forged and genuine deliveries share it. Anyone who finds a product that runs the connector
(the 401 above) can, without the secret:

- **starve genuine deliveries** — about one well-formed `hmacsha256=<64 hex>` request a second
  keeps the bucket full, and every genuine Apple delivery for that product in that minute is
  answered 429 and lost (see Lost follow-ups for what the poller recovers and what it does not);
- **write up to 60 audited opens a minute per product** — each forged request opens the secret
  once (`outlet_credential.use` audit row plus the `last_used_at` write), about 86,400 a day,
  which buries the per-open detection signal the P5-01 section relies on for that credential.
  The `asc-api-key` opens are not affected (its token cache is checked first).

Neither reveals or forges anything, and the poller keeps App Store versions, builds and phased
release current regardless. An operator seeing either should rotate nothing (the secret is not
at risk) and can block the source at the edge. Whoever holds a product's `asc-webhook-secret` can
also make the Worker spend API budget re-reading objects (bounded by the rate limit and Apple's
per-key hourly limit, which the poller reads from `X-Rate-Limit` and backs off from). Raw event
payloads are stored for 30 days, capped at 16 KiB each; beta-feedback events can name testers, so
`dist_connector_events` is personal data under the same retention reasoning as `audit`. The 30
days are enforced by the nightly maintenance sweep (`scheduled.ts`, step
`connectorEvents:<product>`), which walks every product slug, soft-deleted and Distribution-off
products included, so a product that stops being polled does not keep its payloads forever
(`test/scheduled.test.ts`).

**Closed: a manifest-chosen app (P5-02f).** P5-02 shipped with the repo writer choosing the app
the operator's team key reads and acts on. The operator's pin now chooses it, and the manifest can
only agree ("Who picks the outlet's app", above). What remains:

- **A re-pin is only as good as the admin's check.** A platform admin who re-pins to whatever
  `appleId` a new manifest names, without confirming it is the product's app, reopens the hole for
  that app. The console's pin dialog and the docs say to check first; the `outlet_credential.pin`
  row is the record. A4 (the admin plane) can set any pin, as it can overwrite any credential.
- **A repo writer can stop the connector.** Changing the outlet's `appleId` makes it inert (an
  availability loss, not a write): store state stops flowing in until someone notices `inert` in
  the console. Webhook deliveries refused meanwhile are not re-driven (Lost follow-ups, above).
- **Several products on one key.** Each product's credential row carries its own pin, so one team
  key stored for two products is pinned twice, once per product; the pin limits each product to
  its own app, but the key itself can still see the whole team if it is ever stolen. One key per
  team and one product per team where you can stays good advice.
- **Other stores.** The pin is generic (`OUTLET_CREDENTIAL_PINS`). The Google Play connector
  adopted it with P5-03 (`google-service-account`, pinned by `packageName`; "Store connectors:
  Google Play", below), and the Microsoft Store connector with P5-04 (`ms-partner-center`, pinned
  by the Store ID `productId`; "Store connectors: Microsoft Store", below).

### Store connectors: Google Play (P5-03)

**What it is.** `services/distribution/connectors/play/` keeps a product's Google Play state in
Distribution: availability of each release's Android builds on its `play` / `play-testing`
outlets (`source = play`, matched by version code = `release_builds.build_number`), each mapped
track's staged rollout mirrored into `dist_rollouts` (`mirrored = 1`), and every track as a
connector object. Two entry points, no public route: the 15-minute connector cron
(`CONNECTOR_POLL_CRON`), which reads a throwaway edit (`edits.insert` → `edits.tracks.list` →
`edits.delete`), and operator controls in the console (`…/distribution/connectors/play/…`:
rollout fraction, halt, resume, complete, the in-app update priority, settings). An opt-in
vitals auto-halt reads the Play Developer Reporting API on the same tick. It authenticates with
the `google-service-account` outlet credential (P5-01) through `googleAccessToken` only — one
token per scope (`androidpublisher`, `playdeveloperreporting`), sealed in KV, the credential
opened (audited `play:poll` / `play:control` / `play:vitals`) on a cache miss — and never writes
a credential.

**Blast radius of a stolen service-account key.** The key acts on every app its account is invited
to, with that invitation's permissions. With the least privilege the operator docs prescribe
(`services/distribution/google-play.md`: a dedicated account, invited to this ONE app, release
permissions plus read-only app information, no Cloud roles, nothing financial), a thief can
start, ramp, halt, resume or complete a release already uploaded to that app, set the priority of
a draft, read crash and ANR rates, and — with the release permission — upload and roll out a
bundle signed with an upload key they hold; Play App Signing still re-signs it, but Play does not
otherwise stop it. They cannot touch the product's other stores or apps, or Polaris Key itself.
Mitigations: P5-01 custody (sealed, platform-admin writes only, every open audited, the version
marker drops cached tokens on rotation); the connector itself never uploads; Play Console's own
activity log is the second record; rotate by deleting the key in Google Cloud and PUTting a new
one. Whether the account is really scoped to one app cannot be verified by the Worker; an
account invited account-wide turns this paragraph's "one app" into "every app".

**Who picks the app (and the pin that closes it).** Every request names the one package the
setup resolved — the `play` outlet's `packageName`, re-checked against the Android package rule
before it becomes a URL segment — and a Play outlet naming another package is not part of the
setup. But that `packageName` is read from `dist_outlets.identity_json`, which is manifest-owned
(every resync rewrites it from `.pkey/distribution`), so whoever can push that file picks the
package. The service account is the other way round: the operator stores it, and one account can
be invited to several apps of a Play developer account. Without more, a repo writer of product Q
could set Q's `packageName` to any other app the account can see, and the next resync would make
the connector mirror that app's tracks and staged rollouts into Q's tables and `delivery()`
availability, run the vitals auto-halt against it, and point every console control — rollout
fraction, halt (a rollback, on a completed release), resume, complete, update priority — at that
app's releases: the same confused deputy P5-02 shipped with ("Who picks the outlet's app", above).
P5-03 adopts P5-02f's pin to close it: `google-service-account` is in `OUTLET_CREDENTIAL_PINS`,
pinned by `packageName` (the Android application-id rule, at most 255 characters), and
`resolvePlaySetup` calls `checkOutletCredentialPin` on the credential it chose before anything is
opened. A missing pin (`pin_missing`, every credential stored before P5-03) or one naming another
package (`pin_mismatch`) leaves the connector inert, with the reason in its console status; every
control answers 409 `credential_pin_missing` / `credential_pin_mismatch` — the `settings` control
included — and the poll skips the product (`credential-pin-…`), all before a token is minted, a
credential opened or a request sent, so nothing is mirrored and no vitals read happens. A manifest
that changes its `packageName` after linking makes the connector inert until a platform admin
re-pins (`PUT …/outlet-credentials/<id>` with `{kind, pin}`, audited `outlet_credential.pin`);
the console's credential form requires the package name with the key
(`test/playPin.test.ts`). The residuals are the P5-02f ones below (a re-pin is only as good as the
admin's check; a repo writer can stop the connector by changing the package). Least privilege
(one app per account, above) still bounds a stolen key.

**SSRF and paths.** Requests go only to `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/<package>/…`
and `https://playdeveloperreporting.googleapis.com/v1beta1/apps/<package>/…`; the client refuses
any other origin at construction. Every segment (a track id may contain spaces and `:`) is
percent-encoded, `.` / `..` are refused, an edit id must match `^[A-Za-z0-9_-]{1,128}$`, and a
custom method (`:commit`, `:query`) is appended only by the code that means it — a track named
`x:commit` cannot become a commit. Nothing in a response is followed as a URL.

**Bounded, redirect-free reads.** Every API request and the JWT-bearer token exchange in
`core/outletTokens.ts` send `redirect: "manual"` and treat any 3xx (or opaque redirect) as a
failure — a `PlayError` with that status, or `google token exchange failed: <status>` before any
API call — so neither the bearer token nor the signed assertion is re-sent to a `Location`. Bodies
are read through `core/readCapped.ts` (at most 4 MiB for an API response, 64 KiB for a token
response); an oversized or malformed body is `PlayError(502)` or "returned no JSON", and a token
body that is not a JSON object is "returned no token", never a crash.

**Edits are fragile; reads are all-or-nothing.** One open edit per user, invalidated by a new
edit, a Console change or another commit. The poller reads and maps the whole track list before
writing anything, deletes its edit whatever happened, and a failed read (an invalidated edit, a
429 after two backed-off retries) writes nothing — no availability, no rollout, no object — and
records a status line on the credential. A control that is refused before its PATCH, or whose
commit fails, deletes its edit. A poll and a control racing for the one edit fail one another; the
loser is retried next tick or reported to the operator as `store_refused`.

**Controls.** Each is a platform-admin console action (session, CSRF, rate limit), runs only
when the service account's pin matches the manifest's package (else 409, nothing sent), and is ONE edit: read
the track, PATCH its releases back with only the target's `status` / `userFraction` /
`inAppUpdatePriority` changed, commit with `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (a
change that would cancel a review in flight is refused, never forced). One audit row with the
session's subject, then a re-read whose answer is what the mirror shows (a commit can take hours
to propagate; nothing assumes it is live). Halting a `completed` release rolls the track back to
the previous release, so it needs `confirmRollback: true`; the priority cannot change once a
rollout starts, so `priority` is refused on anything but a draft. Google's refusals are relayed as
`store_refused` with the HTTP status only (`PlayError`), never a body.

**The vitals auto-halt.** Off by default; its settings live in `dist_connector_settings`
(migration 0042), written only by the connector's `settings` control (platform admin, audited) —
no manifest, ingest or resync reaches them, so a repo push cannot turn on an automatic halt. With
it off, no Reporting API call is made and no Reporting token minted. With it on, a staged release
whose user-weighted crash or ANR rate over the window exceeds the threshold on at least the
minimum sample is halted through the same control path (actor `connector:play-vitals`, one
`distribution.play.halt` audit row naming the reading) and marked with a `vitals-trip` object,
so it trips once: a halt Play has not propagated yet cannot cause a second one, and an
operator's resume is not fought. Residual: the Reporting data is Google's; a wrong reading (or a
key holder who can make the app crash for enough users) can halt a rollout — the safe direction —
but never start, ramp or complete one.

**The mirror is not an access control.** Users who already installed a halted release keep it,
and Play applies the staged rollout, not Polaris Key; `dist_rollouts` rows with `source = play`
inform the feed (P3-03), the Android plugin (P5-06) and the console. A mirrored row refuses direct
edits (`rollout_mirrored`); the connector overwrites any operator rollout on the same
(deliverable, outlet, channel) and audits that it did. A tick over unchanged Play state writes no
audit row.

### Store connectors: Microsoft Store (P5-04)

**What it is.** `services/distribution/connectors/msstore/` keeps a product's Microsoft Store
state in Distribution, READ ONLY: each release's submission on its `ms-store` outlet (status,
`statusDetails` errors, certification report dates; `submitted_at` / `reviewed_at`), availability
of its MSIX builds (`source = ms-store`, matched by 4-part package version =
`release_builds.build_number`, platform `windows`), each published submission's gradual package
rollout mirrored into `dist_rollouts` (`mirrored = 1`), and the application, its flights and the
submissions read as connector objects. One entry point, no public route and no console control:
the 15-minute connector cron (`CONNECTOR_POLL_CRON`). It authenticates with the
`ms-partner-center` outlet credential (P5-01, a new credential KIND for a connector but not for
custody: the kind, its validator and `meta_json` of tenant, client and seller ids are P5-01's)
through `msstore/token.ts` only — an Entra ID v1 client-credentials token for the resource
`https://manage.devcenter.microsoft.com`, cached sealed in KV with P5-01's
`readSealedToken` / `writeSealedToken` keyed by the credential's version marker, the credential
opened (audited `ms-store:poll`) only on a miss — and never writes a credential.

**Blast radius of a stolen client secret.** Microsoft's submission API needs the Entra
application to hold Partner Center's **Manager** role, which has no per-app scope: a thief can
create, commit and publish submissions, change listings, and start, ramp, halt or finalise
gradual rollouts for **every app of the seller account**, until the key is removed in Partner
Center. They cannot touch other stores or Polaris Key. The connector itself never exercises any
of that: its client (`msstore/client.ts`) can send only GET — there is no method parameter — and
the suite asserts that no request other than GET ever reaches the fake Store API
(`test/msstore.test.ts`). Mitigations are P5-01 custody (sealed, platform-admin writes only,
every open audited, rotation drops the cached token), the operator docs' "dedicated application,
Manager role and nothing wider" (`services/distribution/microsoft-store.md`), and Partner
Center's own activity history as the second record.

**Who picks the app.** As for Play: the Store ID is manifest-owned, the credential reaches the
whole seller account, so a repo writer could otherwise aim it at another app and copy that app's
submission states, certification errors and rollouts into this product's tables and feed (a
disclosure and a polluted availability record; no store change, since the connector cannot
write). P5-04 adds `ms-partner-center` to `OUTLET_CREDENTIAL_PINS` (field `productId`, the
12-character Store ID rule) and `resolveMsStoreSetup` calls `checkOutletCredentialPin` on the
credential it chose before anything is opened: a missing or different pin leaves the connector
inert (`credential-pin-missing` / `credential-pin-mismatch`, no token, no request, no write). The
console's credential form requires the Store ID with the secret. The P5-02f residuals apply (a
re-pin is only as good as the admin's check; a repo writer can stop the connector).

**SSRF and paths.** The token request goes only to `https://login.microsoftonline.com`; the
tenant id becomes one path segment only if it is a GUID or a domain name, and the final URL's
origin is re-checked, so a credential cannot make the Worker post its client secret elsewhere.
API requests go only to `https://manage.devcenter.microsoft.com/v1.0/my/applications/<Store ID>/…`,
the Store ID re-checked against `^[A-Za-z0-9]{12}$`, submission ids against digits and flight ids
against `^[0-9A-Za-z-]{1,64}$`, every segment percent-encoded. A response's `resourceLocation` or
`@nextLink` is never followed: flights are paged by `top` / `skip`, bounded at five pages.

**What is never stored.** A submission resource carries `fileUploadUrl`, a writable Azure Blob SAS
URI for its packages; the parser drops it, with listings, pricing and certification report URLs,
before anything reaches D1 (asserted by scanning every table after a poll). Errors stored on the
credential or shown on the connector page are status lines (`MsStoreError`), never a body.

**Reads are all-or-nothing, and 409 is not an error.** The whole state (application, its pending
and last published submissions, the flight list, the mapped flights' submissions) is read before
anything is written; a failed read writes nothing. The API answers 409 for an app using mandatory
app updates or Store-managed consumable add-ons; the connector records the application as
`not-readable` and skips the tick without failing the cron. Pricing Version 2 returns an unknown
price tier; pricing is never parsed.

**The mirror is not an access control.** Gradual rollout applies to MSIX packages only and a halt
never rolls installed users back; `dist_rollouts` rows with `source = ms-store` inform the feed
(P3-03) and the console. A flight Partner Center lists that no outlet maps is stored, audited once
(`distribution.connector.flight_unmapped`; the Worker has no console logging, R12) and never read
further. A tick over unchanged Store state writes no audit row.

**The fallback keeps the feed honest.** While a gradual rollout is partial (not started, in
progress or stopped), everyone outside it gets the `fallbackSubmissionId` submission. The poller
reads that submission too (role `fallback`, same app or flight path, the id checked like any
other) and keeps its builds `live`, so availability — and through it `feeds/select.ts` and the
signed feed — never shows the previous version as `removed` while the Store still serves it, nor
shows nothing live at all after a halt. The fallback never mirrors a rollout and never writes its
release's submission row; it stops being read once the rollout completes, and its builds then
become `removed` like any build no read submission carries.

**Bounded, redirect-free reads.** Both the token request and every API request use
`redirect: "manual"` and treat any 3xx as a failure, so neither the client secret nor the bearer
token is re-sent to a URL a response names; bodies are read through `core/readCapped.ts`
(`readCappedText`, 64 KiB for a token, 4 MiB for an API response) and a submission's package list
is capped at 64 entries. **The rule is shared by all three store connectors:** the App Store
Connect client (8 MiB) and the Google Play clients and Google token exchange (4 MiB / 64 KiB)
follow it too (fix/connector-hardening; their sections above), with the shared `isRedirect` test
in `core/readCapped.ts`. A refused redirect or an oversized body is always that connector's own
failure or unreadable-answer path, carrying a status line, never a body or a token
(`test/connectorHardening.test.ts` drives the redirect cases through the real runtime `fetch`
against a loopback server and asserts the `Location` is never requested).

### Update health: telemetry, the auto-halt and the Sentry hook (P6-03)

**New inputs.** Devices report update outcome events in the `updates` key of
`POST /<p>/devices/report` (unsigned, device-token authenticated, the existing 16 KiB cap). A
Sentry internal integration posts alerts to `POST /<p>/distribution/hooks/sentry`. Neither input
can do more than the paths below allow.

- **Report path.** `core/updateHealth.ts` `boundedUpdates` keeps at most 16 entries, each matched
  field by field against a fixed alphabet (no `|`, the counters' key separator), drops a
  malformed entry or an unknown event, and strips unknown fields. Counting happens AFTER the
  snapshot is stored, in `UpdateHealthDO` (one Durable Object per product, deliverable and
  release) — never D1 — and fails open, so a broken counter cannot cost a device its report.
- **Inflation.** Counters are deduplicated on (device, `eventId`), and the number the auto-halt
  judges is DISTINCT DEVICES per event, so one device moves a rate by at most one however many
  events it invents; the `eventId` space is per device, so a device cannot pre-claim another's
  ids. Moving a rate needs many registered devices, and `minSample` applied devices must be met.
  **Under open registration that is cheap:** keyless registration allows 10 per minute per IP, so
  one IP reaches the default `minSample` of 200 in about twenty minutes, and more IPs go faster.
  Operators of open-registration products should raise `minSample` well above what an attacker
  would bother to register, or leave the auto-halt off; the docs page says so.
- **Dilution.** The same cheap devices can suppress a GENUINE trip: fake `update_applied`
  devices enlarge the denominator until the true revert rate falls under the threshold. The
  auto-halt is a safety net, not a guarantee; the funnel, Sentry candidates and the operator's
  own halt remain the controls.
- **Object bounds.** An event's (deliverable, release) must be a release Release knows (its
  catalog hook's `releases(deliverable)`, read once per deliverable per report); an event naming
  any other release counts nothing and creates no counter object. One report touches at most two
  (deliverable, release) objects; further groups are dropped, and the two calls run in parallel
  before the device's 200. So the NUMBER of objects is bounded by the product's real releases,
  and each object by the caps below: objects ≤ real releases, storage per object ≤ devices × one
  record (≤ 64 event ids, ≤ 8 pairs) + hours × declared pairs × 7 buckets. Report rate moves
  only work per request, never what is kept.
- **Key bounds.** An event's outlet and channel are checked at ingest against the product's
  declarations, read through Core's hooks (Distribution's live outlets, Release's
  `knownChannels`; AGENTS.md rule 6): anything else is counted in ONE `unknown` bucket that is
  never judged and takes no pair. So bucket keys are bounded by what the operator and the
  manifest declare, and an invented pair cannot crowd out a real one. Per device and per object,
  at most 64 events are ever counted (beyond that the device counts nothing there) and at most 8
  distinct (outlet, channel) pairs introduced (further pairs go to `unknown`); each device has
  exactly one record holding its dedupe list. No per-device rate limit is added on the report:
  with the object bounds above, the caps bound what any number of reports can store, the report
  is device-authenticated and 16 KiB-capped, and a limiter would add a Durable Object round trip
  to every report. A read sums every bucket page by page; past a 500,000-key ceiling it says
  `truncated` and the auto-halt treats that as no data.
- **Retention.** The object's alarm deletes buckets older than 30 days (hour-keyed, a range from
  the start) and device records idle that long (a scan paginated with a `startAfter` cursor that
  persists between alarms), working until done or until a 10 s budget is spent, then re-arming in
  a minute while work remains, otherwise in a day, and clearing its storage once empty.
- **Clock.** A future `at` counts as now; one older than 30 days is not counted.

**The auto-halt is halt-only, operator-owned and off by default.** Its settings live in
`dist_connector_settings` (connector `auto-halt`, P5-03's table), written by one function,
`writeAutoHaltSettings`, whose only caller is the console's control (platform-admin session,
CSRF, rate limit, a `distribution.auto_halt.settings` audit row with the session's subject);
`test/autoHalt.test.ts` pins that no other file names the writer or writes that row, and no
ingest, resync or manifest field reaches it — a repo push cannot turn on an automatic halt. The
tick (the connector cron) halts through P2b-04's `applyRollout` with a third actor kind,
`system`, which `applyRollout` itself refuses for every verb but `halt` (`system_halt_only`), so
the automatic path cannot pause, resume, ramp, complete or start a rollout even through a bug in
its caller. It never touches a `mirrored` (store) rollout — it records an alert for the operator
— and trips once per (deliverable, outlet, channel, release), so an operator's resume is not
fought. A halt `applyRollout` refuses (a race: the rollout or its outlet moved since it was
listed) is recorded on the tick's reading and judged again next tick; it does not fail the cron.
The first refusal per trip is audited (`distribution.auto_halt.refused`), so a halt refused for
a lasting reason is visible.
Residual: a coordinated set of registered devices that crosses `minSample` with false reverts can
halt a self-hosted rollout — the safe direction — but never expose a build (and see Dilution
above for the opposite direction).

**The Sentry hook proposes; an operator decides.** The client secret is an outlet credential of
the new kind `sentry-integration` (P5-01 custody: sealed under its own AAD, written only by the
Core admin handler, every open audited as `system:distribution` with use `sentry:webhook`). It
authenticates Sentry to the Worker; the Worker never calls Sentry. The hook answers the service
not-found shape without a credential, refuses a missing or malformed signature before anything
is opened, rate-limits per product BEFORE the credential is opened (`sentryWebhook`, fail
closed, since every open is an audit row), compares the HMAC in constant time, and dedupes on the
body's SHA-256. A triggered event alert opens at most one `halt-candidate` per matching active or
paused, non-mirrored rollout; it halts nothing. Confirming halts through `applyRollout` as the
confirming admin, with the candidate's release pinned (`stale_release` if the rollout moved
on). A candidate keeps only the rule name and Sentry's numeric issue id, and the events table
keeps only a reduced record of each delivery, whatever its outcome — `{resource, action, rule,
issueId, release, environment, outlet}` — never the body, the event's message, exception, user or
other tags. Residuals: anyone holding the client secret (Sentry, or a leak of it) can open
candidates and fill the console; they cannot halt. An unsigned flood can starve the per-product
`sentryWebhook` limiter so that genuine alerts are refused for its duration. Sentry's signature
covers no timestamp, so a delivery replayed after the 30-day event retention can reopen a
candidate — harmless, because a candidate still needs an admin to confirm it.

### The commerce bridge: store purchases as licence flags (P6-01)

**What it changes.** A verified App Store, Google Play or Steam purchase of a product the
operator mapped (`dist_store_products`) puts a licence flag on the buyer's licence
(`license_store_grants`), which `core/payload.ts` merges into every licence document after the
licence profiles and before the licence's own overrides. The asset is therefore the same as
AT-1's: a flag that unlocks paid content. The new inputs are a device's claim
(`POST /<p>/distribution/commerce/claim`, device token), the binding read
(`GET …/commerce/binding`), and two store notification hooks (`POST …/hooks/app-store`,
`POST …/hooks/play-rtdn`). The licence document's shape and `PROTOCOL_VERSION` do not change: a
flag was always a licence entitlement.

**Who writes a grant.** Only License, through Core's `applyStoreGrant` descriptor method
(`core/storeGrants.ts`, `core/registry.ts`), and only on a purchase Distribution has verified
with its store. Core asks License only while License is enabled for the product
(`license_disabled` otherwise, before any License code runs), so the coherence rule "commerce
needs License" is structural; the admin API also refuses commerce settings and product mappings
with License off (409 `commerce_requires_license`) and every commerce route answers the service
not-found. The write path is the authorizeRegistration pattern, not a descriptor hook: hooks stay
read-only (§ Service boundaries). Every grant change is an audit row as `system:commerce` naming
the flag and the store, never a token.

**Forged purchases and notifications.**

- **App Store.** A StoreKit JWS, a Notifications V2 `signedPayload` and its
  `signedTransactionInfo` are verified by `core/x509.ts` + `commerce/apple.ts`: exactly three
  certificates, the last byte-identical to Apple Root CA - G3 pinned in code (`appleRoot.ts`,
  fingerprint pinned by a test), each link's issuer name, CA bit, keyUsage and signature checked,
  Apple's intermediate (`1.2.840.113635.100.6.2.1`) and leaf (`1.2.840.113635.100.6.11.1`)
  marker OIDs required, unknown critical extensions refused, validity checked at the payload's
  `signedDate` (never later than now), then the ES256 signature under the leaf key. A forged
  notification is 401 before anything is stored. StoreKit Testing's self-signed `Xcode` chain
  fails the chain and the environment check. The pinned root can be replaced only by a test-only
  setter that a test keeps every `src/` file from naming.
- **The device only forwards.** A claimed App Store transaction is re-read from the App Store
  Server API with the operator's `app-store-server-key` and Apple's fresh copy decides; a
  notification is a hint the same way (it names the transaction; the API says what it is). Play
  decides from `purchases.products.get` through P5-03's client; Steam from
  `AuthenticateUserTicket` and `CheckAppOwnership`. Nothing a device sends is trusted as a
  purchase state.
- **Play push.** The Pub/Sub push request must carry a Google-signed OIDC token: Google's JWKS
  (KV-cached for an hour, refetched at most once a minute for an unknown `kid`), issuer
  `https://accounts.google.com`, the operator's audience, `email` equal to the push
  subscription's service account and `email_verified`. Without all five the request is 401
  before the body is read. A valid push still only names a purchase token for the API to read.
- **Steam.** The ticket is authenticated FOR the caller's binding (`identity`), so a ticket
  captured from another player's session does not authenticate for this licence; ownership must be
  the account's own (`ownersteamid` = `steamid`: a Family Sharing borrower gets nothing) and not a
  timed trial.

**Cross-licence claims.** Every purchase is bound before it is made: the licence's binding UUID
(random, not the licence id, not PII) is handed to the store as Apple's `appAccountToken`, Play's
`obfuscatedAccountId` or the Steam ticket identity. A claim grants only when the STORE's record
names the caller's own binding (`binding_mismatch` otherwise) and refuses a purchase with no
binding (`unbound`); once a purchase key (SHA-256 of the store's key) is recorded for a licence, no
other licence can claim it (`bound_elsewhere`), whatever binding a later record carries. The
binding is compared as a UUID (S-09: Apple's JWS carries it in lower case). Residual: anyone who
learns a licence's binding can make a purchase that grants THAT licence — a gift, not a theft;
the binding read needs the licence's own device token.

**Replay.** Notifications are deduplicated on their own id (`notificationUUID`, the Pub/Sub
`messageId`) in `dist_connector_events`; a `failed` delivery may be redelivered by the store and
is processed again. A fresh notification or claim for a purchase already recorded is idempotent:
the grant upsert changes nothing and audits nothing (`changed: false`). An old notification
replayed after the events table's 30-day retention re-reads the store, which answers the current
state — so a replay can only restate the truth.

**Sandbox leaks.** A production product refuses App Store `Sandbox` transactions and Play
licence-tester purchases (`purchaseType` 0) unless the operator turned on `acceptSandbox` /
`acceptTestPurchases` in the commerce settings (operator-owned, audited, never manifest-writable);
`Xcode` is refused always. A sandbox notification delivered to a production product is stored as
`ignored` with a 200, so Apple stops retrying, and grants nothing. Sandbox transactions are read
from Apple's sandbox host, never the production one.

**Credentials and pins.** Two outlet-credential kinds join P5-01's custody: `app-store-server-key`
(the In-App Purchase key, pinned to the bundle id) and `steam-publisher-key` (pinned to the game's
app id); Play reuses the `google-service-account` pinned to the package. A store runs only when
its commerce settings name the app AND an active credential is pinned to that same app, so a repo
writer cannot aim the operator's key at another app (the settings are operator-owned too). The
Steam key rides in a query string to `partner.steam-api.com`, so no error carries a URL; every
store call is redirect-free and capped (`commerce/http.ts`).

**Gated delivery and the App Store's cross-store rule.** The flag is enforced at delivery like any
licence flag (`entitlementFlagRefusal`). App Store 3.1.3(b) — a flag bought elsewhere unlocks on an
Apple outlet only if also sold there — is applied by the SDK (`PolarisKey.commerce.hidden_here`,
from the binding route's product list), not by the Worker: delivery requests carry no outlet, so
the Worker cannot tell an Apple build's download from another's. A modified client can ignore the
rule; that is a store-policy matter, not an entitlement bypass (the player paid for the flag).

**Lost or late signals.** Apple redelivers a notification answered non-2xx for days, Pub/Sub
redelivers with backoff, and the hooks answer 503 on a store outage for exactly that reason. Play
voids are also polled daily (Voided Purchases API, 30 days back); Steam pushes nothing, so active
Steam grants are re-checked weekly and on every claim. Residual: a Steam refund keeps its flag for
up to a week; an App Store refund whose notifications all fail keeps its flag until a later
notification or claim re-reads the transaction (no App Store poll exists).

**Abuse.** Claims are rate-limited per licence (`commerceClaim`). Each hook has two limiters,
both failing closed: a per-client-IP bucket BEFORE verification (`appStoreHookIp`,
`playRtdnHookIp`), which bounds the signature-checking CPU an unauthenticated sender can spend,
and a per-product bucket AFTER it (`appStoreHook`, `playRtdnHook`), which counts only deliveries
the store signed — so junk traffic can never drain the bucket a real refund notification needs
(a test floods unsigned payloads, then delivers a signed one). Bodies are read through the shared
streaming reader and cut off at the cap while streaming, chunked or not. Bodies are capped (32 KiB claims, 64 KiB hooks). Purchase keys are
stored only as SHA-256; `detail_json` keeps the store ids a re-check needs (a Play purchase token,
an order id, a Steam ID) and is never shown in full on the console.

### The device-code user-code page (P1-06)

**What it is.** `GET`/`POST /<p>/identity/auth/device` is the RFC 8628 code-entry page a TV, a
console, a game or a CLI sends the player to. The player types (or scans) an eight-character
user code; the page looks it up server-side and shows a confirmation page naming the product and
the device; one button press sends the browser to the IdP. The secret `deviceCode` — which,
with the device id, is what a poller redeems for a device token — never appears in a URL, a page
or a form on this path, and the user code is drawn independently of it. Its KV index is keyed by
a peppered hash (R12-04), lives at most for the flow's 600 s, and is deleted the moment the flow
is confirmed.

**What a user-code holder can do** — to a flow someone _else_ started (the flow's own starter
is the remote-phishing case below, and is not bounded by anything here). The user code is public
by design: clients show it large
and render it as a QR code, so assume it is read over a shoulder, off a stream or from a photo.
Before the real user confirms, its holder can:

- **(a)** open the confirmation page, which re-mints the single-use CSRF token and so makes the
  real user's pending click 403 until they reload;
- **(b)** confirm the flow themselves and complete the IdP sign-in under their OWN identity. The
  callback then does exactly what an ordinary sign-in for that identity does: it finds the
  holder's own license (`getLicenseBySub`), or mints one under the product's existing group-map
  or `oidcDefault` policy. It touches no other license. When the victim's device next polls with
  the device code, which only it holds, it is signed in to the holder's account: that one device
  row moves onto the holder's license and takes a seat there. The player sees this on the device.
  The holder sees the device (its label, platform and version) in their own device list and can
  revoke it. This is a visible mis-binding, not a takeover.

The holder cannot obtain the device code, the victim's device token, or any token on the
victim's license. They cannot change the victim's license in any way, and they cannot learn the
victim's identity. The license the device was already on keeps its `sub`, origin and status, and
the machine can enroll straight back onto it. The holder also cannot act at all once the victim
has confirmed.

Before P1-06's security fix, (b) was a takeover. The callback took the license the flow's device
was on (`flow.deviceId`) and merged it into the signing-in identity. If the holder had no license,
it re-subjected the victim's anonymous enrolled license to them (claim). If they had one, it
moved the victim's devices onto it and disabled the victim's license, keeping `enroll_hwid`, so
that machine could never enroll again (migrate). The holder could then mint tokens on the
captured license from their own devices with an ordinary sign-in. The callback now applies no
enrolled license at all (PoC, asserting the fix: `R8-oidc.test.ts` › `R8-02 / P1-06 a user-code
holder cannot claim…`). Attaching a device's anonymous license to an account is P1-07's
explicit opt-in. It is applied at `/device/poll` by the device-code holder, and only after the
device was shown the signed-in identity (`confirm`) and the player accepted it there. The callback
now activates nothing for a device-code flow: it stores the verified identity and the
device-code holder's poll activates it, so no license row is created or changed before that poll.
The opt-in names the license by the device's own bearer token, which must belong to the device
the flow was started for and sit on an anonymous, usable enrolled license (PoCs:
`R8-oidc.test.ts` › `ATTACK (claim, P1-07)`, `ATTACK (migrate, P1-07)` and the `P1-07:` cases).
For a party holding _someone else's_ user code, what remains is a human decision: a player who
accepts a stranger's identity on the device, and attaches, hands that stranger the license. The
device shows the name and verified e-mail before anything happens, which is the control. That
control assumes the device-code holder is the player. Under the open R1-07 ("Remote phishing"
below) it is not: the flow's starter holds the device code and its own device's token, so the
starter, not the victim who signed in, makes the attach decision. See "What the opt-in attach
adds under R1-07" there.

Four controls make that true. The first and the fourth are the ones that matter:

1. **Only the device code redeems a device-code flow.** Confirming 303s the browser to the IdP
   authorize URL, and that URL carries `state`. `/identity/auth/poll` redeems `state` plus a
   device id, so a user-code holder who confirmed would hold one half of that pair for free.
   A flow `/device/start` began is therefore marked (`viaDeviceCode`) and `/identity/auth/poll`
   answers it with the generic `error`; it completes only on `/identity/auth/device/poll`, with
   the device code. (Found in P1-06 review: without this, a user code was enough to race the
   real device for its token — an R8-01-class theft.)
2. **The page never shows the device id.** It shows `deviceName`, or "Unnamed device".
3. **Confirmation retires the user code.** The index is deleted, and a flow already confirmed
   does not resolve even if a KV read still sees it: nobody can re-render, re-mint the CSRF token
   or be 303'd to the authorize URL after the real user has pressed the button.
4. **The callback merges nothing.** `handleAuthCallback` activates nothing for a device-code
   flow, and nothing it stores names the device's license. The only flows that carry a device id
   are device-code flows, and those are confirmed with the public user code, so the device's
   current license must not be an input to whoever signs in. The browser-redirect flow carries no
   device id and never merged.

**Cross-site POSTs.** Both device pages carry `referrer-policy: no-referrer`, and under that
policy a browser sends a same-origin form POST with `Origin: null`. The origin check therefore
decides on Fetch Metadata when the browser sends it (only `Sec-Fetch-Site: same-origin` passes)
and otherwise accepts an absent Origin, this origin, or `null`; a foreign Origin is refused. The
single-use CSRF token minted on the render then guards a confirmation against cross-site forgery
of _someone else's_ flow. Neither control stops a flow's _starter_: anyone can GET the page for
their own user code, read the token and POST it back with no `Origin` at all (curl), so the
starter can always confirm their own flow and receive the IdP authorize URL — see "Remote
phishing" below. The `Origin: null` allowance adds only a legacy-browser variant of that same
attack (a browser without Fetch Metadata, or a sandboxed or no-referrer attacker page).

**Brute force (RFC 8628 §5.1).** The code space is 20⁸ ≈ 2.56 × 10¹⁰ (RFC 8628 §6.1's
consonant alphabet). The page allows 30 requests per minute per _client network_, fail-closed:
an IPv4 address, or an IPv6 **/64** (`clientNetwork` in `core/rateLimit.ts`). The /64 matters
because one ordinary IPv6 host is routed a whole /64 — 2⁶⁴ source addresses at no cost
(R10-04b) — so a per-address key, which every other bucket still uses (`clientIp`), would give a
single host an unlimited supply of fresh budgets. One network therefore gets at most 300 guesses
in a code's 600-second life: with N codes live at once it hits one with probability about
300·N / 2.56 × 10¹⁰ — 1.2 × 10⁻⁵ even with 1,000 live flows.

That per-network figure is not the whole bound. An attacker holding an IPv6 /48 (65,536 /64s,
a common end-site assignment) or a botnet multiplies it by the networks it controls, and the
ceiling is then the product's single `RateLimitDO` (a product's own limiter is still one object;
I-02 sharded only the platform-global `_portal` and `_admin` ones), of the order of 1,000 checks a
second shared with every other bucket of that product. At that ceiling — which also degrades
the product's other rate-limited routes, a visible attack in its own right — 1,000 live flows
give about 6 × 10⁵ guesses per 600 s and one hit roughly every 7 hours; at a more sustainable
200 guesses a second, one every day and a half; with 10 live flows, a hundred times rarer. What
actually bounds guessing is the code space, the 600-second lifetime and the limited value of a
hit. A blind hit gets exactly what any user-code holder gets (above), against a flow the guesser
did not choose: a stale CSRF token on the page, or a stranger's device pulled onto the guesser's
own account, where it is visible to both sides. It gets nothing after the victim confirms. Only
the device code redeems a device-code flow, so a hit is not a path to a device token. The
callback claims, migrates and disables nothing, so a hit is not a path to the victim's license
either. Before that fix, one hit every 7 hours at the ceiling was one captured anonymous license
every 7 hours. There is
deliberately no product-wide bucket: one attacker could exhaust it and lock every player of a
product out of sign-in. Residuals, unowned: aggregating the other per-IP buckets to /64 in
`clientIp`, and sharding a product's own rate-limit Durable Object (R10-04a is fixed for the
platform-global `_portal` and `_admin` limiters only; see the single-use store section below).

**Remote phishing (RFC 8628 §5.4) — open: R1-07, rooted in R8-03.** The flow's starter can
complete the confirmation step without a browser and forward the resulting IdP sign-in to a
victim. If the victim signs in (or silent SSO signs them in), the callback binds the victim's
license to the starter's flow, and the starter's own poll then receives a device token on the
victim's license. The confirmation page is never shown to the victim. The regression test
`R8-oidc.test.ts` › `OPEN (R1-07 / R8-03): the starter confirms its own flow…` asserts the gap;
binding the callback to the confirming browser (below) is the fix.

**What the opt-in attach adds under R1-07 (P1-07).** The attach is decided by the device-code
holder, and here that is the starter. If the starter's device is on an anonymous enrolled
license, the starter polls with `confirmIdentity` and its own bearer, is told the license is
`attachable`, and sends `attachLicense: true`. The victim is asked nothing. Compared with the
plain R1-07 poll, which authorizes one starter device on the victim's license through
`authorizeDevice` and its seat check:

- **Claim** (the victim has no license yet): the victim's identity takes over the starter's
  anonymous row in place, with every device already on it, and the row is rewritten onto the
  victim's tier and provisioned overrides. Those devices now hold the victim's entitlements.
  The row's own seat check does not bound them: the enroll tier may allow more seats than the
  victim's, and a dormant device has given up its ordinal (`releaseDormantSeats`), so the
  starter can refill that seat with a new device and the dormant one comes back through
  `validateDeviceToken` without claiming a seat. Bounded since the P1-07 security review: a
  claim is offered (`attachable`) only while every authorized device on the starter's row,
  dormant ones included, fits the device limit the row will carry after the claim (the victim's
  mapped tier and provisioned overrides).
- **Migrate** (the victim already has a license): `moveDevices` re-points _every_ device on the
  starter's anonymous license at the victim's license, with `seat_no = NULL` and without
  `authorizeDevice`. Bounded since P1-07 review: the attach is offered (`attachable`) only while
  every authorized device on the starter's license (dormant ones too, since `moveDevices` moves
  them and a moved dormant device comes back without claiming a seat) plus the seat-holding
  devices on the victim's license fit the device limit the victim's license will carry after the
  activation. The activation rewrites that license's tier and overrides to the victim's current
  group-mapped tier and provisioning before the mint, so the bound is measured on that, not on
  a larger tier the license still stores from an earlier sign-in or an admin `deviceLimit`
  override the same write discards.
- **On both arms**, then, the attach cannot take the victim past their device limit. It can
  still fill the victim's free seats with the starter's devices, so the victim's own next device
  then gets `device_limit` until the owner removes them. The bound is a read before the merge,
  like `authorizeDevice`'s pre-count, not a seat claim; a concurrent activation can race it.
- **Never on a refused mint** (P1-07 review): the merge is committed before the token is minted
  and nothing undoes it, so the attach is offered only when the mint can succeed. A device-code
  poll presents no fingerprint, so when the victim's tier has fingerprint mode `strict` (whose
  mint always answers `fingerprint_required`) nothing is `attachable` and a forced
  `attachLicense: true` gets `confirm` again with nothing merged. Without that check the attach
  turned a flow the Worker refuses (`error`) into a claim or migrate onto the victim's strict
  licence.

PoCs: `R8-oidc.test.ts` › `OPEN (R1-07 / R8-03, P1-07 claim)` and `OPEN (R1-07 / R8-03, P1-07
migrate)` assert the gap; `P1-07 (R1-07 bound)`, `P1-07 (R1-07 bound, dormant devices)` and the three `P1-07 (R1-07 bound,
claim)` / `P1-07 (R1-07 bound, migrate)` tests (dormant devices on a claim, the identity's tier
rather than the enroll tier, the mapped tier rather than a stale stored one) assert the
seat-limit refusal, and `P1-07
(R1-07, claim on a strict tier)` and `P1-07 (R1-07, migrate on a strict tier)` assert that nothing
merges when the mint would be refused. Binding the
callback to the confirming browser (below) closes all of it, because the device-code holder is
then again the person who signed in.

So the confirmation page and its CSRF token protect only flows the attacker did _not_ start
(cross-site forgery against someone else's flow, above). Typing the user code does not close
this either: the starter types their own. The variant where the victim is sent the
`verificationUriComplete` link instead lands them on the confirmation page, which names the
product and shows the device label and user code — but the label is `deviceName` from
`/device/start`, client-supplied display text a phisher sets to anything — so it is a speed bump,
not a control.

This is **not** inherent to the device-authorization grant. In RFC 8628 the user authenticates in
the same browser session that entered the code; Polaris does not yet bind the IdP callback to
the browser that confirmed, which is R8-03 (no flow on any surface is bound to the visitor's
browser). R1-07 therefore stays **Fixed-partial** (2026-08-26 audit): R8-02 and P1-06 closed the
GET self-confirm, the framable page and the device code in the URL, not the starter's ability to
confirm. Fix direction, unowned: bind a `viaDeviceCode` flow's callback to the browser that
confirmed it — e.g. a `__Host-` `SameSite=Lax` cookie set on the confirmation `303` and required
by `handleAuthCallback` — which closes R1-07 for device-code flows and makes the `Origin: null`
question moot.

**Unchanged.** The legacy `/identity/auth/device/verify?device_code=` page stays for flows in
flight across the deploy. Confirmation on both routes is one function: the Fetch Metadata /
`Origin` check above, a single-use CSRF token, and a `303` to the IdP with `no-referrer` and
`no-store`. The confirmation
page's CSP widens `form-action` by exactly the IdP origin that `303` goes to.

### The single-use store, sharded sign-in limiters and email limits (I-02)

**Asset.** Every single-use sign-in artefact: product, portal and console OIDC flow records
(`state` with its PKCE `verifier` and `nonce`), RFC 8628 device-code records and the user-code
index, portal magic links (which name the recipient's email), and the email codes and recipient
strike counters I-08 will use. A record replayed or redeemed twice is a sign-in an attacker did not
earn.

**What changed (S-16 G15).** These records lived in KV, consumed with `get` then `delete` (or
`get`, check, `put`). KV is eventually consistent and those steps are not atomic, so two requests
racing on one artefact could both read it before either write landed: two clicks on one magic
link both signed in, two callbacks on one `state` could both pass the R8-04 `consumedAt` check,
two polls of a ready flow could both mint a device token. They now live in `SingleUseDO`
(`src/singleUseDo.ts`, client `src/core/singleUse.ts`), a Durable Object whose input gate
serialises every operation on one object, so each of these is one atomic step:

- `consume` (read and delete together): portal and console callbacks, `/magic/verify`, and the
  poll's final redemption, which takes the flow before minting (a failed mint puts it back);
- a compare-and-set `update`: the product callback's claim of a `state`, a device confirmation's
  spend of its CSRF token, and the device poll's `lastPollAt` slot (so the deferred activation of
  a device-code flow never runs twice side by side);
- `put … ifAbsent`: the user-code index, so two flows can never claim one live user code;
- `redeem` with a per-artefact attempt cap, and `strike` (a sliding-window counter with a
  lockout), for email codes.

Updates never create a record, so a late write cannot resurrect an artefact another request
consumed. The store is addressed by `(kind, id)` where `id` is the product plus the secret's
peppered hash (R12-04 holds: a storage listing yields nothing usable), and spread over 64 objects
by a hash of the address, so it is not a global chokepoint. Records carry their own expiry and an
alarm sweep deletes expired ones (storage is bounded by the live set, as in R10-04b). It fails
closed: a read that cannot reach the store answers "absent" (an expired link, an unknown `state`,
a locked recipient), a write throws, so no flow is handed out that could not be recorded.
`test-workerd/singleUse.test.ts` proves the concurrent double-consume on the real object.

**Sharded platform limiters (R10-04a, partly fixed).** `_portal` and `_admin` were literal
`RateLimitDO` names, so every customer's and every operator's interactive sign-in serialised
through two objects, reachable with no credentials. Each is now 32 objects; a counter's object is
chosen by a hash of its `(bucket, id)`, so one counter still lives in exactly one object and every
limit stays exact. The email buckets are sharded the same way in every limiter. **Residual:** a
product's own limiter is still one object per product (tenant-scoped, so a flood degrades only that
product), and an attacker can still pick ids that land in one shard; that concentrates load on one
of 32 objects instead of one of one.

**Email limits (S-16 §5.4 item 4), primitives only.** `src/core/emailLimits.ts` holds the send
and verify limits as named constants: per recipient (peppered hash) 5 an hour and 20 a day, per
client address 10 an hour, per network (IPv4 /24, IPv6 /48) 30 an hour, per device 3 starts an
hour, a per-product daily cap (default 1,000 until I-21 sets the operational value); codes of 6
digits, 10 minutes, dead after 5 wrong attempts, replaced (so invalidated) by a new code for the
same recipient and flow; 10 wrong attempts across codes in an hour lock the recipient out of new
codes for 15 minutes. Every limit is per product, so one tenant's traffic can neither drain
another's budget nor lock a person out of another product. Both primitives answer without a
reason (`{ send }`, `{ ok }`), so a caller that echoes them leaks nothing. **Open until I-08:** no
route uses them yet; the enumeration-safe answers (a refused or locked send answered exactly like a
sent one), the flow binding and Turnstile belong to I-08, and the operational cap and
`email_unavailable` to I-21. Today's portal `/api/magic/start` keeps its per-IP limit only.

### Release keys, the strict verifier and the signed feed (wire contract v4, P3-02)

Wire contract v4 (`docs/security/WIRE-CONTRACT-V4.md`) adds two signed documents and a second
signer. P3-02 lands the contract, the types, the corpus and the verifier fixes in every SDK; the
Worker routes, ingest and composer arrive with P3-03, and the Worker's write checks and signer
guard with P3-12, each of which extends this section.

- **A third trust input: the pinned release keys.** A release record (`pkey-release+jws`) is
  signed in CI by a release key and verified **only** against the release keys the app pins
  (`pinnedReleaseKeys`), never against, merged with or extended from the product trust set. The
  Worker never holds a release key's private half, so it cannot mint a record (the two-signer
  model): a compromised Worker or KEK can choose among CI-signed releases, but cannot ship bytes
  no release key signed, because every SDK verifies the record's signature, and then the
  payload's `size` and SHA-256 against the record, before staging.
- **Release keys are never product keys.** If a product key were pinned or declared as a release
  key, the Worker would hold the private half of a "release key" and the two-signer property
  would be gone without a trace. Three checks keep them apart: `verifyReleaseRecord` refuses at
  step `jws` when the selected release key's bytes are also in the effective product trust set
  (`record-release-key-is-product-key`); every SDK refuses options whose `pinnedReleaseKeys` and
  trust pins share a key (`invalid-options`); and P3-03's `.pkey/release` sync refuses a declared
  release key equal to any current or retired product signing key
  (`release_key_is_product_key`).
- **Hash before signature.** A feed pins each record by the SHA-256 of its exact compact JWS. A
  client refuses a body over 88 844 bytes or with a non-ASCII byte without hashing it, and
  checks the hash before any Ed25519 work, so substituting a record is caught by the cheapest
  check and no attacker-chosen body reaches the signature code.
- **One strict verifier for all six `typ`s.** Every SDK applies Ed25519 strictness (`S < L`,
  canonical and non-small-order `A` and `R`, cofactorless equation) and an I-JSON profile
  (well-formed UTF-8, no BOM, no lone surrogate, no U+0000 in a member name, numbers inside
  binary64's range, at most 64 levels) before trusting a byte, and decides every integer claim
  from its token. Before v4 the four backends disagreed on 25 such vectors (OpenSSL accepted
  non-canonical keys CryptoKit refused, Python accepted `NaN`, Swift accepted a trailing comma
  and decided a mistyped bundle member at the wrong step, Godot read `1e4294967297` as 10), and
  all four accepted a small-order `R`. A divergence between verifiers is a forgery that works
  against some installs; the corpus now pins the strict verdict in every language. P3-12 makes
  the Worker unable to sign anything the strict verifier refuses. The verifier's work and memory
  are linear in the capped payload: each SDK holds the non-wire-integer pointers as a tree of
  reference tokens and builds full pointer strings only when a caller lists them, because one
  pointer per number grows with the square of the payload (a 64 KiB document of long member
  names over fractional numbers cost 0.25 to 1.5 GB). Each of shared-jws, Swift and Godot has a
  regression test on that document.
- **The signer is total, and stored data cannot trip it (P3-12).** Two guards make the Worker
  unable to sign what the strict verifier refuses: `signJws` throws `StrictJsonError` on a
  serialized header or payload that breaks a strict-JSON rule (a lone surrogate, U+0000 in a
  member name, a number out of range, more than 64 levels, a payload that is not an object), and
  `signDoc` throws it first when an integer claim of a v3 `typ` is not a safe integer of at
  least its minimum. The trust manifest signs through `signDoc` too, and the builders compute
  `graceUntil` with integer arithmetic. Every signing route (the licence and config documents,
  the trust manifest, the offline bundle mint, the EdDSA edge mint) answers a refusal as
  `500 document_not_representable` in its own body shape, never as an unhandled throw and never
  as a signed document some SDKs reject: a divergent document is a denial of service against
  the stricter installs, and could become a forgery if verifiers ever disagreed about it. The
  refusal is not logged, because the Worker logs nothing (R12) and the value may be a secret.
  Write checks keep stored operator data from turning into such refusals, apart from the
  residuals below. One function,
  `representabilityIssue` in `shared-catalog` (lone surrogate, U+0000 in a member name, two
  sibling names equal after NFC, a number out of range, more than 32 levels inside the value),
  runs first in `validateEntryValue`, so licence overrides and profile payloads refuse such a
  value with `422 value_not_representable` before a secret is sealed, and the catalog prune drops
  a stored one from the config document. The manifest validator refuses it anywhere in a
  `.pkey/` document (`value_not_representable`), which covers the values only the sync writes:
  catalog defaults, provisioning entitlement values and edge-mint claims templates. The admin
  product, tier and licence handlers take the manifest's own patterns (`KID_RE`, `ID_RE`,
  `CHANNEL_RE`, `SEMVER_RE`), `MAX_WIRE_INTEGER` and the 1–365 offline-day rule, and refuse
  unsignable free text (a licence name or email, a tier label). A catalog entry key is a member
  name in every document that carries it (`config.<key>`, `secrets.<key>`,
  `entitlements.<key>`), and neither `new Catalog(...)` nor the prune checks keys, so the
  console's catalog publish and manual product create also apply the member-name rules to the
  keys (`catalogKeyIssue`: a lone surrogate, U+0000, two keys of one kind equal after NFC) and
  the manifest's `ID_RE`. OIDC sign-in stores a
  provider's unsignable name or email as null and skips an unsignable provisioning hook, rather
  than letting a third party's claim deny the user their documents. **Residual:** values stored
  before P3-12 (catalog keys included) are caught only by `pnpm check:representable`, which an
  operator runs against
  production D1 before the first deploy (RUNBOOK, "Representability check"); skipped, a flagged
  entitlement makes that licence's documents answer 500, and the check cannot open a sealed
  secret, which the prune drops at signing instead. A stored value that only fails a pattern
  (a channel `Beta Channel`) still signs and is refused the next time a write touches it.
  **Residual (offline-day counts):** the builders floor a fractional day count, but a count of
  about 1.04e11 days or more, or below about −20 000, makes `graceUntil` unsignable, and every
  licence and config document that uses it answers 500. The admin paths refuse anything outside
  1–365. The manifest sync does not yet: the validator leaves `licensing.defaultMaxOfflineDays`
  unbounded (plans/P3-01.md §8 risk 13, an unscheduled rule-9 follow-up), and resync and repo
  link store it in `products.default_max_offline_days`. Until that rule lands, only the
  operator's product manifest can introduce such a count, and `pnpm check:representable` flags
  it (not as a warning) wherever it is stored.
- **The canonical channel and its residual.** A feed's `channel` claim is the canonical channel
  the Worker resolved, which keys the client's `seq` floor; a `latest` claim is refused, and no
  SDK resolves an alias itself. One residual is accepted (plan decision 4): a request for
  `staging` binds to `staging` or to `beta`, so a network attacker can answer it with a genuine,
  unexpired `beta` feed of the same product. A `staging` grant already covers `beta`, and that
  feed is checked against `beta`'s own floor; committing it removes a manual `staging` entry, so
  a later replay of an older `staging` feed meets no floor, but such a feed must still be
  unexpired, and the attacker could as well have withheld the answer.
- **Feeds do not move the clock floor**, and their freshness is judged against the effective
  clock, so winding the system clock back cannot revive an expired feed. A stale feed freezes
  updates (`none {stale}`); a stale feed never stops play. A CI revocation of a required pack
  can (`plans/P4-13.md` §2.6), even on a stale feed: the revocation is already stored on the
  device and is applied without a fresh feed.

P3-03 adds the Worker's half: the record ingest, the record and feed routes, their four tables,
the composer and the `seq` ceiling script.

- **Record ingest refuses before it stores.** `POST /<p>/release/publish/submit` carries the
  CI-signed record beside the descriptor, and checks it after the descriptor and before anything
  is promoted. One code, `release_record_rejected`, with a reason per check, in order: `typ`
  (`pkey-release+jws`), `kid` (one of the product's declared `releaseKeys`), `product-key` (that
  key is none of the product's signing keys, current or retired — the Worker holds those), the
  signature through the strict verifier (`signature`), `releaseRecordClaims` given the verifier's
  non-wire-integer pointers (`claims`, the claims every v4 SDK runs), the version under the
  deliverable's scheme (`scheme`, SemVer 2.0's grammar for `semver`), the record equals the
  descriptor under the §2.4 mapping (`descriptor-mismatch`: a CI step that signs one thing and
  submits another is refused; the descriptor must also carry the record's `seq` explicitly, so
  a publish that loses a `seq` race is refused by P2-04's explicit-seq guard with nothing stored,
  never stored unaudited without its record), and the release's `seq` (`seq`). A refusal stores
  nothing. An
  accepted record is written in the descriptor's own batch, guarded on that descriptor and seq,
  into `release_records`, which is never rewritten: a re-run keeps the first record. Ingest is
  defence in depth — clients trust only pinned release keys — so a record that slipped past it
  still fails on every device. The Worker never holds, accepts or mints a release key's private
  half. `.pkey/release` `releaseKeys` is repo-owned like `sparkleEd25519Pub`, so a repo writer can
  declare a key they hold; that changes nothing on devices (they pin their own keys), and each
  declared key is also written to the key inventory as a `release`-purpose OBSERVATION (never an
  entry; `dist_keys` `source = 'ci'`, capped like CI reports, no per-observation audit row — see
  "The key inventory is the independent control"), which flags the purpose for the operator
  until they adopt or dismiss it.
- **The record route** (`GET /<p>/release/records/<sha256>`) serves the stored bytes exactly
  (their hash is the path) under the release METADATA mode, in the blob route's order: the
  mode's request-level check first (under `entitled`, only a usable licence), then an unknown
  hash is the plain 404, so the route is no oracle for which records exist; under `entitled` the
  licence's window must also admit the record's own release (its stored version, pinned). A hash
  learned elsewhere unlocks nothing the device could not already download. Public records are
  `immutable`; gated ones `private, no-store`.
- **The feed route** (`GET /<p>/update/<channel>/feed.jws?platform=`) holds nothing
  device-specific: one stored document per (product, canonical channel, selector) in
  `update_feed_docs`, re-signed when the composed content's hash changes or the copy is 450 s
  old, so one signing serves every caller. Only a channel that offers, or once offered,
  something is stored: a channel with no target and no `update_feed_state` row — any of the ~10⁷
  `pr-<n>` spellings, an unused manual channel, a product with no app release — is signed at the
  starting `seq` (1, or the ceiling) and writes no row, so an unauthenticated caller choosing
  channel names cannot grow D1 (R10). What is left is one Ed25519 signing per request, behind
  the per-address 60/min `updateFeed` bucket (`clientIp`, no /64 grouping: R10-04b). Access is
  the METADATA mode, checked per request
  before anything is composed or served; under `entitled` the licence must hold the CANONICAL
  channel. The composer is the first reader of `dist_rollouts` and `dist_availability` that
  decides what a device is offered, and it reads Distribution only through the `delivery` and
  `outletCapabilities` hooks (`delivery.outlets()` is new and read-only); without the hook every
  outlet entry is empty, so nothing is offered. A rollout is copied only for its own release, and
  a store-mirrored rollout is never client-evaluated; a listing URL is composed from the
  outlet's identity and kept only when it passes the per-kind prefixes.
- **The composer's self-check.** Every document is checked with `feedClaims` (the v4 claims, with
  the canonical channel) and `scanStrictJson` before signing, and a document over the 65 536-byte
  payload cap after the per-platform split is not signed: `500 feed_not_composable`. So the
  Worker never signs a feed every SDK would refuse, whichever of P3-03 and P3-12 lands first.
- **`seq` and the ceiling script.** `update_feed_state` keeps one `seq` per (product, canonical
  channel), bumped only on a change of content in one conditional write, capped at 2^53 − 1. The
  recovery from a fast-forward (AT-3) is `pnpm --filter @polaris-key/worker feed:seq-ceiling
--product <slug>`: in one batch it sets the product's `update_feed_ceiling` flag (never
  cleared), raises every existing row to the ceiling and deletes the product's stored documents.
  A row created later starts at the ceiling, so a channel with no row at recovery time — the
  attacker's choice of a manual or `pr-<n>` channel — is covered. It is product-wide on purpose
  and has no per-channel option. Its own risk is denial of updates for the product, not code
  execution: it can only raise `seq`. The RUNBOOK runs it after any suspected product-key or
  Worker compromise.
- **Floors prompt, never block.** A floor (`min_supported`, a record's `minSupportedSeq`, and
  P4-13's pack floors) reaches devices as a prompt the player cannot dismiss, per platform, and
  play continues; License's compatibility window is the only control that stops an old build.
  The one exception is content, not a floor: a CI-signed revocation of a **required** pack with
  no usable replacement stops the boot (`blocked {revoked-content}`, boot `required`;
  `plans/P4-13.md` decision 4, below).

### Revocations, pack sets and floors in the feed (P4-13)

P4-13 (`plans/P4-13.md`; WIRE-CONTRACT-V4 §2.4.1, §2.5.3, §3.4 steps 10–14, §11.1) fills the feed's
reserved content members (`packSets`, `packFloors`, `revocations`), the app's `content.holds` and
the reserved record kind `revocation`. It adds no `typ`, no claim and no route.

- **The revocation record kind keeps the two-signer property.** A revocation is a
  `pkey-release+jws` with `kind: "revocation"`, signed in CI by a release key. A client verifies
  it against the **pinned release keys** only, so the Worker (which holds only the product key)
  can withhold a revocation but never forge one, condemn content or name a substitute. A product
  key cannot sign one (a release key whose bytes are in the product trust set is refused), and a
  delegated content key cannot either (P4-19). Revocations are permanent; a later one may only
  add or change the replacement (newest `issuedAt` wins, `newerRevocation`). Ingest also yanks
  the target, so even a rolled-back Worker stops serving it.
- **Content members never refuse a feed.** They are parsed beside the claims; a malformed member
  is unusable and the app part still decides. A Worker that sheds content for size omits
  `packSets`, then `packFloors`, then unreferenced revocations, then `revocations`, before it
  ever refuses to compose a feed.
- **Revoked required content stops the boot.** This amends P3-01 decision 1 and AT-3's invariant
  (`plans/P4-13.md` decision 4): a revoked required pack cannot be mounted, so continuing would
  end in an error and a boot-guard rollback loop; `required` stops at a confirmed `blocked`. It
  fires only for a pack the stamp marks `required`, revoked with no usable replacement, and so
  only after a CI-signed revocation. A revoked optional pack stops at once when it is hot or
  not yet mounted, and play continues (a mounted Godot `godot.pck` is the exception below).
  Floors still never stop play.
- **A feed target never downgrades a pack**; pins, holds and replacements install exactly, so a
  compromised Worker cannot roll packs back.

Residuals, stated rather than defended:

- **Old SDKs keep revoked content.** A v4 SDK that predates P4-13 verifies the new members and
  never acts on them: it keeps mounting a revoked release until the host upgrades its SDK. The
  yank at least stops new installs. Every SDK release note says so.
- **SDK downgrade.** A host that downgrades its SDK below P4-13 ignores `revocations.json` and
  may mount a revoked release again.
- **Godot: a revoked `godot.pck` already mounted in this process stays loaded until restart**,
  because Godot cannot unload a resource pack. It is withdrawn if not yet mounted, refused from
  the next boot, and `set_changed` fires so the host can prompt a restart. A revoked REQUIRED
  pack gives boot `required` from the next boot.
- **A torn `revocations.json`** is quarantined and replaced by a file whose `relearn` lists the
  stamp's pinned and embedded packs, so their embedded baselines are refused at every boot
  (online the pack is fetched instead) until a fresh feed with a usable `revocations` member
  re-teaches the device. `relearn` clears once every revocation of the pack whose target the
  device holds, pins or would take from the feed is learned; an entry for an older release the
  device does not hold never keeps it set.
- **`relearn` and the size fallback's step 3.** When a feed is over the cap, step 3 keeps only
  revocations whose target a _live_ app release pins or holds, or a row lists. A device on a
  non-live app release can then clear `relearn` from a feed that omitted the revocation of its
  own pinned target, and mount that embedded baseline until a feed lists the revocation again.
- **An unreadable `revocations.json`** with `revocationsStored` set in `state.json` refuses those
  embedded baselines at every boot (a torn `state.json` that lost the flag gets it back when a
  readable `revocations.json` with entries is loaded); one **without** the flag (or with an unreadable `state.json`, so
  the flag cannot be read) refuses nothing offline and can mount a revoked baseline.
- **An unreadable `state.json` with no network** can mount a revoked embedded baseline that the
  device's `revocations.json` does not list; within a process, a baseline a feed verified in
  that process lists as revoked is still refused.
- **The 256-target cap.** A device remembers at most 256 revoked targets; more revocations push
  the oldest (by `issuedAt`) out of its memory, and a Worker that then withholds it can let the
  target mount again.
- **A withheld replacement keeps a required pack stopped.** The Worker can refuse to serve a
  replacement record; the device then keeps `blocked {revoked-content}` until it arrives.
- **A stolen release key can revoke everything.** Devices that verified revocations of required
  packs are stopped until a binary pins a rotated key; on load, an entry whose key is no longer
  pinned is forgotten.

### Content-key delegation (P4-19)

P4-19 (`plans/P4-19.md`; WIRE-CONTRACT-V4 §1, §2.5.4, §2.8, §3.4 step 11, §3.5 steps 13 and 16) fills
the reserved record kind `delegation`. A pinned release key may delegate one content key, through a
CI-signed `kind: delegation` record, the right to sign pack records of the data-only types
(`DELEGABLE_PACK_TYPES`: `files.tree`, `data.json`, `l10n.table`) under one pack-id scope, inside a
signing window of at most 366 days. It adds no `typ`, no claim and no device route; it adds one CI
read route (`POST /{product}/release/publish/delegations`) and the console's read-only Content keys
table.

The new trust boundary is **content CI ↔ device**, mediated by a release-key signature:

- **The Worker cannot forge or widen a delegation.** A delegation verifies against the **pinned
  release keys** only (never the product trust set), so the Worker, which holds only the product
  key, can withhold a delegation (its packs then cannot install) or its revocation, but never mint
  one or change its scope, types or window. A delegated record names its delegation by hash in its
  header `kid` (`pkd1-<sha256>`), so the chain never depends on a Worker-signed member.
- **One level only.** A delegation never verifies through another delegation, so a content key
  cannot re-delegate. Its key bytes must equal no pinned release key and no product key.
- **Release-key surfaces stay release-key surfaces.** The delegated path is allowed only on a
  compatible or standalone pack's feed target and on the reload of a stored delegated install.
  App records, stamp and record pins, holds, revocations, replacements, markers, embedded
  baselines and platform-delivered copies (P5-08's `apple-ba`, `play-pad` and `steam-depot`
  transports) never pass a delegation, so a content-key signature fails there at `jws`. Ingest
  refuses a pin or hold naming a delegated release (`pin-delegated`, `hold-delegated`).
- **Data only.** A delegated release must be tree layout (a container is never delegable), and
  every file passes the data-only rule: an already-normalised path, an extension allow-list (the
  real control, because Godot picks its loader by extension), a head and tail magic sniff that
  fails closed (defence in depth, which also refuses a full 64-byte head window it cannot see
  past), and, for text files, a whole-file rule refusing P4-08's script markers (even split by
  backslashes), `\u`/`\U` escapes that could spell ASCII, invalid UTF-8 and NUL (Amendment A1); ordinary text mentioning a marker is refused too, so publishers rename such keys or text. It runs on the device before
  activation (a `noop` reuse re-sniffs the reused install), in the CLI lint before signing and,
  for the extension rule only, at ingest (`delegation-data-only`). **What it cannot do:** the
  sniffs recognise binary and structured magics plus those text markers; they cannot recognise
  GDScript in general (a script may start with a comment, `func`, `var` and more). Apps must
  parse delegated text only with pure JSON or CSV parsers (`JSON.parse`, `JSON.parse_string`),
  never `str_to_var`, `ConfigFile` or `JSON.to_native(..., allow_objects)`, and must never write
  delegated bytes under a code extension.
- **Revocation is P4-13's record unchanged.** A CI revocation naming the delegation's hash revokes
  every release signed under it (`recordRevoked`, `pack-revoked` detail `delegation`); ingest yanks
  those releases and the feed lists the entry with `kind: "delegation"`, never dropped under the
  64 cap. Only a release key revokes. One key maps to one delegation, so revoking a delegation
  revokes its key for every delegation the release-key holder has.

Residuals, stated rather than defended (`plans/P4-19.md` §8.2):

- **With a compromised Worker, a stolen content key can sign indefinitely.** Devices check only
  that `record.issuedAt` lies inside the window, never their own clock, so the thief backdates
  `issuedAt` and that Worker ingests and serves the result. Only a revocation of the delegation
  that reaches devices (which that Worker can withhold) or a binary that rotates the pinned
  release keys bounds it. Expiry bounds a thief only through an honest Worker (which refuses a
  record more than a day old or outside the window).
- **A delegation revocation also stops legitimate releases** signed under it; a required pack
  then blocks (`revoked-content`) until releases under a new delegation arrive. The RUNBOOK says
  to re-publish first, then revoke, unless the key is actively abused.
- **Data handlers parse untrusted data.** P4-16's handlers must parse and never evaluate it; the
  data-only rule cannot police what host code does with a JSON file. No SDK or handler may pass a
  delegated file to `load_resource_pack` or any engine API that mounts or loads code.
- **The sniff cannot enumerate formats.** A format hidden inside an allowed extension that no magic
  catches passes rules 3 and 4; the allow-list and the handlers are what stand behind it.
- **Old live builds** never install delegated releases; a product delegates only once every live
  build it cares about embeds a P4-19 SDK.
- **A delegation the release-key holder does not hold cannot be revoked by hash.** One minted by a
  thief who stole the release key never reaches an honest Worker, and revocation ingest accepts an
  unstored delegation only when it is supplied alongside. Rotating the pinned release keys is the
  remedy.
- **Publisher policy is unchanged.** Content CI runs the declared workflow in an environment holding
  only `PKEY_CONTENT_KEY`; the signature, not the token, limits what is accepted. A publisher entry
  scoped to packs under a prefix is a P2-02 follow-up.

### Readiness holds, pack gates and the blob collector (P4-14)

P4-14 adds Distribution's outlet readiness (`dist_readiness`), per-outlet pack gates in the signed
feed (`packSets.outlets.<id>.gates`, a member P4-13 froze), and Core's blob collector
(`core/blobGc.ts`, run nightly from `scheduled.ts`). It adds no route outside the console's admin
API and no wire member.

- **The collector deletes only what nothing can serve.** Every read of the blob store is gated on
  the reading product holding a ref (`hasRef`), so an object with no ref from any product is
  unservable; the sweep deletes only such objects, re-checked (`NOT EXISTS` on `blob_refs`) in
  the claim, and again in the row delete. Refs are dropped only for pack releases the hooks call
  dead (never `artifact` or `feed` refs), never for a key any live release's record or index
  names (an index may list a file held only by a dead release's ref), only once older than the
  grace period (30 days, at least one day, `BLOB_GC_GRACE_DAYS`), and — for both `pack-object` and
  `pack-upload` refs — only when the whole live set was read in that tick: an unreadable record
  or index, Release being off, or a spent budget all mean keep. Revoked releases are never live;
  only `kind: record` revocations are read as naming a release. While a pack rollout is not
  complete, every release of that pack below its target is live, so a gate's fallback (which may
  sit at another contentApi level) keeps its bytes.
- **The bucket lock is not weakened.** The sweep never attempts a delete before an object's
  `created_at` is older than the 180-day lock, so a lock refusal means a bug, which fails the step
  and releases the claims (`blob_gc_log` `delete-failed`). An indefinite lock would make the
  collector fail every night; escalate instead of shortening it.
- **No publish can earn a ref to bytes being deleted.** The sweep claims an object
  (`gc_claimed_at`, one conditional statement) before the R2 delete; `promote`'s `recordObject`
  refuses a claimed object (`changed`, retryable) and clears `unreferenced_since` otherwise, so a
  re-promote restarts the grace period. A promote that confirmed existing bytes looks again after
  recording the row (no claim can follow inside the grace period then) and re-puts the staged
  copy if a sweep deleted them in between, so it never answers success for missing bytes.
  Re-earning an existing ref moves its `created_at` forward. A ref the collector itself dropped
  from a release that is live again (a plan computed before a concurrent ingest) is RESTORED on the
  next tick, long inside the grace period, so the sweep never reaches it.
- **Restoring is not earning.** The collector restores only a ref it took from the same product
  (a `ref-dropped` row in `blob_gc_log`), for a key a live release's own verified record, files
  index or chunk index names, on an object still stored and unclaimed. It can never give a product a ref to
  bytes it never held, even ones another product holds.
- **No cross-tenant oracle.** The console's dry run (`GET …/blob-gc`) lists only this product's
  refs and never says whether another product holds the same bytes.
- **Readiness holds fail closed.** The hold is computed on read: an app release whose required
  pack set is not available through a holdable outlet's transport (or cannot be computed yet)
  reads `pending` there in availability, so the signed feed's `live` and the storefront feeds stay
  on the previous release. Only an operator override (audited, with a reason, operator-owned,
  surviving resync) releases it. On a store outlet Polaris Key cannot hold, it warns.
- **Pack gates only narrow.** A gate can send a device to its `fallback` (the previous set's
  release, a key of the signed `releases` table) or keep it where it is; it never names a release
  the device would not accept (a downgrade is not installed, P4-13 §2.6). A mirrored (store)
  rollout composes no rollout gate.

Residuals, stated rather than defended:

- **A dead release stops being served at once.** Once a pack release leaves every live reference
  (and is older than the three newest), the tick drops its refs and the blob route stops serving
  it; a device still mid-way to it falls back to the feed's current set.
- **A deleted product's objects are never collected.** Its refs are kept (fail closed), so its
  objects stay until an operator removes them.
- **The bundle hook point.** Until Release implements `packChunks` (P4-22), every ref to a
  `bundles/` key is kept, and bundle storage only grows.
- **`blob_gc_log` names keys, not tenants, for deletions.** An object's deletion is attributed to
  no product; the `ref-dropped` rows say which product dropped the last ref.

### Lazy hot-pair deltas (P4-17)

P4-17 adds install telemetry (`devices/report`'s `packInstalls`), a demand store in D1, a queue
(`pkey-deltas-<env>`, with a dead-letter queue) fed by the nightly sweep and by an R2
event-notification rule on the payload prefixes, and a **second Worker script**, the consumer
(`polaris-key-deltas-<env>`, `wrangler.deltas.toml`), which encodes `zstd-patch-from` deltas in
WebAssembly (`@polaris-key/zstd-wasm/encoder`, level 9, levels above 15 refused, 32 MiB per side).
It adds no route and no wire member. Off by default twice: the `LAZY_DELTAS` var in both scripts
and a per-product `lazy_delta_settings` row.

- **A lazy delta carries no trust of its own.** It is in no CI-signed record. A device that is
  offered one checks the artifact's SHA-256 and length, that its base is the installed payload,
  and that the output's SHA-256 is the target's, which comes from the CI-signed pack record
  (A7 §3.4); any mismatch fails the strategy and the device falls back. **A compromised Worker
  (either script) can therefore offer junk deltas, which costs bandwidth and CPU, never
  integrity.** The same window check every applier makes (`windowLogMax` from `memBytes`) bounds a
  hostile frame's memory before it is decoded.
- **No byte work on the request path.** The report handler only upserts D1 counters for an
  opted-in product; it reads no payload, decodes nothing and enqueues nothing (asserted by
  `test/register.test.ts` with a blob store that throws on use, and by a source check that only
  `src/deltasEntry.ts` imports the encoder). Every encode runs in the consumer, one message at a
  time (batch 1, concurrency 1), so an encode never shares an isolate with a request or with a
  second encode.
- **Telemetry cannot write bytes, only counts.** A device can claim any (from, to) pair, but a
  claim only upserts its own row for that pair, and a device holds at most 32 demand rows per
  product (`MAX_DEMAND_ROWS_PER_DEVICE`; each report evicts its oldest past that), so what one
  device can write is bounded however many pairs it invents; the consumer encodes only between two payloads of
  the same pack and variant that stored CI-signed records name, which the product holds refs to
  (possession, as for every other ref), under the threshold (25 distinct devices in 7 days by
  default) and the daily cap (20 per product by default). A fleet of forged devices can at most
  make the product spend its daily cap on deltas it did not need; they are verified like any
  other. The inputs are checked against the payload hashes the records name before encoding,
  and the frame is decoded over the base and compared with the target before it is stored.
- **Publish rules hold.** Never against a base starting with `37 A4 30 EC`; one bare frame with
  its content size and checksum; stored only through `putVerified` (R2 checks the SHA-256, the
  write is create-only) under `deltas/<from>/<to>.zstd-patch-from`, or under `gated/` when either
  side is gated, so a gated delta is served (once the feed offers it) only through the same
  delivery authorisation as the gated payloads.
- **The ref a lazy delta earns.** The consumer records the object (`blob_objects`, kind `delta`)
  and a `lazy-delta` ref for the product whose two payloads it read. The key is content-derived,
  so two products with the same pair of payloads reach the same object; each earns its ref only
  through its own possession of both payloads (its `pack-object` refs) and its own opt-in, never
  from the other's. The collector never drops a `lazy-delta` ref; the sweep drops it when the
  delta goes cold (no device reported the pair for 30 days), after which the collector's normal
  mark, grace and lock rules apply.
- **Poison and replay.** Each message is acknowledged or retried on its own; a malformed one is
  acknowledged without work. Idempotency comes from the pair's `release_lazy_deltas` row and the
  deterministic key (`head` before work, create-only put), never from the event: a duplicate or a
  re-PUT event does nothing.
- **The delta menu (P4-29, WIRE-CONTRACT-V4 §2.4.2).** The feed's `deltas` member offers the
  `ready` lazy deltas per target payload (at most 4 per target, 64 per feed). It is inside the
  feed payload, so the **product key** signs it: it carries the Worker's authority, never CI's.
  A device merges an entry into the selected container variant only beside the record's own
  deltas (a record delta wins a shared id and a cost tie), and the applier checks the artifact
  against the entry, the base against `from`, the frame's window against `memBytes` (bounded by
  the device's `memBudget`) and the output against the **CI-signed record's** `payload`, writing
  at most `payload.size` bytes. Any failure, a 404 included, falls back, and **at most one
  feed-offered delta is tried per install**, so a hostile menu wastes at most one artifact the
  planner already priced below the alternatives. The menu is added last into the room under the
  feed's 65,536-byte cap and trimmed first, so it can never shed a content member or make a feed
  uncomposable. Serving follows the pack's delivery rule: the blob route resolves a lazy delta by
  its hash only through this product's `lazy-delta` ref, so a `gated/deltas/…` frame is served
  only to a caller the pack's current gate admits, and a cold delta (ref dropped) is the plain
  not-found. Either P4-17 switch withdraws both the menu and the serving at the next request.

Residuals, stated rather than defended:

- **Demand rows hold device ids.** `delta_demand_devices` keeps (device, pair, strategy, time) for
  30 days to count distinct devices (docs/PRIVACY.md); they are not purged with the device.
- **workerd enforces neither 128 MB nor `cpu_ms` locally** (notes/S-08 §2.5). The memory budget is
  a test against the encoder's own measurement, and the cap is the only defence against an
  isolate OOM in production; a pair above it is refused as `over-worker-cap`, never attempted.
  At the 32 MiB cap linear memory peaks near 84 MiB, and the frame lives once, in one buffer
  preallocated at the largest frame worth keeping (about 22.4 MiB against an incompressible
  32 MiB full object): the worst case measured, a random base and a target 68% new incompressible
  bytes, is 83.8 + 22.4 = 106.2 MiB, which a test keeps under 110 MiB. The remaining headroom to
  128 MB (JS heap, the runtime, the index reads before the encode) is an inference, not a
  measurement, until the live check at the cap (RUNBOOK "Lazy deltas").

### Platform deploy identity and the platform audit trail (A-11, A-12)

The console's Platform section (notes/S-13) starts with two read surfaces, both behind the
existing admin dispatcher (session, `PLATFORM_ADMIN_GROUP`, the per-subject limiter, CSRF on
mutations) and a second platform-admin check in `admin/handlers/platform.ts`:
`GET /manage/api/platform/{version,deployment}` (A-11) and `/activity` (A-12). There is no new
privilege level.

- **Deploy metadata is not secret.** The release tag, commit, Actions run URL, Cloudflare version
  ids, the applied-migration list, missing required indexes and binding presence are visible to
  anyone who can read the repository's Actions tab or the Cloudflare dashboard, and the binding
  list reports presence as a boolean, never a resource id. They help an operator, not an
  attacker. `PKEY_RELEASE_TAG` and `PKEY_GIT_SHA` are plain `--var`s, so a hand deploy can set
  anything; the Worker validates both against a strict pattern and answers `null` rather than
  echo a malformed value, and the unforgeable half is the `CF_VERSION_METADATA` binding.
- **`platform_deploys` has one writer, outside the Worker.** The final `deploy.yml` step inserts
  one row with the deploy token, which already holds D1 edit because it applies the migrations:
  no new credential, no new permission. `wrangler d1 execute --command` takes no bind
  parameters, so `scripts/record-deploy.mjs` checks every value against a strict pattern before
  quoting it and writes nothing when one fails. The step is `continue-on-error` and runs last, so
  it cannot fail or reorder a deploy. No Worker path writes the table, and a forged row (which
  needs the D1-edit token) misleads only the history view, never what is deployed or served.
- **Audit integrity.** `platform_audit` is append-only from the Worker's side: one writer,
  `platformAudit()`, whose actor comes from the verified session and whose `at` is server time,
  and no route that updates or deletes a row. The only delete is the nightly retention step
  (180 days, the same as `audit`). As with `audit`, anyone holding the D1-edit deploy token or
  the dashboard can rewrite it; the trail is evidence against a console session, not against
  the account. `before_json` / `after_json` must never hold a secret: the KEK re-seal sweep
  records row counts only (a test asserts no KEK value appears), and A-13's settings registry
  holds no secret by construction. The per-product `kek.reseal` rows stay, so each product's own
  log still shows the sweep.

### Platform settings and operations: the runtime settings store (A-13)

A-13 makes four deploy settings editable from the console without a deploy, through
`platform_settings` (migration 0056) and `GET`/`PATCH`/`DELETE /manage/api/platform/settings`
behind the same gates as the rest of the Platform section (session, `PLATFORM_ADMIN_GROUP`, the
per-subject limiter, CSRF on mutations, and `handlePlatform`'s second platform-admin check). There
is no new privilege level and no outbound call.

- **What is editable is a closed list in code.** `PLATFORM_SETTINGS` (`core/platformSettings.ts`)
  declares `LAZY_DELTAS`, `LAZY_DELTA_MAX_BYTES`, `BLOB_GC_MODE` and `BLOB_GC_GRACE_DAYS`, and
  nothing else: a D1 row with any other key is ignored, and a value outside an entry's validator
  is never applied (the resolver falls through to `[vars]` or the code default). Each is a
  background job's kill switch or tunable. The worst a hostile session can do with them is waste
  delta CPU (bounded by each product's daily cap and the 32 MiB ceiling, which the size cap can
  only lower: "lower" is enforced against that 32 MiB constant, not against the deploy-time
  `[vars]` value, so a deploy-time 8 MiB cap does not stop a console write of 16 MiB), stop the collector (it costs storage), or restart it with a one-day grace (the
  180-day R2 age lock still bounds every deletion, and the collector deletes only unreferenced
  objects; see "Readiness holds, pack gates and the blob collector"). None changes what a device
  is offered or what is signed.
- **Why nothing else may join it (AT-2).** Whoever takes the admin plane already reaches A2, A3,
  A5 and A6 through the API for as long as the session lasts. A runtime knob that _widens_ what a
  session can do (a longer session TTL, a raised rate limit, a looser `OIDC_ISSUER_ALLOWLIST`, a
  different `PLATFORM_ADMIN_GROUP`, another origin, a KEK kid, the admin IdP) would let that
  session make itself permanent, or move the platform's trust roots, from inside the console.
  Deploy-time settings need the repository and the deploy token, a separate boundary. So
  origins, the privilege root, the admin IdP, security gates, key material and kid selection,
  session lengths, rate limits, retention periods and bucket names stay deploy-time, and
  `test/platformSettings.test.ts` refuses any of those names (or a `*_SECRET`, `*_KEY*`,
  `*_TTL*`, `*_ORIGIN` or `*_PEPPER` name) in the registry.
- **A deploy-time off survives a compromised session.** Kill switches use `ceiling` precedence:
  `[vars]` = `off`, or any string that is neither a recognised value nor `runtime` (`false`, `0`,
  `disabled`), is a hard off that no D1 value overrides (a typo fails closed, and the inventory
  warns), and the resolver answers it without reading the table. The committed value is `"runtime"` (the console decides, default off for
  lazy deltas, on for the collector). An unreadable store resolves a kill switch to off, never on.
- **Auditable, race-free writes.** Every `PATCH` and `DELETE` carries `expectedVersion` and is
  one conditional statement (409 on a mismatch, also when the version moved before the audit
  snapshot was read), so two operators cannot silently overwrite each other. A `DELETE` leaves a
  tombstone row so the version never goes backwards and a stale `expectedVersion` cannot pass.
  Each write commits in ONE batch with its `platform_audit` row (actor from the verified session)
  carrying the stored and effective value before and after: a failed audit insert rolls the
  write back. `before_json` / `after_json` are safe because no secret
  can be in the registry.
- **The inventory never reveals a secret.** `GET …/settings` reports deploy-time values that are
  not credentials (the environment, the admin group name, the IdP issuer and client id, the
  parsed issuer allowlist, the origins, the bucket, the account and GitHub App ids, kid names)
  and every secret as `{ name, set }` only: never a value, a length, a prefix or a hash. It warns
  when the console still borrows the platform IdP client (`ADMIN_OIDC_*` unset, I-03), when
  `PLATFORM_KEK_ID` is set, and when `PORTAL_SESSION_SECRET` is unset (the portal then signs with
  `ADMIN_SESSION_SECRET`).
- **Propagation.** Each isolate caches the table for 30 s; the cron handler and the lazy-delta
  consumer re-read it at the start of each invocation. A setting that must take effect instantly
  does not belong in this store.

### Self-reported operations (A-14)

`GET /manage/api/platform/operations` (A-14, notes/S-13 §7.2 phase 1) sits behind the same
dispatcher and platform-admin check as the routes above. It reads only what the Worker can see
itself: binding probes (D1 `SELECT 1`, a KV `get` and an R2 `head` of a fixed absent key), the
two queues' `metrics()`, D1's `meta.size_after`, `blob_objects` totals, the required-index check,
the connector tables, and two new Core tables the Worker writes about itself. **Phase 1 adds no
credential and no outbound host.**

- **`platform_job_runs` holds cron failure reasons.** One run per cron tick, persisted from the
  `MaintenanceReport` `handleScheduled` already builds: successful per-product steps folded by
  family, each failed step under its full name with the caught exception's message truncated to
  300 characters. These are the strings the thrown aggregate already writes to Cloudflare's
  invocation logs, now admin-readable for 30 days (pruned nightly). No request data reaches a
  cron step, and the R12 posture keeps exception messages secret-free. This is **not** an
  unhandled-exception ring: nothing in a request path writes free text to D1.
- **`platform_heartbeats` holds one row per script.** `main` on every cron tick and `deltas` (the
  lazy-delta consumer) after every batch: time, the validated release tag, the Cloudflare
  version id, a truncated outcome label and, for the consumer, the queue backlog after the batch.
  Nothing in it is secret.
- **`DELTA_DLQ` is a send-capable binding used only to read.** The request Worker binds the
  dead-letter queue `pkey-deltas-dlq-<env>` as a producer so the Operations page can call
  `metrics()`; Cloudflare offers no read-only queue binding. A source check
  (`test/platformOperations.test.ts`) asserts no file calls `.send` or `.sendBatch` on it and
  that only `env.ts`, `core/operations.ts` (which hands it straight to `queueStatus`) and the
  binding-presence list name it. The residual risk, accepted: code running in the request Worker
  could enqueue junk into a queue that has no consumer and whose messages expire after 4 days.
  It reaches no device and no signed document.
- **Probes are bounded.** Each binding probe has a 3-second limit and is fault-isolated, so a
  hung binding degrades one panel, not the admin plane. Error text in the snapshot is truncated
  and comes from caught exceptions; binding presence is a boolean, never a resource id.

### The compatibility matrix and the device simulator (P4-15)

P4-15 adds two read-only routes to the console's admin API: `GET …/release/compat` and
`GET …/update/simulate`. Both sit behind the platform-admin session, CSRF and rate-limit gates of
`admin/api.ts`, write nothing and audit nothing, and add no wire member.

- **No product-key use.** To run client-core's own update check (no second implementation),
  `simulate` must hand the device a signed feed. It signs the document `documentFor` composes with
  an **ephemeral** Ed25519 key generated per request (WebCrypto), and the simulated device trusts
  that ephemeral public key for the feed. The module never reads the product's signing key: the
  admin handler passes it only the product's slug and no `env` (since the P4-29 follow-up, also the
  `LAZY_DELTAS` switch's string value, so the simulated document lists the delta menu; a string,
  never a binding), so nothing on this path can unseal a key, and a test asserts no other product
  field is read. The console therefore cannot be used as
  a product-key signing oracle, and the product key is not exercised on every console click. The
  ephemeral key is dropped with the request; the JWS is never stored, returned or served, and the
  channel's `seq` does not move.
- **The feed signature is not under test here.** Because the device trusts the ephemeral key, the
  simulator says nothing about the product key's signature over the real feed; the conformance
  corpus and the feed route's own tests cover that. The product's PUBLIC keys (public columns
  only) stay in the simulated trust set, so the refusal of a release key equal to a product key
  still runs as on a device.
- **Records stay real.** The simulator's record fetches read `getRecordByHash`, the store the
  record route serves, and verify against the product's real release keys, so record, revocation
  and replacement verification (P4-13), and the delegated-record path with its delegation
  revocations (P4-19), run exactly as on a device; a record that fails is reported in `errors`,
  never trusted.
- **No cross-tenant read.** Both routes read only the session's product; a device id passed for the
  rollout buckets is hashed in memory and echoed back, never stored.

### Packs on the wire (packs v1, P4-21)

Packs v1 (`plans/P4-01.md`; WIRE-CONTRACT-V4 §2.5.1–§2.7, §3.7) adds no `typ`, no feed field and
no device route: a pack release is one more `pkey-release+jws` record (`kind: "pack"`), an app
record names the packs it needs in `content`, and a build carries its embedded packs beside
markers. P4-21 lands the claims, the formats' parsers and the corpus; P4-02 (ingest), P4-04
(appliers and the content corpus) and P4-06 to P4-08 (SDKs) extend this section.

- **Pack records keep the two-signer property.** A pack record is signed in CI by a release key
  and verified only against the pinned release keys, exactly as an app record (§3.5's steps
  12–15, with step 15 comparing the pin's `kind`); the Worker signs none. Every object a pack
  record names is pinned by an object ref over its stored bytes, and per-file detail lives in
  side objects pinned by hash, so a compromised Worker or bytes host can withhold or substitute
  bytes but every substitution fails a hash check before it is used.
- **The content stamp is as trustworthy as the build, and no more.** `pkey-content.json` is
  unsigned and decides which pack releases the running build requires. It is embedded in the
  build, which is the running code, so a stamp the attacker can change is code the attacker can
  change. Node, Python and Swift hosts must load it from the app's own read-only resources (the
  app bundle, the install directory), never from a user-writable path such as a cache, a
  download directory or a configuration file; Godot reads it from `res://pkey_packs/`. A changed
  stamp can only choose among release-key-signed records, by hash, or drop packs; it cannot
  inject bytes, because every pin is a record hash and every record is release-key signed.
- **A marker binds embedded bytes through the signed record.** An embedded pack's marker
  (`pkey-marker/1`) carries the pack record's compact JWS; the device verifies it (§3.7), then
  matches the payload's SHA-256 and size, or a tree's `treeDigest`, against a variant of that
  record, and, where the stamp pins the pack, the record's hash against the pin. A marker
  copied beside other bytes, or naming another release, is not used.
- **Path rules run before any byte is written.** Every path in a files index passes the path
  rules (ASCII, no `..`, no empty or dot segment, no Windows device names, no case collision or
  file/directory conflict, and no first segment `.pkey`, where a tree's marker lives) before an
  applier writes anything, so an index cannot direct a write outside the pack's directory or
  over its marker (`files-unsafe-path`, `files-duplicate-path`, `files-case-collision`,
  `files-path-conflict`).
- **Forward-compatible claims never make a v1 client act on what it does not know.** A value
  outside a v1 vocabulary (a type, layout, codec, delta method or scope, delivery, axis) makes
  that pack, variant, object or delta unusable on a v1 SDK while the record still verifies, so a
  later CI can sign records a v1 client accepts and safely ignores; no claim lets an unknown
  value select a code path. Cross-record rules (every expected pack pinned, `embeds` ⊆ pins, no
  entitlement on a required pack) are publish rules, enforced by the CLI and ingest, never
  trusted from a client.
- **Decoding is bounded before it starts.** Every decoded length is declared by a signed ref
  and checked before allocation: a files index or patch descriptor against
  `MAX_FILES_INDEX_BYTES` (32 MiB) on a client before it is fetched or decoded, its entries
  against `MAX_INDEX_FILES`, and every object's stored SHA-256 and length against its ref before a
  byte is decoded, the decoded length against `size` after. Every `zstd-patch-from` frame's header
  window (`frameWindow`, read from the bytes alone) is checked against
  2^`windowLogMax(memBytes)` before it is decoded, by the applier itself in every SDK, and refused
  as `delta-apply-failed`: libzstd enforces its own window limit only when it streams through a
  small buffer (one-shot decodes, a full-size output buffer and Godot's engine decoder accept the
  window), so a decoder parameter is never relied on (plans/P4-01.md §2.7 rule 3). The content
  corpus pins the rule (`frameWindowCases`, `delta-whole-window-over-mem-bytes`,
  `file-delta-tree-small-window`). `@polaris-key/zstd-wasm`, the decoder-only libzstd 1.5.7 WASM,
  makes the same check itself: it decodes exactly one frame whose declared content size is the
  caller's, and with a raw-content prefix refuses a frame whose header window is above
  2^`windowLogMax` before decoding. Its workerd entry instantiates the module per decode, so no
  decode's linear memory outlives the call. The corpus generator, the conformance runners, the
  Worker's index ingest (P4-02), `@polaris-key/react`'s pack facet (its browser entry) and
  `@polaris-key/node`'s fallback below `node:zlib`'s dictionary floor (P4-06) call it. The JS
  appliers (`@polaris-key/client-core/packs`, P4-06) run the header check before every prefix
  decode whichever decoder is injected, refuse a base that starts with the dictionary magic before
  any decoder sees it (rule 5), and take every decoded length from a signed ref; Python, Swift and
  Godot follow in P4-07 and P4-08.
- **Chunk indexes and bundles (P4-10, plans/P4-10.md §2.3–§2.5).** A variant's `chunks` names a
  binary `pkey-chunks/1` index by an object ref; the claims refuse a malformed one (checks
  81–83). Bundles are untrusted containers: every chunk is checked against its `clen`, decoded
  one-shot to its `len` and hashed against its `id` before it is used, and the whole payload is
  hashed again before it is installed. A chunk's `len` is declared by the signed index and bounded
  by `MAX_CHUNK_BYTES` (4 MiB), which `planTarget` enforces before anything is fetched (an index
  holding a longer chunk makes the strategy unusable), so an applier never allocates more than
  one chunk's `clen + len`; `MAX_CHUNK_INDEX_BYTES` (16 MiB) bounds the index, not a chunk, and is
  checked before the index is fetched or decoded. The index length is compared in exact
  arithmetic and every u64 is two u32 reads saturated at 2^53, so no SDK's integer width changes a
  verdict. A `Range` is only ever answered from a bundle the signed index names (the request
  names the bundle by its SHA-256 and carries `If-Range` on it), and a short or clipped answer is
  `chunk-bundle-truncated`, never a partial install. On the device (P4-11) a run is read only
  from a `206` whose `Content-Range` is exactly the request (or the same start clipped at the
  object's end, which is truncation) and whose `ETag`, when present, is the quoted bundle hash; a
  `200`, another range or another tag stops the strategy and the next one runs, and no SDK ever
  sends a multi-range request or reads a whole bundle to recover. Seed indexes kept under
  `index/<sha256>` are re-parsed against their install's record and payload on every use, seeded
  chunks are covered by the final payload hash (the repair pass refetches any that differ), and a
  resumed run's bytes are re-hashed before they are reused. The chunk strategy never carries a
  delegated release (those are trees; chunks are container-only). Blob fetches never carry the
  device bearer past the control plane's origin: once a redirect leaves it, `Authorization` stays off
  for the rest of the chain, and an `https` → `http` redirect is refused (Swift and Godot). Ingest of `chunks` is P4-22's
  (below, "Pack ingest").

**Pack ingest (P4-02).** The Worker still signs no record: a pack record is CI-signed, and ingest
(`services/release/packs/`) only verifies it, checks it against the pack's declaration and the
blob store, and stores it. What the Worker newly does is parse CI-supplied bytes:

- **A new parser of CI-supplied bytes inside a shared isolate.** Ingest and the catalog hook's
  `packFiles` decode files indexes with `@polaris-key/zstd-wasm` and parse them with
  client-core's `parseFilesIndex`, inside a Workers isolate of 128 MB that concurrent requests
  share (notes/E5, E7). Each index is bounded by `MAX_PUBLISHED_INDEX_BYTES` (8 MiB, stored and
  decoded), refused before anything is read, so one decode and parse peaks near 37 MiB; indexes
  are held one at a time, each dropped before the next is read, with a fresh WASM instance per
  decode; and a record's indexes are bounded by `MAX_INGEST_INDEX_BYTES` (64 MiB decoded in all),
  which bounds the submit's CPU. Sizes always come from the signed record and the stored object,
  never from the request body.
- **Possession, checked in batches.** Every object a pack record or one of its indexes names must
  be stored with its recorded length under the pack's prefix (`gated/` exactly when the record
  carries an `entitlement`), and the product must already hold a ref to it (`pack-object`): earned
  in a stage round, in this submit's ticket, or for an earlier release. The check is a
  `json_each` join of at most 10,000 `[key, bytes]` pairs per query against `blob_objects` and
  this product's `blob_refs`, so another product's copy of the bytes never counts.
- **Chunk indexes at ingest (P4-22, plans/P4-10.md §6).** Ingest parses one CI-supplied binary
  `pkey-chunks/1` index at a time: its declared `size` and `bytes` are checked against
  `MAX_PUBLISHED_INDEX_BYTES` (8 MiB) and its `format` against `pkey-chunks/1` before anything is
  read, the stored object is read bounded by its recorded length, decoded by a fresh WASM
  instance and parsed by client-core's `parseChunkIndex` bound to the variant's payload, which
  compares the index length in exact arithmetic and reads every u64 as two saturated u32s, so no
  length or offset in the index is trusted before it is bounded. The parsed records and bundle
  entries (48 bytes each on the wire, at most 174,761 together: 174,760 records with one
  bundle) are held for that index only and dropped before the next;
  chunk indexes count toward `MAX_INGEST_INDEX_BYTES`. The bundles the index's table names get the
  stricter possession check: the index and every bundle must be stored with the recorded length
  AND held by a `pack-upload` ref of THIS pack (`ref_id` = the pack id) under the pack's prefix.
  A ref held by another pack or by a release does not count, so a record may name an earlier
  release's bundle only when the same pack uploaded it, and a pack cannot borrow (and so serve,
  and pay for) bytes another of the product's packs, or another gating class, uploaded. A pack's
  upload ticket and stage round use the same rule for `present` (the ticket names its pack in
  `deliverable`): an object only another pack holds reads absent, is uploaded again and promoted
  through the already-stored path, so a renamed pack or two packs sharing bytes still publish;
  the answer reads only this product's refs, so it reveals nothing of another product. A gated
  and a free chain never share an object: the key is derived from the record's own gate. Bundles
  get no artifact rows; the collector keeps a bundle while any live release's chunk index names
  it (`packChunks`), and a live variant whose index cannot be read keeps every `pack-upload` ref
  that tick. The CLI publishes no `chunks` unless discovery advertises `release.chunks`, so no
  record carrying one lands on a Worker that does not check it.
- **Pins are signed, mirrored, never edited.** An app release's pins come from its signed
  `content` (the descriptor's, which `descriptor-mismatch` holds to the record); ingest refuses a
  pin to an unknown, mismatched or yanked pack release, an unpinned required or embedded pack, a
  gated pack pinned as required, and an embedded pack not pinned. `release_pins` mirrors them
  for queries only. A declared pack whose stored declaration does not read back fails the app
  release closed (`pack-unreadable`) rather than skipping its `required` rule.
- **A GitHub tag cannot overwrite a pack release.** A pack release's id is `<packId>@<version>`
  and git allows `@` in a tag, so whoever can push a tag to the linked repo can name a GitHub
  release after a pack release. The truth-store sync skips such a release and reports it
  (`packTagConflicts`, `release_tag_is_pack_release`), and its metadata, file, build and health rows
  are guarded at write time to an `app` row, so a stale plan cannot overwrite a pack's metadata (its
  `$.record` marker, which pins verify against), builds or objects either. One residual: the
  `release_channels` row a manual-channel regex writes is not guarded, so in the narrow race where
  a pack is ingested between the sync's read and its batch, the admin channel view may point at the
  pack release until the next sync rewrites it; nothing serves from that row. The reverse order is a
  denial of publish, not a takeover: a repo writer who pushes the tag first makes that pack
  version's publish refuse with `release_exists` (409).

**Pack-set resolution (P4-12).** Release now resolves `compatible` and `standalone` packs into
stored sets (`release_sets`) on every publish, pointer move, floor change, yank and resync. The
Worker still signs nothing; what changes:

- **What resolution reads, and who controls it.** A pack release's `contentApi` range,
  dependencies (`requires.packs`) and `conflicts` are read from its CI-signed record (the
  variants' reserved members, mirrored into `release_builds` at ingest), never from the request,
  so a push cannot re-range a release already published. Holds are the signed `content.holds` of
  the app record (`descriptor-mismatch` holds the descriptor to it), mirrored into
  `release_holds` and never edited. Floors per contentApi line (`release_pack_floors`) are
  operator-owned (the admin PUT, `source = 'admin'`); no resync and no CI route writes them. But a
  pack's **binding, declared variants, channels and `required`** come from the pushed manifest
  (`release_deliverables.def_json`, rewritten on every resync), as does the app's
  `packChannels`: a repo writer can, by pushing, move a pack between pinned and resolved, change
  which variants a set is resolved for, which channels a pack's releases may use and whether an
  app publish insists on it. None of that can put an unsigned release in a set: every member is a
  CI-signed pack record, so P4-13's feed carries only signed records and the two-signer property
  holds.
- **A floor or a yank is never refused because of resolution.** A floor that leaves a line empty
  is the operator's deliberate block (`unsatisfied: content-floor`); and a resolution that FAILS
  (its bound, or an error) never refuses the yank, unyank, floor change, pointer move or resync
  that triggered it. It fails closed instead: the product's stored sets are cleared (so no stale
  set, which may still hold the release just yanked, survives), an audit row
  (`release.pack_sets.failed`) is written, and the route answers `packSets: {ok: false, reason}`.
  A publish whose resolution fails is refused (`pack-sets-bound`).
- **Concurrent triggers cannot store an older resolution.** Each write claims the product's
  `release_set_state` generation it read before resolving, in the same batch as its rows; a
  writer that finds it moved writes nothing and re-resolves once.
- **Bounded computation and memory per request.** Resolution is pure computation over D1 rows
  inside the triggering request. Variants are projected per group of packs (packs with the same
  axes, merged across dependencies and conflicts), so rows grow as the sum over groups, not the
  product over every pack's axes; at most `MAX_SELECTORS` (4,096) rows per product, and ONE work
  budget, `MAX_RESOLUTION_WORK` (1,000,000 work units), for the whole resolution (not per
  problem): grouping, stage candidates, building each candidate's constraints, every dependency
  probe and range check of the pruning pass, the component split and every solver try are all
  charged. Measured on Node 22, the adversarial cases (64 packs × 200 releases with 63
  dependencies each, exhaustive searches over dependency chains, 64-entry conflict lists, three
  coupled 16-value axes, 500 live app releases × 4,000 rows) spend the budget, or finish, in
  15–60 ms with under 25 MB of heap. A CI publish runs one resolution (its check's, reused to
  store); the GitHub sync path can run two for a descriptor it ingests (the descriptor's check,
  then the sync's own re-resolution). A policy change clears the stored sets in its own batch, so
  even a CPU kill before the re-resolution leaves no stale set. The inputs
  are bounded already: at most 64 declared packs, 32 variant combinations each, and conflicts and
  dependencies lists of at most 64. A repo writer who can publish can make resolution slow only up
  to those bounds, and only for their own product.
- **Release never reads Distribution.** Which app releases are live is the channel floor's
  answer, not store availability, so the chain release ← distribution ← update stays one-way.

**Pack publish lint (P4-03).** A v1 pack is data-only (S-07 row 13: App Review 2.5.2, Play's
interpreted-code rule and Microsoft Store 10.2.2 forbid downloaded code on store builds), and
`pkey release publish` is the first place that is enforced: besides script files, native
libraries and GDExtensions by extension, it refuses every resource that carries code inside it —
a text resource (`.tscn`, `.tres`, `.escn`) whose section headers name `GDScript` or
`CSharpScript` or that sets `script/source`, and a binary resource (`.scn`, `.res`, anything under
`.godot/exported/`) containing `GDScript`, `CSharpScript` or `script/source` as a Godot
length-prefixed string, or that is compressed (`RSCC`) or otherwise not inspectable. (P4-08's
audit replaced both scans with the fail-closed content rules below, and P4-27 replaced the `RSCC`
refusal with bounded decompression.) The CLI lint is a
publisher-side guard, not a trust boundary: a repo writer with the release key can sign
any record, so P4-08's device-side directory check must apply the same rule (the same fixtures,
`packages/cli/test/packFixtures.ts`) before a pack is mounted.

**Pack bytes on the device (P4-08).** The Godot SDK is where a `godot.pck` payload becomes
mounted resources, so it is the trust boundary the P4-03 lint is not. A mounted pack cannot be
unmounted and, with `replace_files=true` (needed for `uid://` references), its entries replace
the app's own files of the same path, so the device decides by itself, before anything is
committed or mounted:

- **The data-only invariant.** No pack a device mounts may carry code or change what code runs:
  no script file (`.gd`, `.gdc`, `.cs`, a `.remap` naming one), no native library or
  `.gdextension`, no resource with an embedded script, no `project.binary` and no
  `.godot/global_script_class_cache.cfg`. A delivered pack is downloaded code on a store build
  otherwise (S-07 row 13), and the review found that a pack the CLI admitted could run GDScript
  on both 4.7.2 and 4.4.1; both bypasses below are now refused on the device and in the lint.
- **The directory check runs before commit, and so before mount.** The handler reads the PCK
  directory and checks every entry against the record's `handler.prefixes` and the admission list
  (`PKeyPck.directory_check`, the same rules and the same fixtures as `packLint.ts`) over the
  hash-verified output in staging. A refusal abandons the install (`pck-directory-refused`) and
  nothing reaches the store, the install state or the mount list; a `files.tree` output's files
  get the same content scan (`PKeyPck.tree_check`). Later boots mount only an install whose
  payload digest still matches the one checked, so the check is not repeated per boot.
- **Paths are refused unless already normal.** Godot simplifies a pack path when it mounts it,
  so `res://packs/a/../../x` lands at `res://x` and `res://packs/a/evil.gd/.` at
  `res://packs/a/evil.gd`, outside the prefix (or under an extension) the check matched. The
  reader (`PKeyPck.read_directory`, the CLI's `readPck`) refuses any path with a `..`, `.` or
  empty segment, a trailing `/`, or one that `simplify_path` would change, and a path the
  directory names twice, before a rule is evaluated. Every `.remap` and `.import` target must
  itself be such a path, under `res://`, and an entry of this pack: a target in the base game's
  `.godot/imported/` or `.godot/exported/` is refused, so a pack loads only its own files.
- **The extension never exempts a resource from the scan.** Godot picks a loader by extension:
  in 4.x its runtime text loader takes `.tres` and `.tscn`, and its binary loader takes `.res`,
  `.scn` and every resource type's own extension (`.material`, `.mesh`, `.anim`, …), then
  requires the `RSRC` magic. So the binary scan runs on every entry whose bytes start `RSRC`,
  whatever it is called. The text scan runs on the text-resource extensions (`.tres`, `.tscn`,
  and `.escn`, which is an import format rather than a runtime text-loader extension in 4.x and is
  scanned because stricter is free) and, as a defensive extra, on any entry with a sniffed
  `[gd_scene` / `[gd_resource` head. A compressed resource (`RSCC`) is decompressed, bounded, and
  its body scanned, under any name (next point).
- **Compressed resources are decompressed under fixed bounds (P4-27).** Godot's scene importer
  writes every imported model's `.scn` as `RSCC` (FileAccessCompressed: zstd blocks of 4096), so
  refusing it refused every pack with a model. Both validators now decompress it, which means
  running a decoder over attacker-chosen bytes, so the header is untrusted and bounded before any
  allocation or decode: compression mode 2 (zstd) only; block size 4 KiB–1 MiB; the declared
  total at most 64 MiB per entry (`RSCC_MAX_TOTAL`); the declared totals of one pack's `RSCC`
  entries at most 512 MiB together (`RSCC_PACK_BUDGET`, counted in directory order from each
  header before that entry's blocks are read, so the entry that crosses it is refused without
  being decompressed); the block table and every block inside the entry; the closing magic
  exactly at its end. Both are one constant on both sides. The cap is measured, not guessed:
  4.7.2's importer turns a script-written skinned character (90,601 vertices, 60 joints, 20
  animations of 10 s at 30 fps) into an 18.2 MB body and a 980,000-triangle mesh into 58.7 MB;
  64 MiB is about 4× the character and still admits the mesh. The per-pack budget matters
  because single-segment RLE blocks regenerate 128 KiB from 4 bytes: a 12 kB entry can declare a
  whole cap, so without it a 10 MB pack could demand hundreds of GiB of decoding. Every block
  must be exactly one single-segment zstd frame (no skippable frame, no dictionary id, no second
  frame: libzstd's one-shot decode, the engine's, would take those, the CLI's single-frame wasm
  decoder would not; and no window descriptor, which every Godot frame lacks and on which the
  32-bit wasm decoder and a 64-bit device disagree at 2^31) whose header declares the block's
  size and whose zstd blocks each declare at most 128 KiB and at most that size (libzstd
  versions differ on enforcing the limit for raw and RLE blocks), checked by a frame walk on
  both sides before anything is allocated; each decode then gets that size as its output capacity
  (`PackedByteArray.decompress(size, COMPRESSION_ZSTD)` on the device, `@polaris-key/zstd-wasm`
  in the CLI) and must return exactly it, so a block that lies about its size (a bomb) stops at
  its declared size and is refused, and the work is bounded by the cap whatever the ratio. The
  last block is the remainder (an empty frame when the total is a multiple of the block size,
  which is only walked, never decoded). The body must open like a binary resource (the saver
  omits the `RSRC` magic when compressing: the big-endian and real64 flags must be 0 or 1) and
  then gets the same marker rule as an `RSRC` entry. Any other shape is refused, with identical
  lines from both validators (`rscc-*` fixtures in `verdicts.json`, real 4.7.2 and 4.4.1 imports
  admitted, run on both engines). The device's marker scan is linear whatever the bytes are: it
  hex-encodes 1 MiB windows (overlapping by the longest marker) and searches them natively,
  re-checking a window exactly only when a hit falls between bytes, instead of comparing at
  every occurrence of a marker's first byte (`rscc-g-run`, 64 MiB of `G`, is checked in under a
  second, with a time bound in the suite). Residual: a hostile pack can make a device decompress
  and scan up to 512 MiB during the check (off the main thread, at most 64 MiB held at once),
  which costs time and memory but cannot write past a declared size or reach the mount.
- **The scans are fail-closed content rules, not parsers (P4-08 validator audit).** As
  recalled from the engine source rather than measured here, Godot's VariantParser reads newlines
  as whitespace and fields as Variants (StringName `&"…"`, `\u` escapes, an inline
  `Object(GDScript, …)`) and keeps the character after an unknown escape (`"GD\Script"` reads as
  `GDScript`), and its binary string reader stops at the first NUL. No rule depends on how a
  header is spelled, an escape is written or a length is stored. A text resource is refused when
  it holds a NUL byte, is not valid UTF-8 (one explicit validator on both sides), or contains
  anywhere a script marker (`GDScript`, `CSharpScript`, `ScriptExtension`, `script/source`,
  `source_code`, and on the device every class the running engine says inherits `Script`). The
  marker search runs twice: on the bytes as they are, and on a copy with every backslash removed.
  Any `\u` / `\U` escape is also refused. A binary resource is refused when the raw bytes of any
  marker occur anywhere in it, without the length prefix. A `.remap` or `.import` is refused for a
  NUL, any other control byte but TAB, LF and CR, any backslash, invalid UTF-8 or a byte-order
  mark. It is also refused for any line with a `path` key anywhere in it (quoted or not, after
  `[remap]`, another key or a metadata `}`) unless the whole line is exactly
  `path[.<x>] = "<plain literal>"`: the engine's tag parser does not need a key to start a line.
  A key that ends in `/path`, `.path` or `-path` (`import_script/path` in every scene import's
  `[params]`) is a different key to the engine and is excluded from that rule.
  Lines are split by hand after CR → LF and whitespace is an explicit class, because JS and PCRE2
  disagree on `\s`, `\v` and line breaks. A uid-cache path with a NUL is refused. Every rule has
  fixtures (`audit-*` in `verdicts.json`) that both validators must give the same verdict on, run
  on 4.7.2 and 4.4.1; they pin the validators' verdicts, not the engine behaviour recalled above.
- **What counts as a script comes from the engine on the device.** Besides `.gd`, `.gdc` and
  `.cs`, the device refuses every extension a loader recognises for `Script`
  (`ResourceLoader.get_recognized_extensions_for_type`, minus the generic `tres`/`res`/`tscn`/`scn`
  containers whose content is scanned) and uses every `Script` subclass as a marker, so a
  GDExtension script language installed in the app is covered on the device. The CLI cannot ask
  an engine: `lintPck` takes `scriptExtensions` and `scriptTypes` for such a language, exposed
  as `pkey release publish --script-extensions/--script-types` and the Action's
  `script-extensions`/`script-types` inputs (P4-28), so CI refuses what the device refuses.
- **A pack attaches only the app scripts and UIDs the app lists (P4-28).** A data pack's
  resource can reference a script the app already ships and set its exported properties: a text
  `[ext_resource type="Script" path="res://…"]`, a binary resource's external-table entry, or a
  `uid://`. Measured on 4.7.2 (editor and release template) and 4.4.1: a pack resource saved by
  the engine with an app script attached loads, once mounted, with that script attached and the
  pack's property value set (`_attach_probes` in the Godot packs suite). The app now lists what
  packs may attach, in `PKeyOptions.pack_attachable` on the device and
  `deliverables.app.content.attachable` in `.pkey/release` for the publish lint: `res://` script
  paths, `res://…/` directories, and canonical `uid://` UIDs. Both validators read every
  reference of every admitted resource (text tags; the binary header, string table, external
  and internal tables and every property, walked as the 4.4.1/4.7.2 loader reads them) and
  refuse, with identical lines (`refs-*` and `audit-binary-extref` in `verdicts.json`): a
  reference to an app script (a script extension, or the type `Script` or a script class)
  outside the pack that is not listed, exactly or under a listed directory; a UID that is
  neither in the pack's own uid cache (which may name only the pack's files) nor listed, because
  the engine prefers a resolvable UID over the path; and, failing closed, anything they cannot
  read the way the engine would: a line containing `ext_resource` that is not one strict
  `[ext_resource key="plain literal" …]` tag (no multi-line tag, comment, StringName, escape or
  repeated key), the inline `Resource("…")` constructor (which loads any path or UID directly),
  a path that is not an already-normal `res://` path (relative paths resolve against the
  resource's own directory) or names a `.remap`/`.import` file, a non-canonical UID, a
  big-endian or format-7+ binary resource, a sub-resource path that is not `local://` (the
  loader reuses any cached resource of that path, an app script included), the pre-4.0 inline
  external reference, an unknown value type, or anything past the end. A script behind a remap
  is judged where it is: the exported file the pack's `.remap` names is itself a pack entry and
  gets the same check. **The default is strict: with no list, a pack attaches no app script and
  reaches no UID outside its own cache.** The alternative, admitting everything unless an app
  opts in, would leave the residual open in every app that never hears of the setting, and the
  program has no shipped packs that rely on attaching app scripts (Diceroll's planned packs are
  assets). An app that does attach scripts lists them once in both places (Godot 4.4+ writes the
  path and the UID of a script reference, so both), and the lint names every refused reference
  so the list is easy to complete. Non-script app resources referenced by path (a shared
  material, an app scene to instance) stay admitted without listing.
- **The device judges what a reference really loads (P4-28 audit).** A reference's `type` is a
  hint the pack writes; the engine picks a loader by extension, so an app GDScript saved as
  `.tres` and referenced as `Resource` attaches a script. For an out-of-pack reference without a
  script extension the device reads the resource's real type the way the loaders do (through a
  `.remap` on an export; an imported file's `.import` type; a binary header's type; a text
  resource's head) and treats a `Script` subclass, or a resource that exists but whose type it
  cannot read, as a script that must be listed. A compressed app scene is read only to its
  first block (the type sits at the start of the body; the per-pack cap does not apply to app
  files, so a model over 64 MiB still types as a PackedScene), and each path is read once per
  check, so a pack naming one large app scene in thousands of tags costs one header read
  (P4-28 audit GAP D; 2,001 references to a 30 MB and an over-cap scene check in about 30 ms). A UID outside the pack's cache that the app
  registers (`ResourceUID`) is judged by the path it names: an app texture or scene passes, an
  app script needs listing; one the app does not register needs listing. These lookups are
  device-only. The CLI cannot see the app's files or UIDs, so it judges the hint and refuses every
  unlisted UID: **CI is stricter than the device for app UIDs** (Godot 4.4+ writes `uid="…"` on
  every reference, so a pack scene referencing an app texture by UID is admitted on the device
  but needs the UID in `content.attachable` to publish), and the device is stricter for a
  script hidden under a resource extension. The shared fixtures resolve nothing on the device,
  so their verdicts are identical.
- **A pack resource never sets `resource_path` (P4-28 audit GAP A).** `Resource.set_path`
  registers a resource in the resource cache under the path it is given when nothing is cached
  there, and the loader re-paths only a file's main resource. Measured on 4.7.2 and 4.4.1: a
  mounted pack's sub-resource that sets `resource_path` to an app path not yet loaded takes that
  path, and the app's next `load()` of it returns the pack's object (`_cache_probe`). Both
  validators refuse a text resource naming `resource_path` anywhere (as written or behind
  escapes) and a binary resource whose property uses that name (a string-table entry or an
  inline name), with one line (`refs-resource-path-*`). The engine never stores the property.
- **The binary walk is linear (P4-28 audit GAP B).** Internal-resource offsets must follow the
  tables in strictly ascending order and each walk must end by the next offset, as the saver
  writes them (the real 4.7.2 and 4.4.1 imports do), so no byte is walked twice; the walked
  total is also capped at the stream length, and a property name that is not valid UTF-8 (which
  the loader would rewrite) is refused (`refs-name-utf8`). Overlapping offsets, which would let a few million
  table entries re-walk one large blob on the device's worker, are refused
  (`refs-overlap-offsets`).
- **A pack's uid cache may name only the pack's own files.** A 4.4/4.5 exporter writes the whole
  project's `uid_cache.bin` into a pack, excluded files included; mounted with
  `replace_files=true`, a foreign entry re-points one of the app's own UIDs at the pack's file
  (measured on 4.4.1). An entry naming a path outside the pack is refused on the device and in
  the lint, so such packs must be exported from 4.6+ or have the cache stripped.
- **A delta trailer briefly mutates an installed store pack.** A Godot delta decodes through
  the engine by appending a trailer directory to the store pack that holds the patch base, mounting
  it under a private `res://__pkey/<session>/` namespace, and truncating the file back after the
  decode. A journal written before the append (`bake.json` in the plan's staging directory, a
  list of `{file, size}`) lets the next boot truncate a pack a crash left long, and names only a
  file of the form `<store>/<64 hex>.pck`, so a forged journal cannot truncate anything else.
  The decoded bytes are hash-checked against the signed variant before the directory check runs.
  If the journal cannot be written the decode uses a copy host instead of touching the store.
- **A pack that fails its boots is not offered again.** When the shared boot guard rolls a pack
  set back, each rolled-back pack's record SHA is recorded in the install state (`held`, with a
  count). The SDK does not reinstall it until the content stamp pins a different record, and
  treats the restored install as active (`pack-rolled-back` on an explicit `ensure`). A broken
  pack therefore costs two failed boots once, not on every launch.

Residuals not closed by P4-08 (P4-28 closed two: attaching app scripts, and another script language in CI):

- **Pack data still drives the app's own code.** Closed by P4-28 for scripts a pack attaches
  itself, but an app resource a pack references by path (an app scene it instances, a resource
  that is or embeds a script saved under a resource extension, a node's
  `instance_placeholder` path the app later loads) runs whatever the app composed into it, and
  signal connections in a pack scene call methods on the nodes it builds. Built-in engine nodes
  are tools too, with no script at all: an `HTTPRequest` started through a `[connection]`'s
  `binds` can fetch a URL the pack chose, and an `AnimationPlayer` method-call track calls any
  method of the nodes it animates. That is engine and app behaviour, not downloaded code; the
  app must still treat pack data as untrusted input, and
  integrity rests on the release-key signature over the record. A `files.tree` pack's resources
  are not reference-checked (a tree is never mounted into `res://`); an app that loads a
  resource from a tree file takes the same care as with any `user://` file.
- **App UIDs are judged when the check runs.** The device resolves an out-of-pack UID through
  the app's `ResourceUID` when it checks a pack (before commit, and again before each mount).
  An app update that re-points a UID at a script is caught at the next mount's check; a UID the
  app registers at run time through its own code is the app's choice.
- **Data replacement under a pack-chosen name.** An in-pack `.godot/imported/…` or
  `.godot/exported/…` file whose name equals the base game's replaces it under
  `replace_files=true`. That changes data, not code, and the record is release-key signed.
- **Shaders are admitted.** `.gdshader` and shader resources are GPU programs, not scripts the
  store rules cover, and they pass the check.
- **Embedded packs are trusted as the build.** A pack embedded in `res://pkey_packs/` is bound
  by its marker and signed record but not directory-checked: it is part of the build, which is
  the running code.
- **The store sits in the attacker's trust domain.** An attacker who can write `user://` can
  replace a store pack and the digest the install state holds for it. That is the same boundary
  as the SDK cache (below), and it is no worse than replacing the game itself.

### Pack-type handlers (P4-16)

P4-16 adds the v3 pack types (CONTENT §4.2): `l10n.table`, `data.json`, `ml.model`, `audio.bank`,
`godot.zip` and game-registered `custom.<name>`. Transport, signing, patching, revocation and GC
are unchanged; each type adds a handler `check` over the already verified payload (hashes, path
rules and, for a delegated release, the data-only rule) and its activation. A refusal is
`pack-type-check-failed`: the install is abandoned and staging discarded, and nothing activates.

- **Handlers parse and never evaluate.** Tables (PO, CSV, JSON) and documents are read by plain
  parsers in every SDK. JSON goes through the strict parser (V4 §1.2: no duplicate member, BOM,
  comment or trailing comma, an object at the top). No handler calls `eval`, a reviver that
  builds objects, `str_to_var`, `ConfigFile`, `JSON.to_native(..., true)`, `ResourceLoader` or
  `Expression`. Godot builds `Translation` objects with `add_message`, never loads a
  `.translation` resource, and never hands a pack's `Plural-Forms` formula to `Expression`.
  A file's format is judged by its bytes, never its name.
- **Paths.** Handlers look files up by exact index path. Only `model.json`'s `file` and
  `bank.json`'s `banks` name files, and each must equal an index path byte for byte (no
  normalisation), so nothing a payload says can reach outside its own verified tree.
- **What reaches host code.** An `ml.model` file reaches the host's `loadTest` and runtime, and
  `audio.bank` files reach the host's middleware reload. They are release-signed only (neither
  type is delegable), and the model or bank parser is the host's: a malicious model or bank is
  as dangerous as the host's runtime lets it be. The runtime, quantisation and RAM/VRAM checks
  bound resource use, not parser safety.
- **`godot.zip` is mounted, so its reader is admission control.** Godot tries its PCK reader on
  every pack before its ZIP reader, whatever the extension. That reader accepts a `GDPC` magic
  at the start, at the end, and at a self-contained export's embedded-PCK offset inside the file
  it opens. Measured on 4.7.2: a `.zip` with a PCK appended mounted that PCK's hidden files.
  minizip also follows a ZIP64 locator found before the end record. The CLI lint and the Godot
  check therefore both refuse:
  - a zip holding `GDPC` anywhere;
  - anything before the first local header, an archive or entry comment, ZIP64 (or its
    locator), encryption, data descriptors, compressed entries, local headers disagreeing with
    central ones, overlapping data, and a non-normal or repeated path.

  The `godot.pck` admission list and code scans then run over the entries. A zip install is
  stored as `<sha256>.zip` (named by its leading `PK`), and `mount()` refuses a `godot.zip`
  install at any other path. A content key can never sign a `godot.zip` (P4-19).

- **`custom.<name>` relaxes nothing.** The engine's path rules and, in Godot, the v1 tree rule
  (`PKeyPck.tree_check`, in the base handler's `check_tree`) apply before a game's own check.
  What the game's handler then does with the bytes is the game's: a `custom.*` type is never
  delegable because such a handler may execute what it loads.

### The client token store on Apple platforms (P5-05)

The device id and the `pkeyt_` device token are the client's two secrets at rest (§2). On iOS
the Godot SDK keeps both in the Keychain through the Apple platform plugin (`PKeyKeychainStore`
over `PolarisKeyPlatform`'s `SecureStore`); the verified cache stays in the file store, because
it is re-verified at every load and holds nothing secret.

- **Class.** Generic-password items under service `pkey:<product>`, in the data-protection
  keychain, never synchronizable, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable
  after the first unlock (a background launch can refresh), and never restored onto another
  device from a backup, so a copied backup carries no usable token or device identity.
- **No access group.** No `kSecAttrAccessGroup` and no `keychain-access-groups` entitlement: the
  items sit in the app's private default group. The App Group the Background Assets patch adds
  is used for asset packs only, never as a Keychain access group.
- **The Background Assets extension has no access.** It is a separate process with its own
  default group; it never reads the token or the device id and carries no credential (notes/E9
  §7.1). A compromised or malicious extension therefore cannot act as the device.
- **Migration from the file store.** A token or device id found only in the 0600 files (an
  install from before the plugin) is moved into the Keychain on first read, and the token file
  is deleted. A failed delete is surfaced (`failed`, `store_error`) and retried on every later
  read, so no plaintext copy is left behind silently. A failed Keychain write is surfaced too
  (`degraded: keyring-error`) and the token is never written to a file instead; only the device
  id falls back to its file, so a Keychain fault does not mint a new device per launch.
- **Residual.** On the simulator Keychain items survive app deletion; on a device that is
  undocumented (S-09 hand-off). The Swift SDK's own `KeychainStore` still writes the token
  `AfterFirstUnlock` (backup-restorable) and the device id to a 0600 file; that difference is
  open with the Swift SDK's owner.

### Client updater plugins on the desktop (P5-07)

The Godot SDK hands a binary update to the platform's own updater through optional plugins
(`sdks/godot/native/`; facades in `addons/polaris_key/native/`). The plugins install new code,
so what verifies that code matters more than anything else on this path. Polaris Key never
verifies an update itself on these paths, and no plugin holds a private key: the Sparkle and
WinSparkle EdDSA private keys are CI's (notes/E1 §C1), and the Worker never sees them.

- **Trust anchors.**
  - Sparkle verifies every download against `SUPublicEDKey` in the code-signed bundle's
    `Info.plist`. The bridge refuses to start without that key; an attacker who replaces an
    update cannot replace the key with it.
  - WinSparkle verifies the EdDSA signature against `PKeyOptions.update_eddsa_public_key`, which
    ships inside the game's pack. Whoever can replace the pack can already replace the code, so
    the key is no weaker than the binary that carries it. Without a key WinSparkle refuses to
    start.
  - Velopack has **no signature**: it checks the SHA-1/SHA-256 that the feed lists, over HTTPS,
    and Authenticode on the installer and Update.exe is the owner's (notes/S-11 §7). Its
    integrity is therefore the feed's: TLS to the Worker, and the Worker's selection over
    verified release records. The facades refuse a plain-http feed off loopback.
- **Disable Library Validation (macOS).** A GDExtension in a hardened-runtime app needs
  `com.apple.security.cs.disable-library-validation`, which lets the app load a library signed
  by anyone.
  - The export plugin adds it only when `polaris_key/sparkle/enabled` is on, and never on a Mac
    App Store preset. The App Store export logs an error while the bridge is installed.
  - `sign_and_notarize.sh` fails when the entitlements also grant
    `com.apple.security.cs.allow-dyld-environment-variables`. The pair would let
    `DYLD_INSERT_LIBRARIES` inject code into a notarised build.
  - Residual: with DLV on, a library planted in the bundle loads. The bundle's seal, and
    notarisation, are what stop that.
- **Never unsigned.** A macOS export with `codesign/codesign` Disabled keeps the template's own
  signature on a modified bundle, and Sparkle then rejects every update. The plugin turns
  Disabled into the built-in ad-hoc signature. Ad hoc is a floor for local runs only: Sparkle's
  code-signing match and Gatekeeper need a Developer ID (§7 rows 1–4 of the S-11 checklist).
- **The bearer and redirects.** Foundation, under Sparkle, drops `Authorization` on a
  cross-origin redirect (measured, S-11 m6). ureq, under Velopack, drops it on every redirect,
  even a same-origin one (measured in P5-07). WinSparkle's HTTP stack across origins is
  unmeasured, so treat it the same way. So an `entitled` or `licensed` delivery whose package
  URL redirects to the bytes host refuses the second hop, and fails closed. Velopack is supported
  under public delivery only. A 401 or 403 download answers `unsupported` (`product`); it never
  retries with the bearer in the URL. The bearer is never written into a feed, a log or an
  enclosure URL.
- **The headless user driver** installs every update without asking. It exists for unattended
  tests and is refused unless the process environment sets `PKEY_SPARKLE_HEADLESS=1`. Both the
  facade and the native bridge check the flag, and nothing a game ships sets it. Anyone able to
  set a game's environment can already run code as the user.
- **Runtime DLL loading and the shim (Windows).**
  - `velopack_libc.dll` and `WinSparkle.dll` are loaded by absolute path from beside the
    executable. The load uses `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32`,
    so their own dependencies never come from the current directory or PATH, and a relative path
    is refused. A writable install folder is the residual: an attacker who can write there can
    replace the game's exe too.
  - The Rust launcher shim is the Velopack main exe. It answers the `--veloapp-*` hooks, then
    starts `<stem>_godot.exe` beside itself with the arguments it got, as OS strings. It reads no
    network input and, in a release build, no environment variable.
- **WinSparkle runs installers.** After the EdDSA check passes, WinSparkle runs the downloaded
  installer with the appcast's `sparkle:installerArguments`, which the Worker derives from the
  build's `format`. A product that publishes a malicious installer signed with its own EdDSA key
  is outside this model: that is the release key's compromise (AT-3).
- **Store builds.** A Microsoft Store export ships no updater but StoreContext: the export plugin
  removes the updater DLLs and the shim (folder or `.zip`). StoreContext only asks the Store to
  install what the Store already holds for the package.

### The Android platform plugin: Keystore and self-update (P5-06)

The Godot SDK reaches Android through `polaris-key-platform` (sdks/kotlin) and the
`PolarisKeyAndroid` plugin. Two of its parts hold or act on secrets and code.

- **Token store.** The device id and the `pkeyt_` token are wrapped by one AndroidKeyStore
  AES-256-GCM key per product (alias `pkey:<product>:device`; non-exportable, StrongBox where the
  device has it, else the TEE; no user authentication, so a boot can read it). Each value is a
  versioned blob `0x01 ‖ iv ‖ ciphertext ‖ tag` in `noBackupFilesDir`, never backed up, with the
  AAD `pkey/v1/<product>/<account>`, so a blob moved to another slot or product fails its tag.
  Product and account names are slugs and cannot leave the directory. A lost or permanently
  invalidated key drops its blobs and is surfaced (`store_error`); the device activates again.
  The migration from the file store and the no-silent-downgrade rule are the Apple store's
  (above): a failed Keystore write is `degraded: keyring-error` and the token is never written to a
  file instead. On the emulator the key is software-backed (`securityLevel` 0); the hardware level
  on a device is on the owner's checklist.
- **The flavour is a policy boundary.** A `play` build carries no PackageInstaller session code, no
  install-status receiver and no install permission; a `direct` build carries no Play Core. This is
  checked on release outputs (`sdks/kotlin/tools/check_flavours.sh` in CI, and the headless Godot
  export check), not trusted to the source layout.
- **Self-update verification (direct builds).** Before any session is opened, the APK must sit in
  the app's private storage (canonical path, so a symlink out of it is refused), hash to the
  caller's SHA-256 (required), carry the app's own package name, carry exactly the installed
  signing-certificate set, and have a higher versionCode (and the expected one when given). The
  bytes are hashed again while they stream into the session and a change aborts it, so a writer
  racing the verification cannot swap the file. Android itself refuses a different signer as an
  update; the plugin's check makes that refusal explicit and earlier. Key rotation (a signing
  lineage) is refused by the equality rule, which is deliberate until a product needs rotation.
- **What decides the hash.** The direct adapter's Android path (`PKeyApkUpdate`, run only from the
  player's update action) takes the expected SHA-256 and size from the build's `payload` artifact
  in the VERIFIED signed release record, never from the feed or the download response; the bytes
  are checked against it before the plugin sees them, and the plugin hashes them twice more. The
  record has no Android versionCode, so none is expected: the plugin's "higher than installed",
  package and signer rules still apply. The download URL only says where to fetch.
- **Silent installs.** `USER_ACTION_NOT_REQUIRED` is honoured only when the user allowed installs
  from the game and no other installer owns its updates; an install owned by Play, F-Droid or
  Obtainium prompts and names the owner (notes/S-10 §3). Ownership is never requested.
- **The status receiver** is manifest-declared, not exported, and reached through an explicit,
  package-scoped PendingIntent. It journals the status (no secret) for the next launch.
- **Residual.** The install source is declared by the installer and forgeable through `adb`
  (notes/S-06 §7): it gates In-App Updates (a forged Play claim only reaches Play's own API, which
  then refuses) and never authorises anything on the server.

### Platform pack transports (P5-08)

Apple-hosted Background Assets, Play Asset Delivery and Steam depots move pack bytes that Polaris
Key never served. The store is a byte mover, not a trust anchor.

- **Platform-delivered bytes are untrusted input.** The Godot transports (`packs/transport_*.gd`)
  only locate the store's copy: the path is re-resolved on every call and never persisted, and
  nothing is ever written into the store's directory. The engine verifies the copy's marker
  (`pkey-marker/1`, the compact release record, against the pinned release keys only), then
  hashes the payload, or every file into the treeDigest, against that signed record before
  anything activates or mounts, exactly as for an embedded baseline. A store's own hashes, version
  numbers and "installed" answers are never trusted. A marker for another pack is refused
  (`cross-check`).
- **Which release a copy may be.** At boot a copy is accepted when it is the stamp's pinned
  release, or, on a transport whose packs float (`apple-ba`, `steam-depot`, CONTENT §6.6), a later
  `seq` of the same pack that is not revoked. A Play copy must be exactly the pin, because PAD packs
  ship with the bundle. When a decision names an exact release, only that release is accepted
  (`record-mismatch`). Revocation and `relearn` refusals apply as for embedded baselines, and a
  delegated release can never arrive this way (see "Release-key surfaces" above). A platform copy
  is never written to the pack state document, so a store-side swap is re-verified at every boot.
  A pack bound to a platform transport is never silently fetched from the CDN instead
  (`plan-transport-unsupported` when the plugin is missing). The one CDN request a platform copy
  can cause is P4-11's best-effort chunk-index backfill: a single GET per index per process of
  that copy's chunk index, hash-verified before use and dropped on any failure, so it can only
  make the copy a chunk seed for CDN packs. It never fetches the payload or a feed delta.
- **CI's App Store Connect key.** `pkey transport apple-ba upload` signs its ES256 tokens with
  CI's own key from the environment only (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` or
  `ASC_KEY_PATH`). It is never logged, never sent to the pre-signed part-upload URLs, and never the
  key the Worker's connector holds. A token lasts 20 minutes.
- **Resource pinning.** Asset-pack ids are lossy (`a.b` and `a-b` would collide) and App Store
  Connect never reuses an archived id, so every apple-ba pack of the product is mapped at once
  before any request. The first upload records the asset pack's resource id in
  `.pkey/asset-packs.json` (repository-reviewed). A later upload refuses an asset pack whose
  resource is not the recorded one, one that exists unrecorded (it is adopted only with an
  explicit `--expect-resource`), and a recorded one that has vanished. A version can therefore
  never land in another pack's asset pack, a write that would switch every installed app.
- **Linking connector objects to releases.** A Background Asset object is linked to a pack release
  only through the upload report's ids, and only when the asset pack's name maps back to that
  release's pack id (`assetPackBase`). Two releases claiming one version link neither. A report
  links only still-unlinked objects, and never unlinks one. Each asset pack keeps its own
  availability row (`build_id` = the asset-pack id), so one level's state cannot overwrite
  another's. The connector's ownership proof (P5-02) still decides which objects are this app's.
- **The asset-pack listing** (`GET …/distribution/asset-packs`) is a console (admin) read behind
  the console's own session and CSRF rules. It never archives, because archiving is irreversible.

### Device trust levels: App Attest and Play Integrity (P6-02)

A device is `basic` or `attested` (`devices.trust_level`). `attested` means the device passed Apple
App Attest or Google Play Integrity against a challenge the Worker issued to it
(`core/attestation.ts`); an operator's trust policy can require it for edge-mint, gated delivery
and the commerce claim (`core/deviceTrust.ts`). What it buys: under open registration a script can
mint any number of device tokens, but it cannot cheaply produce a Secure-Enclave-backed attestation
for the product's App ID or a Play verdict for its package on a device meeting device integrity.
What it does not buy: protection of the client itself (report §12), or anything on web, desktop or
sideloaded builds, which cannot attest and stay `basic` by design.

- **Fail closed on verification, fail open on policy.** Only a verdict that passed every check
  raises a device; a refused one is recorded (`attestation_json`) and changes nothing, so a bad
  attestation can neither raise nor lower a level. Policy defaults to `basic` everywhere, a corrupt
  policy reads as the default, and a policy requiring `attested` only audits
  (`device.trust.would_refuse`, deduplicated per device and operation per hour through a KV marker)
  until the operator sets `enforce: true`. An outage of Google's decode endpoint is `503`, never
  a rejection and never an attestation.
- **Who chooses what is verified.** The App Attest RP ID is `<TeamID>.<bundleId>`: the Team ID is
  operator-owned (the trust policy, written only by the platform-admin `trust-policy` resource, never
  by a manifest), the bundle ids come from the live `app-store`/`testflight` outlets' identities
  (manifest-owned). A repo writer can therefore name another bundle id, but an attestation for it
  still needs a genuine install of an app of the operator's own team. The Play package and the
  credential come from Distribution's own pin check (`resolvePlaySetup` through
  `Delivery.attestationTargets`): an unpinned or mispinned `google-service-account` credential is
  never used, and nothing is sent to Google. The root of trust for App Attest is the pinned Apple
  App Attestation Root CA in source (fingerprint pinned by a test); test roots enter only through a
  handler argument production dispatch never passes.
- **Binding.** The client feeds the platform API
  `requestHash = base64url(SHA-256("pkey-attest/1:<product>:<deviceId>:<challenge>"))`, recomputed by
  the Worker from the stored binding, so a challenge or a verdict obtained for one device or product
  cannot be redeemed for another. The challenge is consumed before verification (pass or fail) and
  expires after five minutes (checked in code, not only by the KV TTL).
- **A new token is a new install.** The device id is client-chosen. A keyless re-registration or a
  licence (re)bind of an existing id mints a token without the old one, so it resets the level to
  `basic` (`resetDeviceTrust`); otherwise anyone who learned an attested, licence-free device's id
  could re-register it and inherit `attested`. A token rotation, which presents the old token,
  keeps the level.
- **Custody.** `core/attestation.ts` is the one Core file on the token-helper allowlist
  (`test/outletCredentialReach.test.ts`, `TOKENS_IMPORT_ALLOW_FILES`): it calls `googleAccessToken`
  at the Play Integrity scope for the pinned credential, never `openOutletCredential`, and only after
  the device token and the per-device limit (`attest`, 4/hour, fail-closed) have passed, so an
  unauthenticated caller cannot make it open (and audit) a credential. Raw attestation objects and
  integrity tokens are never stored or logged; `attestation_json` keeps a verdict summary and the App
  Attest public key (for future assertions).
- **Parser surface.** The attestation object is attacker-supplied CBOR wrapping DER certificates.
  `core/cbor.ts` (definite lengths, bounded depth, item count and sizes) and the Worker's one X.509 verifier, P6-01's `core/x509.ts` (strict DER, ECDSA P-256/P-384 only, the root pinned by bytes, an unknown critical extension fails the chain beyond the App Attest nonce OID, validity checked at the request time, the leaf's keyUsage allowing digitalSignature when present) are strict subsets, run identically in workerd
  (`test-workerd/attest.test.ts`), and evaluate no code.
- **Residuals.** (1) KV has no compare-and-delete, so two simultaneous redemptions of one challenge
  can both read it; both still need a genuine attestation bound to the same device and challenge,
  so the effect is a duplicated verdict, not a forged one. (2) There is no revocation for Apple's
  attestation chain and no re-attestation schedule: a device attested once stays `attested` until a
  new token resets it, even if it is later rooted or jailbroken. Assertions on sensitive requests
  (`generateAssertion`, counter checks) are the planned answer and are out of this package. (3) Play
  Integrity's default quota (10,000 decodes a day per app) is shared by every device of the product;
  the per-device budget bounds one device, not a botnet of registered devices, whose exhaustion of
  the quota degrades attestation to `503` (devices stay `basic`; log-only policies are unaffected).
  (4) `basic` is not suspicious: enforcing `attested` for an operation removes it from every web,
  desktop and sideloaded install.
  (5) `attested` rides on a bearer token. The level is bound to the device row, which is reached
  with the `pkeyt_` token; anyone who lifts an attested device's token (from its store, a backup
  of a rooted device, or a debugger) presents an attested device from anywhere, until the token is
  rotated away or the device re-registered. Per-request App Attest assertions (and a Play request
  per sensitive call) are the fix; they are out of this package. (6) One handset can attest many
  device ids. The id is client-chosen and the `attest` budget (4/hour) is per device id, so a
  genuine handset can register and attest any number of ids in turn; attestation proves "a
  genuine install exists", not "one device per id". Bounding attestations per App Attest key or per
  Play device would need state this package does not keep.
- **Play testing responses.** A verdict Google marks `testingDetails.isTestingResponse` is a license
  tester's configured answer, not a check of the device, and is refused (`testing_response`)
  unless the operator sets `playIntegrity.allowTestingResponses: true` for internal testing; the
  flag is recorded in the verdict summary either way.

### The console's own IdP client (I-03)

Operators sign in to the console through their own Pocket ID client (`ADMIN_OIDC_*`); the
customer portal and every `provider: platform` product sign in through the platform client
(`PLATFORM_OIDC_*`). Before I-03 one client served all three, so a leaked client secret or a
group-assignment mistake on that client crossed from customer to operator (notes/S-16 §5.4 item
1).

- **The split is one-way by construction.** `platformOidcConfig` reads `PLATFORM_OIDC_*` only;
  it no longer falls back to the `ADMIN_OIDC_*` names. A customer sign-in therefore never goes
  through the operators' client, whatever the deploy sets.
- **The console falls back whole.** `adminOidcConfig` takes the admin trio when both its issuer
  and client id are set, and its secret only from `ADMIN_OIDC_CLIENT_SECRET`; otherwise the whole
  platform trio. No field is mixed across clients, so a half-set admin trio is ignored rather than
  pairing one client's id with the other's secret.
- **The fallback is visible.** While the console borrows the platform client, Platform → Settings
  shows `console_oidc_shared`, naming the admin variables still unset. Until the owner sets them
  the pre-I-03 exposure stands: the residual this package closes only once the secrets are set
  and `/manage/callback` is removed from the platform client (DEPLOYMENT §2).
- **Authorisation is unchanged.** Console access is still `PLATFORM_ADMIN_GROUP` (or a product
  admin group) in the ID token's `groups` (§5). A separate client narrows who can obtain a token
  for the console's audience; it does not change what the token grants. Where Pocket ID can
  restrict a client to user groups, allowing only the admin group on the console client adds a
  second check at the IdP.
- **Residual.** Both clients live in one Pocket ID directory: a compromise of Pocket ID itself, or
  of its admin account, still reaches both. Moving end users out of Pocket ID is I-09.

### Boundaries that are weaker than they look

- **The SDK cache is inside the attacker's trust domain, but the SDK treats it as trusted.** The
  JWS is verified once on fetch, then discarded; the decoded doc is reloaded with a bare
  `JSON.parse`. Worse, the cache can supply `trustedKeys` that _override pinned keys_.
- **A linked GitHub repo is a control-plane input, not just a data source.** `.pkey/` manifests
  rewrite tiers, OIDC issuer, artifact policy, and admin group on resync. Edge-mint recipes are
  the exception that is held back: a recipe from `.pkey/` is **inert until an operator approves
  it** in the exact form it will run (`edge_mint_approvals`), and any push that changes a
  security-relevant field makes it inert again. A repo writer can name a secret in a recipe but
  cannot make that secret signable, nor make an unapproved recipe mint. An approval is also bound
  to the three product settings that decide who can hold a device token the mint accepts, because
  a push can change each of them without touching the recipe. (a) Whether the mint is public: the
  open-registration acknowledgement is stored on the approval, so a push that makes the mint
  public — declaring `devices.registration: open`, turning License off so the derived policy is
  open, enabling anonymous `autoIssue` enrolment (which hands any caller a licence and a device
  token while registration still reads `requires-license`), or turning on an OIDC default tier
  with Identity on (every account the IdP signs in gets a licence) — widens an approval given
  without it. (b) Whether licences are checked: the mint requires a usable licence only while
  License is on, and with Identity on a push that turns License off keeps the mint closed
  (`requires-identity`) while letting a device whose licence was disabled or expired mint again;
  the approval records whether License was on, the approve call echoes it (`409` if it changed
  since the console loaded), and the console warns while License is off, so a re-approval after
  a License-off push cannot record "no licence checks" unseen. (c) The sign-in trust: on a closed product, signing
  in is the other route to a device token, and the manifest writes the OIDC provider, issuer,
  client id and `groupRoleMap` that decide who a sign-in licenses. The approval records them (and
  whether Identity was on); while Identity is on, any change widens it. A widened approval stops
  matching at once (every mint re-checks), **and it is deleted before anything can revert the
  widening**: every writer of an approval input sweeps the approvals the product has ALREADY
  widened before it writes — resync before its first write, and the console before every write of
  `services_json` or `auto_issue_json` (the services and License-policy PATCH and revert) — and
  audits each drop as `config.mint.invalidate`. The guarantee rests on that pre-write sweep. Resync
  also sweeps after its last write, in a `finally`, so a push that throws half-way (say, a
  duplicated recipe id) is caught at once; but a `finally` does not run when the Worker is killed
  after the push's un-batched writes (a CPU-heavy manual-channel regex, a cancelled webhook), nor
  does it see an approve that races it — the next push or console edit drops those before it
  writes. So a push that aims sign-in at an issuer the pusher controls, opens
  enrolment or turns License off, followed by a push that reverts it, leaves the recipe `pending`
  rather than approved; it mints again only when an operator re-approves it. Recipe-field changes
  are not swept (a changed recipe signs nothing meanwhile), so reverting one restores the
  approval. The upgrade backfill records the acknowledgement only for recipes that were already
  public mints at deploy, and the License and sign-in state as deployed. **Residuals:** (1) the
  licences and device tokens issued while an approval was widened survive a re-approval — the
  ingest drops the approval, not what was handed out meanwhile — so before re-approving, an
  operator reviews the audit log from the `config.mint.invalidate` row on and disables what they
  did not intend; (2) an approval trusts the identity provider itself — anyone that IdP signs in
  with a mapped group (including accounts its administrator adds later) is covered, which is the
  IdP weakness below, not something the approval can close; (3) a widening that no sweep has seen
  yet (an operator's own console edit, or a push killed before its post-write sweep) lasts until
  the next push or console edit drops the approval — the per-mint check refuses while it lasts,
  but anonymous enrolments or sign-ins it allows in the meantime are issued, and fall under (1).
- **The IdP is trusted for `groups`, and `groups` is the entire admin authorization decision.**

## 4. Adversaries

| ID  | Adversary                                                                                               | Capability                                                                           | Motivation                                                                                                                                                                    | Priority                                           |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| T1  | **Unauthenticated internet attacker**                                                                   | HTTP to `key.plrs.im`, can read public discovery/JWKS, can register nothing          | Control-plane takeover                                                                                                                                                        | **Highest**                                        |
| T2  | **Release-channel attacker**                                                                            | Holds the webhook secret, or write access to a linked repo, or GitHub App compromise | Ship code to end users                                                                                                                                                        | **Highest**                                        |
| T3  | **Malicious tenant / customer**                                                                         | Valid license, device token, portal account; possibly a product operator             | Cross-tenant data, tier escalation, extra seats                                                                                                                               | High                                               |
| T4  | **License pirate**                                                                                      | Full control of their own machine, can patch binaries and edit files                 | Use software without paying                                                                                                                                                   | Medium — bounded by §6                             |
| T5  | **Malicious or compromised IdP**: the platform IdP, or a product's own upstream IdP (tenant-controlled) | Controls claims presented to the Worker                                              | Privilege escalation via `groups`, identity confusion via `email`/`sub`; a product's IdP asserting subjects or emails that collide with another issuer's users (R5-01, R5-02) | High                                               |
| T6  | **Supply-chain attacker**                                                                               | Publishes a malicious dependency, or compromises a GitHub Action                     | Reach CI secrets and published artifacts                                                                                                                                      | High                                               |
| T7  | **Insider / compromised admin**                                                                         | Valid admin session                                                                  | Anything the admin API permits — which today is everything, on every tenant                                                                                                   | High                                               |
| T8  | **Network attacker**                                                                                    | On-path between client and `key.plrs.im`                                             | Downgrade, MITM                                                                                                                                                               | Low (TLS), but no SDK enforces HTTPS or pins certs |

## 5. Semi-trusted inputs — the ones that decide authorization

These deserve their own section because each is treated as trusted somewhere in the code while
originating outside the trust boundary.

| Input                           | Trusted for                                                                       | Actual origin        | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OIDC `groups`                   | **Platform admin authority**                                                      | The IdP              | Any IdP feature that lets a user influence group membership grants platform admin. A single claim string is the entire decision.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OIDC `sub`                      | License identity                                                                  | The IdP              | Admin, portal and the product flow all require it non-empty (R8-05a); an ID token without `sub` is refused with a generic 401. Portal identities are keyed by (issuer, `sub`), never by `sub` alone (I-01).                                                                                                                                                                                                                                                                                                                                            |
| OIDC `email`                    | Portal license linking, cross-product                                             | The IdP              | Portal and the product flow both require `email_verified: true`; the product flow stores no email otherwise (R8-05b). Admins may still set `licenses.email` to any unverified string, and portal auto-linking trusts only emails the portal itself verified.                                                                                                                                                                                                                                                                                           |
| `.pkey/` manifest               | Tiers, OIDC issuer, artifact policy, admin group, binary name                     | A linked GitHub repo | Applied on webhook-triggered resync. The repo effectively writes its own security policy — except edge-mint recipes, which are inert until an operator approves them column for column and sign only with an operator-marked `edge-mint` secret. Its tag regexes are length-capped only: R10-09.                                                                                                                                                                                                                                                       |
| `.pkey/distribution`            | Outlet store identities, listings, transports (`dist_outlets`, `dist_transports`) | A linked GitHub repo | Applied on resync by Distribution's ingest hook. Cannot express outlet capabilities (`capabilities_not_manifest_writable`); those are operator-owned, narrow-only and clamped on read (P2b-02). The `appleId` identity must equal the operator's pin on the `asc-api-key` (P5-02f), or the App Store Connect connector is inert; it can no longer pick the app the team key acts on ("Who picks the outlet's app"). Likewise the Play `packageName` must equal the pin on the `google-service-account` (P5-03), or the Google Play connector is inert. |
| `web.origins` (`.pkey/product`) | Which browser origins may read a product's device-facing responses (CORS)         | A linked GitHub repo | Exact origins only (no wildcard, `null`, path or non-loopback `http`), capped at 16, re-checked when the row is read. Never `Allow-Credentials`, so a listed page gains nothing a non-browser client lacks. Applied in dispatch after the handler, so the edge cache stays origin-free. The console, portal, docs, webhook and cookie-bearing identity routes never answer CORS (R1-09).                                                                                                                                                               |
| `X-PKey-Version` header         | Version and channel gating                                                        | The client           | A `0.0.0-dev*` version skips the version window and channel checks only when the licence is granted `dev` or the product sets `allowDevBuilds`, which no caller sets today (R3-01). Otherwise the version implies a channel per WIRE-CONTRACT-V3 §5.1 and is gated like any build.                                                                                                                                                                                                                                                                     |
| `X-PKey-Channel` header         | Channel gating                                                                    | The client           | Normalised per WIRE-CONTRACT-V3 §5.1. It can only add a channel to check, never replace the build-implied one; a malformed value is refused, and an unknown well-formed name must be granted by name (R3-01, R3-13).                                                                                                                                                                                                                                                                                                                                   |
| `X-PKey-Device` header          | Device identity                                                                   | The client           | Entirely client-asserted; not bound to the fingerprint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Fingerprint components          | Seat/hardware binding                                                             | The client           | Server recomputes the hwid (good), but checks it only at activation and never across devices.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Cached `trustedKeys`            | **Signature verification**                                                        | A user-writable file | Overrides pinned keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| CI OIDC claims (GitHub Actions) | **Publishing a product's releases** (a `pkeyci_` token)                           | GitHub, about a run  | Signature, issuer, product-bound audience, expiry and single-use `jti` first. Then all of: numeric `repository_id`/`repository_owner_id` (from GitHub at link, not the manifest), `job_workflow_ref` = this repo's declared workflow at the triggering ref, the declared `environment`, `ref_protected == "true"`, `github-hosted` runner, event in push/release/workflow_dispatch (P2-02).                                                                                                                                                            |
| CI distribution reports         | Availability and submission state per release and outlet; key observations        | A CI job (`pkeyci_`) | `distribution:report` (default grant). Validated whole before writing (declared live outlet, known release and build, vocabulary); audited. Can show a wrong state, never ship code, gate bytes or change a key: the operator-owned key inventory only records a CI-observed fingerprint, flagging a mismatch (P2b-03).                                                                                                                                                                                                                                |

**CI OIDC claims are only as strong as the repository's own settings.** The policy proves the
token came from the declared workflow, in the declared environment, on a ref a branch or tag
ruleset protects. It does not prove who could push to that ref or approve that environment: a
repository whose rulesets let any writer push a tag, or whose `release` environment has no
required reviewers, lets any writer publish. That is the trusted-publishing model's premise
(npm, PyPI) and is stated in the publishing docs; the platform's part is that the manifest cannot
relax any check, and that an operator can claim and tighten the policy.

Under the `entitled` release access mode, a legacy `staging` grant now opens the beta feed and its
artifacts, and a `beta` grant opens the `staging` alias of it: `staging` is the legacy spelling of
`beta` (WIRE-CONTRACT-V3 §5.1, P0-04 §2.4). Its version window is compared as semver, and
`compareSemver` calls an unparseable version equal to both bounds, so a pinned version that is not
semver (a four-part `1.2.3.4`, a tag like `2.0.0.1`) is refused with `version_blocked` whenever the
window is bounded, on `/release/dl`, `/release/builds` and `/release/files` alike (P2-05).
A route that serves one stored release (`/release/files`, and each release `/release/blobs`
checks) passes that release's STORED version as a fixed, pinned version (`fixedVersion`), never
as a route selector: the sync stores the tag minus its `v`, so a release tagged `latest`,
`stable`, `beta`, `pr-5` or a manual channel's name stores that word, and read as a selector it
would be a moving channel with no window check. As a fixed version it is window-checked and, not
being semver, refused whenever the window is bounded (P2-05 security round). The window is
always bounded in practice: `products.compat_min` and `compat_max` are `NOT NULL` with defaults
`0.0.0` and `99.0.0`, and every writer requires semver, so a stored version that is not semver is
always refused. **Residual (open):** like a pinned selector, a fixed release is checked as the
stable channel, not by the release's own stored channel or its prerelease flag. A stable-only
licence can therefore fetch any release whose stored version is semver and inside its window (a
GitHub prerelease such as `v1.2.0-beta.1`, or a release stored on a channel the licence does not
hold) by exact file, by hash, and by pinned version on `/release/builds` and `/release/dl`. Under
the default window `[0.0.0, 99.0.0]` that covers nearly every prerelease. Channel gating holds only
for moving selectors (`/release/dl/beta`, `/release/builds/beta/…`).
`/release/blobs` names a hash rather than a release, so the gateway's decision there proves only
a usable licence; under `entitled` a blob is served only if a release of this product whose
artifact carries that digest passes the `/release/files` check for its stored version, and a hash
no release artifact carries answers not-found (P2-05).

## 6. What the licensing enforcement actually promises

Stated honestly, so nobody builds on a false assumption:

**It does stop:** using the product with no license at all _against the server_; obtaining product
secrets or edge-mint tokens without a valid device token; exceeding seat limits by ordinary,
non-concurrent use; continuing to work after revocation _if the client contacts the server again_.

**It does not stop casual license sharing.** This was claimed here in the first draft and it is
wrong. A user can copy `~/.config/<product>/managed.json` to another machine, or simply hand-write
one — proven by `R4-01`, and it needs no patched binary and no tooling. Sharing a _cache file_ is
about as casual as an attack gets. The correction matters beyond accuracy: `SECURITY.md` declares
client-side-bypass reports out of scope by reference to this section, so an overstated claim here
would have silently placed a real, reportable weakness outside the disclosure policy.

**It does not stop:** a user who edits their own machine. The client gate is a string comparison
over a cache the user owns. A patched binary, an edited `managed.json`, or a rolled-back clock all
defeat it.

**Bounding the damage** is the achievable goal, and it rests on three properties — one of which
currently holds:

1. ✅ Secrets and minted tokens require a live server decision. **Holds.** For an edge-mint token
   that decision has two operator-held conditions besides the device token (and a usable licence
   when License is on): the recipe's signing secret is marked usage `edge-mint`, and an approval
   equal to the current recipe column for column exists. Neither can be set from a `.pkey/`
   manifest; failing the first is `500 misconfigured`, failing the second is the same `404` as an
   unknown recipe. While the mint is public — the product's effective registration is open,
   auto-issue allows anonymous enrolment, or Identity is on with an OIDC default tier
   (`mintIsPublic`) — an approval matches only if it carries an explicit, audited
   acknowledgement that the token is publicly mintable. If it was given with License on, it
   matches only while License is on, since the licence check runs only then. While Identity is on,
   it matches only if the OIDC provider, issuer, client id and group map are the ones it recorded.
   All three are checked on every mint, not only when approving, so a widening after an approval
   (by push or by operator) makes the recipe `404` at once. A widening a manifest push causes is
   also permanent: every writer of an approval input — resync, and the console's services and
   License-policy edits — deletes the widened approval before it writes (`config.mint.invalidate`
   in the audit log), so a later push or console edit that reverts the widening leaves the recipe
   `pending` until an operator re-approves it, even when the widening push threw or its Worker was
   killed before its own post-write sweep. What a re-approval cannot undo is what was issued while the approval
   was widened — the operator reviews and disables it — and what an approval cannot bound is the
   IdP it trusts: whoever that IdP signs in with a mapped group is covered (§3). The only
   approvals not given by an operator are the upgrade backfill's (approved by `migration`), which
   carry the acknowledgement only where the recipe was already a public mint before the upgrade,
   and the License and sign-in state as deployed.
   Every device is also capped at 30 mints a minute beside the per-IP budget.
2. ❌ A tampered cache should not be able to change _which keys verify signatures_. **Does not hold**
   — the cache overrides pinned keys.
3. ❌ A compromised signing key should be revocable. **Does not hold** — client trust sets only grow
   and ignore `status`, so revocation has no effect on already-provisioned clients.

Properties 2 and 3 are the difference between "piracy is bounded" and "one compromise is permanent".
Both are cheaply fixable and are the highest-priority remediation in this audit.

## 7. Attack trees (abbreviated)

### AT-1 — Forge entitlements for every user of a product

```
Forge a signed config doc for product P
├── Obtain P's signing key
│   ├── Obtain PLATFORM_KEK ──────────────► Worker secret compromise
│   └── Obtain an admin session ──────────► AT-2
└── OR make the client trust a key you hold
    ├── Write the victim's managed.json ──► local access; overrides PINNED keys
    └── Get a rogue key into a manifest ──► requires an already-trusted signer
        └── ...and it is then trusted FOREVER (no client-side revocation)
```

### AT-2 — Take the admin plane

```
Obtain admin authority
├── Forge the session cookie ─────────────► needs ADMIN_SESSION_SECRET
├── Plant your own session in an operator's browser (login CSRF — no state↔browser binding)
├── Be granted `groups` by the IdP ───────► any IdP group-membership weakness
└── XSS on the platform origin ───────────► unauthenticated raw-HTML endpoints without CSP
```

### AT-3 — Ship malicious code to every installed client

```
Poison the release channel
├── Hold GITHUB_WEBHOOK_SECRET (one global secret, no per-repo binding, no replay protection)
│   └── forge a push payload naming ANY linked repo, with an arbitrary `after` ref
├── Write access to a linked repo
│   ├── set `.pkey/release` sparkleEd25519Pub to a key you hold  (the verifying key is repo-sourced: resync rewrites `sparkle_ed25519_pub` on every push-triggered resync, with no operator guard)
│   ├── publish a DMG + a .sig made with that key (the appcast verifies the sidecar over the DMG bytes against `sparkle_ed25519_pub`, so a repo writer who swapped the key passes; only the client-side Sparkle `SUPublicEDKey` pin stops it)
│   └── set `.pkey/release` requireSparkleSignature:false  (no effect: the requirement is operator-owned, read from `operator_policy_json`, which no manifest path writes)
├── Publish through a trusted publisher (P2-02)
│   ├── run the declared workflow in the declared environment on a protected ref   (= repo write + whatever the rulesets/environment reviewers allow; the intended path)
│   ├── present another repository's OIDC token  (refused: numeric repository_id/owner_id pinned from GitHub)
│   ├── call a reusable workflow elsewhere, or the workflow from an unprotected ref  (refused: job_workflow_ref must be this repo's workflow at the triggering ref; ref_protected)
│   ├── replay a leaked OIDC token  (refused: single-use jti, UNIQUE in D1; 5-10 min exp anyway)
│   ├── edit `.pkey/release` to loosen the policy  (only workflow/environment are fields; an operator-claimed policy ignores the manifest)
│   ├── steal a minted `pkeyci_` token from a job log  (30 min, one product, scoped; static tokens ≤ 90 days, revocable)
│   └── copy another product's gated blob into the ticket prefix to earn a ref  (refused: credentials grant PutObject/HeadObject on one prefix only; promote refuses another product's staging key)
├── Hold the product key: a compromised Worker or KEK (wire contract v4's two-signer model, P3-02)
│   ├── CAN withhold an update (serve no target), or delay one (stop re-signing: installs freeze at expiresAt, `none {stale}`)
│   ├── CAN re-target a channel among CI-signed releases newer than what is installed, halt or re-bucket a rollout, narrow capabilities, or lower a floor
│   ├── CAN raise a floor: every install of that platform below it gets a prompt it cannot dismiss, including installs whose outlet has nothing newer (`blocked app-floor`), but play continues — no floor maps to `required` (only a CI-signed revocation of a required pack does, `plans/P4-13.md` decision 4), and License's compatibility window stays the one tool that blocks an old build
│   ├── CAN point a store prompt at another listing on the same store (the listing-URL prefixes fix the store, not the app)
│   ├── CAN raise a pack floor (P4-13): a prompt (`content-floor`, boot `optional`); play continues
│   ├── CAN narrow, gate or withhold pack updates (omit `packSets`, pin a pack on an outlet, halt or re-bucket a pack gate)
│   ├── CAN withhold a revocation from a device that has not learned it (a device that has keeps refusing the target)
│   ├── CAN, given a CI revocation with a replacement, withhold the replacement and so stop the revoked required pack (`blocked {revoked-content}`, boot `required`)
│   ├── CAN fast-forward `seq` to 2^53 − 1: installs that fetch that feed refuse the recovered Worker's lower `seq` and freeze once it is stale — until the operator runs `feed:seq-ceiling` for the product, which sets its ceiling flag (every `seq` row created later starts at the ceiling, so channels the attacker answered first, a manual or `pr-<n>` channel with no row, are covered), raises every existing row and drops the stored documents; the recovered Worker then signs every channel at the ceiling with a newer `issuedAt`, which clients accept. The freeze ends with the recovery, not with a client release
│   ├── CANNOT ship bytes no release key signed (records verify against pinned release keys only; the payload's size and SHA-256 are checked against the record)
│   ├── CANNOT downgrade (no answer offers a version below the installed one), widen a capability (the feed only narrows the per-kind defaults), or send a prompt outside the listing-URL prefixes
│   ├── CANNOT forge a revocation (release-key signed, verified against pinned release keys only)
│   ├── CANNOT downgrade a pack below what is installed (a feed target installs only at a higher `seq`)
│   ├── CANNOT install a release the device knows is revoked
│   ├── NOTE: a device remembers at most 256 revoked targets; more revocations push the oldest out (`plans/P4-13.md` §2.5)
│   ├── CANNOT forge a delegation or widen its scope, types or window (P4-19: release-key signed, verified against pinned release keys only)
│   ├── CAN offer, reorder or withhold feed deltas (P4-29): bandwidth and CPU only, bounded by one feed-offered delta per install, `memBudget` and the declared `bytes`
│   ├── CANNOT change installed bytes through a feed delta (the output must equal the CI-signed record's `payload`)
│   ├── CANNOT make a device decode past `memBudget` or write past `payload.size` through a feed delta
│   ├── CAN withhold a delegation record (packs under it then cannot install) or its revocation (as for any revocation) (P4-19)
│   └── CANNOT stop an install from running, except through a CI-signed revocation of a required pack (the licence documents it also signs are AT-1's subject)
├── Hold a delegated content key (P4-19)
│   ├── CAN publish data-only pack releases (types ∩ `DELEGABLE_PACK_TYPES`) of compatible or standalone packs under its scope, signed inside its window, through the trusted publisher; handlers must refuse malformed or offensive data safely
│   ├── CAN keep its releases installed after the window closes; only a CI revocation of the delegation stops them
│   ├── CANNOT sign an app record, a revocation, a delegation, a `godot.pck`, `godot.zip`, `audio.bank`, `ml.model`, `custom.*` or unknown-type pack, or a pack outside its scope (`jws`, `delegation` or `scope` in every SDK)
│   ├── CANNOT ship a container-layout pack, or a file outside the extension allow-list: the device's check, the CLI lint and ingest all refuse them. The allow-list is the real control; the head and tail sniff (Godot resource, PCK, script, archive and native-binary magics, a trailing `GDPC`, a zip end record in the last 65,557 bytes) is defence in depth that fails closed but cannot enumerate every format hidden inside an allowed one
│   ├── CANNOT smuggle a resource or script behind leading whitespace (a full 64-byte head window it cannot see past is refused) or an inline `Object(GDScript, …)` in a text file (the text rule refuses script markers, backslash-split markers and `\u`/`\U` escapes that could spell ASCII); NOTE: GDScript in general is not recognisable, so apps parse delegated text with pure JSON/CSV parsers only, never `str_to_var`, `ConfigFile` or `to_native(allow_objects)`, and never write delegated bytes under a code extension (Amendment A1)
│   ├── CANNOT reach a pin, hold, embedded baseline or replacement
│   ├── CANNOT re-delegate (a delegation verifies against pinned release keys only, one level deep)
│   ├── CANNOT sign outside its window through an honest Worker
│   ├── CAN, with a compromised Worker, sign indefinitely by backdating `issuedAt` into the window; only a revocation of the delegation that reaches devices (which that Worker can withhold) or a binary that rotates the pinned release keys bounds it
│   └── NOTE: delegation revocations count toward a device's 256 stored targets
├── Hold a release key (CI)
│   └── CAN mint delegations, which is no worse than the key itself; a delegation the holder never sees cannot be revoked by hash (revocation ingest accepts an unstored delegation only when it is supplied alongside), so rotating the pinned release keys is the remedy
├── Control the unsigned v3 `/version` answer (a compromised Worker, or its `url` field)
│   └── CAN offer any page, but the Godot UI kit's prompt opens only an `https://` URL (P1-10): a `file:`, `http:` or custom-scheme `url` gets no action, so `OS.shell_open` never reaches a local handler
└── Anywhere upstream of install.sh (no checksum, no signature verification at all)
```

### AT-4 — Take the Apple developer account through the Worker (A-17a)

```
Use the Worker's Admin App Store Connect key (A11b)
├── Steal an admin session (AT-2)
│   ├── CAN submit, release (typing the app's name), add testers, create non-consumable IAPs, register bundle ids
│   ├── CAN point the notification URL and webhook only at /<slug>/distribution/hooks/… on a Worker host
│   └── CANNOT invite users, mint or revoke certificates, register devices, delete anything (write gate, deny by default)
├── Add a route or handler that forwards a request ──► refused in review: no generic proxy; the gate checks every write anyway
├── Widen ASC_WRITE_ALLOW ──────────────────────────► a §9 review trigger; CI classifies every spec write
└── Compromise the Worker's code or PLATFORM_KEK ───► bypasses the gate: A11b lost in full (accepted residual risk)
```

## 8. Out of scope for this model

Physical access to Cloudflare infrastructure; compromise of Cloudflare itself; compromise of the
IdP's own signing keys (we model malicious _claims_, not forged tokens); social engineering of the
operator; and denial of service originating from Cloudflare's own network controls.

## 9. Review triggers

Revisit this document when any of the following changes: a new tenant that is not first-party is
onboarded; the portal gains write capability beyond device disconnect and key claim; a second
release channel or artifact type is added; a service gains a route, a table or a secret, or a
descriptor hook gains a method that writes or a new provider, or a method that returns bytes
(today only `releaseCatalog.openSource`); a byte route or a permanent alias is added; edge caching
is turned on for any byte route; a reader of `dist_rollouts` starts deciding what a device is
offered (P3-03), or a reader of `dist_availability` does, a store connector is added, gains a
control, calls a host other than its store's API, writes from a store object without first proving it is the outlet's app, takes the app it proves against from anywhere but the manifest's outlet identity, runs without that identity matching the operator's pin on its credential (a connector whose key reaches several apps added without an `OUTLET_CREDENTIAL_PINS` entry, or a pin check dropped or made optional), lets anything but the Core admin handler write a pin, or starts uploading or submitting (P5-02, P5-02f), an automatic action (the Play vitals auto-halt, P5-03; the telemetry auto-halt, P6-03) gains a verb other than halt or a setting any path but the console's audited control can write, the `system` rollout actor gains a verb or a caller outside the auto-halt, a Sentry candidate halts without an operator's confirmation, or the update-health counters start being written to D1 or keyed by anything a device can choose without bound, or anything but the console's key
routes writes a `dist_keys` entry (P2b-03); a service gains a `manifestIngestAlways` hook, or Distribution's writes more
than the `app` delivery-access row (it runs whatever the service's enablement); turning a
service on starts running an ingest; a byte route is added to `BYTE_ROUTES`, a type to
`BYTES_HOST_TYPES`, or anything else is hosted on a `plrs.im` sibling; a type is added to
`REGISTRY_HOST_TYPES`, the PyPI HTML fallback is admitted anywhere but its one flagged route or
under a looser policy, a registry route answers CORS or a method other than GET and HEAD, or
`authorizeFeedRead` moves after the cache lookup (F-02); the bucket-lock duration
changes; the admin authorization model changes; the wire contract
version increments; any new field is added to `AdminSession` or `PortalSession` (see the
domain-separation note in the audit report — the two realms share HMAC key material by default);
a CI scope is added, the publisher policy gains a field, a manifest is allowed to set any part of
it beyond the workflow and environment, or `UPLOAD_CREDENTIAL_ACTIONS` changes (P2-02); a new
way to earn a blob ref is added (P4-02's stage round is the second), or the Worker's index bound
(`MAX_PUBLISHED_INDEX_BYTES`) is raised; pack-set resolution reads a new input, an input moves
between signed, operator-owned and manifest-owned, a resolution failure is allowed to refuse an
operator action or to leave stored sets in place, or its bounds (`MAX_SELECTORS`,
`MAX_RESOLUTION_WORK`) are raised (P4-12); a route other than the blob route and P4-18's payload
URL serves a pack's object or reads a `gated/` key, the payload URL decides an object by anything
but `decideBlob`, offers a gated payload as a dictionary, or composes bytes beyond the 40-byte dcz
header and the stored artifact (P4-18), a ref kind other than `pack-upload` or `pack-object` authorises a
`gated/` key, or a gated object is authorised by anything but the pack's current
`dist_access.entitlement` (P4-05); the blob collector drops a ref kind other than `pack-object` or
`pack-upload`, deletes an object that has a ref, deletes before the bucket lock's age, restores a
ref no live release's verified record or index names, or its claim stops being checked by
`recordObject`; or anything but an operator's audited override releases a readiness hold (P4-14);
the commerce bridge (P6-01) gains a store, a writer of `license_store_grants` other than License's
`applyStoreGrant`, a root other than Apple Root CA - G3, a way to grant without the store's own
record naming the caller's binding, or a sandbox path open by default;
a new product-secret usage or sealed kind is introduced (it must say which paths may open it,
and that no manifest can grant it); an outlet-credential kind is added, or a file is added to an
allowlist in `test/outletCredentialReach.test.ts` (it must say why that file needs a store
credential, and the open must stay audited); an entry is added to
`ASC_WRITE_ALLOW` in `core/asc/writeGate.ts` or moved out of `writeGateDenied.ts`, a rule's
attributes, relationships, value checks or confirmation level are loosened, a new App Store Connect
OpenAPI spec version is adopted (`ASC_SPEC_PIN`), anything but `core/asc/client.ts` sends a request
to App Store Connect, or a field joins an A-17 projection (A-17a); a platform store credential (A-16) is added, used
without the product's platform pin matching at setup, token and open, cached in a way a hit can
skip the pin, allowed to fall through from a mis-pinned own credential, or written or opened by a
file outside its allowlists; the device trust level starts being carried in a signed document or token, an operation trusts `attested` without going through `trustRefusal`, the trust policy becomes writable by anything but the platform-admin `trust-policy` resource, the App Attest root stops being the pinned constant, or a path other than a token rotation keeps the level across a new device token (P6-02); or a new way to obtain a device token or licence without an
operator-issued key is added, or a check on one is made conditional on product state (it must be
folded into `mintIsPublic` or into the edge-mint approval's recorded state — `productWidening` in
`core/edgeMintApproval.ts`, which the ingest sweep and the `0025_b` backfill follow); or, for
package feeds (F-03), a package version becomes deletable or republishable, a feed takes a name
outside its namespace or proxies an upstream, a package release gains a signed record or reaches a
device-facing route, the Worker starts unpacking a package, or anything but the platform bootstrap
creates the system product; a feed adapter is added to `FEED_ADAPTERS`, declares
`capabilities.delete` or a non-`feedRoute` route, or a check of `test/feedAdapters.test.ts` is
relaxed; the render drain starts answering a request, reading Release outside the
`releaseCatalog` hook or writing outside `registry/`; or, for
content-key delegation (P4-19), `DELEGABLE_PACK_TYPES` or `DATA_ONLY_EXTENSIONS` grows, a delegation
gains a scope dimension, the delegated path is allowed on a surface beyond a compatible or
standalone pack's feed target and the reload of a stored delegated install, any SDK or handler
passes a delegated file to `load_resource_pack` or to any other engine API that mounts or loads
code, or a non-tree layout becomes delegable, or the head or tail sniff is narrowed; or, for the
pack-type handlers (P4-16), a handler starts evaluating what it reads (a script engine, an object
reviver, a resource loader, a plural-formula evaluator) or resolves a path from payload contents
other than by exact index match, a type joins `MOUNTED_PACK_TYPES`, or a rule of the `godot.zip`
reader is relaxed in the CLI or on a device; or, for the client updater plugins (P5-07), a new
updater backend, or a change to Disable Library Validation or the signing defaults; or, for the
Platform section (A-11, A-12), a Worker path starts writing `platform_deploys`, the deploy record
step gains a credential or a permission beyond the deploy token's D1 edit, a platform route starts
reporting a binding's resource id or any secret-derived value, a route updates or deletes a
`platform_audit` row, or a writer puts a secret (or a hash or length of one) in `before_json` or
`after_json`; or, for the platform settings store (A-13), a setting is added to
`PLATFORM_SETTINGS`, a setting's precedence changes from `ceiling` to `runtime`, a registry
entry's bounds widen (`LAZY_DELTA_MAX_BYTES` above the measured 32 MiB ceiling, or a grace below
one day), the settings inventory starts reporting anything about a secret beyond its presence,
or a path reads one of the four settings from the raw `[vars]` instead of through the resolver;
or, for self-reported operations (A-14), the `DELTA_DLQ` binding is used for anything but
`metrics()`, a request path starts persisting free-text error capture, a job-run or heartbeat
writer stores request data or an untruncated message, or the Operations route gains an outbound
host or a credential.
