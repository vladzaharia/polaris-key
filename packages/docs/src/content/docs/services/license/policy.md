---
title: "Fingerprint and auto-issue policy"
description: "Two policies, one endpoint: manifest blocks versus live admin edits, ownership and revert semantics, and the validation codes now enforced."
sidebar:
  order: 6
---

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

| Field | Meaning |
| --- | --- |
| `enabled` | Per-product opt-out. When false, clients are told not to collect hardware components, and every tier resolves to mode `off`. |
| `defaultMode` | `off`, `lenient`, `normal`, or `strict`. The fallback for tiers that declare none. |
| `probes` | Product-declared companion-application checks the client answers present or absent. |

The default for a product that has never declared one is **enabled, `normal`, no probes**. A
product with no policy row still gets drift-tolerant binding, and clients that predate
fingerprinting are recorded as `unverified` rather than refused.

Per-tier overrides live on the tier row (`policy_fingerprint`), and the effective mode is the
tier's, then the product default, then `normal`. Tolerances per mode — and the anchor bonus that
widens a non-zero tolerance by one — are in
[Fingerprint constants](/docs/reference/fingerprint-constants/).

### Auto-issue

Stored in `products.auto_issue_json`, declared in the manifest as an `autoIssue` block.

| Field | Meaning |
| --- | --- |
| `enabled` | The opt-in. **Off** by default. |
| `tierId` | The tier auto-issued licenses land on. Required when enabled. |
| `mode` | `anonymous`, `oidcDefault`, or `both`. |
| `rateLimitPerHour` | Per-IP enrollment ceiling; `0` disables the limit. Defaults to 10. |

See [Enrollment](/docs/services/license/enrollment/) for what each mode opens.

### Two different fallbacks, on purpose

A malformed or absent policy JSON blob degrades differently for each:

| Policy | Fallback | Why |
| --- | --- | --- |
| Fingerprint | The **default** (enabled, `normal`) | A malformed policy must never take a product's licensing offline. |
| Auto-issue | **Off** | Fail closed: never mint free licenses because a JSON blob was unreadable. |

`test/fingerprintPolicy.test.ts` pins the fingerprint half directly, writing `{not json` into the
column and asserting the effective mode is still `normal`.

## Manifest versus live edits

Both policies are declared in the product's `.pkey/product` manifest **and** editable live from
the console. That combination is only coherent if the next resync cannot silently undo the live
change — the drift lockout an operator is paging about at 3am cannot wait for a pull request, but
a change that evaporates on the next push to the product repo is arguably worse than being
manifest-only.

So each policy carries an **owner** column beside its value:

| Value column | Owner column |
| --- | --- |
| `products.fingerprint_policy_json` | `products.fingerprint_policy_source` |
| `products.auto_issue_json` | `products.auto_issue_source` |

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

| Field in `fields` | Rejected because |
| --- | --- |
| `enabled` | Not a boolean. |
| `defaultMode` | Not one of `off`, `lenient`, `normal`, `strict`. |
| `probes` | Not an array — **or** the runtime parser would silently drop an entry. |
| `autoIssue` | Not a plain object. |
| `autoIssue.enabled` | Not a boolean. |
| `autoIssue.tierId` | Not a string or null; or enabling with no tier; or enabling against a tier that does not exist. |
| `autoIssue.mode` | Not one of `anonymous`, `oidcDefault`, `both`. |
| `autoIssue.rateLimitPerHour` | Not a finite number, or negative. |

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

| Area | Codes |
| --- | --- |
| Fingerprint block | `invalid_fingerprint`, `invalid_fingerprint_enabled`, `invalid_fingerprint_mode` |
| Probes | `invalid_probe_id`, `invalid_probe_label`, `invalid_probe_target` |
| Auto-issue | `invalid_auto_issue`, `invalid_auto_issue_mode`, `invalid_rate_limit`, `invalid_tier_ref`, `missing_auto_issue_tier`, `unknown_auto_issue_tier_ref` |
| Tiers | `invalid_tier_id`, `duplicate_tier_id`, `invalid_tier_label`, `invalid_tier_fingerprint_mode`, `invalid_device_limit`, `invalid_semver`, `invalid_channel`, `invalid_profile_ref`, `unknown_profile_ref` |
| Profiles | `invalid_profile_id`, `duplicate_profile_id`, `invalid_profile_name`, `invalid_profile_description`, `invalid_payload` |

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
