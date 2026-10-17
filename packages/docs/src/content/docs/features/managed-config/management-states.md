---
title: "Management states"
description: "How Editable, Read-only and Hidden are seeded, merged across layers and resolved on the client."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 4
---

Every `config` key carries a management state: `default`, `enforced` or `hidden`. It decides whether the operator's value is a suggestion or a mandate. The console says it from the person's side, **In the app**: Editable, Read-only or Hidden. The wire and the catalog keep the three stored words.

A `flag` has no state. It is an entitlement, read from the license document. A `secret` and a minted token have none either: they are never listed, so there is nothing to show or hide.

## Five combinations, not nine

Three types times three visibilities would be nine cells. Only five mean something:

| Type             | In the app                                   |
| ---------------- | -------------------------------------------- |
| **Setting**      | Editable, Read-only, or Hidden (three cells) |
| **Secret**       | Never listed (one cell)                      |
| **Minted token** | Never listed (one cell)                      |

The other four cells are refused on purpose. A person-changeable secret is a Setting with a password widget. Listing a secret as Read-only would change what the signed document carries. A minted token is only ever read in code.

## The three states

| In the app | Stored     | On the wire                | Client behavior                                                                                                 |
| ---------- | ---------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Editable   | `default`  | A suggested value          | The user's override wins, then the environment, then this remote value, then the SDK's fallback                 |
| Read-only  | `enforced` | The value, marked enforced | The remote value always wins. A settings screen shows it read-only (`listUserConfig` marks it `enforced: true`) |
| Hidden     | `hidden`   | The value, marked hidden   | Enforced, and withheld from `listUserConfig`. `getConfig` still applies it                                      |

## Seeding

`managementDefault` on the catalog entry is the in-app visibility a fresh key gets. It seeds only the bottom layer of the merge, and only for a `config` entry that declares a schema `default`: `{ state: managementDefault ?? "default", value: default }`.

- A `config` entry with no `default` contributes nothing. If no higher layer sets it, the key is absent from the document and the client's own schema fallback answers.
- A `secret` is never seeded. It appears in a document only when a profile, an account override or a device override sets it.

## Layers

Layers merge in one fixed order, later winning, key by key, independently for `config`, `secrets` and `entitlements`:

```text title="Merge order"
catalog default → tier's profile → license's profiles (in order)
  → license overrides → account overrides → device overrides
```

The merge lives in Core, because the license and config documents are sliced from the same result and the two must never disagree about precedence. With no license (a config-only device), the tier, profile and license layers contribute nothing.

One exception: a later `default` can't demote an earlier `enforced` or `hidden`. The lower value and state survive, and only `updatedAt` advances, so a client watching for change still notices.

| Lower layer                  | Higher layer                  | Result                                |
| ---------------------------- | ----------------------------- | ------------------------------------- |
| `enforced` (tier's profile)  | `default` (license override)  | The tier's `enforced` value survives  |
| `default` (tier's profile)   | `enforced` (license override) | The license override wins             |
| `hidden` (license override)  | `default` (device override)   | The license's `hidden` value survives |
| `default` (license override) | `hidden` (device override)    | The device override wins              |

Every other combination, including a higher layer explicitly re-enforcing, is a plain override. For example, a catalog default of `default`, `3`, a tier profile of `enforced`, `8` and a license profile of `default`, `2` resolve to `enforced`, `8`.

## Account overrides

An account override is the operator's managed config for one account on one product. It holds `config` and `secret` keys, never `flag` keys, per pairwise subject, validated, sealed and redacted like a profile's payload. A device gets one account's layer, chosen in this order:

1. The account signed in on the device, unless the device's license is floating or that account removed the license from its library.
2. Otherwise the owner of the device's license, so a device activated by key still gets its owner's non-secret values. Secret keys, and `config` keys the catalog marks secret, reach only a device signed in as that account.
3. Otherwise none.

Edit it on **Users**, in a user's **Overview**. The layer exists on every product, with Identity on or off.

A license's own config and secret overrides are moving onto its owner's account overrides in one platform-wide run the owner schedules, after a 30-day notice. Several licenses of one product on one account collapse to the value of the license updated last. From the run's start the license route accepts entitlements only, and the license page says where its values went.

## On the client

Once the document is verified, the client resolves each key through one chain:

```text title="Resolution order"
enforced or hidden (remote) > local override > environment > remote default > fallback
```

- **Local override.** A synced setting or a programmatic override. It applies only while the remote state is `default`.
- **Environment.** `PKEY_CONFIG_` plus the key with each `.` replaced by `__`: `run.concurrency` is `PKEY_CONFIG_run__concurrency`. The value parses when it is one strict JSON text, else it is the raw string, the same in every SDK.
- **Fallback.** The entry's schema `default`, compiled into the SDK or a generated mirror, used only when nothing above answered.

## Next steps

- [The catalog](/docs/features/managed-config/catalog/): where `managementDefault` is authored.
- [Profiles](/docs/features/managed-config/profiles/): the set-or-blank rules of an override batch.
- [Config document](/docs/reference/protocol/config-document/): the signed result.
