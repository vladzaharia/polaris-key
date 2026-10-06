// The HTTP transcript format, version 1 (P1b-03, PARITY §4.2).
//
// A transcript pins one CONVERSATION between an SDK and the Worker: the requests a client must
// send, in the shape the contract fixes, and the Worker's real answers to them. The Worker's own
// scenario tests (`./scenarios/`) record them through the real router; every SDK replays them
// against a fake server that serves the canned responses and asserts each request.
//
// The files are GENERATED — `conformance/transcripts/<id>.json`, mirrored into the Swift test
// bundle — and drift-checked by `pnpm gen:transcripts -- --check` and by the Worker suite. Never
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
// ── THE `expect` VOCABULARY ─────────────────────────────────────────────────────────────────
//
//   result          discover: "ok" | "not-found" | "invalid" | "error"
//                   activate / enroll: "ok" | "device-limit" | "unauthorized" |
//                     "fingerprint-required" | "enroll-disabled" | "hardware-mismatch" |
//                     "enroll-claimed" | "license-disabled" | "license-expired" |
//                     "attestation-required" | "rate-limited" | "refused" | "error" — the
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
//   applied / unauthorized / blocked      sync: the SyncResult flags
//   documents       sync: slice → "applied" | "unchanged" | "unauthorized" | "blocked" |
//                   "device-cap" | "error" (only the slices the product runs)
//                   pollSignIn / waitForSignIn: "pending" | "slow-down" | "ready" | "expired" |
//                     "error" (waitForSignIn only ever reports the last three)
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
// Step `args` per action: activate { key }; sync { force }; beginSignIn { deviceName? };
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
  | "downloadModel";

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
