# Business-model fit — architecture review

**Lens.** Does the enforcement effort match the revenue at risk? Is the licensing model coherent
as a _commercial_ design, not merely as a correct one? This is a graded architecture review with
an explicit opinion, because the owner asked whether the licensing strategy is **sound** and a
hedged answer would be worthless.

**Scope.** The model (`license` / `key` / `device` / `tier` / `profile`), the auto-issue path, the
offline-grace defaults, the three-way coupling of licensing + managed config + release
distribution, and the build/value ratio of the tree at HEAD `bd26e0b`. Read-only review; no
source files were modified.

**Sibling reviews.** `anti-piracy-realism.md` grades the _enforcement mechanisms_;
`multi-tenant-blast-radius.md` grades _compromise containment_; `docs/security/findings/R3-licensing.md`
enumerates the _exploits_. This review deliberately does not re-argue those. Where it reaches a
different conclusion from a sibling — §4 in particular — the disagreement is stated explicitly.

**Method.** Static reading of the tree, the migration history, and `git log`; line counts by
`find | wc -l` over `.ts/.tsx/.py/.swift/.sql/.json` excluding `node_modules`, `dist`, `.venv`,
`.build`, `.turbo`; unit economics computed from Cloudflare's published D1 and KV pricing
(fetched 2026-08-25).

---

## Verdict at a glance

| #   | Question                                                    | Grade  |
| --- | ----------------------------------------------------------- | :----: |
| 1   | Is the core model coherent?                                 | **C+** |
| 2   | Is the "always free" tier farmable in a way that _matters_? | **D+** |
| 3   | Does enforcement effort match revenue at risk?              | **D**  |
| 4   | Is the offline-grace default right?                         | **C−** |
| 5   | What is it actually selling, and does the design serve it?  | **C**  |
| 6   | Competitive standing                                        | **C+** |
| 7   | Ranked build / stop                                         |   —    |

**Overall: C.**

**Is the licensing strategy sound? No — but not for the reason the code review lane would
suggest.** The strategy is unsound because there is no strategy: there is a well-built
enforcement engine attached to a product that is given away to family and friends, with no
price, no biller, no second tier, and no written statement of who is ever expected to pay.
Every specific defect below — the farmable free tier, the inert re-licensing default, the dead
`customers` table, the 43-route surface — is downstream of that single omission. The individual
mechanisms are mostly correct. The thing they add up to has not been decided.

The most useful sentence in this review: **this platform's real product is signed managed
configuration and release delivery; licensing is the authorization layer for those two, and it
has been mistaken for the main event.** Three of the last three feature commits were licensing
features (`ada5961` fingerprinting, `415dff8` auto-issue, `bd26e0b` re-licensing) shipped to a
product with zero revenue. That is the misallocation this document is about.

Two grounding facts, both from §6. The licensing and release halves of this platform, at today's
scale, are available **free** on Keygen's Dev tier (100 active licensed users, 10 releases) — so
~47,000 lines of source are competing with $0/month. But the config half is genuinely
differentiated: **no licensing vendor delivers typed, schema-validated, `enforced`/`hidden`
managed configuration**, and Keygen's nearest equivalent is immutable once signed. The
conclusion is not "should have bought." It is "built the wrong half first."

---

## 0. The denominator: what revenue is actually at risk

Every grade below is a ratio, so the denominator has to be named first, and it is uncomfortable.

| Fact                                                                                                    | Evidence                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| One product is registered                                                                               | `products/` contains exactly `djdl/`                                                                                                                |
| That product has **one tier**, `standard`, no expiry, 5 devices                                         | `products/djdl/product.json:20-28`                                                                                                                  |
| Its entitlement map grants that tier to the IdP groups `family` and `friends`                           | `products/djdl/product.json:14-18`                                                                                                                  |
| No billing, subscription, payment, invoice, price, or trial-conversion code exists anywhere in the tree | `grep -riE 'stripe\|billing\|subscription\|paddle\|checkout\|invoice\|trial'` over all source returns only djdl's _VPN_ subscription URL config key |
| **No `LICENSE` file** — so the tree is, strictly, all-rights-reserved and unadoptable                   | repo root (a `SECURITY.md` landed from a parallel audit lane during this review; a licence did not)                                                 |
| Every package is `0.0.0`; nothing is published                                                          | `packages/*/package.json`                                                                                                                           |
| No expected user count, traffic volume, or operating cost is written down anywhere                      | `grep -niE 'cost\|scale\|users\|traffic\|volume'` over `DEPLOYMENT.md` + `RUNBOOK.md` returns nothing                                               |
| ~47k lines of source + ~32k lines of tests, 5 languages, 37 commits, 2026-06-23 → 2026-08-25            | `git log`; line counts per §3                                                                                                                       |

**Revenue at risk today: zero.** Not "small" — zero. There is no mechanism by which any human
gives this system money.

That does not make the work worthless. It makes every question of the form "is the enforcement
proportionate?" answerable only in the future tense, and it means the honest grade for
proportionality is poor regardless of code quality. It also means the highest-value artifact
this project could produce next is not code — it is one page saying who is expected to pay for
what.

---

## 1. Is the core model coherent? — **Grade: C+**

### 1.1 The decomposition is right, and in one place better than the market

`license → key → device`, with `tier` carrying policy and `profile` carrying payload, is the
correct decomposition. Mapped to the market:

| Polaris Key                 | Keygen                       | Cryptolens                   | LicenseSpring      | Verdict              |
| --------------------------- | ---------------------------- | ---------------------------- | ------------------ | -------------------- |
| `product`                   | `product`                    | `product`                    | `product`          | Parity               |
| `tier`                      | `policy`                     | (feature set)                | `license policy`   | Parity, better name  |
| `license`                   | `license`                    | `license key`                | `license`          | Parity               |
| `key` (`pkey_…`)            | — (the key _is_ the license) | — (the key _is_ the license) | —                  | **Ahead**            |
| `device` (`pkeyt_…` bearer) | `machine`                    | `machine code`               | `device`           | Parity               |
| `profile`                   | (metadata)                   | (data objects)               | (custom fields)    | **Ahead** for config |
| —                           | `user`, `group`              | `customer`                   | `user`, `customer` | **Behind**           |

Two things are genuinely better than the comparison set:

1. **Separating `key` from `license`.** In Keygen and Cryptolens the key string _is_ the license
   identity, so rotating a leaked key means issuing a new license and losing the device state
   attached to the old one. Polaris stores keys in `keys_index` with their own `status`
   (`0001_init.sql:85-96`), so a license can hold several keys, any one of which can be revoked
   independently without disturbing a single activated device. That is the right shape and it is
   not free elsewhere.
2. **`profile` as a reusable payload baseline, stackable and ordered** (`0004_license_profiles.sql`).
   No licensing vendor has this because no licensing vendor delivers config. It is the correct
   primitive for the half of the platform that actually matters (§5).

The four-layer merge — `tier(profile) → license(profile) → license overrides → device overrides`
(`licenseCore.ts:196-227`) — is coherent, and correctly mirrors how MDM systems layer. Later
layers winning is legitimate admin authority, and the pre-signing catalog validation
(`configDoc.ts:33-55`) that prunes anything the catalog does not recognise is a genuinely good
piece of defensive design.

