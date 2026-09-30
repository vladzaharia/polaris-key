# P5-01 Outlet-credential custody and shared JWT signing (ES256, RS256)

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                 |
| Size        | 1–1.5 engineer-weeks                                                                                                                                           |
| Depends on  | [P2b-01](P2b-01-distribution-service.md)                                                                                                                       |
| Unblocks    | [P5-02](P5-02-asc-connector.md), [P5-03](P5-03-play-connector.md), [P5-04](P5-04-msstore-connector.md)                                                         |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | threat model; D1 migration + `TABLE_OWNERS` (the generated data-model page, `docs gen:check`); edge-mint and GitHub App tests stay byte-stable; `test:workerd` |
| Human input | none (real credentials arrive with P5-02, P5-03 and P5-04)                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

Store credentials (an App Store Connect `.p8`, a Google service-account key, a Partner Center
client secret) live in their own KEK-sealed table under a new AAD kind, `outlet-credential`. Only a
platform admin can write them, through a write-only API. Only one Core accessor can open them, and
it audits every use; a test proves that only the `distribution` service reaches that accessor, and
that neither `openProductSecret` nor edge-mint can. One `core/jwt.ts` holds the ES256 and RS256 JWT
signers that edge-mint, the GitHub App client and the store connectors all use, with the Google
JWT-bearer exchange and a sealed token cache beside it.

## Why

