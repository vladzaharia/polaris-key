---
title: "Services & enablement"
description: "Turning services on and off live, the manifest-vs-admin ownership split, and the coherence errors a bad combination returns."
sidebar:
  order: 4
---

Which of the five opt-in services a product runs is the single most consequential switch in the
console: everything else in [the tour](/docs/admin/console-tour/) — which nav sections exist,
which routes the worker mounts, what a product's discovery document advertises, what the portal
offers — is a **projection** of this one setting. It lives on the Platform section's **Services**
tab rather than inside any one service, for the reason the card's own description gives: a
service that owned its own off switch would have to be running to be turned off.

## The endpoint

`GET /manage/api/products/<slug>/services` returns the current state; `PATCH` on the same path
writes it; `POST .../services/revert` hands ownership back to the manifest. All three are
platform-admin gated like the rest of the admin surface, and enablement is **not** itself
checked on these routes — you have to be able to reach a service's settings in order to
configure it before turning it on.

The response, and the shape a `PATCH` body partially updates:

```json
{
  "services": {
    "license": { "enabled": true },
    "config": { "enabled": true },
    "release": { "enabled": false },
    "update": { "enabled": false },
    "identity": { "enabled": false }
  },
  "registration": null,
  "effectiveRegistration": "requires-license",
  "source": "manifest"
}
```

- `services` — the five slugs. A `PATCH` may send any subset; an omitted slug keeps its current
  value rather than reverting to a default, so a console build that only knows about three
  services can never accidentally turn off the two it has never heard of.
- `registration` — the **declared** device-registration policy, or `null` when the product rides
  the derived default. Sending `null` explicitly clears a previous declaration.
- `effectiveRegistration` — what the wire actually enforces right now, whether declared or
  derived. See [The device principal](/docs/services/core/device-principal/#registration-policies)
  for the full derivation and what each of the three policies allows.
- `source` — `manifest` or `admin`. See below.

## Why the whole set saves at once

The Services card collects every toggle and the registration select into one form behind a
single **Save services** button, rather than writing on each flip. That's a direct consequence
of how the server validates: it checks the **set**, not each flag in isolation (see *Coherence
errors* below). Turning Release off while Update is also on is a coherent two-step change, and a
card that PATCHed on every flip would reject the first step and never let you reach the second.

## Manifest vs admin ownership

`services_json` carries an owner, `services_source`, exactly like the fingerprint and auto-issue
policies do:

- A **`PATCH`** claims the row for `admin`. From that point, a resync (a push to the linked
  repo, or **Resync from repo**) no longer writes `services_json` — your live change can't be
  silently undone by the next manifest sync.
- **`Revert to manifest`** flips `services_source` back to `manifest` and changes **nothing
  else**. It does not re-fetch the repo, does not re-derive a set, and does not touch the live
  enablement — the values stay exactly as you left them until the *next* resync re-applies the
  manifest through the normal sync path, which is now allowed to write again. The confirm dialog
  says this in as many words, because "revert" reads like an instant undo and this one is a
  hand-back, not a rollback.

The **Revert to manifest** button is disabled once a product is already `manifest`-owned — there
is nothing to hand back.

## Coherence errors

A `PATCH` is validated as a whole proposed set, and a set that is individually well-formed but
jointly impossible returns `422` with a stable code per problem in `error.errors` — distinct from
`error.fields`, which means "this input itself was malformed." The console renders each code
beside the control it names, not as a toast, and the same codes appear if a manifest push would
produce the same incoherent state:

| Code | Meaning | Rendered against |
| --- | --- | --- |
| `update_requires_release` | Update is a feed rendered over Release's truth store; Update can't be on with Release off. | The Update toggle |
| `registration_requires_identity` | Registration is declared `requires-identity`, but Identity is off — there is no login to stand behind it, so no device could ever register. | Identity toggle + the registration select |
| `config_without_activation` | Config is on, License is off, and registration is declared `requires-license` — that closes the only mint path such a product has, so its devices could never obtain a token at all. | Config toggle + the registration select |

Leaving `registration` **derived** rather than explicitly declared sidesteps the second and third
of these by construction: a derived value is read off the very enablement set being validated,
so it can never itself be incoherent. That's also why the Services card's help text calls the
derived option "recommended."

A code this build doesn't have a control mapping for (a newer worker rule than the console
knows about) is still shown, just without a specific field to sit next to — better to explain a
save failure without full context than to drop it.

:::note[A same-named code, different moment]
`config_without_activation` also appears in [Manifest validation
codes](/docs/reference/validation-codes/) — there, at manifest-ingest time, it's a **warning**,
not a refusal, because a `.pkey/product` push is a different moment than a live admin edit: the
manifest validator flags the shape as worth a second look, while the live `PATCH` endpoint
refuses to write it. Same code, two different severities, because the two call sites carry
different blast radii.
:::

## Where enablement actually takes effect

Turning a service off doesn't hide a page — it makes the service **not exist** from the outside.
A disabled service's routes 404 exactly like an unregistered slug or a typo'd path (deliberately
indistinguishable, so probing which services a product runs isn't free), its discovery document
entry becomes `{"enabled": false}` with no endpoint list, its console nav section drops instead
of greying out (see [the disabled-service screen](/docs/admin/console-tour/#when-a-service-is-disabled)),
and the customer portal stops offering whatever that service backed. Read
[The service model](/docs/start/service-model/) for the four projections and the full coherence
rule set this page's table is drawn from.

## Reference

- [D1 data model](/docs/reference/data-model/) — `products.services_json` and
  `products.services_source`.
- [The device principal](/docs/services/core/device-principal/) — registration policies in full,
  including the two coherence rules enforced at this same endpoint.
- [Products](/docs/admin/products/#what-resync-actually-re-applies) — how a resync interacts with
  an admin-claimed row.
