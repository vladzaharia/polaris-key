# Architecture review — operational resilience

Reviewed at branch `lewd-owl`, tree at HEAD `bd26e0b`. Read-only review; no source files were
modified. All file:line references are against that tree. Cloudflare platform behaviour was
checked against current docs (August 2026) and against the `wrangler` 4.104.0 binary installed
in this repo, not from memory.

**Lens:** what happens when things go wrong. Rotation, revocation, compromise recovery,
outages, backups, incident response.

**Headline.** Polaris Key is built to a genuinely high standard for the happy path and for
_deliberate_ attack. It has almost no machinery for the _unhappy_ path. Every failure I traced
ends in one of three places: an undifferentiated 500 with no log line, a **misleading 404** with
no log line, or a **permanent condition**. The platform can detect nothing, restore nothing, and
roll back nothing.

The tell is that the one recovery mechanism that _is_ properly built — signing-key rotation,
with a staged→active soak, a single-active DB index, and a break-glass override — is excellent.
It proves the author knows how to build this. Its quality makes the absence of the other five
read as an oversight rather than a decision.

Three things are worse than merely missing, and all three are new findings in this review:

1. **`PLATFORM_KEK_ID` is a loaded gun.** It is referenced by `keyvault.ts:106,135`, typed in
   `env.ts:18`, and appears in **no** documentation — not `RUNBOOK.md`, not `DEPLOYMENT.md`, not
   the required-secrets comment at `wrangler.toml:93-96`. An operator who finds it and sets it
   (reasonably concluding it is how you rotate a KEK) instantly breaks every sealed blob in
   production, because every existing blob carries `kekId: "default"`. The result is not an
   error page — it is `loadProduct` returning `null` (`product.ts:118-120`) and **every product
   route serving 404**, with zero log output. The outage is indistinguishable from "someone
   deleted all the products."

2. **The production deploy smoke check cannot fail.** `deploy.yml:60-66` curls
   `https://key.plrs.im/manage`, which `admin/index.ts:40-62` serves as a **static asset** with
   no D1, KV or DO access. A deploy that takes the entire data plane down passes its own smoke
   test.

