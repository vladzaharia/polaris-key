---
title: "The service model"
description: "services_json as the single enablement authority: how the manifest feeds it, who owns it, the four surfaces that project from it, and the rules it is validated against."
sidebar:
  order: 3
---

Polaris Key is six opt-in services over an always-on Core. "Which services does this product
run?" therefore has to have exactly one answer, in exactly one place, or the surfaces that depend
on it drift: before this existed, four different surfaces each re-derived enablement from the
presence of some child row, which is how the discovery document could advertise a service whose
routes returned `404`.

The one place is a single column, **`products.services_json`**.

## The column

`services_json` records the enablement set and — because its default is a function of that same
set — the product's declared device registration policy:

```json
{
  "license": { "enabled": true },
  "config": { "enabled": true },
  "release": { "enabled": false },
  "distribution": { "enabled": false },
  "update": { "enabled": false },
  "identity": { "enabled": false },
  "registration": "open"
}
```

Every slug is written with an explicit boolean, in canonical order, and `registration` is written
**last and only when declared**. Storing it as absent rather than resolved is the point: undeclared
means "follow the services", which is a different fact from "somebody chose `open`".

The parser is strict _and_ fail-safe, and the two are not in tension. The column is a TEXT blob
read on every product-scoped request, and its content could be a stale row, a hand-edit in the D1
console, or the output of a future writer this build has never seen. So:

- Anything structurally wrong — not JSON, not an object, an array, a non-object entry, an `enabled` that is not a boolean, a `registration` outside the three
  policies — **discards the whole record** and reads as the defaults. Never a partial merge:
  half-honouring a typo is how it turns into a silently disabled service. One rule for the whole
  blob, including `registration` — a second, softer tolerance for one key inside the same value
  is exactly the inconsistency that gets misremembered later.
- An unrecognised slug whose value is a well-formed `{ "enabled": boolean }` is a service a newer
  build wrote. It never affects enablement or registration, and it is carried through and written
  back unchanged (sorted by key, after the known slugs), so rolling a worker back past the release
  that introduced a slug neither resets the slugs it knows nor deletes the one it does not. A
  malformed unrecognised value still discards the whole record.
- A well-formed record that simply omits a slug gets that slug's default.
- It never throws. Hostile database content must not be able to `500` a request.

The **defaults are `license` + `config` on, the rest off** — not all-disabled. This parser sits in
front of the routes every existing product already serves, so the safe direction is "behave
exactly as this product behaved before the column existed". Note what the defaults then derive for
registration: License defaults on, so an unreadable record lands on `requires-license`, the closed
policy that was the only behaviour before any of this existed.

## Where the value comes from: the manifest

The manifest half of the authority is `.pkey/product`'s `modules` block. It used to be validated
and then thrown away; it is now carried through the parsed manifest and persisted verbatim.

```yaml
# .pkey/product.yaml
modules:
  license: { enabled: true }
  config: { enabled: true }
  release: { enabled: true }
  distribution: { enabled: true }
  update: { enabled: true }
```

Three rules govern how that block is read:

- **Only literal `true` counts.** A key present with `enabled` anything else is off.
- **Unknown module names are ignored**, not fatal. A `modules` block is a declaration of intent,
  and a name this build does not know is not a reason to refuse the whole product.
- **No block — or a block where nothing is `enabled: true`** — yields the defaults, `license` +
  `config`. This is the trap worth knowing: writing every entry as `"enabled": false` does not
  produce a product with no services, it produces the default pair. To run a single service, name
  that one service as `true` and leave the others out.

### Both vocabularies parse

The pre-suite module names still validate. They are translated to service slugs at ingest and
**only slugs are stored**, so no manifest in the field has to be rewritten on the day the server
learns the new words, and one block may mix the two spellings.

| Declared    | Enables                                       | Why                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `licensing` | `license`                                     | a rename                                                                                                                                                                                                                        |
| `config`    | `config`                                      | unchanged                                                                                                                                                                                                                       |
| `releases`  | `release` **+** `distribution` **+** `update` | the old module meant "this product distributes software", which the suite splits into the truth store, delivery, and the feed; mapping it to `release` alone would take the appcast away from every product already serving one |
| `oidc`      | `identity`                                    | a rename, not a change of meaning                                                                                                                                                                                               |
| `edgeMint`  | `config`                                      | edge-minting is a secret-**delivery** capability of Config, not a unit of its own, so declaring it turns Config on                                                                                                              |

