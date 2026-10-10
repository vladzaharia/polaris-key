# I-30 Connections: one OIDC relying-party client, verified domains, identifier routing

| Field       | Value                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                                                                                                                                                                                          |
| Size        | 2.5–3.5 engineer-weeks                                                                                                                                                                                                                                                                     |
| Depends on  | [I-27](I-27-plan-identity-consolidation.md), [P0-15](P0-15-platform-primitives-duplicate-helper.md)                                                                                                                                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-13](I-13-exchange-endpoint.md), [I-29](I-29-retire-product-account-toggles-one-app.md), [I-31](I-31-platform-connections-setup-wizards.md), [I-32](I-32-product-connections-absorbs-i-22.md), [ST-32](ST-32-sso-rules-admingroup-conversion.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                                                                                                         |
| Gates       | `migration`, `table-owners`, `threat-model`, `rule-10`                                                                                                                                                                                                                                     |
| Human input | none                                                                                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                  |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-03** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

- Owner 2026-10-07: no compatibility window. The Pocket ID env override goes in the same release that seeds Pocket ID as a platform connection (`tracks.md` rule 6).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: connections carry `audience: customers | operators | both`. It refuses `operators` and `both` from a console write until ST-32 adds the Superadmin-only gate; its `source: env` seed is exempt. A platform-connection link created through an operator connection gets `strong_at` (SM-3(b)). Its `/callback` writes `groups_json`, `claims_json` and `asserted_at` in one `UPDATE`.
- [`plans/I-27.md`](../plans/I-27.md) §12: §2.3 in full: `/callback` through `platformSignInPolicy` and `beginProviderSignIn`; the vouch rule on the gate paths only, with the legacy engine unchanged; `amr` and `claims_json` (access-rule claims only), with no birth date on links; `createLocalJWKSet`, the DNS-over-HTTPS host and exact domains; the seed job and secret custody; the seeded row as the only source, with no env-override window (its backlog scope's "at least 30 days … 14 days" goes); only platform connections can be operator connections; auto-link per Q1 (owner, 2026-10-08: a platform connection on a DNS-verified domain, an exact match on an address verified on exactly one account, an email to that account and an audit row), and the join offer for every other case.

## Corrections from the code (2026-10-10, the I-30 builder)

- **The scope line above is superseded where the approved plans say so.** The seeded Pocket ID
  row is the only source from this release, with no env-override window (I-27 §12). The env trio
  stays set only for the legacy engine (`services/identity/oidc.ts`) until I-32b.
- **The seeded audience is `both`.** I-27 §2.3 derived `operators` from
  `PLATFORM_OIDC_MIGRATION=operators-only` or a past sunset. The owner's Q3 (2026-10-08) keeps
  Pocket ID a connection with audience `both` and withdraws the sunset, so the seed always writes
  `both`. While the switch is still read, I-17's policy applies at `/login` and `/callback`
  instead: `ended` refuses, and `operators-only` refuses an unknown subject.
- **P0-49's runner does not exist yet.** `seed-platform-connection` is built as its three steps
  (`planPlatformConnectionSeed`, `applyPlatformConnectionSeed`, `downPlatformConnectionSeed` in
  `services/identity/connections/seed.ts`). Until the runner lands, the apply runs idempotently
  on first need: from `/login`, `/callback` and `/api/capabilities`. It never overwrites an
  existing row. It seeds nothing when `PLATFORM_KEK` will not seal the secret.
- **ST-30's `asserted_at` is not on main.** `/callback` writes `groups_json` and `claims_json` in
  one `UPDATE` (`portal/repo.ts` `recordLinkAssertion`). ST-30 adds `asserted_at` to that
  statement when it lands.
- **The console's IdP (`ADMIN_OIDC_*`, falling back to `PLATFORM_OIDC_*`) is not a seeded row.**
  It is ST-30's `console-idp`, and moves onto the one client as an issuer-configured relying
  party.
- **Q1 is decided** (owner, 2026-10-08), so the auto-link is built, not deferred. The join offer's
  proof code stays allowed on an enforced domain for every other case.
- **The portal HTML routes are narrative-only in `routeCoverage`.** These are `portalLogin`,
  `portalProviderSignIn` and `portalCallback`. `/login/sso/<id>` routes under
  `portalProviderSignIn`, so rule 10 adds no path. The `next` member and the `method` field of
  `POST /api/signin/email/start` are in the spec (`CardSsoNext`).
- **The migrations are named `00XX_identity_connections.sql` and `00XX_account_links_claims.sql`.**
  The lead numbers them at merge. Until then `test/checkRepresentable.test.ts` applies them first,
  because wrangler's order parses `00XX` as 0. So that one test fails on this branch and passes
  once they are numbered.

## Continuation (2026-10-10): what this branch leaves

Built and tested: the two migrations and their down scripts; `TABLE_OWNERS`; the one client
`core/oidc/client.ts`, with all six sites moved onto it; the Core reader
`core/oidc/connections.ts`; DNS TXT domain proofs over DNS-over-HTTPS with the daily re-check;
identifier-first routing with enforce; `connectionVouchesForEmail`; `/login/sso/<id>`; the
generalised `/callback`; `groups_json` and `claims_json`; `amr` `connection:<id>`; Q1's auto-link;
the seed job; card capabilities `auth.connections`; the THREAT-MODEL and PRIVACY rows.

Left for a follow-up slice (same package, or split by the lead):

1. **The docs pages** (acceptance item 4):
   - its part of `features/sign-in/*`;
   - `operate/platform/connections`, which today holds only store connections;
   - `help/work-account`, `help/account` and `help/connected-apps`;
   - removing the React cookie note (`build/sdks/react/index.mdx:11`).
2. **The card UI** (`packages/admin/src/portal/pages/SignInPage.tsx`):
   - render `next: {kind: "sso"}` from `email/start`;
   - "Use a code" through `resend`;
   - the `auth.connections` buttons ("Continue with <label>"), linking `/login/sso/<id>?login_hint=…`.

   The mockups are `identity.sign-in-routes` and `identity.sign-in`. The console screens are I-31's.

3. **The I-17 modes as connection settings** (scope line): not built. The switch is still read
   from the env for the seeded row's policy and the legacy engine, until I-32b.

## Goal

Connections: one OIDC relying-party client, verified domains, identifier routing, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-03** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **IX-03**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- identity_connections and identity_connection_domains; one RP client core/oidc/client.ts (discovery, JWKS cache, PKCE, state, nonce, RFC 9207 iss, ID-token verification, SSRF gate) replacing the copies in admin/auth.ts, portal/auth.ts, oidc.ts and providers/{google,apple}.ts (Steam OpenID 2.0 stays separate); DNS TXT domain verification re-checked daily, failing closed; identifier-first routing in POST /api/signin/email/start (enumeration-safe, rate-limited); per-domain enforce; account_links.groups_json; a domain-verified connection vouches email_verified only inside its domains; Pocket ID's env trio seeded as a platform connection (env stays an override for at least 30 days, removed after 14 days with no env-path sign-in; P0-24 ledger); I-17's modes become connection settings; magic link always available unless a domain is enforced.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-03**; DX consolidation F: Identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 10 mockup item(s):** `admin.confirm-step-up`, `identity.connection-audience`, `identity.connection-enforce`, `identity.connection-new-failed`, `identity.connection-new-start`, `identity.connection-new`, `identity.connection`, `identity.connections`, `identity.sign-in-routes`, `identity.sign-in`.

## Acceptance criteria

- [x] Six OIDC RP code sites become one (grep: `test/oidcClient.test.ts`)
- [x] An unverified domain never routes (test: `test/connectionRouting.test.ts`, `test/connectionDomains.test.ts`)
- [x] THREAT-MODEL section: domain trust, rogue issuer, group injection
- [ ] Docs, in this PR (not done: Continuation item 1) ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-30 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-30 done`.
