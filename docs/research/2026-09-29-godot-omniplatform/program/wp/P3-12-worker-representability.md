# P3-12 Worker: representability write checks, signer guards and the D1 check

| Field       | Value                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                                                                                                              |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                    |
| Depends on  | [P3-01](P3-01-wire-v4-plan.md), [P3-02](P3-02-wire-v4-contract-corpus.md)                                                                                                               |
| Unblocks    | none                                                                                                                                                                                    |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                   |
| Plan mode   | yes: execute the approved `plans/P3-01.md` (its P3-12 parts); the plan's approval is this package's plan-mode gate, as for P3-02                                                        |
| Gates       | plan mode; rule 9 (manifest schema-parity for `value_not_representable`); threat model; generated docs (validation codes, `error-codes.mdx`); constants (the two `core` codes); workerd |
| Human input | an operator runs `check:representable` against production D1 before the first deploy of a Worker that contains this package, and fixes every value it flags                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                               |

## Goal

The Worker cannot sign a value a v4 verifier would refuse, and stored operator data cannot trip
that guard. `signJws` and `signDoc` throw `StrictJsonError` on a document that breaks
`plans/P3-01.md` §2.2's strict-JSON or integer rules; every signing route answers
`500 document_not_representable` instead of throwing; the admin handlers, the manifest validator,
OIDC sign-in and the catalog prune refuse or drop such values at write; and a one-time
`check:representable` lists every stored value in production D1 that would trip the guard.

## Why

P3-02 makes every SDK's verifier strict (lone surrogates, U+0000 in member names, numbers out of
range, depth over 64, integer claims decided from the token). Values that break those rules can
reach signed documents today through catalog-typed operator data, admin handlers that check less
than the manifest validator, OIDC sign-in and the manifest sync (plan §2.2, "Every value a v3
document carries"). Without write checks a v4 SDK would refuse a document the Worker signed. The
lead split this Worker write path out of P3-02 (plan §8, decision 3, option (a)) so it runs beside
[P3-03](P3-03-feed-composition.md) and [P3-05](P3-05-v4-react.md) and frees the corpus lane
sooner.

## Read first

- `AGENTS.md` rules 3, 9 and 10 and the green gate, including the workerd smoke job; the
  `authoring-pkey-manifests` skill for the manifest rule.
- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P3-01.md`**: §2.2 "Keeping the
  signer total" with its two tables and the D1 check, §2.7 (the `shared-jws` and
  `shared-catalog` rows marked P3-12), §3's P3-12 part, §6's P3-12 part, §7 step 2 and §9's
  "P3-12's PR also shows". Where it and this brief differ, the plan wins.
- `packages/worker/src/core/signing.ts:29-35` (`signDoc`), `core/trust.ts:98`
  (`signTrustManifest`), `core/documents.ts:78,146` (the `graceUntil` arithmetic),
  `core/payload.ts:111-149`, `core/bundles.ts:180-337`, `services/config/mint.ts:283`.
- `packages/shared-jws/src/index.ts` (`signJws`, and P3-02's `scanStrictJson`),
  `packages/shared-catalog/src/validate.ts`, `packages/worker/src/admin/lib/overrides.ts`,
  `services/identity/oidc.ts:509-552,703-720`, the admin product, tier and licence handlers named
  in the plan's inventory, and `services/distribution/capabilities.ts` (P2b-02's
  `DEFAULT_CAPABILITIES`).

## Scope

**In:**

- `StrictJsonError` and the `signJws` guard in `shared-jws` (rules 5, 7, 8 and 9 on the
  serialized header and payload).
- `signDoc`'s integer guard: an integer claim of a v3 `typ` must be a safe integer of at least
  its minimum (plan §2.2 "Minimums": 0 for every timestamp, 1 for `schemaVersion`);
  `signTrustManifest` moved onto `signDoc` with the same bytes; integer arithmetic in the
  builders, including `graceUntil = now + Math.floor(maxOfflineDays × 86 400)`.
- `representabilityIssue(value) → {rule, path} | null` in `shared-catalog`, with the five rules
  `lone-surrogate`, `nul-in-member-name`, `equivalent-member-names`, `number-out-of-range` and
  `too-deep`, run first by `validateEntryValue`.
- The manifest validator rule `value_not_representable` over every value of a `.pkey/` document,
  and `shared-manifest` exporting `ID_RE`, `CHANNEL_RE`, `SEMVER_RE` and `KID_RE` (rule 9's three
  parts).
- The inventory's admin write checks (`KID_RE` on `signingKid`, `ID_RE` on tier ids, `CHANNEL_RE`
  on channels, `SEMVER_RE` on version bounds, `MAX_WIRE_INTEGER` on `policyDeviceLimit`, an
  integer 1–365 for offline days, `representabilityIssue` on free text), answering
  `422 bad_request` with `fields` or `422 value_not_representable`.
- OIDC sign-in: a flagged `name` or `email` is stored as null, a flagged provisioning hook is
  skipped.
- `500 document_not_representable` on every signing route, in each route's existing body shape.
- The two `core` wire codes in `errors.json`: `value_not_representable` and
  `document_not_representable`.
- `packages/worker/scripts/check-representable.mjs` as
  `pnpm --filter @polaris-key/worker check:representable`, over the 8 JSON, 12 text and 1 number
  columns of plan §2.2, with its two warning columns, a local-D1 test, and the RUNBOOK deploy
  step.
- The capability table: `services/distribution/capabilities.ts` imports
  `OUTLET_CAPABILITY_DEFAULTS` from `@polaris-key/protocol/distribution` in place of
  `DEFAULT_CAPABILITIES`, with a test that the Worker's table, the protocol constant and
  `outlet-matrix.json#/kinds` are equal.
- THREAT-MODEL §3: the signer guard and the write checks.

**Out** (and where it belongs instead):

- The verifier fixes, the corpus, `scanStrictJson` itself and the four `client-core` functions
  (→ [P3-02](P3-02-wire-v4-contract-corpus.md)).
- Feed composition, the composer's `feedClaims` and `scanStrictJson` self-check, record ingest and
  the routes (→ [P3-03](P3-03-feed-composition.md)).
- The follow-up rule-9 change that makes the manifest refuse 0 or more than 365 offline days
  (plan §8 risk 13; not scheduled).

## Design notes

- **Nothing here changes a verifier or a signed byte for clean data.** With a clean
  `check:representable` and no warnings, no product's documents change, except a sealed secret
  whose plaintext the rules flag, which the config document's prune drops (the check cannot open
  sealed values).
