# R12 — Secrets exposure, information leakage, privacy/compliance

Red-team lane R12. Every claim below was verified against code as it exists on branch
`lewd-owl`. PoC tests live in `packages/worker/test/attack/R12-secrets.test.ts`
(21 tests, all passing — each test states whether it CONFIRMS or REFUTES).

Run: `export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH" && cd packages/worker && npx vitest run test/attack/R12-secrets.test.ts`

## Summary

| ID     | Title                                                                                     | Severity | PoC                 |
| ------ | ----------------------------------------------------------------------------------------- | -------- | ------------------- |
| R12-01 | `redactPayload()` fails OPEN when the active catalog is null or changed                   | Medium   | Confirmed (3 tests) |
| R12-02 | Managed secret values stored PLAINTEXT in D1 while every other secret class is KEK-sealed | High     | Confirmed           |
| R12-03 | Live GitHub App installation token cached in KV unencrypted                               | High     | Confirmed           |
| R12-04 | Magic-link token / OIDC `state` / device code used verbatim as KV key names               | High     | Confirmed           |
| R12-05 | Magic-link token has only 72 bits of entropy                                              | Medium   | Confirmed           |
| R12-06 | `KEY_HASH_PEPPER` optional; silent degradation to unsalted SHA-256                        | Medium   | Confirmed           |
| R12-07 | Python README pins a COMMITTED test keypair as a production trust anchor                  | High     | Confirmed           |
| R12-08 | Credentials travel in query strings + Workers Logs persist at 100%                        | Medium   | Confirmed           |
| R12-09 | PRIVACY.md omits `devices.ua`, client IP, and all non-device retention                    | Medium   | Confirmed           |
| R12-10 | No retention bound and no data-subject deletion path for portal/audit PII                 | Medium   | Confirmed           |
| R12-11 | Delivered `payload.secrets` never reach the OS keyring, contra the protocol contract      | Medium   | Verified by read    |
| R12-12 | Facts telemetry is unconditional and cannot be disabled; Swift silently sends none        | Medium   | Verified by read    |
| R12-13 | License key is a positional argv in five CLI entry points                                 | Medium   | Verified by read    |
| R12-14 | Licensee name + email printed to stdout by `status`                                       | Low      | Verified by read    |
| R12-15 | Prod Cloudflare D1/KV ids committed, contradicting the file's own comment                 | Low      | Confirmed           |
| R12-16 | `keys_index.key_hash` served to the end user's browser                                    | Low      | Verified by read    |
| R12-17 | Swift `writeSecure` create-then-chmod race; no `O_NOFOLLOW`                               | Low      | Verified by read    |

Zero application-level logging exists in the Worker (confirmed), which removes the
classic log-leak class entirely but also means **no detection capability whatsoever** —
see R12-08.

---

## R12-01 — `redactPayload()` fails OPEN when the active catalog is null or changed

