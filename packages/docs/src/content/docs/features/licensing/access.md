---
title: "Enrollment"
description: "Keyless auto-issue: the policy that opens it, one license per machine, the 404 contract, and the claim/migrate merge on sign-in."
sidebar:
  order: 4
---

A product that mainly wants signed settings delivery should not have to gate every install
behind a license key or a sign-in. **Enrollment** is the keyless path: the server auto-issues a
license bound to the machine, authorizes the device, and hands back the same body
[activation](/docs/services/license/activation/) returns.

Enrollment is distinct from activation. Activation _redeems_ a `pkey_…` key; enrollment
_creates_ the license it then authorizes against.

## `POST /<product>/license/enroll`

```http
POST /djdl/license/enroll
X-PKey-Device: 7Yb2Qh8sK1nR4tV9wX3zA6cD0eF5gH7j
Content-Type: application/json

{ "fingerprint": { "components": { "machineUuid": "…", "boardSerial": "…" } } }
```

No `Authorization` header — that is the point. The response is byte-compatible with
`/license/activate`: `token`, `schemaVersion`, `device`, `license`.

## The auto-issue policy

Enrollment exists only for products that opt in. The policy lives in `products.auto_issue_json`
and has four fields:

| Field              | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `enabled`          | The opt-in. Off by default — issuing licenses is never a silent default. |
| `tierId`           | The tier an auto-issued license lands on. Required.                      |
| `mode`             | `anonymous`, `oidcDefault`, or `both`.                                   |
| `rateLimitPerHour` | Per-IP enrollment ceiling. `0` disables the limit. Defaults to 10.       |

The three modes open different doors:

- **`anonymous`** opens `POST /<product>/license/enroll` — this page.
- **`oidcDefault`** does not open the route at all. It makes an _authenticated_ user who matches
  no IdP group land on the named tier instead of a hard refusal. That path belongs to
  [Identity](/docs/services/identity/).
- **`both`** opens both.

The parser is fail-closed in a specific way that matters: `enabled: true` **with no `tierId`** is
read as _disabled_, because a policy naming no tier cannot issue anything coherent. Unparseable
JSON is likewise read as off. (The fingerprint policy takes the opposite fallback — see
[Policy](/docs/services/license/policy/) for why the asymmetry is right.)

## The request pipeline

1. **Method.** Not `POST` is `405`.
2. **Policy gate.** `404 enroll_disabled` unless the policy is enabled, its mode includes
   `anonymous`, and it names a tier.
3. **Rate limit.** Bucket `enroll`, `rateLimitPerHour` per hour keyed by client network, skipped
   entirely when the ceiling is `0`. Over the limit is `429 rate_limited`. Fail-closed.
4. **Device header.** Absent is `400 bad_request`.
5. **Tier existence.** The tier the policy names is loaded. If it is gone, `404 enroll_disabled`
   — fail closed rather than issuing a license whose entitlements nobody configured.
6. **Fingerprint.** Required; see below.
7. **Locate or mint** the machine's license.
8. **Authorize the device** through the same `authorizeDevice` pipeline activation uses, with
   the same error mapping — the two surfaces report identical codes for identical causes.

### The 404 contract

:::caution[A 404 here means enroll is disabled, not no-such-product]
Every way this route can be closed answers the **same** `404` with code `enroll_disabled`: the
product never opted in, the policy names a tier that no longer exists, or the policy names no
tier at all. A `403` would advertise that the route exists on this product; a `404` does not.

SDKs are expected to treat a `404` from `/license/enroll` as "this product does not offer keyless
enrollment" and fall back to whatever activation path they were given, **not** as a transport
error to retry.
:::

`test/enroll.test.ts` pins all three closures to `404`, and the first of them to the
`enroll_disabled` code specifically.

## A fingerprint is mandatory here

Unlike activation, where only `strict` makes hardware identification compulsory, enrollment
requires a fingerprint **regardless of the tier's mode**:

```json
{
  "error": "fingerprint_required",
  "message": "enrollment requires a hardware fingerprint"
}
```

with status `403`. The reason is structural rather than a policy choice: dedupe is impossible
without one. Every install would mint its own license, which is exactly the farming case the
policy exists to bound.

The requirement is really two:

| Refusal                    | Message                                                            | Cause                                                      |
| -------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `403 fingerprint_required` | "enrollment requires a hardware fingerprint"                       | No usable fingerprint in the body.                         |
| `403 fingerprint_required` | "enrollment requires a machine anchor in the hardware fingerprint" | A fingerprint was sent, but it omits the anchor component. |

## One license per machine

