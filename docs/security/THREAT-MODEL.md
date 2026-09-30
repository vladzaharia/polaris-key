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

| #   | Asset                                                             | Where it lives                                                                   | Loss impact                                                                                                                                |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | **`PLATFORM_KEK`**                                                | Worker secret                                                                    | Decrypts every tenant's signing key and every product secret. Total platform compromise. Cannot be rotated today (see A9).                 |
| A2  | **Per-product Ed25519 signing keys**                              | `product_keys.enc_private_json`, sealed under A1                                 | Forge any config doc, entitlement, or secret for that product. **Unrevocable for already-provisioned clients** — see §6.                   |
| A3  | **The release channel**                                           | GitHub App key, webhook secret, `release_config`                                 | Ship arbitrary code to every installed client. Equal to A1 in practical severity.                                                          |
| A4  | **`ADMIN_SESSION_SECRET`**                                        | Worker secret                                                                    | Forge admin sessions → reach A2, A3, A5, A6 through the API.                                                                               |
| A5  | **Product secrets** (OIDC client secrets, edge-mint signing keys) | `product_secrets`, sealed under A1                                               | Impersonate the product to its IdP; mint third-party tokens (e.g. Apple MusicKit) at the operator's cost.                                  |
| A6  | **Customer PII**                                                  | `licenses`, `customers`, `portal_accounts`, `audit` — plaintext                  | Email, name, OIDC subject, device user-agents, hardware-derived digests. Regulatory and reputational.                                      |
| A7  | **Licensing revenue**                                             | The whole enforcement path                                                       | The thing the system nominally exists to protect. Deliberately ranked _below_ A1–A5.                                                       |
| A8  | **Service availability**                                          | Worker, D1, KV, DO                                                               | A licensing outage can block paying customers from software they already bought.                                                           |
| A9  | **The ability to recover**                                        | Rotation and revocation machinery                                                | Not an asset in the usual sense, but its absence converts any A1/A2 loss from an incident into a permanent condition.                      |
| A10 | **The blob store** (release bytes)                                | R2 bucket `polaris-key-blobs-<env>` (`BLOBS`) + `blob_objects`/`blob_refs` in D1 | Serve a wrong object under a trusted hash name to every client that downloads it, or lock one in place for 180 days. Equal to A3 in reach. |

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
 CI (temp creds) ──────►│  R2 staging/ only; never a locked prefix  │
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
  gated content is authorised per request and served `private, no-store`.
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
(`mount.ts` `BYTE_ROUTES`, dispatched by `core/bytesHost.ts`; empty until P2-05/P2b-04);
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

### The device-code user-code page (P1-06)

**What it is.** `GET`/`POST /<p>/identity/auth/device` is the RFC 8628 code-entry page a TV, a
console, a game or a CLI sends the player to. The player types (or scans) an eight-character
user code; the page looks it up server-side and shows a confirmation page naming the product and
the device; one button press sends the browser to the IdP. The secret `deviceCode` — which,
with the device id, is what a poller redeems for a device token — never appears in a URL, a page
or a form on this path. The user code is drawn independently of it, so learning a user code
(over a shoulder, from a stream, from a photo of a QR code) gives nothing to poll with. Its KV
index is keyed by a peppered hash (R12-04), lives for the flow's 600 s and is deleted with it.