**Severity: Medium.** Impact is high (a stored credential is echoed in cleartext to the
browser, defeating the module's stated absolute guarantee), but the audience is limited:
`admin/authz.ts:20-26` makes every admin route platform-admin-only in v1. It rises to High
the moment the "PRODUCT admin RBAC pass" that `authz.ts:4-5` explicitly reserves lands.

**Where**

- `packages/worker/src/admin/lib/redact.ts:33-41` — the fail-open branch.
- `packages/worker/src/admin/lib/shape.ts:81-92` — `loadCatalog()` returns `null` on both
  "no active schema" and "unparseable `catalog_json`", swallowing the parse error.
- `packages/worker/src/admin/handlers/profiles.ts:82-87` — GET path, no null guard.
- `packages/worker/src/admin/handlers/licenses.ts:172,188` — same, license overrides.

The file header at `redact.ts:2-4` states the invariant it does not hold:

> Responses NEVER echo a stored secret value

The redaction of a `secret`-flagged **config** key is conditional on the catalog:

```ts
config[key] = meta?.secret
  ? { state: entry.state, value: "", updatedAt: entry.updatedAt }
  : entry; // ← full entry, value included
```

`meta` comes from `catalog?.entryByKey(key)`. When `catalog` is `null`, `meta` is
`undefined`, `meta?.secret` is falsy, and the stored plaintext is returned verbatim.
Note the asymmetry: the PUT path _does_ guard (`profiles.ts:90-91`
`if (!catalog) return err(409, …, "no active catalog")`), the GET path does not.

**Preconditions.** A stored value under a `kind: "config", secret: true` catalog entry,
plus any one of:

1. the active schema is deactivated (`deactivateSchemas`) — happens on every schema
   replacement (`admin/handlers/schema.ts:47`) and on every manifest resync
   (`release/resync.ts:188`), leaving a window where no schema is active;
2. a new catalog version drops the `secret: true` flag for that key — a routine,
   non-obvious authoring change that retroactively un-redacts historical values;
3. `product_schema.catalog_json` becomes unparseable — degrades silently to null.

**Impact.** Stored credentials (the shipped example in `shared-catalog/src/catalog.test.ts:19-25`
is a VPN subscription URL) are returned in an admin API JSON response, so they land in
browser memory, devtools/HAR captures, screenshots, and any front-end error reporter.

**PoC.** `R12-secrets.test.ts` → `R12-01`, 4 tests:
unit fail-open; e2e leak after `deactivateSchemas`; e2e leak after publishing a v2 catalog
without the flag; corrupt-`catalog_json` → `loadCatalog()` returns `null`.

**Fix direction.** Fail CLOSED: when `catalog` is `null`, blank **every** config value
rather than none. Better, persist the secret-ness on the stored entry at write time
(`applyOverrides` knows it) so redaction never depends on mutable external state. Also
distinguish "no schema" from "corrupt schema" in `loadCatalog()` instead of collapsing both to `null`.

---

## R12-02 — Managed secret values are stored PLAINTEXT in D1

**Severity: High.** This is the single largest at-rest inconsistency in the system.

**Where**

- `packages/worker/src/admin/lib/overrides.ts:40-66` — `applyOverrides` writes
  `bucket[u.key] = { state, value, updatedAt }` with no `seal()` call, for
  `entry.kind === "secret"` as well as `secret: true` config keys.
- `packages/worker/src/admin/handlers/profiles.ts:105-111` — persists
  `payload_json: JSON.stringify(result.payload)` straight to `profiles.payload_json`.
- `packages/worker/src/admin/handlers/licenses.ts:364` — same for `licenses.overrides_json`.

**Contrast.** Every _other_ secret class in the system is envelope-encrypted:
`product_keys.enc_private_json` and `product_secrets.enc_value_json` go through
`keyvault.seal()` under `PLATFORM_KEK` (`admin/handlers/products.ts:600-611`,
`:639-644`), and `env.ts:4-6` states the design as fact:

> Product signing keys, OIDC client secrets, and edge-mint key material are sealed in D1
> under PLATFORM_KEK, not stored as Worker secrets.

Catalog-declared secrets are the exception nobody wrote down. `admin.test.ts:863` asserts
`enc_private_json` never contains `BEGIN PRIVATE KEY`; **no equivalent assertion exists
for `profiles.payload_json` or `licenses.overrides_json`** — that is precisely the gap.

**Impact.** A read-only D1 dump (leaked Cloudflare API token, a support export, a restored
backup) yields every product-delivered secret in cleartext. The KEK gives no protection
here at all, so the blast radius of a D1 compromise is much larger than the architecture
documents claim.

**PoC.** `R12-secrets.test.ts` → `R12-02`. Writes both a `kind: "secret"` key and a
`secret: true` config key through the real admin API and asserts the D1 column contains
both plaintexts and carries no `"v":2` Sealed envelope.

**Fix direction.** Route `payload.secrets` (and `secret: true` config values) through
`keyvault.seal()` with an AAD of `pkey:v2:<product>:managed-secret:<key>`, opening only at
config-doc signing time in `configDoc.ts`. Add the missing at-rest assertion to the test suite.

---

## R12-03 — Live GitHub App installation token cached in KV unencrypted

**Severity: High.**

**Where** `packages/worker/src/release/githubApp.ts:230-238`:

```ts
const body = (await res.json()) as { token: string };
const expiresAt = now + TOKEN_TTL_SECONDS;
await env.HOT.put(
  cacheKey,
  JSON.stringify({ token: body.token, expiresAt } satisfies CachedToken),
  { expirationTtl: TOKEN_TTL_SECONDS },
);
```

`cacheKey` is `pk(product, "gh-token", String(installId))` (`:210`) and `TOKEN_TTL_SECONDS`
is 55 minutes (`:21`).

**Preconditions.** A GitHub-linked product, plus read access to the KV namespace
(`51b31c97ac2140e5af2402bed1a31e71` — committed, see R12-15).

**Impact.** The plaintext value is a live GitHub App installation bearer token with the
App's full repo scopes, valid for up to 55 minutes. `kv.ts:1-3` describes KV as holding
"just the two lookups on the request hot path: token-hash -> device, and key-hash ->
license" — this third, credential-bearing entry contradicts that and is the only _directly
usable_ credential anywhere in KV. Every other credential in KV is a hash.

**PoC.** `R12-secrets.test.ts` → `R12-03`. Drives the real `getInstallationToken()` with a
stub fetch and reads `ghs_LIVE_INSTALLATION_TOKEN` back out of the KV mock.

**Fix direction.** `seal()` the cached token under `PLATFORM_KEK` before `HOT.put`, or drop
the cache and re-mint per request (one extra round trip on the release path only). Update
`kv.ts`'s header comment either way.

---

## R12-04 — Magic-link token, OIDC `state`, and device code are KV KEY NAMES

**Severity: High.** A KV _list_ capability — strictly weaker than a KV _read_ — becomes a
credential dump.

**Where**

| Credential              | Site                  | Key                           | Value                            |
| ----------------------- | --------------------- | ----------------------------- | -------------------------------- |
| Portal magic-link token | `portal/auth.ts:353`  | `portal:magic:<token>`        | `{"email":"victim@…"}`           |
| Portal OIDC flow state  | `portal/auth.ts:196`  | `portal:oidc-flow:<state>`    | PKCE `verifier` + `nonce`        |
| Product OIDC flow state | `oidc.ts:508`, `:814` | `p:<slug>:oidc-flow:<state>`  | PKCE `verifier` + `nonce`        |
| Device code             | `oidc.ts:584`, `:626` | `p:<slug>:device-flow:<code>` | flow `state`, deviceId, userCode |
| Admin OIDC flow state   | `admin/auth.ts:168`   | `<ADMIN_FLOW_PREFIX><state>`  | PKCE `verifier` + `nonce`        |

**Contrast — the codebase already knows better.** Device tokens are stored as
`pk(product, "token", tokenHash)` (`kv.ts:23,33`), browser sessions as
`sessionKey(slug, tokenHash)` (`browserSession.ts:129`), and portal download tokens as
`hashKey(token, env.KEY_HASH_PEPPER)` (`portal/repo.ts:586-587`). The flow/magic
credentials are the only ones stored raw.

**Impact.** `KVNamespace.list()` returns key _names_. An actor with KV-list-only access
(a scoped Cloudflare API token, a dashboard session, a misconfigured binding) gets:

- every in-flight magic-link token → sign in as the account named in the paired value,
  which conveniently identifies the victim by email;
- every in-flight OIDC `state` → with the value's `verifier`+`nonce`, drive the callback;
- every live device code → poll `/auth/device/poll` and steal the resulting session.

TTL is 600s (`portal/auth.ts:22`, `oidc.ts` `FLOW_TTL_SECONDS`), which bounds but does not
eliminate the window.

**PoC.** `R12-secrets.test.ts` → `R12-04`. Drives `handleMagicStart` end-to-end, then reads
the KV key list and asserts the key name matches `^magic_[A-Za-z0-9_-]+$` and the value
contains `victim@example.com`.

**Fix direction.** Key these entries by `hashKey(credential, env.KEY_HASH_PEPPER)`, exactly
as device and download tokens already are. Additionally, stop storing the raw email as the
magic-link value — store the `portal_accounts.id` resolved at send time.

---

## R12-05 — Magic-link token has 72 bits of entropy

**Severity: Medium.**

**Where** `packages/worker/src/portal/auth.ts:348` — `const token = randomId("magic");`
and `packages/worker/src/crypto.ts:42-44`:

```ts
export function randomId(prefix: string): string {
  return `${prefix}_${b64url(randomBytes(9))}`;
}
```

`randomId` is designed for **opaque ids** (`lic_`, `dev_`, `flow_`, `acct_`, `paud_`), not
bearer credentials. Nine bytes is 72 bits. The two functions immediately above it in the
same file mint real credentials at 128 bits (`mintLicenseKey`) and 256 bits (`mintToken`).
`oidc.ts` and `portal/auth.ts` correctly use `b64url(randomBytes(16))` for `state` and
`nonce`; only the magic link regressed to `randomId`.

**Impact.** 72 bits is not practically brute-forceable online, and the endpoint is rate
limited (`portal/auth.ts:309-315`, 8/min/IP) with a 600s TTL — so this is defense-in-depth,
not an immediately exploitable break. It is flagged because it is a silent inconsistency:
the single credential that grants full account access is the weakest one minted anywhere in
the system, and nothing in the type system or naming signals it.

**PoC.** `R12-secrets.test.ts` → `R12-04` second test: asserts the magic body is 12
base64url chars (72 bits) against a license key's 22 (128 bits).

**Fix direction.** Mint with `mintToken()` or `b64url(randomBytes(32))`.

---

## R12-06 — `KEY_HASH_PEPPER` is optional and degrades silently

**Severity: Medium.**

**Where** `packages/worker/src/crypto.ts:74-76`:

```ts
/** Hash a credential for storage. With a pepper, an offline KV dump can't confirm guesses. */
export async function hashKey(value: string, pepper?: string): Promise<string> {
  if (!pepper) return sha256Hex(value);
```

`env.ts:19` types it `KEY_HASH_PEPPER?: string`. `PLATFORM_KEK?: string` (`env.ts:17`) is
also optional, though that one fails loudly at use (`keyvault.ts:69-71` throws), so only
the pepper degrades silently.

**Impact.** The stated property in `crypto.ts:3-4` — "optionally peppered so a KV/D1 dump
can't confirm guesses" — is off by default and there is no startup check, no health-check
surface, and no test that asserts the peppered path. A deployment that forgets
`wrangler secret put KEY_HASH_PEPPER` gets unsalted SHA-256 with no signal. Note the entire
existing test corpus runs unpeppered (`seed.ts:38-45` sets no pepper), so the degraded mode
is the _tested_ mode. Practical exploitability is bounded by the 128-bit license-key body,
but it also removes the barrier for any lower-entropy value that ever flows through
`hashKey` — and R12-16 publishes these hashes to end users.

**PoC.** `R12-secrets.test.ts` → `R12-05`. Recomputes the stored hash offline with WebCrypto
and no server-side material, then shows a pepper breaks the match. Second test asserts
`makeEnv()` has no pepper and the seeded `keys_index.key_hash` equals the unpeppered digest.

**Fix direction.** Make `KEY_HASH_PEPPER` required — throw at first use like
`importKek()` does — and surface a "pepper configured" boolean in the admin health view.

---

## R12-07 — Python README pins a COMMITTED test keypair as a production trust anchor

**Severity: High** for any adopter who copies the quickstart.

**Where** `sdks/python/README.md:28`:

```python
TRUST = {"pkey-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"}  # kid -> raw Ed25519 pubkey (base64url)
```

…six lines above `base_url="https://key.plrs.im"` (`:34`, the real production origin), and
repeated for the CLI at `:109` (`--trust pkey-prod-2026=kDJF6…`).

That public key's **private half is committed** at
`conformance/corpus/v1/cases.json:12` and `tools/sign-corpus.ts:55-56`, under the honest
kid `pkey-test-prod-2026`. The README dropped `test` from the name. The Swift README keeps
the correct name (`sdks/swift/README.md:41`); Python is the outlier, and the string
`pkey-prod-2026` appears nowhere else in the repo.

**Why it is exploitable.** `shared-jws/src/index.ts:158-159` selects the verifying key by
the **attacker-controlled header `kid`**: `const rawKey = trustedKeys[header.kid];`. An
attacker signs any payload with the committed private key, sets `kid: "pkey-prod-2026"`,
and it verifies against the README's TRUST map — arbitrary entitlements, arbitrary config.

**PoC.** `R12-secrets.test.ts` → `R12-07`. Reads the README and the corpus, forges a doc
with the committed private key under the README's kid, and verifies it against the README's
trust map.

**Fix direction.** Replace the README examples with an obviously-fake placeholder
(`"<your-kid>": "<your-base64url-pubkey>"`) and a pointer to `/<product>/.well-known/jwks.json`.
Add a CI check that no corpus public key appears in any README. Consider rotating the
corpus keypair since it now has a prod-looking alias in published docs.

**Refuted sub-claim.** The corpus keys are **not** trusted by any production code path.
There is no default/builtin trust store anywhere; trust is always caller-supplied
(`sdk-node/src/client.ts:51`) or built at runtime from D1 (`worker/src/discovery.ts:71-92`).
Zero references to `pkey-test-prod-2026` or its public key exist outside tests, the corpus,
and the generator (asserted in the PoC file). The real `djdl` product pins a different key
(`products/djdl/product.json:4-5`) whose private half is not committed.

---

## R12-08 — Credentials in query strings + Workers Logs persisted at 100%

**Severity: Medium.**

**Where** `packages/worker/wrangler.toml:11-15`:

```toml
[observability.logs]
enabled = true
head_sampling_rate = 1
persist = true
invocation_logs = true
```

Every request is recorded platform-side, un-sampled, with invocation metadata (method,
**full URL**, status, and the `cf-connecting-ip` the edge attached). Meanwhile these
credentials ride in query strings:

| Credential            | Site                                                              |
| --------------------- | ----------------------------------------------------------------- |
| Magic-link token      | `portal/auth.ts:349-350` → `/magic/verify?token=<token>`          |
| OIDC `state`          | `oidc.ts:517`, `portal/auth.ts:205`, `admin/auth.ts:177`          |
| OIDC `code`           | `oidc.ts:692`, `portal/auth.ts:227` (IdP-controlled, unavoidable) |
| Device code           | `oidc.ts:589` → `/auth/device/verify?device_code=<code>`          |
| Portal download token | `portal/api.ts:582` → `/download/<token>` (path, not query)       |

**Impact.** Live, unhashed, single-use-but-not-yet-used credentials are retained in
Cloudflare's log store for the retention period of the plan, readable by anyone with
Workers Logs access — a different and typically broader audience than KV/D1 access.
Combined with R12-04 (the same values are also raw KV key names), the magic-link token is
exposed through three independent channels: email, KV key name, and platform logs.

**The other half of this finding.** `console.*` appears **zero** times in
`packages/worker/src` — confirmed by an exhaustive walk in the PoC file. That is a genuine
strength (no application-level leak is possible) but it also means there is no
audit trail for anything the `audit`/`portal_audit` tables do not already capture: no
failed-auth logging, no anomaly signal, no way to answer "was this magic token replayed?"
The only telemetry that exists is the one that retains secrets.

**PoC.** `R12-secrets.test.ts` → `R12-08` (asserts the four observability flags) and
`R12 refuted hypotheses` → the zero-`console.*` walk.

**Fix direction.** Move the magic token and device code out of the query string into a POST
body (or a one-time redirect that immediately exchanges for a cookie). If they must stay in
the URL, set `invocation_logs = false` and accept the reduced visibility, or hash the
credential so the logged value is not the credential.

---

## R12-09 — PRIVACY.md vs code delta

**Severity: Medium** (compliance/accuracy). The document is unusually accurate on
fingerprinting; the gaps are all in what it does _not_ mention.

| PRIVACY.md claim                                                                                                         | Code reality                                                                                                                                                                                                                                                                            | Verdict                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| §"What is collected" (`:29-64`) lists fingerprint components + software facts                                            | The **full User-Agent** is also collected (`licensing.ts:74`), stored untruncated in `devices.ua` (`repo.ts:926-955`, `licensing.ts:489`), shown to admins (`admin/handlers/devices.ts:44`, `licenses.ts:203`) **and to end users** (`portal/api.ts:220`)                               | **DELTA — omitted entirely.** The doc never uses the words "user agent"                                     |
| §"Not collected" (`:63-64`): "Hostname, OS username, IP-derived geolocation…"                                            | Accurate for the SDKs — `facts.ts:10` imports only `arch, cpus, platform, release, totalmem, type`; no `hostname()`, no `userInfo()`                                                                                                                                                    | **ACCURATE**                                                                                                |
| (no mention of client IP)                                                                                                | `clientIp(req)` reads `cf-connecting-ip` and uses it as a rate-limit key on login, magic-link, claim, device-disconnect and download paths (`rateLimit.ts:44-46`; `portal/auth.ts:175,312`; `portal/api.ts:278`). It is additionally retained platform-side by `invocation_logs = true` | **DELTA — omitted.** "IP-derived geolocation" is not collected, but the IP itself is processed and retained |
| §"Where it lives, and for how long" (`:68-72`) — three rows, all "deleted with the device"                               | Accurate for `device_fingerprints` / `device_facts`: `setDeviceStatus` → `purgeDeviceData` (`repo.ts:969-973`) does fire on deauthorize                                                                                                                                                 | **ACCURATE for the rows listed**                                                                            |
| `audit` row: "Retained with the product's audit log"                                                                     | No bound is defined anywhere. No `DELETE FROM audit` exists; no `scheduled()` handler exists (`index.ts:75` exports `fetch` only)                                                                                                                                                       | **DELTA — unbounded, and the doc's phrasing implies a policy that does not exist**                          |
| (no row) `portal_accounts`, `portal_account_emails`, `portal_account_identities`, `portal_license_links`, `portal_audit` | Not mentioned at all. All hold PII; none has a deletion path                                                                                                                                                                                                                            | **DELTA — omitted** (see R12-10)                                                                            |
| §5 "Retention is device lifetime… there is nothing that outlives its device" (`:25-27`, `:76-77`)                        | False as a global statement: `licenses.email`/`licenses.name` (`0001_init.sql:70`), `audit.actor_email` (`:187`), `customers.email` **indexed** (`0007:27-29`), `portal_account_emails.email` as **PRIMARY KEY** (`0008:16`) all outlive every device                                   | **DELTA — overbroad claim**                                                                                 |
| §"Per-product opt-out" (`:79-94`)                                                                                        | Covers **fingerprinting only**. `PolarisKeyOptions` has `fingerprint?: boolean` but no facts/telemetry toggle; `collectFacts()` is called unconditionally (`sdk-node/src/client.ts:591`)                                                                                                | **DELTA — the heading implies facts can be opted out of; they cannot** (see R12-12)                         |
| §"What an end user can see" (`:125-127`): "platform, versions, and first/last-seen times"                                | Also serves `ua` (`portal/api.ts:220`) and `hash` = `keys_index.key_hash` (`:203`)                                                                                                                                                                                                      | **DELTA — under-states**                                                                                    |

**Fix direction.** Add `devices.ua` to the collected table (or truncate it to
platform/version, which is all the panel actually renders); add a client-IP row noting
rate-limiting use and Cloudflare log retention; add rows for the five `portal_*` tables and
`licenses.email`/`customers.email` with an honest retention statement; rename the opt-out
section to "Fingerprinting opt-out" or add a facts toggle to match the doc.

---

## R12-10 — No retention bound and no data-subject deletion path

**Severity: Medium** (compliance).

**Where (by absence).** Grepping `packages/worker/src` and `packages/worker/migrations`:

- No `DELETE FROM audit`, `portal_audit`, `portal_accounts`, `portal_account_emails`,
  `licenses`, or `customers` anywhere.
- No `scheduled()` export — `src/index.ts:75` exports `fetch` only, and `wrangler.toml`
  declares no `[triggers]`/cron.
- The portal API surface (`portal/api.ts:585-638`) routes only
  `capabilities | magic/start | me | licenses | claim/license-key | releases` plus a
  device DELETE. **There is no account-delete and no data-export endpoint.**

**Impact.** Email addresses, display names, OIDC subjects, license↔account links, and both
audit trails accumulate indefinitely with no operator or end-user erasure path. PRIVACY.md
justifies the absence of a cleanup job ("there is no orphaned data for one to collect",
`:76-77`), which is true for device data and false for account data. For any GDPR/CCPA
posture this is the gap that matters most in this lane.

**Fix direction.** Add `DELETE /api/me` (cascade across `portal_account_*` and
`portal_license_links`, tombstone `portal_audit`), define an explicit retention window for
`audit`/`portal_audit`, and state both in PRIVACY.md.

---

## R12-11 — Delivered `payload.secrets` never reach the OS keyring

**Severity: Medium.** The protocol declares a contract the SDKs do not implement.

**Where** `packages/shared-protocol/src/index.ts:40-42` states the intent:

> The three payload kinds, each routed to a different store on arrival: `config` →
> plaintext, `secrets` → **OS keyring**, `entitlements` → the capability map.

In practice `getSecret()` reads straight out of the cached doc
(`sdk-node/src/client.ts:250-255`), and the whole doc — secrets included — is
`JSON.stringify`'d into `managed.json` (`sdk-node/src/store.ts:203-205`;
`sdks/python/.../store.py:198`; `sdks/swift/.../KeychainStore.swift:180-183`). Only the
device token ever reaches the keyring (`store.ts:225`, `account = "device-token"`).