### The dedupe key is the anchor alone

The enrollment dedupe key is **not** the ordinary device hwid. It is computed over a fixed
projection — the anchor component (`machineUuid`) and nothing else — under its own
domain-separation prefix, so an enrollment key can never be confused with, or replayed as, a
device hwid.

The ordinary hwid digests exactly the components that were submitted, which is right for a
device binding (a partial read should degrade match precision rather than collide with every
other partial reader) and catastrophic for a dedupe key. With seven components there are
127 non-empty subsets, and the fingerprint parser accepts any of them — so one machine could
present 127 distinct "identities" and collect 127 free licenses, each with its own seat pool.

Under the fixed projection, every subset of one machine's components **that contains the
anchor** yields the same key, so omitting components gains nothing. A submission without the
anchor cannot be deduped at all, and is refused rather than minted.

### The unique index is the enforcement

`licenses.enroll_hwid` carries the key, under a partial unique index over
`(product, enroll_hwid)` for non-null values. The uniqueness is the **database's**, not the
handler's read-then-write: if two enrollments race, the loser's insert violates the index and the
handler re-reads the winner's row, so a burst of concurrent first-runs converges on a single
license instead of silently minting duplicates.

`test/enroll.test.ts` pins the observable half: a second enrollment from the same machine under a
different device id returns the **same** license id, and exactly one `origin = 'enroll'` row
exists afterwards. It also pins that the mint is audited (`license.enroll`) exactly once per
machine, and that genuinely different machines get genuinely different licenses.

### The minted row

| Column                 | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| `status`               | `active`                                              |
| `sub`, `name`, `email` | `null` — deliberately anonymous                       |
| `tier_id`              | The policy's tier                                     |
| `expires_at`           | Derived from the tier's `policy_expiry_days`, or null |
| `overrides_json`       | Empty config, secrets, and entitlements               |
| `origin`               | `enroll`                                              |
| `enroll_hwid`          | The anchor-derived key                                |
| `modified_by`          | `enroll`                                              |

The expiry derivation matters: a tier configured as a time-boxed trial used to issue
**permanent** licenses through this route — the one path where the license is free and
unauthenticated, which is where the time box matters most. A tier's expiry policy is a property
of the tier, so it is re-derived on every path that assigns one.

The anonymous name and email are safe to leave null because the signed greeting block tolerates
them and renders empty strings, so the document needs no special case.

### A claimed machine cannot re-enroll

`enroll_hwid` is **never released**. Once a machine's free license has been claimed by an
identity, or retired into one by a merge, the row keeps its key and goes on occupying the unique
index. An anonymous caller from that machine gets:

```json
{
  "error": "enroll_claimed",
  "message": "this machine's free license has been claimed; sign in to use it"
}
```

with status `403`.

Returning the existing row instead would hand an anonymous caller a license that now carries
somebody's identity and, post-claim, their tier. Clearing the key instead would let the same
machine enroll again immediately and be claimed by a second identity, without limit. So the
binding is permanent, and the caller signs in to reach it.

