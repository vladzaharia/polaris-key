---
title: "The catalog"
description: "Authoring ConfigEntry items: kinds, the per-entry JSON-Schema fragment, categories and UI hints, dependsOn gating, accessor, and secret delivery."
sidebar:
  order: 2
---

A product's catalog is data, not code: one JSON document with a `schemaVersion` and an
`entries` array of `ConfigEntry` items, authored in the product's own repo (`.pkey/schema`) or
edited directly in the admin catalog editor. Everything else in this service reads it: the admin
SPA renders a form from it, every SDK validates against it, and the config document is pruned
against it before it is ever signed.

This page is the authoring guide. For the exact shape of a `ConfigEntry`, see
[ConfigEntry — the catalog item shape](/docs/reference/config-entry/), reproduced verbatim from
source so these pages don't have to keep a second copy honest.

## The three kinds

| Kind | Holds | Delivered via |
| --- | --- | --- |
| `config` | A plaintext client setting. | This service's config document, `config` map, addressed by `accessor`. |
| `secret` | A value the admin surface always redacts. | This document's `secrets` map, or a runtime token via edge-mint — never plaintext in an admin response. |
| `flag` | An entitlement. | Not this document at all. |

`flag` is the odd one out. Config owns the *schema* for a flag exactly as it does for the other
two kinds, but a flag's resolved *value* never appears in this service's document — it rides the
license document's `entitlements` map instead, read client-side via `isEntitled`/`getEntitlements`
rather than through the config accessor. A product with Config enabled and License disabled can
still declare `flag` entries in its catalog; it simply has no document to deliver their resolved
values on, since entitlements ride the one document Config doesn't own.

## Fields you author

The reference page has the exact TypeScript shape. These are the fields with authoring rules
worth stating explicitly:

| Field | Notes |
| --- | --- |
| `key` | A dotted identifier, unique within the catalog — e.g. `run.concurrency`, `proxy.subscriptionUrl`, `polarisVpn`. |
| `category`, `label`, `description` | Grouping and copy for the admin surface and any generated settings UI. |
| `examples` | Sample values shown in a generated form. Never validated against `schema`. |
| `default` | The schema-level fallback. Also the value `managementDefault` seeding uses — see [Management states](/docs/services/config/management-states/). |
| `secret` | `true` on a `config`-kind entry whose value should be redacted like a `secret`-kind one. |
| `managementDefault` | **`config` kind only.** The state a freshly-minted key gets until an admin overrides it. |
| `userGrant` / `grantLabel` | `flag`-only. Surfaces the entitlement to the user as an included capability, e.g. "Included with your license". |
| `appliesTo` | Optional `cli`/`app` narrowing, for a catalog one schema shares across client shapes. |
| `deprecated`, `since` | Optional metadata. Never affects validation. |

## `ui`: presentation hints that never validate

`ui` (`UiHints`) shapes a generated form. None of it changes what `validateKeyValue` accepts — a
`select` widget with the wrong `optionLabels` still takes whatever `schema` allows; the hint only
changes how the value is rendered and edited.

| Field | Meaning |
| --- | --- |
| `widget` | `password` \| `select` \| `textarea` \| `switch` \| `stepper`. |
| `help`, `placeholder` | Copy for the generated field. |
| `order` | Sort position within the entry's `category`. |
| `scopes` | Which admin surfaces the key is meaningful at: `profile`, `license`, `device` — omitted means all. |
| `advanced` | Hint to collapse the field behind an "advanced" toggle. |
| `unit` | A unit label, e.g. `"seconds"`, rendered beside the value. |
| `optionLabels` | Human labels for an `enum`'s raw values. |
| `adminSection` | Groups the field within a larger admin form independently of `category`. |

## `dependsOn`: presentation gating, not validation gating

`dependsOn: { key, equals }` hides an entry in a rendered form until another key's *current*
value equals a given one — e.g. show `proxy.select` only once `proxy.enabled` is `true`. It is
read by the admin SPA and by SDK-side settings UIs; `validateKeyValue` and the document-signing
prune never consult it. An admin can set and enforce `proxy.select` even while `proxy.enabled` is
`false` and the field is hidden — the value is simply not shown to a user who can't act on it yet.