**Impact.** Product-delivered secrets sit in a mode-0600 plaintext JSON file alongside the
licensee's name and email (`doc.profile`), one `cat` away, with the keyring already wired
and unused. Combined with R12-02, such a secret is plaintext at _every_ hop: D1 → response
→ disk.

**Fix direction.** Route `payload.secrets` to the keyring as documented, or amend the
protocol comment to describe what actually happens.

---

## R12-12 — Facts telemetry is unconditional; Swift silently sends none

**Severity: Medium.**

**Collected and sent on every refresh** (`sdk-node/src/facts.ts:86-116`): OS name/version/
build/kernel, CPU model, core count, total RAM, machine model, runtime name/version,
**locale**, **timezone**, and probe results. Assembled at `client.ts:585-595`, POSTed to
`/<product>/config/report` (`endpoints.ts:237`) from `refresh()` (`client.ts:430-437`),
which fires unconditionally after `activateWithKey` (`client.ts:385`) and `enroll` (`:377`).
Together with locale + timezone this is a strong device fingerprint delivered outside the
hardware-fingerprint system that PRIVACY.md governs.

**No opt-out exists.** `PolarisKeyOptions` (`client.ts:55-78`) has `fingerprint?: boolean`
and `probes?`, but no `facts`/`telemetry` flag. Setting `fingerprint: false` does **not**
suppress facts — `collectFacts()` at `client.ts:591` is unconditional. Only the `probes`
sub-object is conditional (`facts.ts:91`).

