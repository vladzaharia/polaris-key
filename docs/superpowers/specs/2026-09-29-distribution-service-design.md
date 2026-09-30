# Polaris Key Distribution service and Godot SDK (design)

Date: 2026-09-29. Status: **draft for Vlad's decision.** First consumer: Diceroll
(`vladzaharia/diceroll`, public), whose design is `docs/design/2026-09-29-distribution-v2.md` there
(§7 trust, §8 hosting, §10 Polaris). This spec is the Polaris side of that design. Supporting research
(kept here because it references this private repository): `2026-09-29-distribution/research/03-polaris-key.md` (Polaris fit,
gaps, costs, a measured pure-GDScript Ed25519 verifier) and `2026-09-29-distribution/research/10-security-signing.md`
(threat model, TUF-lite design, custody, rotation runbook).

## 0. Summary

Add a **Distribution** service (`dist`) that runs the *publishing* side of software and content
distribution for products that ship to many platforms: a GitHub-OIDC publish gateway, a content
signer, release-document intake, a timestamp signer with a halt switch, staged rollouts, garbage
collection, a console section and `pkey dist` commands. Players never talk to it: they read static,
signed files from R2 behind a CDN. Plus a **Godot SDK** (`sdks/godot`, pure GDScript).

Why not the existing Release/Update services: they serve bare binaries/DMGs streamed from GitHub,
their feeds are unsigned, they have no rollouts, no R2, no machine credential for CI and no CORS.
What Polaris already has (hardened JWS, pinned trust, clock floors, a conformance corpus, console,
audit) is what the publishing side needs.

## 1. Shape and boundaries

- **Code:** `packages/worker/src/services/dist/` as a normal service (AGENTS rule 6: imports only
  `core/…`, its own directory and declared packages). Registered in the service slug list and the
  manifest module services like any other service; enabled per product by its `.pkey/` manifest
  (rule 5: products are data).
- **Deployment:** its **own Worker script** (`wrangler.dist.toml`) that mounts only core + `dist`,
  with its own secrets (content and timestamp private keys) and its own R2 binding. The multi-tenant
  worker never holds these keys. Same repo, same packages, same tests.
- **Hot path:** none. Clients fetch `https://dl.<product-domain>/v2/…` straight from R2's custom
  domain. If the Worker is down, games keep playing and updating from what's published; only
  publishing, rollout changes and timestamp refreshes pause (timestamps are valid 7 days).
- **Privacy (rule 7):** no device registration, no identifiers. Rollout buckets are computed
  client-side from a local random install id that is never sent.

## 2. Wire: the Distribution protocol family ("DIST-1")

Rule 2 makes any change to the licence/config/trust/bundle set an all-languages event. Distribution
documents are a **separate protocol family** with its own version constant (`DIST_PROTOCOL_VERSION =
1`), its own corpus section, and implementations in **Node client-core, the Worker and the Godot SDK**;
Python and Swift are "not applicable" until a product needs them. This needs a one-line amendment to
AGENTS rule 2.

**Encoding (reuses the v3 JWS hardening):** protected header `{"alg","typ","kid"}` in that order,
≤ 1024 B; strict base64url; duplicate keys rejected; integers integral and ≤ 2^53−1; payload caps per
type; signature verified over the exact bytes before parsing; `alg` must equal the **key's declared
algorithm** (never trusted from the header alone).

**Differences from v3:**

