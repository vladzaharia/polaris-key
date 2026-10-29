// The HTTP transcript format, version 1 (P1b-03, PARITY §4.2).
//
// A transcript pins one CONVERSATION between an SDK and the Worker: the requests a client must
// send, in the shape the contract fixes, and the Worker's real answers to them. The Worker's own
// scenario tests (`./scenarios/`) record them through the real router; every SDK replays them
// against a fake server that serves the canned responses and asserts each request.
//
// The files are GENERATED — `conformance/transcripts/<id>.json`, mirrored into the Swift test
// bundle — and drift-checked by `pnpm gen transcripts --check` and by the Worker suite. Never
// hand-edit one: change the scenario and regenerate.
//
// ── WHICH SDK REPLAYS WHICH TRANSCRIPT ──────────────────────────────────────────────────────
//
//   An SDK replays a transcript when its parity manifest marks every id in `features`
//   `implemented` AND marks none of the ids in `requires` `na`. `features` is what the
//   conversation PROVES; `requires` is what it PRESUPPOSES without proving. Every conversation
//   that authenticates with a `pkeyt_` device token requires `core.store`: a runtime with no
//   credential store (the browser, the desktop renderer — both `na` in the React manifest) never
//   has this conversation at all, while `planned` there only means the store's hardening is still
//   open. `pnpm parity:check` applies the same rule when it demands a tagged replayer.
//
// ── READING A TRANSCRIPT ────────────────────────────────────────────────────────────────────
//
//   * `initial` is the client's state before the first step: the device id its store returns,
//     the token it already holds (if any), the host version it reports, and the services it
//     expects before discovery (`services`, the SDK's `expectedServices`; absent ⇒ the SDK
//     default of license + config). `deviceName` (PX-W13, WIRE-CONTRACT-V4 §12.7.1) stands in
//     for the platform's own device name: a replayer feeds it to the SDK's default-label hook
//     (the label the SDK sends when the host passes none), and absent means NO default, so the
//     SDK sends no label unless a step passes one.
//   * each step is ONE public SDK call (`action`), made with the SDK clock at `now` (the step's,
//     else the transcript's), and every HTTP exchange that call makes — including the ones it
//     makes implicitly, such as the sync an activation triggers.
//   * `exchanges.ordered: false` (the default everywhere the protocol allows it, PARITY §2.3): a
//     request is matched to the first not-yet-served item with the same method and path whose
//     assertions it satisfies, so a client may issue parallel requests in any order and a
//     sequential client may issue them one after the other. Placeholders are substituted when a
//     request ARRIVES, from the bindings current at that moment, so a request that depends on a
//     captured value (a rotated token) only matches once that value has been served.
//     `ordered: true` additionally requires the items in their listed order.
//   * request `headers` are asserted by VALUE, after `{name}` placeholders are substituted from
//     `initial` (`{deviceId}`, `{version}`, `{token}`), the step's `args` (`{key}`) and earlier
//     `capture`s. `requiredHeaders` are asserted by PRESENCE only. Names compare lowercased;
//     order and casing are never asserted (PARITY §11 Q2).
//   * request `body`: `null` ⇒ the request carries no body. Otherwise `json` compared under
//     `match`:
//       exact   deep equal;
//       subset  every expected member present; objects recurse as subsets, arrays and scalars
//               must be equal;
//       shape   every expected member present with the same JSON type, recursing into objects
//               (an expected `{}` accepts any object); values are not compared.
//     `allowedKeys`, when present, bounds the top-level members the body may carry at all.
//   * response `body` is a string served byte-for-byte (a compact JWS, an empty 304, a plain
//     error) or a JSON value served as its compact serialization (member order is not
//     significant to any client).
//   * `expect` is the client-visible outcome after the step, in the vocabulary below. Each SDK
//     maps its own result types onto it in one helper.
//
// ── FORM BODIES AND THE BROWSER'S STEPS (I-08) ──────────────────────────────────────────────
//
// A request whose `content-type` header is asserted as `application/x-www-form-urlencoded`
// carries its `body.json` members as the form's fields (`token`, WIRE-CONTRACT-V4 §12.5): a
// replayer encodes them as a form because the request says so. A `browser` step holds the
// requests a person's browser makes in a redirect sign-in; a replayer serves them from its fake
// server and asserts nothing of them. `redirectComplete` is the SDK's one call in that flow:
// result "ok" | "invalid-grant" | "invalid-request" | "invalid-client" | "license-choice-required"
// | "rate-limited" | "error", then `scope`, `subject`, `licenseId` (null on a licence-less device)
// and `tokenHeld` on "ok".
//
// `redirectComplete` also reports result "choose" (I-08b, §12.5.1): `token` answered a pending
// sign-in grant instead of a device token, and the SDK holds no token yet. The `choice*` steps
// report `result` "ok" | "refused" (with `code`, the nested error's code); `choiceLicenses`
// adds `state` and `licenses` (the row ids, sorted); `choiceDevices` the device ids in order;
// `choiceComplete` on "ok" adds `licenseId`, `subject`, `tokenHeld` and, after a key,
// `keyEntries` {used, limit}.
//
// ── THE `expect` VOCABULARY ─────────────────────────────────────────────────────────────────
//
//   result          discover: "ok" | "not-found" | "invalid" | "error"
//                   activate / enroll: "ok" | "device-limit" | "unauthorized" |
//                     "fingerprint-required" | "enroll-disabled" | "hardware-mismatch" |
//                     "enroll-claimed" | "license-disabled" | "license-expired" |
//                     "attestation-required" | "rate-limited" | "key-entry-limit" (PX-W9: the
//                     `key_entry_limit` refusal, keyentry-limit.json) | "refused" | "error" — the
//                     `activationResult` enum (conformance/parity/enums.json; SDK-PARITY-PASS
//                     §3.1), mapped from the refusal body's code, never from the status alone.
//                     activate-refusals.json records every one the routes answer today. Two are
//                     reserved and recorded nowhere yet (plans/SP-00.md §8: never faked):
//                     "license-expired" (an expired licence's key is answered 401
//                     `unauthorized` today, so its step expects "unauthorized") and
//                     "attestation-required" (activation and enrolment are not trust
//                     operations, so no attesting product makes them answer it; the step is
//                     dropped)
//                   releaseFetch: "ok" (the payload was fetched, and its size and SHA-256 match
//                     the target's) | "refused" (a 4xx with a registry code: no file is left) |
//                     "error"
//                   downloadModel: "ok"
//                   register: "ok" | "registration-closed" | "rate-limited" | "not-configured" |
//                     "error"
//                   report: true when the server accepted the report
//                   commerceBinding / commerceClaim: "ok", or the wire code the call was refused
//                     with (`forbidden`, `not_entitled`, `bad_request`, `unavailable`, …)
//   services        discover: the capability map afterwards, slug → enabled
//   presentation    discover (HA-12, WIRE-CONTRACT-V4 §5.5): the normalised `core.presentation`
//                   the client exposes afterwards (client-core `parsePresentation`), compared by
//                   value, or null when the document carried none (a client drops what it had)
//   applied / unauthorized / blocked      sync: the SyncResult flags
//   documents       sync: slice → "applied" | "unchanged" | "unauthorized" | "blocked" |
//                   "device-cap" | "error" (only the slices the product runs)
//                   pollSignIn / waitForSignIn: "pending" | "slow-down" | "ready" | "expired" |
//                     "error" | "transient" (waitForSignIn only ever reports "ready", "expired"
//                     and "error"). "transient" (I-37d): no answer or a 5xx, with `code`
//                     "network-error" or "server-error"; the client keeps polling
//                   mintToken: "ok", or the error code the call failed with — the Worker's
//                     wire code ("not_found", "unauthorized", "rate_limited") or a client one
//   prompt          beginSignIn: what the host shows the player — { userCode, verificationUri,
//                   verificationUriComplete, expiresIn, interval, deviceName } (never the device
//                   code). `deviceName` is the label the Worker echoed (PX-W13, §12.7.1), `null`
//                   when it stored none.
//   interval        pollSignIn on "slow-down": the interval the client must now wait (seconds)
//   token / expiresAt   mintToken on "ok": the minted token and its expiry (epoch seconds)
//   bindingId / products   commerceBinding on "ok": the binding UUID (compared case-insensitively)
//                   and the store products, as the Worker listed them
//   reason          commerceClaim / commerceBinding on a refusal: the body's `reason`
//   flag / state / granted   commerceClaim on "ok": the flag, the purchase state, whether granted
//   range           chunkRange: "ok" (the server answered the exact 206 the run needs, or the
//                   206 clipped at the end of the object) | "refused" (any other answer: the
//                   strategy fails, WIRE-CONTRACT-V4 §11.4)
//   bytes           chunkRange on "ok": the returned body, as a string (fewer than `length`
//                   bytes when the 206 was clipped at the end of the object)
//   manageUrl       activate / enroll on "device-limit" (PX-W8) or "key-entry-limit" (PX-W9):
//                   the refusal link the result exposes, exactly as served, or null when the
//                   result carries none
//   keyEntries      activate on "ok" or "key-entry-limit" (PX-W9, WIRE-CONTRACT-V4 §12.2): the
//                   result's key entries {used, limit}, exactly as served, or null when the
//                   result carries none (Identity off)
//                   activate's `license_owned` (I-09, §12.2 step 3) is recorded as "refused" with
//                   its code, what every SDK reports today; I-10a and I-10b make it the typed
//                   result "license-owned" with the body's `signInUrl`
//   attach (I-09, §12.3): result "confirm" (the preview) | "ok" | "refused" (a nested refusal,
//                   with `code`) | "error"; `license` on "confirm": the previewed {id, tierId,
//                   name}; `attached` on "ok": "claimed" when this call put the licence in the
//                   account, else null; `subject` on "ok": the signed-in subject
//   subject (I-09): `subject`, the pairwise subject or null
//   released        signOut (I-09): whether the seat was released (the client then holds no
//                   token)
//   licenseStatus   the gate's status afterwards (client-core `licenseState`)
//   tokenHeld       whether the client holds a device token afterwards
//   code            on a refusal: the wire code the body carried (`{"error":"<code>"}` or
//                   `{"error":{"code":"<code>"}}`), exactly as sent
//   bootOutcome     boot: the stage machine's terminal outcome (`vocabulary.outcomes` in
//                   conformance/corpus/v2/stage-matrix.json: "ready", "blocked", "offline", …)
//   size / sha256   releaseFetch on "ok": the payload's byte count and lowercase hex SHA-256,
//                   as the client verified them (the whole file, a resumed one included)
//   platforms       downloadModel: the model's platform groups, by platform id, in its order
//   current         downloadModel: the model's group for `initial.platform` (or null), by value
//   updatesPending  report: how many journalled update events the client still holds after
//                   the step (a 200 drops the ones it delivered)
//
// updateDecide (P3-03, plans/P3-01.md §2.5) — `client.update.decide({channel})` returns an
// `UpdateCheck`, and every member is asserted:
//   channel         the canonical channel: the `channel` claim of the feed the decision used
//   feed            "network" (the fetched copy was committed, or equals the committed one) |
//                   "committed" (the decision used the earlier copy)
//   record          "network" | "cache" | "none"
//   errors          [{code, detail}] in the order the steps raised them (`feed-rollback`, …)
//   decision        the `UpdateDecision`, compared by value (update-matrix.json's shape)
//
// `initial.update` (only on updateDecide transcripts) is the update client's state:
//   pinnedReleaseKeys  kid → raw Ed25519 release key (base64url), compiled into the app
//   outlet             the host's outlet {id, kind}
//   platform, arch     the device
//   installed          the InstalledBuild the host reports (version, buildNumber, format, engine)
//   methods            the host's binary methods
//   cache              {feeds: canonical channel → compact JWS, releaseRecords: sha256 → JWS},
//                      what the client's store holds before the first step
//
// Every key present is asserted; an absent key is not.
//
// `initial.platform` (downloadModel, releaseFetch) is the device's canonical platform
// (WIRE-CONTRACT-V3 §5.2): what `current` is chosen by.
//
// `initial.updateJournal` (telemetry.updates) is the update journal (P6-03) the client holds
// before the first step: the queued events, oldest first, in the report's `updates` shape. A
// report carries at most 16 of them, oldest first (`core/updateHealth.ts` `MAX_UPDATE_EVENTS`),
// and drops the ones a 200 delivered.
//
// Step `args` per action: activate { key }; attach { confirm }; sync { force }; beginSignIn { deviceName? };
// mintToken { recipeId }; updateDecide { channel } (the REQUESTED name, which may be an alias);
// commerceClaim { store, payload } (payload: the store's own fields, sent beside `store`). pollSignIn and waitForSignIn act on the prompt the transcript's last
// beginSignIn returned. boot {} and downloadModel {} take none.
//
// boot (SP-00, `ui.boot`) — the SDK's one-call boot (Godot `PolarisKey.boot()`, the
// client-core stage machine): every request the stages make — discovery, the keyless
// registration where the policy is open and no token is held, and the sync pass — then the
// machine's terminal outcome.
//
// releaseFetch (SP-00, `release.fetch`) — `{ version, platform, arch, build, size, sha256,
// partial? }`: the target is a verified release record's build entry for the device's platform
// and arch (its build id, and the payload size and SHA-256 the record pins). The SDK expands
// discovery's `distribution.endpoints.builds` template with `{selector}` = `version` and
// `{buildId}` = `build`, streams it with the device bearer and the metadata headers, and checks
// size and SHA-256 before it reports "ok". `partial` (resume): the replayer seeds a partial
// download holding the payload's first `partial` bytes, and the SDK sends
// `Range: bytes=<partial>-` with `If-Range: "<sha256>"`.
//
// downloadModel (SP-00, `release.distribution`) — the public GET of
// `/<p>/distribution/download.json` (`distribution.downloadModel()`).
//
// cloudSyncPull / cloudSyncPush (U-05.16, WIRE-CONTRACT-V4 §13.3, §13.4) — the Cloud Sync settings
// calls of the `cloudsync-*` transcripts, replayed only by an SDK that marks `sync.settings`
// implemented. `cloudSyncPull { cursor }` is `GET /<p>/sync?cursor=<n>` (the cursor is always
// sent; `If-None-Match` carries the last ETag). `cloudSyncPush { cursor, atomic, mutations }`
// (the mutation COUNT) is `POST /<p>/sync/ops`; its body is asserted by shape, since the
// `clientId`, mutation ids and clocks are the client's own state. `expect`: `result` "ok" |
// "not-modified" | "refused" (with `status` and `code`); on "ok" `cursor`, `more`, `empty` and
// `settings` (the changed setting keys, sorted); a push adds `lastMutationId` and `results`, one
// label per mutation: "ok" | "duplicate" | "conflict" | "aborted" | "ok:renamedTo:<key>" |
// "ok:dropped" | "rejected:<code>" ("rejected:quota_exceeded:<scope>"). A refusal adds `retryAfter`
// (seconds) when the Worker sent `Retry-After`; some steps add `quotaBytes`, `files` and
// `aliases`. U-05.16 pins the request loosely on purpose (a pull always sends `?cursor=N`, a push
// body is held to its shape); U-06 may tighten both. The CORS exchanges of `cloudsync-cors` are
// `browser` steps and record the `access-control-*` response headers they carry.
//
// exchange (I-13.7, WIRE-CONTRACT-V5 §12.11.2, §12.11.3, `identity.exchange`) — the platform
// sign-in as one SDK call: `POST …/identity/nonce` with the device's keys (unless `args.nonce`
// holds one the client fetched earlier), the platform's ID token for that nonce, then the
// RFC 8693 grant at `…/identity/token` with the `exchange` proof. `args`: `kind`
// ("google" | "apple"), `keyLabel`, `subjectToken` (what the platform's provider returns for the
// nonce; the replaying client's provider stub hands it back, the token is never built from the
// nonce here) and the optional `nonce`. The device keys are fixtures derived from `keyLabel`: the
// Ed25519 signing key's seed is SHA-256(label), the agreement key is SHA-256(label + ":agree")
// with the top bit of its last byte clear; `pkey-proof/1` lines are joined by LF (§12.11.1) and
// the signature is base64url, all of which the recorded request bodies pin exactly. `expect`:
//   result          "ok" (a device token; then `tokenHeld`, `scope`, `issuedTokenType`,
//                   `licenseId` or null) | "confirm" (`firstTime`, `changed`, `as`: the consent
//                   view the SDK shows) | "choose" | "interstitial-required" (`reason`, `url`,
//                   `linkHandle`, `expiresIn`, `tokenHeld` false) | "refused" (`code`: the
//                   refusal's wire code, `tokenHeld` false; the SDK throws a typed error) |
//                   "unavailable" (`tokenHeld` false: the rung is not there. Either the client
//                   sends nothing, a step with no exchanges, because the last discovery names no
//                   `exchange` member (§12.11.6), or a 404 answers the nonce or token route, the
//                   Worker having rolled the launch gate back after discovery)
// A `confirm` or `choose` answer is completed by a `choiceComplete` step whose body (the
// consent, the choice) is the one the recording sent; its `expect` is an exchange `ok`.
// A `discover` step in these transcripts also pins `exchange` (the fragment's member or null)
// and `nonceEndpoint` (whether the identity endpoints name `nonce`).
// linkOffer / link (I-43.3, WIRE-CONTRACT-V5 §12.11.4, `identity.link`) — the link offer after a
// same-device sign-in, both calls with the device token as the bearer. `linkOffer` is
// `GET …/identity/link`; `expect`: `result` "ok" and `offer`, the [{kind, reach}] the answer
// lists (reach null; an empty list while no step-up is live). `link` is `POST …/identity/link`
// with the body {linkHandle, proof}: `args.linkHandle` is a handle an `exchange` step answered,
// `args.keyLabel` names the fixture device keys (see `exchange`) and `args.proofValue`, when
// present, is the value the proof covers instead of the handle (a proof that is not the
// handle's). The proof is `pkey-proof/1` with purpose `link`, the handle as value and `-` as the
// token hash. `expect`: `result` "ok" with `linked` {kind, reach} ("global" | "developer"), or
// "refused" with `status` and `code` (`step_up_required`, `link_conflict`, `not_found`,
// `invalid_grant`). A transcript whose feature is `identity.link` is replayed only by an SDK
// that marks it implemented.
// keyringGet / keyringCreate / keyringWrap / keyringUnwrap / keyringRecoverySet /
// keyringRecoveryGet / keyringAdopt / keyringReset (U-36.4, WIRE-CONTRACT-V5 §13.11.2) — the
// `keyring-*` calls, replayed only by an SDK that marks `sync.keyring` implemented. They are
// `GET|POST /<p>/devices/keyring`, `PUT|DELETE .../wraps/<deviceId>` (`args.deviceId`),
// `PUT|GET .../recovery`, `POST .../adopt` and `POST .../reset`. Every key, wrap and blob is an
// opaque fixture derived from a label, so bodies are asserted by shape. `expect`: `result` "ok" |
// "refused" (with `status`, `code` and, on a 429, `retryAfter`); keyringGet adds `ring` (null, or
// {ringId, epoch, rootKid, state, recoverySet, previous (the ring id or null), adopted (ring
// ids)}) and `wrap` (null, or {epoch, kid, by}); keyringCreate and keyringReset add `ringId` and
// `epoch`; keyringRecoveryGet adds `ct`.
//
// relayTicket (CC-07.3, WIRE-CONTRACT-V5 §15.7) — `POST /<p>/connect/relay/ticket`, replayed only by
// an SDK that marks `connect.relay` implemented. `expect`: `result` "ok" (with `protocol`
// "pkey-relay.1", `url` and `expiresIn` seconds) | "refused" (with `status`, `code` and, on a 429,
// `scope` "person" | "product"; on a 503, `retryAfter`). The ticket value is random and never
// asserted beyond its `pkeyrt_` shape.
//
// connectIdentity / connectDevices (CC-06.4, WIRE-CONTRACT-V5 §15.2 to §15.4, §15.9) — the SDK's
// Cloud Connect identity (`client.connect.identity()` and `.listDevices()`), replayed only by an SDK
// that marks `connect.identity` implemented. The transcript opens with a `discover` step, because a
// client sends nothing to a product whose discovery names no `connect` service. `args`:
// `keyLabel` (the device's fixture keys, see below) and, on connectIdentity, `refresh`. The device
// keys are a fixture derived from the label (`providers.ts` `fixtureDeviceKeys`): the Ed25519 signing
// key is seeded by SHA-256(label), the agreement key's 32 bytes are SHA-256(label + ":agree") with
// the top bit of the last byte clear, so the `PUT /<p>/devices/keys` the client sends first (a
// `keys` proof, no token) is the recorded bytes at the step's clock. A step whose `keyLabel`
// differs from the one before it is a key rotation: the replayer hands the client the new keys. A
// step may record a `PUT /<p>/devices/keys` after a refused GET (the Worker forgot the keys: the
// client registers once more and asks again).
//   connectIdentity `expect`: `result` "ok" | "refused" (with `code`, the wire code the Worker
//     answered, as a refusal) | "unavailable" (the client refused to send: discovery names no
//     Cloud Connect). On "ok": `epoch`, `devices` (the roster's device ids, in order), `deviceId`
//     (the certificate's) and `discKeys` (1, or 2 while the previous K_disc is held). The keys
//     themselves are never in `expect`.
//   connectDevices `expect`: `result` "ok" with `devices`, the answer's list by value
//     ({deviceId, label, platform, lastSeen, self}), or "refused" with `code`.
//
// nearbyStart / nearbyApprove / nearbyPoll (I-40.8, WIRE-CONTRACT-V5 §12.11.5, `identity.nearby`) — the
// nearby approval of the `nearby-*` transcripts, replayed only by an SDK that marks `identity.nearby`
// implemented. TWO devices take part: D (the transcript's own device, `initial.deviceId`) calls
// `nearbyStart` (`POST …/identity/nearby/start`) and `nearbyPoll` (`POST …/identity/nearby/poll`); M, a
// signed-in device nearby, calls `nearbyApprove` (`POST …/identity/nearby/approve`). A replayer plays
// both, or the one its role is. Every key is a fixture derived from a label (see `exchange`), every
// request carries a `pkey-proof/1` proof (§12.11.1) with line 6 `-`, and the bodies are asserted
// EXACTLY, so a replayer's proof must be the recorded bytes: the purpose is `nearby-start` (value
// `<signKey>.<agreeKey>`), `nearby-approve` or `nearby-poll` (value the request handle), the device
// is the one that signs. The request handle (`nr_…`) is the Worker's answer to start, served as
// recorded, and appears literally in the later bodies.
//   nearbyStart   args: `keyLabel` (D's keys), `deviceName`? (sent as given), `proofKeyLabel`?
//                 (sign the proof with these keys instead: a proof that is not the body's).
//                 expect: result "ok" (`expiresIn`, `interval`) | "refused" (`status`, `code`) |
//                 "unavailable" (the client sends nothing, a step with no exchanges, because the last
//                 discovery names no `nearby` member; or a 404 answers: the gate went off).
//   nearbyApprove args: `approverDeviceId`, `approverToken` (M's id and device token, bound to
//                 `{approverDeviceId}` and `Bearer {approverToken}` in the request's headers: M is not
//                 the transcript's device), `approverKeyLabel` (M's keys), `keyLabel` (D's keys, the
//                 body's `signKey` and `agreeKey`), `decision` ("approve" | "deny"), `choice`? (the
//                 body's), `request`? (the handle to approve, else the one `nearbyStart` answered),
//                 `proofKeyLabel`? and `proofValue`? (a proof by other keys, or over another value),
//                 `agreeKeyLabel`? (send another label's agreement key). expect: result "approved"
//                 (`deviceLabel`, string or null) | "choose" (`choices`, the answer's list by value) |
//                 "denied" (the 204) | "refused" (`status`, `code`) | "unavailable".
//   nearbyPoll    args: `keyLabel` (D's keys), `request`? (else the one `nearbyStart` answered),
//                 `proofKeyLabel`?. expect: result "pending" | "slow-down" (`interval`) | "timeout" |
//                 "error" (`reason`, "access_denied") | "ready" (`tokenHeld` true, `scope`; the
//                 token response binds `{token}`) | "refused" (`status`, `code`) |
//                 "unavailable". The poll interval is 3 seconds: a poll inside it is "slow-down", and the
//                 steps' `now` are the recorder's clock, so a replayer moves its clock to each step.
//   Q13: the Worker decides proximity from the client network, which a replayer cannot choose.
//   Each exchange records the `clientIp` it was sent from; a replayer neither sends nor matches it.
//   `not_nearby` is served as recorded.
//
// chunkRange (P4-32, plans/P4-32.md §4) — `{ bundle, offset, length }`: the SDK's chunk-range
// fetch (client-core `chunkRangeFetch`, Python `chunk_range_fetch`, Swift `chunkRangeFetch`,
// Kotlin `chunkRangeFetch`, Godot `PKeyPackChunks.chunk_range_fetch`) of `length` bytes at
// `offset` from the bundle whose SHA-256 is `bundle` (hex), over the SDK's own pack-object
// transport, against the blobs template the transcript's last discover returned. It sends
// `Range: bytes=<offset>-<offset+length-1>` and `If-Range: "<bundle>"`. A step whose `if-range`
// is in `requiredHeaders` instead of `headers` records the server's answer to a STALE validator
// (the recorder sent one no SDK can, the blobs URL being content-addressed): the replay proves
// the SDK refuses a 200 to its own If-Range.