**Capability divergence — flag for the platform owner.** Swift sends no facts at all:
`sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:494-509` builds a `SnapshotBody` with
only `config` and `entitlements`, and the wire type has no facts field. `probes` is
accepted (`:37, :55, :70`), stored (`:128, :149`) and **never read** — `Facts.collect` at
`Facts.swift:122-145` is fully implemented, `public`, and has zero callers. Python sends
facts but omits `cpuModel` and `ramMb` (`facts.py:76-113`), and Node populates
`machineModel` with `arch()` (`facts.ts:105`) where Swift would use `hw.model`. Server-side
facts data is therefore not comparable across platforms, and the Swift `probes` parameter
is a silent no-op that an adopter would reasonably assume works.

**Fix direction.** Add `facts?: boolean` (default documented explicitly), implement or
remove the Swift path, and reconcile `machineModel` semantics across the three SDKs.

---

## R12-13 — License key as a positional argv

**Severity: Medium.** Leaks to shell history, `ps`/`/proc/<pid>/cmdline`, and CI job logs.

| Entry point       | Site                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| Node / commander  | `packages/sdk-node/src/cli/commander.ts:74-79` — `.command("activate <key>")`         |
| Node / yargs      | `packages/sdk-node/src/cli/yargs.ts:68-73` — `command: "activate <key>"`              |
| Python / argparse | `sdks/python/src/polaris_key/cli/argparse_cli.py:69` — `p_act.add_argument("key", …)` |
| Python / click    | `sdks/python/src/polaris_key/cli/click_cli.py:68` — `@click.argument("key")`          |
| Python / typer    | `sdks/python/src/polaris_key/cli/typer_cli.py:48` — `key: str` positional             |

