# I-01 Identity hygiene: OIDC licence `origin`, portal identities keyed by issuer, threat-model rows, portal-gating docs, drop `authPoll`

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-0, MVI)                                                                                           |
| Size        | 0.2–0.3 engineer-weeks                                                                                                              |
| Depends on  | none                                                                                                                                |
| Unblocks    | none                                                                                                                                |
| Role        | `pkey-implementer`                                                                                                                  |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                            |
| Gates       | D1 migration; `TABLE_OWNERS`; THREAT-MODEL; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; `check:links` |
| Human input | none                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                           |

## Goal

The small, standalone Identity defects S-16 found are fixed before any redesign: fresh OIDC licences carry `origin: "oidc"`, portal identities are keyed by issuer, the stale THREAT-MODEL rows are corrected, the docs match the code on portal gating, and the dead `authPoll` entry is gone from the Identity discovery fragment.

## Why

These are gaps G10 and G14 and threat-model item 11 in S-16. They are wrong today under any option, and owner decision D10 ships them ahead of the plan ([S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps), [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps) (G10, G14), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 11, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-01, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D7 and D10.
- `packages/worker/src/services/identity/oidc.ts` (licence insert near the `activateFromIdentity` path) and `packages/worker/src/repo.ts` (the `origin` default).
- `packages/worker/src/services/identity/portal/auth.ts` (identities keyed `provider: "oidc"`), `portal/repo.ts`.
- `packages/worker/src/services/identity/index.ts:74` (`authPoll` in the discovery fragment).
- `docs/security/THREAT-MODEL.md` (A6 lists the dropped `customers` table; §5 `sub` and `email_verified` rows).

## Scope

**In:**

- Pass `origin: "oidc"` when the OIDC flow inserts a fresh licence, with a test that fails on today's code.
- A D1 migration re-keying portal identities by issuer (not the literal `"oidc"`), backfilling from the configured platform issuer, plus the `TABLE_OWNERS` entry if a table changes owner.
- THREAT-MODEL: drop `customers` from A6; correct the §5 rows to say the product flow requires a non-empty `sub` and `email_verified`; extend T5 to "a product's upstream IdP is malicious".
- Docs and the service summary: per D7, the portal is a platform concern that runs for every product regardless of the Identity flag; make the docs say what the code does.
- Remove `authPoll` from the Identity discovery fragment and re-record transcripts (`discovery-capabilities.json`). Grep every SDK first and record that none reads it.

**Out** (and where it belongs instead):

- Retiring the `/auth/poll` route itself and its rate-limit buckets (→ I-13).
- Any user or link model (→ I-06).
- Atomic single-use consumption (→ I-02).

## Design notes

- Keep the `/auth/poll` route answering; only its advertisement goes. I-13 replaces it with the native redirect token route.
- The migration must be reversible and safe on a production-shaped copy: number it when rebasing, never in advance (program README §5).
- D7 (owner default accepted with "everything"): the portal stays a platform concern. Fix the docs, not the code.

## Steps

1. Write the failing `origin` test, then the fix.
2. Migration and portal-identity code change with tests.
3. Discovery fragment change and `gen:transcripts`.
4. THREAT-MODEL and docs edits; `check:links`.

## Acceptance criteria

- [x] A fresh OIDC licence row has `origin = 'oidc'`; a test proves it.
- [x] Portal identities are keyed by issuer; existing rows are migrated; the portal suite passes.
- [x] THREAT-MODEL A6, the §5 `sub`/`email_verified` rows and T5 are corrected.
- [x] Docs and the service summary state that the portal runs regardless of the Identity flag.
- [x] `authPoll` is absent from discovery; `gen:transcripts -- --check` passes; the PR lists the SDK grep showing no reader.
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Corrections from the implementation

Recorded by I-01 where the code made this brief's text inexact:

- **The backfill cannot live in the migration.** The platform issuer is a Worker secret
  (`PLATFORM_OIDC_ISSUER`), which D1 SQL cannot read. Migration `0059_portal_identity_issuer.sql`
  therefore adds only a data-layer guard (an insert trigger that refuses a `provider` that is
  neither an http(s) issuer URL nor the legacy literal `'oidc'`) and leaves existing rows
  untouched; the Worker re-keys the legacy `provider = 'oidc'` rows to the configured issuer
  (`rekeyLegacyPortalIdentities`, an idempotent `UPDATE OR IGNORE`) before every portal OIDC
  sign-in, ahead of the identity lookup. The guard is expand-only on purpose: `deploy.yml` applies
  migrations before it deploys the Worker, so a pre-I-01 Worker that is still serving (between the
  two steps, or after a failed deploy) or one rolled back to in Cloudflare keeps writing `'oidc'`
  on first-time portal sign-ins, and those must not fail. Such rows are re-keyed at the user's next
  sign-in on the I-01 Worker. Refusing the literal belongs to a later contract-phase migration. The
  column keeps its name (`provider`), so a Worker deployed before the migration keeps working, and
  a Worker rollback needs no SQL; the optional data-shape rollback is in the migration header and
  is exercised by a test. The issuer key is normalised without a trailing slash
  (`portalIdentityIssuerKey`), like every other issuer URL in the flow, so an operator editing
  `PLATFORM_OIDC_ISSUER` only by its trailing slash does not orphan identities.
  No table changes owner, so `TABLE_OWNERS` is unchanged.
- **Transcripts did not move.** `conformance/transcripts/discovery-capabilities.json` records a
  product with Identity off (`"identity": { "enabled": false }`), so it never carried `authPoll`;
  `gen:transcripts` rewrote nothing. The advertisement was pinned instead by
  `test/fixtures/discovery-golden.json` (a sanctioned edit, noted in `discoveryGolden.test.ts`),
  `test/surfaces.test.ts` and the OpenAPI discovery example, all updated.
- **The "service summary"** is `tools/services.json`'s `identity.summary`, regenerated into
  `packages/admin/src/services.generated.ts` with `gen:services`.
- **SDK grep** (no reader of `authPoll`):
  `grep -rniE "authPoll|auth_poll|identity/auth/poll" packages/*/src sdks` outside
  `packages/worker` and `packages/docs` returns nothing (covers `sdks/{godot,kotlin,python,swift}`,
  `sdk-node`, `sdk-react`, `client-core`, `cli`, `admin`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity portal
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- I-06 builds the user model on licences whose `origin` is now trustworthy.
- I-13 retires the `/auth/poll` route.

The role agent sets `--set I-01 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-01 done`.
