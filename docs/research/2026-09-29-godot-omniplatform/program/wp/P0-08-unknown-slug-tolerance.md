# P0-08 Tolerate unknown service slugs in `parseServices` (ship one deploy ahead)

| Field       | Value                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| Phase       | P0: Hygiene and unblockers                                                  |
| Size        | 0.1–0.25 engineer-weeks                                                     |
| Depends on  | none                                                                        |
| Unblocks    | [P0-09](P0-09-service-table.md)                                             |
| Role        | `pkey-implementer`                                                          |
| Plan mode   | no                                                                          |
| Gates       | worker tests; must be **deployed** before any worker that writes a new slug |
| Human input | a production deploy of this change before P0-09's new slug ships            |
| Repo        | `vladzaharia/polaris-key`                                                   |

## Goal

A worker that meets a `services_json` record containing a service slug it does not know keeps
every slug it _does_ know exactly as stored, and writes unknown slugs back unchanged. Rolling a
worker back past the release that introduced a new slug (e.g. `distribution`) then changes
nothing for existing products.

## Why

`parseServices` returns the **defaults for the whole record** as soon as it meets one key that is
not a known slug (`packages/worker/src/core/services.ts:158`, the `if (!isServiceSlug(key)) return
fallback();` line). Once a newer worker has written `distribution`, an older worker would read
every product with it as "defaults", silently switching Release, Update and Identity back to their
defaults (report [§3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered),
issue #6 in [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot)).
`serializeServices` compounds it: it writes only `SERVICE_SLUGS`, so a round-trip through an old
worker would also **delete** the unknown slug. This must ship at least one deploy before the
first new slug (P0-09 adds the table; P2b-01 adds `distribution`).

## Read first

- `AGENTS.md`, especially the green gate and the Node 22 constraint.
- `packages/worker/src/core/services.ts` (`parseServices`, `serializeServices`, `isServiceSlug`,
  `defaults`) and its callers: `src/core/servicesAdmin.ts:97`,
  `src/services/identity/portal/repo.ts:590`.
- `packages/worker/test/services.test.ts` for the existing fail-safe expectations.

## Scope

**In:**

- `parseServices` skips unknown slug keys instead of falling back, **but only when their value is
  well-formed** (`{ enabled: boolean }`). Malformed values still fall back, as today.
- The parsed result carries unknown entries through (e.g. `ProductServices.unknown?:
Record<string, { enabled: boolean }>`), and `serializeServices` writes them after the known
  slugs and before `registration`, byte-stable.
- Tests for: an unknown well-formed slug (known slugs preserved, round-trip preserves the
  unknown key); an unknown malformed slug (falls back, as before); ordering of the serialised
  output.

**Out:**

- Adding any new slug or changing `SERVICE_SLUGS` (→ [P0-09](P0-09-service-table.md), P2b-01).
- Admin UI display of unknown slugs (not needed; the console never offers them).

## Design notes

- Keep the fail-safe direction documented above `parseServices`: anything structurally wrong
  still means "behave as before the column existed".
- An unknown slug must **never** affect the effective registration policy or any enablement
  check. Only round-tripping cares about it.
- `servicesAdmin.ts` edits services by read-modify-write; make sure it preserves `unknown` too.

## Steps

1. Add the passthrough field to `ProductServices` and populate it in `parseServices`.
2. Emit it from `serializeServices` in a stable order (sorted by key).
3. Thread it through `servicesAdmin.ts`'s read-modify-write.
4. Add the tests above; keep every existing test green.

## Acceptance criteria

- [ ] `parseServices('{"release":{"enabled":false},"distribution":{"enabled":true}}')` yields
      `release.enabled === false` (not the default) and keeps `distribution` in the passthrough.
- [ ] `serializeServices(parseServices(x)) === x` for a record with an unknown well-formed slug.
- [ ] A malformed unknown value (`"distribution": true`) still returns the defaults.
- [ ] The admin services editor does not drop unknown slugs.
- [ ] The green gate passes.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- services
mise exec node@22 -- pnpm typecheck
```

## Hand-off

P0-09 relies on this being **deployed to production** before its first new slug is written. Record
the deploy in the PR description, then set the status:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-08 done`.