**No alternative input path exists in any of the five.** A repo-wide grep across
`packages/sdk-node/src`, `packages/cli/src` and `sdks/` for
`getpass|prompt|hide_input|readline|stdin|mask` returns zero input-related hits; the only
env reads are `XDG_CONFIG_HOME` and the `PKEY_CONFIG_*` override prefix. Both click and
typer offer `hide_input` prompts and neither uses it. The documented usage puts the raw key
into shell history verbatim (`sdks/python/README.md:108`).

**Fix direction.** Accept `-` / `--key-file` / `POLARIS_KEY_LICENSE`, and prompt with echo
off when the argument is omitted and stdin is a TTY.

---

## R12-14 — Licensee name + email printed to stdout

**Severity: Low.**

`packages/sdk-node/src/cli/commands.ts:120-122` and
`sdks/python/src/polaris_key/cli/core.py:195-197` both emit
`Licensed to: {name} <{email}>` from `status`. Any CI log, terminal scrollback, or
screen-share captures it. Neither is gated behind `--verbose`.

**Fix direction.** Mask by default (`Licensed to: A**** <a***@example.com>`), full value
behind `--verbose` or `--json`.

---

## R12-15 — Prod Cloudflare resource ids committed, contradicting the file's own comment

**Severity: Low.** Resource ids are not credentials; they are reconnaissance aids that name
the exact prod D1/KV to target with a compromised API token, and the committed state
contradicts written policy.

