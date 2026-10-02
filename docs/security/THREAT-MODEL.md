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

| #   | Asset                                                             | Where it lives                                                                   | Loss impact                                                                                                                                 |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **`PLATFORM_KEK`**                                                | Worker secret                                                                    | Decrypts every tenant's signing key and every product secret. Total platform compromise. Cannot be rotated today (see A9).                  |
| A2  | **Per-product Ed25519 signing keys**                              | `product_keys.enc_private_json`, sealed under A1                                 | Forge any config doc, entitlement, or secret for that product. **Unrevocable for already-provisioned clients** — see §6.                    |
| A3  | **The release channel**                                           | GitHub App key, webhook secret, `release_config`                                 | Ship arbitrary code to every installed client. Equal to A1 in practical severity.                                                           |
| A4  | **`ADMIN_SESSION_SECRET`**                                        | Worker secret                                                                    | Forge admin sessions → reach A2, A3, A5, A6 through the API.                                                                                |
| A5  | **Product secrets** (OIDC client secrets, edge-mint signing keys) | `product_secrets`, sealed under A1                                               | Impersonate the product to its IdP; mint third-party tokens (e.g. Apple MusicKit) at the operator's cost.                                   |
| A6  | **Customer PII**                                                  | `licenses`, `customers`, `portal_accounts`, `audit` — plaintext                  | Email, name, OIDC subject, device user-agents, hardware-derived digests. Regulatory and reputational.                                       |
| A7  | **Licensing revenue**                                             | The whole enforcement path                                                       | The thing the system nominally exists to protect. Deliberately ranked _below_ A1–A5.                                                        |
| A8  | **Service availability**                                          | Worker, D1, KV, DO                                                               | A licensing outage can block paying customers from software they already bought.                                                            |
| A9  | **The ability to recover**                                        | Rotation and revocation machinery                                                | Not an asset in the usual sense, but its absence converts any A1/A2 loss from an incident into a permanent condition.                       |
| A10 | **The blob store** (release bytes)                                | R2 bucket `polaris-key-blobs-<env>` (`BLOBS`) + `blob_objects`/`blob_refs` in D1 | Serve a wrong object under a trusted hash name to every client that downloads it, or lock one in place for 180 days. Equal to A3 in reach.  |
| A11 | **Outlet credentials** (store API keys)                           | `outlet_credentials`, sealed under A1 (own AAD kind); minted tokens sealed in KV | Act as the operator in App Store Connect, Google Play or Partner Center: upload or release builds, change listings and prices. Equal to A3. |
| A12 | **CI credentials** (`pkeyci_` tokens, upload tickets)             | `ci_tokens`/`ci_upload_tickets` (peppered hashes only); held by CI jobs          | Publish, promote (and, if granted, yank) releases of one product for up to 30 min (minted) or 90 days (static). A route into A3/A10.        |
| A13 | **The R2 parent token** and the temporary credentials it mints    | Worker secrets `R2_PARENT_*`; temp credentials held by CI for ≤ 1 h              | The parent can write the whole bucket, locked prefixes included (subject to the age lock). A temp credential: one staging prefix.           |

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
  gated content is authorised per request and served `private, no-store`. Until that per-request
  check exists (P4-05), the build and file routes (Distribution's since P2b-04) refuse a location
  under `gated/` outright, whatever the deliverable's delivery access, and the blob route reads only the
  ungated key and, under `entitled`, re-checks the licence against every release that carries
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
is bounded by the validator, not by the push: at most 32 outlets (`MAX_OUTLETS`), and transport
routes only for the deliverables Release actually ingests — today only `app`, because packs are
ignored (`pack_deliverables_not_supported`). Routing every declared pack would have let a 64 KiB
`release.yaml` of `{kind: pack}` entries multiply into ~90,000 statements. A link or resync
therefore writes at most 32 outlet upserts, one removal sweep, one transport delete and 32
transport inserts (`test/distributionOutlets.test.ts`, "the ingest's cost is bounded"). When
packs are ingested (P4-02), the pack count must be bounded before they are routed.

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
  survives a push. A pack row is operator-only. `update/settings` refuses `artifactsAccess` by
  name.
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
  reads as `entitled` too. The blob route uses the strictest mode of the deliverables whose
  releases carry the digest.
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
  test pins a ten-outlet product).