3. **The disaster-recovery path is already blocked.** `wrangler.toml:32-34` declares
   `RateLimitDO` with `new_classes`, the key-value-backed Durable Object form, which Cloudflare
   [no longer permits accounts to create](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
   Everything else — D1 export, KV snapshot, escrowed secrets, the Git repo — could be restored
   into a fresh Cloudflare account. The Worker itself would not deploy. §5.1a; the fix is an
   hour, and only while the DO still holds nothing anyone needs.

Overall grade: **D+**.

| #   | Question                                        | Grade                                        |
| --- | ----------------------------------------------- | -------------------------------------------- |
| 1   | Key-compromise recovery runbooks                | **F**                                        |
| 2   | Dual-KEK rotation (state today; §2 is the spec) | **F**                                        |
| 3   | Revocation SLA                                  | **D** (server-side **A**, client-side **F**) |
| 4   | Availability — fail open vs. fail closed        | **C−**                                       |
| 5   | Backup, restore, pre-prod                       | **D−**                                       |
| 6   | Detection                                       | **F**                                        |
| 7   | Ranked recommendations                          | §7                                           |

### Corrections to the brief

Three of the established facts need adjusting before building on them.

- **`SECURITY.md` now exists** (untracked, added during this session). It is a _vulnerability
  disclosure policy_ — reporting channels, SLAs, scope. It contains no incident-response
  procedure, no key-compromise runbook, and no "what we do when it happens" content. The
  substance of the finding stands; the file is not the missing artefact.
- **The status-vocabulary "drift" at `repo.ts:359` vs `admin/repo.ts:74` is not drift.** Those
  are different operations: `stmtRetireProductKeys` retires the previously-active key during a
  rotation (it stays in the verification set, `repo.ts:330`), and `deleteProduct` revokes all
  keys on product deletion (dropping them from the verification set). That is correct and
  deliberate. The _real_ problem is one layer down: `migrations/0003_keyvault.sql:15` documents
  the column as `-- active | retired` while the code writes four values, and there is **no CHECK
  constraint**. A typo in a manual `UPDATE` — `'retire'`, `'Revoked'` — silently removes a key
  from `listVerificationProductKeys`' `IN ('active','staged','retired')` filter and takes the
  product's signing offline with no error. That is the finding; fix it with a CHECK constraint,
  not by unifying the two writers.
- **`trustRefresh` is on by default** (`client.ts:149`, `opts.trustRefresh !== false`). What is
  off by default is `refreshIntervalSeconds` (`client.ts:71-74`, `client.ts:190-198`) — the
  polling timer. So clients _do_ pull the trust manifest, they just only do it when the host app
  calls `refresh()`. This matters for §3: the plumbing to deliver a revocation already runs; it
  is the _trigger_ and the _acceptance rule_ that are missing.

Everything else in the brief I confirmed. Additional confirmations worth stating:

- `keyvault.ts:135-138` rejects any blob whose `kekId` differs from the single configured value.
  There are exactly **two** `open()` call sites (`product.ts:97`, `product.ts:134`) and **four**
  `seal()` call sites (`admin/handlers/products.ts:276,600,644`, `release/linkRepo.ts:183`). The
  surface is small; §2 is a half-day of work, not a project.
- All three SDKs merge trust additively and ignore `key.status`: `client.ts:536-542`,
  `sdks/python/src/polaris_key/client.py:535-550`,
  `sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:463-469`.
- Server-side revocation really is immediate: `validateDeviceToken` re-reads `devices` and
  `licenses` from D1 on every call (`licenseCore.ts:467-474`); KV holds only a token→device
  _pointer_, never an authorization decision (`kv.ts:12-25`). There is no cache to invalidate.
  This is the best-designed part of the system's recovery story.
- Zero `console.*` calls in `packages/worker/src`. There is also **no top-level `try/catch`** in
  the fetch handler (`index.ts:75-199`) and **no `ExecutionContext` parameter**, so nothing can
  be deferred with `waitUntil` either.
- No cron triggers, no queues, no DO alarms anywhere in the worker. Every write is
  request-driven; there is no place to hang a backup, a sweep, or a reconciliation job today.

---

## 1. Key-compromise recovery runbooks

**Grade: F.** No runbook exists for any of the six. Two are unrecoverable at any acceptable
cost, one destroys its own evidence, and only two rotate cleanly.

The summary first, because the shape of the table is the finding:

| Secret                  | Detection today                  | Containment                             | Clean rotation?                       | Unrecoverable residue                                             |
| ----------------------- | -------------------------------- | --------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| Product signing key     | **None**                         | `prepare`→`activate`→`revoke`           | Server: **yes**. Client: **no**       | **Every installed client trusts the leaked kid forever**          |
| `PLATFORM_KEK`          | **None**                         | **None that keeps the platform up**     | **No — impossible today**             | **Everything.** Full re-key + forced SDK upgrade of every install |
| `ADMIN_SESSION_SECRET`  | **None**                         | `wrangler secret put` — instant, global | **Yes**                               | The audit trail as evidence                                       |
| `KEY_HASH_PEPPER`       | None (offline use)               | Rotation = mass outage                  | Technically yes, **operationally no** | Every license key ever issued (plaintext never stored)            |
| GitHub App private key  | **Yes** — GitHub's own audit log | New key in GitHub App settings          | **Yes** (GitHub allows overlap)       | Ingested `.pkey/` config; ≤55 min of cached tokens                |
| `GITHUB_WEBHOOK_SECRET` | **None**                         | Rotate in GitHub + wrangler             | **Yes**                               | Ingested `.pkey/` config                                          |

### 1.1 Leaked product Ed25519 signing key

**Detection: none, and structurally so.** The private key exists in plaintext only inside a
Worker isolate, for the duration of one request (`product.ts:96-101`). A forged config document
is byte-indistinguishable from a real one — the client cannot tell, and the server never sees
it. There is no `licenseId` cross-check on the report path that would surface a document the
server never issued (`handleReport` authenticates with a device token first, so a purely forged
document is never reported at all).

**Containment (this part works, and works well):**

```
POST /manage/api/products/<slug>/keys/prepare        → new kid, status=staged
   … wait TRUST_CACHE_SECONDS (300s, products.ts:625) …
POST /manage/api/products/<slug>/keys/activate {kid}  → old key → 'retired', new → 'active'
POST /manage/api/products/<slug>/keys/revoke   {kid: <leaked>}
```

`idx_product_keys_one_active` (`migrations/0006_hardening.sql:11-13`) makes single-signer an
invariant rather than a convention, and `breakGlass: true` (`products.ts:699`) skips the soak
when 300 seconds is 300 seconds too many. This is properly built.

**What is unrecoverable.** Revoking removes the kid from `listVerificationProductKeys`
(`repo.ts:330`) so it stops appearing in JWKS and the trust manifest — but **every SDK merges
trust additively and never removes** (`client.ts:542` and mirrors). A client that has ever seen
the leaked kid trusts it permanently. Rotation therefore protects only _new installs_ whose
build-time pinned trust set is regenerated and shipped.

Two aggravating factors:

- The leak is **self-amplifying**. `handleTrustManifest` signs the trust manifest with the
  product's active key (`jwks.ts:61`). An attacker holding the leaked private key can serve a
  _validly signed_ trust manifest that adds their own kid — which every SDK then merges
  permanently. One leaked key converts into an attacker-controlled key that survives all
  subsequent rotations.
- **Revocation is signalled by absence.** A revoked kid simply stops being published. A client
  that is offline for the whole publication window learns nothing, ever. Revocation must be
  _published as a positive statement_ — see §3.4.

**Verdict: unrecoverable today for the installed base.** Fix §3.4 and this becomes a clean,
bounded rotation.

### 1.2 Leaked `PLATFORM_KEK`

**Detection: none.** The attack is entirely offline: obtain a D1 dump (or a Cloudflare API token
with D1 read), decrypt `product_keys.enc_private_json` and `product_secrets.enc_value_json`
locally. Nothing touches the Worker. The AAD (`keyvault.ts:59-63`) binds ciphertext to
`product`/`kind`/`id` — all of which the attacker reads from the same rows. It is metadata
binding, not a second factor.

**Containment: there is none that keeps the platform running.** Enumerating honestly:

| Option                                 | Result                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Do nothing                             | Attacker holds every product's signing key and every product secret, permanently                                                   |
| Re-seal every value under the same KEK | No effect — they have the KEK                                                                                                      |
| Set a new `PLATFORM_KEK`               | Every `open()` throws → `loadProduct` returns `null` (`product.ts:118`) → **every product route 404s**. Total outage. No log line. |

There is no dual-KEK read window, no re-encryption migration, and no cron/queue/alarm anywhere
in the worker on which to hang one. `RUNBOOK.md:88-89` states the constraint but presents it as
a caution ("do not rotate it as a routine secret") rather than as what it is: _there is no
procedure, routine or otherwise._

**Recovery after option 3** is: mint a fresh Ed25519 key for every product, re-enter every
product secret by hand, and then ship an SDK update to every installed client with a new pinned
trust set — because the old trust sets now point at keys that no longer exist. For any client
that does not take the update, the product is dead.

**Verdict: unrecoverable. This is the single worst scenario in the system.** §2 is the fix and
it should be done before anything else in this document.

### 1.3 Leaked `ADMIN_SESSION_SECRET`

**Detection: none — and worse, the compromise poisons its own evidence.** A forged session
carries attacker-chosen `sub`/`name`/`email` (`admin/session.ts:117-124`), and `audit()` copies
those verbatim into the audit row (`admin/audit.ts:22-24`) with a comment stating the actor is
"taken from the VERIFIED session, never from a request field." That is true and it is exactly
the problem: with the signing secret, the attacker _is_ the verified session. The audit table
will show a plausible-looking admin doing plausible-looking things.

There is no `admin.login` audit event (confirmed by enumerating all 29 audit action strings in
the tree), so there is nothing to diff against PocketID's sign-in log. The only forensic handle
is the eight-hour session TTL (`admin/session.ts:30`) bounding how long any single forged cookie
lasts — which does not bound the attacker, who can mint a fresh one.

**Containment is clean and instant** — the one genuinely good rotation story here:

```sh
npx wrangler secret put ADMIN_SESSION_SECRET --env prod
```

Sessions are stateless HMAC, so a new key invalidates every session — forged and legitimate —
on the next request. Cost: all admins re-login.

> **`wrangler rollback` silently un-rotates secrets.** Per
> [Cloudflare's versions documentation](https://developers.cloudflare.com/workers/versions-and-deployments/),
> a version "captures the complete state of your Worker … its bundled code, static assets,
> **bindings**, and compatibility settings," and classic Worker secrets are bindings. `wrangler
secret put` therefore _creates and immediately deploys a new version_, and a later `wrangler
rollback` restores the **old secret value along with the old code**. During an incident this
> means a rollback can silently reinstate the compromised `ADMIN_SESSION_SECRET` — re-validating
> every forged cookie the attacker still holds. This applies to every secret in §1, and it is
> the single most dangerous interaction between §1 and §5. It must be in the runbook (§8.7).

Note the coupling at `portal/session.ts:62`
(`PORTAL_SESSION_SECRET ?? ADMIN_SESSION_SECRET`): if `PORTAL_SESSION_SECRET` were ever unset,
this also signs out every customer. Production sets both (`DEPLOYMENT.md:216`), so it is
contained — but the fallback should be deleted, because it silently merges two trust domains.

**What is unrecoverable:** the audit trail as evidence, and any state the attacker changed.
Product secrets are write-only (`products.ts:621-622`) so you cannot diff them; `deleteProduct`
is a soft delete (`admin/repo.ts:58`) but there is no undelete endpoint; and a forged
`linkRepo` rewrites tiers, profiles, `admin_group`, and OIDC issuer/client_id with no prior
version retained.

**Also containment-relevant, and currently broken:** removing someone from the `admins` group at
PocketID has **no effect for up to 8 hours**, because `groups` are baked into the cookie at issue
time (`admin/session.ts:117-124`) and `isPlatformAdmin` reads them from the cookie
(`admin/authz.ts:16-18`). For a compromised _admin account_ — a more likely incident than a
leaked signing secret — the only working containment is the same global secret rotation. That
should be written down as the procedure, because it is not obvious.

### 1.4 Leaked `KEY_HASH_PEPPER`

This one inverts: **the leak is low-severity; the rotation is catastrophic.**

**Impact of the leak alone:** near zero. The pepper is only useful with a D1/KV dump, where it
lets an attacker confirm guessed license keys and device tokens offline. Without the dump it
buys nothing.

**Detection: none**, and none is possible — the use is entirely offline.

**Containment — read this before ever running `wrangler secret put KEY_HASH_PEPPER`:**

`hashKey` is `HMAC(pepper, value)` with **no pepper id and no dual-read** (`crypto.ts:75-90`).
Changing the pepper changes every hash the system has ever computed:

- Every `devices.token_hash` and every KV `p:<product>:token:<hash>` entry stops matching, so
  `validateDeviceToken` returns `unauthorized` for **every device on the platform**. The SDK
  treats that as revocation, not as an error: `fetchAndApply` sets `lastSyncUnauthorized`
  (`client.ts:481`) and `licenseState` returns **`status: "revoked"`** (`gate.ts:43`). Every
  paying customer sees a _revoked_ banner, not "please sign in again."
- Every `keys_index.key_hash` stops matching — and license keys are **stored only as hashes**
  (`crypto.ts:31-33`; the plaintext is shown once at issue). You therefore **cannot re-hash
  existing keys**. Recovery is: mint brand-new license keys for every license and deliver them
  to every customer.

**Silent-degradation hazard.** `hashKey` falls back to unpeppered SHA-256 when the pepper is
absent (`crypto.ts:76`). A deploy that drops the secret produces the identical mass
invalidation with no error, no exception, and no log line.

**Verdict: unrecoverable in practice.** Technically you can rotate; operationally it is a
platform-wide credential reissue plus a false "revoked" state on every install. Fix by versioning
the pepper (§7, R6) so a rotation becomes a dual-read window like any other key.

### 1.5 Leaked GitHub App private key

**Detection: yes — the only one of the six with a real external channel.** Installation-token
mints appear in the GitHub organisation audit log, and GitHub surfaces App credential events.
Polaris itself logs nothing.

**Containment is clean.** GitHub Apps support multiple simultaneously-valid private keys
specifically so this can be done without downtime:

1. Generate a new private key in the GitHub App settings.
2. `npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env prod` (paste the full PEM including
   `BEGIN`/`END` lines).
3. Verify a release path works (`GET /<product>/appcast.xml`, or Releases → resync in the admin).
4. **Then** delete the old key in GitHub.

**Residue:** cached installation tokens live in KV for up to 55 minutes (`githubApp.ts:21`) and
are **not** invalidated by rotating the private key — they are already-minted bearer tokens.
Either accept a 55-minute window or purge them:

```sh
npx wrangler kv key list --binding HOT --env prod --remote --prefix "p:" \
  | jq -r '.[].name | select(contains(":gh-token:"))' > /tmp/ghtok.txt
# then delete each; see the runbook draft in §8
```

**Unrecoverable:** any `.pkey/` content the attacker pushed and Polaris already ingested.
`resyncRepo` overwrites tiers, profiles, `admin_group`, and the OIDC `issuer`/`client_id`
wholesale. `product_sync_state` retains `commit_sha` and `changed_paths_json`
(`repo.ts:300-310`) — enough to tell you _that_ something changed, not _what it was before_.
Reverting means re-pushing the known-good manifest and forcing a resync.

### 1.6 Leaked `GITHUB_WEBHOOK_SECRET`

**Detection: none.** `verifySignature` (`githubWebhook.ts:46-65`) is correct — constant-time,
strict `sha256=` format — but a _valid_ forged signature is indistinguishable from GitHub's, and
the webhook path writes **no audit row at all**. `release.resync` is audited only on the manual
admin path (`products.ts:813`). A forged push that rewrites a product's OIDC issuer leaves a
changed `product_sync_state` row and nothing else.

**Containment is clean and instant:** rotate the secret in the GitHub App settings, then
`npx wrangler secret put GITHUB_WEBHOOK_SECRET --env prod`. A GitHub App carries one webhook
secret, so there is a brief window where in-flight deliveries fail signature verification;
GitHub retries, so this is a non-issue in practice. Do the wrangler side first if you want to
avoid even that (accepting a short window where the _old_ secret is the one that fails).

**Unrecoverable:** same as §1.5 — whatever config was rewritten, with no prior version retained.
Compounded by the sibling review's finding that `resyncRepo` does not pin the fetch to the
default-branch head, so a forged webhook can pull an arbitrary ref.

### 1.7 The two that should also be on the list

- **`PLATFORM_OIDC_CLIENT_SECRET`** — rotate at PocketID, then `wrangler secret put`. Clean;
  brief window where in-flight admin logins fail. Fully recoverable.
- **Per-product OIDC client secrets** — rotate at the product's IdP, then re-enter via
  `PUT /manage/api/products/<slug>/secrets/<name>` (`products.ts:581-623`). Clean, per-tenant,
  fully recoverable. This is the model the platform secrets should aspire to.

---

## 2. Dual-KEK rotation — implementable spec

**Grade for the current state: F.** Not merely "unimplemented" — the `kekId` field and the
undocumented `PLATFORM_KEK_ID` env var actively advertise a capability that does not exist and
whose naive use is a production outage.

The good news is that the blast radius of the change is tiny: two `open()` call sites, four
`seal()` call sites, one module.

### 2.1 Envelope: no wire change

```ts
export interface Sealed {
  v: 2; // DO NOT BUMP — every existing blob must open unchanged
  kekId: string; // already present; becomes load-bearing
  iv: string;
  ct: string;
}
```

The AAD stays exactly as it is (`pkey:v2:<product>:<kind>:<id>`, `keyvault.ts:59-63`). It must
**not** incorporate `kekId`: if it did, re-encrypting a blob would change its AAD and you would
need a `v: 3` and a second migration to get out of the first one. This is the single most
important constraint in the design.

### 2.2 Configuration: an ordered keyring, not a single key

Replace the `PLATFORM_KEK` / `PLATFORM_KEK_ID` pair with:

```text
PLATFORM_KEK_ACTIVE = "k2"
PLATFORM_KEK_KEYS   = {"k1":"<base64 of 32 bytes>","k2":"<base64 of 32 bytes>"}
```

`PLATFORM_KEK_ACTIVE` names the kid used for **new** seals. `PLATFORM_KEK_KEYS` names every kid
that may be **opened**. Rotation is the interval during which the map has two entries.

**Backwards compatibility is mandatory and is what makes this deployable.** If
`PLATFORM_KEK_KEYS` is absent, synthesise the ring from the legacy vars:

```ts
// keyvault.ts
function resolveKeyring(env: Env): {
  active: string;
  raw: Record<string, string>;
} {
  if (
    typeof env.PLATFORM_KEK_KEYS === "string" &&
    env.PLATFORM_KEK_KEYS.length > 0
  ) {
    const raw = JSON.parse(env.PLATFORM_KEK_KEYS) as Record<string, string>;
    const active = env.PLATFORM_KEK_ACTIVE;
    if (!active || !(active in raw))
      throw new Error("PLATFORM_KEK_ACTIVE is not in PLATFORM_KEK_KEYS");
    return { active, raw };
  }
  // Legacy single-KEK shape. Deliberately keeps the "default" kid so existing blobs open.
  const legacy = env.PLATFORM_KEK;
  if (typeof legacy !== "string" || legacy.length === 0)
    throw new Error("PLATFORM_KEK is not configured");
  const kid = env.PLATFORM_KEK_ID || "default";
  return { active: kid, raw: { [kid]: legacy } };
}
```

With this, shipping the code is a **no-op deploy on the current production secret set**. That
matters more than usual here, because there is no staging environment to try it on (§5.3).

### 2.3 Import + cache

```ts
let cachedRing: {
  fingerprint: string;
  active: string;
  keys: Map<string, CryptoKey>;
} | null = null;

async function loadKeyring(
  env: Env,
): Promise<{ active: string; keys: Map<string, CryptoKey> }> {
  const { active, raw } = resolveKeyring(env);
  // Memo per isolate, keyed by the literal secret material, so a secret change in a fresh
  // isolate is picked up without a restart hook.
  const fingerprint = `${active} ${JSON.stringify(raw)}`;
  if (cachedRing?.fingerprint === fingerprint) return cachedRing;

  const keys = new Map<string, CryptoKey>();
  for (const [kid, b64] of Object.entries(raw)) {
    const bytes = b64Decode(b64);
    if (bytes.length !== 32)
      throw new Error(`KEK ${kid} must decode to exactly 32 bytes`);
    keys.set(
      kid,
      await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(bytes),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      ),
    );
  }
  if (keys.size === 0) throw new Error("PLATFORM_KEK_KEYS is empty");
  cachedRing = { fingerprint, active, keys };
  return cachedRing;
}
```

Fails closed on: empty ring, an active kid missing from the ring, or any value that is not
exactly 32 bytes. Same posture as `importKek` today (`keyvault.ts:67-83`), extended to N keys.

### 2.4 `seal()` — one-line change

```ts
const { active, keys } = await loadKeyring(env);
const key = keys.get(active)!;
// … unchanged …
const sealed: Sealed = { v: 2, kekId: active, iv: …, ct: … };
```

### 2.5 `open()` — the acceptance rule

This is the whole fix:

```ts
export async function open(
  env: Env,
  sealedJson: string,
  ctx: SealContext,
): Promise<string> {
  const { keys } = await loadKeyring(env);
  // … parse + shape-check unchanged (keyvault.ts:121-134) …

  const key = keys.get(sealed.kekId);
  if (!key)
    throw new Error(`sealed value uses unavailable KEK ${sealed.kekId}`);

  // Unchanged: a bad auth tag rejects, and we propagate — never a wrong/partial plaintext.
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(b64urlDecode(sealed.iv)),
      additionalData: aad(ctx),
    },
    key,
    toArrayBuffer(b64urlDecode(sealed.ct)),
  );
  return dec.decode(pt);
}
```

Stated precisely, because it is the crux: acceptance becomes **"the blob's own kid is present in
the ring"**, replacing today's **"the blob's kid equals the single active kid"**
(`keyvault.ts:135-138`). Everything else about the fail-closed posture is preserved, including
the error message, so existing tests keep asserting the same thing.

### 2.6 Re-encryption migration

Two designs. I recommend the second and would reject the first in review.

**(a) Lazy re-seal on read.** In `loadProduct`/`openProductSecret`, if `sealed.kekId !== active`,
re-seal and `UPDATE`. **Reject.** It puts a D1 write on the request hot path; two isolates race
to re-seal the same row; a product nobody calls never migrates; and you can never tell whether
the migration is finished — which is the one thing an operator needs to know before deleting the
old KEK.

**(b) Explicit, observable admin sweep.** Recommended.

First, a schema change so progress is cheaply observable:

```sql
-- migrations/0012_kek_rotation.sql
ALTER TABLE product_keys    ADD COLUMN kek_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE product_secrets ADD COLUMN kek_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_product_keys_kek    ON product_keys(kek_id);
CREATE INDEX IF NOT EXISTS idx_product_secrets_kek ON product_secrets(kek_id);