- Edge-mint opens **any** product secret by name (`packages/worker/src/services/config/mint.ts:228`)
  for any device of the product, and under `open` registration anyone can be a device. A `.p8`
  stored as a product secret would become a public App Store Connect token mint (report
  [§0.4](../../README.md#04-findings-that-should-change-plans-now) item 5,
  [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #5).
- The custody rules are decided in
  [§3.8](../../README.md#38-distribution-distribution-service) ("Connectors and credential
  custody"): own table, unreachable from `openProductSecret` and edge-mint, platform-admin writes,
  every use audited, least privilege.
- RS256 is written twice today: `rsaToPkcs8` + `signRs256` in `services/config/mint.ts:77-142`, and
  `toPkcs8` + `signAppJwt` in `services/release/githubApp.ts:67-121`. ES256 lives only in
  `mint.ts:93-116`. The store connectors would make a third and fourth copy.
- Note: the header comment of `githubApp.ts` (line 7) says the App JWT is ES256; the code signs
  RS256 (`githubApp.ts:101`). Fix the comment while moving the code.

## Read first

- `AGENTS.md`, `CLAUDE.md`; `docs/security/THREAT-MODEL.md` §2 (assets A1–A9) and §9.
- [README §3.8](../../README.md#38-distribution-distribution-service), notes/E1 §A1 ("Authentication
  (JWT)"), notes/E2 §A1 ("Auth: service account + JWT, from a Worker").
- `packages/worker/src/keyvault.ts` (`SealContext` at lines 65-69, `aad` at 74-78) and
  `src/core/platform.ts` (the façade services import it through).
- `src/core/products.ts:146-164` (`openProductSecret`), `src/services/config/mint.ts`,
  `src/services/release/githubApp.ts` (`installationTokenSlot`: the sealed KV token cache to copy).
- `src/admin/handlers/products.ts`: `SEALED_TABLES` (418-433), `kekCounts` (533), `resealSweep`
  (605), `handleSecrets` (846); `src/admin/repo.ts:63` (`deleteProduct`); `src/admin/authz.ts`.
- `packages/admin/src/views/products/SecretDialog.tsx` and
  `packages/docs/src/content/docs/admin/secrets-and-keys.md`.
- Tests: `test/keyvault.test.ts`, `test/edgeMint.test.ts`, `test/boundaries.test.ts`,
  `test/attack/R12-secrets.test.ts`; `packages/docs/scripts/gen-reference.mjs:248` (`TABLE_OWNERS`).

## Scope

**In:**

- Migration (next free number; 0021 is the latest today) creating `outlet_credentials`:

  ```sql
  outlet_credentials(product, credential_id, kind, outlet_id, enc_value_json, meta_json, status,
                     created_at, created_by, rotated_at, expires_at,
                     last_used_at, last_ok_at, last_error)
  -- PRIMARY KEY (product, credential_id); product REFERENCES products(slug)
  ```

  `meta_json` holds non-secret display fields only (key id, issuer id, client email, tenant id).
  Add the table to `TABLE_OWNERS` under `core` and regenerate the data-model page.

- `SealContext.kind` gains `"outlet-credential"`; the AAD is
  `pkey:v2:<product>:outlet-credential:<credential_id>`.
- `src/core/outletCredentials.ts`: `putOutletCredential`, `listOutletCredentials` (metadata only),
  `deleteOutletCredential`, `openOutletCredential(env, db, product, credentialId, use)` returning a
  parsed, kind-typed value, and `recordOutletCredentialResult(…, ok | error)` for health.
- Kinds and value validation:
  - `asc-api-key`: `{keyId, issuerId, p8}`;
  - `asc-webhook-secret`: `{secret}`;
  - `google-service-account`: the Google JSON key (keep `client_email`, `private_key`,
    `token_uri`);
  - `ms-partner-center`: `{tenantId, clientId, clientSecret, sellerId}`.

  Later kinds are added by the packages that need them (P6-01, P6-02, P6-03).

- Admin API in Core's product-scoped handler, beside `secrets`:
  `GET /manage/api/products/<slug>/outlet-credentials` (metadata and health, never values),
  `PUT …/outlet-credentials/<id>` (write-only, echoes the id only), `DELETE …/<id>`. Audited as
  `outlet_credential.set` and `outlet_credential.delete`. Admin routes are narrative-only for
  rule 10 (`adminApi` in `test/routeCoverage.test.ts`).
- A minimal console form modelled on `SecretDialog.tsx` plus a metadata list (kind, outlet, created,
  last used, last result). Document it in `admin/secrets-and-keys.md` (no new page, so the help-link
  tables need no change).
- KEK rotation: add the table to `SEALED_TABLES` so `resealSweep` and `kekCounts` cover it.
- `deleteProduct` deletes the product's outlet-credential rows in the same batch.
- `src/core/jwt.ts`: `signJwtEs256` and `signJwtRs256` (PKCS#1 or PKCS#8 PEM), moved from `mint.ts`
  and `githubApp.ts`, which then import them. Output bytes unchanged.
- `src/core/outletTokens.ts`: `ascToken(cred, now)` (ES256, header `kid`, claims `iss`,
  `aud: "appstoreconnect-v1"`, `exp - iat ≤ 1200`, reused until 60 s before expiry) and
  `googleAccessToken(env, cred, scopes, now, fetchImpl)` (RS256 assertion, `aud`
  `https://oauth2.googleapis.com/token`, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`,
  cached in KV sealed under kind `outlet-credential`, id `token:<credential_id>:<scope hash>`, TTL
  `expires_in - 300`). Export the sealed-cache helper so P5-04 can cache Entra tokens the same way.
- `test/outletCredentialReach.test.ts`: only `src/services/distribution/**`,
  `src/core/outletTokens.ts` and the Core admin handler import `core/outletCredentials`; no file
  outside that allowlist names the `outlet_credentials` table.
- Threat model: a new asset row (outlet credentials), the boundary, and a review trigger.

**Out** (and where it belongs instead):

- Any connector and any call to a store API (→ [P5-02](P5-02-asc-connector.md),
  [P5-03](P5-03-play-connector.md), [P5-04](P5-04-msstore-connector.md)).
- Entra client-credentials tokens for Partner Center (→ P5-04, using the cache helper).
- The full console "Outlets and credentials" view with webhook health and the key inventory
  (report §6.2 item 3; no work package owns it yet).
- Edge-mint's own hardening (→ P0-12). If P0-12 has landed, rebase onto it; do not redo it.

## Design notes

- **Separation is by AAD, not only by table.** A blob copied from `outlet_credentials` into
  `product_secrets` must fail to open, because its AAD kind differs. Test it.
- **Platform admin is the only admin.** `src/admin/authz.ts` has exactly one privilege level; the
  rule "written only by a platform admin, never from a manifest" means: no manifest ingest path,
  no resync path, no service `manifestIngest` hook may write this table.
- **Audit every open**, with `actor_sub` `system:distribution`, action `outlet_credential.use`, and
  the `use` string (e.g. `asc:poll`). Token caching keeps this to tens of rows a day per credential.
  Admin writes use the session's actor, as `handleSecrets` does.
- **Never log or return a value.** Errors from `open` are reported as "unusable credential", like
  `openProductSecret`'s fail-closed contract.
- **`core/jwt.ts` is signing only.** Keep the hand-rolled WebCrypto code; do not switch to `jose`'s
  `SignJWT` here, because `edgeMint.test.ts` pins header shape and key order.
- **Least privilege** is documented per kind in the admin docs: ASC team key with the App Manager
  role; a Google service account invited to one app with release permissions only; a Partner
  Center app with the Manager role.

## Steps

1. Migration, `TABLE_OWNERS`, `SealContext` kind, `core/outletCredentials.ts` with unit tests.
2. Admin API, `SEALED_TABLES`, `deleteProduct`, audit; tests in `test/outletCredentials.test.ts`.
3. `core/jwt.ts`; switch `mint.ts` and `githubApp.ts`; keep `edgeMint.test.ts` and the GitHub App
   tests unchanged and green.
4. `core/outletTokens.ts` with a fake token endpoint (injected `fetchImpl`).
5. The reach test and an attack test beside `R12-secrets.test.ts`.
6. Console form, admin docs, threat model; `pnpm --filter @polaris-key/docs gen`.

## Acceptance criteria

- [ ] `outletCredentials.test.ts` covers: write-only PUT (value never echoed, never in `GET`),
      DELETE, audit rows for set, delete and every open, per-kind validation (a `.p8` that is not
      P-256 PKCS#8 is rejected at write), `meta_json` without secret fields.
- [ ] A sealed outlet credential copied into `product_secrets` does not open; an edge-mint recipe
      naming an outlet credential id answers `misconfigured`.
- [ ] `outletCredentialReach.test.ts` fails when a file under `src/services/config/` imports
      `core/outletCredentials`.
- [ ] `GET /manage/api/products/kek` counts the new table, and the reseal sweep re-seals its rows.
- [ ] Deleting a product deletes its outlet credentials.
- [ ] `edgeMint.test.ts` and the GitHub App tests pass unmodified; `ascToken` produces a token that
      verifies with the public key and has `exp - iat ≤ 1200`; `googleAccessToken` caches and
      re-uses a token, and refreshes it after expiry.
- [ ] The data-model page is regenerated and `gen:check` passes; the threat model names the asset.
- [ ] The green gate passes (`AGENTS.md`), including `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- outletCredential edgeMint keyvault
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- `openOutletCredential(env, db, product, credentialId, use)` and the four kinds above are the
  interface P5-02, P5-03 and P5-04 build on; `ascToken`, `googleAccessToken` and the sealed-cache
  helper are theirs to reuse. P6-01, P6-02 and P6-03 add kinds and, for P6-02, one reviewed entry
  in the reach-test allowlist.
- `signJwtEs256` and `signJwtRs256` in `core/jwt.ts` are the only JWT signers in the Worker.
- Set the status in the completing PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P5-01 done`.
