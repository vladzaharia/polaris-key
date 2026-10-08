# P0-12 Harden edge-mint: scope signing secrets and authorise minting

| Field       | Value                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality                                                                        |
| Size        | 0.5–0.75 engineer-weeks                                                                                         |
| Depends on  | none                                                                                                            |
| Unblocks    | [P1-04](P1-04-godot-config.md), [P1b-08](P1b-08-devicecode-edgemint-ports.md)                                   |
| Role        | `pkey-implementer`                                                                                              |
| Plan mode   | no (the device-facing route keeps its wire contract)                                                            |
| Gates       | threat model; D1 migrations; `TABLE_OWNERS` + generated `data-model`; docs `check:links`                        |
| Human input | after deploy, an operator reviews the secrets the migration marked `edge-mint` and approves nothing new blindly |
| Repo        | `vladzaharia/polaris-key`                                                                                       |

## Goal

A `.pkey/` push can no longer turn an arbitrary product secret into a publicly reachable token
mint. Edge-mint signs only with product secrets an operator has marked for edge-minting, and only
with recipes an operator has approved in the exact form they will run. Existing djdl minting keeps
working through the upgrade. The threat model records the new rule.

## Why

Report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #5 (High,
latent) and [notes/A3 §7.3](../../notes/A3-admin-dx.md#73-store-api-credentials-inside-pkey):

- Recipes are repo-authored (`.pkey/product` or `.pkey/release` `edgeMint[]`); the validator
  checks only the shape of `signingKeySecret` (`packages/shared-manifest/src/index.ts:1197-1206`).
- `handleMintToken` opens **any** product secret by that name
  (`packages/worker/src/services/config/mint.ts:226-234`, `openProductSecret` in
  `core/products.ts:146-163`).
- The template may set `iss` and any non-reserved claim; only `iat`/`exp`/`nbf`/`aud` are stripped
  (`mint.ts:168-181`), and `aud` comes from the recipe.
- The route asks only for a device token of the product, plus a usable licence when License is on
  (`mint.ts:214-219`). Under `open` registration anyone can get a device token.

So a repo writer, or a mistaken recipe, can mint tokens from any PEM-shaped product secret. Today
that is djdl's edge-mint recipe; once store credentials exist it would be a public App Store
Connect or Play token mint. The report treats this as a hard design constraint for outlet
credentials (P5-01), and Godot will be the first SDK to call edge-mint for leaderboard and
cloud-save keys ([§5.3](../../README.md#53-transport-persistence-device-identity) "Secrets").

## Read first

- `AGENTS.md` and `docs/security/THREAT-MODEL.md` (§2 A5, §3 "Boundaries that are weaker than they
  look", §5 semi-trusted inputs, §6 property 1, §9 review triggers).
- `packages/worker/src/services/config/mint.ts` (whole file) and `services/config/index.ts:25-45`
  (the discovery `mint.available` bit).
- `packages/worker/src/core/products.ts:146-163`, `packages/worker/src/keyvault.ts` (seal kinds and
  AAD), `packages/worker/src/admin/handlers/products.ts:847-890` (write-only secret PUT).
- `packages/worker/src/services/release/resync.ts:382-400` and `linkRepo.ts` (recipes are
  deleted and re-inserted on every push), `migrations/0001_init.sql:160-170`, `0003_keyvault.sql:22-33`.
- `packages/worker/test/edgeMint.test.ts`, `test/attack/R12-secrets.test.ts`.
- `packages/docs/src/content/docs/services/config/edge-mint.md`.

## Scope

**In:**

- **Scope secrets.** `product_secrets.usage` (`NULL` = general, or `edge-mint`), set only through
  the admin API: `PUT /manage/api/products/<slug>/secrets/<name>` accepts an optional
  `"usage": "edge-mint"`. `openProductSecret` takes a required-usage argument; edge-mint asks for
  `edge-mint`, the OIDC client secret path asks for general. A mismatch reads as "missing" and the
  route returns today's `500 misconfigured`.
- **Authorise recipes.** A new table `edge_mint_approvals(product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience, approved_at, approved_by)`,
  primary key `(product, id)`. The route mints only when an approval exists whose fields equal the
  current `edge_mint_config` row column for column; otherwise it answers exactly like an unknown
  recipe (`404 not_found`). Any push that changes a security-relevant field makes the recipe inert
  until re-approved. Resync deletes approvals for recipe ids the manifest no longer declares.
  _Correction (implementation):_ the table also carries `open_registration_acknowledged`
  (`INTEGER NOT NULL DEFAULT 0`). Whether the mint is public is product state, not a recipe
  column, and a `.pkey/product` push can make it public without touching the recipe in three
  ways: open registration (declare `devices.registration: open`, or turn License off with
  Identity off); enable anonymous `autoIssue` enrolment (`mode` `anonymous`/`both`), which hands
  any caller a licence and a device token from `POST /<p>/license/enroll` while registration
  still reads `requires-license`; or, with Identity on, enable an OIDC default tier (`mode`
  `oidcDefault`/`both`), which licenses every account the IdP signs in. Checking the
  acknowledgement only at approve time would let such a push widen a closed-product approval
  into a public mint, so the flag is stored on the approval and re-checked on every mint: while
  `mintIsPublic(product)` holds, an approval without it does not match (404, reported `changed`
  with `registration` in `changedFields`).
  _Correction (review):_ on a closed product sign-in is a second push-controlled route to a
  device token — `activateFromIdentity` licenses any identity whose groups hit the manifest's
  `groupRoleMap`, against the manifest's issuer and client id. So the table also records the
  sign-in trust the approval was given under: `identity_enabled`, `oidc_provider`,
  `oidc_issuer`, `oidc_client_id`, `oidc_group_role_map_json` (read through the Core seam
  `core/identityTrust.ts`). While Identity is on, an approval matches only if they are unchanged
  (group map compared structurally); otherwise it is `changed` with `identity` in
  `changedFields`. Turning Identity off never invalidates. The approve body echoes `identity`
  (409 if stale). One TypeScript rule, `approvalMismatch` in `core/edgeMintApproval.ts` (re-exported by
  `services/config/mint.ts`), now
  decides for the token route, discovery, the admin list and approve, and the setup checklist
  (the earlier SQL join fragment is gone). The migration backfill records the acknowledgement
  `1` only where the mint was already public at deploy (a SQL mirror of `mintIsPublic` over
  `services_json` and `auto_issue_json`) and `0` everywhere else, and copies the sign-in trust
  as deployed, so a closed product such as djdl keeps minting under today's policy but goes
  inert if a later push makes it public or rewrites its OIDC trust. Residual, recorded in
  THREAT-MODEL §3: the approval trusts the IdP itself — whoever it signs in with a mapped group
  is covered.
  _Correction (second review):_ the mint checks licences only while License is on, and with
  Identity on a push that turns License off keeps the mint closed (`requires-identity`) while a
  device whose licence was disabled or expired mints again. So the approval also records
  `license_enabled`, and while License is off an approval given with it on is `changed` with
  `license` in `changedFields`. And a per-request check alone let a widen-then-revert pair of
  pushes restore the approval while the licences and device tokens issued in between kept
  working, so the manifest ingest makes a product-side widening permanent: resync deletes every
  approval `productWidening` reports (public without acknowledgement, License turned off,
  sign-in trust changed) before its first write and after its last (the last in a `finally`, so a
  push that throws after its widening writes cannot skip it — fourth review), auditing each as
  `config.mint.invalidate`; link deletes every approval row under the slug. _Fifth review:_ a
  `finally` does not run when the Worker is killed after resync's un-batched
  `setAutoIssuePolicy`/`setServices` writes (CPU limit from a manual-channel regex, a cancelled
  webhook), and an approve can race the post-write sweep. So the console sweeps too, before every
  write of an approval input — `core/servicesAdmin.ts` (services PATCH and revert) and
  `services/license/admin/policy.ts` (License policy PATCH with `autoIssue`, and revert); the
  ingest is the only writer of `oidc_config`. The guarantee rests on this pre-write sweep by every
  writer, not on the `finally`. The rule moved to
  `core/edgeMintApproval.ts` because the ingest (Release) may not import Config. Recipe-field
  changes are not swept. Residual (THREAT-MODEL §3): what was issued while widened survives a
  re-approval — the operator reviews the audit log first.
- **Admin API** under Config's admin handler (`services/config/admin/index.ts`):
  `GET /manage/api/products/<slug>/config/mint` (each recipe with status `approved`, `pending` or
  `changed`, its secret's usage, and the product's effective registration policy);
  `POST …/config/mint/<id>/approve` with the recipe fields echoed back (refused if they no longer
  match, so an operator never approves something they did not see) and, when the effective
  registration is `open`, `"acknowledgeOpenRegistration": true` (_correction:_ also when
  anonymous auto-issue enrolment or an OIDC default tier is on — see `mintIsPublic` above — and
  the body also echoes the sign-in trust as `identity`; _correction (third review):_ and whether
  License is on as `licenseEnabled`, `409` with `fields: ["licenseEnabled"]` if it differs and
  `422` if absent — the console warns on the card and in the dialog while License is off, since
  after a License-off push the swept recipe reads plain `pending`);
  `POST …/config/mint/<id>/revoke`. Audit events `config.mint.approve`, `config.mint.revoke`,
  `secret.usage`.
- **Per-device rate limit** in addition to the per-IP one: bucket `mintDevice`, keyed by device id,
  30 per 60 seconds.
- **Discovery:** `config.mint.available` is true only when an approved recipe exists.
- **Console:** an "Edge-mint recipes" card (Config section or the Secrets view) with approve and
  revoke, the open-registration warning, and a usage selector when setting a secret; a setup
  checklist item for pending recipes.
- **Migrations** (numbered on rebase): `ALTER TABLE product_secrets ADD COLUMN usage TEXT;`; the
  approvals table; an idempotent backfill that marks every secret currently named by an
  `edge_mint_config` row as `edge-mint` and copies every current recipe into `edge_mint_approvals`
  (`approved_by = 'migration'`), so deployed products keep minting.
  _Correction (implementation):_ the lead pre-assigned the number `0025`, so the two files use
  the lettered-suffix convention of `0022_*`: `0025_a_product_secret_usage.sql` (the bare
  `ALTER`, alone in its file) and `0025_b_edge_mint_approvals.sql` (the table plus both
  idempotent backfill statements), which sort and apply in that order in wrangler and
  `test/helpers.ts`.
- **Docs:** `services/config/edge-mint.md` (the recipe, the guard, the responses table, discovery),
  `admin/secrets-and-keys.md`, and the `authoring-pkey-manifests` skill (recipes need approval).
- **Threat model:** A5 gains the scoping rule; §3 and §5 say edge-mint recipes from `.pkey/` are
  inert until an operator approves them; §6 property 1 names the two conditions; §9 adds "a new
  product-secret usage or sealed kind" as a review trigger.

**Out** (and where it belongs instead):

- Outlet credentials as a separate sealed kind in their own table, unreachable from
  `openProductSecret` and edge-mint (→ P5-01, which also extracts `signEs256`/`signRs256` into
  `core/jwt.ts`).
- Binding usage into the AEAD associated data (`pkey:v2:<product>:<kind>:<id>`, `keyvault.ts`):
  stronger, but it needs every existing secret re-sealed; revisit in P5-01.
- Edge-mint in the SDKs (→ [P1-04](P1-04-godot-config.md) for Godot, P1b-08 for Node, Python, Swift).
- The `/auth` page (`handleMintAuth`), which already ships a script-free policy.

## Design notes

- **No wire change.** The device-facing route keeps its paths, methods, success body and error
  codes; an unapproved recipe is indistinguishable from a missing one. No OpenAPI, corpus or SDK
  change, so no plan mode. If a new error code seems necessary, stop and escalate.
- **Compare columns, not hashes.** Storing the approved values makes the migration backfill a
  plain `INSERT … SELECT` and makes "what changed" easy to show in the console.
- **The backfill trusts today's references.** That is the status quo, not a weakening: every
  secret it marks was already mintable. The human input above is to look at the list once
  (`SELECT product, name FROM product_secrets WHERE usage = 'edge-mint'`).
- **Open registration.** Approval is the operator's explicit decision that "anyone who installs
  this product may mint this token". The acknowledgement flag makes that visible in the audit log.
- **TABLE_OWNERS:** add `edge_mint_approvals` under Config in
  `packages/docs/scripts/gen-reference.mjs:248`, then regenerate `reference/data-model.mdx`.
- The admin API is narrative-only for `routeCoverage` (`test/routeCoverage.test.ts:28-44`);
  document the endpoints on the docs site.

## Steps

1. Migrations and repository functions (usage read/write, approvals CRUD); regenerate data-model.
2. `openProductSecret` with required usage; update both callers.
3. Approval check, per-device rate limit and discovery bit in `mint.ts` / `config/index.ts`.
4. Resync and link: delete orphaned approvals; never write approvals from a manifest.
5. Admin endpoints, console card, checklist item, secret usage selector.
6. Tests, docs, threat model, changeset.

## Acceptance criteria

- [x] Test: a recipe naming a general-usage secret returns `500 misconfigured` and mints nothing.
- [x] Test: a new recipe arriving by resync returns `404` until approved, then mints.
- [x] Test: changing the recipe's `claimsTemplate`, `audience`, `alg`, `kid`, `ttlSeconds` or
      `signingKeySecret` by resync makes it `404` again; an unchanged resync keeps it approved.
- [x] Test: approve with stale echoed fields is refused; approve on an `open` product without
      `acknowledgeOpenRegistration` is refused (likewise with anonymous enrolment or an OIDC
      default tier on).
- [x] Test: after the migration, a djdl-shaped fixture (recipe + secret) mints exactly as before,
      and (review fix) goes `404` if a later push opens registration or enables anonymous
      enrolment; a product already public at deploy keeps minting. djdl's real Identity setup
      (platform provider, its group map) is recorded and a later OIDC rewrite goes `404`.
- [x] Test (review fix): with Identity on, a resync that changes `oidc.issuer`, `oidc.clientId`
      or `oidc.groupRoleMap`, or that turns Identity on, makes an approved closed recipe `404`
      until re-approved; approve with a stale `identity` echo is `409`.
- [x] Test (third review): after a License-off push sweeps the approval, a re-approval echoing
      `licenseEnabled: true` is `409` (absent is `422`); the console warns on the card and in the
      approve dialog while License is off and echoes `false`.
- [x] Test (fourth review): a push that enables anonymous autoIssue and then throws (duplicated
      recipe id) still drops and audits the approval; a console revert of the enrolment does not
      let a stranger enrolled in between mint, and neither does a later clean resync.
- [x] Test (fifth review): with a widening left by a killed ingest (written directly, no sweep),
      each console writer of an approval input — License policy PATCH and revert, services PATCH
      and revert — drops and audits the approval before it writes; a stranger enrolled in between
      gets `404` after the console closes enrolment and after a clean resync. A console edit that
      widens nothing keeps the approval.
- [x] Test: the per-device bucket returns `429` after 30 mints in a minute from one device.
- [x] Test: discovery `config.mint.available` is false while every recipe is pending.
- [x] `THREAT-MODEL.md` and `services/config/edge-mint.md` describe both conditions; `gen:check`,
      `check:links` and the green gate pass (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- edgeMint R12-secrets linkRepo admin
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

P1-04 (Godot config client) and P1b-08 (edge-mint in Node, Python, Swift) rely on the unchanged
route contract: `GET|POST /<p>/config/mint/<id>/token` with a device bearer token →
`200 { token, expiresAt }`; `404` means "not available" (unknown or not approved); discovery
`config.mint.available` says whether to try. P5-01 builds outlet-credential custody on the rule
this package establishes: a secret's usage is set by an operator, never by a manifest. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-12 done`.