-- Also fix the unconstrained status column while you are here (§0):
-- SQLite cannot ADD a CHECK constraint; use a 12-step table rebuild, or enforce in code
-- and add the constraint at the next table rewrite. Do NOT skip this.
```

The `DEFAULT 'default'` backfills every existing row correctly, because every existing blob
carries `kekId: "default"`. Writers set `kek_id` alongside `enc_*_json`; the column is a
denormalised copy of the value inside the blob, used only for the sweep query.

Then two endpoints, platform-admin only, CSRF-guarded like every other admin mutation:

```
GET  /manage/api/platform/kek/status
     → { active: "k2", counts: { keys: {k1: 3, k2: 12}, secrets: {k1: 1, k2: 8} } }

POST /manage/api/platform/kek/reseal   { limit?: number }   // default 50, max 200
     → { resealed: 50, remaining: 27 }
```

Sweep semantics:

```ts
for (const row of await db.all(
  "SELECT product, kid, enc_private_json FROM product_keys WHERE kek_id != ? LIMIT ?",
  active,
  limit,
)) {
  const ctx = {
    product: row.product,
    kind: "signing-key" as const,
    id: row.kid,
  };
  const pem = await open(env, row.enc_private_json, ctx); // opens under k1 via the ring
  const next = await seal(env, pem, ctx); // seals under k2 (active)
  await db.run(
    `UPDATE product_keys SET enc_private_json = ?, kek_id = ?
      WHERE product = ? AND kid = ? AND enc_private_json = ?`, // ← compare-and-swap
    next,
    active,
    row.product,
    row.kid,
    row.enc_private_json,
  );
}
// … identical loop for product_secrets with kind: "product-secret", id: name …
```

Four properties that make this safe:

1. **Idempotent** — the `WHERE kek_id != active` filter means re-running is free.
2. **Compare-and-swap** — the `AND enc_private_json = <old>` guard means a concurrent admin
   write (a key rotation, a `secret.set`) wins and the sweep simply picks the row up next pass,
   rather than clobbering it with a stale plaintext.
3. **Bounded** — a `limit` keeps each request inside the Worker CPU budget and inside D1's
   per-request limits.
4. **Observable** — `remaining` reaching 0, confirmed by `GET …/kek/status`, is the gate for
   deleting the old KEK. Without this the operator is guessing.

Audit each sweep as `kek.reseal` with `{from, to, count}`. This needs a product-less audit row —
see §6.4.

### 2.7 Operator procedure

Written to be lifted into `RUNBOOK.md`; see §8.2 for the runbook-formatted version.

The one subtlety worth calling out here: **use `wrangler secret bulk`, not two `secret put`
calls.** Each `secret put` creates and deploys a new Worker version. Two sequential calls leave a
window in which `PLATFORM_KEK_ACTIVE` names a kid that `PLATFORM_KEK_KEYS` does not yet contain
— `loadKeyring` fails closed, and every product route 404s for the duration. `wrangler secret
bulk` writes up to 100 secrets in a single request and therefore a single version.

### 2.8 Cost

~150 lines in `keyvault.ts`, ~120 lines of admin handler + repo queries, one migration, and
tests (a round-trip across two kids, an unavailable-kid rejection, and a CAS-conflict case).
**Half a day.** Compare against §1.2's alternative, which is "the platform never recovers."

---

## 3. Revocation SLA

**Grade: D** — server-side **A**, client-side **F**.

### 3.1 Where the asymmetry actually comes from

| Path              | Latency                                                 | Mechanism                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side       | **Immediate**                                           | `validateDeviceToken` re-reads `devices` + `licenses` from D1 every call (`licenseCore.ts:467-474`). KV caches only a token→device pointer, never a decision (`kv.ts:1-3`). |
| Connected client  | ≤ `DOC_EXPIRY_SECONDS` = **1 hour** — _if it refreshes_ | `configDoc.ts:66`                                                                                                                                                           |
| Real-world client | **Unbounded**                                           | `refreshIntervalSeconds` is undefined by default → no timer (`client.ts:190-198`). A daemon may never re-check.                                                             |
| Offline ceiling   | **30 days**                                             | `graceUntil = issuedAt + maxOfflineDays * 86400` (`configDoc.ts:67`); default 30 (`migrations/0001_init.sql:19`, `products/djdl/product.json:8`)                            |

The server-side design is genuinely good and should be preserved as-is. Re-reading D1 on every
validation is the _reason_ revocation is instant, and it is the correct trade.

Worth stating plainly for the record: revoke a license at 09:00 and a device that synced at
08:59 and never syncs again retains **full entitlements until day 30**. Each successful refresh
pushes `graceUntil` out by another 30 days, so an intermittently-connected client is never
inside a shrinking window.

### 3.2 Recommended SLA

| Class                                             | Target                                                    |
| ------------------------------------------------- | --------------------------------------------------------- |
| Connected client (app running, network available) | **≤ 1 hour**                                              |
| Intermittently connected client                   | **≤ 24 hours**                                            |
| Absolute offline ceiling                          | **7 days** default, per-license override up to 90         |
| Compromised signing key                           | **≤ 7 days** to every online client, permanently enforced |

### 3.3 The four changes that deliver it

**(1) `refreshIntervalSeconds` default 3600.** The comment at `client.ts:71-74` justifies the
current default: "enabling it would silently add network traffic and background wakeups to every
already-shipped integration." That is correct about the _upgrade_ and wrong about the _default_.
The honest handling is to keep the option, flip the default in the next **major** SDK version,
and say so in the changeset. Cost: ~720 requests/device/month, of which the steady state is a
**304 with an `If-None-Match` hit** (`licensing.ts:551-554`) — no signing work, no JWS bytes.
The timer already calls `unref()` (`client.ts:197`), so CLIs and short-lived processes are
unaffected.

**(2) `default_max_offline_days` 30 → 7.** Thirty days means a revoked license keeps working for
longer than most subscription dunning cycles; a chargeback plus 30 days of free use is a real
revenue leak, and it is also the window in which a _stolen_ license stays useful. Keep the
per-license override (`licenses.max_offline_days`, already plumbed at `licensing.ts:541-542`)
for the genuinely offline customer.

**The UX cost, stated honestly:** the customer who takes a laptop somewhere without internet for
more than a week is met with `expired` — a support ticket, possibly a refund. Three mitigations
make 7 defensible: (a) the per-license override, surfaced in the admin UI as a first-class
control rather than a JSON field; (b) the portal issuing an "extended offline" grant
self-service; (c) the SDK surfacing `graceUntil` so the app can warn at T-3 days instead of
failing at T-0. Without (c) I would not ship 7 days. **If the owner disagrees, 14 is a defensible
compromise. 30 is not.**

**(3) A soft heartbeat, not a hard one.** Keep `graceUntil` as the hard ceiling and add
`heartbeatSeconds` (default 86400) to the signed document. Between `heartbeatSeconds` and
`graceUntil` the SDK already reports `status: "grace"` (`gate.ts:47-53`) — the missing half is
that the host app has no reason to treat `grace` as different from `ok`, since `isUsable`
returns true for both (`gate.ts:62-64`). Surface `daysSinceVerified` so the app can ramp: a quiet
badge at day 1, a dismissible banner at day 3, a modal at day 6. A ramp converts the cliff into
a support-ticket-free renewal prompt.

**(4) Short-lived doc + long-lived grace is already the design** — 1 hour expiry, long grace —
and it is the right one. The missing piece is not the shape, it is that nothing pulls the
trigger. That is change (1).

### 3.4 Client-side key revocation — mandatory regardless of the SLA

Without this, the revocation SLA for a _compromised signing key_ is **infinite**, which makes
every other number in this section moot.

```ts
// client.ts refreshTrust(), and the Python/Swift mirrors
const next: TrustSet = {};
for (const key of doc.keys) {
  if (key.status === "revoked") continue; // (a) honour status
  if (key.alg === "EdDSA" && key.kty === "OKP" && key.crv === "Ed25519") {
    next[key.kid] = key.publicKey;
  }
}
if (Object.keys(next).length === 0) return false;
this.trust = { ...this.pinnedKeys, ...next }; // (b) REBUILD, do not accumulate
```

Two changes, both necessary:

- **(a) Honour `key.status`.** The field is already on the wire (`jwks.ts:54-57`) and every SDK
  parses past it.
- **(b) Rebuild from the build-time pinned set, not from the accumulated set.** Today
  `this.trust = { ...this.trust, ...next }` (`client.ts:542`) makes the trust set monotonically
  grow, forever. Rebuilding from `opts.trust.pinnedKeys` keeps the pinned set as an unremovable
  floor — so a hostile or truncated manifest can never strip a client down to zero keys — while
  letting the manifest remove anything it added.

**And the server must publish revocations as positive statements.** Today `revoke` drops the row
from `listVerificationProductKeys`' `IN ('active','staged','retired')` filter (`repo.ts:330`), so
a revoked kid simply vanishes. A client offline for the whole publication window learns nothing.
Change the filter to include `'revoked'` and keep revoked kids in the manifest for a defined
tombstone window (90 days), then reap them:

```sql
WHERE product = ? AND (status IN ('active','staged','retired')
                    OR (status = 'revoked' AND rotated_at > ?))   -- now - 90d
ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'staged' THEN 1 WHEN 'retired' THEN 2 ELSE 3 END,
         created_at DESC
