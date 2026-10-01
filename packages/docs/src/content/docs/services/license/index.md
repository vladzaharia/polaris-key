---
title: "License"
description: "The service that decides who gets a seat: licenses, keys, tiers, activation, enrollment, and the signed license document."
sidebar:
  order: 1
---

License is one of the six opt-in services over Core. It answers exactly one question, from
several distances: **on what terms does this machine get a seat, and what does that seat
grant?**

Everything else it owns follows from that. A **key** is the credential that redeems a seat. A
**tier** is the named plan that shapes one. A **license** is the account the seat hangs off. The
**license document** is the signed statement of what the seat grants, handed to the client so it
can enforce the answer offline. And the fingerprint and auto-issue **policies** decide whether an
unrecognised machine may take a seat at all.

A product that does not enable License has none of this — no activation, no keys, no license
document — and boots `not-applicable` rather than `needs-activation`. See
[Core](/docs/services/core/) for the device principal, which exists either way.

## The pages in this section

| Page                                                 | What it covers                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Model](/docs/services/license/model/)               | The nouns: license, key, device, tier, profile, entitlement. Origins, the status lifecycle, seat pools, and where `deviceLimit` comes from. |
| [Activation](/docs/services/license/activation/)     | `POST /<product>/license/activate` key redemption, the authorization pipeline in order, token rotation, self-deauthorize.                   |
| [Enrollment](/docs/services/license/enrollment/)     | The keyless auto-issue path, one-license-per-machine dedupe, and the claim/migrate merge on later sign-in.                                  |
| [License document](/docs/services/license/document/) | The `pkey-license+jws` envelope, the entitlement map, the content-only ETag, and the build gate that lives on this route.                   |
| [Policy](/docs/services/license/policy/)             | Fingerprint and auto-issue policy: manifest blocks, live admin edits, ownership and revert.                                                 |
| [Re-licensing](/docs/services/license/relicensing/)  | Changing a tier and having running clients notice, without a push channel.                                                                  |

## The public surface

Five routes, all under `/<product>/license`. The full generated table — with methods, summaries,
and every other service's routes — is at [Public route
table](/docs/reference/routes/).

| Route                                 | Purpose                                                    |
| ------------------------------------- | ---------------------------------------------------------- |
| `POST /<product>/license/activate`    | Redeem a `pkey_…` key for a per-device `pkeyt_` token.     |
| `POST /<product>/license/enroll`      | Keyless auto-issue, when the product's policy opens it.    |
| `POST /<product>/license/token`       | Rotate or re-acquire an already-authorized device's token. |
| `POST /<product>/license/deauthorize` | Self-deauthorize the bearer token's own device.            |
| `GET /<product>/license/document`     | The signed license document, and the build gate.           |

All five appear in the product's discovery document at
`/<product>/.well-known/polaris.json`, under `services.license.endpoints`, keyed
`activate` · `enroll` · `token` · `deauthorize` · `document`. A product that has License
disabled contributes `enabled: false` and no endpoints at all — a disabled service's routes
cannot be read out of a public document, and they 404 identically to an unregistered slug and a
bad path.

## The admin surface

Three resources under `/manage/api/products/<slug>/license`:

- `licenses` — list, create (which mints the first key, returned exactly once), detail, patch,
  enable/disable, catalog-validated override batches, and the `keys` and `devices`
  sub-resources.
- `tiers` — list, create, patch, delete. Delete is refused with `409` while any license still
  references the tier.
- `policy` — the fingerprint and auto-issue policies, plus `policy/revert`.

The pre-suite spellings of these paths are gone rather than aliased. Session, CSRF, rate
limiting and the platform-admin gate all run in Core before any License handler is reached.

## What License owns, and what it borrows

License logically owns four D1 tables — `licenses`, `keys_index`, `tiers`, `license_profiles`
(see [D1 data model](/docs/reference/data-model/)). Ownership is logical: the tables live in one
database, and a service may only reach another's rows through a Core-mediated seam. A boundary
test enforces that no service imports a sibling.

Two computations that read like License's live in Core instead, and the reason is the same in
both cases — Identity performs them too:

