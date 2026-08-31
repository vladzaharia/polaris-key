# Polaris Key — Threat Model

> Status: **v2**, revised 2026-08-31. First written 2026-08-25 as part of the full security audit.
> This is the document the codebase was missing. When code and this document disagree, that is
> a finding — open a PR to reconcile one or the other.

**What changed from v1.** v1 described a system that has since been remediated, and a threat model
that overstates a weakness is as harmful as one that understates it: `SECURITY.md` scopes what is
_reportable_ by reference to §6, so a stale §6 silently places real weaknesses outside the
disclosure policy — or, in the other direction, invites reports on properties that now hold.

| §   | v1 said                                                    | v2 says                                                                                               |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| §2  | `PLATFORM_KEK` cannot be rotated; product keys unrevocable | Both are now operations. A1/A2/A9 rewritten; **A10 added** for the new `pkeya_` admin API token       |
| §3  | The SDK cache supplies `trustedKeys` that override pins    | The cache is not a key source at all. Bullet replaced; manifest ingest named as its own control class |
| §4  | T8: "no SDK enforces HTTPS or pins certs"                  | Half false. All four SDKs enforce https-or-loopback; none pin TLS certificates                        |
| §5  | Row: cached `trustedKeys` "overrides pinned keys"          | Row removed — it describes a key source that no longer exists                                         |
| §6  | Properties 2 and 3 ❌ "Does not hold"                      | **Both now ✅ hold**, with the enforcing call sites named                                             |
| §7  | Attack trees naming four now-fixed defects                 | Rewritten against the current tree; AT-4 added for manifest ingest; PK-01 recorded in AT-2            |
| §9  | —                                                          | Two new review triggers: the admin-token surface, and the trust-anchor key class                      |

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

| #   | Asset                                                             | Where it lives                                                  | Loss impact                                                                                                                                                      |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **`PLATFORM_KEK`**                                                | Worker secret                                                   | Decrypts every tenant's signing key and every product secret. Total platform compromise. **Rotatable** — see below.                                              |
| A2  | **Per-product Ed25519 keys** (anchor + document)                  | `product_keys.enc_private_json`, sealed under A1                | Forge any config doc, entitlement, or secret for that product. **Revocable** for already-provisioned clients — see §6 and below.                                 |
| A3  | **The release channel**                                           | GitHub App key, webhook secret, `release_config`                | Ship arbitrary code to every installed client. Equal to A1 in practical severity.                                                                                |
| A4  | **`ADMIN_SESSION_SECRET`**                                        | Worker secret                                                   | Forge admin sessions → reach A2, A3, A5, A6, A10 through the API.                                                                                                |
| A5  | **Product secrets** (OIDC client secrets, edge-mint signing keys) | `product_secrets`, sealed under A1                              | Impersonate the product to its IdP; mint third-party tokens (e.g. Apple MusicKit) at the operator's cost.                                                        |
| A6  | **Customer PII**                                                  | `licenses`, `customers`, `portal_accounts`, `audit` — plaintext | Email, name, OIDC subject, device user-agents, hardware-derived digests. Regulatory and reputational.                                                            |
| A7  | **Licensing revenue**                                             | The whole enforcement path                                      | The thing the system nominally exists to protect. Deliberately ranked _below_ A1–A5.                                                                             |
| A8  | **Service availability**                                          | Worker, D1, KV, DO                                              | A licensing outage can block paying customers from software they already bought.                                                                                 |
| A9  | **The ability to recover**                                        | Rotation and revocation machinery                               | Not an asset in the usual sense. In v1 its **absence** converted any A1/A2 loss from an incident into a permanent condition. It now exists for both — see below. |
| A10 | **`pkeya_` admin API tokens**                                     | `admin_api_tokens`, stored only as `hashKey(token, pepper)`     | A bearer credential for the admin API. Narrower than A4 by construction, and the reason it exists is that the alternative was worse — see below.                 |

**A1 is rotatable now.** `keyvault.ts` reads a KEK **keyring** (`PLATFORM_KEK_KEYS` as
`kid → base64`, with `PLATFORM_KEK_ACTIVE` naming the writer) rather than a single secret, so
there is a two-KEK read window during which everything sealed under the outgoing kid still opens.
The re-encryption pass is an admin endpoint (`POST /manage/api/products/kek`) because SQLite
cannot do AES-GCM and it therefore cannot be a migration. The legacy single-`PLATFORM_KEK` form
still opens, so this is not a flag day. Procedure: `docs/RUNBOOK.md` → Secrets → Rotating
`PLATFORM_KEK`. **The step that is easy to skip is the resealing sweep**; skipping it leaves rows
sealed under a KEK that is no longer in the ring, which presents as every product route 404ing at
once.