```

`jwks.ts:54-57` currently coerces anything that is not `active`/`staged` to `"retired"` — that
must also pass `"revoked"` through, or the tombstone is invisible.

This is the sharpest single finding in §3: **revocation must be published, not implied by
absence.**

---

## 4. Availability — does each surface fail open or closed?

**Grade: C−.** The posture was never designed; it is an emergent property of where the
`try/catch` blocks happen to be. Some of what emerged is genuinely good. One path is
catastrophically wrong.

### 4.1 Server-side matrix

| Surface                                           | D1 unavailable                                                                                                                     | KV unavailable                                    | DO unavailable                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| `GET /<p>/config`                                 | **500** (`getProduct` throws, uncaught) or **404** (`getActiveSchema` throws _inside_ `loadProduct`'s try → `null` → `notFound()`) | **500** — `HOT.get` throws, uncaught (`kv.ts:23`) | n/a — `/config` is not rate-limited        |
| `POST /<p>/activate`                              | 500 / 404                                                                                                                          | **500** (`putTokenRecord`)                        | **500** (`rateLimitOk`, `rateLimit.ts:34`) |
| `POST /<p>/token`                                 | 500 / 404                                                                                                                          | **500**                                           | **500**                                    |
| `POST /<p>/enroll`                                | 500 / 404                                                                                                                          | **500**                                           | **500**                                    |
| `/<p>/.well-known/jwks.json`, `polaris-trust.jws` | **404** (`loadProduct` → null before the handler runs)                                                                             | 200                                               | n/a                                        |
| `/manage/api/*`                                   | 500                                                                                                                                | 500                                               | 500 on login (`admin/auth.ts:150,195`)     |
| `/manage` (SPA)                                   | **200**                                                                                                                            | 200                                               | 200                                        |
| `/webhooks/github`                                | 500                                                                                                                                | —                                                 | n/a                                        |

Three observations:

- **The D1 column is inconsistent by accident.** `loadProduct` wraps `open()` _and_
  `getActiveSchema` in one try (`product.ts:96-120`) but leaves `getProduct` and
  `getActiveProductKey` outside it. So the same underlying D1 fault yields 500 or 404 depending
  on which query fails first. A 404 from `loadProduct` also cannot be distinguished from a KEK
  failure, a deleted product, or a genuinely unknown slug — four very different incidents, one
  indistinguishable response, zero log lines.
- **The DO row contains an accidental good decision.** `/config` is the only licensing hot path
  _not_ behind `rateLimitOk` (confirmed across all nine call sites). So a DO outage blocks new
  activations but leaves every existing customer refreshing normally. That is exactly the right
  containment, and it should be written down as intentional before someone "fixes" it by adding
  a rate limit to `/config`.
- **The rate-limit DO is one instance per product** — `env.RL.get(env.RL.idFromName(product))`
  (`rateLimit.ts:23`). Every activation for `djdl` worldwide serialises through a single object
  in a single colo: a latency tax and a genuine single point of failure. Shard it:
  `idFromName(\`${product}:${bucket}:${idHash % 16}\`)`. The counters are already per-`(bucket,id)`
(`rateLimitDo.ts:31`), so sharding by id is semantically free.

### 4.2 Client-side consequences — the column that actually matters

| Server response | SDK result                                                                                   | Client status                                               | Open or closed?                |
| --------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| 500             | `{kind:"error"}` (`fetch.ts:93-99`)                                                          | cache untouched → `ok` for 1h, then `grace` to `graceUntil` | **Open — correct**             |
| 404             | `{kind:"error"}`                                                                             | same                                                        | **Open — correct**             |
| 403             | `blocked`                                                                                    | `version-too-old` etc.                                      | Closed, deliberate, correct    |
| **401**         | `unauthorized` → retry `/token` → on failure `lastSyncUnauthorized = true` (`client.ts:481`) | **`revoked`** (`gate.ts:43`)                                | **Closed, hard, user-visible** |

The client's fail-open behaviour on 5xx is genuinely well done and is the reason a Cloudflare
incident does not immediately brick every customer. Credit where due.

**But the entire availability posture reduces to one question: can a transient server fault
produce a 401?** It can, in at least three ways:

1. **A D1 read that returns no row rather than throwing.** A Time Travel restore to before a
   device was created, a partially applied migration, a mis-scoped manual `DELETE` — any of these
   make `getDevice` return `null` → 401 (`licenseCore.ts:467`) → every affected customer's app
   says **revoked**. This is the failure mode that makes §5's restore procedure dangerous.
2. **Rate limiting — a live bug, not a hypothesis.** `/token` is capped at 30/min per IP
   (`licensing.ts:363-371`), and `reacquireToken` targets `/token` (`endpoints.ts:197-209`). A
   NAT'd office, a conference network, or a captive portal with 30+ devices trips it. The 429
   makes `re.kind !== "ok"`, so `fetchAndApply` sets `lastSyncUnauthorized` and **every device
   behind that IP displays "revoked."** A rate-limit trip is being conflated with a revocation.
3. **A dropped `KEY_HASH_PEPPER`** (§1.4) — the same 401 avalanche, platform-wide.

### 4.3 Recommendations

**A transient server condition must never produce a client-visible `revoked`.** Make revocation
an explicit server statement rather than an inference from a bare 401:

- Server: `validateDeviceToken` already computes six distinct failure reasons and collapses them
  all into `{error:"unauthorized"}` (`licenseCore.ts:453-471`). Return the reason. Emit
  `{"error":"unauthorized","revoked":true}` only for the deliberate cases — `device.status !==
"authorized"`, `license.status !== "active"`, license expired — and a bare `unauthorized`
  otherwise.
- SDK: treat a bare 401 as `error` (retry, keep grace); treat `revoked: true` as revocation.
- SDK: in `fetchAndApply`, do **not** set `lastSyncUnauthorized` when the `/token` reacquire
  failed with 429 or 5xx. Only a definitive 401 from `/token` is evidence of anything.

**Choose the rate-limiter's failure policy deliberately, and retry correctly.** Cloudflare's
[Durable Objects error-handling guidance](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
specifies the contract: errors carry `.retryable` ("suggested to be retried if requests … are
idempotent"), `.overloaded` ("should not be retried … retrying will worsen the overload"), and
— critically — "many exceptions leave the `DurableObjectStub` in a _broken_ state, such that all
attempts to send additional requests will just fail immediately with the original exception." A
retry must therefore acquire a **fresh stub**, not reuse the one that failed.

```ts
export async function rateLimitOk(
  env,
  product,
  rl,
  now,
  opts: { onError: "allow" | "deny" },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stub = env.RL.get(env.RL.idFromName(product)); // fresh stub each attempt
      /* … existing body … */
    } catch (err) {
      const e = err as Error & { retryable?: boolean; overloaded?: boolean };
      if (e.retryable && !e.overloaded && attempt === 0) continue; // one backoff-free retry
      logEvent({
        event: "ratelimit.unavailable",
        product,
        bucket: rl.bucket,
        policy: opts.onError,
        retryable: e.retryable === true,
        overloaded: e.overloaded === true,
        message: e.message,
      });
      return opts.onError === "allow";
    }
  }
  return opts.onError === "allow";
}
```

Note the counter increment is **not** idempotent, so a retry can double-count one request. That
is the correct trade here — over-counting a rate limit is harmless; failing the request is not.

My recommendation: **`allow` on the licensing hot paths** (`activate`, `token`, `enroll`,
`mint`) and **`deny` on `admin/auth.ts:150,195`**. Rationale: the limiter bounds credential
guessing, but the credential check itself still runs behind it — a DO outage that blocks every
activation is a worse business outcome than a temporarily unrated activation path. Admin login
is the opposite trade: highest-value target, human on the other end who can retry in a minute.

**Take KV off the critical path entirely — three lines.** `getTokenRecord` already has a working
D1 fallback for a KV _miss_ (`licenseCore.ts:455-464`), and a KV _error_ should degrade to it
identically:

```ts
export async function getTokenRecord(
  env,
  product,
  tokenHash,
): Promise<TokenRecord | null> {
  let raw: string | null;
  try {
    raw = await env.HOT.get(pk(product, "token", tokenHash));
  } catch (err) {
    logEvent({
      event: "kv.unavailable",
      op: "get",
      product,
      message: (err as Error).message,
    });
    return null;
  }
  return raw ? (JSON.parse(raw) as TokenRecord) : null;
}
```

**Retry D1 writes — the platform does not do it for you.** Per
[Cloudflare's D1 debugging docs](https://developers.cloudflare.com/d1/observability/debug-d1/),
"D1 detects read-only queries and automatically attempts up to two retries… **Only read-only
queries (`SELECT`, `EXPLAIN`, `WITH`) are retried**." Every write in this codebase is therefore
un-retried, and `db/d1.ts` adds no retry of its own. That matters most on the hot path:
`handleConfig` performs an `upsertDevice` write on **every single config poll**
(`licensing.ts:486-495`) purely to refresh `last_seen` and device metadata. A transient
`D1_ERROR` on that write turns a successful read into a 500.

Two fixes, in order of value:

1. Wrap the four methods in `db/d1.ts` with one retry on `D1_ERROR`/`D1_EXEC_ERROR` and a short
   backoff, logging `db.error` (§6.3) either way.
2. Better: stop writing on every poll. `last_seen` at one-second granularity has no operational
   value; write it only when it has moved by more than, say, 15 minutes. That removes the
   dominant write from the hot path entirely, which also matters for R11 — turning on hourly
   auto-refresh multiplies this write by every device on the platform.

**Add a top-level `try/catch` in `index.ts:76`** that logs the route and returns a generic 500.
Right now an uncaught throw returns the runtime's default error page and the only record is
whatever Workers Logs captured, unstructured.

**Add `GET /healthz`** — unauthenticated, no product — doing one trivial D1 read, one KV read,
and one DO ping, returning `{d1, kv, do}` with per-dependency status and HTTP 200 regardless, so
a monitor can alert on the body. Then **change the deploy smoke check** (`deploy.yml:60-66`)
from `/manage` (a static asset, §0) to `/healthz`, and fail the deploy if any dependency is
down.

---

## 5. Backup, restore, and pre-prod

**Grade: D−.** D1 Time Travel gives this platform a real 30-day safety net that the operator has
not earned, does not know about, and has never tested. Everything else is absent.

### 5.1 What exists today whether you know it or not

**D1 Time Travel** is automatic and always on: D1 retains the write-ahead log and can restore a
database to any point within the retention window without you configuring anything. Per
[Cloudflare's Time Travel reference](https://developers.cloudflare.com/d1/reference/time-travel/)
the window is **30 days on paid plans, 7 days on the free plan**. The `wrangler` binary in this
repo states the same in its own help text: `--timestamp` "Accepts a Unix (seconds from epoch) or
RFC3339 timestamp … to retrieve a bookmark for (**within the last 30 days**)."

Verified against `wrangler` 4.104.0 in this repo:

```sh
npx wrangler d1 time-travel info    polaris_key_prod --timestamp 2026-08-25T12:00:00Z --json
npx wrangler d1 time-travel restore polaris_key_prod --bookmark  <bookmark>
npx wrangler d1 time-travel restore polaris_key_prod --timestamp 2026-08-25T12:00:00Z
```

Three caveats that must be in the runbook:

- **Restore is in place and destructive.** Cloudflare's own wording: it "is a _destructive_
  operation, and overwrites the database in place." Take a `d1 export` first so you can go
  forward again.
- **A restore returns an undo bookmark**, so an unwanted restore can be reverted. Capture the
  current bookmark _before_ you restore anyway — belt and braces, and it costs one command.
- **A restore that rolls back device or license rows produces the 401 avalanche in §4.2.1**:
  every device created after the restore point vanishes, `getDevice` returns `null`, and those
  customers' apps display **revoked**. Fix §4.3 before you ever need this, or a recovery becomes
  a second incident.

**Nothing else has any backup.** KV has no first-party export or point-in-time recovery — you
build it from `kv key list` + `kv bulk get`. Worker secrets are write-only: `wrangler secret
list` returns names, never values. **If `PLATFORM_KEK` is lost — not leaked, _lost_ — every
sealed value in D1 is permanently undecryptable, and a D1 backup does not help.** That belongs
in the runbook in bold.

### 5.1a New finding: the disaster-recovery path is blocked today

SQLite-backed Durable Objects have their own 30-day point-in-time recovery. **This platform's DO
does not qualify**, on two counts, and the second one is the serious one.

`wrangler.toml:32-34` declares the class with the legacy migration form:

```toml
[[migrations]]
tag = "v1"
new_classes = ["RateLimitDO"]     # ← key-value-backed, NOT new_sqlite_classes
```

- **No PITR.** `new_classes` provisions a key-value-backed namespace, and only SQLite-backed
  namespaces get PITR. That is _fine_ on the merits — `RateLimitDO` holds ephemeral fixed-window
  counters (`rateLimitDo.ts:31-45`) that nobody needs to restore. Losing them costs one rate-limit
  window. Do not spend effort here.
- **But you cannot recreate this Worker from scratch.** Per
  [Cloudflare's Durable Objects migrations docs](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/),
  "creating new namespaces with the key-value storage backend is **no longer supported** for
  accounts without an existing key-value-backed namespace." The `legacy-kv` backend is permitted
  only "for namespaces that were already provisioned with key-value storage."

The consequence is a genuine disaster-recovery gap, and it is invisible until the worst possible
moment: **"redeploy Polaris Key into a clean Cloudflare account" — the recovery from account
loss, account compromise, or a billing/suspension event — fails on the DO migration.** Every
other asset (D1 export, KV snapshot, escrowed secrets, the Git repo) is restorable; the Worker
itself will not deploy.

**Fix, and it is cheap:** migrate the class to the SQLite backend now, while it holds nothing of
value. That property is exactly what makes this the right moment — a counter namespace is the
only DO you will ever get to switch backends without a data-migration plan.

```toml
[[migrations]]
tag = "v2"
deleted_classes = ["RateLimitDO"]