The handler's test for "still claimable" is precise — `origin = 'enroll'` **and** `sub is
null` **and** `status = 'active'` — and it is one shared predicate, applied identically on the
first read and on the re-read after a lost insert race, so the two arms cannot drift.

A row that fails only on `status` gets its own refusal: a still-anonymous enrolled license an
operator **disabled** answers `403` with code `license_disabled`. It is deliberately distinct
from `enroll_claimed` because the guidance differs — signing in will not reach a disabled
anonymous row, and re-enrolling around it would bypass the operator's deliberate refusal.

## Claim and migrate

Identity's `activateFromIdentity` can merge an anonymously enrolled license into an identity
rather than abandon it, when its caller names the license the device is currently on. **The
only caller that does is `/device/poll`, on the device-code holder's opt-in.** The device-code
callback used to, but a device-code flow is confirmed with a public user code, so the merge let
whoever confirmed the flow take the device's license over. A device-code callback now stores the
verified identity and activates nothing; the poll activates it. Without the opt-in a sign-in gets
only the identity's own license, and the enrolled license stays anonymous and active. With it,
the device is first shown the identity (`confirmIdentity` → `confirm`), and after the player
accepts it on the device the next poll sends `attachLicense: true` with the device's own bearer.
See [attaching the device's anonymous license](/docs/services/identity/device-flow/#attaching-the-devices-anonymous-license). The rules below are what a merge does when
it runs.

A license is **claimable** only if it is `origin = 'enroll'` with a null `sub`. Anything else —
an admin or OIDC license the device happens to hold — is left strictly alone, and the sign-in
returns no merge marker at all.

### Claim — the identity is new

No license exists for this `sub` yet, so the identity is attached to the **same row**:

- `sub`, `name`, `email`, `groups_json` are written from the IdP.
- `tier_id` and `expires_at` move to whatever the group mapping (or the `oidcDefault` fallback)
  grants, with the new tier's expiry policy re-derived.
- `origin` becomes `oidc`; `enroll_hwid` is kept.
- Overrides are replaced with the provisioning result for this identity.
- Audit: `license.merge`, "Claimed the auto-issued license".

The result carries `merged: "claimed"`. Because it is the same row, **devices and local state
survive** — the user simply becomes known. `test/enroll.test.ts` pins the device count at 1
across the claim and asserts `enroll_hwid` is still set.

### Migrate — the identity already has a license

The user already signed in on another machine, so a license for this `sub` exists:

- The enrolled row's devices are **moved** onto the identity's license, seat-checked: each
  authorized device takes a free seat there, and the migrate is refused (`device-limit`) when
  they would not fit the device limit the identity's license carries after the sign-in.
- The enrolled row's **store purchases follow** (the grants, the purchase records), and its
  purchase binding keeps resolving to the identity's license, so a restore made under it later
  still lands there.
- The enrolled row is set `status = 'disabled'`, keeping its `enroll_hwid`.
- Audit: `license.merge` against the identity's license, with the enrolled row as parent.

All of that is one batch: either everything moves or nothing does. The result carries
`merged: "migrated"`. The user keeps their machines and purchases but ends up on the license that
already holds their entitlements. `test/enroll.test.ts` pins the device landing on the identity
license with a seat, the enrolled row ending `disabled`, its `enroll_hwid` surviving, the
purchases following, and a refused migrate moving nothing; `test/licenseMerge.test.ts` pins a
restore under the old binding reaching the identity's license.

:::note[Why the retired row keeps its key]
The unique index is the only guard on "one free license per machine". If a migrate released the
key, the same machine could enroll again the moment the merge finished and repeat the whole
exercise with a second identity, without limit.
:::

### The `oidcDefault` half

`oidcDefault` (or `both`) also changes what happens to an authenticated user whose groups match
nothing in the product's group-to-role map. With the policy unset that user is refused outright;
with it set they land on the policy's tier. `test/enroll.test.ts` pins all three states: refused
when no default is configured, admitted to the free tier when the product opts in, and still
refused when the mode is `anonymous` only.

## An enrolled license is an ordinary license

Nothing downstream treats it specially. The token enrollment hands back fetches **both** halves
of the split document — `GET /<product>/license/document` and
`GET /<product>/config/document` — with `application/jwt` responses, which
`test/enroll.test.ts` asserts directly. Seat limits, fingerprint drift, re-licensing and the
build gate all apply exactly as they do to a purchased license.

## Reference

- [The license model](/docs/services/license/model/) — origins, `enroll_hwid`, seat pools.
- [Policy](/docs/services/license/policy/) — configuring auto-issue from the manifest or the
  console, and the validation codes.
- [Manifest validation codes](/docs/reference/validation-codes/) — `invalid_auto_issue`,
  `invalid_auto_issue_mode`, `invalid_rate_limit`, `invalid_tier_ref`,
  `missing_auto_issue_tier`, `unknown_auto_issue_tier_ref`.
- [Fingerprint constants](/docs/reference/fingerprint-constants/) — the anchor, the canonical
  component order, and the frozen hash domains.

## Fingerprint and auto-issue policy

Two policies sit behind one admin resource, because they answer one question from opposite ends:
**on what terms does a machine get a seat?**

- The **fingerprint policy** decides how tightly a device is bound to the hardware it activated
  on, and how much drift is tolerated before the binding is refused.
- The **auto-issue policy** decides whether an unrecognised install mints a license on the spot,
  and on which tier.

Both are read on the activation and enrollment paths, and neither means anything to a product
that does not run the License service — which is why License owns them even though they live on
Core's `products` row.

## The two shapes

### Fingerprint

Stored in `products.fingerprint_policy_json`, declared in the manifest as a `fingerprint` block.

| Field         | Meaning                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `enabled`     | Per-product opt-out. When false, clients are told not to collect hardware components, and every tier resolves to mode `off`. |
| `defaultMode` | `off`, `lenient`, `normal`, or `strict`. The fallback for tiers that declare none.                                           |
| `probes`      | Product-declared companion-application checks the client answers present or absent.                                          |

The default for a product that has never declared one is **enabled, `normal`, no probes**. A
product with no policy row still gets drift-tolerant binding, and clients that predate
fingerprinting are recorded as `unverified` rather than refused.

Per-tier overrides live on the tier row (`policy_fingerprint`), and the effective mode is the
tier's, then the product default, then `normal`. Tolerances per mode — and the anchor bonus that
widens a non-zero tolerance by one — are in
[Fingerprint constants](/docs/reference/fingerprint-constants/).

### Auto-issue

Stored in `products.auto_issue_json`, declared in the manifest as an `autoIssue` block.

| Field              | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `enabled`          | The opt-in. **Off** by default.                                    |
| `tierId`           | The tier auto-issued licenses land on. Required when enabled.      |
| `mode`             | `anonymous`, `oidcDefault`, or `both`.                             |
| `rateLimitPerHour` | Per-IP enrollment ceiling; `0` disables the limit. Defaults to 10. |

See [Enrollment](/docs/services/license/enrollment/) for what each mode opens.

### Two different fallbacks, on purpose

A malformed or absent policy JSON blob degrades differently for each:

| Policy      | Fallback                            | Why                                                                       |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Fingerprint | The **default** (enabled, `normal`) | A malformed policy must never take a product's licensing offline.         |
| Auto-issue  | **Off**                             | Fail closed: never mint free licenses because a JSON blob was unreadable. |

`test/fingerprintPolicy.test.ts` pins the fingerprint half directly, writing `{not json` into the
column and asserting the effective mode is still `normal`.

## Manifest versus live edits

Both policies are declared in the product's `.pkey/product` manifest **and** editable live from
the console. That combination is only coherent if the next resync cannot silently undo the live
change — the drift lockout an operator is paging about at 3am cannot wait for a pull request, but
a change that evaporates on the next push to the product repo is arguably worse than being
manifest-only.

So each policy carries an **owner** column beside its value:

| Value column                       | Owner column                         |
| ---------------------------------- | ------------------------------------ |
| `products.fingerprint_policy_json` | `products.fingerprint_policy_source` |
| `products.auto_issue_json`         | `products.auto_issue_source`         |

Both are `manifest` or `admin`, defaulting to `manifest`.

### The guard is the UPDATE's own WHERE clause

This is the mechanism, and it matters that it is not application logic:

- A **manifest** write (repo link, or a resync after a push) carries
  `WHERE … source = 'manifest'`. If an operator has already claimed the row, the statement
  matches nothing and the push is a no-op.
- An **admin** write always wins and sets `source = 'admin'` in the same statement.

`test/fingerprintPolicy.test.ts` pins exactly this: an admin write to `off`/disabled survives a
subsequent manifest write of `strict`/enabled, and the effective policy afterwards is still the
operator's.

### Revert hands ownership back — and nothing else

```http
POST /manage/api/products/<slug>/license/policy/revert
```

Revert sets the source back to `manifest`. It does **not** restore the manifest's values: the
live values stay put until the next resync re-applies the declaration, at which point the guard
no longer blocks it. The test walks that sequence — admin write, revert, manifest write, and the
manifest's value is now the effective one.

:::caution[Revert covers both policies]
`policy/revert` reverts the fingerprint policy **and** the auto-issue policy together. There is
no per-policy revert. Audit action: `product.fingerprint.revert`.
:::

The same machinery governs `products.services_json` through `services_source` — see
[Core](/docs/services/core/) for service enablement.

## The admin endpoint

```http
GET   /manage/api/products/<slug>/license/policy
PATCH /manage/api/products/<slug>/license/policy
POST  /manage/api/products/<slug>/license/policy/revert
```

`GET` and the post-write echo share one projection, so they cannot drift:

```json
{
  "policy": { "enabled": true, "defaultMode": "normal", "probes": [] },
  "source": "manifest",
  "autoIssue": {
    "enabled": false,
    "tierId": null,
    "mode": "anonymous",
    "rateLimitPerHour": 10
  },
  "autoIssueSource": "manifest"
}
```

`test/fingerprintPolicy.test.ts` asserts that exact body for a freshly-seeded product.

`PATCH` is a partial update: omitted fields keep their current values. Two ownership details are
easy to miss:

- **Any `PATCH` claims the fingerprint policy.** The fingerprint write runs unconditionally and
  always sets `source = 'admin'`, even when the request body only touched `autoIssue`.
- **Auto-issue ownership is claimed only when `autoIssue` is present** in the body. A PATCH that
  never mentions it leaves `auto_issue_source` alone.

Success is audited as `product.policy.update`, with a summary naming the effective fingerprint
mode and the auto-issue mode and tier.

## The validation codes now enforced

A rejected `PATCH` is `422` with the offending field paths. The admin API emits its error both
nested and mirrored at the top level, so a console that reads either shape works:

```json
{
  "error": {
    "code": "bad_request",
    "message": "invalid policy",
    "fields": ["autoIssue.tierId"]
  },
  "code": "bad_request",
  "message": "invalid policy",
  "fields": ["autoIssue.tierId"]
}
```

Every field is validated and **all** failures are collected before anything is written, so one
request reports every problem rather than the first — and a request that fails validation writes
nothing at all, including the ownership flag.

| Field in `fields`            | Rejected because                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `enabled`                    | Not a boolean.                                                                                  |
| `defaultMode`                | Not one of `off`, `lenient`, `normal`, `strict`.                                                |
| `probes`                     | Not an array — **or** the runtime parser would silently drop an entry.                          |
| `autoIssue`                  | Not a plain object.                                                                             |
| `autoIssue.enabled`          | Not a boolean.                                                                                  |
| `autoIssue.tierId`           | Not a string or null; or enabling with no tier; or enabling against a tier that does not exist. |
| `autoIssue.mode`             | Not one of `anonymous`, `oidcDefault`, `both`.                                                  |
| `autoIssue.rateLimitPerHour` | Not a finite number, or negative.                                                               |

Two of these deserve their reason spelled out.

**Probes are validated by re-running the runtime parser.** The request's probe array is parsed
with the exact function the worker reads policy through; if the parsed array is shorter than the
submitted one, the request is refused. A probe with no `id` is discarded by that parser, so
storing it would leave an operator believing they had configured something that never runs.
The test submits `[{ "label": "no id here" }]` and expects `422` with `fields: ["probes"]`.

**Enabling auto-issue is checked against real tiers.** `enabled: true` with a `tierId` that
names nothing is refused here rather than failing silently at enrollment, where it would mint
licenses whose entitlements nobody configured. The test covers both the missing-tier and the
no-tier-at-all cases.

### The manifest validator enforces the same rules

The `.pkey/` validator aggregates every problem rather than stopping at the first, and `pkey
validate` and the console's link and resync surfaces show these codes with their JSON-pointer
paths. The License-relevant ones:

| Area              | Codes                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fingerprint block | `invalid_fingerprint`, `invalid_fingerprint_enabled`, `invalid_fingerprint_mode`                                                                                                                         |
| Probes            | `invalid_probe_id`, `invalid_probe_label`, `invalid_probe_target`                                                                                                                                        |
| Auto-issue        | `invalid_auto_issue`, `invalid_auto_issue_mode`, `invalid_rate_limit`, `invalid_tier_ref`, `missing_auto_issue_tier`, `unknown_auto_issue_tier_ref`                                                      |
| Tiers             | `invalid_tier_id`, `duplicate_tier_id`, `invalid_tier_label`, `invalid_tier_fingerprint_mode`, `invalid_device_limit`, `invalid_semver`, `invalid_channel`, `invalid_profile_ref`, `unknown_profile_ref` |
| Profiles          | `invalid_profile_id`, `duplicate_profile_id`, `invalid_profile_name`, `invalid_profile_description`, `invalid_payload`                                                                                   |

Full text, severity, and JSON pointer for each: [Manifest validation
codes](/docs/reference/validation-codes/).

## The support escape hatch

A false-positive drift lockout is a support call, and the fix must not cost the user a seat:

```http
POST /manage/api/products/<slug>/license/licenses/<id>/devices/<deviceId>/fingerprint/reset
```

This clears the device's hardware binding and **leaves it authorized**. The device's next
check-in re-binds cleanly against whatever hardware it now presents. `test/fingerprintPolicy.test.ts`
pins both halves: the fingerprint row is gone, and the device row is still `authorized`.

Audit action: `device.fingerprint.reset`.

Compare with the other two ways a binding disappears, which both **do** cost the seat:
deauthorizing a device from the console or from the device itself, and a hardware mismatch, which
retires the binding before answering `409` so the retry can re-bind cleanly.

## Reference

- [Activation](/docs/services/license/activation/) — where fingerprint mode is resolved and
  enforced.
- [Enrollment](/docs/services/license/enrollment/) — what the auto-issue policy opens.
- [Manifest validation codes](/docs/reference/validation-codes/) — the generated table.
- [Fingerprint constants](/docs/reference/fingerprint-constants/) — component order, hash
  domains, tolerances.
- [D1 data model](/docs/reference/data-model/) — the `products` columns these policies live in.