export const TRANSCRIPT_VERSION = 1;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type BodyMatch = "exact" | "subset" | "shape";

export interface RequestBody {
  json: JsonValue;
  match: BodyMatch;
  allowedKeys?: string[];
}

export interface RecordedRequest {
  method: string;
  /** Path and query, e.g. `/djdl/license/document`. */
  path: string;
  /** Asserted by value; `{name}` placeholders allowed. Lowercased names. */
  headers: Record<string, string>;
  /** Asserted by presence. Lowercased names. */
  requiredHeaders: string[];
  body: RequestBody | null;
}

export interface RecordedResponse {
  status: number;
  /** Only the headers a client reads (`RECORDED_RESPONSE_HEADERS`), lowercased. */
  headers: Record<string, string>;
  body: string | JsonValue;
}

export interface Exchange {
  request: RecordedRequest;
  response: RecordedResponse;
  /** Bind a value from the JSON response for later steps: name → `$.path.to.member`. */
  capture?: Record<string, string>;
  /**
   * Q13 (I-40.8): the client network the recorder sent the request from. Informational: a
   * replayer neither sends nor matches it, so `not_nearby` is the recorded answer a fake server
   * serves, not a proximity check the replay makes.
   */
  clientIp?: string;
}

export type Action =
  | "discover"
  | "sync"
  | "activate"
  | "enroll"
  | "register"
  | "deactivate"
  | "report"
  | "fetchSchema"
  | "changelog"
  | "installUrl"
  | "downloadUrl"
  | "beginSignIn"
  | "pollSignIn"
  | "waitForSignIn"
  | "mintToken"
  /** P3-03: `client.update.decide({channel})` — the signed feed, the pinned record, the decision. */
  | "updateDecide"
  /** P6-01: `client.commerce.getBinding()` — the licence's purchase binding and the products. */
  | "commerceBinding"
  /** P6-01: `client.commerce.claim(store, payload)` — a store purchase as a licence flag. */
  | "commerceClaim"
  /** P4-32: one chunk-bundle Range + If-Range fetch (WIRE-CONTRACT-V4 §11.4). */
  | "chunkRange"
  /** SP-00: the one-call boot, to the stage machine's terminal outcome (`ui.boot`). */
  | "boot"
  /** SP-00: one verified build download, resumable (`release.fetch`). */
  | "releaseFetch"
  /** SP-00: `distribution.downloadModel()` (`release.distribution`). */
  | "downloadModel"
  /** I-09: `identity.attach({confirm})` (`identity.attach`, WIRE-CONTRACT-V4 §12.3). */
  | "attach"
  /** I-09: `identity.subject()` (`identity.account`). */
  | "subject"
  /** I-09: `identity.signOut()` (`identity.account`). */
  | "signOut"
  /**
   * I-08 (WIRE-CONTRACT-V4 §12.4): the BROWSER's half of a redirect sign-in — the navigation to
   * `authorize`, the card's Continue — requests the SDK never makes. Recorded so a replayer's
   * fake server can serve the whole conversation; no SDK asserts them. Their requests carry no
   * metadata headers and may carry cookies the recorder chose (not asserted).
   */
  | "browser"
  /**
   * I-08 (§12.5): the SDK's `redirect.complete({callbackUrl})` — the code in the callback URL
   * redeemed at `token` with the PKCE verifier the SDK kept. `args.codeVerifier` is the verifier
   * the replayer feeds the SDK so the request is reproducible.
   */
  | "redirectComplete"
  /**
   * I-08b (§12.5.1): `choice.licenses(grant)`, `choice.devices(grant, licenseId)`,
   * `choice.complete(grant, choice)` and `choice.cancel(grant)` (`identity.choice`). `args.grant`
   * is the grant the exchange answered (and `args.licenseId` for `choiceDevices`).
   */
  | "choiceLicenses"
  | "choiceDevices"
  | "choiceComplete"
  | "choiceCancel"
  /** U-05.16 (WIRE-CONTRACT-V4 §13.4): the Cloud Sync pull, `GET /<p>/sync?cursor=<n>`. */
  | "cloudSyncPull"
  /** U-05.16 (§13.3): the Cloud Sync push, `POST /<p>/sync/ops`. */
  | "cloudSyncPush"
  /** I-13.7 (WIRE-CONTRACT-V5 §12.11.3): the native-token exchange, nonce then grant. */
  | "exchange"
  /** I-43.3 (WIRE-CONTRACT-V5 §12.11.4): `GET …/identity/link`, the link offer (`identity.link`). */
  | "linkOffer"
  /** I-43.3 (§12.11.4): `POST …/identity/link` with a link handle (`identity.link`). */
  | "link"
  /** U-36.4 (WIRE-CONTRACT-V5 §13.11.2): the key ring calls of the `keyring-*` transcripts. */
  | "keyringGet"
  | "keyringCreate"
  | "keyringWrap"
  | "keyringUnwrap"
  | "keyringRecoverySet"
  | "keyringRecoveryGet"
  | "keyringAdopt"
  | "keyringReset"
  /** CC-07.3 (WIRE-CONTRACT-V5 §15.7): the Cloud Connect relay ticket of the `connect-relay-*` transcripts. */
  | "relayTicket"
  /** CC-06.4 (WIRE-CONTRACT-V5 §15.2 to §15.4): the Cloud Connect identity of the `connect-identity*` transcripts. */
  | "connectIdentity"
  | "connectDevices"
  /** I-40.8 (WIRE-CONTRACT-V5 §12.11.5): the nearby approval calls of the `nearby-*` transcripts. */
  | "nearbyStart"
  | "nearbyApprove"
  | "nearbyPoll";

