---
title: "Services & enablement"
description: "Turning services on and off live, the manifest-vs-admin ownership split, and the coherence errors a bad combination returns."
sidebar:
  order: 4
---

Which of the seven opt-in services a product runs is the single most consequential switch in the
console: everything else in [the tour](/docs/admin/console-tour/) — which nav sections exist,
which routes the worker mounts, what a product's discovery document advertises, what the portal
offers — is a **projection** of this one setting. It lives on **Core → Services**
(`#/p/<slug>/services`) rather than inside any one service: a service that owned its own off
switch would have to be running to be turned off.

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
    "distribution": { "enabled": false },
    "update": { "enabled": false },
    "identity": { "enabled": false },
    "sync": { "enabled": false }
  },
  "registration": null,
  "effectiveRegistration": "requires-license",
  "source": "manifest"
}
```

- `services` — the six slugs. A `PATCH` may send any subset; an omitted slug keeps its current
  value rather than reverting to a default, so a console build that only knows about some of the
  services can never accidentally turn off the ones it has never heard of.
- `registration` — the **declared** device-registration policy, or `null` when the product rides
  the derived default. Sending `null` explicitly clears a previous declaration.
- `effectiveRegistration` — what the wire actually enforces right now, whether declared or
  derived. See [The device principal](/docs/services/core/device-principal/#registration-policies)
  for the full derivation and what each of the three policies allows.
- `source` — `manifest` or `admin`. See below.

## Each switch saves on its own

Every service switch on the Services page writes as soon as you flip it; there is no services
save bar. The services form a chain, **Release ← Distribution ← Update**, and the page applies
one rule to it, read from the generated `SERVICE_REQUIRES` edges rather than a list kept in the
console:

- **Turning a service on also turns on what it needs, and nothing more.** Turning on Update with
  everything off turns on Distribution and Release with it; turning on Release turns on Release
  alone. Each row says what its service needs before you flip it. The toast that follows names
  what came on with it ("Also turned on Distribution and Release") and offers **Undo**, which
  turns off exactly the services that flip turned on.
- **Turning a service off asks first.** The confirmation lists the dependents that go off with it
  (turning Release off also turns off Distribution and Update, which need it), what stops working
  for each (for example "The update feed answers not-configured: clients see no updates"), and
  that the section leaves the navigation. The service's settings are kept and come back when you
  turn it on again. Cancelling sends nothing.

The `PATCH` carries only the flags the flip changed, so a page that has gone stale can never
rewrite a service it did not touch, nor the registration policy. The server still validates the
whole resulting **set** (see _Coherence errors_ below), and the chain keeps the service edges
whole by construction. What it can't settle is the registration policy: a flip the declared
policy forbids (turning Identity off while registration is declared `requires-identity`, say) is
refused before anything is sent, and the message appears beside the controls involved: the
switch and the registration choice. The registration policy is a choice of four rather than a
switch, so it keeps its own **Save registration policy** action.

## Manifest vs admin ownership

`services_json` carries an owner, `services_source`, exactly like the fingerprint and auto-issue
policies do:

- A **`PATCH`** claims the row for `admin`. From that point, a resync (a push to the linked
  repo, or **Resync from repo**) no longer writes `services_json` — your live change can't be
  silently undone by the next manifest sync.
- **`Revert to manifest`** flips `services_source` back to `manifest` and changes **nothing
  else**. It does not re-fetch the repo, does not re-derive a set, and does not touch the live
  enablement — the values stay exactly as you left them until the _next_ resync re-applies the
  manifest through the normal sync path, which is now allowed to write again. The confirm dialog
  says this in as many words, because "revert" reads like an instant undo and this one is a
  hand-back, not a rollback.

The **Revert to manifest** button sits in the section header beside the owner badge (_From
manifest_ or _Set in console_). It is disabled, with the reason shown, once a product is already
`manifest`-owned: there is nothing to hand back.

## Coherence errors

A `PATCH` is validated as a whole proposed set, and a set that is individually well-formed but
jointly impossible returns `422` with a stable code per problem in `error.errors` — distinct from
`error.fields`, which means "this input itself was malformed." The console renders each code
beside the control it names, not as a toast, and the same codes appear if a manifest push would
produce the same incoherent state:

| Code                             | Meaning                                                                                                                                                                              | Rendered against                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `distribution_requires_release`  | Distribution delivers what Release says exists; Distribution can't be on with Release off.                                                                                           | The Distribution toggle                   |
| `update_requires_distribution`   | Update is a feed over what Distribution delivers; Update can't be on with Distribution off. (It replaced `update_requires_release`, which it and the rule above together imply.)     | The Update toggle                         |
| `registration_requires_identity` | Registration is declared `requires-identity`, but Identity is off — there is no login to stand behind it, so no device could ever register.                                          | Identity toggle + the registration select |
| `config_without_activation`      | Config is on, License is off, and registration is declared `requires-license` — that closes the only mint path such a product has, so its devices could never obtain a token at all. | Config toggle + the registration select   |
| `sync_requires_config`           | Cloud Sync syncs Config's user settings; Cloud Sync can't be on with Config off, nor Config go off under it.                                                                         | The Cloud Sync and Config toggles         |
| `sync_requires_identity`         | Cloud Sync needs people to sign in through the product; Cloud Sync can't be on with Identity off, nor Identity go off under it.                                                      | The Cloud Sync and Identity toggles       |

Leaving `registration` **derived** rather than explicitly declared sidesteps the last two of
these by construction: a derived value is read off the very enablement set being validated,
so it can never itself be incoherent. That's why _Derived from services_ is the first choice on
the page, and why the page shows the policy enforced now, and the one a save would enforce, in
words (_License required_, _Identity required_, _Open_).

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
of greying out (see [the disabled-service page](/docs/admin/console-tour/#when-a-link-goes-nowhere)),
and the customer portal stops offering whatever that service backed. Read
[The service model](/docs/start/service-model/) for the four projections and the full coherence
rule set this page's table is drawn from.

## When Distribution was added

Distribution arrived as the sixth service after the others were in production. Migration `0033`
turned it on for every product that already had Release on — admin-owned rows included, because
Distribution did not exist when the operator claimed the row, and every Release product already
serves downloads that later move into Distribution. A product whose `.pkey/product` names the
slugs `release` and `update` directly (rather than the legacy `releases` module) fails its next
push with `update_requires_distribution` until the manifest adds `distribution: { enabled: true }`;
the stored set keeps serving in the meantime. The **Distribution** nav section appears only while
Distribution is on.

## Package feeds

Below the services, **Package feeds** is Distribution's one sub-capability: whether the product's
packages are served on the registry host. It is operator-owned (a manifest never writes it) and
saves on its own, through `PUT /manage/api/products/<slug>/distribution/package-feeds` with
`{enabled, expectedVersion}`; a stale version is a 409 and nothing changes. Turning it off asks
first, because every feed of the product answers not-found within 30 seconds. While it is on,
**Distribution → Package feeds** is in the sidebar: see [Package feeds](/docs/admin/feeds/).

## Reference

- [D1 data model](/docs/reference/data-model/) — `products.services_json` and
  `products.services_source`.
- [The device principal](/docs/services/core/device-principal/) — registration policies in full,
  including the two coherence rules enforced at this same endpoint.
- [Products](/docs/admin/products/#what-resync-actually-re-applies) — how a resync interacts with
  an admin-claimed row.
