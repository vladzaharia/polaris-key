---
title: "The catalog"
description: "Declare the keys a product delivers: kinds, the fields you author, presentation hints, secret delivery and the schema each value must match."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 3
---

A product's catalog is data: one JSON document with a `schemaVersion` and an `entries` array of `ConfigEntry` items. You author it in `.pkey/schema` in your repo or edit it in the console. Everything reads it: the console renders forms from it, every SDK validates against it, and the Worker prunes the config document against it before signing. The exact type is in [Config entry](/docs/reference/config-entry/).

## The three kinds

| Kind     | Holds                                    | Delivered through                                           |
| -------- | ---------------------------------------- | ----------------------------------------------------------- |
| `config` | A plaintext client setting (a Setting)   | The config document's `config` map, addressed by `accessor` |
| `secret` | A value the admin surface always redacts | The `secrets` map, or a runtime token through edge mint     |
| `flag`   | An entitlement                           | The license document, never the config document             |

A `flag` has a schema in the catalog like the others, but its resolved value rides the license document's `entitlements` map, so a config-only product can declare flags yet has no document to deliver them on.

## Fields you author

| Field                              | Notes                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `key`                              | A dotted identifier, unique in the catalog, such as `run.concurrency`      |
| `category`, `label`, `description` | Grouping and copy for the console and generated settings screens           |
| `examples`                         | Sample values for a generated form. Never validated against `schema`       |
| `default`                          | The schema-level fallback, and the value Default seeding uses              |
| `secret`                           | `true` on a `config` entry whose value is redacted like a secret           |
| `managementDefault`                | `config` kind only. The state a fresh key gets until an admin overrides it |
| `userGrant`, `grantLabel`          | `flag` only. Shows the entitlement to the user as an included capability   |
| `appliesTo`                        | Optional `cli` or `app` narrowing                                          |
| `deprecated`, `since`              | Metadata. Never affects validation                                         |

Publishing refuses two mistakes. A key declared twice would shadow itself, so a value could be screened against one entry and delivered under the other. A `flag` with `secret: true` is refused, because entitlements are read in the clear and never sealed.

## Presentation hints

`ui` shapes a generated form and never changes what validates.

| Field                                  | Meaning                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `widget`                               | `password`, `select`, `textarea`, `switch` or `stepper`                        |
| `help`, `placeholder`                  | Copy for the field                                                             |
| `order`                                | Sort position inside the category                                              |
| `scopes`                               | Where the key matters: `profile`, `license`, `device`. Omitted means all three |
| `advanced`                             | Collapse the field behind an advanced toggle                                   |
| `unit`, `optionLabels`, `adminSection` | A unit label, human labels for enum values, a grouping in a larger form        |

`dependsOn: { key, equals }` hides an entry until another key's current value matches. Neither validation nor the signing prune consults it, so an admin can set a hidden key.

`accessor` is a dotted path into the client's own config object for `config` and `secret` kinds. A `flag` is addressed by `key` alone.

## Secret delivery

A `secret` may declare `delivery`: `clientScoped`, `serverOnly` or `edgeMint`. Any other value, or `delivery` on another kind, fails validation.

- `clientScoped` is the default: the value travels in the document's `secrets` map, redacted everywhere in the admin surface. The SDK caches it with the document. Only the device token lives in the OS keyring, so a host that wants the value in a vault copies it itself.
- `serverOnly` never leaves the Worker. The signing prune drops it from every device-facing document, bundles included.
- `edgeMint` marks that the entry isn't read from the document at all: the client calls the paired recipe instead ([Edge mint](/docs/features/managed-config/edge-mint/)).

## The schema fragment

`schema` is a Draft-07 JSON Schema subset, and `@polaris-key/catalog` interprets it by walking the tree. Nothing is compiled, because workerd forbids code generation from strings outside startup.