export interface Step {
  action: Action;
  /** What the step is about, for a human reading the file. Not asserted. */
  note?: string;
  args: Record<string, JsonValue>;
  /** The client clock (epoch seconds) for this step; absent ⇒ the transcript's `now`. */
  now?: number;
  exchanges: { ordered: boolean; items: Exchange[] };
  expect: Record<string, JsonValue>;
}

export interface Transcript {
  transcriptVersion: typeof TRANSCRIPT_VERSION;
  id: string;
  description: string;
  /** Registry feature ids (conformance/parity/features.json) this conversation PROVES. An SDK
   *  replays the transcript only when its parity.json marks every one of them `implemented`. */
  features: string[];
  /** Registry feature ids the conversation PRESUPPOSES. An SDK whose manifest marks any of
   *  them `na` never has this conversation, so it does not replay it. */
  requires: string[];
  product: string;
  baseUrl: string;
  now: number;
  /** The pinned trust set: kid → raw Ed25519 public key (base64url). */
  trust: Record<string, string>;
  initial: {
    deviceId: string;
    token?: string;
    version: string;
    services?: string[];
    /** PX-W13: the platform's device name the SDK's default label comes from; absent = none. */
    deviceName?: string;
    /** P3-03: the update client's state, on `updateDecide` transcripts only. */
    update?: UpdateInitial;
    /** SP-00: the device's canonical platform (downloadModel's `current`, releaseFetch). */
    platform?: string;
    /** SP-00: the journalled update events (P6-03), oldest first (`telemetry.updates`). */
    updateJournal?: JsonValue[];
  };
  steps: Step[];
}

