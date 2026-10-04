# A-18a Storefront adapter layer: the shared adapter contract, the store-agnostic gate, `store_operations`, budgets and the conformance harness

| Field       | Value                                                                                                                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                                                                                                                                                                                                                                   |
| Size        | 1–2 engineer-weeks                                                                                                                                                                                                                                                                                                                           |
| Depends on  | [A-17a](A-17a-asc-write-substrate.md)                                                                                                                                                                                                                                                                                                        |
| Unblocks    | [A-18b](A-18b-listing-model.md), [A-18e](A-18e-play-adapter.md), [A-18f](A-18f-msstore-adapter.md), [A-18g](A-18g-steam-adapter.md), [A-18h](A-18h-ci-plane-adapters.md), [A-18i](A-18i-pr-plane-generators.md), [A-18j](A-18j-console-storefronts.md), [A-18k](A-18k-storefront-live-verification.md), [A-18m](A-18m-apple-listing-push.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                           |
| Plan mode   | no: Worker-internal; no `shared-protocol`, `shared-jws`, `client-core`, signed document, `PROTOCOL_VERSION` or corpus change                                                                                                                                                                                                                 |
| Gates       | D1 migration and `TABLE_OWNERS`; THREAT-MODEL edit (S-15 §9); the adapter conformance suite and every spec classification as required CI checks; `boundaries.test.ts`                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                    |

## Goal

One modular adapter layer exists, and every storefront and every package feed is an instance of it.
`core/adapters/contract.ts` defines the shared base (`Adapter`, `Capabilities`, `Support`,
`RateSpec`, `SpecPin`). `core/storefront/` holds the store-agnostic gate engine, ledger, budget,
audit projection, typed confirmations and deep-link table, generalised from A-17a's `core/asc/*`.
A-17a's App Store rules are the first adapter's rule table, moved unchanged, and the Apple adapter
is registered. The ledger is `store_operations`. The feeds' `RegistryRenderer` becomes a
`FeedAdapter` on the same base. The conformance harness runs over every registered adapter in CI.
No new store is added here.

## Why

The owner asked on 2026-10-04 for provisioning on every storefront to be easy, through one common
layer that abstracts each store's responsibilities and capabilities, so that adding a storefront is
easy; the feeds system must follow the same pattern
([S-15 §1 item 4, §6](../../notes/S-15-storefront-provisioning.md#6-the-common-layer)). A-17a has
already built a deny-by-default gate, a ledger and a budget for App Store Connect. S-15 found that
most of it is store-neutral apart from names (§2, §6.2). Forking it per store would leave several
gates to keep in step. Generalising it once leaves one.

## Read first

- `AGENTS.md` (the green gate, the eleven hard rules) and `CLAUDE.md`.
- [notes/S-15](../../notes/S-15-storefront-provisioning.md): the owner-decisions header, §2, §5.4,
  **§6 in full**, §9, §11 (A-18a and "Changes to the A-17 packages") and §13.
- [notes/S-14](../../notes/S-14-asc-provisioning.md) §7 (write discipline) and §12 decision 1 (the
  Admin key, so the gate is the only barrier).
- A-17a's code (`packages/worker/src/core/asc/{writeGate,writeGateDenied,ledger,budget,audit,client}.ts`,
  its ledger migration and `ascWriteGate.test.ts`), on `main` if merged, otherwise on
  `wp/A-17a-asc-write-gate`.
- The feeds renderer contract: `packages/worker/src/services/distribution/registry/{materialise,index}.ts`
  (`RegistryRenderer`, `RENDERERS`) and the per-protocol capabilities in
  `packages/worker/src/admin/lib/feedModel.ts` (F-11 correction 3).
- A-16: `packages/worker/src/core/{platformCredentials,platformStoreSettings}.ts`,
  `services/distribution/connectors/{platformApps,platformFallback}.ts`.
- `docs/security/THREAT-MODEL.md` §2 and §9.

## Scope

**In:**

- `core/adapters/contract.ts`: `Plane` (`worker`, `ci`, `pr`), `Support` (`api`, `ci`, `pr`,
  `deep-link`, `unsupported`), `RateSpec`, `Capabilities<Op>`, `SpecPin`, `Adapter<Id, Op>`, as
  sketched in S-15 §6.1.
- `core/storefront/adapter.ts`: `StorefrontOp` and `StorefrontAdapter` (S-15 §6.1), plus the
  adapter registry (one line per adapter).
- `core/storefront/gate.ts` (the engine), `match/{jsonapi,json,form,multipart}.ts` (the body
  matchers) and `rules/appStore.ts` (A-17a's `ASC_WRITE_ALLOW`, deny classification and spec pin,
  moved with their contents and tests unchanged). See §6.2 for what the engine holds.
- `core/storefront/{ledger,budget,audit,confirm,deeplinks}.ts`, generalised from A-17a:
  `performAscWrite` becomes `performStoreWrite`, the budget takes the adapter's `RateSpec`, the
  audit projection is keyed by `(store, resource type)`, and the deep-link table holds
  `{id, store, template, params, verify}` (§6.3–§6.5).
- **The ledger `store_operations`** with `store`, `vendor_status`, `vendor_code` and `plane`
  (`worker`, `ci`, `pr`, `deep-link`), and `op_id = sha256(store|scope|product|op|natural_key|idempotency_key)`.
  If A-17a merged with the rename (owner decision 3), add only `plane`. If it merged as
  `asc_operations`, carry a rebuild migration that renames and backfills `store = 'app-store'`.
  `TABLE_OWNERS` follows.
- The Apple adapter (`StorefrontAdapter` for `app-store`), declaring A-17's operations against
  the moved rules. A-17b–e call `performStoreWrite`: an import change, no behaviour change.
- `FeedAdapter` as `RegistryRenderer` plus the shared base. Each ecosystem declares its
  `FeedOp` support; the per-protocol table in `admin/lib/feedModel.ts` is replaced by these
  declarations, so `unsupported_by_ecosystem` becomes a declared `unsupported` with its reason. The
  admin API's error code does not change.
- `test/storefront/conformance.test.ts`: the harness of S-15 §6.6, items 1–10, running over the
  Apple adapter (and the Play lease item as a skipped placeholder until A-18e), and items 3 and 7
  over every `FeedAdapter`.
- The CI command allow-list **type** and its conformance check (§6.2), with no CI adapter yet
  (→ A-18h fills it).
- THREAT-MODEL edits from S-15 §9: the new assets, the controls (a)–(g), and the §9 review
  triggers (any `core/storefront/rules/*` table, a new adapter, a new spec pin, the CI command
  allow-list).
- The research README amendment of owner decision 2: [`../README.md`](../../README.md) decision 7 gains "listing
  assets may be pushed by the Worker from the blob store; binaries never".

**Out** (and where it belongs instead):

- The listing model (→ A-18b). Any new store's rules or client (→ A-18e, A-18f, A-18g). CI and PR
  planes (→ A-18h, A-18i). Console (→ A-18j). Widening the Apple surface (→ A-18m).
- A new outlet kind of any sort, including Epic (owner decision 8): that is a wire change and plan
  mode.

## Design notes

**Owner requirements this package carries:**

- **One recognisable integration pattern.** `StorefrontAdapter` and `FeedAdapter` both extend
  `Adapter<Id, Op>` from `core/adapters/contract.ts`. Adding a storefront or a feed is one
  directory plus one registry line and adds no console code; the console renders `Support`, never
  store knowledge (S-15 §6.1). Adapter ids are Worker-internal and map to one or more existing
  outlet kinds; "adding a storefront" must not need a new outlet kind wherever one fits (§4.4).
- **Generalise A-17a's gate; do not duplicate it.** There is one engine. A-17a's rule table, deny
  list, spec pin and tests are moved, not rewritten, and only their imports change. A reviewer
  checks the diff of `rules/appStore.ts` against A-17a's table is a move.
- **The ledger is `store_operations`** (owner decision 3).
- **Typed confirmation for submit, release and price changes, on every store.** The engine keeps
  A-17a's rule: a rule marked `confirm: "typed"` refuses without `typedConfirmation: true`, so a
  handler that forgets to compare cannot send. The phrase is an adapter property: the app's name as
  the store reports it (§6.4). The initial price on a new product stays `initial`.
- **Never delete, never manage users, never touch payments or signing keys.** The engine asserts
  that no rule allows a `DELETE`; the conformance suite asserts each adapter's never-list
  (`DELETE`s, user and permission paths, signing-key paths, refunds and other payment actions) is
  unreachable through its gate and its CI command allow-list (§6.6 item 2).
- **Decision 2: listing assets from the Worker, binaries from CI.** The `multipart`/`blob`
  matcher enforces a content type and a size cap per adapter, and no adapter declares `api` for
  `uploadBuild`; build uploads are `ci` only.

**Constraints:**

- The engine is consulted before the token thunk: a refused request mints no token (§6.6 item 5).
- Callback URLs are fixed server-side to the Worker's origin (A-17a's `hookOrigin` rule,
  generalised).
- The budget's spend classes (`poll`, `background`, `operator`) and tiers stay as A-17a defined
  them. Steam's `RateSpec` will set `stopOn403`; the engine must support it now.
- Where the shared declaration lives so the CLI can import it (S-15 §6.1 leaves the choice here):
  a new internal, dependency-free package or a generated JSON. Not `shared-protocol`, which is
  wire. Record the choice in this brief.
- `boundaries.test.ts`: `core/adapters` and `core/storefront` import no service; services import
  them.

## Steps

1. Contract and registry, with types only, and the `FeedAdapter` declarations over today's
   renderers (no behaviour change; `feedModel.ts` reads them).
2. Move the gate engine, matchers and A-17a's rules; keep `ascWriteGate.test.ts` green unchanged.
3. Ledger, budget, audit, confirm and deep links; the migration and `TABLE_OWNERS`.
4. The Apple adapter and the A-17b–e import switch.
5. The conformance harness; wire it and the spec classification as required CI checks.
6. THREAT-MODEL and README decision 7 amendments.

## Acceptance criteria

- [ ] `core/adapters/contract.ts` exists; `StorefrontAdapter` and `FeedAdapter` both extend its
      `Adapter`. Every feed ecosystem declares its capabilities; the admin feeds API answers as
      before (worker tests unchanged).
- [ ] A-17a's rule table and its tests are moved into `core/storefront/rules/appStore.ts`, with
      no change to their contents; there is one gate engine in the tree.
- [ ] The ledger is `store_operations` with `store`, `plane`, `vendor_status` and `vendor_code`;
      `TABLE_OWNERS` updated; the migration takes its number in merge order.
- [ ] The conformance suite runs over the Apple adapter and every feed adapter, and is a required
      check. It fails if a rule allows a `DELETE` or a never-list path, if an `api` op has no rule
      or a rule no op, or if a typed step passes without confirmation.
- [ ] THREAT-MODEL carries the S-15 §9 additions; README decision 7 carries decision 2.
- [ ] No ASC behaviour changes: every existing A-17 and P5-02 test passes unchanged.
- [ ] The green gate passes (`AGENTS.md`), including `gen:transcripts -- --check`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- storefront asc feeds boundaries routeCoverage
mise exec node@22 -- pnpm -r typecheck
```

## Hand-off

- A-18b builds the listing model on `core/storefront/adapter.ts`'s `ListingProfile` slot.
- A-18e, A-18f and A-18g each add one directory, one rule table and one registry line.
- A-18h fills the CI command allow-list type; A-18j renders `Support` as capability badges, for
  storefronts and feeds alike.

The role agent sets `--set A-18a in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18a done`.