[[migrations]]
tag = "v3"
new_sqlite_classes = ["RateLimitDO"]
```

Deploy this **alone**, not alongside other changes, for the reason in §5.3: a DO lifecycle change
truncates your rollback horizon permanently. Then verify by deploying the same `wrangler.toml`
into a scratch account — which is the DR rehearsal you should have anyway.

### 5.2 Minimum viable backup set

Four items, in priority order:

**(1) A weekly D1 export to R2, run from CI.** This is the only thing that survives account-level
loss, and it is the one that gets you past the 30-day Time Travel horizon.

```sh
npx wrangler d1 export polaris_key_prod --env prod --remote \
  --output "polaris_key_prod-$(date -u +%Y%m%dT%H%M%SZ).sql" -y
```

> **An export is an outage.** Cloudflare's
> [import/export docs](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
> state plainly: "**A running export will block other database requests.**" The REST equivalent
> says the same — "this process may take some time for larger DBs, during which your D1 will be
> unavailable to serve queries." Because _every_ licensing request reads D1 (`loadProduct` alone
> is 2–3 queries before any handler runs), a backup taken at the wrong moment is a licensing
> outage. Schedule it at the traffic trough, keep it weekly rather than nightly until you have
> measured its duration, and **do not** add it to the deploy pipeline. This constraint alone
> justifies leaning on Time Travel as the primary recovery mechanism and treating the export as
> the off-platform archive.

Two hard requirements on the artefact, both from this repo's own findings:

- **Encrypt it.** Per the R12 audit findings (R12-02), managed secret values are
  stored **plaintext** in `profiles.payload_json` and `licenses.overrides_json`. A D1 export is
  therefore a cleartext dump of every product-delivered secret, plus customer names, emails, and
  OIDC subjects. Age or GPG it to a key held outside the Cloudflare account before it lands in
  R2.
- **Restrict the token.** Use a scoped Cloudflare API token with D1:read and R2:write only —
  not the deploy token.

Restore path (verified flags):

```sh
npx wrangler d1 execute polaris_key_prod --env prod --remote --file ./restore.sql
```

**The restore path has four sharp edges, and none of them are discoverable during an incident:**

- **The arithmetic does not close.** Max D1 database size is **10 GB**; max import file size is
  **5 GiB** ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). A full-size
  database cannot be restored from a single `--file`. Cloudflare's own guidance is to "split the
  data into multiple files" — which then collides with foreign-key ordering.
- **`BEGIN TRANSACTION` / `COMMIT;` must be stripped** from the dump before import.
- **Max SQL statement length is 100 KB.** Large multi-row `INSERT`s hit `"Statement too long"`
  and must be re-batched.
- **Foreign keys need import ordering** — `products` before everything, since `licenses`,
  `devices`, `keys_index`, `product_keys`, `product_secrets` and `audit` all reference
  `products(slug)`. The documented escape hatch is `PRAGMA defer_foreign_keys = true` before the
  violating statements.

**Rehearse this against a scratch database.** An untested restore is a hypothesis, and this one
has four ways to fail that you will not want to discover at 02:00.

**(2) Off-platform custody of the secrets.** Every Worker secret except `PLATFORM_KEK` is
re-derivable (regenerate and re-set) at the cost of an outage. `PLATFORM_KEK` is not — losing it
is unrecoverable. Store it, plus `KEY_HASH_PEPPER` (§1.4: rotating it is a platform-wide reissue,
so losing it is equivalent), in a password manager or an offline escrow, with a documented
two-person or two-device recovery path. This costs an afternoon and removes the only
truly-terminal failure mode.

**(3) A weekly KV snapshot, best-effort.** KV holds token→device pointers, key→license pointers,
short-lived OIDC/magic-link state, and cached GitHub tokens. Almost all of it is a _cache_
reconstructible from D1 (`licenseCore.ts:455-464` proves the token path self-heals), so this is
the lowest-value item — but the export is cheap:

```sh
npx wrangler kv key list --binding HOT --env prod --remote --prefix "p:" > keys.json
jq '[.[].name]' keys.json > keynames.json
npx wrangler kv bulk get keynames.json --binding HOT --env prod --remote > kv-snapshot.json
```

Four caveats:

- `kv bulk get` is still marked **open beta** in wrangler 4.104.0, and its input-file JSON format
  is not documented on any Cloudflare page. Verify the shape before relying on it in CI.
- **KV is eventually consistent — writes take up to 60 seconds to become globally visible**
  ([KV limits](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)). Any snapshot is
  therefore a _fuzzy_ one, never transactionally consistent. Fine here, because everything in KV
  is a cache reconstructible from D1 — but it must not be treated as a source of truth.
- `list()` returns at most 1,000 keys per page, and **`list_complete: false` means more keys
  remain even when the `keys` array is empty** — a paginator that stops on an empty page will
  silently truncate the backup.
- The snapshot contains live GitHub App installation tokens in plaintext (R12-03) — encrypt it
  exactly like the D1 export, or filter `:gh-token:` keys out before writing.

> **Never delete the KV namespace during a recovery.** Per
> [Cloudflare's rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
> a rollback is **blocked** when the target version's bindings reference a deleted KV namespace.
> Recreating `POLARIS_HOT_prod` under a new id would therefore permanently strand every rollback
> target that referenced the old one. Restore _into_ the existing namespace.

**(4) A monthly restore drill.** Restore last week's export into a scratch D1 database, run one
`SELECT COUNT(*)` per table against the production counts, and record the result and the elapsed
time in the runbook. Fifteen minutes a month.

### 5.3 Pre-production

`wrangler.toml:63-91` has `staging` and `dev` environments whose KV and D1 ids are
`REPLACE_ME_*`. Only prod has real ids (`wrangler.toml:54,58`). So there is exactly one
environment, and it is the one paying customers use. (`RUNBOOK.md:168-171` still tells operators
to replace `REPLACE_ME_PROD_D1_ID` — stale; prod was filled in.)

The consequences are concrete rather than theoretical:

- **The D1 migration in `deploy.yml:51` runs against production having never run anywhere else.**
  `wrangler d1 migrations` has **no down/rollback command** — verified locally: the subcommands
  are `create`, `list`, `apply`. A bad migration is a Time Travel restore, i.e. an incident.
- **§2's KEK rotation cannot be rehearsed**, which is precisely why §2.2's backwards-compatible
  fallback is non-negotiable.
- The deploy applies migrations _then_ deploys code (`deploy.yml:51,58`) with no rollback step,
  so a failed deploy leaves migrated schema against old code.

**Minimum viable pre-prod**, roughly two hours of work:

```sh
npx wrangler d1 create polaris_key_staging          # → database_id
npx wrangler kv namespace create POLARIS_HOT_staging # → id
# paste both over the REPLACE_ME_STAGING_* placeholders in wrangler.toml
npx wrangler secret bulk ./staging-secrets.json --env staging   # distinct values, never prod's
```

Then add a `staging` job to `deploy.yml` on `v*-rc*` tags that applies migrations, deploys, and
hits `/healthz`. Staging needs no customers to be useful — its job is to prove the migration
applies and the Worker boots against real bindings.

**And add a rollback step**, which is one command and currently absent:

```sh
npx wrangler deployments list --env prod       # find the previous version id
npx wrangler rollback <version-id> --env prod --message ""   # empty message = non-interactive
```

Better: switch the deploy to `wrangler versions upload` + `wrangler versions deploy`, so a new
version can be smoke-tested before taking traffic:

```sh
npx wrangler versions upload --env prod --tag "$GITHUB_SHA"          # → <new-version-id>
npx wrangler versions deploy <new-id>@0% <old-id>@100% --env prod -y # deployed, zero traffic
curl -fsS https://key.plrs.im/healthz \
  -H 'Cloudflare-Workers-Version-Overrides: polaris-key="<new-id>"' | jq .