Because `releases` brings the whole chain with it by construction, a legacy manifest can never
trip `distribution_requires_release` or `update_requires_distribution` below. A manifest that names
the slugs `release` and `update` directly, without `distribution`, does trip the second one: add
`distribution: { enabled: true }`. (Migration `0033` turned Distribution on for every stored
product that had Release on, so such a product keeps serving until its manifest is fixed.)

## Who owns the column: `services_source`

`products.services_source` is `manifest` or `admin`, and it is the same machinery as
`fingerprint_policy_source`, `auto_issue_source`, `compat_source` (the compatibility window) and
`release_config.access_source` (the metadata access mode, claimed and reverted from
[Update → Feed](/docs/services/update/eligibility/#the-console-feed)):

- A **resync writes only while the column is `manifest`-owned**, and the guard is the `UPDATE`'s
  own `WHERE … = 'manifest'` predicate rather than a read-then-write in the caller. A push cannot
  quietly undo a 3am toggle.
- A live edit — `PATCH /manage/api/products/<slug>/services` — **claims the column for `admin`**.
  From then on a `.pkey/` push no longer rewrites it, so an operator cannot have a service turned
  back on, or registration re-opened, behind their back.
- `POST /manage/api/products/<slug>/services/revert` **hands ownership back to `manifest` and does
  nothing else.** The live values stay exactly where the operator left them until the next resync
  re-applies the manifest. Reverting by immediately re-reading the repo would make the operator's
  escape hatch depend on a GitHub round trip that can fail.

## The four projections

Every surface that answers "is this service on?" reads that one column and infers nothing.

**1. Route mounting.** Core checks the flag **before** consulting the service descriptor, so a
disabled service's code never runs: it cannot read a row, write an audit entry, spend a rate-limit
token, or make a timing difference. Disabled, unregistered, and no-such-route return one identical
`404`, because telling them apart is the reconnaissance being refused.

**2. The discovery document.** `/<product>/.well-known/polaris.json` carries a `services` object
keyed by the six slugs. An enabled service contributes its own fragment — its endpoints and its
capability answers; a disabled one is `{"enabled": false}` and nothing else, so a disabled
service's endpoints cannot be read out of a public document. This is also the SDK's
capability-negotiation source, and it is fail-closed: a discovery document loaded this session
wins, else the app's configured `expectedServices`, else the suite default — never all-true.

**3. The console nav.** One projection (`serviceStateOf`) stamps `services`, `registration`,
`effectiveRegistration` and `servicesSource` onto the row the console shell already loads, and the
same projection serves `GET /manage/api/products/<slug>/services`. The shell needs the answer
before it can decide which nav sections exist at all, so the nav is drawn from enablement rather
than appearing after the page it frames. See
[Service enablement in the console](/docs/admin/services-enablement/).

**4. Portal capabilities.** `/api/capabilities` and the portal's release listing **conjoin** the
per-product portal toggles with `services_json`. Gating only the capability would hide the nav
item while leaving the endpoint enumerating a non-Release product's releases to anyone who
deep-links it — the nav is a courtesy, the listing is the disclosure, so the flag has to bind both
or it binds neither.

## Coherence rules

An enablement set is validated **as a set**, not flag by flag: every one of these faults is a
_relationship_ between two toggles, so no single flag can be blamed for it. Validation returns
stable error **codes**, not prose, so the admin API, the console and the manifest validator can
each render them their own way.

| Code                             | The fault                                                            | Why it is refused                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `distribution_requires_release`  | Distribution on, Release off                                         | Distribution delivers what Release says exists; with Release off there is nothing to deliver.                                                          |
| `update_requires_distribution`   | Update on, Distribution off                                          | Update's feed tells a device what to do next over what Distribution delivered. It would answer every client with an empty document — a silent failure. |
| `registration_requires_identity` | a declared `requires-identity` policy with Identity off              | there is no login to stand behind, so the endpoint could never say yes to anyone; the product has taken registration away rather than restricted it.   |
| `config_without_activation`      | Config on, License off, **and** a declared `requires-license` policy | that closes the only mint path such a product has, leaving the service enabled and unreachable.                                                        |

The rules are not all enforced in the same place, and the difference matters when you are
debugging a manifest that pushed cleanly but behaves oddly:

- **Manifest ingest** refuses `distribution_requires_release` and `update_requires_distribution`
  as errors, refuses an unrecognised
  `devices.registration` outright (`invalid_registration_policy`) rather than coercing it, and
  **warns** on the softer form of `config_without_activation` — Config on with neither License nor
  Identity. That stays a warning on purpose: a config-only product issuing config documents to
  registered devices is the wire-level proof that the services are independent, not a mistake.
- **The enablement API** (`PATCH …/services`) applies all four as hard errors, including
  `registration_requires_identity`, which manifest ingest does not check at all.

That gap is why the runtime registration check is load-bearing rather than a redundant second
opinion: a repo-authored `requires-identity` policy on an identity-disabled product reaches the
database, and the only thing standing between it and a minted device token is Core re-asking the
Identity descriptor at request time — a question that fails closed at every step.

The chain **Release ← Distribution ← Update** replaced the single `update_requires_release` rule,
which the two edges together imply (Distribution itself requires Release). That code is retired
and is never emitted.

## Services read one another through Core

A service may import only Core and itself; `update → release` is the one historical exception,
enforced by `boundaries.test.ts`. Everything else crosses through **descriptor hooks** that Core
declares (`core/hooks.ts`) and the providing service implements — the pattern the registration
predicate below set:

| Hook                 | Provided by  | What it answers                                                                 |
| -------------------- | ------------ | ------------------------------------------------------------------------------- |
| `releaseCatalog`     | Release      | deliverables, releases, builds, artifact records, channel policy, yanks         |
| `delivery`           | Distribution | the default transport (`pkey-cdn`) and availability; later rollouts and URLs    |
| `outletCapabilities` | Distribution | what one outlet permits (`null` for every outlet until outlets can be declared) |
| `licenseProvenance`  | License      | where each licence came from: its store grants, or the origin that minted it    |

Core builds the hooks for each request from the registry and the product's `services_json`, and
every accessor **fails closed**: while the providing service is off it returns `null` and the
provider's code never runs. Hooks are read-only — a cross-service write would be an import in
disguise.

## Registration policy and its derived default

`devices.registration` decides who may mint a device token at
`POST /<product>/devices/register` — a **Core** route that exists under every policy, because a
device is substrate, not a licensing concept.

| Policy              | Behaviour                                                                        |
| ------------------- | -------------------------------------------------------------------------------- |
| `open`              | mint for any caller; rate-limited by edge IP, fingerprint optional               |
| `requires-identity` | the same endpoint, but only for a caller carrying a live product browser session |
| `requires-license`  | refuse permanently; activation and enrollment are the only mint paths            |

Every refusal is the same `403 registration_closed`. A caller learns that it may not register and
nothing about why — distinguishing the policies, or an expired session from an absent one, would
let a prober map which products run which services.

Core cannot answer "is a human signed in to this product", so for `requires-identity` it asks the
Identity descriptor through a **narrow predicate** rather than importing the service. The contract
is a yes/no; everything about what a refusal looks like stays Core's.

The policy is optional, and undeclared means "follow the services":

```
requires-license  if License is enabled
requires-identity else, if Identity is enabled
open              otherwise
```

The order is by how much the product already knows about the caller. A licensed product already
has a mint path, so keyless registration stays shut; an identity product can authenticate a human,
so registration is possible but must go through that; a product with neither has nobody to ask and
nothing to protect a seat pool with, so registration is open — rate-limited, never a free-for-all.

Because undeclared is stored as absent, **a product that later turns License off moves to the
derived `open`** instead of staying pinned to a value nobody wrote. That is the whole reason the
policy lives inside `services_json` rather than in a column of its own: reading a policy from one
place while deriving its default from another is how the two drift.

## Related

- [Concepts & terminology](/docs/start/concepts/) — the canonical definitions.
- [Architecture](/docs/start/architecture/) — how enablement is enforced at dispatch.
- [Quickstart by goal](/docs/start/quickstart/) — the smallest manifest for each service mix.
- [Authoring the manifest](/docs/build/manifest/) — the full `.pkey/` reference.
- [Core](/docs/services/core/) — the device principal and the registration route itself.
