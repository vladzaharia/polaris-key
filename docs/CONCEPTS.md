# Polaris Key — concepts & canonical terminology

This is the source of truth for the vocabulary used across the Worker, the SDKs, the admin
panel, and the docs. When code and this glossary disagree, this glossary wins — open a PR to
reconcile. Consistent names are a feature: they make the system learnable across five languages.

## Core nouns

- **product** — one tenant of Polaris Key, addressed by its `slug` (e.g. `djdl`). Every D1 row,
  KV key, signature, and admin route is product-scoped. (Not "app" or "gateway".)
- **license** — an account that holds entitlements. Created manually by an admin or minted on
  OIDC sign-in. Has a status, optional tier/profile, optional expiry, and per-license overrides.
- **key** — a `pkey_<product>_…` activation secret a user redeems to enroll a device. Shown to the
  user exactly once; stored only as a (peppered) hash.
- **device** — an authorized install of the product, bound to a per-device bearer token
  (`pkeyt_…`). In the data layer the table is still named `machines` for historical reasons;
  new code, APIs, and UI say **device**.
- **tier** — a named plan: an optional profile plus policy (default expiry, device limit, and —
  from the channels work — default upgrade channels and version window). (Not "plan".)
- **profile** — a reusable managed-payload baseline that a tier or license can attach.
- **entitlement** — a capability flag or value delivered to the client (the `flag` config kind),
  e.g. `polarisVpn`, `channels`, `app.minVersion`.

## Config model

- **config / secret / flag** — the three `ConfigKind`s of a catalog entry. `config` → plaintext
  client setting; `secret` → redacted, delivered to the OS keyring; `flag` → an entitlement.
- **management state** — per-value enforcement, one of:
  - **default** — the server suggests a value; the client (user/local override or environment)
    may override it.
  - **enforced** — the server value wins and the client cannot override it (shown read-only).
  - **hidden** — `enforced` **and** withheld from user-facing enumeration (still applied
    internally).
    > The legacy states `unmanaged` / `managed` / `hidden` map to `default` / `enforced` / `hidden`.
- **scope** — where a catalog key is meaningful (the `UiHints.scopes` field): one or more of
  `profile`, `license`, `device`. (Renamed from the old `UiHints.tiers`.)
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