**A2 is two key classes, and the split is what made revocation real.** Wire contract v3 §1.1
separates the **anchor** (signs the trust manifest, and it is what host applications pin) from the
**document** key (signs license, config and bundle documents). Before that split — finding
**B3-01** — the manifest was signed by whichever key was currently active for documents, while
clients verify a manifest against **pins only**. So the first document-key rotation made every
already-installed client reject every subsequent manifest: trust refresh died, the §4.2 clock
floor stopped advancing, and revocation died, for precisely the population a compromise needs to
reach. Rotating a signing key was, in effect, an application release. With the split
(`packages/worker/src/core/trust.ts` signs with `product.trustAnchorKey()`), a document-key
rotation changes nothing a client verifies a manifest with, and **only** rotating the anchor
costs a release — which is the one key operation the pinning rule is supposed to make expensive.

**A9 exists now, for both A1 and A2.** That is the single largest change from v1. Neither loss is
a permanent condition any more: a KEK is rotated through the keyring plus the resealing sweep, and
a compromised document key is revoked with an effect that reaches installed clients (§6, property
3).

**A10 is deliberately narrow, and it replaced something broader.** Before it, the one non-browser
caller of the admin API — `pkey bundle`, run from terminals and CI — authenticated by having an
operator copy their live `__Host-pkey_admin` cookie into an environment variable. That credential
carries the human's full authority, cannot be revoked without killing every session that identity
holds, and is indistinguishable in the audit log from the human clicking in the console. A
`pkeya_` token is scoped, individually revocable, separately attributed, and given an explicit
expiry at mint. Its blast radius is bounded by **default deny**: `scopeForRequest` returns `null`
for every admin route it does not explicitly name, and `null` refuses. Adding an admin route
therefore does not silently widen every existing token. The scope vocabulary is exactly one entry
(`bundles:mint`), and the token routes themselves are unscoped — so a token cannot mint, list or
revoke a token, including itself.

## 3. Trust boundaries

```
                        ┌─────────────────────────────────────────┐
   UNTRUSTED            │              TRUSTED                     │
                        │                                          │
 end-user device ──────►│  Cloudflare Worker (key.plrs.im)          │
  (SDK, fully           │    ├── D1  (relational, authoritative)    │
   attacker-controlled) │    ├── KV  (hot-path hints only)          │
                        │    ├── DO  (atomic rate limiting)         │
 browser (admin/portal)►│    └── ASSETS (SPA bundles + docs site)   │
                        │                                          │
 GitHub (webhooks, ────►│  secrets: PLATFORM_KEK keyring, session   │
  repo contents,        │           secrets, GitHub App key,        │
  release assets)       │           webhook secret                  │
                        └─────────────────────────────────────────┘
 IdP (OIDC claims) ────►│  semi-trusted: see §5
```

**The single load-bearing sentence, stated so a developer can act on it:**

> The server's decision to _send_ something is the only enforcement. Everything the client does
> with what it received is advisory.

Concretely: a bypassed client gate can fake "licensed" locally, but it cannot manufacture
`payload.secrets` or an edge-mint token, because those only exist if the server chose to emit them.
Any feature whose security depends on the client _refusing_ to do something is not secured.

### Boundaries that are weaker than they look

- **The SDK cache is inside the attacker's trust domain, and the SDK now treats it that way.** In
  v1 the JWS was verified once on fetch and discarded, the decoded document was reloaded with a
  bare `JSON.parse`, and — worst — the cache could supply `trustedKeys` that overrode pinned keys.
  None of that survives: cache record v3 persists **compact JWS only** (`trustJws` plus each
  document), every artifact is re-verified on reload against the same rules as the network path,
  and there is no bare `kid → key` JSON anywhere in the format. The residual weakness is the
  honest one — a user can delete or roll back their own cache, which is bounded by the monotonic
  clock floor (§4.2 of the wire contract), not by the cache being trusted.
