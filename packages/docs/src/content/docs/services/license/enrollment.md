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
3. **Rate limit.** Bucket `enroll`, `rateLimitPerHour` per hour keyed by client IP, skipped
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