| | v3 documents | DIST-1 documents |
|---|---|---|
| Audience | one device (`deviceId`) | broadcast, cacheable: no `deviceId` |
| Algorithms | EdDSA only | per key: **ES256** (default, verifies natively in Godot's mbedTLS) or EdDSA |
| Serialization | compact | compact; **General JSON** for the root document (two root signatures) |
| Trust | pinned product key + online-signed trust manifest | pinned **offline roots** → root-signed key list with **scopes** and `notAfter` |
| Freshness | `expiresAt`/`graceUntil`, per-type `issuedAt` floors | `timestamp` document (7 d) vouches for current documents; per-type `seq` floors; clock floor |

**Types** (payload shapes in the Diceroll design §7.3):

| `typ` | Signed by | Mutable? |
|---|---|---|
| `pkey-dist-root+jws` | offline roots (2 of 3) | new version per ceremony |
| `pkey-dist-timestamp+jws` | timestamp key (Worker) | the only mutable object |
| `pkey-dist-release+jws` | release key (hardware, off-Worker) | immutable per `seq` |
| `pkey-dist-catalog+jws` | content key (Worker) | immutable per `seq` |
| `pkey-dist-pack+jws` | release key (hardware, off-Worker) | approves one asset-pack revision; `packs/<sha256>.jws` and inside store-delivered packs |

**Scopes** in the root document (`{typ, aud pattern, code: bool}`) are enforced by clients: a content
key can never sign a release or pack document; a timestamp key can only halt, disable or choose
among already-signed catalogs; catalogs never reference code and may only reference packs that have a
pack document.

**Conformance:** `distCases` (valid; expired on the network path but accepted on reload; seq
rollback; same seq different payload; scope confusion; typ confusion; aud/channel mismatch; revoked
kid; floor reset; root step-through; oversize; malformed hash rejects the whole document) and
`rolloutBucketCases` (salt, install id → bucket). Godot mirror + runner alongside the Swift mirror.

## 3. Keys and custody

| Key | Where | Rotation |
|---|---|---|
| Roots A, B, C (ES256), 2 of 3 | product owner's hardware keys and one air-gapped key; never in Polaris | yearly root document; roots every 3–5 years |
| Release key | product owner's YubiKey; signs release documents and pack documents locally (`pkey dist sign-release` / `sign-packs` using PKCS#11) | 12 months |
| Content key (ES256) | `dist` Worker secret (not the KEK-sealed product key store) | 12 months, via the root document |
| Timestamp key (ES256) | `dist` Worker secret | 12 months |

The Worker never holds a key that can authorise code or new binary content. A content-key compromise
is bounded to JSON definitions and references to already-approved packs; a timestamp-key compromise
can freeze, halt or pick among already-signed catalogs.

## 4. Storage (D1) — draft

```sql
CREATE TABLE dist_publishers (          -- GitHub OIDC trust policy, from the product manifest
  product TEXT NOT NULL, repository_id INTEGER NOT NULL, repository_owner_id INTEGER NOT NULL,
  workflow_ref TEXT NOT NULL,           -- 'vladzaharia/diceroll/.github/workflows/content-release.yml@refs/*'
  ref_pattern TEXT NOT NULL,            -- '^refs/(heads/main|tags/content/.+)$'
  environment TEXT,                     -- 'content-beta'
  scopes_json TEXT NOT NULL,            -- ["upload","catalog:dev","catalog:beta","promote:stable","release:intake"]
  PRIMARY KEY (product, repository_id, workflow_ref, ref_pattern)
);
CREATE TABLE dist_oidc_jti (product TEXT NOT NULL, jti TEXT NOT NULL, exp INTEGER NOT NULL,
  PRIMARY KEY (product, jti));
CREATE TABLE dist_objects (             -- every uploaded immutable object
  product TEXT NOT NULL, key TEXT NOT NULL, sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size > 0), kind TEXT NOT NULL,   -- pack | delta | defs | velopack | sidecar
  provenance_json TEXT NOT NULL,        -- {repository, sha, run_id, workflow} from the OIDC token
  created_at INTEGER NOT NULL, PRIMARY KEY (product, key));
CREATE TABLE dist_pack_revs (
  product TEXT NOT NULL, pack_id TEXT NOT NULL, rev INTEGER NOT NULL, sha256 TEXT NOT NULL,
  size INTEGER NOT NULL, engine TEXT NOT NULL, format INTEGER NOT NULL, prefixes_json TEXT NOT NULL,
  sources_json TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (product, pack_id, rev), UNIQUE (product, sha256));
CREATE TABLE dist_documents (           -- append-only publish log: root/timestamp/release/catalog
  product TEXT NOT NULL, typ TEXT NOT NULL, channel TEXT NOT NULL, seq INTEGER NOT NULL,
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, kid TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL, r2_key TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL,
  PRIMARY KEY (product, typ, channel, seq));
CREATE TABLE dist_channels (            -- current pointers, rollout and switches per channel
  product TEXT NOT NULL, channel TEXT NOT NULL,
  release_seq INTEGER, catalog_seq INTEGER,
  candidate_catalog_seq INTEGER, candidate_bp INTEGER CHECK (candidate_bp BETWEEN 0 AND 10000),
  candidate_salt TEXT, ramp_json TEXT,  -- [{bp: 500, at: …}, {bp: 2500, at: …}, {bp: 10000, at: …}]
  halted INTEGER NOT NULL DEFAULT 0, disabled_json TEXT,   -- {sets: [], packs: []}
  modified_at INTEGER NOT NULL, modified_by TEXT NOT NULL,
  PRIMARY KEY (product, channel));
```

## 5. Routes (each needs an OpenAPI entry and a `routeCoverage` row, rule 10)

| Route | Auth | Purpose |
|---|---|---|
| `POST /<p>/dist/uploads` | GitHub OIDC (`upload`) | declare objects `{key-kind, sha256, size}` → presigned R2 PUTs (`If-None-Match: *`, checksum header, ≤ 30 min) for keys not yet present |
| `POST /<p>/dist/catalogs` | GitHub OIDC (`catalog:<channel>`) | compose + sign a catalog: policy (seq + 1; objects exist with matching size/checksum; every referenced pack has a valid pack document and passed the Worker's script scan; pack prefixes and kinds allowed by the product's catalog schema; no prerelease on `stable`) → write `catalog/<ch>/<seq>.jws` → re-sign timestamp |
| `POST /<p>/dist/releases` | GitHub OIDC (`release:intake`) or admin | accept a release document already signed with the release key; verify chain, scope and policy → store → re-sign timestamp |
| `POST /<p>/dist/channels/<ch>/promote` | GitHub OIDC (`promote:<ch>`) or admin | set candidate catalog + ramp, or promote fully |
| `POST /<p>/dist/channels/<ch>/halt` · `/unhalt` · `/disable` | admin (or OIDC with scope) | re-sign timestamp with the switch; audit-logged |
| `POST /<p>/dist/channels/<ch>/rollback` | admin or OIDC | new catalog revoking hashes / restoring previous revisions |
| `GET /<p>/dist/status` | admin | channels, documents, expiry countdowns, R2 health |
| `POST /<p>/dist/gc/plan` · `/apply` | admin (apply) | unreferenced objects older than retention; apply needs approval |
| `POST /<p>/dist/packs` | GitHub OIDC (`upload`) or admin | accept pack documents signed on the YubiKey; verify chain and scope; run the script scan over the uploaded pack (PCK directory + binary resource type strings) and record the result |

**OIDC verification:** GitHub JWKS (cached), `iss = https://token.actions.githubusercontent.com`,
custom `aud` (`https://dist.plrs.im/<product>`), `exp`/`iat`/`nbf` with ≤ 60 s skew, **single-use
`jti`**, `repository_id` + `repository_owner_id` (numeric, immutable), `job_workflow_ref`, `ref`,
`environment`, `event_name`, `runner_environment == github-hosted`, all matched against
`dist_publishers`. A hashed, scoped API token (`pkeyapi_…`) is the fallback for local CLI use.

**Crons:** timestamp re-sign daily (and after every publish); ramp advancement hourly; expiry monitors
(root T−60 d, documents T−30 d) and anomaly alerts (unexpected `seq`, failed OIDC bursts).

## 6. R2 layout (per product bucket)

```
v2/timestamp.jws · v2/root/<v>.jws · v2/release/<ch>/<seq>.jws · v2/catalog/<ch>/<seq>.jws
v2/defs/<sha256>.json · v2/packs/<sha256>.pck · v2/deltas/<from>-<to>.<algo> · v2/velopack/<os>-<arch>/<file>
```

Custom domain with cache-everything rules, `immutable` on hashed keys, 60–300 s on the timestamp,
CORS `GET`/`HEAD` for web origins, bucket locks on every immutable prefix. Gated (paid) objects, if
ever needed, get a Worker 302 to a short-lived presigned URL; public ones never touch the Worker.

## 7. Console and CLI

- **Console:** a Distribution section (shown when the service is enabled): channel × document matrix
  (seq, issued, expiry), pack revisions with sizes and sources, rollout slider with the ramp, halt and
  disable switches with reasons, publish log with one-click rollback, R2 health, GC plan.
- **CLI:** `pkey dist upload | catalog | sign-release (YubiKey, PKCS#11) | release | promote | rollout
  | halt | unhalt | disable | rollback | status | verify <url> | gc plan|apply`.

## 8. Godot SDK (`sdks/godot`)

Pure GDScript addon vendored by products (`addons/polaris_key`), from the prototypes in
`2026-09-29-distribution/research/03-polaris-key.md` §7:

- `crypto/es256.gd` (raw r‖s → DER, native `Crypto.verify`, ~1 ms) and `crypto/ed25519.gd` (pure
  GDScript Ed25519 + SHA-512, RFC 8032 and 81/81 v2 corpus cases, ~15 ms desktop) so the SDK also
  verifies the existing v3 licence/config documents.
- `core/jws.gd`, `b64url.gd`, `json_strict.gd`, `trust.gd`, `clock.gd`, `store.gd`: v3 and DIST-1
  verification, pins, scopes, floors, clock floor, signed-blob cache (re-verified on every load).
- `dist/client.gd`, `dist/plan.gd`, `net/downloader.gd`: timestamp → release/catalog, states
  (`fresh`/`stale`/`unverified`), rollout bucket, planner, `HTTPClient` downloader with Range resume,
  size caps and streaming SHA-256.
- `licence/`, `config/`: optional clients for the v3 services.
- `tests/run_corpus.gd`: runs the v2 corpus and `distCases` headless in CI (Godot 4.7.2).

## 9. Effort

| Item | Days |
|---|---|
| DIST-1 addendum, ES256 in the JWS package, corpus sections, Godot mirror | 3–4 |
| `dist` service: OIDC gateway, uploads, catalog signer, release intake, timestamp cron, halt/disable, attack tests | 6–9 |
| Rollout ramps, GC, monitors | 2–3 |
| Console section | 3–4 |
| CLI (`pkey dist …`, PKCS#11 signing) | 1–2 |
| Godot SDK from the prototypes | 5–7 |
| **Total** | **20–29** (the Diceroll plan counts the SDK under its M3) |

## 10. Open questions

1. Separate Worker script (recommended) vs the `dist` service inside the multi-tenant worker.
2. Distribution documents as a separate protocol family (recommended) vs `PROTOCOL_VERSION` 4 for
   every SDK.
3. Domain: `dist.plrs.im` for the Worker; per-product CDN domains (`dl.<game domain>`) for R2.
4. Whether the release key should ever move into KMS (GCP HSM via Workload Identity) for fully
   automated core releases.