### 1.2 `customers` is redundant _as shipped_, and the redundancy is a stalled decision

The brief asks whether `customers` (`0007_backend_contracts.sql:6-31`) duplicates `licenses`.
It is worse than duplicative — it is **dead**:

```
$ grep -rn 'INTO customers|UPDATE customers|FROM customers' packages/*/src
(no matches)
```

Zero reads, zero writes, zero rows, in any source file. Its only live trace is
`devices.customer_id`, which is read once and carried forward verbatim
(`licenseCore.ts:363`) and is therefore always `NULL`, and two foreign keys pointing into it
from `release_download_tokens` (`0007_backend_contracts.sql:134`).

Column-for-column it holds `status`, `sub`, `name`, `email`, `groups_json` — the same five
identity fields `licenses` already has (`0001_init.sql:67-71`) — plus `external_id` and
`metadata_json`. So on the surface it is redundant. But the _intent_ is not redundant at all: it
is the beginning of the correct split — **`customer` = who the person is, `license` = what they
bought** — which is exactly Keygen's `user`/`license` separation and exactly what you need
before you can have organizations, seat transfer, or a billing linkage.

The problem is that the split was started, abandoned, and then **answered a second time,
differently**, one migration later. `0008_portal.sql` introduces `portal_accounts`,
`portal_account_emails`, `portal_account_identities`, and `portal_license_links` — a
platform-global identity model that solves the same problem with different tables and a
different scoping decision (global, not product-scoped).

The schema therefore now contains **three** overlapping answers to "who is this person":

| Answer                         | Tables                                | Scope               | Live?                       |
| ------------------------------ | ------------------------------------- | ------------------- | --------------------------- |
| Identity fields on the license | `licenses.sub/name/email/groups_json` | product             | **Yes** — the only one used |
| First-class customer           | `customers`                           | product             | No — zero rows, zero code   |
| Portal account                 | `portal_accounts` + 3                 | **platform-global** | Yes                         |

That is not redundancy in the abstract. It is a fork in the road that was never resolved, and it
is now load-bearing in the threat model: `THREAT-MODEL.md:32` lists `customers` under asset A6
("Customer PII … plaintext") for a table that holds no data. An audit finding against an empty
table is a small thing; a schema that documents an architectural decision nobody made is not.

**Recommendation: delete `customers` and its two foreign keys now.** Re-introduce it only when
there is a customer to put in it, and when you do, make `portal_accounts` the identity and
`customers` the product-scoped projection of it — do not ship a third answer.

### 1.3 What is missing, ranked by business consequence

**1. No billing or subscription linkage — the structural gap.**
Nothing in this system knows what "paid" means. `licenses.expires_at` is set at creation and
mutated only by an admin's explicit `expiresAt` in a PATCH body
(`admin/handlers/licenses.ts:239-244`). There is no renewal, no dunning, no external
subscription id, no webhook receiver. If a card declines, an operator must remember to go change
a row by hand. Every platform in §6 either _is_ the biller or has documented first-class
integration with one. This is the single largest structural absence, and it is the one that makes
"is the licensing strategy sound?" answerable with "there isn't one."

**2. `tiers.policy_expiry_days` is honored on exactly one of four paths.**
This is an original finding and it is a live commercial bug, not a gap:

| Path                     | Site                                                                    | Honors tier expiry? |
| ------------------------ | ----------------------------------------------------------------------- | :-----------------: |
| OIDC activation          | `oidc.ts:326-331` — `expiresAt = now + tier.policy_expiry_days * 86400` |       **Yes**       |
| Anonymous enroll         | `enroll.ts:71` — `expires_at: null` hardcoded                           |         No          |
| Admin create             | `admin/handlers/licenses.ts:117` — `body.expiresAt` or `null`           |         No          |
| Admin re-license (PATCH) | `admin/handlers/licenses.ts:239-254`                                    |         No          |

The fourth row is the serious one, and it is not in `R3-licensing.md` (which covers only the
enroll path, as R3-06). `patchLicense` is a pure column setter — it sets whatever columns are
present and derives nothing (`admin/repo.ts:151-161`). So `tier_id` and `expires_at` move
independently, and the flagship feature of the most recent commit behaves like this:

- **Trial → paid.** Operator changes `tier_id` to the paid tier. `expires_at` still holds the
  trial's date. The customer's license dies on schedule, days after they paid. Support ticket,
  refund risk, and the operator has no signal that it will happen.
- **Paid → trial/downgrade.** `expires_at` stays `NULL`. The license never expires. Silent
  permanent grant.

`ADOPTER-GUIDE.md:104-106` documents the _device-limit_ consequence of a downgrade
("downgrades grandfather") carefully and correctly. The _expiry_ consequence is undocumented and
wrong in both directions. Fix: compute the license fields implied by a tier in **one** helper and
call it from all four paths — the same fix R3-06 proposes for enroll, extended to the other two.

**3. No organization or team.** No table, no column, nothing. Worse, `idx_licenses_sub` is a
_unique_ partial index on `(product, sub)` (`0001_init.sql:81`), so a license maps to at most one
identity. Two named humans cannot share one license; the only workaround is one anonymous license
with a large `policyDeviceLimit`, which discards per-member identity, per-member revocation, and
any notion of an org admin. For B2C that is fine and I would not build it. For any B2B sale it is
disqualifying, and it is the _first_ thing that would need building — note that
`R1-control-plane.md:145` already flags portal org/team roles as "the obvious next feature."

**4. No seat transfer.** `moveDevices` exists (`repo.ts:763-775`) but has exactly one call site:
the OIDC migrate arm (`oidc.ts:396`). There is no admin operation to move a device between
licenses. The only lever for "my laptop died, move my seat" is deauthorize — which also purges
the device's fingerprint and facts (`PRIVACY.md:73-77`) — followed by a re-activation that
consumes a fresh seat check. Keygen and LicenseSpring both expose machine reassignment as a
first-class operation because it is the single most common licensing support ticket in desktop
software. Cost to add: small, since the primitive already exists and only needs an endpoint.

**5. No trial → paid conversion path.** Beyond the expiry bug above, there is no concept of a
license having _been_ on a trial: no `converted_at`, no origin transition beyond
`enroll → oidc`, nothing to report conversion rate from. `licenses.origin`
(`0011_auto_issue.sql:20`) is the closest thing and it is overwritten on claim, destroying the
one signal that would tell you whether the free tier works.

### 1.4 One genuine redundancy inside the config model

There are four ways to set a value: `tiers.profile_id`, the ordered `license_profiles` stack,
`licenses.overrides_json`, and `devices.overrides_json`. Three would do — `tiers.profile_id` is a
one-element special case of the stack shape that `license_profiles` already implements. Low
priority, but worth collapsing the next time that code is touched.

---

## 2. Is the "always free" tier farmable in a way that matters? — **Grade: D+**

### 2.1 The mechanism is a good product idea