- **Shared with P3-03.** Both packages touch `core/signing.ts` callers and the threat model, in
  the same worker lane; they rebase on each other. The composer's own `scanStrictJson` keeps the
  feed safe whichever lands first, and no Worker signs a release record.
- **Release ordering.** No SDK release built after P3-02 is published before this package's
  Worker is deployed with a clean check (plan §7). The schedule puts this package by week 6.25
  and the first wave package by week 6.5.
- **The D1 check is a human step.** Skipped, a stored value that trips the new rules becomes a
  pruned config value or a `500` on that product's licence documents, for v3 clients too.

## Steps

1. Confirm `plans/P3-01.md` is merged and P3-02 is `done`; branch
   `wp/P3-12-worker-representability`; set `in-progress`.
2. `StrictJsonError`, the `signJws` guard and `signDoc`'s integer guard; `signTrustManifest` on
   `signDoc`; integer arithmetic in the builders.
3. `representabilityIssue` and `validateEntryValue`; the manifest rule with rule 9's three parts;
   the exported patterns.
4. The admin write checks, OIDC handling and `500 document_not_representable` on every signing
   route; the two codes in `errors.json`; regenerate the docs.
5. `check:representable` with its local-D1 test and the RUNBOOK step.
6. The capability table import and its equality test; THREAT-MODEL §3.
7. Run the green gate, including workerd. Set `in-review`.

## Corrections from the code (recorded by P3-12)

- **No log line on a refusal.** Plan §2.2 asks for `500 document_not_representable` "logged with
  the product and `typ`". The Worker logs nothing, by a tested invariant
  (`test/attack/R12-secrets.test.ts`, "no console.\* logging anywhere in packages/worker/src"),
  and the value that trips the guard may be a secret. The routes answer the code without a log;
  the bundle mint's message names the `typ`, and the product is in every route's URL.