## `accessor`: where a value lands on the client

For `config` and `secret` kinds, `accessor` is a dotted path into the client's own config object —
the mirror or struct an SDK exposes to application code. `flag` kinds have no `accessor`: their
value lives in the entitlements map, addressed by `key` alone.

## `delivery`: how a secret reaches a runtime

A `secret`-kind entry may declare `delivery`, one of `serverOnly` \| `clientScoped` \| `edgeMint`
(`SecretDelivery`, `@polaris-key/protocol/config`). The manifest validator enforces two things
about it at ingest: it is only meaningful on a `kind: "secret"` entry, and it must be one of the
three values — anything else, or a `delivery` on a `config`/`flag` entry, fails validation.

- **`clientScoped`** is the shape every catalog secret has by default: the value travels in the
  config document's `secrets` map, redacted everywhere in the admin surface, decrypted
  client-side into the OS keyring.
- **`serverOnly`** documents that the value is meant for the Worker's own use rather than the
  client's. Treat it as authoring intent to be enforced by how the value is actually populated —
  the annotation itself does not change what the document-signing prune delivers.
- **`edgeMint`** marks that the entry's *value* is not the thing delivered at all. It is the
  client's cue to call the paired [edge-mint recipe](/docs/services/config/edge-mint/) — via
  `/<product>/config/mint/<id>/token` — instead of reading a value from this document.

## The per-entry `schema` fragment

### An interpreter, not a compiler

`schema` is a Draft-07 JSON-Schema fragment, but Ajv — the usual interpreter — validates by
generating JavaScript source and handing it to `Function()`, and workerd only allows code
generation from strings during the startup window. Catalogs load from D1 mid-request, so
`@polaris-key/catalog` walks the schema tree instead of compiling it: nothing is ever evaluated,
at publish time or at request time.

### The supported subset

Annotations are carried but never checked: `$schema`, `$id`, `$comment`, `title`, `description`,
`default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `definitions`, `$defs`,
`contentMediaType`, `contentEncoding`.

Assertions are fully implemented: `type`, `enum`, `const`, the numeric bounds
(`minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`), the string bounds
(`minLength`/`maxLength`/`pattern`/`format`), the array keywords
(`items`/`additionalItems`/`minItems`/`maxItems`/`uniqueItems`/`contains`), the object keywords
(`properties`/`required`/`additionalProperties`/`patternProperties`/`propertyNames`/`minProperties`/`maxProperties`),
and the applicators `allOf`/`anyOf`/`oneOf`/`not`/`if`/`then`/`else`.

Supported `format` values — hand-implemented rather than delegated to `ajv-formats`, whose own
URI regex is itself backtracking-prone: `uri`, `url`, `uri-reference`, `iri`, `email`, `hostname`,
`ipv4`, `ipv6`, `date`, `time`, `date-time`, `uuid`, `json-pointer`, `regex`.

### Fail-closed on anything else

A keyword outside those two lists does not get ignored — it makes the whole fragment
**unsupported**. `prepareSchema` throws immediately, `Catalog#compileAll()` surfaces that as a
publish-time `422` (below), and if an unsupported fragment somehow reached request time anyway,
the key's value would be marked invalid rather than unconstrained. `format` follows the same rule:
an unrecognised value is a rejected schema, never a skipped check.

### `pattern` runs on a linear-time engine

`pattern` and `patternProperties` never touch the host `RegExp`. A catalog `pattern` is
operator-supplied — an admin publish, or a linked repo's `.pkey/schema` — and V8's backtracking
engine turns some eight-character patterns into tens of seconds of Worker CPU against a few dozen
bytes of input: `(x+x+)+y` measured at roughly 57 seconds against a 34-character string (finding
R10-09). A source-length cap alone does not help — the pathological patterns are short — and
star-height analysis both under- and over-rejects: `(a|a)*` has star height 1 and is still
exponential, while `a*a*a*a*b` is merely polynomial and still worth capping.