- **A linked GitHub repo is a control-plane input, not just a data source — this is its own
  class.** `.pkey/` manifests rewrite tiers, OIDC issuer, artifact policy, admin group and binary
  name on resync, so the ingest path is a **write to security policy performed by a party outside
  the trust boundary**, and it deserves to be modelled as such rather than as "config sync". The
  ingest is now bounded rather than open (`MAX_MANIFEST_BYTES`; a 1 MiB cap on the webhook body
  checked _before_ the body is buffered; the body read is the exact HMAC input and an over-cap
  request is refused, never truncated), a delivery is refused for any product whose linked repo
  records a `gh_installation_id` that the delivery does not match, and replayed deliveries are
  dropped by remembered `X-GitHub-Delivery` GUID. Note the shape of that middle control: it binds
  only where an installation id **has been recorded**, so a linked repo with none is still
  reachable by anyone holding the one global webhook secret. And one
  control is explicitly **not** repo-owned: `requireSparkleSignature` is dropped by
  `parseManifest` and defaults to true from operator state, so a repo can no longer disable the
  platform's check on the repo's own artifacts. What remains true is the shape of the boundary:
  whoever can merge to a linked repo can still rewrite that product's tiers and its OIDC issuer.
- **The IdP is trusted for `groups`, and `groups` is the entire admin authorization decision.**
  Unchanged, and still the shortest path to the admin plane that needs no secret at all.

## 4. Adversaries

| ID  | Adversary                             | Capability                                                                           | Motivation                                                              | Priority                           |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------- |
| T1  | **Unauthenticated internet attacker** | HTTP to `key.plrs.im`, can read public discovery/JWKS, can register nothing          | Control-plane takeover                                                  | **Highest**                        |
| T2  | **Release-channel attacker**          | Holds the webhook secret, or write access to a linked repo, or GitHub App compromise | Ship code to end users                                                  | **Highest**                        |
| T3  | **Malicious tenant / customer**       | Valid license, device token, portal account; possibly a product operator             | Cross-tenant data, tier escalation, extra seats                         | High                               |
| T4  | **License pirate**                    | Full control of their own machine, can patch binaries and edit files                 | Use software without paying                                             | Medium — bounded by §6             |
| T5  | **Malicious or compromised IdP**      | Controls claims presented to the Worker                                              | Privilege escalation via `groups`, identity confusion via `email`/`sub` | High                               |
| T6  | **Supply-chain attacker**             | Publishes a malicious dependency, or compromises a GitHub Action                     | Reach CI secrets and published artifacts                                | High                               |
| T7  | **Insider / compromised admin**       | Valid admin session, or a `pkeya_` token                                             | Anything the admin API permits — which for a session is everything      | High                               |
| T8  | **Network attacker**                  | On-path between client and `key.plrs.im`                                             | Downgrade, MITM                                                         | Low — see the transport note below |

**T8, stated precisely, because v1 got it wrong in both directions.** v1 said "no SDK enforces
HTTPS or pins certs". The first half is now false and the second half was always true, and the two
halves are about different things.

- **Transport is enforced.** All four SDKs refuse a base URL that is not `https:`, exempting only
  loopback hosts (`localhost`, `127.0.0.1`, `::1`) so `wrangler dev` and integration tests still
  work. It is enforced at construction, not at request time, so a misconfigured client fails
  immediately rather than leaking a bearer token once: `normalizeBaseUrl` in
  `packages/sdk-node/src/core/context.ts`, its ports in `sdks/python/src/polaris_key/core/context.py`
  and `sdks/swift/Sources/PolarisKeyCore/Endpoints.swift`, the same rule in `packages/cli/src/bundle.ts`,
  and — as of WP-16 — `normalizeBaseUrl` in `packages/sdk-react/src/browser/browserAdapter.ts`,
  which had been the one client that would happily carry a `SameSite`/`Secure` session cookie over
  plaintext.
- **TLS certificates are NOT pinned, by any SDK.** There is no `URLSessionDelegate` doing
  server-trust evaluation, no pinned CA bundle, no certificate-transparency requirement. A network
  attacker holding a certificate any platform trust store accepts — a mis-issued cert, an
  enterprise MITM appliance, a compromised CA — can read and rewrite the transport.

