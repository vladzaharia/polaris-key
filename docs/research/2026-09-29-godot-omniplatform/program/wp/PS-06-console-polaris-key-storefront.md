# PS-06 Console: Polaris Key hub tile and listing editor through A-18j, the Polaris Key panel (listing, audience, ways to add, group labels), readiness, "Who can see this?" persona preview, analytics card

| Field       | Value                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 3: console)                                                                          |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                 |
| Depends on  | [A-18j](A-18j-console-storefronts.md), [PS-01](PS-01-polaris-key-adapter.md), [PS-02](PS-02-storefront-listing-settings.md), [PS-04](PS-04-storefront-portal-api.md) |
| Unblocks    | [PS-11](PS-11-storefront-closeout.md), [CM-12](CM-12-console-commerce.md)                                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                   |
| Gates       | console CSP parity; docs help-link drift gate; rule 10 (narrative-only admin routes); THREAT-MODEL (admin mutations)                                                 |
| Human input | none                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                            |

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`.

- **Wire the first-party `status` port** ([PS-03](PS-03-obtain-path-engine.md)).
  `core/storefront/firstParty.ts` declares `FirstPartyPorts` (`readListing`, `writeListing`,
  `setListing`, `status`, `audit`), and nothing implements any of them yet. PS-03 built the engine
  `status` reports from: `evaluateObtain`, `storefrontOffers` and `obtainPaths` in
  `services/identity/portal/store/obtain.ts`, with the deployment switch
  `polarisKeyStorefrontEnabled` (`core/storefrontSwitch.ts`). Implement the ports in the services
  that own their tables. `status` answers the listing state, readiness and the offers visible today
  from that engine, so the console panel and the conformance suite's first-party branch read the
  same answer.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Already stamped done on main (2eb10597c); the hygiene PR leaves it. Merged (0226e2824). Its Polaris Key panel re-homes as the Polaris Key channel page's Sales tab in A-22.

## Goal

In the console, Polaris Key appears as a storefront tile with its capability strip, its listing in the shared Listing editor, a Polaris Key panel (listing state, audience, ways to add, group labels), the readiness checklist, a persona-based "Who can see this?" and a 28-day analytics card.

## Why

[S-21 §6.6](../../notes/S-21-polaris-storefront.md#66-the-console-ps-06).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- [A-18j](A-18j-console-storefronts.md) and its shared tile and badge component; `docs/design/ADMIN.md` T3, T4, §5.8.
- PS-01's declaration and readiness; PS-02's settings; PS-04's analytics.

## Scope

**In:**

- Tile and Listing editor via A-18j (no store-specific code beyond the panel).
- The panel (T4 layout, controls right-aligned), with typed confirmation for audience `everyone`.
- Admin routes (narrative-only): `GET /manage/api/products/<p>/storefronts/polaris-key`, `POST …/preview`, `GET …/analytics`; audit rows.
- Persona preview running PS-03's engine on a synthetic in-memory account; no endpoint takes an email or account id.
- ADMIN.md amendment for the panel; help links in both tables.

**Out** (and where it belongs instead):

- Store connections (nothing to connect). Payment providers (→ S-22).

## Design notes

- No "coming soon" or implementation-status copy; no redundant subtitles; a path whose policy is not configured is absent, not disabled.

## Corrections from the code (PS-06 implementation, 2026-10-06)

Recorded under step 1; the code is the fact. Each was decided on the recommended option (decisions
delegated to the lead).

- **The routes are CORE, and the composition root of the first-party ports.** `GET|POST
/manage/api/products/<p>/storefronts/polaris-key[/preview|/analytics]` live in
  `admin/handlers/polarisKeyStorefront.ts` beside the other product-scoped core resources
  (`assets`, `refusals`), because every product can list whether or not it runs Distribution
  (S-21 §6.2) and the panel needs two services. The GET runs the declared `polaris-key.status`
  handler over `FirstPartyPorts` the owning services implement: Identity answers the status
  (`services/identity/portal/store/panelStatus.ts`: listing, policy, the engine's mode rules,
  readiness inputs), Distribution the listing fit (its own `readListing` and Core's `fitReport`).
  This is the "wire the first-party status port" follow-up. `readListing` and `audit` are real
  too; `setListing` and `writeListing` are not served by any route (see the next point), so the
  panel's ports refuse them with a clear error.
- **The panel writes through PS-02's route, not through `submit`.** Listing, audience, ways to add
  and group labels are `PATCH …/identity/portal` (`writeSetting()`, audited
  `storefront.polarisKey.update`), at the levels `lib/actions.ts` now assigns: listing and ways to
  add L1, narrowing the audience and labels L0, widening the audience to everyone L3 with the
  product's slug typed (the brief's and S-21 §6.6's typed confirmation; the Worker still needs its
  `confirm` key, which the console sends). The A-18j flow has no Polaris Key steps (SETUP.md D48:
  the built-in storefront has no wizard), so nothing calls the first-party write handlers yet.
- **SETUP.md §2.10 asks for UX-54's page shell; UX-54 is not registered.** The panel is the
  storefront's own page, a record of the Storefronts page (`distribution/storefronts/polaris-key`,
  one `STORE_PANELS` line), with SETUP's Discover-tab content. UX-54's shell can host it as is.
- **The built-in tile needed a flag and a badge.** The storefront view gains `builtIn` (an adapter
  with no credential whose ops are `first-party`, from the declaration), and `CapabilityBadge`
  gains `first-party` ("Built in"); before this every Polaris Key op rendered "Not offered". A
  built-in tile reads "Built in: always connected" with **Manage**; Add to storefronts leaves it
  out.
- **The persona preview reads no account.** `previewPersona` (in `store/obtain.ts`) runs the engine
  with a synthetic identity and the persona's "holds it" switch; `previewIdentityIssue` gained
  `existing: false` so a synthetic subject is never looked up among licences. `ObtainContext`
  carries the persona, with an empty `accountId`, for PS-07 and PS-09's sources to answer from.
  The route schema is closed (`PERSONA_FIELDS`); `emailDomain` and `stores` are accepted for those
  sources, and the console shows their inputs only once their path kinds are configured (today
  the persona form is the sign-in switch, the mapped groups and "Already has it").
- **The preview tile is the console's, with the portal's words.** PX-16's `DiscoverTile` draws only
  offers with licence terms until PS-05, so the preview renders the same fields (reason line from
  S-21 §6.5's table, terms, action) in a console card from `GET /api/discover`'s offer shape
  (`storefrontTileView`, which records no impression).
- **Readiness for an unlisted product** counts the ways it would offer once listed; otherwise it
  counts what the current mode offers (Automatic: the identity kinds only).
- **Listing editor.** The fit report gains a store switcher kept in the URL (`?store=`); the
  panel's **Edit the listing** opens it on `polaris-key`. `LISTING_GROUP_LABELS` names the
  `polaris-key` slot group.
- **Docs.** A page of its own, `/docs/admin/polaris-key-storefront/` (help links cannot carry
  anchors), linked from Storefronts, the admin index and Identity → Portal's listing section.
- **No migration, no OpenAPI entry** (admin routes are narrative-only); THREAT-MODEL gains "The
  Polaris Key panel and the persona preview (PS-06)".

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-06:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-06 in-review`.

## Acceptance criteria

- [x] The tile renders from the registry (a test with the registry stubbed).
- [x] The preview has no input that identifies a real person (reviewer check, test on the route schema).
- [x] `adminCspParity`, the CSP e2e and `check:links` pass.
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

ST-13 moves the panel into the settings hub with the Listing editor.

The role agent sets `--set PS-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-06 done`.