`@polaris-key/catalog` compiles `pattern` into a Thompson/Pike NFA instead: every reachable state
advances one input code point at a time, so a match costs `O(instructions × input)` with **no
backtracking**, for every pattern including adversarial ones. What that engine cannot express
without backtracking is refused at compile time rather than run anyway: backreferences,
lookahead and lookbehind, and `\b`/`\B` word boundaries. Budgets bound the rest:

| Limit | Value | Bounds |
| --- | --- | --- |
| `MAX_PATTERN_SOURCE` | 300 characters | The `pattern` string itself. |
| `MAX_PATTERN_PROGRAM` | 2000 instructions | The compiled NFA — what bounds `{n,m}` expansion. |
| `MAX_PATTERN_REPEAT` | 100 | The largest `{n,m}` bound a pattern may declare. |
| `MAX_PATTERN_INPUT` | 4096 characters | The longest value ever matched; longer values fail closed — `test()` returns `false`, never an error. |

### Budgets around the fragment, and around a value

Two more sets of numbers matter to an author: shape budgets, checked once at analysis time, and
value budgets, spent on every validation call.

- `MAX_SCHEMA_DEPTH` = 12 — deepest nesting a fragment may declare.
- `MAX_SCHEMA_NODES` = 500 — total subschemas (properties, items, `allOf` branches, …) in one
  fragment.
- `MAX_VALIDATION_STEPS` = 100,000 — the work budget for validating one *value*. A value that
  blows it comes back as an ordinary failure, never a throw, so a hostile value gets pruned rather
  than 500-ing the document route.
- `MAX_UNIQUE_ITEMS` = 1,000 — the largest array `uniqueItems` will scan; past it, `uniqueItems`
  fails closed too.

### Publish-time compilation

`PUT /manage/api/products/<slug>/config/catalog` is the admin path this service owns directly:

```
PUT .../config/catalog
  new Catalog(body).compileAll()   // analyse every entry's schema fragment, once
    ok      -> bump schemaVersion, deactivate the old row, insert the new one, audit "schema.publish"
    throws  -> 422 { fields: ["<key>: <reason>"] }, nothing written
```

`compileAll()` turns "a malformed, oversized, or ReDoS-shaped fragment" from a problem the *next
device to poll* discovers into a problem the *publishing operator* discovers, with the offending
key named. Request-time validation (`validateKeyValue`, used by every override write and by the
document-signing prune) never throws for the same reason in reverse: an uninterpretable fragment
there just marks the value invalid, so a stale or corrupt catalog can't turn a routine config
fetch into a `500`.

## Worked examples

```jsonc
// config — overridable by default
{
  "key": "run.concurrency", "kind": "config", "category": "Run",
  "label": "Parallel downloads",
  "schema": { "type": "integer", "minimum": 1, "maximum": 8 },
  "default": 3, "managementDefault": "default", "ui": { "widget": "stepper" }
}

// secret — withheld from enumeration, delivered to the OS keyring
{
  "key": "proxy.subscriptionUrl", "kind": "secret", "secret": true, "category": "VPN",
  "label": "VPN subscription URL",
  "schema": { "type": "string", "format": "uri" },
  "managementDefault": "hidden", "ui": { "widget": "password" },
  "dependsOn": { "key": "polarisVpn", "equals": true }
}

// flag — an entitlement, delivered on the LICENSE document, not this one
{
  "key": "polarisVpn", "kind": "flag", "category": "VPN", "label": "Polaris VPN",
  "schema": { "type": "boolean" }, "default": false,
  "userGrant": true, "grantLabel": "Polaris VPN", "ui": { "widget": "switch" }
}
```

## See also

- [ConfigEntry — the catalog item shape](/docs/reference/config-entry/) — the verbatim type.
- [Manifest validation codes](/docs/reference/validation-codes/) — every coded error a `.pkey/`
  ingest can raise, including `missing_schema` and `invalid_schema` for the catalog document
  itself.
- [Management states](/docs/services/config/management-states/) — what `managementDefault`
  actually seeds.
- [Edge-mint](/docs/services/config/edge-mint/) — the recipe a `delivery: "edgeMint"` secret
  pairs with.
- `packages/shared-catalog/src/{catalog,validate,regex}.test.ts` — pin the keyword table, the
  format table, and the ReDoS refusal list (including the `(x+x+)+y` and `(a|a)*` cases above).