- **The seat decision** (`core/authz.ts`). `POST /<product>/identity/session/license` and the
  whole OIDC sign-in path authorize a device and mint a token exactly as activation does. A
  duplicated seat check is how two services end up admitting a different number of machines to
  one license, so the computation lives once in Core and both bind to it.
- **The build gate** (`core/gate.ts`). Wire contract v3 §5 names two enforcement points for
  channel and version blocking: this service's document route, and identity's
  `GET /<product>/identity/session`. They must refuse exactly the same builds.

`services/license/authz.ts` and `services/license/gate.ts` are re-export shims that define
nothing — a second definition of either is precisely the divergence the move exists to prevent.

Devices are **Core's** principal, not License's. A device row, its `pkeyt_` token, its
fingerprint, its facts, and the `GET/PATCH/DELETE /<product>/devices` self-service surface all
belong to Core and exist for products that never enable License. What License contributes is the
seat: which license granted this machine a place, and how many places there are.

## The two ways a license comes to exist

There are three [origins](/docs/services/license/model/#origins), reached by two mint paths and
one operator action:

- **An operator creates one.** The console mints the license and its first key together, and the
  raw key is shown exactly once. The user redeems it at
  [activation](/docs/services/license/activation/). Origin `admin`.
- **A user signs in.** [Identity](/docs/services/identity/) maps the IdP's groups onto a tier and
  mints a license for the subject, idempotently. Origin `oidc`.
- **A machine enrolls.** If the product opens the keyless path, the first run of the app
  auto-issues a license bound to that machine, with no key and no sign-in. Origin `enroll`. See
  [Enrollment](/docs/services/license/enrollment/).

The three converge: whatever minted it, the license is an ordinary row, and every downstream
behaviour — seat limits, fingerprint drift, re-licensing, the build gate — applies identically.
Identity can _merge_ an enrolled license into a signed-in identity rather than abandon it (see
[claim and migrate](/docs/services/license/enrollment/#claim-and-migrate)). No sign-in route
triggers that merge today: a device-code sign-in is confirmed with a public user code, so it
leaves the device's enrolled license untouched.

## How a client uses it

The shape every SDK follows, in order:

1. **Obtain a token.** Redeem a key at `/license/activate`, or take the keyless path at
   `/license/enroll` if the product opens it. Both return the same body — `token`,
   `schemaVersion`, `device`, `license` — so an SDK reuses one activation result type for both.
2. **Fetch the document.** `GET /license/document` with the `pkeyt_` token, honouring
   `ETag` / `If-None-Match`.
3. **Derive status locally.** The document carries grants, never state. The client's gate turns
   the verified document, the clock, and two unsigned local hints into one of `ok`, `grace`,
   `expired`, `revoked`, `needs-activation`, `version-too-old`, `version-too-new`,
   `channel-not-entitled`, or `not-applicable`.
4. **Re-acquire on 401.** Exactly one `POST /license/token` attempt, then one retry of the
   failed fetch.

A product may also run [Config](/docs/services/config/) alongside, in which case the client
fetches a second, independently-tagged document from `GET /<product>/config/document`. The two
documents are per-service by construction: a config edit does not force a license re-download,
and a product may take either without the other.

:::note[Terminology]
This section uses the vocabulary in [Concepts & terminology](/docs/start/concepts/), which wins
over code when the two disagree. In particular: **device** (never "machine slot" or "install"), **tier** (never
"plan"), **enrollment** (keyless auto-issue) as distinct from **activation** (redeeming a key),
and **entitlement** for anything delivered as a grant.
:::

## Where the guarantees are pinned

Prose is not the contract. Three places are:

- `docs/security/WIRE-CONTRACT-V3.md` — normative for everything that crosses the wire: the
  envelope (§2), the license document (§2.1), claim validation and grace (§3), gate placement
  (§5), the device principal (§6).
- The conformance corpus — pins the fingerprint formulas and the client gate matrix byte-for-byte
  across the worker and every SDK.
- The worker's test suite — `test/relicense.test.ts`, `test/enroll.test.ts` and
  `test/fingerprintPolicy.test.ts` pin the behaviours these pages describe. Each page cites the
  specific cases that hold it up.