npx wrangler versions deploy <new-id>@100% --env prod -y             # promote
```

Four constraints on that pattern, all of which bite this repo specifically:

- **There are no preview URLs.** Cloudflare
  [does not generate them for Workers that implement a Durable Object](https://developers.cloudflare.com/workers/configuration/previews/),
  and this Worker exports `RateLimitDO` (`index.ts:40`). The `@0%` + version-override header
  above is therefore the _only_ way to exercise a new version before it takes traffic.
- **A failed version override falls through silently** to the percentage split. The smoke check
  must assert _which_ version answered — add a `version_metadata` binding and return
  `env.CF_VERSION_METADATA.id` from `/healthz`, then assert on it. Without that assertion the
  test is checking the old version and passing.
- **Never use `wrangler secret put` during a gradual rollout** — it creates and _immediately
  deploys_ a new version, collapsing the split to 100%. Use `wrangler versions secret put`, which
  only creates the version.
- **Gradual deployments serve at most two versions**, and only the last 100 uploaded versions are
  eligible.

And the limit that matters most: **`wrangler rollback` reverts code, bindings, and secret values
— but not D1 schema, KV values, or DO storage.** That asymmetry (code goes back, data does not)
is the whole argument for staging, and it is why §5.1a's DO backend migration must ship alone:
a Durable Object lifecycle change is a one-way door — "once a lifecycle change is deployed,
rollbacks cannot take place to any version prior to the one that included the change."

---

## 6. Detection

**Grade: F.** Zero `console.*` calls in `packages/worker/src`. Workers Logs is configured at 100%
head sampling with `persist = true` (`wrangler.toml:11-15`), so it should capture invocation
metadata and uncaught exceptions — and nothing else, because nothing else is emitted.

> **Verify that logs are actually being ingested before relying on any of this.** The config
> sets `observability.enabled = false` (`wrangler.toml:7-8`) _and_ `observability.logs.enabled =
true` (`:11-12`). Cloudflare documents the top-level key as "when set to `true` on a Worker,
> logs for the Worker are persisted," and separately documents the nested `logs` block — but
> **does not document the precedence between them** when they disagree. The nested
> `logs.{enabled,destinations,persist}` keys and the whole `traces` block are absent from the
> Wrangler configuration reference entirely. This is a five-minute check in the dashboard
> (Workers & Pages → polaris-key → Observability) and it gates everything in §6. If the
> top-level flag wins, this platform currently has **no logs at all**, not merely no application
> logs.

Per
[Cloudflare's Workers Logs docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
retention is **7 days on paid plans** (3 days free), with **20 million log events per month
included** on paid. Two consequences: the security events in §6.3 are affordable — at djdl's
scale a handful of structured lines per request is well inside 20M/month, and `head_sampling_rate`
is already 1 so nothing is being dropped — but **7 days is too short for a security record**.
Anything you would want during an incident post-mortem needs Logpush to R2 alongside the D1
`audit` table.

### 6.1 What an operator would actually see, per attack this audit found

| Attack                                                  | What the operator sees today                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Forged admin session (leaked `ADMIN_SESSION_SECRET`)    | Audit rows attributed to a **plausible-looking actor of the attacker's choosing**. No login event exists to diff against PocketID. §1.3. |
| KEK compromise                                          | Nothing. Entirely offline.                                                                                                               |
| KEK **misconfiguration** (or a naive `PLATFORM_KEK_ID`) | Every product route 404s. **No log line.** Indistinguishable from "the products were deleted."                                           |
| License-key brute force                                 | Nothing. `/activate` 401s are neither logged nor audited, and rate-limit trips are silent.                                               |
| Forged GitHub webhook                                   | A changed `product_sync_state` row. **No audit row** — the webhook path never calls `audit()`.                                           |
| Webhook signature failure (i.e. someone probing)        | Nothing.                                                                                                                                 |
| Stolen device token replayed elsewhere                  | Nothing on `/config`. Fingerprint mismatch **is** audited (`licenseCore.ts:307-319`) — good — but only on `activate`.                    |
| D1 / KV / DO outage                                     | Uncaught exceptions in Workers Logs with a stack, no structured event, no way to attribute to a dependency.                              |
| A bad deploy                                            | Nothing — the smoke check passes regardless (§0).                                                                                        |

The pattern: the audit table is a good _administrative_ record and a poor _security_ record,
because it only ever fires on deliberate admin mutations.

### 6.2 Two channels, deliberately separated

- **Workers Logs**, via one structured helper, for anything high-volume or platform-scoped. The
  existing rationale for not auditing unauthenticated 401s (`admin/api.ts:69-71`: "that would be
  a D1-write DoS amplifier") is correct — and applies to **D1 writes**, not to a log line. A
  `console.log` costs nothing and is exactly the right channel for that traffic.
- **D1 `audit`**, unchanged, for low-volume, actor-attributable, operator-facing events.

```ts
// packages/worker/src/log.ts — new file, ~15 lines
export function logEvent(e: {
  event: string;
  outcome?: "ok" | "denied" | "error";
  product?: string;
  [k: string]: unknown;
}): void {
  // Structured single-line JSON so Workers Logs can filter on `event`.
  // NEVER log: license keys, device tokens, full token hashes, PEMs, session cookies,
  // pepper/KEK material, or customer email. An 8-char hash prefix is enough to correlate.
  console.log(JSON.stringify({ ts: Date.now(), ...e }));
}
```

### 6.3 The specific events to add

Ordered by value. The first one alone would have turned this review's worst-case outage into a
one-line diagnosis.

| Event                                                                           | Where                                                                                          | Channel           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------- |
| **`kek.open.failed`** — `{product, kind, id, sealedKekId, activeKekId}`         | `product.ts:118` and `product.ts:139` catch blocks                                             | log               |
| `product.load.failed` — `{slug, reason: "no-product"\|"no-key"\|"kek"}`         | `product.ts:93`, `:95`, `:118`                                                                 | log               |
| `auth.admin.login` / `auth.admin.denied` — `{sub, groups, ip}`                  | `admin/auth.ts`, after `issueSession` / at the `hasAnyAdminGrant` denial (`admin/auth.ts:220`) | **audit + log**   |
| `auth.admin.session.invalid`                                                    | `admin/session.ts:160` (`if (!ok) return null`)                                                | log               |
| `token.validate.failed` — `{reason}`                                            | `licenseCore.ts:453-471`, which already computes 6 distinct reasons and collapses them all     | log               |
| `license.activate.failed` — `{reason: "bad-key"\|"inactive-key"\|"no-license"}` | `licensing.ts:316-320`                                                                         | log (counts only) |
| `ratelimit.tripped` — `{bucket, product, ipHash}`                               | `rateLimit.ts`, on `ok === false`                                                              | log               |
| `ratelimit.unavailable`                                                         | new catch, `rateLimit.ts:34` (§4.3)                                                            | log               |
| `kv.unavailable`                                                                | new catch, `kv.ts:23` (§4.3)                                                                   | log               |
| `db.error` — `{op, table}`                                                      | wrap the four methods in `db/d1.ts`                                                            | log               |
| `webhook.github.signature.failed` — `{delivery, repo}`                          | `githubWebhook.ts` verify path                                                                 | **log + audit**   |
| `webhook.github.resync` — `{repo, ref, products, changedPaths}`                 | `githubWebhook.ts` success path                                                                | **audit**         |
| `kek.reseal` — `{from, to, count}`                                              | new (§2.6)                                                                                     | **audit**         |
| `unhandled` — `{route, message}`                                                | new top-level catch, `index.ts:76`                                                             | log               |

### 6.4 The audit table cannot hold platform events

```sql
-- migrations/0001_init.sql:182
product TEXT NOT NULL REFERENCES products(slug),
```

Admin login, KEK resealing, webhook forgery, and platform-admin authz denials have **no
product**. Two options:

- **Recommended:** insert a sentinel `products` row with slug `_platform` (status
  `'deleted'` so `getProduct` at `repo.ts:221` never resolves it as a real product, and
  `listProducts` at `:228` never shows it). One migration, zero code change, and
  `listAudit(db, "_platform")` works immediately.
- Alternative: drop the FK and make `product` nullable. Cleaner modelling, but the FK is doing
  real referential work elsewhere and this touches the primary key.

### 6.5 Alerting

Logging without alerting is archaeology — doubly so at a 7-day retention window, where an
unalerted event is gone before anyone thinks to look. Minimum: a Workers Logs / Logpush filter
alerting on
`event = "kek.open.failed"` (any occurrence), `event = "auth.admin.login"` (any occurrence — the
admin population is small enough that every login is worth a notification), and
`event = "webhook.github.signature.failed"` (any occurrence). Those three are individually
actionable and individually rare.

---

## 7. Ranked recommendations

Ordered by (irreversibility of the risk) × (1 / effort). Effort assumes one engineer already
fluent in this codebase.

| #       | Recommendation                                                                                                                                                                                                                        | Why it ranks here                                                                                                                                                                                                                                 | Effort                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **R1**  | **Ship the dual-KEK keyring (§2).** Keyring resolution, `open()` accepts any kid in the ring, `kek_id` column + reseal sweep + status endpoint.                                                                                       | The only fix that converts §1.2 from "unrecoverable" to "a procedure." Everything else is recoverable without it; nothing is recoverable with it missing.                                                                                         | **0.5 day**                             |
| **R2**  | **Escrow `PLATFORM_KEK` and `KEY_HASH_PEPPER` off-platform**, with a documented recovery path.                                                                                                                                        | Loss (not leak) of `PLATFORM_KEK` is terminal and no backup helps. Highest value per minute spent in this table.                                                                                                                                  | **1 hour**                              |
| **R3**  | **Delete `PLATFORM_KEK_ID` or document it.** Until R1 ships, it is a documented-looking env var whose use is a total, silent, undiagnosable outage.                                                                                   | Removes an active foot-gun.                                                                                                                                                                                                                       | **15 min**                              |
| **R4**  | **Fix client-side key revocation (§3.4):** honour `key.status`, rebuild trust from the pinned set, publish revoked kids as tombstones for 90 days. All three SDKs + `repo.ts:330` + `jwks.ts:54-57`.                                  | Without it, signing-key rotation protects only new installs and the §1.1 leak is permanent.                                                                                                                                                       | **1 day** (3 SDKs + conformance corpus) |
| **R5**  | **Stop transient faults presenting as `revoked` (§4.3):** explicit `revoked: true` from the server; SDK ignores 429/5xx on reacquire.                                                                                                 | Fixes a live bug (NAT'd offices see "revoked"), and de-fuses the D1-restore path so R7 is safe to use.                                                                                                                                            | **0.5 day**                             |
| **R6**  | **Add `logEvent` + the 14 events in §6.3**, the `_platform` audit sentinel, the top-level catch in `index.ts`, alerts on the three events in §6.5, and Logpush→R2 for the `event` stream (Workers Logs retains only 7 days).          | Converts every incident in this document from "undiagnosable" to "one log filter."                                                                                                                                                                | **1 day**                               |
| **R6a** | **Verify Workers Logs is actually ingesting** (§6): `observability.enabled = false` sits next to `observability.logs.enabled = true` and the precedence is undocumented. Check the dashboard; make the config unambiguous.            | If the top-level flag wins, the platform has _no_ logs, and every other detection recommendation is built on sand. Five minutes.                                                                                                                  | **5 min**                               |
| **R7**  | **Weekly encrypted D1 export to R2 + a rehearsed restore (§5.2).** Scoped token, age/GPG, one drill. Schedule at the traffic trough — **an export blocks the database**.                                                              | Time Travel already covers 30 days; this covers everything past it and account-level loss.                                                                                                                                                        | **0.5 day** + 15 min/month              |
| **R7a** | **Migrate `RateLimitDO` from `new_classes` to `new_sqlite_classes` (§5.1a), shipped alone.**                                                                                                                                          | Key-value-backed DO namespaces can no longer be created. Today "redeploy into a clean Cloudflare account" — the recovery from account loss or compromise — **fails**. The DO holds only ephemeral counters, so this is the one moment it is free. | **1 hour**                              |
| **R8**  | **`/healthz` + a `version_metadata` binding, and point the deploy smoke check at it** (`deploy.yml:60-66`). Add `wrangler rollback --message ""` on smoke failure, and capture the Time Travel bookmark before `d1 migrations apply`. | Today's smoke check curls a static asset and is incapable of failing. This Worker gets no preview URLs (it exports a DO), so `@0%` + a version-override header — asserted via `version_metadata` — is the only pre-traffic test available.        | **3 hours**                             |
| **R9**  | **Write the runbook sections in §8** into `docs/RUNBOOK.md`, and fix the `PLATFORM_ADMIN_GROUP` drift.                                                                                                                                | `RUNBOOK.md:72,145` say `admin`; `RUNBOOK.md:21`, `DEPLOYMENT.md:234,336` say `admins`. An authz-critical value is wrong in two places _within the same file_.                                                                                    | **3 hours**                             |
| **R10** | **Wrap `rateLimitOk` and `getTokenRecord` with explicit failure policies (§4.3)**, retrying DO calls on `.retryable` with a _fresh stub_. Add a D1 write retry, and stop the per-poll `upsertDevice` (`licensing.ts:486`).            | Turns three accidental 500s into deliberate decisions. D1 auto-retries reads only — every write here is unprotected, including one on the hottest path.                                                                                           | **2 hours**                             |
| **R11** | **Revocation SLA defaults (§3.3):** `refreshIntervalSeconds` 3600 and `default_max_offline_days` 7, both in the next major SDK/product version, with `graceUntil` surfaced for a warning ramp.                                        | Real revenue and revocation impact, but it is a behaviour change for shipped integrations and must ride a major version.                                                                                                                          | **0.5 day** + a major release           |
| **R12** | **Stand up staging (§5.3)** and gate `v*-rc*` tags on it.                                                                                                                                                                             | Makes R1 and every future migration rehearsable. Ranked below R1 because R1's fallback design deliberately does not need it.                                                                                                                      | **2 hours**                             |
| **R13** | **CHECK constraint on `product_keys.status`** and fix the `-- active \| retired` comment at `migrations/0003_keyvault.sql:15`.                                                                                                        | A typo'd status silently removes a key from the verification set and takes a product's signing offline.                                                                                                                                           | **1 hour**                              |
| **R14** | **Shard the rate-limit DO** (`rateLimit.ts:23`) 16 ways.                                                                                                                                                                              | Removes a per-product single point of failure and a global serialisation point.                                                                                                                                                                   | **1 hour**                              |
| **R15** | **Remove the `PORTAL_SESSION_SECRET ?? ADMIN_SESSION_SECRET` fallback** (`portal/session.ts:62`).                                                                                                                                     | Silently merges two trust domains; rotating one should never sign out the other.                                                                                                                                                                  | **15 min**                              |

R1–R3 total under a day and remove both unrecoverable-today scenarios that have a fix. R4 removes
the third.

---

## 8. Draft runbook sections

Written to be lifted into `docs/RUNBOOK.md` as-is. They describe the system **after** R1 lands
where noted; the KEK section is marked accordingly.

### 8.1 Incident response — first 15 minutes

````markdown
## Incident response

### Triage

| Symptom                             | Most likely cause                                                                     | First check                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Every product route 404s            | KEK cannot open sealed keys; or `PLATFORM_KEK_ID`/`PLATFORM_KEK_ACTIVE` misconfigured | Workers Logs, filter `event = "kek.open.failed"`                   |
| One product 404s                    | That product has no `status='active'` row in `product_keys`                           | `SELECT kid, status FROM product_keys WHERE product = ?`           |
| Widespread 500s                     | D1, KV, or the rate-limit DO is unavailable                                           | `curl https://key.plrs.im/healthz`                                 |
| Customers report "revoked" en masse | A 401 avalanche: pepper changed, devices rows lost, or `/token` rate-limited          | Workers Logs, `event = "token.validate.failed"`, group by `reason` |
| Admin actions you did not take      | Forged session or a compromised admin account                                         | §8.4, then diff `audit` against PocketID sign-ins                  |