Stated up front, because the grade is about implementation: **keyless auto-issue, deduplicated
one-per-machine, claimable in place on later sign-in, is the correct design for freemium desktop
software, and it is better than anything the compared vendors offer.** None of Keygen,
Cryptolens or LicenseSpring has a first-class anonymous tier with a non-destructive upgrade path.
The claim/migrate table (`CONCEPTS.md:30-33`) — _claim_ preserves the row so local state
survives, _migrate_ moves devices onto the identity's existing license — is thoughtful, and the
race handling via a partial unique index rather than application logic
(`0011_auto_issue.sql:28-30`, `enroll.ts:46-89`) is exactly right.

The grade is D+ because the implementation puts three holes in the single invariant the feature
exists to maintain, and hardcodes away the one policy knob that would make it a trial.

### 2.2 The three defects, confirmed

| #   | Defect                                                                                                                                                                          | Site                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a   | `computeHwid` digests **only the components actually submitted**, so varying the subset mints a fresh "machine". 7 components → 2⁷−1 = 127 distinct identities per real machine | `fingerprint.ts:86-93`, with `parseFingerprint` accepting any non-empty subset at `:66-83` |
| b   | Claim sets `enroll_hwid = NULL`, re-arming the unique index; migrate does the same. enroll → sign in → enroll → sign in … is unbounded from one machine and one identity        | `repo.ts:748`; `oidc.ts:398`                                                               |
| c   | `expires_at: null` is hardcoded, so a tier with `policy_expiry_days` auto-issues as **perpetual**                                                                               | `enroll.ts:71`                                                                             |

The only bound is `rateLimitPerHour`, default 10, keyed on `cf-connecting-ip`
(`fingerprint.ts:243-248`, `enroll.ts:128-142`) — 240/day/IP.

### 2.3 Quantifying the impact — four separate questions, four different answers

The brief is right to insist this be reasoned rather than assumed. "High severity" is the wrong
frame; the honest answer differs by which cost you mean.

**(a) Infrastructure cost: negligible, and not a reason to fix anything.**
Each enrollment writes ~4 D1 rows (`licenses`, `devices`, `device_fingerprints`, `audit`) and
1 KV key (`putTokenRecord`, `licenseCore.ts:434`), storing roughly 1.3 KB. At Cloudflare's
published paid rates — D1 $1.00/million rows written and $0.75/GB-month; KV $5.00/million
writes and $0.50/GB-month:

```
per farmed license   ≈ $0.000004 (D1 writes) + $0.000005 (KV write)  ≈ $0.000009
per MILLION licenses ≈ $9 one-off, + ~$1/month retained storage
```

And a million is not reachable: at 240/day/IP the default rate limit implies ~11 IP-years, i.e.
~11,400 distinct source IPs sustained for a day. **Farming the free tier costs the operator
approximately nothing in cloud spend.** Anyone arguing for these fixes on hosting-cost grounds is
arguing from the wrong number.

**(b) Revenue leakage: zero today, and structurally impossible to reason about — because there
is no tier ladder.**
This is the finding that matters and it is upstream of all three defects. `djdl` has exactly one
tier (`products/djdl/product.json:20-28`). `parseAutoIssue` requires the policy to name a tier
and treats a tier-less policy as disabled (`fingerprint.ts:270-276`), so if auto-issue were
enabled today it could only name `standard` — the _whole product_. **The free tier and the paid
tier would be the same tier.** In that configuration you do not need to farm anything: you enroll
once and you have everything. The defects are irrelevant next to the fact that there is nothing
to farm _past_.

Conversely, the day a `free` tier exists that is strictly weaker than `standard`, defects (a) and
(b) become the primary revenue bypass — each farmed license carries its own full seat pool
(`licenseCore.ts:336-352`), so the seat cap, which `anti-piracy-realism.md` correctly identifies
as the one control that actually holds, becomes decorative.

**(c) Third-party cost pass-through: this is the real exposure, and it is not about licensing at
all.**
A device token from `/enroll` is _sufficient_ to call `POST /<product>/mint/applemusic/token`.
The only authorization on the minting path is `validateDeviceToken`:

```ts
// packages/worker/src/edgeMint.ts:186-189
const token = bearer(req);
if (!token) return errorResponse(401, "unauthorized");
const valid = await validateDeviceToken(env, db, product, token, now);
if ("error" in valid) return errorResponse(401, "unauthorized");
```

That mints an ES256 Apple MusicKit developer token signed with the operator's Apple Developer
team key (`products/djdl/product.json:42-51`: `kid: 7L3Q6F68Y4`, `iss: 48H7CLBV8Y`, TTL 3600 s),
using a private key sealed in `product_secrets`. So enabling anonymous enroll converts the
platform into an **unmetered, unattributable Apple Music developer-token oracle running on the
operator's Apple Developer account.**

The cost of that abuse is not measured in D1 rows. It is measured in Apple's response to a team
key being used to power somebody else's service: key revocation or account action, which breaks
Apple Music simultaneously for every real user of the product. `THREAT-MODEL.md:32` already
ranks this asset (A5) correctly — _"mint third-party tokens at the operator's cost"_ — but does
not connect it to the keyless enrollment path shipped two commits later. Low probability;
product-ending impact; and the mitigation is cheap.

**(d) Trust and data hygiene.** Farmed licenses carry fingerprint rows for machines that were
never real. Retention is device lifetime with no cleanup job by design
(`PRIVACY.md:74-77`), so farmed rows persist until someone deauthorizes a device nobody owns.
Minor, but it quietly falsifies the privacy document's central claim that nothing outlives its
device.

### 2.4 The opinion

**Do not rush the three code fixes; fix the sequencing instead.** Concretely:

1. **Do not enable `autoIssue` until a `free` tier exists that is strictly weaker than
   `standard`.** This is a data change, costs nothing, and is the only thing that makes the
   feature meaningful. As configured today the feature cannot be turned on safely regardless of
   how many bugs are fixed.
2. **Gate minters on more than a device token** — a per-license quota, an origin check that
   refuses `enroll`-origin licenses, or both. This is the only abuse path with an external,
   uncapped, third-party cost.
3. **Then** land the three fixes (fixed component projection with a required anchor; retain a
   `claimed_hwid` rather than nulling; honor tier expiry via the shared helper from §1.3). Roughly
   one day total, and they should ride along — but calling them High severity today overstates
   the exposure and, more damagingly, distracts from the tier-design problem underneath them.

---

## 3. Does enforcement effort match revenue at risk? — **Grade: D**

### 3.1 The measurement

| Package                    |  Source LOC |    Test LOC |
| -------------------------- | ----------: | ----------: |
| `packages/worker`          |      15,663 |      18,112 |
| `packages/admin`           |      13,949 |       3,186 |
| `sdks/python`              |       3,094 |       1,563 |
| `packages/sdk-react`       |       2,755 |       3,000 |
| `packages/sdk-node`        |       2,617 |       3,830 |
| `sdks/swift`               |       2,565 |       1,226 |
| `packages/shared-manifest` |       1,375 |         218 |
| `tools`                    |       1,231 |          71 |
| `conformance`              |       1,225 |         111 |
| `packages/shared-jws`      |         787 |         564 |
| `packages/cli`             |         656 |         193 |
| `packages/shared-catalog`  |         554 |         358 |
| `products`                 |         583 |           — |
| `packages/shared-protocol` |         311 |           — |
| **Total**                  | **~47,400** | **~32,400** |