- Annotations such as `title`, `description`, `default` and `examples` are carried and never checked.
- Assertions are fully implemented: `type`, `enum`, `const`, numeric and string bounds, `pattern`, `format`, the array and object keywords, and `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else`.
- Supported `format` values: `uri`, `url`, `uri-reference`, `iri`, `email`, `hostname`, `ipv4`, `ipv6`, `date`, `time`, `date-time`, `uuid`, `json-pointer`, `regex`.
- Any other keyword makes the fragment unsupported. Publishing refuses it with `422`, and at request time the value is marked invalid rather than unconstrained.

`pattern` runs on a linear-time engine, because a backtracking pattern such as `(x+x+)+y` can burn tens of seconds of Worker CPU on a short string. It refuses backreferences, lookahead, lookbehind and word boundaries.

| Limit                  | Value           | Bounds                                               |
| ---------------------- | --------------- | ---------------------------------------------------- |
| `MAX_PATTERN_SOURCE`   | 300 characters  | The `pattern` string                                 |
| `MAX_PATTERN_PROGRAM`  | 2000 steps      | Compile budget, including `{n,m}` expansion          |
| `MAX_PATTERN_REPEAT`   | 100             | The largest `{n,m}` bound                            |
| `MAX_PATTERN_INPUT`    | 4096 characters | The longest value matched. Longer values fail closed |
| `MAX_SCHEMA_DEPTH`     | 12              | Deepest nesting in a fragment                        |
| `MAX_SCHEMA_NODES`     | 500             | Subschemas in one fragment                           |
| `MAX_VALIDATION_STEPS` | 100,000         | Work for one value. Over it, the value is invalid    |
| `MAX_UNIQUE_ITEMS`     | 1,000           | The largest array `uniqueItems` scans                |

## Publish

Publishing analyzes every entry's fragment once, so a malformed or oversized fragment is found by the publisher with the key named, not by the next device to poll. A failure is `422` with `fields`, and nothing is written. Success bumps `schemaVersion`, deactivates the old row and audits `schema.publish`. Every version is kept.

The admin routes under `/manage/api/products/<slug>/config/catalog` are `GET` (active, `404` before the first publish), `PUT` (publish `{ catalog, expectedVersion? }`), `versions`, `versions/<n>` and `usage?key=…`. With `expectedVersion`, a different active version answers `409 catalog_version_conflict` with `currentVersion` and writes nothing. Without it the last writer wins. `usage` names, per key, the profiles, tiers and licenses that set it (ids and names, never values).

## In the console

**Config → Catalog** shows the active catalog with search and filters that stay in the URL. The header shows the version, key count and owner: a product linked to a repo shows **From manifest**, because the next resync reapplies `.pkey/schema` over a console publish. **Version history** compares an earlier version with the active one. **Edit catalog** opens the editor:

- **Form** edits one entry at a time. **JSON** edits the whole document with line-level problems. Both edit the same draft, which stays in the tab until you publish or discard it.
- **Review changes** shows the draft against the version it started from. Removing a key that a profile or license still sets is marked breaking and needs your acknowledgement, because its values are dropped.
- If someone published in the meantime, you can review your draft against the newer version or discard it.

## Example

```json title=".pkey/schema"
{
  "schemaVersion": 1,
  "entries": [
    {
      "key": "run.concurrency",
      "kind": "config",
      "category": "Run",
      "label": "Parallel downloads",
      "description": "How many downloads run at once.",
      "schema": { "type": "integer", "minimum": 1, "maximum": 8 },
      "default": 3,
      "managementDefault": "default",
      "ui": { "widget": "stepper" }
    }
  ]
}
```

## Next steps

- [Management states](/docs/features/managed-config/management-states/): what `managementDefault` seeds.
- [Edge mint](/docs/features/managed-config/edge-mint/): the recipe an `edgeMint` secret pairs with.
- [Validation codes](/docs/reference/validation-codes/): `missing_schema`, `invalid_schema` and the rest.