**Do not confuse the two kinds of pinning; conflating them is what produced v1's wrong row.** This
system pins **Ed25519 public keys** — the trust anchor, compiled into the host application, used to
verify a JWS. That is application-layer, it survives any transport, and it is why the paragraph
above is a bounded statement rather than a fatal one: a TLS MITM can suppress, delay or replay
documents, but it cannot forge one, because a forged document has no valid signature under a
pinned anchor. **TLS certificate pinning** is a transport-layer control over which X.509 chain is
acceptable, and this system does not implement it. Ed25519 pinning does not give you it, and the
two protect against different halves of the same attacker.

## 5. Semi-trusted inputs — the ones that decide authorization

These deserve their own section because each is treated as trusted somewhere in the code while
originating outside the trust boundary.

| Input                   | Trusted for                                                   | Actual origin        | Control                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC `groups`           | **Platform admin authority**                                  | The IdP              | Any IdP feature that lets a user influence group membership grants platform admin. A single claim string is the entire decision.          |
| OIDC `sub`              | License identity                                              | The IdP              | Admin and portal require it non-empty; the **product flow does not**, so an omitted `sub` converges distinct identities onto one license. |
| OIDC `email`            | Portal license linking, cross-product                         | The IdP              | Portal requires `email_verified`; the **product flow does not**, and admins may set `licenses.email` to any unverified string.            |
| `.pkey/` manifest       | Tiers, OIDC issuer, artifact policy, admin group, binary name | A linked GitHub repo | Applied on webhook-triggered resync. Bounded and replay-protected (§3), but the repo still writes most of its own security policy.        |
| `X-PKey-Version` header | Version and channel gating                                    | The client           | `0.0.0-dev` bypasses all of it.                                                                                                           |
| `X-PKey-Device` header  | Device identity                                               | The client           | Entirely client-asserted; not bound to the fingerprint.                                                                                   |
| Fingerprint components  | Seat/hardware binding                                         | The client           | Server recomputes the hwid (good), but checks it only at activation and never across devices.                                             |

The v1 row for **cached `trustedKeys`** is gone rather than corrected. It described a key source
that no longer exists: the cache is not consulted for keys at all, so there is nothing left to
grade as semi-trusted (see §3 and §6, property 2).

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

**Bounding the damage** is the achievable goal, and it rests on three properties. In v1 one of
them held. **All three now hold.**

1. ✅ **Secrets and minted tokens require a live server decision. Holds.** Unchanged from v1: a
   client cannot manufacture what the server did not choose to emit.

2. ✅ **A tampered cache cannot change which keys verify signatures. Now holds** (B7-01, closing
   R2-01 / R2-02 / R4-02). Four independent things enforce it, and it is worth naming all four
   because any one of them alone would be insufficient:
   - **Pins are terminal.** `mergeTrust` in `packages/client-core/src/trust.ts` is
     `mergeTrust(pinned, discovered) => ({ ...discovered, ...pinned })` — pins are the second
     spread, so a manifest key can never shadow one. v1 spread these the other way round, and
     that single transposition _was_ R2-01.
   - **Manifests verify against pins only.** `verifyTrustManifest` calls
     `verifyJws<TrustManifestDoc>(jws, opts.pinned, { typ: "pkey-trust+jws" })` — never against
     the effective set. That kills the self-perpetuation amplifier in which one planted key signs
     a manifest minting further keys.
   - **A pinned kid presented with different bytes rejects the WHOLE manifest** and keeps the
     previous trust set (`pinnedBytes !== key.publicKey ⇒ return REJECTED`). Not a skipped entry
     — a substitution attempt is fatal to the document that attempted it.
   - **The cache is not a key source.** It persists the manifest's compact JWS, never bare
     `kid → key` JSON, so a file write can neither add a kid nor swap the bytes behind one.

   Mirrored identically in `sdks/python/src/polaris_key/core/trust.py` and
   `sdks/swift/Sources/PolarisKeyCore/Trust.swift`, and pinned across all implementations by the
   conformance corpus (`trust-pinned-substitution`, `trust-pinned-kid-same-bytes`,
   `trust-signed-by-non-pinned-key`).