- **`value_not_representable` is registered through the Worker's `ErrorCode`.** The constants
  generator does not scan `src/admin/` (the console API is not an SDK surface), where the write
  checks live, so both new codes are `ErrorCode` members in `core/errors.ts`, which the generator
  reads.
- **`signJws` also refuses a payload that is not an object.** The plan says `JSON.stringify`
  cannot break any strict-JSON rule but 5, 7, 8 and 9; it can break rule 3 (a scalar payload).
  The guard runs `scanStrictJson` over the serialized text, which refuses that too. Nothing in
  the Worker signs one; `attack.test.ts`'s scalar vector now signs raw segments.
- **The capability change moves two kind-change tests.** Under wire v4's table `web` updates
  through the platform (`binaryUpdates: none`), so `web → altstore` widens and is no longer the
  example of a narrowing kind change; `test/distributionOutlets.test.ts` uses `direct → altstore`.
- **Also checked at write**, beyond the inventory: the console's catalog publish and manual
  product create refuse a catalog whose defaults or entry keys no document could carry, and an
  OIDC provisioning hook whose claim `encodeURIComponent` cannot encode (a lone surrogate) is
  skipped instead of failing sign-in. The prune would drop an unsignable default at signing,
  but it checks no key, and `new Catalog(...)` applies no key rule: an entry key is a member
  name in `config.<key>`, `secrets.<key>` and `entitlements.<key>`, so a key holding U+0000
  would make the signer guard refuse every config document of the product, and two keys equal
  after NFC would sign a document Swift reads differently. Both write paths therefore run
  `catalogKeyIssue` (shared-catalog: lone surrogate, U+0000, two keys of one kind equal after
  NFC; `422 value_not_representable`) and the manifest's own `ID_RE` on every key
  (`422 bad_request`), and `check:representable` applies `catalogKeyIssue` to the active
  `product_schema.catalog_json` row (found in review).
- **`check:representable` reads only the active catalog** (`product_schema` rows with
  `active = 1`), the only one whose defaults reach a document, and reports a JSON column that
  does not parse as a warning, not a blocker (the Worker ignores such a column).

## Acceptance criteria

- [x] `signJws` throws `StrictJsonError` on a payload with a lone surrogate, a U+0000 member name,
      a number out of range or 65 levels, and `signDoc` throws it on a licence whose `graceUntil`
      is `1700000000.5` or `-1`; the licence and config document routes, the trust manifest, the
      bundle mint and the edge mint each answer `500 document_not_representable` in their own
      body shape instead of throwing.
- [x] A licence override and a profile payload carrying `"\ud800"`, a `"a\u0000b"` member, two
      canonically equivalent sibling names, `1e-320` or 33 levels, and a licence name or tier
      label with a lone surrogate, are refused with `422 value_not_representable`; such a stored
      config value is pruned from the config document; an OIDC sign-in whose provider sends a
      lone surrogate in `name` stores a null name.
- [x] The admin handlers answer `422 bad_request` to a tier id, a channel, a `minVersion` or a
      `maxVersion` outside the manifest's pattern, a product `signingKid` outside `KID_RE`, a
      `policyDeviceLimit` above `MAX_WIRE_INTEGER`, and an offline-day count that is not an
      integer from 1 to 365.
- [x] `check:representable` reports a seeded bad row in each of its 21 columns, and a warning for
      each of its two warning columns, in a local D1, and nothing on a clean one.
- [x] The Worker's capability table, `OUTLET_CAPABILITY_DEFAULTS` and `outlet-matrix.json#/kinds`
      are equal, and a stored override wider than a narrowed default reads back narrowed.
- [x] The green gate passes (`AGENTS.md`), including schema-parity (rule 9), the generated-reference
      gate, the constants gate and the workerd smoke job.

## Verify

```sh
mise exec node@22 -- pnpm build
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm test
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm format
```

## Hand-off

- `StrictJsonError`, the two signer guards and `representabilityIssue`, which every later Worker
  package that signs or stores operator data relies on.
- `check:representable` and its RUNBOOK step, which the operator runs before this Worker's first
  production deploy.
- The role agent sets `--set P3-12 in-review` when it hands off. After review, the lead adds the
  last commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-12 done`.
