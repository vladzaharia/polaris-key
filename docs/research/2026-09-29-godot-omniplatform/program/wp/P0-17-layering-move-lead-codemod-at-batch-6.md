# P0-17 Layering move (lead codemod at the batch-6 boundary)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [HA-12](HA-12-presentation-discovery.md), [P0-15](P0-15-platform-primitives-duplicate-helper.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Unblocks    | [P0-16](P0-16-first-party-respond-body-module-console.md), [P0-18](P0-18-table-ownership-owner-stores-one-audit.md), [P0-19](P0-19-descriptor-contributions-services-slug.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md), [P0-21](P0-21-notification-substrate-core-notify.md), [P0-22](P0-22-request-scoped-product-context-lazy.md), [P0-26](P0-26-core-manifest-ingest-pipeline.md), [P0-27a](P0-27a-store-clients-core-stores.md), [P0-29](P0-29-licence-list-paging-set-queries.md), [P0-30](P0-30-guardrails-test-harness-test-layout.md), [P0-33](P0-33-worker-owned-dto-types-admin-portal-apis.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md), [P0-51](P0-51-1-0-readiness-review.md), [I-28](I-28-accounts-contract-phase.md), [F-33](F-33-personal-tokens-pkeyp-packages-read.md), [ST-05a](ST-05a-one-settings-read-write-path.md), [ST-29](ST-29-admin-route-table-can-usecan.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Gates       | none beyond the green gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-03** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Layering move (lead codemod at the batch-6 boundary), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-03** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.1, §4.2, §4.3, for **CQW-03**.
- [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), for file and line evidence.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- Lead-run codemod in the worker window, as soon as batch 6 has landed on main and P0-15 has merged (the console window, P0-31 and P0-39, runs beside it; P0-44 is a corpus-lane item, not part of either window). P0-16, P0-21, P0-22, P0-29 and ST-05a start after it on the new layout: top-level env/crypto/kv/keyvault/http/securityHeaders/platformOidc/fingerprint/merge into platform/; shared admin/lib/\* and AdminSession into core/ or console/; split admin/lib/shape.ts; delete the 13 re-export shims; core/ domain folders (licensing, accounts, notify, trust, assets, registry, ops); admin/ renamed console/; per-service public.ts; test/boundaries.test.ts made transitive. Open branches merge main once afterwards.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-03**; DX consolidation B: Foundations (code quality the feature tracks build on).
- Run by the lead in a short window (tracks.md rule 2); every package that touches the moved files depends on it, so no branch is in flight across the codemod.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Corrections (verified against the code, 2026-10-10)

- **`merge.ts` goes to `core/licensing/`, not `platform/`.** It type-imports `ManagedPayload` from
  `core/payload.ts` and its only caller is `core/licensing/payload.ts`: it is payload logic, and in
  `platform/` it would import upward.
- **`securityHeaders.ts` and `fingerprint.ts` go to `core/`, not `platform/`.** P0-15 made
  `platform/` a leaf with no package imports (`test/platformPrimitives.test.ts`).
  `fingerprint.ts` imports `@polaris-key/protocol`, and `securityHeaders.ts` hashes the brand
  page style from `core/brandHtml.ts`, which imports `@polaris-key/brand`. Both therefore move to
  `core/`, as does `adminCsp.ts`, which only `securityHeaders.ts` reads. `core/fingerprint.ts`
  is now the real module where the shim used to be.
- **`repo.ts` moves to `core/repo.ts`, `admin/repo.ts` to `core/console/repo.ts`.** Deleting
  `core/data.ts`, `core/ingest.ts` and `core/adminApi.ts` means services import these queries
  directly, so they must sit in a layer a service may import. Splitting them into owner stores
  stays with P0-18.
- **"AdminSession into core" is `core/console/`.** The session (and the revocation check it calls),
  the audit writer, the response envelope, the console's queries, `deviceShape`, `overrides`,
  `writeChecks`, `redact` and `deviceAdmin` are what services' admin handlers share with the
  console; they live in `core/console/`. `managedSecrets.ts` is Config sealing used by Core's
  payload code, so it is `core/managedSecrets.ts`.
- **The Core admin handlers.** `core/bundles.ts` and `core/servicesAdmin.ts` move to
  `console/handlers/`. `blobGc.ts`'s admin endpoints stay in `core/assets/blobGc.ts`: after the
  move they import only `core/console/respond.ts`, which is legal, and splitting the file is not
  a move.
