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

**A5 is scoped by usage.** Every product secret carries a usage — general (stored `NULL`) or
`edge-mint` — and `openProductSecret` opens a secret only for the usage its caller requires: the
edge-mint route asks for `edge-mint`, the OIDC client-secret path for general, and a mismatch
reads as a missing secret (the value is never unsealed). The usage is written **only** by the admin
API (`PUT …/secrets/<name>` with `"usage"`), audited as `secret.usage`, and never by a `.pkey/`
manifest. The usage is not yet bound into the AEAD associated data; that is stronger but needs
every secret re-sealed, and is deferred to the outlet-credential work (P5-01).

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

| Input                           | Trusted for                                                               | Actual origin        | Control                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC `groups`                   | **Platform admin authority**                                              | The IdP              | Any IdP feature that lets a user influence group membership grants platform admin. A single claim string is the entire decision.                                                                                                                                                                                                                                                         |
| OIDC `sub`                      | License identity                                                          | The IdP              | Admin and portal require it non-empty; the **product flow does not**, so an omitted `sub` converges distinct identities onto one license.                                                                                                                                                                                                                                                |
| OIDC `email`                    | Portal license linking, cross-product                                     | The IdP              | Portal requires `email_verified`; the **product flow does not**, and admins may set `licenses.email` to any unverified string.                                                                                                                                                                                                                                                           |
| `.pkey/` manifest               | Tiers, OIDC issuer, artifact policy, admin group, binary name             | A linked GitHub repo | Applied on webhook-triggered resync. The repo effectively writes its own security policy — except edge-mint recipes, which are inert until an operator approves them column for column and sign only with an operator-marked `edge-mint` secret. Its tag regexes are length-capped only: R10-09.                                                                                         |
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
version increments; any new field is added to `AdminSession` or `PortalSession` (see the
domain-separation note in the audit report — the two realms share HMAC key material by default);
a new product-secret usage or sealed kind is introduced (it must say which paths may open it,
and that no manifest can grant it); or a new way to obtain a device token or licence without an
operator-issued key is added, or a check on one is made conditional on product state (it must be
folded into `mintIsPublic` or into the edge-mint approval's recorded state — `productWidening` in
`core/edgeMintApproval.ts`, which the ingest sweep and the `0025_b` backfill follow).