3. ✅ **A compromised signing key is revocable. Now holds** (B7-01 for the client half, B3-01 for
   the half that made it reach anyone). Three things, in the order they have to happen:
   - **The server emits revoked keys explicitly**, as a positive prune signal. `signTrustManifest`
     in `packages/worker/src/core/trust.ts` calls
     `loadPublicSigningKeys(db, slug, now - 2 * TRUST_CACHE_SECONDS)`, so a key revoked inside
     twice the cache window is still listed, carrying `status: "revoked"`. Twice the window is
     chosen so every client refreshing on schedule sees at least one manifest naming the revoked
     kid; older revocations age out and absence takes over.
   - **Clients prune on it.** `verifyTrustManifest` reads `key.status` and drops `revoked`
     entries, and the check is ordered _before_ the algorithm check so a revoked entry is pruned
     whatever else is wrong with it. The discovered set is then **replaced wholesale**, so a kid
     that simply disappears from a newer manifest is dropped too — absence is revocation, and the
     explicit signal is belt to that braces.
   - **And the manifest still verifies after a rotation.** This is B3-01 and it is what made the
     first two matter: the anchor signs the manifest, so a document-key rotation does not change
     the key a client checks the manifest against. Without it, the client-side pruning above
     would have been unreachable for exactly the installed population that a compromise reaches.

   Pinned by `trust-document-key-rotation-keeps-client-working` in the corpus.

**What properties 2 and 3 buy.** They are the difference between "piracy is bounded" and "one
compromise is permanent". A user who edits their own machine still defeats their own gate — that
is property 1's job to bound, and it does. What is no longer possible is for that same file write
to change whose signatures the client believes, or for a leaked key to stay believed forever.

## 7. Attack trees (abbreviated)

These are kept, and rewritten against the current tree, rather than deleted. **An attack tree with
no live path is still the map** — it records which branches are closed and by what, so that a
change which reopens one is legible as a regression rather than as a new feature. `DEAD` marks a
branch closed by a specific control; the control is named so it can be checked.

### AT-1 — Forge entitlements for every user of a product

```
Forge a signed config doc for product P
├── Obtain P's DOCUMENT signing key                                          ── LIVE
│   ├── Obtain a KEK from the ring ────────► Worker secret compromise (A1)
│   └── Obtain an admin session ───────────► AT-2
├── OR obtain P's ANCHOR key ──────────────► mint a manifest publishing a key you hold  ── LIVE
│                                            (the anchor is the ONLY manifest signer)
└── OR make the client trust a key you hold
    ├── Write the victim's cache ──────────► DEAD. Cache holds compact JWS only; a write
    │                                        can neither add a kid nor swap bytes (§6.2)
    ├── Present a pinned kid with new bytes ► DEAD. Whole manifest rejected, prior set kept
    ├── Sign a manifest with a manifest-learned key ► DEAD. Manifests verify against pins only
    └── ...and once trusted, trusted FOREVER ► DEAD. Revocation reaches clients (§6.3)
```

The live paths are exactly the two that require a platform secret or an admin credential. Every
client-side branch is closed, which is the whole of what B7-01 bought.

### AT-2 — Take the admin plane