### Standing rules

1. **Do not rotate `KEY_HASH_PEPPER` under time pressure.** It invalidates every license key and
   every device token platform-wide and cannot be undone — the plaintext keys are not stored.
   See §8.5.
2. **Do not run `wrangler d1 time-travel restore` before capturing the current bookmark.**
   The restore is in place and destructive.
3. **Rotating a secret deploys a new Worker version.** Use `wrangler secret bulk` when two or
   more secrets must change together, so they land in one version rather than two.
4. **A rollback un-rotates secrets.** Secret values live inside the Worker version, so
   `wrangler rollback` restores the _old_ value along with the old code. After any rollback,
   re-apply every secret you rotated during the incident.
5. Every containment step below is safe to run twice.

### Capture state before changing anything

```sh
cd packages/worker
npx wrangler deployments list --env prod > /tmp/deployments.txt
npx wrangler d1 time-travel info polaris_key_prod --env prod --json > /tmp/bookmark.json
npx wrangler d1 export polaris_key_prod --env prod --remote --output /tmp/pre-incident.sql -y
npx wrangler secret list --env prod > /tmp/secret-names.txt   # names only; values are never readable
```

Encrypt `/tmp/pre-incident.sql` before it leaves the machine — it contains plaintext managed
secrets and customer PII.
````

### 8.2 Rotating `PLATFORM_KEK` (requires the dual-KEK keyring, §2)

````markdown
## Rotating PLATFORM_KEK

Two-KEK read window. The platform stays up throughout. Do not skip step 6.

1. Generate the new KEK and confirm it decodes to exactly 32 bytes:

   ```sh
   NEW_KEK=$(openssl rand -base64 32)
   echo -n "$NEW_KEK" | base64 -d | wc -c    # must print 32
   ```

2. Record the current active kid:

   ```sh
   curl -fsS https://key.plrs.im/manage/api/platform/kek/status -H "cookie: pkey_admin=…" | jq .
   ```

3. **Add the new key WITHOUT making it active.** One `secret bulk` call = one Worker version.

   ```jsonc
   // /tmp/kek.json  — delete this file immediately afterwards
   {
     "PLATFORM_KEK_KEYS": "{\"k1\":\"<old base64>\",\"k2\":\"<NEW_KEK>\"}",
     "PLATFORM_KEK_ACTIVE": "k1",
   }
   ```

   ```sh
   npx wrangler secret bulk /tmp/kek.json --env prod && shred -u /tmp/kek.json
   ```