- **`updateHealthDo.ts` moves to `core/`.** `core/updateHealth.ts` imports its constants at
  runtime, so the Durable Object sits beside its client.
- **`core/cors.ts` took `Route` from `router.ts`** (type-only). It now takes a structural
  `CorsRoute`, so Core never imports the composition root.
- **The shape split.** The licence summary is `core/licensing/summary.ts` and the catalog loader is
  `core/activeCatalog.ts`; `productView` and the secrets inventory stay in
  `console/lib/shape.ts` (JSON helpers were already in `platform/json.ts` after P0-15).
- **`core/registry.ts` keeps its name** (the service registry, 57 importers); the package-registry
  modules move into the folder `core/registry/` beside it, file names unchanged.
- **`public.ts` vs P0-19's `api.ts`.** `services/<slug>/public.ts` exists for config,
  distribution, identity and release (the services the console reads) and holds exactly what the
  console imports. P0-19's façades should grow these files (or rename them) rather than add a
  second barrel.
- **The `pkeyci_` mock seam.** `core/ciTokens.ts` existed so the CI-route suites could mock the
  lookup; they now mock `lookupCiToken` on `core/publisher.ts` with `importOriginal`.
- Migration comments that name a moved file are left as they are (migrations are not edited).

### Path map

Every file keeps its basename. `admin/**` not listed below becomes `console/**`.

| Was (`packages/worker/src/`)                                                                                                                                                                                                        | Now                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `env`, `crypto`, `kv`, `keyvault`, `http`, `platformOidc`                                                                                                                                                                           | `platform/`                                              |
| `repo`, `updateHealthDo`, `securityHeaders`, `fingerprint`, `adminCsp`, `admin/lib/managedSecrets` (`core/brandHtml` stays)                                                                                                         | `core/`                                                  |
| `admin/{session,sessionRevocation,audit,repo}`, `admin/lib/{respond,deviceShape,overrides,writeChecks,redact}`, `core/deviceAdmin`                                                                                                  | `core/console/`                                          |
| `merge`, `core/{authz,entitlements,entitledAccess,entitlementEvents,grants,graceClamp,keyEntries,licenseDelete,licenseHolders,licenseMerge,licensingCatchUp,payload,refusals,reservedNames,storeGrants,anchor,gate,manageUrl}`      | `core/licensing/`                                        |
| `core/{accountCookies,accountOverrides,accountSubjects,subjectHooks,identityGate,identityTrust,browserRequestGuard,reservedDisplayNames,syncAccess}`                                                                                | `core/accounts/`                                         |
| `core/{emailDelivery,emailDns,emailLimits,emailSender}`                                                                                                                                                                             | `core/notify/`                                           |
| `core/{trust,trustSigners,deviceTrust,attestation,appAttest,playIntegrity,x509,cbor}`                                                                                                                                               | `core/trust/`                                            |
| `core/{blobs,blobGc,hostedAssets,hostedAssetPulls,hostedAssetUploads,hostedImages,assetHosting,assetQuota,assetSettings,sniff,deltaDemand,imgHost,imgHostname,bytesHost,bytesHostname,bytesLanding}`                                | `core/assets/`                                           |
| `core/registry{Credential,Host,Hostname,Landing,Publish,Queue,Tokens,Vocabulary}`                                                                                                                                                   | `core/registry/`                                         |
| `core/{operations,platformOps,deployIdentity,platformEvents,securityEvents,settingsBackfill,overrideMigration}`                                                                                                                     | `core/ops/`                                              |
| `core/{bundles,servicesAdmin}`                                                                                                                                                                                                      | `console/handlers/`                                      |
| `admin/**` (the rest)                                                                                                                                                                                                               | `console/**`                                             |
| the 13 shims (`core/{platform,data,adminApi,ingest,fingerprint,ciTokens}`, `services/license/{authz,auth,entitlements,gate}`, `services/release/manifest`, `services/identity/portal/headers`, `services/distribution/page/detect`) | deleted (`core/fingerprint.ts` is now the module itself) |

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] Transitive boundary test is blocking (P0-48 seeded it report-only)
- [x] No re-export shim remains
- [ ] Gate green with no behaviour change

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-17 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-17 done`.