`packages/worker/wrangler.toml:41-43` states the rule:

> Paste the returned ids over the REPLACE*ME*\* placeholders below before deploying;
> they require a one-time bootstrap against the Cloudflare account and **cannot be
> committed here as real values.**

Eleven lines later:

- `:54` — `id = "51b31c97ac2140e5af2402bed1a31e71"` (prod KV `HOT`)
- `:58` — `database_id = "4bcb24b2-80af-4180-abcc-0e5e99564ed8"` (prod D1)

Staging and dev still hold `REPLACE_ME_*` (`:72, :76, :87, :91`), so **prod alone** was
filled in — exactly the drift the comment guards against. Introduced in commit `c87633a`.

`docs/DEPLOYMENT.md:193-194` is softer and conditional:

> Do not commit real IDs **unless this private repo is the intended source of truth for
> deployment config.** If placeholders remain, `wrangler deploy --env prod` cannot bind D1/KV.

So the two documents disagree, and nothing records which branch of the conditional was
chosen. Related: the prod Cloudflare **account id** `07a2eb0d4916b220da1f9c1387b5f6d8` is
committed at `docs/DEPLOYMENT.md:12,49` and `docs/RUNBOOK.md:13`; the repo's previous
unconditional prohibition on exactly this (`infra/README.md:48`, "Never commit real
account/zone ids or the API token") was deleted along with the Terraform tree in `efbe13c`.

**PoC.** `R12-secrets.test.ts` → `R12-08` first test.

**Fix direction.** Pick one policy and make both files agree. If the repo is the source of
truth, delete the false `wrangler.toml:41-43` comment; otherwise restore the placeholders
and move ids to CI secrets.

---

## R12-16 — `keys_index.key_hash` served to the end user's browser

**Severity: Low.**

`packages/worker/src/portal/api.ts:202-208` returns `hash: key.key_hash` in the portal
license detail; `admin/handlers/licenses.ts:194` does the same for admins. With
`KEY_HASH_PEPPER` unset (R12-06) that value is exactly `SHA-256(license_key)`, and it is
also the primary lookup key used by `getKey(db, product, keyHash)` (`portal/api.ts:378-379`).

The 128-bit key body makes offline recovery infeasible, so this is not a break — it is an
unnecessary publication of an internal credential-derived identifier to the least-trusted
surface, and a cross-product correlator if the same key were ever reused. Note
`deviceShape.ts:9-10` deliberately truncates fingerprint digests for exactly this reason;
key hashes get no such treatment.

**Fix direction.** Serve a short opaque `keyId` (or the first 8 chars of the hash, matching
the fingerprint precedent) instead of the full lookup hash.

---

## R12-17 — Swift `writeSecure` create-then-chmod race

**Severity: Low.**

`sdks/swift/Sources/PolarisKey/KeychainStore.swift:195-199`:

```swift
private func writeSecure(_ data: Data, to url: URL) {
    try? data.write(to: url, options: .atomic)
    try? FileManager.default.setAttributes(
        [.posixPermissions: 0o600], ofItemAtPath: url.path)
}
```

The file is created at the process umask (commonly 0644) and only then narrowed. Node and
Python both avoid this by passing the mode to `open(2)` **and** adding `O_NOFOLLOW`
(`sdk-node/src/store.ts:138-150`; `store.py:132-141`) — the Swift path has neither. The
0700 parent directory limits but does not close the window, and the directory mode is
best-effort `try?` and not re-asserted if the directory pre-exists with looser permissions.

**Fix direction.** Use `FileManager.createFile(atPath:contents:attributes:)` with
`.posixPermissions: 0o600` in the attributes, or drop to `open(2)` with the mode and
`O_NOFOLLOW` to match the other two SDKs.

---

## REFUTED

Hypotheses tested and **not** supported. Nine of these have standing assertions in
`packages/worker/test/attack/R12-secrets.test.ts` so they stay refuted.

1. **Sealed key material reaching the browser.** `PUT /api/products/<slug>/secrets/<name>`
   echoes the name only (`admin/handlers/products.ts:621-622`, comment "NEVER echo the
   value back"); `POST /keys/prepare|rotate` returns kid + public key only
   (`:673-679`); the product registry view (`shape.ts:129-182`) carries `signing.publicKey`
   / `trustKeys` and no `enc_*` column. Asserted in the PoC file (3 tests, including
   negative assertions on `BEGIN PRIVATE KEY`, `enc_private_json`, `enc_value_json`, `"ct"`).

2. **GitHub API error strings carrying a token, a credentialed URL, or a response body.**
   `release/github.ts` maps every non-OK upstream response to `<op> failed: <status>` and
   never reads the body into an error (`:68, :84, :139, :142, :185, :220`);
   `release/githubApp.ts:156, 229` likewise emit status codes only. The strings that reach
   `product_sync_state.message` (`admin/handlers/products.ts:787`) and are re-served by
   `shape.ts:76, 286-289` (`syncStateView` + the `manifest sync:` warning) are therefore status codes and validation text, not credentials.
   Asserted in the PoC file. _Nuance:_ they do reveal whether the App is installed on a
   given repo (`githubApp.ts:155`), which is minor internal detail, and they are persisted
   to D1 and re-served indefinitely with no expiry.

3. **Catalog-compiler exception messages leaking secrets.** `schema.ts:85-94` and
   `admin/handlers/schema.ts:41-45` return `e.message` from `new Catalog(...).compileAll()`.
   These are Ajv/structural errors about the **submitted schema document**, which contains
   type declarations, not values, and the submitter is the platform admin who authored it.
   No token or credential can reach them.

4. **`console.log` in the Worker.** Zero occurrences of `console.` anywhere in
   `packages/worker/src` — verified by an exhaustive recursive walk in the PoC file, not a
   grep of a single directory. (The _consequence_ is written up as R12-08.)

5. **Committed corpus keys trusted by a production code path.** No default or builtin trust
   store exists anywhere in the repo. Zero references to `pkey-test-prod-2026` or
   `kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI` outside `test/`, `tests/`, `Tests/`,
   `conformance/corpus/`, and `tools/sign-corpus.ts`; asserted in the PoC file for
   `packages/worker/src`. `tools/sign-corpus.ts:36-38` labels them correctly. The naming
   footgun is real but its only realised consequence is the README issue (R12-07).

6. **Secrets present only in git history.** `git log --all -p` grepped for
   `BEGIN … PRIVATE KEY|ghp_|github_pat_|AKIA…|xox…|sk-|glpat-` returns only material that
   still exists in the working tree — nothing was committed then scrubbed. No `.env`,
   `.dev.vars`, `.pem`, `.key`, `.p12`, or credentials file has ever been tracked. The
   deleted `infra/` Terraform tree (`efbe13c`) contains only `<ACCOUNT_ID>` / `<token>`
   placeholders.

7. **`packages/cli/src/index.ts:186` printing signing keys.** The line prints
   `body.signing ?? body.trust` fetched from the **public, unauthenticated**
   `/<product>/.well-known/polaris.json` endpoint. Server-side that object is
   `discovery.ts:85-92` — jwksUrl, cacheSeconds, and Ed25519 **public** keys. No private
   material. The label "Signing keys exposed:" is dangerously misleading and should be
   reworded ("Published verification keys:"), and `body.signing` is a dead branch that
   never exists in the response — but this is not a leak. Adjacent `index.ts:146` prints
   secret **names** only.

8. **`packages/cli` taking a license key on argv.** The `pkey` CLI is the platform
   _authoring_ tool (`init | validate | doctor | trust | sdk`, `helpText()` at `:239-249`).
   It has no `activate` command and no license key. `pkey trust --public-key` passes a
   public key. R12-13 applies to the five SDK CLIs only.

9. **The license key being persisted to disk.** `activateWithKey` exchanges the key for a
   device token and stores only the token (`sdk-node/src/client.ts:382-386`); the raw key
   never reaches any `Store`. Token storage is genuinely hardened: OS keyring first, and
   the file fallback uses `O_NOFOLLOW` + mode-at-open in both Node (`store.ts:138-150`) and
   Python (`store.py:132-141`). Swift keeps the token in the Keychain with
   `kSecAttrAccessibleAfterFirstUnlock`. (R12-11 and R12-17 are the residual issues.)

10. **`.gitignore` failing to cover secret files.** `.gitignore:7-17` covers `.dev.vars`,
    `.dev.vars.*`, `*.pem`, `.env`, `.env.*`, `secrets.created.json`, all unanchored so they
    match at any depth. Minor gaps only (`*.key`, `*.p12`, `id_rsa*` are uncovered), with no
    current exposure. Structurally, no filename rule can catch the PEMs embedded inside
    `.ts`/`.json`/`.py` test fixtures — a content-based pre-commit scan would be needed, and
    `.husky/pre-commit` performs none.

11. **Hostname / OS username collection.** PRIVACY.md `:63-64` claims neither is read, and
    that holds: `sdk-node/src/facts.ts:10` imports only
    `arch, cpus, platform, release, totalmem, type` from `node:os`; `hostname()` and
    `userInfo()' appear nowhere in any SDK.

12. **Device-data retention.** PRIVACY.md's core claim that fingerprints and facts are
    purged with the device is true: `setDeviceStatus` → `purgeDeviceData`
    (`repo.ts:969-977`) fires on deauthorize from app, admin panel and portal alike
    (`portal/api.ts:451`, `admin/handlers/devices.ts`). The retention gap is in the tables
    the doc does not list (R12-10), not the ones it does.