4. Verify nothing broke — every sealed blob still carries `k1` and still opens:

   ```sh
   curl -fsS https://key.plrs.im/djdl/.well-known/jwks.json | jq .
   curl -fsS https://key.plrs.im/healthz | jq .
   ```

   A 404 here means the keyring did not parse. Re-set `PLATFORM_KEK_KEYS` with only `k1`
   and stop.

5. **Promote the new key.** New seals now use `k2`; old blobs still open under `k1`.

   ```jsonc
   {
     "PLATFORM_KEK_KEYS": "{\"k1\":\"<old>\",\"k2\":\"<NEW_KEK>\"}",
     "PLATFORM_KEK_ACTIVE": "k2",
   }
   ```

6. **Re-encrypt everything.** Loop until `remaining` is 0:

   ```sh
   curl -fsS -X POST https://key.plrs.im/manage/api/platform/kek/reseal \
     -H "cookie: pkey_admin=…" -H "X-PKey-CSRF: …" -d '{"limit":50}'
   ```

   Then confirm the sweep is genuinely complete — this is the gate for step 8:

   ```sh
   curl -fsS https://key.plrs.im/manage/api/platform/kek/status -H "cookie: pkey_admin=…" | jq .
   # counts must show ZERO rows under any kid other than the active one
   ```

7. Soak for **24 hours**. Nothing should reference `k1`; if `event = "kek.open.failed"` appears
   with `sealedKekId: "k1"`, a row was missed — return to step 6.

8. **Drop the old key.**

   ```jsonc
   {
     "PLATFORM_KEK_KEYS": "{\"k2\":\"<NEW_KEK>\"}",
     "PLATFORM_KEK_ACTIVE": "k2",
   }
   ```

9. Update the escrow copy (§8.6) and destroy the old KEK material.

**Rollback:** at any point before step 8, re-set `PLATFORM_KEK_ACTIVE` to the previous kid while
keeping both keys in `PLATFORM_KEK_KEYS`. Blobs already resealed under the new kid still open,
because the ring still contains it. After step 8 there is no rollback — this is why step 7
exists.
````

### 8.3 Compromised product signing key

````markdown
## Compromised product signing key

Assume every document signed with that kid is forgeable until every client has dropped it.

1. **Rotate.** Break-glass skips the 300s trust-cache soak; use it if forged documents are
   actively circulating.

   ```sh
   BASE=https://key.plrs.im/manage/api/products/<slug>/keys
   curl -fsS -X POST $BASE/prepare  -H "cookie: …" -H "X-PKey-CSRF: …"          # → {kid}
   curl -fsS -X POST $BASE/activate -H … -d '{"kid":"<new>","breakGlass":true}'
   ```

2. **Revoke the leaked kid** (not `retire` — retired keys stay in the verification set):

   ```sh
   curl -fsS -X POST $BASE/revoke -H … -d '{"kid":"<leaked>"}'
   ```

3. **Confirm the trust manifest publishes the revocation.** Requires R4; until R4 ships, a
   revoked kid silently disappears and offline clients never learn of it.

   ```sh
   curl -fsS https://key.plrs.im/<slug>/.well-known/jwks.json | jq '.keys[].kid'
   ```

4. **Ship an SDK/app update with a regenerated pinned trust set.** Until R4 ships this is the
   _only_ thing that protects the installed base — every client that has ever seen the leaked
   kid trusts it permanently.

5. Rotate any product secret the same attacker could have reached:
   `PUT /manage/api/products/<slug>/secrets/<name>`.

6. Audit the window: `SELECT * FROM audit WHERE product = ? AND at > ? ORDER BY at DESC`.
````

### 8.4 Compromised admin session or admin account

````markdown
## Compromised admin session or account

Sessions are stateless HMAC. There is no per-session revocation and **removing the user from the
`admins` group at PocketID has no effect for up to 8 hours**, because groups are carried in the
cookie. Global secret rotation is the only working containment.

1. **Invalidate every session** (yours included; all admins re-login):

   ```sh
   npx wrangler secret put ADMIN_SESSION_SECRET --env prod
   ```

   If `PORTAL_SESSION_SECRET` is not separately set, this also signs out every customer.
   Confirm it is set: `npx wrangler secret list --env prod | grep PORTAL_SESSION_SECRET`.

2. Remove the account at PocketID and confirm `PLATFORM_ADMIN_GROUP` membership is minimal.
3. Review `audit` for the incident window. **Treat the actor fields as untrusted** — a forged
   session carries attacker-chosen `sub`/`name`/`email`. Cross-reference PocketID sign-in logs;
   any audit row with no matching sign-in is suspect.
4. Rotate anything reachable from the admin API: product signing keys (§8.3) and every product
   secret. Product secrets are write-only, so you cannot tell whether they were changed — rotate
   them all.
5. Check `products` for soft-deletes (`status = 'deleted'`) and `product_sync_state` for
   unexpected resyncs.
````

### 8.5 `KEY_HASH_PEPPER` — read before touching

````markdown
## KEY_HASH_PEPPER

**Do not rotate this as a routine secret. Rotating it is a platform-wide credential reissue.**

`hashKey` is `HMAC(pepper, value)` with no pepper id and no dual-read (`crypto.ts:75-90`).
Changing it means:

- Every device token stops matching → every customer's app displays **"revoked"**, not
  "sign in again".
- Every license key stops matching → and license keys are stored **only as hashes**. The
  plaintext was shown once at issue and is not recoverable. You must mint new keys for every
  license and deliver them to every customer.

Leaking the pepper is low-impact on its own — it is only useful with a D1/KV dump. **The
containment is worse than the compromise.** If it leaks, prioritise protecting D1 read access
(rotate Cloudflare API tokens, audit account access) over rotating the pepper.

Also: if the secret is ever _unset_, `hashKey` silently falls back to unpeppered SHA-256
(`crypto.ts:76`) with the identical mass-invalidation and no error. Verify it is present after
any secret change:

```sh
npx wrangler secret list --env prod | grep KEY_HASH_PEPPER
```

A safe rotation requires versioning the pepper (R6) so both peppers can be checked during a
migration window. Do not attempt one before then.
````

### 8.6 Backup and restore

````markdown
## Backup and restore

### What is protected

| Store          | Mechanism                                                              | Window                  |
| -------------- | ---------------------------------------------------------------------- | ----------------------- |
| D1             | Time Travel — automatic, always on                                     | **30 days** (paid plan) |
| D1             | Weekly encrypted export to R2                                          | Per retention policy    |
| KV             | Weekly best-effort snapshot (eventually consistent — a fuzzy snapshot) | Per retention policy    |
| Rate-limit DO  | **None** — ephemeral counters, intentionally not backed up             | —                       |
| Worker secrets | **None** — write-only. Off-platform escrow only.                       | —                       |

**Taking a D1 export blocks the database.** Every licensing request reads D1, so run exports at
the traffic trough and never from the deploy pipeline.

**`PLATFORM_KEK` is not in any backup and is not recoverable from one.** If it is lost, every
sealed value in D1 is permanently undecryptable and the platform must be re-keyed from scratch.
Escrow it, plus `KEY_HASH_PEPPER`, outside the Cloudflare account.

### Point-in-time restore (D1 Time Travel)

```sh
cd packages/worker

# 1. ALWAYS capture the current bookmark first — the restore is in place and destructive.
npx wrangler d1 time-travel info polaris_key_prod --env prod --json | tee /tmp/bookmark-now.json

# 2. Find the bookmark for the target time.
npx wrangler d1 time-travel info polaris_key_prod --env prod \
  --timestamp 2026-08-25T12:00:00Z --json

# 3. Restore.
npx wrangler d1 time-travel restore polaris_key_prod --env prod --bookmark <bookmark>
```

**Before restoring, understand the client-side blast radius.** Any device row created after the
restore point disappears. `validateDeviceToken` then returns 401 and — until R5 ships — the SDK
reports **`revoked`** to the end user. Plan customer communications _before_ you restore, or
restore only specific tables from an export instead.

To undo an unwanted restore, restore again to the bookmark captured in step 1.

### Export and reload

```sh
npx wrangler d1 export polaris_key_prod --env prod --remote --output ./backup.sql -y
npx wrangler d1 export polaris_key_prod --env prod --remote --output ./schema.sql --no-data -y
npx wrangler d1 export polaris_key_prod --env prod --remote --output ./licenses.sql \
  --table licenses --table keys_index --table devices -y

npx wrangler d1 execute polaris_key_prod --env prod --remote --file ./backup.sql
```

**Every export is a cleartext dump of customer PII and of managed secret values** (which are
stored plaintext in `profiles.payload_json` and `licenses.overrides_json`). Encrypt it before it
leaves the machine and never commit one.

### Monthly drill

Restore last week's export into a scratch D1 database, compare row counts per table against
production, and record the result and elapsed time here. An untested restore is a hypothesis.
````

### 8.7 Deploy rollback

````markdown
## Rolling back a deploy

`.github/workflows/deploy.yml` applies D1 migrations and then deploys, with no rollback step.

> **A rollback restores old secret values along with old code.** Classic Worker secrets are
> bindings, and a version captures its bindings — so `wrangler rollback` will silently
> **un-rotate** any secret changed since the target version. If you have rotated a secret during
> an incident, **re-apply it immediately after any rollback** or the compromised value is live
> again. Check `wrangler secret list --env prod` and re-`put` anything from §8.2–§8.5.

```sh
cd packages/worker
npx wrangler deployments list --env prod        # find the previous version id
npx wrangler rollback <version-id> --env prod --message ""   # empty message = non-interactive
```

Rollback is **blocked** if the target version references a deleted KV namespace, or if a Durable
Object lifecycle change was deployed after it. Only the 100 most recent versions are eligible.

`wrangler rollback` reverts code, bindings, and secret values. It does **not** revert D1 schema,
D1 rows, KV values, DO storage, routes, custom domains, or cron triggers.

If the bad deploy included a migration, roll the code back first, then decide between a forward
fix and a Time Travel restore. `wrangler d1 migrations` has **no down command** — there is no
schema rollback other than a restore. Because of this, **capture the Time Travel bookmark
immediately before every `d1 migrations apply`** and record it with the deploy; that bookmark is
the only break-glass for a bad migration.

```sh
npx wrangler d1 time-travel info polaris_key_prod --env prod --json | tee /tmp/pre-migration.json
npx wrangler d1 migrations apply polaris_key_prod --env prod --remote
```

Prefer expand/contract schema changes (add nullable column → backfill → switch reads → drop) so
that no migration ever _needs_ reverting.

After any rollback:

```sh
curl -fsS https://key.plrs.im/healthz | jq .
curl -fsS https://key.plrs.im/djdl/.well-known/jwks.json | jq .
```

Note: `curl https://key.plrs.im/manage` is **not** a valid health check — it serves a static
asset and returns 200 with the entire data plane down.
````