Plus 43 distinct route kinds (`router.ts:5-49`), 11 migrations, 5 client languages, and a
three-file signed conformance corpus (`conformance/corpus/v1/`). Built in ~9 weeks, 37 commits.

Against a denominator of **$0** (§0).

**Grade: D.** This is a ratio grade, and the numerator is large while the denominator is zero.
It is emphatically _not_ a code-quality grade — on quality alone this tree earns a **B**. The
server-side authorization is re-read from D1 on every request, tenancy is enforced in the primary
key rather than in a query builder, the payload is validated against the catalog before signing,
and the test-to-source ratio in the worker is above 1:1. Very little of this is bad work. Almost
all of it is early work.

### 3.2 Genuinely load-bearing — would build again, keep investing

- **The frozen JWS wire contract + `shared-jws` + the corpus** (787 + 1,225 LOC). This is the
  asset. It is what lets five implementations agree byte-for-byte, it is the single most
  expensive thing to retrofit later, and — crucially — **it is not licensing infrastructure**.
  It is signed-config infrastructure and it earns its keep even if every licensing feature were
  deleted tomorrow.
- **Server-side authorization discipline**: full re-read of device and license state per request
  (`licenseCore.ts:442-476`), `product` as column 1 of every primary key, pre-signing catalog
  validation (`configDoc.ts:33-55`), KEK-sealed signing keys that fail closed
  (`0003_keyvault.sql`).
- **Release distribution** (`packages/worker/src/release/*`, 12 modules). The one component with
  no off-the-shelf substitute — Sparkle appcast generation, channel gating, GitHub App
  integration, changelog extraction. It is also the piece with a concrete daily payoff for the
  one real product.
- **Managed config + the catalog.** 28 catalog entries drive the actual product
  (`products/djdl/catalog.json`: 17 config, 6 secret, 5 flag). This is what djdl uses the
  platform _for_.

### 3.3 Premature but cheap — defer, do not delete

- **Multi-tenancy.** Costs one column per table and is already paid for. Keep.
- **The admin SPA** (13,949 LOC). Large, but an operations UI is the difference between a system
  you can run and one you cannot. The cost is maintenance drag, not waste.
- **Generic provisioning hooks and generic edge-mint.** Two hooks and one minter, generalized
  into config tables. Mild over-generalization at low cost.

### 3.4 Over-engineered for this stage — stop investing

**The fingerprint subsystem.** Seven hardware components, a per-tier policy column
(`0010_fingerprint.sql:65`), a four-mode tolerance ladder with an anchor bonus
(`fingerprint.ts:123-146`), a drift-vs-mismatch distinction, implementations in three native
SDKs, a dedicated conformance sub-corpus, and a written privacy policy — governing a check that
runs **at most once per device lifetime** and whose one genuinely unique capability (detecting N
device-ids on one machine) is implemented and **never called** (`findFingerprintByHwid`, zero
call sites, per `R3-11`). `anti-piracy-realism.md` recommends collapsing the ladder to `off`/`on`;
I agree and go one step further: **for a product with $0 at risk, ship it `off` by default.**
Collecting seven hardware signals from every native user, by default, to protect nothing, is the
clearest instance in this tree of effort with no matching revenue — and it is the one that costs
user trust rather than just engineering time. §6.2 adds the decisive comparison: **Keygen, with
real revenue riding on seat integrity, defines a machine fingerprint as "an arbitrary string"
the client picks.** It did not build hardware collection, drift tolerance, or an enforcement
ladder, and it is fine.

**The Swift and Python SDKs.** 5,659 LOC of source and 2,789 of tests, maintained against the
corpus. Consumers today: **zero**. `ADOPTER-GUIDE.md:47-49` states plainly that the macOS app
"keeps delegating licensing to the embedded engine (it is not retrofitted to the Swift SDK now)."
No Python consumer exists at all. So two of the five languages exist to satisfy a conformance
corpus whose purpose is keeping five languages in sync — a self-justifying loop. Each new server
feature currently costs five client implementations plus corpus regeneration. **Freeze them:**
keep them building and green (that is what the corpus is for), stop adding features.

**The customer portal.** `0008_portal.sql` adds five tables; `packages/worker/src/portal/` adds
seven modules; the admin SPA carries portal views. Self-service license management, magic-link
email auth, and download tokens — for licenses nobody pays for, serving a user base of family and
friends who can be supported by text message. Freeze.

**Anti-piracy work generally.** `anti-piracy-realism.md` §0 establishes that only three of seven
assets are un-manufacturable by a bypassed client — `payload.secrets`, edge-minted tokens, and
release artifacts — and all three are already defended server-side. Everything beyond that is
client-side theater with a maintenance cost.

---

## 4. Is the offline-grace default right? — **Grade: C−**

The parameters: doc TTL 3600 s (`shared-protocol/src/index.ts:268`, `configDoc.ts:66`); grace
30 days by default (`0001_init.sql:19`), overridable per license (`:75`); auto-refresh **off**
unless `refreshIntervalSeconds` is supplied (`sdk-node/src/client.ts:191`;
`sdks/python/src/polaris_key/client.py:195` — _"OFF unless refresh_interval_seconds is set"_).

`anti-piracy-realism.md` grades this **D** on security grounds (the cache is unsigned, so grace
is effectively unbounded for anyone who can edit a JSON file). That analysis is correct and I do
not repeat it. **On business grounds I reach a partly different conclusion, and the difference
matters for what you should do about it.**

### 4.1 The 30-day number is right, and should arguably be longer

Weigh the two errors honestly:

| Error                                                         | Who pays                    | Magnitude                                                                                                                                       |
| ------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Grace too long → revoked user keeps working                   | Operator                    | ~1/12 of an annual seat, _and only for the subset of revocations that are involuntary_ (expired card), where the customer usually renews anyway |
| Grace too short → paying user locked out by a network problem | **Customer, then operator** | A support ticket, plus a trust event on a desktop app the user already paid for, plus a refund risk, plus the review                            |

The asymmetry is severe and it points one way. The desktop market has converged accordingly —
generous offline fallbacks are the norm precisely because false lockouts are the single most
expensive support category in licensed desktop software. For a one-person vendor with no support
staff, **the right instinct is to be more generous than 30 days, not less.** Keep 30; 45–60 would
also be defensible. Do not shorten it to protect revenue that does not exist.

### 4.2 The one place a shorter grace is right: auto-issued licenses

Auto-issued free licenses inherit the product default (`enroll.ts:72`: `max_offline_days: null`
→ falls back to `products.default_max_offline_days`). They should not, for a reason that has
nothing to do with piracy: **a free license has no support relationship to protect and no other
revocation lever.** If a farmed or abusive free license needs to be cut off, `status = 'disabled'`
takes up to 30 days to bite. 7 days is ample for a license that cost nothing to obtain and can be
re-obtained in one request.

### 4.3 The actual defect is auto-refresh being off, and it hurts the operator