- **Residual.** The page is rendered from what CI and the operator recorded: a CI report can make
  a store link appear (a `live` claim) or a self-hosted release disappear, as for the feeds
  above; a wrong listing is the repo writer's own text, shown escaped. A visitor reaching the
  page through a stale link sees a release up to five minutes old. QR codes carry the same URLs
  the links do; one too long for the encoder (an Obtainium app config) is simply not drawn.

### Outlet credentials (P5-01)

**What they are.** The keys a store connector authenticates with (A11): an App Store Connect API
key (`.p8`), the App Store Connect webhook secret, a Google service-account key, a
Partner Center client secret. Each is worth as much as the release channel (A3) — whoever holds
one can ship to that store as the operator.

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
  Google Play", below). A Partner Center app (P5-04) is protected only once its connector adds its
  entry and calls `checkOutletCredentialPin` in its setup; until then that connector has this
  section's old residual.

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
ceiling is then the product's single `RateLimitDO` (R10-04a), of the order of 1,000 checks a
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
`clientIp`, and sharding the rate-limit Durable Object (R10-04a).

**Remote phishing (RFC 8628 §5.4) — open: R1-07, rooted in R8-03.** Whoever starts a flow can
confirm it themselves, with no browser: `/device/start` with their own device id, GET the page
for their own user code, read the CSRF token, POST it with no `Origin` (it passes, as above), and
read the IdP authorize URL — `state`, `nonce` and PKCE challenge — out of the `303`. They then
forward that URL to a victim, or redirect the victim to it from any page. The victim signs in at
the IdP — or, with silent SSO, does nothing at all — and never sees the Polaris confirmation
page. The callback binds the victim's license to the flow, whose device id is the attacker's,
and the attacker's own `/device/poll`, with their own device code, returns a device token on the
victim's license (PoC: `R8-oidc.test.ts` › `OPEN (R1-07 / R8-03): the starter confirms its own
flow…`, which asserts the gap).

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
  updates (`none {stale}`); it never stops play.

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
- **Floors prompt, never block.** A floor (`min_supported`, a record's `minSupportedSeq`) reaches
  devices as a prompt the player cannot dismiss, per platform, and play continues; License's
  compatibility window is the only control that stops an old build.

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
- **Decoding is bounded before it starts.** `@polaris-key/zstd-wasm`, the decoder-only libzstd
  1.5.7 WASM the Worker and the browser use, decodes exactly one frame whose declared content
  size is the caller's, and with a raw-content prefix refuses a frame whose header window is
  above 2^`windowLogMax` before decoding, because libzstd enforces its own limit only when it
  streams through a small buffer. Its workerd entry instantiates the module per decode, so no
  decode's linear memory outlives the call. A files index is refused above
  `MAX_FILES_INDEX_BYTES` (32 MiB) on a client before it is fetched or decoded.

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

| ID  | Adversary                             | Capability                                                                           | Motivation                                                                  | Priority                                           |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------- |
| T1  | **Unauthenticated internet attacker** | HTTP to `key.plrs.im`, can read public discovery/JWKS, can register nothing          | Control-plane takeover                                                      | **Highest**                                        |
| T2  | **Release-channel attacker**          | Holds the webhook secret, or write access to a linked repo, or GitHub App compromise | Ship code to end users                                                      | **Highest**                                        |
| T3  | **Malicious tenant / customer**       | Valid license, device token, portal account; possibly a product operator             | Cross-tenant data, tier escalation, extra seats                             | High                                               |
| T4  | **License pirate**                    | Full control of their own machine, can patch binaries and edit files                 | Use software without paying                                                 | Medium — bounded by §6                             |
| T5  | **Malicious or compromised IdP**      | Controls claims presented to the Worker                                              | Privilege escalation via `groups`, identity confusion via `email`/`sub`     | High                                               |
| T6  | **Supply-chain attacker**             | Publishes a malicious dependency, or compromises a GitHub Action                     | Reach CI secrets and published artifacts                                    | High                                               |
| T7  | **Insider / compromised admin**       | Valid admin session                                                                  | Anything the admin API permits — which today is everything, on every tenant | High                                               |
| T8  | **Network attacker**                  | On-path between client and `key.plrs.im`                                             | Downgrade, MITM                                                             | Low (TLS), but no SDK enforces HTTPS or pins certs |

## 5. Semi-trusted inputs — the ones that decide authorization

These deserve their own section because each is treated as trusted somewhere in the code while
originating outside the trust boundary.

| Input                           | Trusted for                                                                       | Actual origin        | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OIDC `groups`                   | **Platform admin authority**                                                      | The IdP              | Any IdP feature that lets a user influence group membership grants platform admin. A single claim string is the entire decision.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OIDC `sub`                      | License identity                                                                  | The IdP              | Admin and portal require it non-empty; the **product flow does not**, so an omitted `sub` converges distinct identities onto one license.                                                                                                                                                                                                                                                                                                                                                                                                              |
| OIDC `email`                    | Portal license linking, cross-product                                             | The IdP              | Portal requires `email_verified`; the **product flow does not**, and admins may set `licenses.email` to any unverified string.                                                                                                                                                                                                                                                                                                                                                                                                                         |
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
│   ├── CAN raise a floor: every install of that platform below it gets a prompt it cannot dismiss, including installs whose outlet has nothing newer (`blocked app-floor`), but play continues — no v4 answer maps to `required`, and License's compatibility window stays the one tool that blocks
│   ├── CAN point a store prompt at another listing on the same store (the listing-URL prefixes fix the store, not the app)
│   ├── CAN fast-forward `seq` to 2^53 − 1: installs that fetch that feed refuse the recovered Worker's lower `seq` and freeze once it is stale — until the operator runs `feed:seq-ceiling` for the product, which sets its ceiling flag (every `seq` row created later starts at the ceiling, so channels the attacker answered first, a manual or `pr-<n>` channel with no row, are covered), raises every existing row and drops the stored documents; the recovered Worker then signs every channel at the ceiling with a newer `issuedAt`, which clients accept. The freeze ends with the recovery, not with a client release
│   ├── CANNOT ship bytes no release key signed (records verify against pinned release keys only; the payload's size and SHA-256 are checked against the record)
│   ├── CANNOT downgrade (no answer offers a version below the installed one), widen a capability (the feed only narrows the per-kind defaults), or send a prompt outside the listing-URL prefixes
│   └── CANNOT stop an install from running (the licence documents it also signs are AT-1's subject)
├── Control the unsigned v3 `/version` answer (a compromised Worker, or its `url` field)
│   └── CAN offer any page, but the Godot UI kit's prompt opens only an `https://` URL (P1-10): a `file:`, `http:` or custom-scheme `url` gets no action, so `OS.shell_open` never reaches a local handler
└── Anywhere upstream of install.sh (no checksum, no signature verification at all)
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
control, calls a host other than its store's API, writes from a store object without first proving it is the outlet's app, takes the app it proves against from anywhere but the manifest's outlet identity, runs without that identity matching the operator's pin on its credential (a connector whose key reaches several apps added without an `OUTLET_CREDENTIAL_PINS` entry, or a pin check dropped or made optional), lets anything but the Core admin handler write a pin, or starts uploading or submitting (P5-02, P5-02f), an automatic action (the Play vitals auto-halt, P5-03) gains a verb other than halt or a setting any path but the console's audited control can write, or anything but the console's key
routes writes a `dist_keys` entry (P2b-03); a service gains a `manifestIngestAlways` hook, or Distribution's writes more
than the `app` delivery-access row (it runs whatever the service's enablement); turning a
service on starts running an ingest; a byte route is added to `BYTE_ROUTES`, a type to
`BYTES_HOST_TYPES`, or anything else is hosted on a `plrs.im` sibling; the bucket-lock duration
changes; the admin authorization model changes; the wire contract
version increments; any new field is added to `AdminSession` or `PortalSession` (see the
domain-separation note in the audit report — the two realms share HMAC key material by default);
a CI scope is added, the publisher policy gains a field, a manifest is allowed to set any part of
it beyond the workflow and environment, or `UPLOAD_CREDENTIAL_ACTIONS` changes (P2-02);
a new product-secret usage or sealed kind is introduced (it must say which paths may open it,
and that no manifest can grant it); an outlet-credential kind is added, or a file is added to an
allowlist in `test/outletCredentialReach.test.ts` (it must say why that file needs a store
credential, and the open must stay audited); or a new way to obtain a device token or licence without an
operator-issued key is added, or a check on one is made conditional on product state (it must be
folded into `mintIsPublic` or into the edge-mint approval's recorded state — `productWidening` in
`core/edgeMintApproval.ts`, which the ingest sweep and the `0025_b` backfill follow).
