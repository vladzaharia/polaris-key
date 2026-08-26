# Polaris Key — concepts & canonical terminology

This is the source of truth for the vocabulary used across the Worker, the SDKs, the admin
panel, and the docs. When code and this glossary disagree, this glossary wins — open a PR to
reconcile. Consistent names are a feature: they make the system learnable across five languages.

## Core nouns

- **product** — one tenant of Polaris Key, addressed by its `slug` (e.g. `djdl`). Every D1 row,
  KV key, signature, and admin route is product-scoped. (Not "app" or "gateway".)
- **license** — an account that holds entitlements. Created manually by an admin or minted on
  OIDC sign-in. Has a status, optional tier/profile, optional expiry, and per-license overrides.
- **key** — a `pkey_<product>_…` activation secret a user redeems to activate a device. Shown to the
  user exactly once; stored only as a (peppered) hash.
- **device** — an authorized install of the product, bound to a per-device bearer token
  (`pkeyt_…`). The data layer, APIs, SDKs, docs, and UI all use **device**.
- **tier** — a named plan: an optional profile plus policy (default expiry, device limit, and —
  from the channels work — default upgrade channels and version window). (Not "plan".)
- **profile** — a reusable managed-payload baseline that a tier or license can attach.
- **entitlement** — a capability flag or value delivered to the client (the `flag` config kind),
  e.g. `polarisVpn`, `channels`, `app.minVersion`.
- **enrollment** — a keyless activation that auto-issues a license under a product's auto-issue
  policy. Distinct from **activation**, which redeems a `pkey_…` key.
- **origin** — how a license came into existence: `admin` (an operator created it), `oidc`
  (minted on sign-in), or `enroll` (auto-issued, keyless, bound to a machine).
- **auto-issue policy** — a product's opt-in to issuing licenses without a credential. Names
  the tier, and a **mode**: `anonymous` (opens `POST /<product>/enroll`), `oidcDefault` (an
  authenticated user matching no IdP group lands on that tier instead of a 403), or `both`.
  Off unless a product opts in; a policy naming no tier counts as off.
- **claim / migrate** — the two merge outcomes when a signed-in identity meets an auto-issued
  license. _Claim_: the identity is attached to the same row, so devices and local state
  survive. _Migrate_: the identity already had a license, so the enrolled row's devices move
  onto it and the enrolled row is retired.
- **re-licensing** — changing a license's `tier_id`. Running clients pick up the new
  entitlements on their next config refresh; nothing is pushed. A downgrade below the active
  device count **grandfathers** existing devices and refuses new activations until the count
  drops.

## Device identity

- **fingerprint** — the set of per-component hashes a device reports about its hardware. Raw
  hardware values are hashed on-device and never transmitted.
- **component** — one hashed hardware signal within a fingerprint: `machineUuid` (the
  **anchor**), `boardSerial`, `cpuModel`, `primaryMac`, `bootVolumeUuid`, `ramBucket`,
  `machineModel`. A component that cannot be read is omitted, never substituted.
- **hwid** — the composite hash over a device's present components, in canonical order; the
  coarse dedupe key. The server always recomputes it and never trusts the client's copy.
- **drift** — how many components differ between a device's stored and presented fingerprint.
  A component that was stored and is now missing or different counts as drift; a _newly_
  reported one does not, so an SDK upgrade that learns to read more components is free.
- **fingerprint mode** — per-tier enforcement strength, falling back to the product default:
  `off` (collect, never enforce) · `lenient` (4) · `normal` (2, the default) · `strict` (0, and
  a fingerprint becomes mandatory). A matching anchor widens a non-zero tolerance by one.
- **device facts** — a device's current software snapshot: OS, runtime, hardware summary, and
  probe results. Overwritten on each report; no history is kept.
- **probe** — a product-declared check for a companion application, answered by the client as
  present/absent plus an optional version. There is no full installed-application enumeration.

Note that **profile** is already taken twice — the reusable managed-payload baseline above, and
`DocProfile` in the signed payload. Do not overload it a third time for device data.

## Config model

- **config / secret / flag** — the three `ConfigKind`s of a catalog entry. `config` → plaintext
  client setting; `secret` → redacted, delivered to the OS keyring; `flag` → an entitlement.
- **management state** — per-value enforcement, one of:
  - **default** — the server suggests a value; the client (user/local override or environment)
    may override it.
  - **enforced** — the server value wins and the client cannot override it (shown read-only).
  - **hidden** — `enforced` **and** withheld from user-facing enumeration (still applied
    internally).
- **scope** — where a catalog key is meaningful (the `UiHints.scopes` field): one or more of
  `profile`, `license`, `device`.
- **manifest** — the `.pkey/` files in a product's repo that describe it: `schema` (the config
  catalog), `product` (metadata + OIDC + tiers + provisioning), and `release` (release config +
  minters), each in JSON or YAML.

## Layering & precedence

Effective managed config is computed server-side by merging payload layers
`tier(profile) → license(profile) → license overrides → device overrides` (later layers win;
this is legitimate admin authority). On the **client**, a value's source is resolved as:

```
enforced | hidden (remote)  >  user/local override  >  environment  >  remote default  >  schema default
```

So an `enforced`/`hidden` value always comes from the server; a `default` value can be overridden
locally or by environment variables.

## Trust & keys

- **signing key** — a per-product Ed25519 keypair. The private key is envelope-encrypted at rest
  in D1 under the platform **KEK** (a single Worker secret) and never leaves the Worker. The
  public key is served at `/<product>/.well-known/jwks.json` and pinned by SDKs.
- **edge-mint / minter** — a per-product recipe that mints a short-lived third-party token
  (e.g. an Apple MusicKit developer token); described by `alg`, claims template, key, and audience.