**Brute force (RFC 8628 §5.1).** The code space is 20⁸ ≈ 2.56 × 10¹⁰ (RFC 8628 §6.1's
consonant alphabet). The page allows 30 requests per minute per IP, fail-closed, so one address
gets at most 300 guesses in a code's 600-second life: with N codes live at once, a single
address hits one with probability about 300·N / 2.56 × 10¹⁰ — 1.2 × 10⁻⁵ even with 1,000 live
flows. A botnet scales that linearly with its addresses (10,000 addresses against 1,000 live
flows is roughly 0.12 per 10-minute window). What a hit buys is bounded: it can render and
confirm SOMEONE ELSE's flow and sign it in under the attacker's own IdP identity (the device ends
up on the attacker's account, not the reverse), or re-render the page to invalidate the real
user's single-use CSRF token so their click 403s and they reload. It cannot obtain a device
token, a license, the device code, or the victim's identity. There is deliberately no
product-wide bucket: one attacker could exhaust it and lock every player of a product out of
sign-in.

**Remote phishing (RFC 8628 §5.4).** An attacker can start a flow on their own device and send a
victim the `verificationUriComplete` link; if the victim confirms and signs in, the attacker's
device receives the victim's license. The control is the confirmation page itself, which a QR
scan still lands on: it names the product and shows the device label and user code, and nothing
happens without a button press. The device label is `deviceName` from `/device/start`, which is
client-supplied display text, so a phisher can make it say anything. This residual is inherent
to the device-authorization grant; it is the same one every RFC 8628 deployment carries.

**Unchanged.** The legacy `/identity/auth/device/verify?device_code=` page stays for flows in
flight across the deploy. Confirmation on both routes is one function: an `Origin` check, a
single-use CSRF token, and a `303` to the IdP with `no-referrer` and `no-store`. The confirmation
page's CSP widens `form-action` by exactly the IdP origin that `303` goes to.

### Boundaries that are weaker than they look

- **The SDK cache is inside the attacker's trust domain, but the SDK treats it as trusted.** The
  JWS is verified once on fetch, then discarded; the decoded doc is reloaded with a bare
  `JSON.parse`. Worse, the cache can supply `trustedKeys` that _override pinned keys_.
- **A linked GitHub repo is a control-plane input, not just a data source.** `.pkey/` manifests
  rewrite tiers, OIDC issuer, artifact policy, and admin group on resync.
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

| Input                           | Trusted for                                                               | Actual origin        | Control                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC `groups`                   | **Platform admin authority**                                              | The IdP              | Any IdP feature that lets a user influence group membership grants platform admin. A single claim string is the entire decision.                                                                                                                                                                                                                                                         |
| OIDC `sub`                      | License identity                                                          | The IdP              | Admin and portal require it non-empty; the **product flow does not**, so an omitted `sub` converges distinct identities onto one license.                                                                                                                                                                                                                                                |
| OIDC `email`                    | Portal license linking, cross-product                                     | The IdP              | Portal requires `email_verified`; the **product flow does not**, and admins may set `licenses.email` to any unverified string.                                                                                                                                                                                                                                                           |
| `.pkey/` manifest               | Tiers, OIDC issuer, artifact policy, admin group, binary name             | A linked GitHub repo | Applied on webhook-triggered resync. The repo effectively writes its own security policy. Its tag regexes are length-capped only: R10-09.                                                                                                                                                                                                                                                |
| `web.origins` (`.pkey/product`) | Which browser origins may read a product's device-facing responses (CORS) | A linked GitHub repo | Exact origins only (no wildcard, `null`, path or non-loopback `http`), capped at 16, re-checked when the row is read. Never `Allow-Credentials`, so a listed page gains nothing a non-browser client lacks. Applied in dispatch after the handler, so the edge cache stays origin-free. The console, portal, docs, webhook and cookie-bearing identity routes never answer CORS (R1-09). |
| `X-PKey-Version` header         | Version and channel gating                                                | The client           | `0.0.0-dev` bypasses all of it.                                                                                                                                                                                                                                                                                                                                                          |
| `X-PKey-Device` header          | Device identity                                                           | The client           | Entirely client-asserted; not bound to the fingerprint.                                                                                                                                                                                                                                                                                                                                  |
| Fingerprint components          | Seat/hardware binding                                                     | The client           | Server recomputes the hwid (good), but checks it only at activation and never across devices.                                                                                                                                                                                                                                                                                            |
| Cached `trustedKeys`            | **Signature verification**                                                | A user-writable file | Overrides pinned keys.                                                                                                                                                                                                                                                                                                                                                                   |

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

1. ✅ Secrets and minted tokens require a live server decision. **Holds.**
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
│   ├── publish a DMG + matching .sig (signature is passed through, never verified server-side)
│   └── set `.pkey/release` requireSparkleSignature:false  ← repo disables its own control
└── Anywhere upstream of install.sh (no checksum, no signature verification at all)
```

## 8. Out of scope for this model

Physical access to Cloudflare infrastructure; compromise of Cloudflare itself; compromise of the
IdP's own signing keys (we model malicious _claims_, not forged tokens); social engineering of the
operator; and denial of service originating from Cloudflare's own network controls.

## 9. Review triggers

Revisit this document when any of the following changes: a new tenant that is not first-party is
onboarded; the portal gains write capability beyond device disconnect and key claim; a second
release channel or artifact type is added; a byte route is added to `BYTE_ROUTES`, a type to
`BYTES_HOST_TYPES`, or anything else is hosted on a `plrs.im` sibling; the bucket-lock duration
changes; the admin authorization model changes; the wire contract
version increments; or any new field is added to `AdminSession` or `PortalSession` (see the
domain-separation note in the audit report — the two realms share HMAC key material by default).