This is where I differ in emphasis from the security review, which frames refresh as a leakage
control. The business problem is larger and more immediate: **with auto-refresh off, two shipped
features are advertised and inert.**

- **Remote re-licensing — the entire content of the most recent commit (`bd26e0b`) — does not
  work by default.** You change a customer's tier in the admin panel and _nothing happens_ until
  their app restarts, which on a long-running desktop app can be weeks. `ADOPTER-GUIDE.md:80-82`
  is honest about this ("Nothing polls by default, so opt in where you want an upgrade to land
  without a restart"), but shipping a _remote_ re-licensing feature whose default is _not remote_
  is a product defect. The first time this is felt will be a customer who paid for an upgrade and
  did not receive it.
- **Revocation is inert for the same reason,** compounding §4.2.

Turn it on: 6–12 hours with jitter, opt-out for existing integrations. Roughly half a day.

### 4.4 And fix the 304 bug before touching any number

`anti-piracy-realism.md` §3.2 documents that the `not-modified` path leaves the cached doc's
`expiresAt` stale, so a client that is fully online and successfully re-validating every hour
reports `status: "grace"` once its config has been stable for an hour, with `lastVerifiedAt`
frozen indefinitely. Framed commercially: **the product tells correctly-functioning paying
customers that they are running in offline grace mode, and tells them the wrong "last verified"
date, forever.** That is a support-ticket generator of exactly the kind §4.1 says is the most
expensive category, it costs a few hours to fix, and it is the highest return-on-effort item in
this entire review.

### 4.5 Summary of the position

| Knob               | Today                       | Recommended             | Why (business)                                         |
| ------------------ | --------------------------- | ----------------------- | ------------------------------------------------------ |
| Grace, paid        | 30 d                        | **Keep 30 d**           | Leakage is trivial; false lockouts are not             |
| Grace, auto-issued | 30 d (inherited)            | **7 d**                 | No support relationship, no other revocation lever     |
| Auto-refresh       | off                         | **on**, 6–12 h jittered | Two shipped features are otherwise inert               |
| 304 freshness      | reports `grace` when online | **fix first**           | Directly generates the most expensive support category |
| Doc TTL            | 3600 s                      | Keep                    | Correct                                                |

---

## 5. What is it actually selling, and does the design serve it? — **Grade: C**

### 5.1 The position

**Polaris Key is not a licensing product. It is a signed managed-configuration and
release-delivery product with a licensing system attached, because licensing is how it decides
who gets which config.** The tree has been built and named as if the reverse were true, and that
inversion is steering feature selection.

The evidence is not subtle:

- The one real product's catalog is **28 entries: 17 `config`, 6 `secret`, 5 `flag`**
  (`products/README.md`, `products/djdl/catalog.json`). The reason djdl talks to this server is
  settings and secrets, not permission to run.
- The auto-issue feature exists because the design _noticed_ this. `0011_auto_issue.sql:11-13`
  says so in the migration comment: _"A product can opt into issuing a license with no key and no
  sign-in, so software that mainly wants signed settings distribution doesn't have to gate every
  install behind a credential."_ That is the architecture conceding that the licensing gate is in
  the way of the actual product.
- `anti-piracy-realism.md` §0 establishes that the only genuinely un-manufacturable assets are
  `payload.secrets`, edge-minted tokens, and release artifacts. All three are **delivery**, not
  **licensing**.
- The one product is given away to `family` and `friends` (`products/djdl/product.json:14-18`).
  There is nothing to license.

### 5.2 Is the three-way coupling a strength or a liability? Both — and I would keep it

**Keep it.** The coupling is genuinely right _for this system_, for reasons that are not merely
convenience:

- All three capabilities need the same primitive: a server-authenticated, product-scoped,
  per-device identity. Building it three times is strictly worse than building it once.
- Config and release gating are the _same policy decision at two granularities_. "Which build may
  this device run" is expressed as the `channels` / `app.minVersion` / `app.maxVersion`
  entitlements and enforced by `checkBuildGate` (`licensing.ts:527-539`) — i.e. the release
  policy is _already_ a config entitlement. Splitting the systems means two policy engines that
  must agree, which is precisely the failure mode of shops running a feature-flag vendor plus
  Sparkle plus a licensing vendor separately.
- The single-integration claim is real and is a differentiator: one SDK call yields activation,
  config, entitlements, and update channel. No vendor in §6 offers that.

**But name the liability precisely, because it is not the obvious one.** The security liability
(one control-plane compromise reaches all three, and shipping arbitrary code to every installed
client is categorically worse than issuing a free license) is real and is argued in
`THREAT-MODEL.md:9-22` and `multi-tenant-blast-radius.md`. I have nothing to add to it.

The _commercial_ liability is narrower than it first appears, and §6 pins down exactly how
narrow. Licensing + release distribution is **not** an odd pairing — it is Keygen's own product
("a software licensing _and distribution_ API"), down to Ed25519 signing chosen for Sparkle
compatibility and an access-strategy enum that matches Polaris's line for line (§6.3). So two of
the three legs are a proven bundle.

The odd leg is the third one, and it cuts both ways: full managed configuration is what makes
this platform genuinely differentiated (§6.2) _and_ what leaves it without a category. Buyers
shop for licensing (Keygen, LicenseSpring), _or_ for remote config and flags (LaunchDarkly,
ConfigCat, Flagsmith), _or_ for update distribution. Nobody searches for all three at once. If
this is ever meant to be sold, the mitigation is positioning, not decoupling: **lead with signed
managed configuration — the thing nobody else sells — and present licensing and releases as what
it authorizes and what it delivers.**

### 5.3 The concrete consequence of getting this backwards

The name is `Polaris **Key**`. The vocabulary is `license`, `key`, `activation`, `seat`,
`entitlement`. And the last three feature commits are, in order: hardware fingerprinting, free
auto-issued licenses, remote re-licensing. Three consecutive licensing features shipped to a
product with no revenue, while the config half — which is what the one real product actually uses
— received none.

Vocabulary steers roadmaps. `CONCEPTS.md` is an unusually good glossary and it is pointed at the
wrong half of the system.

---

## 6. Competitive standing — **Grade: C+**

Researched 2026-08-25/26 against current vendor material, not memory. Figures marked † come from
third-party aggregators or a competitor's comparison page and should be treated as indicative.

### 6.1 What the market charges, and what it meters

| Vendor                                                                                     | Free tier                                                       | Entry paid                                                                  | Next                                              | Metered on                                                                                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Keygen Cloud**                                                                           | **100 active licensed users + 10 product releases**             | Std from **$49/mo**†                                                        | Ent, custom                                       | **ALU** — a licensed user with any API activity in the last 90 days (validation, activation, entitlement consumption, offline check-in) |
| **Devolens** (formerly **Cryptolens** — rebranded; `cryptolens.io` 301s to `devolens.com`) | €0 — 10 active keys, 15 end users, **"not for production use"** | Business **€199/mo** — 5,000 active licenses, 1M API calls                  | Scale **€699/mo** — 10,000 licenses, 2M API calls | Active licenses + API calls                                                                                                             |
| **LicenseSpring**                                                                          | Yes, limits unpublished                                         | Business Starter **$199/mo**†                                               | Business Plus **$750/mo**†                        | Licenses / activations, largely negotiated                                                                                              |
| **Lemon Squeezy**                                                                          | —                                                               | **5% + $0.50** per transaction (≈7% + $0.50 on international subscriptions) | —                                                 | Revenue. Merchant of record. **Native license key generation, activation limits, and validation API.** Acquired by Stripe, 2024         |
| **Paddle**                                                                                 | —                                                               | **5% + $0.50**, all-in, no international surcharge                          | Scale, negotiated                                 | Revenue. Merchant of record. **No licensing layer — you build it**                                                                      |

Two things follow immediately.

**The whole market meters on _active_ licensed users or licenses.** Polaris Key has no metering
concept at all. That is correct for self-hosted infrastructure and disqualifying for a product,
and it is another instance of §0: no unit of value has been defined because no value exchange has
been decided.

**And the buy-side number is brutal.** djdl's user base — `family`, `friends`, `admins` — fits
inside **Keygen's free tier** (100 ALUs, 10 releases), with the Distribution API included. The
build-vs-buy comparison for the licensing and release halves of this platform, at today's scale,
is ~47,000 lines of source against **$0/month**. That does not make the build wrong (§6.3 lists
three things no vendor sells), but it should be stated plainly rather than discovered later.

### 6.2 Where Polaris Key sits, dimension by dimension

| Dimension                      | Polaris Key                                                                                                                                                                        | Market                                                                                                                                                                                                                                 |              Standing               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------: |
| **Key ≠ license**              | `keys_index` holds many revocable keys per license (`0001_init.sql:85-96`)                                                                                                         | Keygen and Devolens: the key string **is** the license identity                                                                                                                                                                        |              **Ahead**              |
| **Policy object**              | `tier` (expiry, device limit, channels, version window, fingerprint mode)                                                                                                          | Keygen `policy`, LicenseSpring `license policy`                                                                                                                                                                                        |               Parity                |
| **Managed config delivery**    | Typed catalog, `default`/`enforced`/`hidden` management states, per-layer merge, secrets to the OS keyring                                                                         | Keygen: `metadata` key-value only, and **immutable once embedded in a signed key**. LicenseSpring: dynamic feature entitlements, changeable post-issuance — the closest competitor. Nobody has management states or a validated schema | **Ahead — the real differentiator** |
| **Release distribution**       | Channels, Sparkle appcasts, `public`/`authenticated`/`licensed` access (`0007_backend_contracts.sql:60-61`)                                                                        | **Keygen's Distribution API is the same idea**: releases, artifacts, Ed25519ph signing with an Ed25519 mode explicitly for Sparkle, and `LICENSED`/`OPEN`/`CLOSED` strategies                                                          |               Parity                |
| **Organization / team / user** | **None**                                                                                                                                                                           | Keygen `user` + `group`; LicenseSpring `user` + `customer`; Devolens end users                                                                                                                                                         |             **Behind**              |
| **Seat reclamation**           | **None.** `countActiveDevices` is `COUNT(*) WHERE status='authorized'` with no `last_seen` predicate (`repo.ts:913-924`); `devices.last_seen` is written and never read for policy | Keygen **machine heartbeats**: default 10-minute monitor window, `NOT_STARTED`/`ALIVE`/`DEAD`/`RESURRECTED`; dead machines self-reap                                                                                                   |             **Behind**              |
| **Seat transfer**              | `moveDevices` exists, one call site, no admin route (`repo.ts:763`; `oidc.ts:396`)                                                                                                 | First-class machine reassignment                                                                                                                                                                                                       |             **Behind**              |
| **Billing linkage**            | **None**                                                                                                                                                                           | Keygen/LicenseSpring/Devolens integrate; Paddle/Lemon Squeezy _are_ the biller                                                                                                                                                         |             **Behind**              |
| **Offline**                    | Signed doc + 30 d grace; **the JWS is discarded after verify** (`anti-piracy-realism.md` §3.1)                                                                                     | Keygen: cryptographic license/machine **files** checked out and re-verified offline, min 1 h TTL for machine files                                                                                                                     |             **Behind**              |
| **Hardware fingerprint**       | 7 on-device-hashed components, drift tolerance, anchor bonus, 4-mode ladder, 3 native SDKs, conformance sub-corpus                                                                 | **Keygen: the fingerprint is "an arbitrary string" the client picks, unique within the license.** Hardware components are optional metadata, not an enforced identity                                                                  | **Ahead in mechanism — see below**  |
| **Platform's own licence**     | **No `LICENSE` file**                                                                                                                                                              | Keygen: Fair Core License, converting to Apache 2.0 after 2 years; CE free to self-host; Portal Apache 2.0; CLI MIT                                                                                                                    |             **Behind**              |

### 6.3 The three conclusions worth drawing

**1. The licensing + release-distribution coupling is not unusual — it is the market leader's
model.** Keygen brands itself "a software licensing **and distribution** API," and its access
strategies (`LICENSED`/`OPEN`/`CLOSED`) map one-to-one onto Polaris's `licensed`/`authenticated`/
`public`, down to Ed25519 signing chosen for Sparkle compatibility. Two independent designs
converged on the same shape, which is decent evidence the shape is right. **§5's coupling concern
therefore does not apply to that pair.** What is genuinely unusual is the _third_ leg — full
managed configuration with typed schemas and enforcement states. That is not something any
licensing vendor sells, and it is where Polaris Key is actually ahead. This sharpens §5: the
differentiated bundle is **config + releases**, authorized by licensing — not licensing with two
extras bolted on.

**2. Being ahead on fingerprinting is evidence against the fingerprinting, not for it.** The
market leader, with thousands of paying customers and a direct commercial interest in seat
integrity, deliberately shipped the _simplest possible_ machine identity: a client-chosen opaque
string. It did not build hardware component collection, drift tolerance, or an enforcement ladder
— and it is fine. Polaris Key built all three, by default, for zero revenue (§3.4). When you are
ahead of the market leader on a mechanism the market leader chose not to build, the first
hypothesis should be that they were right.

**3. Keygen's heartbeat is the single cheapest idea to steal.** A 10-minute liveness window with
`DEAD` machines auto-reaping their slot solves — _for free_ — most of what Polaris currently
lacks a seat-transfer endpoint for. Today a seat is held forever by a sold laptop, a reimaged
disk, or a dead SSD, because `countActiveDevices` has no recency predicate. Adding
`AND last_seen > ?` to that one query, with a per-tier window, would be a few lines and would
convert the most common desktop licensing support ticket into a non-event. It also pairs exactly
with turning auto-refresh on (§4.3) — heartbeats are what auto-refresh _is_, once it exists.

**Grade C+**: ahead on config and on key/license separation, at parity on releases and policy,
behind on identity, seats, billing, offline durability, and — bluntly — on having a licence file
at all.

---

## 7. Ranked build / stop

Ordered by (business value) ÷ (effort). The framing throughout is: **this is a one-product,
$0-revenue platform, and the goal of the next quarter is either to reach the first dollar or to
state honestly that there will not be one.**

### Build

| #      | Do this                                                                                                                                                                            | Effort           | Why it ranks here                                                                                                                                                                                                                                                                                                                                                                                                     | What it does **not** do                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | **Write down whether this is a product or personal infrastructure.** One page: who pays, for what, at what price, or an explicit "nobody, this is infrastructure for my own apps." | **1 d** (prose)  | Every other row branches on it. The tree currently contains a multi-tenant SaaS, a personal deployment, and no `LICENSE` file; that ambiguity is what produced the §3 inversion                                                                                                                                                                                                                                       | Ship any feature. It prevents _wrong sequencing_, which is why it is #1                                                                   |
| **2**  | **Fix the 304 freshness bug; turn auto-refresh on by default** (6–12 h, jittered, opt-out).                                                                                        | **1 d**          | Stops telling online paying users they are in offline grace (§4.4) **and** makes remote re-licensing and revocation actually function (§4.3). Two shipped features go from inert to working                                                                                                                                                                                                                           | Any abuse. This is a correctness and product-honesty fix                                                                                  |
| **3**  | **Create a second tier.** A `free` tier strictly weaker than `standard`, in `products/djdl/product.json`.                                                                          | **0.5 d** (data) | Today every entitlement question is vacuous: one tier means auto-issue can only grant the whole product (§2.3b), and none of the seat/expiry/channel machinery is exercised by anything real                                                                                                                                                                                                                          | Fix the enroll defects — but it is what makes them _matter_, and what makes fixing them testable                                          |
| **4**  | **One helper for "license fields implied by a tier," called from all four paths.**                                                                                                 | **0.5 d**        | Fixes the live trial→paid and paid→trial expiry bugs (§1.3), which silently cost money or silently give it away, and subsumes R3-06                                                                                                                                                                                                                                                                                   | Anything adversarial. This is a revenue-correctness fix                                                                                   |
| **5**  | **Gate minters on more than a device token** — refuse `enroll`-origin licenses, add a per-license quota.                                                                           | **1 d**          | The only abuse path with an external, uncapped, third-party cost, on the operator's Apple Developer account (§2.3c)                                                                                                                                                                                                                                                                                                   | Abuse by legitimately licensed users. Quotas bound that separately                                                                        |
| **6**  | **Delete `customers` and its two foreign keys.**                                                                                                                                   | **0.5 d**        | Removes a dead table that duplicates `licenses`, contradicts `portal_accounts`, and is listed as a PII asset in the threat model while holding zero rows (§1.2)                                                                                                                                                                                                                                                       | Solve the identity model. It stops _pretending_ to have solved it                                                                         |
| **7**  | **Persist the JWS, re-verify on load, add a monotonic floor.** (= `anti-piracy-realism.md` #3.)                                                                                    | **1–2 d**        | Ranked lower here than in that review _on business grounds_ — it converts a text-file crack into a binary patch, which matters once there is revenue. But it is cheap and it is a one-way door: do it before the first paying customer, not after                                                                                                                                                                     | Anything against a patched binary. By design                                                                                              |
| **8**  | **Reclaim stale seats: add a recency predicate to `countActiveDevices`,** with a per-tier window. Then expose seat transfer by routing the existing `moveDevices`.                 | **0.5 d**        | Steals Keygen's heartbeat idea for a few lines (§6.3). Today a seat is held **forever** by a sold laptop or a reimaged disk — `countActiveDevices` is `COUNT(*)` with no `last_seen` predicate (`repo.ts:913-924`) while `devices.last_seen` is written and never read for policy. This converts the most common desktop licensing ticket into a non-event, and it composes with #2 (auto-refresh _is_ the heartbeat) | Deliberate sharing across live machines. That is what the cap is for                                                                      |
| **9**  | **Add a `LICENSE` file.**                                                                                                                                                          | **1 h**          | With no licence the tree is "all rights reserved," so the one plausible non-revenue model — open source / self-host, the route Keygen took with FCL + CE — is closed by omission (§6.2). One hour, and it is the only item here that is pure downside if skipped                                                                                                                                                      | Decide the business model. It stops _foreclosing_ one                                                                                     |
| **10** | **The three enroll fixes** (fixed component projection + required anchor; `claimed_hwid` instead of nulling; honor tier expiry).                                                   | **1 d**          | Correct fixes, correctly deferred until #3 exists — before that they protect a tier that grants everything anyway (§2.4)                                                                                                                                                                                                                                                                                              | Farming across genuinely different machines. That is what seat caps are for                                                               |
| **11** | **Billing linkage — a webhook receiver and `licenses.external_subscription_id` only.** Do not build a biller.                                                                      | **3 d**          | Only if #1 says "product." The absence of any concept of "paid" is the largest structural gap (§1.3), but building it before #1 is answered would be the same mistake again                                                                                                                                                                                                                                           | Replace a merchant of record. Use one — Paddle or Lemon Squeezy at 5% + $0.50 (§6.1) is cheaper than any in-house billing you would write |

### Stop

| #     | Stop                                                                                                             | Why                                                                                                                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **Fingerprint collection by default; the four-mode ladder.** Collapse to `off`/`on` and **ship `off`.**          | Seven hardware signals from every native user, a per-tier policy column, a tolerance table and an anchor bonus — governing a once-per-device check whose one unique capability has zero call sites (§3.4). It costs user trust, not just engineering time, and it protects $0 |
| **2** | **Feature-freeze the Swift and Python SDKs.** Keep them building and corpus-green; add nothing.                  | 5,659 source LOC with **zero consumers** — `ADOPTER-GUIDE.md:47-49` confirms djdl does not use the Swift SDK. Every new server feature currently costs five client implementations plus corpus regeneration                                                                   |
| **3** | **Freeze the customer portal.**                                                                                  | Five tables, seven worker modules, and SPA surface for self-service on licenses nobody pays for, for a user base that can be supported by text message                                                                                                                        |
| **4** | **Stop anti-piracy investment beyond rank 7 above.**                                                             | Only three of seven assets are un-manufacturable by a bypassed client, and all three are already defended server-side (`anti-piracy-realism.md` §0). Everything further is client-side theater                                                                                |
| **5** | **Stop generalizing for tenant #2.** No per-tenant KEKs, no per-product admin scoping, no tenant isolation work. | `multi-tenant-blast-radius.md` is right that the _documentation_ over-promises isolation. The correct fix is to correct the documentation, not to build the isolation, until a second tenant exists                                                                           |
| **6** | **Add no new route kinds.**                                                                                      | 43 is already a large surface (`router.ts:5-49`) for one consumer. Every route is a permanent compatibility obligation across five client languages                                                                                                                           |

---

## Appendix — evidence index

| Claim                                                                                                                                         | Evidence                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| One product; one tier; granted to `family`/`friends`                                                                                          | `products/djdl/product.json:14-18`, `:20-28`                                                                     |
| No billing/payment/subscription code anywhere                                                                                                 | repo-wide grep; only djdl's VPN _subscription URL_ config key matches                                            |
| No `LICENSE` file; all packages `0.0.0`                                                                                                       | repo root; `packages/*/package.json`                                                                             |
| `customers` has zero reads and zero writes in any source file                                                                                 | `grep -rn 'INTO customers\|UPDATE customers\|FROM customers' packages/*/src` → no matches                        |
| `customers` duplicates the license identity columns                                                                                           | `0007_backend_contracts.sql:6-31` vs `0001_init.sql:64-82`                                                       |
| Foreign keys into the dead table                                                                                                              | `0007_backend_contracts.sql:134`                                                                                 |
| Third, conflicting identity model                                                                                                             | `0008_portal.sql:5-35`                                                                                           |
| `customers` listed as a PII asset                                                                                                             | `THREAT-MODEL.md:32`                                                                                             |
| A license maps to at most one identity                                                                                                        | `0001_init.sql:81` (unique partial index on `product, sub`)                                                      |
| Tier expiry honored on OIDC only                                                                                                              | `oidc.ts:326-331` vs `enroll.ts:71`, `admin/handlers/licenses.ts:117`, `:239-254`                                |
| `patchLicense` derives nothing                                                                                                                | `admin/repo.ts:131-161`                                                                                          |
| Downgrade device-limit behaviour documented; expiry behaviour not                                                                             | `ADOPTER-GUIDE.md:104-106`                                                                                       |
| `moveDevices` has one call site                                                                                                               | `repo.ts:763-775`; `oidc.ts:396`                                                                                 |
| Key/license separation with per-key revocation                                                                                                | `0001_init.sql:85-96`                                                                                            |
| Ordered profile stack                                                                                                                         | `0004_license_profiles.sql`                                                                                      |
| Four-layer merge                                                                                                                              | `licenseCore.ts:196-227`                                                                                         |
| `computeHwid` covers only submitted components                                                                                                | `fingerprint.ts:86-93`; subset accepted at `:66-83`                                                              |
| Claim/migrate null the dedupe key                                                                                                             | `repo.ts:748`; `oidc.ts:398`                                                                                     |
| `/enroll` hardcodes no expiry                                                                                                                 | `enroll.ts:71`                                                                                                   |
| Enroll rate limit default 10/h/IP                                                                                                             | `fingerprint.ts:243-248`; `enroll.ts:128-142`                                                                    |
| Auto-issue is disabled without a named tier                                                                                                   | `fingerprint.ts:270-276`                                                                                         |
| Minting is authorized by a device token alone                                                                                                 | `edgeMint.ts:186-189`                                                                                            |
| Apple team key and issuer used by the minter                                                                                                  | `products/djdl/product.json:42-51`                                                                               |
| Minting third-party tokens at operator cost is a ranked asset                                                                                 | `THREAT-MODEL.md:32` (A5)                                                                                        |
| Per-enrollment writes: 4 D1 rows + 1 KV key                                                                                                   | `enroll.ts:58-104`; `licenseCore.ts:379-438`                                                                     |
| Cloudflare D1/KV rates used for the cost model                                                                                                | developers.cloudflare.com/d1/platform/pricing, /kv/platform/pricing (fetched 2026-08-25)                         |
| Seat pool is per license, checked only on new authorization                                                                                   | `licenseCore.ts:336-352`                                                                                         |
| Doc TTL 3600 s                                                                                                                                | `shared-protocol/src/index.ts:268`; `configDoc.ts:66-67`                                                         |
| Grace default 30 d; per-license override                                                                                                      | `0001_init.sql:19`, `:75`; `licensing.ts:541-542`                                                                |
| Auto-refresh off by default                                                                                                                   | `sdk-node/src/client.ts:191`; `sdks/python/src/polaris_key/client.py:195`                                        |
| Nothing polls by default (documented)                                                                                                         | `ADOPTER-GUIDE.md:80-82`                                                                                         |
| Enrolled licenses inherit the product grace default                                                                                           | `enroll.ts:72`; `licensing.ts:541-542`                                                                           |
| Release policy is expressed as config entitlements                                                                                            | `licenseCore.ts:117-140`; `licensing.ts:527-539`                                                                 |
| Auto-issue exists because the licensing gate obstructs config delivery                                                                        | `0011_auto_issue.sql:11-13`                                                                                      |
| djdl's catalog is 28 entries, config-dominant                                                                                                 | `products/README.md`; `products/djdl/catalog.json`                                                               |
| The Swift SDK has no consumer                                                                                                                 | `ADOPTER-GUIDE.md:47-49`                                                                                         |
| `findFingerprintByHwid` has zero call sites                                                                                                   | `R3-licensing.md` R3-11                                                                                          |
| 43 route kinds                                                                                                                                | `router.ts:5-49`                                                                                                 |
| Fingerprint policy surface                                                                                                                    | `0010_fingerprint.sql:65`; `fingerprint.ts:123-156`                                                              |
| Retention is device lifetime, no cleanup job                                                                                                  | `PRIVACY.md:66-77`                                                                                               |
| Build window: 37 commits, 2026-06-23 → 2026-08-25                                                                                             | `git log`                                                                                                        |
| Seats are never reclaimed: no `last_seen` predicate on the count                                                                              | `repo.ts:913-924`                                                                                                |
| Release access enum matches Keygen's distribution strategies                                                                                  | `0007_backend_contracts.sql:60-61` vs keygen.sh/docs/api/releases, /software-distribution-api                    |
| Keygen pricing, ALU definition, Dev free tier (100 ALUs, 10 releases)                                                                         | keygen.sh/pricing (fetched 2026-08-25); Std $49/mo† via aggregators                                              |
| Keygen machine heartbeat: default 10-minute window; `NOT_STARTED`/`ALIVE`/`DEAD`/`RESURRECTED`; min 1 h TTL for checked-out machine files     | keygen.sh/docs/api/machines, /docs/api/licenses                                                                  |
| Keygen fingerprints are client-chosen arbitrary strings; hardware components are optional metadata                                            | keygen.sh/docs/api/machines                                                                                      |
| Keygen is Fair Core License, converting to Apache 2.0 after 2 years; CE free to self-host                                                     | keygen.sh/blog/keygen-is-now-fair-source, /docs/self-hosting                                                     |
| Keygen embedded entitlements are immutable once signed into a key                                                                             | keygen.sh/docs/choosing-a-licensing-model/feature-licenses                                                       |
| Cryptolens has rebranded to Devolens; `cryptolens.io/pricing` 301s to `devolens.com/pricing`                                                  | fetched 2026-08-25                                                                                               |
| Devolens tiers: €0 (10 keys, 15 end users, not for production) / €199 / €699 / custom                                                         | devolens.com/pricing                                                                                             |
| LicenseSpring: free tier, Business Starter $199/mo, Business Plus $750/mo†                                                                    | competitor comparison page — **unverified**, flagged as indicative                                               |
| LicenseSpring feature entitlements are dynamic and changeable post-issuance                                                                   | licensespring.com/blog/news/announcement-feature-based-licensing, /blog/tutorials/working-with-features-licenses |
| Lemon Squeezy and Paddle both 5% + $0.50 MoR; Lemon Squeezy has native license keys, Paddle does not; Lemon Squeezy acquired by Stripe (2024) | vendor and comparison sources, fetched 2026-08-26                                                                |