```
Obtain admin authority
├── Be granted `groups` by the IdP ────────► LIVE. Still the entire decision, and needs no secret
├── Forge the session cookie ──────────────► needs ADMIN_SESSION_SECRET (A4)
├── Steal a `pkeya_` token (A10) ──────────► LIVE but BOUNDED: default-deny scoping means an
│                                            unnamed route is unreachable by token, and the
│                                            token routes are themselves unscoped
├── Plant your own session in an operator's browser (login CSRF)
│   └── DEAD. `__Host-pkey_flow` binds a flow to the browser that started it; the callback
│       demands a cookie hashing to the stored value, and `__Host-` is what an attacker
│       cannot write for this origin (core/oidcFlow.ts, all three realms)
├── XSS on the platform origin ────────────► statically generated HTML on this origin carries a
│                                            script-free CSP; the docs site's inline scripts are
│                                            hash-pinned, never `unsafe-inline`
└── Reach a gated surface through an ungated door
    └── PK-01 — DEAD, and it was live. `assemble-assets.mjs` copies the admin bundle to the
        assets ROOT and the docs build into `docs/` of that same root; the router claims
        `/manage/*` before the `/docs` reservation is consulted, and `serveAdminAsset` had no
        prefix confining it. `GET /manage/docs/index.html` therefore returned the
        platform-admin-gated docs site with NO session of any kind — a second, unauthenticated
        door onto a surface whose front door was correctly gated the whole time. The deploy
        smoke check probed `/docs/` and never `/manage/docs/`, so the gate verified green on
        every release while open. Closed by an ALLOW-list of the paths the admin bundle owns
        (`adminOwnsAsset`, packages/worker/src/admin/index.ts) — an allow-list rather than a
        `/docs` block-list, because a block-list is wrong again the moment anything else is
        assembled into that root.
```

The lesson PK-01 is kept here for is not "check `/manage/docs/`". It is that **two handlers
sharing one asset root is a trust-boundary crossing that neither handler's code shows you**, and
that a green smoke check for the front door says nothing about the side.

### AT-3 — Ship malicious code to every installed client

```
Poison the release channel
├── Hold GITHUB_WEBHOOK_SECRET ────────────► NARROWED, not closed
│   ├── forge a push payload naming ANY linked repo ► NARROWED. A product whose release
│   │   config records a `gh_installation_id` refuses a delivery that does not match it
│   │   (githubWebhook.ts). A product with none recorded is still reachable — one global
│   │   secret, no per-repo binding, exactly as in v1
│   ├── replay a captured delivery ──────► DEAD. `X-GitHub-Delivery` GUIDs are remembered for
│   │   7 days; a redelivery is dropped. This mattered because a resync rewrites tiers and
│   │   OIDC config, so replaying an old delivery reverted an operator's incident response
│   └── exhaust the worker with a huge body ► DEAD. 1 MiB cap checked BEFORE buffering; an
│       over-cap request is refused, never truncated-then-verified (that would be a forgery
│       oracle, not a size limit)
├── Write access to a linked repo ─────────► LIVE
│   ├── publish a DMG + matching .sig ────► signature is still passed through, not verified
│   │                                       server-side
│   └── set `.pkey/release` requireSparkleSignature:false ► DEAD. `parseManifest` DROPS the
│       field; it is operator state, defaulting to true. A repo can no longer disable the
│       platform's control over the repo's own artifacts
└── Anywhere upstream of install.sh ───────► NARROWED. The script fetches the published
    SHA-256 alongside the binary, refuses to install when no checksum is published, refuses
    when no SHA-256 tool is available, and aborts on mismatch. It is not a signature — a
    party who can rewrite the artifact can rewrite the checksum beside it — so this bounds
    corruption and a compromised mirror, not a compromised origin
```

### AT-4 — Rewrite a product's security policy through its manifest

New in v2, because §3 now names manifest ingest as its own control class and a class with no tree
is a class nobody checks.

```
Make the platform apply a policy of your choosing to product P
├── Merge to P's linked repo ──────────────► LIVE, and it is the intended mechanism
│   ├── rewrite tiers / entitlements ─────► LIVE
│   ├── rewrite the OIDC issuer ──────────► LIVE, and it redirects the product's sign-in
│   ├── rewrite the admin group ──────────► LIVE
│   └── disable requireSparkleSignature ──► DEAD (see AT-3)
├── Forge a resync without repo access ────► needs the webhook secret ⇒ AT-3
└── Make one oversized/looping manifest cost the platform ► DEAD. MAX_MANIFEST_BYTES and the
    webhook body cap bound the ingest before it is parsed
```

The honest summary is that this tree is _supposed_ to be mostly live: a product describing itself
is the design (AGENTS rule 5, "products are DATA"). What the model asks of a reader is that they
treat merge access to a linked repo as **equivalent to a scoped admin credential for that
product**, and provision it accordingly.

## 8. Out of scope for this model

Physical access to Cloudflare infrastructure; compromise of Cloudflare itself; compromise of the
IdP's own signing keys (we model malicious _claims_, not forged tokens); social engineering of the
operator; and denial of service originating from Cloudflare's own network controls.

## 9. Review triggers

Revisit this document when any of the following changes:

- a new tenant that is not first-party is onboarded;
- the portal gains write capability beyond device disconnect and key claim;
- a second release channel or artifact type is added;
- the admin authorization model changes — **including the `pkeya_` token surface**: a new entry in
  `ADMIN_API_SCOPES`, or a new arm in `scopeForRequest`, widens a credential that exists precisely
  because it is narrower than a session, and §2's A10 stops being true the moment the scope
  vocabulary stops being one word;
- **the trust-anchor key class changes** — anything that alters what signs a trust manifest, what
  clients pin, or the revocation window in `signTrustManifest`. §6's properties 2 and 3 are stated
  in terms of that one key class, and B3-01 is the demonstration that a change here can silently
  disable revocation for every installed client while every test and every server-side check still
  passes;
- the wire contract version increments;
- or any new field is added to `AdminSession` or `PortalSession` (see the domain-separation note in
  the audit report — the two realms share HMAC key material by default).
