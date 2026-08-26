# R4 — On-device / client-side abuse (Node, Python, Swift, React SDKs)

**Auditor:** Red team agent R4
**Scope:** `packages/sdk-node`, `packages/sdk-react`, `sdks/python`, `sdks/swift`, `packages/cli`
**PoC suite:** `packages/sdk-node/test/R4-client-attack.test.ts` — 11 tests, all passing (i.e. all attacks succeed today). They assert the _vulnerable_ behaviour and will fail once the fixes land; that is intentional.

---

## Where the trust boundary actually is

Some client-side bypass is unavoidable and is not a finding (see [INHERENT](#inherent--not-findings)). The severity line I used throughout:

> **A defect is real if it lets an attacker gain something WITHOUT patching the shipped binary, or if it defeats a control the vendor believes they still have (revocation, key rotation, tamper detection).**

The design intent is clear from the code: the JWS signature is the client's root of trust, and `verifyDoc` (`packages/sdk-node/src/verify.ts:15-34`) is the gate that enforces it. The problem is that **the signature is verified exactly once, on the network path, and then thrown away.** Everything downstream — the cache, the trust set, the anti-replay counters — is plain user-writable JSON with no authentication. The result is that the _shipped binary is not the trust boundary; `~/.config/<product>/managed.json` is._ That file is writable by any process running as the user, including a compromised transitive dependency, a restored backup, a cloud-sync daemon, or a 40-line "crack" distributed as a gist.

Assumed attacker capability throughout: **write access to the SDK's own config directory, no binary patching.**

---

## Findings

| ID    | Title                                                                                                                         | Severity | PoC       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| R4-01 | Offline cache is not integrity-protected — arbitrary entitlements, secrets and grace from hand-written JSON                   | **High** | ✅ proven |
| R4-02 | Cache-planted `trustedKeys` grant the attacker permanent document-signing authority                                           | **High** | ✅ proven |
| R4-03 | Anti-replay counters are attacker-writable — pins forged state and permanently disables revocation + key rotation             | **High** | ✅ proven |
| R4-04 | Gate reads the raw wall clock; no monotonic floor, no server-time anchor, `lastVerifiedAt` never enforced                     | Medium   | ✅ proven |
| R4-05 | Tamper _detection_ is defeated — `/config/report` echoes the attacker's own forged map                                        | Medium   | ✅ proven |
| R4-06 | Desktop bridge is an ambient, unauthenticated global capability                                                               | Medium   | ✅ proven |
| R4-07 | Every Python CLI front end defaults `--version` to `0.0.0-dev`, which the server's build gate treats as an unconditional pass | Medium   | ✅ static |
| R4-08 | Node/Swift transport: no scheme validation, no timeout, no in-flight guard                                                    | Medium   | ✅ proven |
| R4-09 | Swift `writeSecure` creates the cache at 0644 then chmods, with both calls error-swallowed                                    | Low      | ✅ proven |
| R4-10 | No SDK repairs a pre-existing over-permissive directory or file; Python's `O_NOFOLLOW` silently degrades to 0 on Windows      | Low      | ✅ proven |
| R4-11 | Node/Python silently downgrade keyring → plaintext file with no caller signal                                                 | Low      | ✅ static |
| R4-12 | Swift discards `SecItemAdd`/`SecItemDelete` status and has no token fallback → silent credential loss                         | Low      | ✅ static |
| R4-13 | Python raises `TypeError` out of `refresh()`/`status()` where Node coerces and Swift rejects                                  | Low      | ✅ proven |
| R4-14 | React browser adapter applies the `/session` doc with no `aud`/`iss`/`deviceId`/expiry sanity check                           | Low      | ✅ static |
| R4-15 | `pollUntilSettled` is an uncancellable infinite loop that `dispose()` does not stop                                           | Low      | ✅ static |
| R4-16 | License key passed as positional argv in all six CLI front ends → shell history and `ps`                                      | Low      | ✅ static |

---

### R4-01 — Offline cache is not integrity-protected

**Severity: High.** Complete licence bypass plus arbitrary secret injection, achieved by writing one JSON file. No key material, no debugger, no binary patching, no network. Trivially packaged and redistributed.

**Location**

- Signature verified then discarded: `packages/sdk-node/src/client.ts:491-510` — `verifyDoc(res.jws, …)` returns the decoded `doc`; only `doc` is stored, the JWS is dropped.
- Reload has no verification: `packages/sdk-node/src/store.ts:194-202` (`JSON.parse`), applied at `packages/sdk-node/src/client.ts:180-188`.
- Mirrors: `sdks/python/src/polaris_key/store.py:183-190`; `sdks/swift/Sources/PolarisKey/KeychainStore.swift:170-178` (`JSONDecoder().decode` — decodes shape, never authenticity).
- `KeyringStore` does **not** protect the cache: `store.ts:284-286` delegates `readCache`/`writeCache` straight to `FileStore`. The keyring only ever holds the token.

**Preconditions:** write access to `~/.config/<product>/managed.json` (or `$XDG_CONFIG_HOME`). Any non-empty `token` file satisfies `hasToken`; its _contents are never checked offline_.

**Exploit**

1. `mkdir -p ~/.config/<product>`
2. `echo -n anything > ~/.config/<product>/token`
3. Write `managed.json` containing `{"doc":{…},"lastAcceptedIssuedAt":0}` with any `entitlements`, any `payload.secrets`, any `profile`, and `expiresAt`/`graceUntil` set to a far-future integer.
4. Start the app. `status()` → `ok`; `isEntitled(anything)` → `true`; `getSecret(k)` → the injected string.

**Notably worse than a plain licence bypass:** the SDK is also a _secret-delivery_ channel (`client.ts:249-254`). A local attacker who can write this file chooses the values the host application will send to third-party APIs. And the `deviceId`/`aud` bindings that `verify.ts:25-26` enforces on the network path are **not** re-checked on reload, so a doc lifted from another machine — or another product on the same control plane — is honoured verbatim.

**PoC:** `R4-01` block, both tests.

**Fix direction:** store the original compact JWS in the cache and re-run `verifyDoc` (including `aud`, `deviceId`, and the `expiresAt`/`graceUntil` fields as signed) on every load. Treat verification failure as `needs-activation`, not as "keep the doc". Everything the gate reads must come from inside the signature envelope — which means the bookkeeping in R4-03 needs a different home (see there).

---

### R4-02 — Cache-planted `trustedKeys` grant permanent signing authority

**Severity: High.** This is the finding that turns "one file write" into "the vendor's signature no longer means anything on this device", and it _survives the online path_: the client will fetch, cryptographically verify, and persist attacker-signed documents as genuine.

**Location**

- `packages/sdk-node/src/client.ts:184-186` — `if (this.cache?.trustedKeys) this.trust = { ...this.trust, ...this.cache.trustedKeys };`
- `sdks/python/src/polaris_key/client.py:188-189` — identical.
- `sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:169-171` — identical.
- The field is written by the legitimate rotation path (`client.ts:543-546`) into the same unauthenticated file as everything else.

**Exploit**

1. Write `{"doc":null,"lastAcceptedIssuedAt":0,"trustedKeys":{"attacker-kid-1":"<raw ed25519 pubkey, base64url>"}}`.
2. Sign a `ManagedConfigDoc` with the matching private key and serve it at `/<product>/config` (hosts-file + a locally trusted CA, `NODE_EXTRA_CA_CERTS`, or a plain `http://` base URL — see R4-08).
3. `refresh()` returns `applied: true`. The doc is now in the cache marked as verified, indistinguishable from a real one.

**Amplification:** the injected key is also accepted by `refreshTrust()` (`client.ts:523`, which verifies against `this.trust` — already poisoned), so the attacker can serve a signed _trust manifest_ installing further keys, and the poisoning becomes self-sustaining across cache wipes of the `doc` field.

**PoC:** `R4-02` block. Uses a freshly generated Ed25519 keypair; the vendor key is never involved.

**Fix direction:** the pinned trust set from `PolarisKeyOptions.trust.pinnedKeys` must be the _only_ root. Cached rotation keys must be stored inside a structure signed by a pinned key (e.g. cache the trust-manifest JWS itself and re-verify it against the pinned set on load), never as bare `kid → key` JSON. A rotated key must chain to a pinned key on every load, not merely on the load where it was first installed.

---

### R4-03 — Attacker-writable anti-replay counters

**Severity: High.** Two distinct, permanent denials of the vendor's own control plane, plus the mechanism that makes R4-01/R4-02 stick _while the device is online and reachable_.

**Location**

- `lastAcceptedIssuedAt` consumed at `packages/sdk-node/src/verify.ts:27-32`, sourced from the cache at `client.ts:496`.
- `lastTrustIssuedAt` consumed at `client.ts:529-534`, sourced from the cache at `client.ts:530`.
- Mirrors: `sdks/python/src/polaris_key/verify.py:163` + `client.py:529-531`; `sdks/swift/…/PolarisKeyClient.swift:426, 462`.

**(a) Revocation cannot land.** Set `lastAcceptedIssuedAt` to a far-future epoch. Every genuine, correctly-signed doc the server issues now has a smaller `issuedAt` and is rejected by `verify.ts:27-32`. `fetchAndApply` returns `{ applied: false }` — a value **indistinguishable from a network error**, which sets no flag, logs nothing, and leaves `status()` reporting `ok`. The forged doc is pinned forever on a fully online device.

**(b) Key rotation cannot land.** Set `lastTrustIssuedAt` to a far-future epoch. `refreshTrust()` fetches and cryptographically validates the manifest, then discards it at `client.ts:529-534`. The vendor's mechanism for retiring a compromised signing key is now permanently disabled on this device, silently.

**(c) Replay protection resets on `rm`.** Deleting `managed.json` restores `lastAcceptedIssuedAt` to undefined, and a captured older doc (still inside its own `graceUntil`) is accepted again. This is the offline-capture-and-replay path for a user who once held a paid licence.

**PoC:** `R4-03` block, all three tests. (a) asserts a genuine `lic_REVOKED` doc is dropped while `isEntitled("pro")` stays `true`; (b) asserts a valid rotation manifest is fetched and then not installed; (c) asserts a year-old doc is re-accepted after the file is removed.

**Fix direction:**

- Distinguish "rejected by anti-replay" from "network failed" in `RefreshResult`, and treat a _persistent_ anti-replay rejection as a tamper signal (fail closed after N consecutive occurrences, or surface it to the host app).
- Anchor the counters to something the attacker cannot rewind: keep them alongside the token in the OS keyring/keychain, or bind them into the signed envelope from R4-01.
- Cap `lastTrustIssuedAt` / `lastAcceptedIssuedAt` at `now + skew`; a value in the far future is prima facie tampering.
- On (c): a wiped cache should force a fresh `/config` with `force: true` and reject any doc whose `issuedAt` is older than `now - maxDocAge`.

---

### R4-04 — Raw wall clock, no monotonic floor

**Severity: Medium.** Indefinite offline grace extension with no tooling beyond `sudo date` or disabling NTP. Medium rather than High because the same attacker can already achieve more via R4-01 — but this one needs _no_ file write at all, which matters for a host where the config dir happens to be protected.

**Location:** `packages/sdk-node/src/client.ts:115` (`nowSec`) feeding `gate.ts:45-53`; `sdks/python/…/client.py:65` → `license.py:146-151`; `sdks/swift/…/PolarisKeyClient.swift:174` → `Gate.swift`; `packages/sdk-react/src/core/gateModel.ts:56-58` via both adapters.

The client _does_ record a high-quality anti-rollback signal and then never uses it: `lastVerifiedAt` is written at `client.ts:503` (`Date.now()`), stored (`store.ts:29`), and passed into the gate (`client.ts:215`) — but `gate.ts` only ever echoes it back into `LicenseState` (`gate.ts:51, 57`). It is never compared against `now`. A `lastVerifiedAt` 400 days _ahead_ of `now` is accepted without comment.

**PoC:** `R4-04`. A doc expired 370 real days ago reports `expired` at the true clock and `ok`/`grace` at a rolled-back clock, while still advertising a `lastVerifiedAt` far in its own future.

**Fix direction:** add a monotonic floor — `effectiveNow = max(now, lastVerifiedAt/1000, doc.issuedAt)` — and treat `now < lastVerifiedAt - skew` as `expired` (or as a distinct `clock-tampered` status). Persist the floor in the same protected store as the counters from R4-03. The server already returns a `Date` header on every response; anchoring to it on each successful refresh is nearly free.

---

### R4-05 — Tamper detection is defeated by the same tamper

**Severity: Medium.** Not an authorization bypass — I confirmed the Worker treats `/config/report` as display/telemetry only (`packages/worker/src/licensing.ts:569-605`; the reported map is written to `devices.reported_json` and is never a merge layer in `licenseCore.ts:185-227`, and seat counting uses `COUNT(*)` on `devices`). The severity is that **the one server-side signal that would reveal an R4-01 forgery is authored by the forgery.**

**Location:** `packages/sdk-node/src/client.ts:574-596` (`reportSnapshotBody` reads straight from `this.cache.doc`), posted at `client.ts:431-437`. Mirrors: `client.py:607-624`, `PolarisKeyClient.swift:495-504`.

An admin looking at the device row sees exactly the entitlement/config map the attacker planted. The Worker applies a 15-key allowlist and a 16 KiB cap (`licensing.ts:87-103, 166-182`) but the _values_ inside `config`/`entitlements` are copied verbatim as unvalidated JSON of arbitrary shape and depth (`licensing.ts:173`) and rendered in the admin SPA — a stored-content surface worth hardening independently.

**PoC:** `R4-05` asserts the forged `{enterprise: true, "quality.floor": "lossless"}` map is POSTed to `/config/report`.

**Fix direction:** report the _authenticated_ state, not the cached projection — e.g. echo the `etag`/`issuedAt` of the doc the server actually signed and let the server compare, so a mismatch is detectable. Server-side, validate the reported `config`/`entitlements` against the catalog and flag divergence from what was issued rather than storing it as opaque JSON.

---

### R4-06 — Desktop bridge is an ambient, unauthenticated global capability

**Severity: Medium.** In an Electron/Tauri app, `window.polarisKey` is a privileged handle to the main process's credential store, and it is handed to the entire renderer JavaScript realm.

**Location**

- `packages/sdk-react/src/desktop/bridge.ts:93-100` — `resolveBridge` reads `globalThis.polarisKey` with no handshake, no capability token, no origin/frame check, and no shape validation.
- `packages/sdk-react/src/react/Provider.tsx:51-57` — `mode: "auto"` (the default, `Provider.tsx:65`) selects the desktop adapter on the _mere presence_ of that global.

Two directions, both live:

1. **Impersonation.** Any script that runs before the provider mounts can define `globalThis.polarisKey` and win. `auto` mode then routes the whole app through it — the attacker chooses `status`, `entitlements`, `profile`, and `configEntries` for every `useEntitlement`/`useManagedConfig` consumer, and the real browser transport is never contacted.
2. **Capability leak.** Once the real preload exposes the bridge, `signOut()` (wipes the user's credentials server-side and locally) and `submitKey(attackerKey)` (rebinds the device to the attacker's licence, burning a seat and swapping the rendered profile) are callable by any code in the realm — including a compromised transitive npm dependency in the renderer bundle, with no caller identity and no user confirmation.

**PoC:** `R4-07` block in the test file (re-stating `resolveBridge` and `resolveMode` verbatim, since the React SDK is a separate workspace package). It proves both directions.

**Fix direction:**

- Make `bridge` an explicit, required prop for `mode: "desktop"`; drop the global-sniffing default, or at minimum require `mode: "desktop"` to be stated rather than inferred (`auto` should prefer `browser` and only use a bridge that was passed in).
- Have the preload mint a one-time capability token at `contextBridge.exposeInMainWorld` time and require it on every call, so a later-loading dependency cannot re-use the handle.
- Gate the two destructive verbs (`signOut`, `submitKey`) behind a main-process user confirmation, and validate the sender frame in the IPC handler.

---

### R4-07 — Python CLI defaults to a build-gate-bypassing version

**Severity: Medium.** A vendor-shipped tool whose _default_ invocation bypasses a server-side control.

**Location:** `sdks/python/src/polaris_key/cli/argparse_cli.py:22`, `cli/click_cli.py:18`, `cli/typer_cli.py:50,61,72,84`, and the dataclass default `cli/core.py:60` — all `version = "0.0.0-dev"`.

The Worker's `checkBuildGate` short-circuits on a dev version before evaluating either the version window or the channel entitlement (`packages/worker/src/gate.ts:126-127`, `isDevBuild` at `gate.ts:69-71`). So `polaris-key status --product foo` — with no `--version` — always requests a doc that skips version _and_ channel enforcement. Any user can also pass `--version 0.0.0-dev` explicitly to the same effect, and Node's adapters forward whatever `--version` the host CLI parsed (`packages/sdk-node/src/cli/commander.ts:63`, `cli/yargs.ts:39`).

**Fix direction:** make `--version` required (it is already required for `--product`), or default it to the installed package version rather than a dev sentinel. Server-side, the `isDevBuild` short-circuit should be gated on the product actually entitling the `dev` channel rather than on a client-asserted string — that part belongs to the Worker lane, cross-referenced here because the client ships the bypass by default.

---

### R4-08 — Node/Swift transport hardening gaps

**Severity: Medium.** These are missing guardrails rather than a default-exploitable flaw (the default base URL is `https://key.plrs.im`), but each one materially widens R4-02.

**Location**

- No scheme validation on `baseUrl`: `packages/sdk-node/src/client.ts:145` (only strips trailing slashes), `sdks/python/…/client.py:125`, `sdks/swift/…/PolarisKeyClient.swift:59`, `packages/sdk-react/src/browser/browserAdapter.ts:104`, `packages/cli/src/index.ts:173`. An `http://` base URL is accepted and the bearer token is sent over it in clear text (proven). No certificate pinning anywhere.
- **No request timeout in Node.** `packages/sdk-node/src/fetch.ts:36` accepts an `AbortSignal`, but `client.ts` never supplies one — nor do any of the `endpoints.ts` calls. Node's `fetch` has no default timeout. Python is the only SDK that sets one (`client.py:162`, `timeout=30.0`) and only when it constructs its own `httpx.Client`; an injected client inherits the caller's settings. Swift relies on `URLSession` defaults.
- **`refreshTrust()` is awaited before `/config`** (`client.ts:447`), so a slowloris on `/.well-known/polaris-trust.jws` stalls the entire refresh. `.catch()` does not help with a hang.
- **No in-flight guard on the refresh timer** (`client.ts:190-198`): `setInterval` fires unconditionally, so stalled refreshes accumulate without bound, each one re-running `collectFacts()` (which spawns `sw_vers` on macOS, `facts.ts:47-58`).

**PoC:** `R4-06` block — asserts the plaintext URL + bearer, that no `signal` is ever passed, and that three overlapping `refresh()` calls all reach the network simultaneously.

**Fix direction:** reject a non-`https:` `baseUrl` in the constructor unless an explicit `allowInsecureTransport` opt-in is set (useful for local dev). Thread an `AbortSignal` with a default deadline (say 15 s) through `fetch.ts` and `endpoints.ts`. Give `refresh()` an in-flight promise guard so a stalled call coalesces instead of stacking. Consider making `refreshTrust` non-blocking with respect to the config fetch.

---

### R4-09 — Swift `writeSecure` creates world-readable, then chmods

**Severity: Low.** Real, but narrowed by the 0700 parent directory. Worth fixing because the failure mode is _permanent_, not transient.

**Location:** `sdks/swift/Sources/PolarisKey/KeychainStore.swift:184-188`.

```swift
private func writeSecure(_ data: Data, to url: URL) {
    try? data.write(to: url, options: .atomic)
    try? FileManager.default.setAttributes(
        [.posixPermissions: 0o600], ofItemAtPath: url.path)
}
```

Measured on macOS 26 / Swift 6.3 with the default umask 022:

| step                                       | resulting mode   |
| ------------------------------------------ | ---------------- |
| `data.write(.atomic)` — file did not exist | **0644**         |
| `setAttributes(0o600)`                     | 0600             |
| `data.write(.atomic)` — file already 0600  | 0600 (preserved) |

So the exposure window is the **first-ever write** of `managed.json` and `device` — which is precisely when the cache first contains `payload.secrets`. Because **both** statements use `try?`, a failing `setAttributes` (or a crash/SIGKILL between them) leaves the file at 0644 _permanently_, with no error surfaced to the caller.

Node (`store.ts:138-150`, `openSync(..., O_CREAT|O_NOFOLLOW, 0o600)`) and Python (`store.py:132-140`, `os.open(..., 0o600)`) set the mode atomically at creation and do not have this window.

**Fix direction:** create with `open(2)` at mode 0600 (or write to a `mkstemp` file, `fchmod` it, then `rename`), and propagate — rather than swallow — both failures.

---

### R4-10 — Pre-existing over-permissive modes are never repaired; Windows loses `O_NOFOLLOW`

**Severity: Low.**

Measured, all three SDKs:

- A pre-existing `managed.json` at 0644 stays 0644 after `writeSecure` — the `mode` argument to `open(2)` only applies at creation. Node `store.ts:138-150`, Python `store.py:132-140`.
- A pre-existing `~/.config/<product>` directory at 0755 stays 0755 — `mkdirSync(recursive, mode)` / `os.makedirs(mode=)` / `FileManager.createDirectory(attributes:)` all no-op on an existing directory. Node `store.ts:172`, Python `store.py:157`, Swift `KeychainStore.swift:110-112`.
- Python's `os.makedirs(mode=0o700)` applies the mode to the **leaf only**; intermediates get `0777 & ~umask`. (Node and Swift apply it to every created level.) Benign for `~/.config` specifically, but a divergence worth knowing.
- `sdks/python/src/polaris_key/store.py:135` — `flags |= getattr(os, "O_NOFOLLOW", 0)`. On Windows the constant is absent, so the symlink guard silently becomes a no-op with no diagnostic. The comment on line 133 still promises the protection.
- Swift has no symlink guard at all. `.atomic` replaces a planted symlink on write, but the **read** paths do follow one: `KeychainStore.swift:160` (`String(contentsOf: deviceURL)`) and `:171` (`Data(contentsOf: cacheURL)`).

Realistic trigger: a config directory restored from a backup, created by an installer, or synced from another machine.

**Fix direction:** `stat` before use and repair (or refuse) when the mode is wider than expected. Make the Windows `O_NOFOLLOW` degradation explicit — use `FILE_FLAG_OPEN_REPARSE_POINT` semantics or document the gap rather than papering over it with `getattr(..., 0)`.

---

### R4-11 — Silent keyring → plaintext-file downgrade

**Severity: Low.**

`packages/sdk-node/src/store.ts:232-263` and `sdks/python/src/polaris_key/store.py:219-248`: if the keyring module is missing _or any keyring call throws_, the token is written to a plaintext 0600 file instead, and the caller is never told. On a headless CI box that is the documented, intended behaviour. On a desktop where the keyring merely failed transiently (locked keychain, D-Bus hiccup, `libsecret` not running), the user silently loses the OS-level protection they believe they have, and there is no API to ask which backend is in use.

**Fix direction:** expose the resolved backend on the store (`store.tokenBackend: "keyring" | "file"`) and surface it in `status()`/`pkey doctor`, so a product can warn. Optionally add a `requireKeyring` option that fails closed.

---

### R4-12 — Swift discards Keychain status codes and has no token fallback

**Severity: Low** (availability, not confidentiality — but a bad user experience with no diagnostic).

**Location:** `sdks/swift/Sources/PolarisKey/KeychainStore.swift:145` (`SecItemAdd(add as CFDictionary, nil)` — return value discarded) and `:155` (`SecItemDelete(query as CFDictionary)` — discarded). `SecItemUpdate` at `:140` _is_ checked, but only to detect `errSecItemNotFound`.

Unlike Node and Python, `KeychainStore` has **no file fallback for the token** — only the keychain. So if `SecItemAdd` fails (locked keychain, `errSecInteractionNotAllowed`, a missing keychain-access-group entitlement on an unsigned or sandboxed build), `setToken` returns normally having stored nothing. `activate()` still returns `.ok` and `client.status()` is `ok` for the rest of the process lifetime; the next launch reports `needs-activation`. The user re-activates on every launch and no error ever names the cause.

Related, same file: `getDeviceId()` (`:159-167`) swallows the `writeSecure` failure with `try?`. On a platform where `DeviceID.rawDeviceId()` returns `nil` — i.e. anything that is not macOS or iOS, per `DeviceID.swift:30-38`, which falls back to `UUID().uuidString` — an unwritable config directory yields a **fresh random device id on every launch**, creating a new device row (and consuming a seat) each time. Node (`store.ts:187-193`) and Python (`store.py:175-181`) let the write throw and fail loudly.

**Fix direction:** make `Store`'s mutating methods `throws` (or return a status), check every `SecItem*` result, and either mirror Node/Python's file fallback or surface a typed error so the host app can tell the user their keychain is unavailable.

---

### R4-13 — Python raises where Node coerces and Swift rejects

**Severity: Low.** Availability only, and confirmed reproducible:

```
verify.py:163 raises -> TypeError: '<=' not supported between instances of 'str' and 'int'
license.py:146 raises -> TypeError: '>' not supported between instances of 'int' and 'str'
```

**Location:** `sdks/python/src/polaris_key/models.py:176-189` — `ManagedConfigDoc.from_dict` does **no type coercion or validation**; it only requires the keys to be present. `verify_jws_doc` (`verify.py:131-139`) wraps `from_dict` in `except Exception: return None`, so a _missing_ key is handled — but a present key with the wrong _type_ passes straight through.

Two paths:

1. A signed-but-malformed doc with `"issuedAt": "5"` reaches `verify.py:163` and raises `TypeError` out of `verify_doc` → `_fetch_and_apply` → `refresh()`, uncaught. Node coerces via JS `<=` (`verify.ts:29`); Swift's `JSONDecoder` rejects at decode (`Models.swift`).
2. Local only, and therefore reachable without any signing key: a tampered `managed.json` with `"graceUntil": "9999999999"` decodes cleanly and then raises `TypeError` at `license.py:146` inside `status()` — turning every gate read into a crash.

**Fix direction:** validate types in `from_dict` (`isinstance(d["issuedAt"], int)` etc.) and return/raise a typed `ValueError` that `verify_jws_doc`'s existing `except Exception` already converts to `None`. Same treatment for `expiresAt`, `graceUntil`, `schemaVersion`, and `DocProfile.activatedAt`.

---

### R4-14 — React browser adapter applies the `/session` doc with no sanity check

**Severity: Low.** The _absence of a signature check_ here is **defensible** and I am not flagging it (see [INHERENT](#inherent--not-findings)): `GET /<product>/session` returns unsigned JSON over TLS behind an `HttpOnly; Secure; SameSite=Lax` first-party cookie, and the Worker strips `payload.secrets` before building it (`packages/worker/src/browserSession.ts:196`). Both `BrowserAdapter.getSecret` (`browserAdapter.ts:422-425`) and `DesktopAdapter.getSecret` (`desktopAdapter.ts:262-267`) return `null` unconditionally. That is a coherent design.

What _is_ a gap is the total absence of **content** validation. `browserAdapter.ts:216-230` casts the JSON to `SessionResponse` and hands `s.doc` to `projectState` (`browserAdapter.ts:179-193`), which never checks `doc.aud`, `doc.iss`, `doc.deviceId`, or that `expiresAt`/`graceUntil` are numbers (`packages/sdk-react/src/core/adapter.ts:70-102`). Every other SDK asserts `aud` and `deviceId` (`verify.ts:25-26`, `verify.py:159-161`, `JWSVerifier`/`verifyDoc` in Swift). Because `baseUrl` and `productSlug` are independent options against a path-scoped multi-tenant control plane, a misconfiguration silently yields a foreign product's doc with no complaint. Non-numeric `graceUntil` also produces a `false` comparison in `gateModel.ts:56`, quietly landing in `ok`.

**Fix direction:** assert `doc.aud === productSlug`, `doc.iss === ISSUER`, and `typeof doc.expiresAt === "number" && typeof doc.graceUntil === "number"` in `BrowserAdapter.apply` (and in `DesktopAdapter.apply`, where the doc crosses an IPC boundary from a process the renderer should not blindly trust). Fail to `needs-activation` with an error rather than projecting the doc.

---

### R4-15 — `pollUntilSettled` is an uncancellable infinite loop

**Severity: Low.**

**Location:** `packages/sdk-react/src/desktop/desktopAdapter.ts:159-183` (`for (;;)` with a 1.5 s delay, exiting only on a terminal `pollSignIn` result) versus `dispose()` at `:273-276`, which clears `offBridge` and nothing else.

A bridge that keeps returning `{ kind: "pending" }` — a stalled OIDC flow, an unreachable IdP, or a hostile bridge per R4-06 — produces an unbounded loop that survives provider unmount, keeps issuing IPC calls to the privileged process every 1.5 s for the lifetime of the window, and keeps writing into a store nobody reads. There is also no overall deadline: the OIDC device-flow `expires_in` is never consulted.

**Fix direction:** hold an `AbortController` (or a cancellation flag + timer handle) on the adapter, abort it in `dispose()`, bail out when the store has been disposed, and impose a hard wall-clock deadline on the poll.

---

### R4-16 — License key as positional argv

**Severity: Low.** Well-understood, cheap to fix.

**Location:** `packages/sdk-node/src/cli/commander.ts:74-79` (`activate <key>`), `cli/yargs.ts:70-76` (`activate <key>`), `sdks/python/src/polaris_key/cli/argparse_cli.py:69` (`p_act.add_argument("key", …)`), plus the click and typer front ends.

`polaris-key activate PKEY-XXXX` lands in `~/.zsh_history` / `~/.bash_history` unencrypted and is visible to every user on the box via `ps auxww` for the duration of the call, and to any process reading `/proc/<pid>/cmdline` on Linux.

**Fix direction:** make the positional optional and prompt on a TTY when omitted; accept `--key-file <path>` and `--key-stdin`; read an env var as a documented fallback. Keep the positional for scripting but document the exposure.

---

## INHERENT — not findings

These are unavoidable consequences of running licence enforcement inside a process the user controls. They are listed so the fix effort is not spent here.

1. **Binary patching.** A user who edits the shipped bundle can stub `isLicensed()` to `return true`. No client-side measure defeats this; only server-side enforcement of what actually matters (seat counts, secret issuance, entitlement-gated API calls) does.
2. **Debugger / `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` / a patched `node_modules`.** Same class as (1).
3. **Re-implementing the SDK.** The wire protocol is public and the client holds a valid device token; anyone can write their own client that ignores the gate.
4. **Offline grace existing at all.** Any `graceUntil > expiresAt` is, by construction, a window in which the client runs without server contact. That is a product decision, not a bug.
5. **The pinned trust set living in the shipped binary.** Public keys are not secrets, and pinning them is the correct design. (R4-02 is a finding precisely because it lets the attacker _add_ to that set, which pinning was supposed to prevent.)
6. **`localOverrides` and `PKEY_CONFIG_*` env layering for `default`-state keys.** A designed feature. I verified `enforced`/`hidden` correctly beat both layers in all four SDKs — see REFUTED.
7. **Hardware fingerprint components are computed on-device and are not server-verifiable.** `packages/sdk-node/src/fingerprint.ts:200-231` hashes locally-read values; the server can only compare opaque digests (`packages/worker/src/fingerprint.ts:66-83` validates shape only). Without hardware attestation this is inherent, and the design already acknowledges it — the server recomputes `hwid` from the components rather than trusting the client's, and the real ceiling is the seat count, which holds. Cloning a fingerprint to a second machine is therefore possible but gains nothing a second activation would not.
8. **The React browser adapter not verifying a JWS.** A browser cannot hold a device token or a keyring; TLS + `HttpOnly; Secure` cookie + server-side stripping of `payload.secrets` is the right trust model for that transport. (Only the missing _content_ assertions are a finding — R4-14.)
9. **Local clock being locally controllable.** The finding (R4-04) is the absence of a cheap monotonic floor, not the existence of a settable clock.

---

## REFUTED

Nine hypotheses I tested and could not substantiate.

1. **"A tampered cache can be leveraged into a `/token` re-acquire gain."** Refuted. `CacheRecord` carries no token (`packages/sdk-node/src/store.ts:26-42`); the token lives in the keyring or a separate `token` file. `POST /<product>/token` requires a bearer whose hash matches `devices.token_hash` in D1 _and_ an `X-PKey-Device` header matching the KV record (`packages/worker/src/licensing.ts:372-380`), and it persists nothing from the client. No cached value reaches it.

2. **"A tampered cache can influence what `/config` returns."** Refuted. The only cache-derived value on the wire is `if-none-match` (`fetch.ts:52` from `client.ts:455`). The worst an attacker achieves is forcing a full re-send by clearing it — the opposite of useful.

3. **"A tampered cache can influence `/config/report` in a way the server later trusts."** Refuted as an _authorization_ gain. I traced both sinks: `devices.reported_json` is read only for admin display (`packages/worker/src/admin/handlers/licenses.ts:210-211`) and carried forward verbatim in `licenseCore.ts:371`; `device_facts` is read only by admin handlers. `resolveEffective` (`licenseCore.ts:185-227`) never merges reported values, and seat counting is a SQL `COUNT(*)`. Downgraded and re-filed as R4-05 (detection evasion) rather than an authorization finding.

4. **"`enforced`/`hidden` config can be overridden locally."** Refuted in all four SDKs: `packages/sdk-node/src/config.ts:91-93`, `sdks/python/…/client.py:262-263`, `sdks/swift/…/PolarisKeyClient.swift:203-205`, `packages/sdk-react/src/core/adapter.ts:43`. The remote value wins over both `localOverrides` and the env layer in every implementation. `listUserConfig` correctly withholds `hidden` keys while `getConfig` still applies them.

5. **"`alg: none` / HMAC downgrade against the JWS verifier."** Refuted. All three implementations assert `alg === "EdDSA"` and `typeof kid === "string"` _before_ any signature math, and select the key by `kid` from the caller-supplied trust set, never from the document: `packages/shared-jws/src/index.ts:158-160`, `sdks/python/src/polaris_key/verify.py:100-109`, `sdks/swift/Sources/PolarisKey/JWSVerifier.swift`. All three fail closed (`null`) on every error path, including a malformed base64url signature.

6. **"Secrets leak to the browser or the renderer."** Refuted three times over: the Worker strips `payload.secrets` before building the browser doc (`packages/worker/src/browserSession.ts:196`); `BrowserAdapter.getSecret` returns `null` unconditionally (`browserAdapter.ts:422-425`); `DesktopAdapter.getSecret` returns `null` unconditionally (`desktopAdapter.ts:262-267`). Secrets only ever materialise in the Node/Python/Swift clients.

7. **"The JSON-parse DoS cap can be bypassed on the cache-reload path."** Not applicable rather than refuted, but worth recording: the 64 KiB `MAX_DOC_BYTES` cap (`shared-jws/src/index.ts:37, 152`) protects the _network_ path. The cache reload has no cap at all (`store.ts:194-202`) — but the attacker who would supply an oversized cache file already owns the process, so this is not an additional capability. Not filed.

8. **"The refresh timer keeps a CLI process alive / leaks."** Refuted for Node and Python: `client.ts:197` calls `timer.unref?.()`, and `client.py:211-213` marks the thread `daemon=True`. Swift's `refreshTask` is explicitly cancellable (`PolarisKeyClient.swift:357-360`). The React provider clears its interval on unmount (`Provider.tsx:120`). Only `pollUntilSettled` leaks (R4-15).

9. **"`baseUrl` normalisation can be abused to splice a path/credential."** Refuted for the realistic attacker. `client.ts:145` only strips trailing slashes, so a `baseUrl` like `https://evil.test/?x=` would indeed misdirect the token — but `baseUrl` is supplied by the _host application_, not by the attacker, in every non-CLI integration. Via the CLI's `--base-url` flag the user is already the attacker and gains nothing. Folded into R4-08 as a missing-validation note rather than filed separately.

---

## Suggested fix order

1. **R4-01 + R4-02 + R4-03 together.** They are one defect wearing three hats: the cache is an unauthenticated input that feeds the gate, the trust set, and the anti-replay state. Fixing R4-01 in isolation (re-verify the JWS on load) does _not_ fix R4-02 or R4-03, because `trustedKeys` and the counters live outside the signed envelope. Design the cache format once: signed doc + a separately protected bookkeeping record.
2. **R4-04** — a monotonic floor is ~10 lines per SDK and closes the no-file-write attack.
3. **R4-06** — a breaking API change to `PolarisKeyProvider`, so land it before more integrations ship.
4. **R4-07, R4-08** — cheap, and R4-08 shrinks R4-02's delivery surface.
5. The Low band, opportunistically.

---

## Remediation

Landed on branch `lewd-owl` by the client/crypto remediation lane. Scope: `packages/sdk-node/**`
only — `packages/sdk-react`, `sdks/python`, `sdks/swift` and `packages/cli` belong to other
lanes and are **not** touched here.

**Result:** `@polaris-key/node` 162/162 (was 154), `@polaris-key/conformance-node` 68/68
(was 34), `@polaris-key/jws` 42/42, `pnpm gen:corpus -- --check` clean, `tsc --noEmit` clean,
Prettier clean.

`R4-client-attack.test.ts` has been **inverted**: every block keeps its original name and now
asserts the attack FAILS, with a `// FIXED (id)` comment naming the finding. The one exception
is `R4-07`, which still asserts the vulnerable behaviour — see below.

| Finding                   | Status                                | Where                                                                                                                                                                                                               | Test proving it                                                                                                                                                     |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-01                     | **fixed**                             | `store.ts` `CacheRecord` v2 holds `configJws`/`trustJws` and nothing else; `client.loadCache()` re-verifies against the pinned keys and derives all state; any failure ⇒ `needs-activation`                         | `R4-01` block ×2 (hand-written cache yields nothing; a genuinely-signed doc bound to another product/device is refused on reload)                                   |
| R4-02                     | **fixed**                             | `trust.ts` `mergeTrust()` = `{...discovered, ...pinned}`; `trustedKeys` no longer exists; keys only come from a manifest that verifies against the PINS                                                             | `R4-02` block; corpus `trust-pinned-substitution`, `trust-signed-by-non-pinned-key`                                                                                 |
| R4-03                     | **fixed**                             | `lastAcceptedIssuedAt` / `lastTrustIssuedAt` / `lastVerifiedAt` deleted from disk; derived from re-verified content                                                                                                 | `R4-03` ×3: (a) a genuine revocation now lands, (b) a rotation manifest now installs, (c) a wiped cache no longer re-opens replay because §3 refuses an expired doc |
| R4-04                     | **fixed**                             | `gate.ts` evaluates at `max(now, highWaterMark)`; the high-water mark is the greatest verified `issuedAt`, recomputed at load from `configJws`                                                                      | `R4-04` block: the planted cache is unloadable, and with a genuine cached doc a 400-day rollback does not move the gate                                             |
| R4-05                     | **fixed** (as a consequence of R4-01) | `reportSnapshotBody()` reads the re-verified doc, so there is no attacker-authored map to echo                                                                                                                      | `R4-05` block asserts the report carries empty maps                                                                                                                 |
| R4-08                     | **fixed** (2 of 4 sub-issues)         | `normalizeBaseUrl()` rejects non-`https:` (loopback exempt) via `InsecureBaseUrlError`; every request carries `AbortSignal.timeout(requestTimeoutMs)`, default 15 s, threaded through `fetch.ts` and `endpoints.ts` | `R4-06` block ×2                                                                                                                                                    |
| R4-06, R4-07, R4-09…R4-16 | **not addressed**                     | React / Swift / Python / CLI lanes                                                                                                                                                                                  | —                                                                                                                                                                   |

### R4-08: what was NOT fixed

Two of the four sub-issues remain open, deliberately:

- **`refreshTrust()` is still awaited before `/config`.** It can no longer _hang_ — the
  deadline fires and the error is swallowed — but a slow trust endpoint still delays the config
  fetch by up to one timeout. Making it non-blocking changes refresh ordering and was out of
  the brief's scope.
- **No in-flight coalescing on `refresh()`.** Overlapping calls still each reach the network.
  A shared in-flight promise would make `refresh({force:true})` silently return a non-forced
  result to a caller that asked for a forced one — `activateWithKey()` depends on that
  distinction — so it needs a design decision rather than a one-line guard. The unbounded
  pile-up the finding describes is bounded now (each call terminates within the deadline), but
  the coalescing gap is real and should be filed forward.

Also unfixed and worth restating: **`getSecret` / `isEntitled` / `getConfig` still do not
consult the gate.** Under v2 an unverifiable document is no longer a document, so the
R2-08/R4-01 forgery paths are closed — but a _genuinely signed_ document whose `graceUntil` has
passed still yields entitlements and secrets to a caller who never checks `isLicensed()`. That
is R2-08's "payload accessors never consult the gate" sub-finding; changing it is a breaking
API behaviour change and was outside this lane's brief.

### Behavioural changes adopters will notice

1. **The cache format is v2 and a v1 record is discarded, not migrated** (§7.3). Every existing
   installation performs one extra `/config` round trip on first launch after upgrading, and a
   client that is offline at that moment reports `needs-activation` until it can reach the
   control plane once. This is the intended price of not carrying poisoned state forward.
2. **`baseUrl` must be `https:`** (or `http://localhost` / `http://127.0.0.1`). A non-HTTPS
   base URL now throws `InsecureBaseUrlError` from the **constructor**, not at first request.
3. **`PolarisKeyOptions.requestTimeoutMs`** is new (default 15000; `0` disables).
4. **`lastVerifiedAt` is derived.** Offline it is `doc.issuedAt * 1000` — the server's own
   statement of when the document was minted — rather than a locally recorded wall-clock value
   an attacker could choose. It still moves to `Date.now()` after a successful online verify,
   including on a `304`.
5. **A trust manifest is verified against the PINNED keys only**, on both the network and the
   reload path. A rotated key can no longer sign the manifest that mints the next key. This
   closes R4-02's amplification, and it also guarantees anything installed online still
   verifies after a restart.

### Cross-lane note

`packages/worker/test/e2e.test.ts` was updated (outside this lane's stated scope) because it
consumes `CacheRecord` and `verifyDoc` directly and would otherwise not compile: it now seeds
the cache with a signed `configJws` and passes an explicit `now: NOW` to `verifyDoc`, since the
fixtures mint documents at a fixed epoch and §3 now asserts the freshness window. That file is
4/4 green. `packages/worker/test/attack/R11-data.test.ts` has pre-existing typecheck errors
from the R11 lane that are unrelated to this work.

---

## Remediation (clock floor)

**R4-04 — closed properly.** The earlier "fixed" entry above was half a fix. `gate.ts` did
evaluate at `max(now, highWaterMark)`, but the mark was derived from `configJws` alone, and
that form is **inert**: with one cached document `highWaterMark === doc.issuedAt`, while
`graceUntil = issuedAt + maxOfflineDays × 86400` is greater by construction, so the floor could
never reach the end of grace. Rolling the clock back into an aged-out document's window still
returned `ok`. It did block replay of an _older_ document, which is why it was not worthless —
it simply did not stop the attack it was written for.

Landed in all three client implementations, together, per wire contract v2 §4.3 as corrected:

```
highWaterMark = max(verifiedConfigDoc.issuedAt, verifiedTrustManifest.issuedAt)
effectiveNow  = max(systemClock, highWaterMark)
```

| Implementation       | Change                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@polaris-key/node`  | `client.ts` gains `raiseFloor()`; called from `loadCache()` for the cached manifest AND the cached doc (the doc assignment was `=`, which would have _lowered_ the mark), and from `refreshTrust()` on the network path.       |
| `polaris-key` (py)   | `client.py` gains `_raise_floor()`; called from `_accept_doc()` and `_apply_trust_manifest()`, so both the reload and network paths raise it.                                                                                  |
| `PolarisKey` (swift) | `applyTrustManifest()` raises `highWaterMark`. `verifyCachedDoc()` now evaluates at `effectiveNow()` instead of the raw clock, so a rollback larger than `MAX_GRACE_SECONDS` can no longer make a current document unloadable. |
| `@polaris-key/jws`   | Unchanged — it verifies signatures and knows nothing about the gate.                                                                                                                                                           |

**Why the manifest is the right second source.** It is signed by a **pinned** key, cached
separately from the config document, and `trustRefresh` is on by default — so it advances even
while a content-stable config document sits behind an unchanged ETag. A client that verified a
manifest yesterday cannot then claim it is last month.

**The freshness trap, avoided.** A cached manifest is loaded with `checkFreshness: false`; its
`expiresAt` is minutes away, so re-checking it on load would drop every rotated key on restart
(`testStaleCachedManifestStillYieldsItsKeysOnLoad`). Raising the floor from a stale cached
manifest is nonetheless correct — `issuedAt` is a signed lower bound on real time whether or
not the manifest is still fresh. No freshness check was re-introduced on that path, and
`trust-expired-manifest-reload-path` now pins it cross-language.

**Cross-language enforcement, not per-SDK convention.** `tools/sign-corpus.ts` gains a
`clockFloorCases` section (6 cases) plus `checkFreshness` / `expect.issuedAt` on `trustCases`
(1 new case). Each floor case replays the cache-reload path as pure data and every runner
asserts all three of `highWaterMark`, `effectiveNow` and the gate status:

| Case                                                | Pins                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `floor-config-doc-alone-does-not-stop-rollback`     | the defect itself — single-source is insufficient, so it cannot come back |
| `floor-trust-manifest-defeats-rollback`             | the fix: rollback + yesterday's manifest ⇒ `expired`                      |
| `floor-stale-cached-manifest-still-yields-its-keys` | no freshness checking re-introduced on the reload path                    |
| `floor-honest-clock-is-never-lowered`               | the floor is a minimum, never a substitute                                |
| `floor-rejected-manifest-does-not-raise-it`         | only re-verified content moves the mark (no planted-file DoS)             |
| `floor-manifest-without-a-document`                 | the mark survives with no config document at all                          |

Client-level regressions (not just the primitives) were added per SDK: `R4-client-attack.test.ts`
→ "cannot extend an aged-out document's grace…", `test_wire_contract_v2.py` →
`test_r4_04_the_trust_manifest_anchors_time_independently`, `TrustAndCacheTests.swift` →
`testTrustManifestAnchorsTheClockFloorIndependently`. Each drives (a) document-only ⇒ rollback
still works, (b) with the cached manifest ⇒ `expired`, (c) the online `refreshTrust()` path.

### Still not fixed

- **No far-future bound on a cached manifest's `issuedAt`.** With `checkFreshness: false` the
  reload path does not bound it above, so a manifest the vendor mis-signs with an absurd
  `issuedAt` would drive every client that caches it to `expired`. It requires the pinned
  private key, so it is a vendor-footgun rather than an attacker path, and Node/Python have the
  same gap on the cached _document_ (Swift alone rejects a far-future doc, via
  `verifyCachedDoc`). Bounding all four consistently is a separate, cross-cutting change.
- The R4-08 and payload-accessor items listed above are unchanged by this work.
