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

| #   | Asset                                                             | Where it lives                                                  | Loss impact                                                                                                                |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A1  | **`PLATFORM_KEK`**                                                | Worker secret                                                   | Decrypts every tenant's signing key and every product secret. Total platform compromise. Cannot be rotated today (see A9). |
| A2  | **Per-product Ed25519 signing keys**                              | `product_keys.enc_private_json`, sealed under A1                | Forge any config doc, entitlement, or secret for that product. **Unrevocable for already-provisioned clients** — see §6.   |
| A3  | **The release channel**                                           | GitHub App key, webhook secret, `release_config`                | Ship arbitrary code to every installed client. Equal to A1 in practical severity.                                          |
| A4  | **`ADMIN_SESSION_SECRET`**                                        | Worker secret                                                   | Forge admin sessions → reach A2, A3, A5, A6 through the API.                                                               |
| A5  | **Product secrets** (OIDC client secrets, edge-mint signing keys) | `product_secrets`, sealed under A1                              | Impersonate the product to its IdP; mint third-party tokens (e.g. Apple MusicKit) at the operator's cost.                  |
| A6  | **Customer PII**                                                  | `licenses`, `customers`, `portal_accounts`, `audit` — plaintext | Email, name, OIDC subject, device user-agents, hardware-derived digests. Regulatory and reputational.                      |
| A7  | **Licensing revenue**                                             | The whole enforcement path                                      | The thing the system nominally exists to protect. Deliberately ranked _below_ A1–A5.                                       |
| A8  | **Service availability**                                          | Worker, D1, KV, DO                                              | A licensing outage can block paying customers from software they already bought.                                           |
| A9  | **The ability to recover**                                        | Rotation and revocation machinery                               | Not an asset in the usual sense, but its absence converts any A1/A2 loss from an incident into a permanent condition.      |

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
 browser (admin/portal)►│    └── ASSETS (SPA bundles)               │
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
  to the two product settings that decide who can hold the device token the mint accepts, because
  a push can change both without touching the recipe. (a) Whether the mint is public: the
  open-registration acknowledgement is stored on the approval and re-checked on every mint, so a
  push that makes the mint public — declaring `devices.registration: open`, turning License off
  so the derived policy is open, enabling anonymous `autoIssue` enrolment (which hands any caller
  a licence and a device token while registration still reads `requires-license`), or turning on
  an OIDC default tier with Identity on (every account the IdP signs in gets a licence) — makes
  an approval given without it stop matching. (b) The sign-in trust: on a closed product, signing
  in is the other route to a device token, and the manifest writes the OIDC provider, issuer,
  client id and `groupRoleMap` that decide who a sign-in licenses. The approval records them (and
  whether Identity was on); while Identity is on, any change makes it stop matching, so a push
  that aims sign-in at an issuer or client the pusher controls, or maps their group onto a tier,
  does not reach the mint. The upgrade backfill records the acknowledgement only for recipes that
  were already public mints at deploy, and the sign-in trust as deployed. **Residual:** an
  approval trusts the identity provider itself — anyone that IdP signs in with a mapped group
  (including accounts its administrator adds later) is covered, which is the IdP weakness below,
  not something the approval can close.
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
| `.pkey/` manifest               | Tiers, OIDC issuer, artifact policy, admin group, binary name             | A linked GitHub repo | Applied on webhook-triggered resync. The repo effectively writes its own security policy — except edge-mint recipes, which are inert until an operator approves them column for column and sign only with an operator-marked `edge-mint` secret.                                                                                                                                         |
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
   acknowledgement that the token is publicly mintable. While Identity is on, it matches only if
   the OIDC provider, issuer, client id and group map are the ones it recorded. Both are checked
   on every mint, not only when approving, so the mint becoming public, or sign-in trusting a
   different IdP or group map, after an approval (by push or by operator) makes the recipe `404`
   until it is re-approved. What an approval cannot bound is the IdP it trusts: whoever that IdP
   signs in with a mapped group is covered (§3). The only approvals not given by an operator are
   the upgrade backfill's (approved by `migration`), which carry the acknowledgement only where
   the recipe was already a public mint before the upgrade, and the sign-in trust as deployed.
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
release channel or artifact type is added; the admin authorization model changes; the wire contract
version increments; any new field is added to `AdminSession` or `PortalSession` (see the
domain-separation note in the audit report — the two realms share HMAC key material by default);
a new product-secret usage or sealed kind is introduced (it must say which paths may open it,
and that no manifest can grant it); or a new way to obtain a device token or licence without an
operator-issued key is added (it must be folded into `mintIsPublic` or into the edge-mint
approval's recorded trust, in `services/config/mint.ts` and the `0025_b` backfill).