/** The update client's state before the first `updateDecide` step (P3-03). */
export interface UpdateInitial {
  pinnedReleaseKeys: Record<string, string>;
  outlet: { id: string | null; kind: string };
  platform: string;
  arch: string;
  installed: {
    version: string;
    buildNumber: string | null;
    format: string | null;
    engine: string | null;
  };
  methods: string[];
  cache: {
    feeds: Record<string, string>;
    releaseRecords: Record<string, string>;
  };
}

/** The response headers a client acts on. Everything else the Worker sends (HSTS, CSP, CORS,
 *  `vary`) is transport policy, not conversation, and recording it would make every security-
 *  header change a transcript change. */
export const RECORDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-range",
  // I-08: where an `authorize` navigation went (a redirect's target is the conversation).
  "location",
  "content-type",
  "etag",
  "retry-after",
  "www-authenticate",
] as const;

/** The seven `X-PKey-*` metadata headers every device-authenticated product call carries (wire
 *  contract v3 §5). Transcripts assert them by PRESENCE; `x-pkey-device` and `x-pkey-version`
 *  are also asserted by value. The platform and arch VALUES are P1b-04's to pin. */
export const METADATA_HEADERS = [
  "x-pkey-device",
  "x-pkey-version",
  "x-pkey-channel",
  "x-pkey-sdk",
  "x-pkey-sdk-version",
  "x-pkey-platform",
  "x-pkey-arch",
] as const;
