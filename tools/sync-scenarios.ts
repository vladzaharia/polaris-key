// `conformance/corpus/v2/sync-scenarios.json`: the Cloud Sync client scenario corpus
// (plans/U-01.md §4.1, Q1, as amended by plans/U-01b.md §4 and its Revision 2; S-17 §5.13;
// WIRE-CONTRACT-V4 §11.5).
//
// HTTP transcripts pin the wire; this file pins what a client does between requests: optimistic
// reads over the journal, the debounce, HLC folding and pre-contact re-stamping, conflict rebase,
// one outstanding compare-and-swap per target, the per-subject partitions, the first-sign-in
// move, sign-out with pending operations, principal changes, `403 account_required` and a `/sync`
// 401. Every push and journal rule of S-17 §5.4 has at least one scenario. Version 2 (U-01b) adds
// the setting routes (synced, local, locked, refused) and open settings, the one-time import of
// the legacy `config.local` store at the HLC floor, record field policies, the other 403s, the
// paused state, the parked quota and entitlement refusals, and `settingCases`: catalog entries
// in, `syncedSettings` routes out.
//
// LITERAL DATA. Unlike the matrices whose expectations a generator-local reference recomputes,
// every expectation here is written out by hand and this module imports NO `client-core`: the
// reference state machine (`@polaris-key/client-core/cloud-sync`) is the first implementation
// checked against it, by `conformance/runners/node/syncScenarios.test.ts`, exactly as every
// other SDK's runner is. The self-check below validates the file's own shape and the invariants
// that hold whatever the implementation: the vocabulary, rule coverage, HLC and clientId
// syntax, and that a client never sends a fresh mutationId at or below one it already sent.
//
// Version 3 (U-35.2; WIRE-CONTRACT-V5 §11.5, §13.10) adds the end-to-end policy. `init` gains
// `encryption` ("server" or "e2e") and `hasRoot` (whether the device holds the ring's root); the
// `root` step gives or takes the root away; `respond` may carry `opened`, what the host codec
// found for each row it opened (the machine never reads sealed/invalid/seq from a body); the
// `encryptionSince` assert reads the partition's boundary. The fake transport still speaks
// plaintext: sealing is the host codec's job, pinned by `sync-vectors.json`. Every v2 scenario
// runs in server mode, with its expectations unchanged.
//
// Version 4 (X-1.1) corrects two scripts and adds one scenario. `e2e-min-server-wins` now answers
// a push whose base version is behind the server's (a matching base is accepted by the register,
// §13.10.5); `server-mode-unchanged`'s conflict copy carries the `editedHlc` a real server always
// sends; `e2e-conflict-plaintext-copy-refused` pins that a conflict's plaintext server copy is
// judged against the cursor the push carried.
//
// Version 5 (U-08; WIRE-CONTRACT-V5 §11.5 "Conflicts", plans/U-08.md §2, §5) is the conflict
// vocabulary. A `revision` record's plain `put` that meets a conflict opens a MergeRequest the
// person or the app decides; nothing is lost and nothing is enqueued until `keep`. The `keep` step
// answers one (`{request, choice}` and, when refused at once with `bad_request` or
// `sync-merge-closed`, an `expect` of `{ok: false, error}`; choice `local`, `remote`, `both` or `{value}`), the `delete`
// call is the collection's default delete (based on the request's local version while one is
// open), the asserts `conflicts` (the exact open list, each `{id, cause, collection, record,
// local, remote, choices, state, error}`, a side `{value, version, savedAt, device, file}`;
// `newer` is display only and not asserted) and `cloudEmpty` read the new views, and the events
// are `{type: "conflict", id, cause, collection, record}` and `{type: "conflictClosed", id, how}`.
// `status` gains `conflicts`, the open count, present only above 0. A request alone is not a
// pending operation: `pending` counts the journal. `resolve` on a collection is the scenario host's
// inline decider (`keepLocal` or `keepRemote`): an answer given synchronously, so no request is
// listed and no event fires. The new scenarios use CONFLICT_CATALOG, which declares no `resolve`.
// Every v4 row and expectation is unchanged.
//
// Append-only: a scenario's expectations never change under the same `syncScenariosVersion`;
// a vocabulary or expectation change bumps it.

export const SYNC_SCENARIOS_VERSION = 5;

type J = null | boolean | number | string | J[] | { [k: string]: J };
type Obj = { [k: string]: J };

// ── vocabulary ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  "local",
  "advance",
  "network",
  "respond",
  "signIn",
  "signOut",
  "relaunch",
  "root",
  "keep",
  "assert",
] as const;

const CALLS = [
  "set",
  "clear",
  "put",
  "add",
  "remove",
  "flush",
  "refresh",
  "delete",
] as const;

const ASSERTS = [
  "values",
  "states",
  "records",
  "journal",
  "requests",
  "events",
  "status",
  "licence",
  "encryptionSince",
  "conflicts",
  "cloudEmpty",
] as const;

/** Every rule a scenario can pin. S-17 §5.4 push and journal rules 1–8 first. */
const RULES: { id: string; title: string; ref: string }[] = [
  {
    id: "push-1-last-mutation-id",
    title:
      "Every processed result removes its mutation; a request-level failure leaves the journal unchanged",
    ref: "S-17 §5.4 rule 1; plans/U-01.md §2.3",
  },
  {
    id: "push-2-conflict-new-mutation",
    title:
      "A conflict is resolved as a new mutation on the server's version; the conflicting one is never resent",
    ref: "S-17 §5.4 rule 2; plans/U-01.md §2.3 (Q6)",
  },
  {
    id: "push-3-one-outstanding-cas",
    title:
      "At most one unacknowledged revision mutation per record; later edits are held and rebased",
    ref: "S-17 §5.4 rule 3",
  },
  {
    id: "push-4-client-id",
    title:
      "A lost journal or client_mismatch gives a new clientId whose mutationIds restart at 1",
    ref: "S-17 §5.4 rule 4",
  },
  {
    id: "push-5-sign-out-pending",
    title:
      "Sign-out flushes up to 5 s, reports what stayed unsynced and keeps it in that subject's partition for 30 days",
    ref: "S-17 §5.4 rule 5",
  },
  {
    id: "push-6-renamed-dropped",
    title:
      "renamedTo and dropped are ok results; reads resolve old names through the pull's aliases",
    ref: "S-17 §5.4 rule 6",
  },
  {
    id: "push-7-cursor-expired",
    title:
      "cursor_expired keeps the journal, takes a full snapshot and pushes the pending operations unchanged",
    ref: "S-17 §5.4 rule 7",
  },
  {
    id: "push-8-clocks",
    title: "The HLC's physical part is local time plus the last server offset",
    ref: "S-17 §5.4 rule 8",
  },
  {
    id: "pre-contact-restamp",
    title:
      "Edits stamped before the first server contact are re-stamped when the offset exceeds 5 minutes",
    ref: "S-17 §5.5 (clocks that run slow)",
  },
  {
    id: "optimistic-read",
    title: "Reads are the server snapshot plus pending operations",
    ref: "S-17 §5.4 (journal behaviour)",
  },
  {
    id: "debounce",
    title: "Writes are debounced per key, so a slider drag is one mutation",
    ref: "S-17 §5.4 (journal behaviour)",
  },
  {
    id: "partition",
    title:
      "Journal and snapshot are partitioned by subject; nothing written as one subject is sent as another",
    ref: "S-17 §5.4 (journal behaviour), rule 5",
  },
  {
    id: "first-sign-in",
    title:
      "Local-partition settings move into the subject's journal at sign-in; losers report origin merge",
    ref: "S-17 §5.5 (settings at first sign-in)",
  },
  {
    id: "account-required",
    title:
      "403 account_required leaves licence state untouched, keeps values local and offers sign-in",
    ref: "plans/U-01.md §2.1; S-17 §5.4",
  },
  {
    id: "principal-change",
    title:
      "A relink that clears the binding or a merge alias is handled exactly like sign-out",
    ref: "plans/U-01.md §2.4",
  },
  {
    id: "unauthorized-pauses",
    title:
      "A /sync 401 pauses Cloud Sync until the next document fetch and never touches licence state",
    ref: "plans/U-01.md §2.1",
  },
  {
    id: "locked-key",
    title:
      "A set on an enforced or hidden key is refused locally with managed_by_admin and journals nothing",
    ref: "plans/U-01b.md §2.5, D8; S-17 §5.5",
  },
  {
    id: "invalid-value",
    title:
      "An invalid stored value is kept, marked invalid and falls through to the next layer",
    ref: "S-17 §5.6",
  },
  {
    id: "member-merge",
    title:
      "A merge key sends one member op per changed member, never a whole set",
    ref: "S-17 §5.4 (operations), §5.5",
  },
  {
    id: "union-set",
    title:
      "A union record sends add and remove with observedSeq; a concurrent add survives",
    ref: "S-17 §5.5 (observed-remove set)",
  },
  {
    id: "relaunch",
    title:
      "The journal survives a relaunch, debounced edits are committed on exit, and start pushes them",
    ref: "S-17 §5.4 (journal flushes)",
  },
  // Version 2 (plans/U-01b.md §4 and Revision 2).
  {
    id: "open-settings",
    title:
      "A key the catalog does not declare is an open setting: user scope, lastWrite, schema-less, at most 8 KiB of canonical JSON",
    ref: "plans/U-01b.md D3, §2.5",
  },
  {
    id: "setting-routes",
    title:
      "A synced key is pushed with its route's scope; a local key stays on the device and never moves; a locked key is managed_by_admin; a secret, a flag or an invalid value is bad_request",
    ref: "plans/U-01b.md §2.5, D8",
  },
  {
    id: "local-import",
    title:
      "The legacy config.local store is imported once at the HLC floor, so any newer cloud value wins",
    ref: "plans/U-01b.md §2.5 (Import)",
  },
  {
    id: "record-merge-fields",
    title:
      "A merge record sends one setField or removeField per changed field, never a whole value; another device's field arrives in the pull",
    ref: "WIRE-CONTRACT-V5 §13.3 (U-09.11)",
  },
  {
    id: "record-field-policy",
    title:
      "A lastWrite, max or min record is a stamped set the server resolves; on conflict the client takes the server copy and enqueues nothing",
    ref: "plans/U-01b.md D4, §2.2",
  },
  {
    id: "forbidden-blocks",
    title:
      "403 attestation_required blocks with reason attestation and any other 403 but account_required with reason forbidden; both keep the journal and wait for refresh",
    ref: "plans/U-01b.md §2.5 (403)",
  },
  {
    id: "writes-paused",
    title:
      "503 writes_paused on a push keeps the journal and shows paused, never blocked; the next trigger retries and a 200 push clears it",
    ref: "plans/U-01b.md R4; WIRE-CONTRACT-V4 §13.9",
  },
  {
    id: "parked-rejection",
    title:
      "quota_exceeded and entitlement_required park a setting edit on the device, still read and never lost, until more room or a sign-in re-sends it as a new mutation with its clock; every other rejection reverts",
    ref: "plans/U-01b.md R5",
  },
  {
    id: "quota-never-deletes",
    title:
      "A quota below the person's usage removes nothing, and a clear still passes",
    ref: "plans/U-01b.md R4 rule 5; WIRE-CONTRACT-V4 §13.1",
  },
  // Version 3 (U-35.2).
  {
    id: "e2e-client-policy",
    title:
      "In E2E mode a max or min key is a compare-and-swap on the version seen; on conflict the client keeps the better value, re-pushes it on the server's version with origin merge when it is its own, and never prompts. A merge key stays per-member on the server",
    ref: "WIRE-CONTRACT-V5 §13.10.5; plans/CC-01-cloud-sync.md §1.6",
  },
  {
    id: "e2e-locked",
    title:
      "With no root for the ring the machine is locked: nothing is pushed or pulled, the journal is kept, edits read in the clear, and unlocking pulls first, then pushes in mutationId order",
    ref: "WIRE-CONTRACT-V5 §11.5",
  },
  {
    id: "encryption-pinned",
    title:
      "An app that requires E2E (the default) never reads past a Worker that says server or omits the member: the body is dropped unread, the status is unsupported with sync-encryption-pinned, and the journal and snapshot are kept. A server-mode app is unchanged",
    ref: "WIRE-CONTRACT-V5 §11.5, §13.10.6; threat T26",
  },
  {
    id: "forged-plaintext-rows",
    title:
      "A hostile Worker's plaintext row never reads as legacy over data the device holds sealed: a change at or below the request's cursor is ignored (E2E, cursor above 0), a plaintext row is legacy only when the request's cursor is below encryptionSince, and a key this device has ever pushed or opened sealed refuses plaintext for good, across a snapshot reset. A fresh device before any sealed row stays trust-on-first-use (threat T26)",
    ref: "WIRE-CONTRACT-V5 §13.10.7; threat T26",
  },
  {
    id: "encryption-since",
    title:
      "A plaintext row is legacy data only when the host-mapped seq is below encryptionSince, which only ever lowers; otherwise it is invalid. Sealed and invalid come only from the host's open result",
    ref: "WIRE-CONTRACT-V5 §13.10.7",
  },
  // Version 5 (U-08).
  {
    id: "merge-request-open",
    title:
      "A revision record's plain put that meets a conflict opens one MergeRequest per record, with the server copy as remote and the device's copy as local; nothing is enqueued. The request is journalled per subject, survives a relaunch and is never shown to another subject",
    ref: "WIRE-CONTRACT-V5 §11.5; plans/U-08.md §2.3 rules 1, 7",
  },
  {
    id: "merge-request-freeze",
    title:
      "While a request is open the record reads the local copy, a later plain put replaces it and is not sent, a held edit joins the request, and a delete is based on the local version so it conflicts and the other copy survives",
    ref: "WIRE-CONTRACT-V5 §11.5; plans/U-08.md §2.3 rules 3, 4",
  },
  {
    id: "merge-request-keep",
    title:
      "keep local and keep a value send one set on the remote version, keep remote sends nothing and reads the server copy; the request is applying until the mutation is answered; a decider that answers inline lists nothing; a keep on a closed request is sync-merge-closed",
    ref: "WIRE-CONTRACT-V5 §11.5; plans/U-08.md §2.3 rule 6",
  },
  {
    id: "merge-request-remote",
    title:
      "A pulled change of the record replaces the request's remote and a tombstone makes it null, so keep local then creates the record with a star base",
    ref: "WIRE-CONTRACT-V5 §11.5; plans/U-08.md §2.3 rule 5",
  },
  {
    id: "cloud-empty",
    title:
      "cloudEmpty is true after a cursor-0 answer that says empty, false after one that does not or after any change, and null before any cursor-0 answer",
    ref: "WIRE-CONTRACT-V5 §11.5, §13.4; plans/U-08.md §2.3 rule 8",
  },
];

// ── fixtures ───────────────────────────────────────────────────────────────────────────────

const PRODUCT = "demo";
const T0 = 1_760_000_000_000;
const DAY = 86_400_000;
const SIGN_IN_URL = "https://key.plrs.im/signin?product=demo";

const VOL = "audio.music.volume";
const QUAL = "graphics.quality";
const BIND = "input.bindings";
const BEST = "stats.bestScore";
const THEME = "ui.theme";

// Version 2's keys: a platform-scoped synced key, a local key, a catalog-locked key, a secret, a
// flag, and two keys no catalog declares (open settings).
const PLAT = "input.sensitivity";
const WINDOW = "ui.windowSize";
const REGION = "ops.region";
const TOKEN = "api.token";
const BETA = "beta.newUi";
const OPEN = "mods.lastProfile";
const OPEN2 = "mods.theme";
/** The HLC floor every imported `config.local` value carries (plans/U-01b.md §2.5). */
const FLOOR = "000000000000:0000";

const ALICE = "sub_alice";
const BOB = "sub_bob";
const ZED = "sub_zed";

const hlc = (ms: number, counter = 0): string =>
  `${ms.toString(16).padStart(12, "0")}:${counter.toString(16).padStart(4, "0")}`;
const cid = (n: number): string => `c_${`client${n}`.padStart(22, "0")}`;
const C1 = cid(1);
const C2 = cid(2);

/** A synced route, as `syncedSettings` hands it to the machine (plans/U-01b.md §2.5). */
const synced = (
  key: string,
  policy: string,
  schema: Obj,
  scope = "user",
): Obj => ({ key, route: "synced", scope, policy, schema });

const CATALOG: Obj = {
  settings: [
    synced(VOL, "lastWrite", { type: "number", minimum: 0, maximum: 1 }),
    synced(QUAL, "lastWrite", {
      type: "string",
      enum: ["low", "medium", "high"],
    }),
    synced(BIND, "merge", { type: "object" }),
    synced(BEST, "max", { type: "integer", minimum: 0 }),
    synced(THEME, "lastWrite", { type: "string" }),
  ],
  collections: [
    { name: "progress", policy: "revision", resolve: "keepLocal" },
    { name: "unlocks", policy: "union" },
  ],
};

/** Version 5's catalog: `progress` is a `revision` collection with no inline decider. */
const CONFLICT_CATALOG: Obj = {
  settings: CATALOG.settings!,
  collections: [
    { name: "progress", policy: "revision" },
    { name: "unlocks", policy: "union" },
  ],
};

/** `progress` with the scenario host's inline decider keepRemote (an answer given synchronously). */
const INLINE_REMOTE_CATALOG: Obj = {
  settings: CATALOG.settings!,
  collections: [
    { name: "progress", policy: "revision", resolve: "keepRemote" },
    { name: "unlocks", policy: "union" },
  ],
};

/** Version 2's routed catalog: every route `syncedSettings` derives, and a `max` collection. */
const ROUTED_CATALOG: Obj = {
  settings: [
    ...(CATALOG.settings as Obj[]),
    synced(PLAT, "lastWrite", { type: "number" }, "platform"),
    { key: WINDOW, route: "local" },
    { key: REGION, route: "locked" },
    { key: TOKEN, route: "refused" },
    { key: BETA, route: "refused" },
  ],
  collections: [
    ...(CATALOG.collections as Obj[]),
    { name: "slots", policy: "max", field: "playtime" },
  ],
};

const DOCUMENT: Obj = {
  values: {
    [VOL]: 0.8,
    [QUAL]: "medium",
    [BIND]: { jump: "space", crouch: "ctrl" },
    [BEST]: 0,
    [THEME]: "dark",
  },
  locked: [THEME],
};

const ROUTED_DOCUMENT: Obj = {
  values: {
    ...(DOCUMENT.values as Obj),
    [PLAT]: 1,
    [WINDOW]: "1280x720",
    [REGION]: "eu",
    [BETA]: false,
  },
  locked: DOCUMENT.locked!,
};

const LICENCE: Obj = {
  state: "valid",
  lastSyncUnauthorized: false,
  documents: ["license", "config"],
};

/** The pull's quota (§13.4): the requesting device's resolved `pkey.cloudSync.bytes`. */
const QUOTA: Obj = { bytes: 268435456, files: true };
/** The person's usage, person-wide. The reference ignores both, except to re-send parked edits. */
const USAGE: Obj = { bytes: 0, settings: 0, records: 0, files: 0 };

function init(over: Obj = {}): Obj {
  return {
    catalog: CATALOG,
    document: DOCUMENT,
    journal: null,
    clock: { now: T0, offsetMs: 0, contacted: true },
    subject: ALICE,
    network: "online",
    licence: LICENCE,
    clientIds: [C1, C2],
    options: { onSignOut: "clear" },
    legacyLocal: null,
    encryption: "server",
    hasRoot: true,
    ...over,
  };
}

// Mutations (the wire form; `j` adds the journal-only marks).
const target = (key: string, scope = "user"): Obj => ({ setting: key, scope });
const set = (
  id: number,
  key: string,
  value: J,
  h: string,
  scope = "user",
): Obj => ({
  mutationId: id,
  target: target(key, scope),
  op: "set",
  value,
  editedHlc: h,
});
const clear = (id: number, key: string, h: string): Obj => ({
  mutationId: id,
  target: target(key),
  op: "clear",
  editedHlc: h,
});
const setMember = (
  id: number,
  key: string,
  member: string,
  value: J,
  h: string,
): Obj => ({
  mutationId: id,
  target: target(key),
  op: "setMember",
  member,
  value,
  editedHlc: h,
});
const removeMember = (
  id: number,
  key: string,
  member: string,
  h: string,
): Obj => ({
  mutationId: id,
  target: target(key),
  op: "removeMember",
  member,
  editedHlc: h,
});
const put = (
  id: number,
  collection: string,
  rid: string,
  value: J,
  baseVersion: number | "*",
): Obj => ({
  mutationId: id,
  target: { record: [collection, rid] },
  op: "set",
  value,
  baseVersion,
});
const addEl = (
  id: number,
  collection: string,
  rid: string,
  element: J,
): Obj => ({
  mutationId: id,
  target: { record: [collection, rid] },
  op: "add",
  element,
});
const removeEl = (
  id: number,
  collection: string,
  rid: string,
  element: J,
  observedSeq: number,
): Obj => ({
  mutationId: id,
  target: { record: [collection, rid] },
  op: "remove",
  element,
  observedSeq,
});
/** A `lastWrite`, `max` or `min` record write: a stamped set, no base version (U-01b D4). */
const stamped = (
  id: number,
  collection: string,
  rid: string,
  value: J,
  h: string,
): Obj => ({
  mutationId: id,
  target: { record: [collection, rid] },
  op: "set",
  value,
  editedHlc: h,
});
const setField = (
  id: number,
  collection: string,
  rid: string,
  field: string,
  value: J,
  h: string,
): Obj => ({
  mutationId: id,
  target: { record: [collection, rid] },
  op: "setField",
  field,
  value,
  editedHlc: h,
});
const removeField = (
  id: number,
  collection: string,
  rid: string,
  field: string,
  h: string,
): Obj => ({
  mutationId: id,
  target: { record: [collection, rid] },
  op: "removeField",
  field,
  editedHlc: h,
});
const j = (
  m: Obj,
  marks: { preContact?: true; moved?: true; parked?: string },
): Obj => ({
  ...m,
  ...marks,
});

// Requests.
const pullReq = (cursor: number, clientId: string): Obj => ({
  method: "GET",
  path: `/${PRODUCT}/sync?cursor=${cursor}&clientId=${clientId}`,
});
const pushReq = (clientId: string, cursor: number, mutations: Obj[]): Obj => ({
  method: "POST",
  path: `/${PRODUCT}/sync/ops`,
  body: { clientId, cursor, atomic: false, mutations },
});

// Responses.
const change = (
  key: string,
  value: J,
  version: number,
  h: string,
  scope = "user",
): Obj => ({
  setting: key,
  scope,
  value,
  version,
  editedHlc: h,
  updatedBy: "device",
});
const tombstone = (key: string, version: number, h: string): Obj => ({
  setting: key,
  scope: "user",
  version,
  editedHlc: h,
});
const recChange = (
  collection: string,
  rid: string,
  value: J,
  version: number,
): Obj => ({
  record: [collection, rid],
  value,
  version,
});
interface PullArgs {
  subject?: string;
  serverNow: number;
  cursor: number;
  changes?: Obj[];
  tombstones?: Obj[];
  lastMutationId?: number;
  more?: boolean;
  aliases?: Obj;
  quota?: Obj;
  usage?: Obj;
}
/** §13.4's body. `empty: true` only on a cursor-0 answer with nothing in it. */
const pullBody = (a: PullArgs): Obj => {
  const changes = a.changes ?? [];
  const tombstones = a.tombstones ?? [];
  return {
    subject: a.subject ?? ALICE,
    serverNow: a.serverNow,
    cursor: a.cursor,
    more: a.more ?? false,
    lastMutationId: a.lastMutationId ?? 0,
    catalogVersion: 1,
    aliases: a.aliases ?? {},
    quota: a.quota ?? QUOTA,
    usage: a.usage ?? USAGE,
    ...(a.cursor === 0 && changes.length === 0 && tombstones.length === 0
      ? { empty: true }
      : {}),
    changes,
    tombstones,
  };
};
const pushBody = (a: PullArgs & { results: Obj[] }): Obj => ({
  ...pullBody(a),
  results: a.results,
});
const ok = (id: number, version: number, extra: Obj = {}): Obj => ({
  mutationId: id,
  status: "ok",
  version,
  ...extra,
});
const conflict = (id: number, server: Obj): Obj => ({
  mutationId: id,
  status: "conflict",
  server,
});
const rejected = (id: number, code: string): Obj => ({
  mutationId: id,
  status: "rejected",
  code,
});
const respond = (body: Obj, status = 200, opened?: Obj): Obj => ({
  respond: opened ? { status, body, opened } : { status, body },
});
const errorBody = (code: string, message: string, extra: Obj = {}): Obj => ({
  error: { code, message, ...extra },
});
const ACCOUNT_REQUIRED = errorBody(
  "account_required",
  "Sign in to use Cloud Sync.",
  {
    signInUrl: SIGN_IN_URL,
  },
);

// Steps.
const local = (call: string, args: J[] = [], expect?: Obj): Obj => ({
  local: expect ? { call, args, expect } : { call, args },
});
const advance = (ms: number): Obj => ({ advance: { ms } });
const network = (state: "online" | "offline"): Obj => ({ network: { state } });
const signIn = (subject: string): Obj => ({ signIn: { subject } });
const signOut = (opts: Obj = {}): Obj => ({ signOut: opts });
const assert = (a: Obj): Obj => ({ assert: a });
/** Version 5: answer an open request. `expect` is given only when the keep is refused at once
 *  (`{ok: false, error}`); an accepted keep settles with the transfer, which the asserts after the
 *  next `respond` show. */
const keep = (request: string, choice: J, expect?: Obj): Obj => ({
  keep: expect ? { request, choice, expect } : { request, choice },
});
const PROGRESS_ID = "w:progress/main";
const root = (has: boolean): Obj => ({ root: { has } });
const val = (value: J, from: string): Obj => ({ value, from });
const st = (state: string, pending: number, reason?: string): Obj =>
  reason ? { state, pending, reason } : { state, pending };
const changed = (keys: string[], origin: string): Obj => ({
  type: "change",
  keys,
  origin,
});
const signedOut = (reason: string, unsynced: number): Obj => ({
  type: "signedOut",
  reason,
  unsynced,
});
const unsynced = (count: number): Obj => ({ type: "unsyncedData", count });
// Version 5: MergeRequest views (plans/U-08.md §2.2). A record side has no savedAt, device or file.
const side = (value: J, version: number): Obj => ({
  value,
  version,
  savedAt: null,
  device: null,
  file: null,
});
const mergeReq = (
  collection: string,
  record: string,
  local: Obj | null,
  remote: Obj | null,
  over: Obj = {},
): Obj => ({
  id: `w:${collection}/${record}`,
  cause: "write",
  collection,
  record,
  local,
  remote,
  choices: ["local", "remote", "value"],
  state: "open",
  error: null,
  ...over,
});
const conflictEv = (collection: string, record: string): Obj => ({
  type: "conflict",
  id: `w:${collection}/${record}`,
  cause: "write",
  collection,
  record,
});
const closedEv = (collection: string, record: string, how: string): Obj => ({
  type: "conflictClosed",
  id: `w:${collection}/${record}`,
  how,
});
/** A status with open requests (`conflicts` is present only above 0). */
const stc = (state: string, pending: number, conflicts: number): Obj => ({
  state,
  pending,
  conflicts,
});
const partition = (
  clientId: string,
  nextMutationId: number,
  cursor: number,
  pending: Obj[],
  held?: Obj,
): Obj => ({
  clientId,
  nextMutationId,
  cursor,
  pending,
  ...(held ? { held } : {}),
});

/** The start-up pull every signed-in, contacted scenario begins with. */
function started(cursor: number, changes: Obj[] = [], clientId = C1): Obj[] {
  return [
    assert({ requests: [pullReq(0, clientId)], status: st("syncing", 0) }),
    respond(pullBody({ serverNow: T0, cursor, changes })),
  ];
}

interface Scenario {
  name: string;
  description: string;
  rules: string[];
  wp: string;
  init: Obj;
  steps: Obj[];
}

// ── scenarios ──────────────────────────────────────────────────────────────────────────────

function scenarios(): Scenario[] {
  const s: Scenario[] = [];
  const add = (sc: Omit<Scenario, "wp">): void => {
    s.push({ ...sc, wp: "U-18" });
  };
  const addV2 = (sc: Omit<Scenario, "wp">): void => {
    s.push({ ...sc, wp: "U-01b" });
  };
  const add3 = (sc: Omit<Scenario, "wp">): void => {
    s.push({ ...sc, wp: "U-35.2" });
  };

  add({
    name: "optimistic-read-pending",
    description:
      "A pending set is read at once over the cloud snapshot, and the read moves to the cloud when it is acknowledged.",
    rules: ["optimistic-read", "push-1-last-mutation-id"],
    init: init(),
    steps: [
      ...started(5, [change(VOL, 0.5, 3, hlc(T0 - 1000))]),
      assert({
        values: { [VOL]: val(0.5, "cloud") },
        events: [changed([VOL], "remote")],
        status: st("idle", 0),
      }),
      local("set", [VOL, 0.6], { ok: true }),
      assert({
        values: { [VOL]: val(0.6, "pending") },
        states: { [VOL]: { sync: "pending", invalid: false, locked: false } },
        events: [changed([VOL], "local")],
        requests: [],
        status: st("pending", 1),
      }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 5, [set(1, VOL, 0.6, hlc(T0))])],
        journal: { [ALICE]: partition(C1, 2, 5, [set(1, VOL, 0.6, hlc(T0))]) },
        values: { [VOL]: val(0.6, "pending") },
        status: st("syncing", 1),
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 6,
          lastMutationId: 1,
          results: [ok(1, 4)],
          changes: [change(VOL, 0.6, 4, hlc(T0))],
        }),
      ),
      assert({
        values: { [VOL]: val(0.6, "cloud") },
        states: { [VOL]: { sync: "synced", invalid: false, locked: false } },
        journal: { [ALICE]: partition(C1, 2, 6, []) },
        events: [],
        requests: [],
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "max-policy-optimistic",
    description:
      "A pending set on a max key reads as the larger of the snapshot and the pending value.",
    rules: ["optimistic-read"],
    init: init(),
    steps: [
      ...started(2, [change(BEST, 120, 2, hlc(T0 - 1000))]),
      local("set", [BEST, 100], { ok: true }),
      assert({
        values: { [BEST]: val(120, "pending") },
        events: [changed([BEST], "remote")],
      }),
      local("set", [BEST, 150], { ok: true }),
      assert({
        values: { [BEST]: val(150, "pending") },
        events: [changed([BEST], "local")],
      }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 2, [set(1, BEST, 150, hlc(T0, 1))])],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 3,
          lastMutationId: 1,
          results: [ok(1, 3)],
          changes: [change(BEST, 150, 3, hlc(T0, 1))],
        }),
      ),
      assert({ values: { [BEST]: val(150, "cloud") }, status: st("idle", 0) }),
    ],
  });

  add({
    name: "debounce-slider",
    description:
      "Three sets inside the debounce window become one mutation carrying the last value and the last edit's clock.",
    rules: ["debounce"],
    init: init(),
    steps: [
      ...started(1),
      local("set", [VOL, 0.3]),
      advance(500),
      local("set", [VOL, 0.4]),
      advance(500),
      local("set", [VOL, 0.5]),
      advance(1999),
      assert({
        requests: [],
        values: { [VOL]: val(0.5, "pending") },
        events: [
          changed([VOL], "local"),
          changed([VOL], "local"),
          changed([VOL], "local"),
        ],
        status: st("pending", 1),
      }),
      advance(1),
      assert({
        requests: [pushReq(C1, 1, [set(1, VOL, 0.5, hlc(T0 + 1000))])],
        journal: {
          [ALICE]: partition(C1, 2, 1, [set(1, VOL, 0.5, hlc(T0 + 1000))]),
        },
      }),
      respond(
        pushBody({
          serverNow: T0 + 3000,
          cursor: 2,
          lastMutationId: 1,
          results: [ok(1, 2)],
          changes: [change(VOL, 0.5, 2, hlc(T0 + 1000))],
        }),
      ),
      assert({ status: st("idle", 0), events: [] }),
    ],
  });

  const FAST = 3 * DAY;
  add({
    name: "clock-offset-folded",
    description:
      "A device clock 3 days fast stamps edits at local time plus the persisted server offset, and each response refreshes the offset.",
    rules: ["push-8-clocks"],
    init: init({ clock: { now: T0 + FAST, offsetMs: -FAST, contacted: true } }),
    steps: [
      ...started(1),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({ requests: [pushReq(C1, 1, [set(1, VOL, 0.6, hlc(T0))])] }),
      respond(
        pushBody({
          serverNow: T0 + 62_000,
          cursor: 2,
          lastMutationId: 1,
          results: [ok(1, 2)],
          changes: [change(VOL, 0.6, 2, hlc(T0))],
        }),
      ),
      local("set", [VOL, 0.7]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 2, [set(2, VOL, 0.7, hlc(T0 + 62_000))])],
      }),
      respond(
        pushBody({
          serverNow: T0 + 64_000,
          cursor: 3,
          lastMutationId: 2,
          results: [ok(2, 3)],
          changes: [change(VOL, 0.7, 3, hlc(T0 + 62_000))],
        }),
      ),
      assert({ status: st("idle", 0) }),
    ],
  });

  const SLOW = -3 * DAY;
  add({
    name: "clock-slow-precontact-restamp",
    description:
      "Edits made 3 days slow before the first server contact are marked preContact, the first request is a pull, and they are re-stamped by the offset before the first push.",
    rules: ["pre-contact-restamp", "push-8-clocks"],
    init: init({
      clock: { now: T0 + SLOW, offsetMs: 0, contacted: false },
      network: "offline",
    }),
    steps: [
      local("set", [VOL, 0.6]),
      advance(2000),
      local("set", [QUAL, "high"]),
      advance(2000),
      assert({
        requests: [],
        journal: {
          [ALICE]: partition(C1, 3, 0, [
            j(set(1, VOL, 0.6, hlc(T0 + SLOW)), { preContact: true }),
            j(set(2, QUAL, "high", hlc(T0 + SLOW + 2000)), {
              preContact: true,
            }),
          ]),
        },
        status: st("offline", 2),
      }),
      network("online"),
      assert({ requests: [pullReq(0, C1)] }),
      respond(pullBody({ serverNow: T0 + 4000, cursor: 1 })),
      assert({
        requests: [
          pushReq(C1, 1, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0 + 2000)),
          ]),
        ],
        journal: {
          [ALICE]: partition(C1, 3, 1, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0 + 2000)),
          ]),
        },
      }),
      respond(
        pushBody({
          serverNow: T0 + 4000,
          cursor: 3,
          lastMutationId: 2,
          results: [ok(1, 2), ok(2, 3)],
          changes: [
            change(VOL, 0.6, 2, hlc(T0)),
            change(QUAL, "high", 3, hlc(T0 + 2000)),
          ],
        }),
      ),
      local("set", [VOL, 0.7]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 3, [set(3, VOL, 0.7, hlc(T0 + 4000))])],
      }),
    ],
  });

  add({
    name: "clock-fast-precontact-restamp",
    description:
      "An edit made 3 days fast before first contact is re-stamped back by the offset, so it cannot win by a clock set ahead.",
    rules: ["pre-contact-restamp"],
    init: init({
      clock: { now: T0 + FAST, offsetMs: 0, contacted: false },
      network: "offline",
    }),
    steps: [
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({
        journal: {
          [ALICE]: partition(C1, 2, 0, [
            j(set(1, VOL, 0.6, hlc(T0 + FAST)), { preContact: true }),
          ]),
        },
      }),
      network("online"),
      assert({ requests: [pullReq(0, C1)] }),
      respond(pullBody({ serverNow: T0 + 2000, cursor: 1 })),
      assert({ requests: [pushReq(C1, 1, [set(1, VOL, 0.6, hlc(T0))])] }),
    ],
  });

  add({
    name: "lww-conflict-server-wins",
    description:
      "A stale lastWrite set comes back as conflict with the server copy; the client takes it, reports origin remote and enqueues nothing.",
    rules: ["push-2-conflict-new-mutation", "push-1-last-mutation-id"],
    init: init(),
    steps: [
      ...started(5, [change(VOL, 0.5, 3, hlc(T0 + 10_000))]),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 5, [set(1, VOL, 0.6, hlc(T0))])],
        events: [changed([VOL], "remote"), changed([VOL], "local")],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 5,
          lastMutationId: 1,
          results: [
            conflict(1, {
              value: 0.5,
              version: 3,
              editedHlc: hlc(T0 + 10_000),
            }),
          ],
        }),
      ),
      assert({
        values: { [VOL]: val(0.5, "cloud") },
        events: [changed([VOL], "remote")],
        journal: { [ALICE]: partition(C1, 2, 5, []) },
        requests: [],
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "conflict-then-ok-one-push",
    description:
      "A conflict followed by an ok in one push removes both; the next mutation's id is above both.",
    rules: ["push-1-last-mutation-id"],
    init: init(),
    steps: [
      ...started(5, [change(VOL, 0.5, 3, hlc(T0 + 10_000))]),
      local("set", [VOL, 0.6]),
      local("set", [QUAL, "high"]),
      advance(2000),
      assert({
        requests: [
          pushReq(C1, 5, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0, 1)),
          ]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 6,
          lastMutationId: 2,
          results: [
            conflict(1, {
              value: 0.5,
              version: 3,
              editedHlc: hlc(T0 + 10_000),
            }),
            ok(2, 6),
          ],
          changes: [change(QUAL, "high", 6, hlc(T0, 1))],
        }),
      ),
      assert({
        values: { [VOL]: val(0.5, "cloud"), [QUAL]: val("high", "cloud") },
        journal: { [ALICE]: partition(C1, 3, 6, []) },
      }),
      local("set", [QUAL, "low"]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 6, [set(3, QUAL, "low", hlc(T0 + 2000))])],
      }),
      respond(
        pushBody({
          serverNow: T0 + 4000,
          cursor: 7,
          lastMutationId: 3,
          results: [ok(3, 7)],
          changes: [change(QUAL, "low", 7, hlc(T0 + 2000))],
        }),
      ),
      assert({
        journal: { [ALICE]: partition(C1, 4, 7, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "request-failure-keeps-journal",
    description:
      "A 503 and a transport error leave the journal as it was; the next trigger resends the same mutationIds.",
    rules: ["push-1-last-mutation-id"],
    init: init(),
    steps: [
      ...started(1),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({ requests: [pushReq(C1, 1, [set(1, VOL, 0.6, hlc(T0))])] }),
      respond(errorBody("unavailable", "Try again later."), 503),
      assert({
        journal: { [ALICE]: partition(C1, 2, 1, [set(1, VOL, 0.6, hlc(T0))]) },
        values: { [VOL]: val(0.6, "pending") },
        requests: [],
        status: st("pending", 1),
      }),
      local("flush", [], { ok: true }),
      assert({ requests: [pushReq(C1, 1, [set(1, VOL, 0.6, hlc(T0))])] }),
      { respond: { error: "transport" } },
      assert({ requests: [], status: st("pending", 1) }),
      local("flush"),
      assert({ requests: [pushReq(C1, 1, [set(1, VOL, 0.6, hlc(T0))])] }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 2,
          lastMutationId: 1,
          results: [ok(1, 2)],
          changes: [change(VOL, 0.6, 2, hlc(T0))],
        }),
      ),
      assert({
        journal: { [ALICE]: partition(C1, 2, 2, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "conflict-rebase-new-mutation",
    description:
      "A revision conflict under a keep-local hook is resolved as a new mutation with a fresh id and the server's version as its base.",
    rules: ["push-2-conflict-new-mutation"],
    init: init(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 9,
          changes: [recChange("progress", "main", { level: 3 }, 7)],
        }),
      ),
      local("put", ["progress", "main", { level: 4 }], { ok: true }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
        records: { "progress/main": val({ level: 4 }, "pending") },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [conflict(1, { value: { level: 5 }, version: 8 })],
          changes: [recChange("progress", "main", { level: 5 }, 8)],
        }),
      ),
      assert({
        requests: [
          pushReq(C1, 10, [put(2, "progress", "main", { level: 4 }, 8)]),
        ],
        journal: {
          [ALICE]: partition(C1, 3, 10, [
            put(2, "progress", "main", { level: 4 }, 8),
          ]),
        },
        records: { "progress/main": val({ level: 4 }, "pending") },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 11,
          lastMutationId: 2,
          results: [ok(2, 9)],
          changes: [recChange("progress", "main", { level: 4 }, 9)],
        }),
      ),
      assert({
        records: { "progress/main": val({ level: 4 }, "cloud") },
        journal: { [ALICE]: partition(C1, 3, 11, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "one-outstanding-cas",
    description:
      "While a record's compare-and-swap is in flight, later edits of it are held and coalesced, then sent rebased on the result; another record's write is not held.",
    rules: ["push-3-one-outstanding-cas"],
    init: init(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 3,
          changes: [recChange("progress", "main", { level: 1 }, 2)],
        }),
      ),
      local("put", ["progress", "main", { level: 2 }]),
      assert({
        requests: [
          pushReq(C1, 3, [put(1, "progress", "main", { level: 2 }, 2)]),
        ],
      }),
      local("put", ["progress", "main", { level: 3 }]),
      local("put", ["progress", "main", { level: 4 }]),
      local("put", ["progress", "side", { x: 1 }]),
      assert({
        requests: [],
        journal: {
          [ALICE]: partition(
            C1,
            3,
            3,
            [
              put(1, "progress", "main", { level: 2 }, 2),
              put(2, "progress", "side", { x: 1 }, "*"),
            ],
            { "progress/main": { level: 4 } },
          ),
        },
        records: {
          "progress/main": val({ level: 4 }, "pending"),
          "progress/side": val({ x: 1 }, "pending"),
        },
        status: st("syncing", 3),
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 4,
          lastMutationId: 1,
          results: [ok(1, 3)],
          changes: [recChange("progress", "main", { level: 2 }, 3)],
        }),
      ),
      assert({
        requests: [
          pushReq(C1, 4, [
            put(2, "progress", "side", { x: 1 }, "*"),
            put(3, "progress", "main", { level: 4 }, 3),
          ]),
        ],
        journal: {
          [ALICE]: partition(C1, 4, 4, [
            put(2, "progress", "side", { x: 1 }, "*"),
            put(3, "progress", "main", { level: 4 }, 3),
          ]),
        },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 6,
          lastMutationId: 3,
          results: [ok(2, 1), ok(3, 4)],
          changes: [
            recChange("progress", "side", { x: 1 }, 1),
            recChange("progress", "main", { level: 4 }, 4),
          ],
        }),
      ),
      assert({
        records: {
          "progress/main": val({ level: 4 }, "cloud"),
          "progress/side": val({ x: 1 }, "cloud"),
        },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "account-switch-partition",
    description:
      "Alice's pending operation stays in her partition while Bob is signed in and is sent only at Alice's next sign-in.",
    rules: ["partition", "push-5-sign-out-pending"],
    init: init({ network: "offline" }),
    steps: [
      local("set", [VOL, 0.6]),
      advance(2000),
      signOut(),
      assert({
        events: [
          changed([VOL], "local"),
          signedOut("signOut", 1),
          unsynced(1),
          changed([VOL], "remote"),
        ],
        values: { [VOL]: val(0.8, "document") },
        status: st("local", 0),
      }),
      signIn(BOB),
      network("online"),
      assert({ requests: [pullReq(0, C2)] }),
      respond(
        pullBody({
          subject: BOB,
          serverNow: T0 + 2000,
          cursor: 2,
          changes: [change(VOL, 0.3, 1, hlc(T0 - DAY))],
        }),
      ),
      assert({
        values: { [VOL]: val(0.3, "cloud") },
        events: [changed([VOL], "remote")],
        journal: {
          [ALICE]: partition(C1, 2, 0, [set(1, VOL, 0.6, hlc(T0))]),
          [BOB]: partition(C2, 1, 2, []),
        },
        status: st("idle", 0),
      }),
      signOut(),
      signIn(ALICE),
      assert({
        requests: [pushReq(C1, 0, [set(1, VOL, 0.6, hlc(T0))])],
        events: [
          signedOut("signOut", 0),
          changed([VOL], "remote"),
          changed([VOL], "remote"),
        ],
        values: { [VOL]: val(0.6, "pending") },
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 5,
          lastMutationId: 1,
          results: [ok(1, 5)],
          changes: [change(VOL, 0.6, 5, hlc(T0))],
        }),
      ),
      assert({ values: { [VOL]: val(0.6, "cloud") }, status: st("idle", 0) }),
    ],
  });

  add({
    name: "first-sign-in-empty-cloud",
    description:
      "Settings edited before any sign-in move into the subject's journal at sign-in (member ops for a merge key), wait for the first contact's pull, then upload.",
    rules: ["first-sign-in", "pre-contact-restamp"],
    init: init({
      subject: null,
      clock: { now: T0, offsetMs: 0, contacted: false },
    }),
    steps: [
      local("set", [VOL, 0.6]),
      local("set", [BIND, { jump: "j", crouch: "ctrl" }]),
      advance(2000),
      assert({
        requests: [],
        journal: {
          local: {
            settings: {
              [VOL]: { value: 0.6, editedHlc: hlc(T0), preContact: true },
              [BIND]: {
                value: { jump: "j", crouch: "ctrl" },
                editedHlc: hlc(T0, 1),
                preContact: true,
              },
            },
          },
        },
        values: {
          [VOL]: val(0.6, "device"),
          [BIND]: val({ jump: "j", crouch: "ctrl" }, "device"),
        },
        events: [changed([VOL], "local"), changed([BIND], "local")],
        status: st("local", 0),
      }),
      signIn(ALICE),
      assert({
        requests: [pullReq(0, C1)],
        journal: {
          [ALICE]: partition(C1, 4, 0, [
            j(set(1, VOL, 0.6, hlc(T0)), { moved: true, preContact: true }),
            j(setMember(2, BIND, "crouch", "ctrl", hlc(T0, 1)), {
              moved: true,
              preContact: true,
            }),
            j(setMember(3, BIND, "jump", "j", hlc(T0, 1)), {
              moved: true,
              preContact: true,
            }),
          ]),
        },
        values: { [VOL]: val(0.6, "pending") },
        events: [],
      }),
      respond(pullBody({ serverNow: T0 + 2000, cursor: 0 })),
      assert({
        requests: [
          pushReq(C1, 0, [
            set(1, VOL, 0.6, hlc(T0)),
            setMember(2, BIND, "crouch", "ctrl", hlc(T0, 1)),
            setMember(3, BIND, "jump", "j", hlc(T0, 1)),
          ]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 3,
          lastMutationId: 3,
          results: [ok(1, 1), ok(2, 2), ok(3, 3)],
          changes: [
            change(VOL, 0.6, 1, hlc(T0)),
            change(BIND, { crouch: "ctrl", jump: "j" }, 3, hlc(T0, 1)),
          ],
        }),
      ),
      assert({
        values: {
          [VOL]: val(0.6, "cloud"),
          [BIND]: val({ jump: "j", crouch: "ctrl" }, "cloud"),
        },
        events: [],
        journal: { [ALICE]: partition(C1, 4, 3, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "first-sign-in-newer-and-older-cloud",
    description:
      "At first sign-in a newer cloud value beats the moved local one (reported with origin merge) and an older one loses, with no prompt.",
    rules: ["first-sign-in"],
    init: init({ subject: null }),
    steps: [
      local("set", [VOL, 0.6]),
      local("set", [QUAL, "high"]),
      advance(2000),
      signIn(ALICE),
      assert({
        requests: [
          pushReq(C1, 0, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0, 1)),
          ]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 5,
          lastMutationId: 2,
          results: [
            conflict(1, {
              value: 0.5,
              version: 4,
              editedHlc: hlc(T0 + 60_000),
            }),
            ok(2, 5),
          ],
          changes: [
            change(VOL, 0.5, 4, hlc(T0 + 60_000)),
            change(QUAL, "high", 5, hlc(T0, 1)),
          ],
        }),
      ),
      assert({
        events: [changed([VOL], "merge")],
        values: { [VOL]: val(0.5, "cloud"), [QUAL]: val("high", "cloud") },
        journal: { [ALICE]: partition(C1, 3, 5, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "sign-out-local-edit-sign-in-other",
    description:
      "After Alice signs out, a local edit lands in the local partition and moves to whoever signs in next, here Bob.",
    rules: ["first-sign-in", "partition"],
    init: init(),
    steps: [
      ...started(3, [change(VOL, 0.5, 3, hlc(T0 - 1000))]),
      signOut(),
      local("set", [VOL, 0.7]),
      advance(2000),
      assert({
        events: [
          changed([VOL], "remote"),
          signedOut("signOut", 0),
          changed([VOL], "remote"),
          changed([VOL], "local"),
        ],
        journal: {
          [ALICE]: partition(C1, 1, 0, []),
          local: { settings: { [VOL]: { value: 0.7, editedHlc: hlc(T0) } } },
        },
        values: { [VOL]: val(0.7, "device") },
      }),
      signIn(BOB),
      assert({
        requests: [pushReq(C2, 0, [set(1, VOL, 0.7, hlc(T0))])],
        journal: {
          [ALICE]: partition(C1, 1, 0, []),
          [BOB]: partition(C2, 2, 0, [
            j(set(1, VOL, 0.7, hlc(T0)), { moved: true }),
          ]),
        },
      }),
      respond(
        pushBody({
          subject: BOB,
          serverNow: T0 + 2000,
          cursor: 2,
          lastMutationId: 1,
          results: [ok(1, 2)],
          changes: [change(VOL, 0.7, 2, hlc(T0))],
        }),
      ),
      assert({ values: { [VOL]: val(0.7, "cloud") }, status: st("idle", 0) }),
    ],
  });

  add({
    name: "account-required-on-push",
    description:
      "403 account_required on a push is handled like sign-out: licence state untouched, the pending operation kept in the partition, values local, sign-in offered.",
    rules: ["account-required", "principal-change"],
    init: init(),
    steps: [
      ...started(2, [change(VOL, 0.5, 2, hlc(T0 - 1000))]),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])],
        events: [changed([VOL], "remote"), changed([VOL], "local")],
      }),
      respond(ACCOUNT_REQUIRED, 403),
      assert({
        events: [
          signedOut("accountRequired", 1),
          unsynced(1),
          changed([VOL], "remote"),
          { type: "signInOffered", signInUrl: SIGN_IN_URL },
        ],
        licence: LICENCE,
        values: { [VOL]: val(0.8, "document") },
        journal: { [ALICE]: partition(C1, 2, 0, [set(1, VOL, 0.6, hlc(T0))]) },
        status: st("blocked", 0, "account_required"),
      }),
      local("set", [VOL, 0.4]),
      advance(2000),
      assert({
        requests: [],
        values: { [VOL]: val(0.4, "device") },
        licence: LICENCE,
      }),
      signIn(ALICE),
      assert({
        requests: [
          pushReq(C1, 0, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, VOL, 0.4, hlc(T0 + 2000)),
          ]),
        ],
        status: st("syncing", 2),
      }),
      respond(
        pushBody({
          serverNow: T0 + 4000,
          cursor: 4,
          lastMutationId: 2,
          results: [ok(1, 3), ok(2, 4)],
          changes: [change(VOL, 0.4, 4, hlc(T0 + 2000))],
        }),
      ),
      assert({ values: { [VOL]: val(0.4, "cloud") }, status: st("idle", 0) }),
    ],
  });

  add({
    name: "relink-clears-binding",
    description:
      "A relink that cleared the device's binding answers the start-up pull with account_required; values stay local and a document refresh does not lift it.",
    rules: ["account-required", "principal-change"],
    init: init(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(ACCOUNT_REQUIRED, 403),
      assert({
        events: [
          signedOut("accountRequired", 0),
          { type: "signInOffered", signInUrl: SIGN_IN_URL },
        ],
        licence: LICENCE,
        status: st("blocked", 0, "account_required"),
      }),
      local("set", [VOL, 0.6]),
      advance(2000),
      local("refresh"),
      assert({
        requests: [],
        values: { [VOL]: val(0.6, "device") },
        journal: {
          [ALICE]: partition(C1, 1, 0, []),
          local: { settings: { [VOL]: { value: 0.6, editedHlc: hlc(T0) } } },
        },
        licence: LICENCE,
        status: st("blocked", 0, "account_required"),
      }),
    ],
  });

  add({
    name: "key-activated-device-local-only",
    description:
      "A device nobody has signed in on never calls Cloud Sync; its settings persist locally across a relaunch.",
    rules: ["account-required", "relaunch"],
    init: init({
      subject: null,
      clock: { now: T0, offsetMs: 0, contacted: false },
    }),
    steps: [
      local("set", [VOL, 0.6]),
      advance(2000),
      { relaunch: {} },
      assert({
        requests: [],
        values: { [VOL]: val(0.6, "device") },
        journal: {
          local: {
            settings: {
              [VOL]: { value: 0.6, editedHlc: hlc(T0), preContact: true },
            },
          },
        },
        licence: LICENCE,
        status: st("local", 0),
      }),
    ],
  });

  add({
    name: "merge-alias-subject-change",
    description:
      "A response naming another subject (a merge alias) is handled like sign-out; the old partition's pending operation expires 30 days later.",
    rules: ["principal-change", "push-5-sign-out-pending"],
    init: init(),
    steps: [
      ...started(2, [change(VOL, 0.5, 2, hlc(T0 - 1000))]),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])],
        events: [changed([VOL], "remote"), changed([VOL], "local")],
      }),
      respond(
        pushBody({
          subject: ZED,
          serverNow: T0 + 2000,
          cursor: 7,
          lastMutationId: 1,
          results: [ok(1, 7)],
          changes: [change(VOL, 0.6, 7, hlc(T0))],
        }),
      ),
      assert({
        events: [
          signedOut("subjectChanged", 1),
          unsynced(1),
          changed([VOL], "remote"),
        ],
        journal: { [ALICE]: partition(C1, 2, 0, [set(1, VOL, 0.6, hlc(T0))]) },
        status: st("local", 0),
      }),
      signIn(ZED),
      assert({ requests: [pullReq(0, C2)] }),
      respond(
        pullBody({
          subject: ZED,
          serverNow: T0 + 2000,
          cursor: 7,
          changes: [change(VOL, 0.6, 7, hlc(T0))],
        }),
      ),
      advance(30 * DAY),
      { relaunch: {} },
      assert({
        requests: [pullReq(7, C2)],
        journal: { [ZED]: partition(C2, 1, 7, []) },
      }),
    ],
  });

  add({
    name: "unauthorized-pauses",
    description:
      "A /sync 401 blocks Cloud Sync with the journal intact and licence state untouched; only a document refresh resumes it.",
    rules: ["unauthorized-pauses"],
    init: init(),
    steps: [
      ...started(2),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({ requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])] }),
      respond(errorBody("unauthorized", "Device token revoked."), 401),
      local("set", [QUAL, "high"]),
      advance(2000),
      local("flush"),
      assert({
        requests: [],
        licence: LICENCE,
        journal: {
          [ALICE]: partition(C1, 3, 2, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0 + 2000)),
          ]),
        },
        values: { [VOL]: val(0.6, "pending") },
        status: st("blocked", 2, "unauthorized"),
      }),
      local("refresh", [], { ok: true }),
      assert({
        requests: [
          pushReq(C1, 2, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0 + 2000)),
          ]),
        ],
        status: st("syncing", 2),
      }),
      respond(
        pushBody({
          serverNow: T0 + 4000,
          cursor: 4,
          lastMutationId: 2,
          results: [ok(1, 3), ok(2, 4)],
          changes: [
            change(VOL, 0.6, 3, hlc(T0)),
            change(QUAL, "high", 4, hlc(T0 + 2000)),
          ],
        }),
      ),
      assert({ status: st("idle", 0), licence: LICENCE }),
    ],
  });

  add({
    name: "sign-out-flush-succeeds",
    description:
      "Sign-out commits the debounced edit, flushes it, and completes with nothing unsynced once the push is acknowledged.",
    rules: ["push-5-sign-out-pending"],
    init: init(),
    steps: [
      ...started(2),
      local("set", [VOL, 0.6]),
      signOut(),
      assert({
        requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])],
        events: [changed([VOL], "local")],
        status: st("syncing", 1),
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 3,
          lastMutationId: 1,
          results: [ok(1, 3)],
          changes: [change(VOL, 0.6, 3, hlc(T0))],
        }),
      ),
      assert({
        events: [signedOut("signOut", 0), changed([VOL], "remote")],
        journal: { [ALICE]: partition(C1, 2, 0, []) },
        status: st("local", 0),
      }),
    ],
  });

  add({
    name: "sign-out-flush-timeout",
    description:
      "A sign-out flush that gets no answer in 5 seconds completes with the operation unsynced and kept.",
    rules: ["push-5-sign-out-pending"],
    init: init(),
    steps: [
      ...started(2),
      local("set", [VOL, 0.6]),
      signOut(),
      advance(4999),
      assert({
        requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])],
        events: [changed([VOL], "local")],
        status: st("syncing", 1),
      }),
      advance(1),
      assert({
        requests: [],
        events: [
          signedOut("signOut", 1),
          unsynced(1),
          changed([VOL], "remote"),
        ],
        journal: { [ALICE]: partition(C1, 2, 0, [set(1, VOL, 0.6, hlc(T0))]) },
        status: st("local", 0),
      }),
    ],
  });

  add({
    name: "sign-out-discard-unsynced",
    description:
      "signOut with discardUnsynced deletes the pending operations instead of keeping them.",
    rules: ["push-5-sign-out-pending"],
    init: init({ network: "offline" }),
    steps: [
      local("set", [VOL, 0.6]),
      advance(2000),
      signOut({ discardUnsynced: true }),
      assert({
        events: [
          changed([VOL], "local"),
          signedOut("signOut", 1),
          changed([VOL], "remote"),
        ],
        journal: { [ALICE]: partition(C1, 2, 0, []) },
        status: st("local", 0),
      }),
    ],
  });

  add({
    name: "pending-expire-after-30-days",
    description:
      "A signed-out subject's pending operations, and its partition, expire 30 days after sign-out.",
    rules: ["push-5-sign-out-pending", "partition"],
    init: init({ network: "offline" }),
    steps: [
      local("set", [VOL, 0.6]),
      advance(2000),
      signOut(),
      advance(30 * DAY - 1),
      signIn(BOB),
      assert({
        journal: {
          [ALICE]: partition(C1, 2, 0, [set(1, VOL, 0.6, hlc(T0))]),
          [BOB]: partition(C2, 1, 0, []),
        },
      }),
      signOut(),
      advance(1),
      signIn(BOB),
      assert({ journal: { [BOB]: partition(C2, 1, 0, []) } }),
    ],
  });

  add({
    name: "on-sign-out-keep",
    description:
      "Under onSignOut keep, the snapshot and cursor survive sign-out, so the next sign-in pulls from the old cursor.",
    rules: ["push-5-sign-out-pending"],
    init: init({ options: { onSignOut: "keep" } }),
    steps: [
      ...started(3, [change(VOL, 0.5, 3, hlc(T0 - 1000))]),
      signOut(),
      assert({
        values: { [VOL]: val(0.8, "document") },
        journal: { [ALICE]: partition(C1, 1, 3, []) },
        events: [
          changed([VOL], "remote"),
          signedOut("signOut", 0),
          changed([VOL], "remote"),
        ],
      }),
      signIn(ALICE),
      assert({
        requests: [pullReq(3, C1)],
        values: { [VOL]: val(0.5, "cloud") },
        events: [changed([VOL], "remote")],
      }),
    ],
  });

  add({
    name: "journal-loss-new-client-id",
    description:
      "A relaunch with the journal lost generates a new clientId whose mutationIds restart at 1; the lost operation is gone.",
    rules: ["push-4-client-id", "relaunch"],
    init: init(),
    steps: [
      ...started(4, [change(VOL, 0.5, 4, hlc(T0 - 1000))]),
      network("offline"),
      local("set", [VOL, 0.6]),
      advance(2000),
      { relaunch: { journal: "lost" } },
      assert({
        journal: { [ALICE]: partition(C2, 1, 0, []) },
        values: { [VOL]: val(0.8, "document") },
        requests: [],
      }),
      local("set", [VOL, 0.7]),
      advance(2000),
      network("online"),
      assert({ requests: [pullReq(0, C2)] }),
      respond(
        pullBody({
          serverNow: T0 + 4000,
          cursor: 5,
          changes: [change(VOL, 0.5, 4, hlc(T0 - 1000))],
        }),
      ),
      assert({
        requests: [pushReq(C2, 5, [set(1, VOL, 0.7, hlc(T0 + 2000))])],
      }),
    ],
  });

  add({
    name: "client-mismatch-regenerates",
    description:
      "409 client_mismatch makes the client generate a new clientId, renumber its pending operations from 1 and resend.",
    rules: ["push-4-client-id"],
    init: init(),
    steps: [
      ...started(1),
      local("set", [VOL, 0.6]),
      local("set", [QUAL, "high"]),
      advance(2000),
      assert({
        requests: [
          pushReq(C1, 1, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0, 1)),
          ]),
        ],
      }),
      respond(
        errorBody("client_mismatch", "clientId belongs to another device."),
        409,
      ),
      assert({
        requests: [
          pushReq(C2, 1, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0, 1)),
          ]),
        ],
        journal: {
          [ALICE]: partition(C2, 3, 1, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0, 1)),
          ]),
        },
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 3,
          lastMutationId: 2,
          results: [ok(1, 2), ok(2, 3)],
          changes: [
            change(VOL, 0.6, 2, hlc(T0)),
            change(QUAL, "high", 3, hlc(T0, 1)),
          ],
        }),
      ),
      assert({
        journal: { [ALICE]: partition(C2, 3, 3, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "cursor-expired-with-pending",
    description:
      "cursor_expired keeps the journal, replaces the snapshot with a full pull, keeps the optimistic view and pushes the operation unchanged.",
    rules: ["push-7-cursor-expired"],
    init: init(),
    steps: [
      ...started(40, [
        change(VOL, 0.5, 3, hlc(T0 - 1000)),
        change(QUAL, "low", 39, hlc(T0 - 500)),
      ]),
      network("offline"),
      local("set", [VOL, 0.6]),
      advance(2000),
      network("online"),
      assert({
        requests: [pushReq(C1, 40, [set(1, VOL, 0.6, hlc(T0))])],
        events: [changed([VOL, QUAL], "remote"), changed([VOL], "local")],
      }),
      respond(
        errorBody(
          "cursor_expired",
          "Cursor is older than the tombstone horizon.",
        ),
        410,
      ),
      assert({
        requests: [pullReq(0, C1)],
        journal: { [ALICE]: partition(C1, 2, 0, [set(1, VOL, 0.6, hlc(T0))]) },
        values: { [VOL]: val(0.6, "pending"), [QUAL]: val("low", "cloud") },
        events: [],
      }),
      respond(
        pullBody({
          serverNow: T0 + 2000,
          cursor: 120,
          changes: [
            change(VOL, 0.5, 90, hlc(T0 - 1000)),
            change(QUAL, "high", 100, hlc(T0 + 1000)),
          ],
        }),
      ),
      assert({
        requests: [pushReq(C1, 120, [set(1, VOL, 0.6, hlc(T0))])],
        events: [changed([QUAL], "remote")],
        values: { [VOL]: val(0.6, "pending"), [QUAL]: val("high", "cloud") },
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 121,
          lastMutationId: 1,
          results: [ok(1, 121)],
          changes: [change(VOL, 0.6, 121, hlc(T0))],
        }),
      ),
      assert({ status: st("idle", 0) }),
    ],
  });

  add({
    name: "member-merge",
    description:
      "Setting a merge key sends one setMember or removeMember per changed member; a concurrent member edit from another device arrives with origin remote.",
    rules: ["member-merge"],
    init: init(),
    steps: [
      ...started(2, [
        change(BIND, { jump: "space", crouch: "ctrl" }, 2, hlc(T0 - 1000)),
      ]),
      local("set", [BIND, { jump: "j", crouch: "ctrl", dash: "shift" }]),
      advance(2000),
      assert({
        requests: [
          pushReq(C1, 2, [
            setMember(1, BIND, "dash", "shift", hlc(T0)),
            setMember(2, BIND, "jump", "j", hlc(T0)),
          ]),
        ],
        events: [changed([BIND], "local")],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 5,
          lastMutationId: 2,
          results: [ok(1, 3), ok(2, 4)],
          changes: [
            change(
              BIND,
              { jump: "j", crouch: "c", dash: "shift" },
              5,
              hlc(T0 + 500),
            ),
          ],
        }),
      ),
      assert({
        values: {
          [BIND]: val({ jump: "j", crouch: "c", dash: "shift" }, "cloud"),
        },
        events: [changed([BIND], "remote")],
      }),
      local("set", [BIND, { jump: "j", crouch: "c" }]),
      advance(2000),
      assert({
        requests: [
          pushReq(C1, 5, [removeMember(3, BIND, "dash", hlc(T0 + 2000))]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0 + 4000,
          cursor: 6,
          lastMutationId: 3,
          results: [ok(3, 6)],
          changes: [
            change(BIND, { jump: "j", crouch: "c" }, 6, hlc(T0 + 2000)),
          ],
        }),
      ),
      assert({
        values: { [BIND]: val({ jump: "j", crouch: "c" }, "cloud") },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "union-add-remove",
    description:
      "A union record sends add, and remove with the cursor as observedSeq; an add the remover had not seen survives.",
    rules: ["union-set"],
    init: init(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 4,
          changes: [recChange("unlocks", "main", ["sword"], 1)],
        }),
      ),
      local("add", ["unlocks", "main", "shield"], { ok: true }),
      assert({
        requests: [pushReq(C1, 4, [addEl(1, "unlocks", "main", "shield")])],
        records: { "unlocks/main": val(["sword", "shield"], "pending") },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 5,
          lastMutationId: 1,
          results: [ok(1, 2)],
          changes: [recChange("unlocks", "main", ["sword", "shield"], 2)],
        }),
      ),
      local("remove", ["unlocks", "main", "sword"], { ok: true }),
      assert({
        requests: [
          pushReq(C1, 5, [removeEl(2, "unlocks", "main", "sword", 5)]),
        ],
        records: { "unlocks/main": val(["shield"], "pending") },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 7,
          lastMutationId: 2,
          results: [ok(2, 4)],
          changes: [recChange("unlocks", "main", ["shield", "sword"], 4)],
        }),
      ),
      assert({
        records: { "unlocks/main": val(["shield", "sword"], "cloud") },
        status: st("idle", 0),
      }),
    ],
  });

  const OLD_CATALOG: Obj = {
    settings: [
      ...(CATALOG.settings as Obj[]),
      synced("gfx.q", "lastWrite", {
        type: "string",
        enum: ["low", "medium", "high"],
      }),
      synced("audio.legacyReverb", "lastWrite", { type: "boolean" }),
    ],
    collections: CATALOG.collections!,
  };
  const OLD_DOCUMENT: Obj = {
    values: {
      ...(DOCUMENT.values as Obj),
      "gfx.q": "medium",
      "audio.legacyReverb": false,
    },
    locked: DOCUMENT.locked!,
  };
  add({
    name: "renamed-and-dropped-keys",
    description:
      "An old build reads a renamed key through the pull's aliases, gets ok with renamedTo for a set on it, and ok with dropped for a dropped key (origin migration).",
    rules: ["push-6-renamed-dropped"],
    init: init({ catalog: OLD_CATALOG, document: OLD_DOCUMENT }),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 3,
          aliases: { "gfx.q": QUAL },
          changes: [change(QUAL, "high", 3, hlc(T0 - 1000))],
        }),
      ),
      assert({
        values: { "gfx.q": val("high", "cloud"), [QUAL]: val("high", "cloud") },
        events: [changed(["gfx.q", QUAL], "remote")],
      }),
      local("set", ["gfx.q", "low"]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 3, [set(1, "gfx.q", "low", hlc(T0))])],
        events: [changed(["gfx.q", QUAL], "local")],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 4,
          lastMutationId: 1,
          aliases: { "gfx.q": QUAL },
          results: [ok(1, 4, { renamedTo: QUAL })],
          changes: [change(QUAL, "low", 4, hlc(T0))],
        }),
      ),
      assert({ values: { "gfx.q": val("low", "cloud") }, events: [] }),
      local("set", ["audio.legacyReverb", true]),
      advance(2000),
      assert({
        requests: [
          pushReq(C1, 4, [set(2, "audio.legacyReverb", true, hlc(T0 + 2000))]),
        ],
        events: [changed(["audio.legacyReverb"], "local")],
      }),
      respond(
        pushBody({
          serverNow: T0 + 4000,
          cursor: 4,
          lastMutationId: 2,
          aliases: { "gfx.q": QUAL },
          results: [{ mutationId: 2, status: "ok", dropped: true }],
        }),
      ),
      assert({
        values: { "audio.legacyReverb": val(false, "document") },
        events: [changed(["audio.legacyReverb"], "migration")],
        journal: { [ALICE]: partition(C1, 3, 4, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "locked-key-refused",
    description:
      "A set on a key the document enforces is refused with managed_by_admin and journals nothing, while the server's stored value stays out of the read.",
    rules: ["locked-key"],
    init: init(),
    steps: [
      ...started(2, [change(THEME, "light", 2, hlc(T0 - 1000))]),
      local("set", [THEME, "light"], {
        ok: false,
        error: "managed_by_admin",
      }),
      advance(2000),
      assert({
        values: { [THEME]: val("dark", "document") },
        states: { [THEME]: { sync: "synced", invalid: false, locked: true } },
        journal: { [ALICE]: partition(C1, 1, 2, []) },
        requests: [],
        events: [],
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "invalid-stored-value",
    description:
      "A stored value that fails the key's schema is kept, marked invalid and falls through to the next layer; a valid set replaces it.",
    rules: ["invalid-value"],
    init: init(),
    steps: [
      ...started(2, [change(VOL, 1.5, 2, hlc(T0 - 1000))]),
      assert({
        values: { [VOL]: val(0.8, "document") },
        states: { [VOL]: { sync: "synced", invalid: true, locked: false } },
        events: [],
      }),
      local("set", [VOL, 0.4]),
      assert({
        values: { [VOL]: val(0.4, "pending") },
        states: { [VOL]: { sync: "pending", invalid: false, locked: false } },
        events: [changed([VOL], "local")],
      }),
    ],
  });

  add({
    name: "rejected-result-reverts",
    description:
      "A rejected mutation is removed, reported, and the read falls back to the snapshot (origin remote).",
    rules: ["push-1-last-mutation-id"],
    init: init(),
    steps: [
      ...started(2, [change(QUAL, "low", 2, hlc(T0 - 1000))]),
      local("set", [QUAL, "high"]),
      advance(2000),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 2,
          lastMutationId: 1,
          results: [
            { mutationId: 1, status: "rejected", code: "value_invalid" },
          ],
        }),
      ),
      assert({
        events: [
          changed([QUAL], "remote"),
          changed([QUAL], "local"),
          { type: "rejected", mutationId: 1, code: "value_invalid" },
          changed([QUAL], "remote"),
        ],
        values: { [QUAL]: val("low", "cloud") },
        journal: { [ALICE]: partition(C1, 2, 2, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "relaunch-commits-and-pushes",
    description:
      "A debounced edit is committed on exit, survives the relaunch with its clock, and start pushes it.",
    rules: ["relaunch", "debounce"],
    init: init(),
    steps: [
      ...started(2),
      local("set", [VOL, 0.6]),
      advance(1000),
      { relaunch: {} },
      assert({
        requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])],
        journal: { [ALICE]: partition(C1, 2, 2, [set(1, VOL, 0.6, hlc(T0))]) },
      }),
      respond(
        pushBody({
          serverNow: T0 + 1000,
          cursor: 3,
          lastMutationId: 1,
          results: [ok(1, 3)],
          changes: [change(VOL, 0.6, 3, hlc(T0))],
        }),
      ),
      local("set", [VOL, 0.7]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 3, [set(2, VOL, 0.7, hlc(T0 + 1000))])],
      }),
    ],
  });

  // ── version 2 (plans/U-01b.md §4 and Revision 2) ────────────────────────────────────────────

  const routed = (over: Obj = {}): Obj =>
    init({ catalog: ROUTED_CATALOG, document: ROUTED_DOCUMENT, ...over });
  const LOWERED: Obj = { bytes: 1_048_576, files: false };
  const OVER: Obj = { bytes: 2_097_152, settings: 12, records: 0, files: 0 };

  addV2({
    name: "open-setting-synced",
    description:
      "A key the catalog does not declare is an open setting: read at once, pushed with scope user under lastWrite, read from the cloud once acknowledged, and another device's open setting arrives in a pull.",
    rules: ["open-settings", "optimistic-read"],
    init: routed(),
    steps: [
      ...started(3),
      local("set", [OPEN, { deck: "red" }], { ok: true }),
      assert({
        values: { [OPEN]: val({ deck: "red" }, "pending") },
        states: { [OPEN]: { sync: "pending", invalid: false, locked: false } },
        events: [changed([OPEN], "local")],
        requests: [],
        status: st("pending", 1),
      }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 3, [set(1, OPEN, { deck: "red" }, hlc(T0))])],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 4,
          lastMutationId: 1,
          results: [ok(1, 4)],
          changes: [change(OPEN, { deck: "red" }, 4, hlc(T0))],
        }),
      ),
      assert({
        values: { [OPEN]: val({ deck: "red" }, "cloud") },
        states: { [OPEN]: { sync: "synced", invalid: false, locked: false } },
        events: [],
        status: st("idle", 0),
      }),
      network("offline"),
      network("online"),
      assert({ requests: [pullReq(4, C1)] }),
      respond(
        pullBody({
          serverNow: T0 + 4000,
          cursor: 5,
          changes: [change(OPEN2, "neon", 5, hlc(T0 + 3000))],
        }),
      ),
      assert({
        values: {
          [OPEN2]: val("neon", "cloud"),
          [OPEN]: val({ deck: "red" }, "cloud"),
        },
        events: [changed([OPEN2], "remote")],
        status: st("idle", 0),
      }),
    ],
  });

  const AT_LIMIT = "x".repeat(8190); // 8,192 bytes of canonical JSON with its quotes
  addV2({
    name: "open-setting-too-large",
    description:
      "A value over 8 KiB of canonical JSON is refused with bad_request and journals nothing; one of exactly 8 KiB is accepted.",
    rules: ["open-settings"],
    init: routed(),
    steps: [
      ...started(3),
      local("set", [OPEN, `${AT_LIMIT}x`], {
        ok: false,
        error: "bad_request",
      }),
      assert({ events: [], requests: [], status: st("idle", 0) }),
      local("set", [OPEN, AT_LIMIT], { ok: true }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 3, [set(1, OPEN, AT_LIMIT, hlc(T0))])],
        events: [changed([OPEN], "local")],
      }),
    ],
  });

  addV2({
    name: "local-key-stays-local",
    description:
      "A local key set signed out and signed in is never moved at sign-in and never in a push, and always reads from the device, after sign-out too.",
    rules: ["setting-routes", "first-sign-in"],
    init: routed({ subject: null }),
    steps: [
      local("set", [WINDOW, "1920x1080"], { ok: true }),
      local("set", [VOL, 0.6], { ok: true }),
      assert({
        values: {
          [WINDOW]: val("1920x1080", "device"),
          [VOL]: val(0.6, "pending"),
        },
        states: {
          [WINDOW]: { sync: "local", invalid: false, locked: false },
        },
        events: [changed([WINDOW], "local"), changed([VOL], "local")],
        requests: [],
        status: st("local", 1),
      }),
      advance(2000),
      signIn(ALICE),
      assert({
        requests: [pushReq(C1, 0, [set(1, VOL, 0.6, hlc(T0))])],
        journal: {
          [ALICE]: partition(C1, 2, 0, [
            j(set(1, VOL, 0.6, hlc(T0)), { moved: true }),
          ]),
        },
        values: { [WINDOW]: val("1920x1080", "device") },
        events: [],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 1,
          lastMutationId: 1,
          results: [ok(1, 1)],
          changes: [change(VOL, 0.6, 1, hlc(T0))],
        }),
      ),
      local("set", [WINDOW, "2560x1440"], { ok: true }),
      advance(2000),
      assert({
        requests: [],
        values: {
          [WINDOW]: val("2560x1440", "device"),
          [VOL]: val(0.6, "cloud"),
        },
        states: {
          [WINDOW]: { sync: "local", invalid: false, locked: false },
        },
        journal: { [ALICE]: partition(C1, 2, 1, []) },
        events: [changed([WINDOW], "local")],
        status: st("idle", 0),
      }),
      signOut(),
      assert({
        values: {
          [WINDOW]: val("2560x1440", "device"),
          [VOL]: val(0.8, "document"),
        },
        events: [signedOut("signOut", 0), changed([VOL], "remote")],
        status: st("local", 0),
      }),
    ],
  });

  addV2({
    name: "secret-key-refused",
    description:
      "While Cloud Sync is on, a set or clear of a declared secret or flag, or a value its schema refuses, is bad_request; a key the catalog locks is managed_by_admin. None journals or sends anything.",
    rules: ["setting-routes", "locked-key"],
    init: routed(),
    steps: [
      ...started(2),
      local("set", [TOKEN, "s3cr3t"], { ok: false, error: "bad_request" }),
      local("clear", [TOKEN], { ok: false, error: "bad_request" }),
      local("set", [BETA, true], { ok: false, error: "bad_request" }),
      local("set", [VOL, 1.5], { ok: false, error: "bad_request" }),
      local("set", [REGION, "us"], {
        ok: false,
        error: "managed_by_admin",
      }),
      advance(2000),
      assert({
        values: {
          [BETA]: val(false, "document"),
          [VOL]: val(0.8, "document"),
          [REGION]: val("eu", "document"),
        },
        states: { [REGION]: { sync: "synced", invalid: false, locked: true } },
        journal: { [ALICE]: partition(C1, 1, 2, []) },
        requests: [],
        events: [],
        status: st("idle", 0),
      }),
    ],
  });

  addV2({
    name: "platform-scope-target",
    description:
      "A key routed with platform scope is pushed with scope platform; an open setting in the same push with scope user.",
    rules: ["setting-routes", "open-settings"],
    init: routed(),
    steps: [
      ...started(2),
      local("set", [PLAT, 0.5], { ok: true }),
      local("set", [OPEN, "speedrun"], { ok: true }),
      advance(2000),
      assert({
        requests: [
          pushReq(C1, 2, [
            set(1, PLAT, 0.5, hlc(T0), "platform"),
            set(2, OPEN, "speedrun", hlc(T0, 1)),
          ]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 4,
          lastMutationId: 2,
          results: [ok(1, 3), ok(2, 4)],
          changes: [
            change(PLAT, 0.5, 3, hlc(T0), "platform"),
            change(OPEN, "speedrun", 4, hlc(T0, 1)),
          ],
        }),
      ),
      assert({
        values: {
          [PLAT]: val(0.5, "cloud"),
          [OPEN]: val("speedrun", "cloud"),
        },
        status: st("idle", 0),
      }),
    ],
  });

  addV2({
    name: "config-local-import-loses-to-cloud",
    description:
      "The legacy config.local store is imported once at the HLC floor: a synced key and an open setting move at sign-in, and a newer cloud value beats the import (conflict, server copy, origin merge, nothing enqueued); a local key lands on the device and never moves; a locked or secret key is not imported.",
    rules: ["local-import", "first-sign-in"],
    init: routed({
      subject: null,
      clock: { now: T0, offsetMs: 0, contacted: false },
      legacyLocal: {
        [VOL]: 0.3,
        [OPEN]: "legacy",
        [WINDOW]: "800x600",
        [REGION]: "us",
        [TOKEN]: "old",
      },
    }),
    steps: [
      assert({
        requests: [],
        journal: {
          local: {
            settings: {
              [VOL]: { value: 0.3, editedHlc: FLOOR },
              [OPEN]: { value: "legacy", editedHlc: FLOOR },
            },
          },
        },
        values: {
          [VOL]: val(0.3, "device"),
          [OPEN]: val("legacy", "device"),
          [WINDOW]: val("800x600", "device"),
          [REGION]: val("eu", "document"),
        },
        events: [changed([VOL, OPEN, WINDOW], "local")],
        status: st("local", 0),
      }),
      signIn(ALICE),
      assert({
        requests: [pullReq(0, C1)],
        journal: {
          [ALICE]: partition(C1, 3, 0, [
            j(set(1, VOL, 0.3, FLOOR), { moved: true }),
            j(set(2, OPEN, "legacy", FLOOR), { moved: true }),
          ]),
        },
        events: [],
      }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 5,
          changes: [change(VOL, 0.5, 4, hlc(T0 - 60_000))],
        }),
      ),
      assert({
        requests: [
          pushReq(C1, 5, [
            set(1, VOL, 0.3, FLOOR),
            set(2, OPEN, "legacy", FLOOR),
          ]),
        ],
        values: { [VOL]: val(0.3, "pending") },
        events: [],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 6,
          lastMutationId: 2,
          results: [
            conflict(1, {
              value: 0.5,
              version: 4,
              editedHlc: hlc(T0 - 60_000),
            }),
            ok(2, 6),
          ],
          changes: [change(OPEN, "legacy", 6, FLOOR)],
        }),
      ),
      assert({
        values: {
          [VOL]: val(0.5, "cloud"),
          [OPEN]: val("legacy", "cloud"),
          [WINDOW]: val("800x600", "device"),
        },
        events: [changed([VOL], "merge")],
        journal: { [ALICE]: partition(C1, 3, 6, []) },
        requests: [],
        status: st("idle", 0),
      }),
    ],
  });

  addV2({
    name: "record-max-field-conflict",
    description:
      "A record in a max collection is a stamped set the server resolves on playtime; when the server keeps a larger one the push gets conflict, and the client takes the server copy and enqueues nothing.",
    rules: ["record-field-policy"],
    init: routed(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 3,
          changes: [
            recChange("slots", "1", { playtime: 500, chapter: "2" }, 2),
          ],
        }),
      ),
      local("put", ["slots", "1", { playtime: 300, chapter: "3" }], {
        ok: true,
      }),
      assert({
        requests: [
          pushReq(C1, 3, [
            stamped(1, "slots", "1", { playtime: 300, chapter: "3" }, hlc(T0)),
          ]),
        ],
        records: {
          "slots/1": val({ playtime: 300, chapter: "3" }, "pending"),
        },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 3,
          lastMutationId: 1,
          results: [
            conflict(1, { value: { playtime: 500, chapter: "2" }, version: 2 }),
          ],
        }),
      ),
      assert({
        records: { "slots/1": val({ playtime: 500, chapter: "2" }, "cloud") },
        journal: { [ALICE]: partition(C1, 2, 3, []) },
        requests: [],
        status: st("idle", 0),
      }),
    ],
  });

  addV2({
    name: "attestation-required-blocks",
    description:
      "403 attestation_required blocks Cloud Sync with reason attestation: the journal is kept, licence state is untouched, later edits wait, and a document refresh resumes it.",
    rules: ["forbidden-blocks"],
    init: init(),
    steps: [
      ...started(2),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({ requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])] }),
      respond(
        errorBody(
          "attestation_required",
          "This product needs an attested device.",
        ),
        403,
      ),
      local("set", [QUAL, "high"]),
      advance(2000),
      local("flush"),
      assert({
        requests: [],
        licence: LICENCE,
        journal: {
          [ALICE]: partition(C1, 3, 2, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0 + 2000)),
          ]),
        },
        values: { [VOL]: val(0.6, "pending") },
        status: st("blocked", 2, "attestation"),
      }),
      local("refresh", [], { ok: true }),
      assert({
        requests: [
          pushReq(C1, 2, [
            set(1, VOL, 0.6, hlc(T0)),
            set(2, QUAL, "high", hlc(T0 + 2000)),
          ]),
        ],
        status: st("syncing", 2),
      }),
      respond(
        pushBody({
          serverNow: T0 + 4000,
          cursor: 4,
          lastMutationId: 2,
          results: [ok(1, 3), ok(2, 4)],
          changes: [
            change(VOL, 0.6, 3, hlc(T0)),
            change(QUAL, "high", 4, hlc(T0 + 2000)),
          ],
        }),
      ),
      assert({ status: st("idle", 0), licence: LICENCE }),
    ],
  });

  addV2({
    name: "other-403-blocks",
    description:
      "Any other 403 blocks with reason forbidden and waits for a document refresh; unlike account_required it neither signs out nor offers sign-in.",
    rules: ["forbidden-blocks"],
    init: init(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(errorBody("forbidden", "Cloud Sync is not available here."), 403),
      assert({
        events: [],
        licence: LICENCE,
        journal: { [ALICE]: partition(C1, 1, 0, []) },
        status: st("blocked", 0, "forbidden"),
      }),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({
        requests: [],
        values: { [VOL]: val(0.6, "pending") },
        status: st("blocked", 1, "forbidden"),
      }),
      local("refresh", [], { ok: true }),
      assert({
        requests: [pushReq(C1, 0, [set(1, VOL, 0.6, hlc(T0))])],
        status: st("syncing", 1),
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 3,
          lastMutationId: 1,
          results: [ok(1, 3)],
          changes: [change(VOL, 0.6, 3, hlc(T0))],
        }),
      ),
      assert({
        values: { [VOL]: val(0.6, "cloud") },
        status: st("idle", 0),
        licence: LICENCE,
      }),
    ],
  });

  const PAUSED = errorBody("writes_paused", "Cloud Sync writes are paused.");
  addV2({
    name: "writes-paused-keeps-journal",
    description:
      "503 writes_paused on a push keeps the journal and the value and shows paused, never blocked, with no refresh needed; the next trigger retries, and the push that lands clears it.",
    rules: ["writes-paused", "push-1-last-mutation-id"],
    init: init(),
    steps: [
      ...started(2),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({ requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])] }),
      respond(PAUSED, 503),
      assert({
        journal: { [ALICE]: partition(C1, 2, 2, [set(1, VOL, 0.6, hlc(T0))]) },
        values: { [VOL]: val(0.6, "pending") },
        states: { [VOL]: { sync: "pending", invalid: false, locked: false } },
        requests: [],
        events: [],
        licence: LICENCE,
        status: st("paused", 1),
      }),
      local("flush", [], { ok: true }),
      assert({
        requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])],
        status: st("syncing", 1),
      }),
      respond(PAUSED, 503),
      assert({ requests: [], status: st("paused", 1) }),
      local("flush"),
      assert({ requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])] }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 3,
          lastMutationId: 1,
          results: [ok(1, 3)],
          changes: [change(VOL, 0.6, 3, hlc(T0))],
        }),
      ),
      assert({
        values: { [VOL]: val(0.6, "cloud") },
        journal: { [ALICE]: partition(C1, 2, 3, []) },
        events: [],
        status: st("idle", 0),
      }),
    ],
  });

  /** The steps every quota scenario starts with: a set refused with quota_exceeded, parked. */
  const parkedOnQuota = (): Obj[] => [
    ...started(2, [change(VOL, 0.5, 2, hlc(T0 - 1000))]),
    local("set", [VOL, 0.6]),
    advance(2000),
    assert({
      requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])],
      events: [changed([VOL], "remote"), changed([VOL], "local")],
    }),
    respond(
      pushBody({
        serverNow: T0 + 2000,
        cursor: 2,
        lastMutationId: 1,
        results: [rejected(1, "quota_exceeded")],
        quota: LOWERED,
        usage: OVER,
      }),
    ),
    assert({
      values: { [VOL]: val(0.6, "pending") },
      states: { [VOL]: { sync: "pending", invalid: false, locked: false } },
      journal: {
        [ALICE]: partition(C1, 2, 2, [
          j(set(1, VOL, 0.6, hlc(T0)), { parked: "quota" }),
        ]),
      },
      events: [],
      requests: [],
      status: st("pending", 1, "quota"),
    }),
  ];

  addV2({
    name: "quota-rejected-keeps-value",
    description:
      "A set refused with quota_exceeded parks on the device: the value still reads, sync stays pending, the status gives reason quota, no rejected event fires and nothing is resent; it survives a relaunch, and a pull with no more room keeps it parked.",
    rules: ["parked-rejection", "relaunch"],
    init: init(),
    steps: [
      ...parkedOnQuota(),
      { relaunch: {} },
      assert({
        requests: [pullReq(2, C1)],
        journal: {
          [ALICE]: partition(C1, 2, 2, [
            j(set(1, VOL, 0.6, hlc(T0)), { parked: "quota" }),
          ]),
        },
        values: { [VOL]: val(0.6, "pending") },
        status: st("syncing", 1, "quota"),
      }),
      respond(
        pullBody({
          serverNow: T0 + 3000,
          cursor: 2,
          quota: LOWERED,
          usage: OVER,
        }),
      ),
      assert({
        requests: [],
        values: { [VOL]: val(0.6, "pending") },
        events: [],
        status: st("pending", 1, "quota"),
      }),
    ],
  });

  addV2({
    name: "quota-raised-retries",
    description:
      "Once a pull shows more room, a quota-parked edit is re-sent as a new mutation with its original clock, and lands.",
    rules: ["parked-rejection"],
    init: init(),
    steps: [
      ...parkedOnQuota(),
      network("offline"),
      network("online"),
      assert({ requests: [pullReq(2, C1)] }),
      respond(
        pullBody({
          serverNow: T0 + 4000,
          cursor: 3,
          usage: OVER,
        }),
      ),
      assert({
        requests: [pushReq(C1, 3, [set(2, VOL, 0.6, hlc(T0))])],
        journal: { [ALICE]: partition(C1, 3, 3, [set(2, VOL, 0.6, hlc(T0))]) },
        status: st("syncing", 1),
      }),
      respond(
        pushBody({
          serverNow: T0 + 4000,
          cursor: 4,
          lastMutationId: 2,
          results: [ok(2, 4)],
          changes: [change(VOL, 0.6, 4, hlc(T0))],
          usage: OVER,
        }),
      ),
      assert({
        values: { [VOL]: val(0.6, "cloud") },
        journal: { [ALICE]: partition(C1, 3, 4, []) },
        events: [],
        status: st("idle", 0),
      }),
    ],
  });

  addV2({
    name: "quota-lowered-deletes-nothing",
    description:
      "A pull whose quota is below the person's usage removes nothing on the device, and a clear still passes.",
    rules: ["quota-never-deletes"],
    init: init(),
    steps: [
      ...started(3, [
        change(VOL, 0.5, 2, hlc(T0 - 1000)),
        change(QUAL, "high", 3, hlc(T0 - 500)),
      ]),
      network("offline"),
      network("online"),
      assert({
        requests: [pullReq(3, C1)],
        events: [changed([VOL, QUAL], "remote")],
      }),
      respond(
        pullBody({ serverNow: T0, cursor: 3, quota: LOWERED, usage: OVER }),
      ),
      assert({
        values: { [VOL]: val(0.5, "cloud"), [QUAL]: val("high", "cloud") },
        events: [],
        status: st("idle", 0),
      }),
      local("clear", [VOL], { ok: true }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 3, [clear(1, VOL, hlc(T0))])],
        events: [changed([VOL], "local")],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 4,
          lastMutationId: 1,
          results: [ok(1, 4)],
          tombstones: [tombstone(VOL, 4, hlc(T0))],
          quota: LOWERED,
          usage: { bytes: 2_097_000, settings: 11, records: 0, files: 0 },
        }),
      ),
      assert({
        values: { [VOL]: val(0.8, "document"), [QUAL]: val("high", "cloud") },
        journal: { [ALICE]: partition(C1, 2, 4, []) },
        events: [],
        status: st("idle", 0),
      }),
    ],
  });

  addV2({
    name: "terminal-rejection-reverts",
    description:
      "value_invalid is terminal: the value reverts to the snapshot and a rejected event fires. entitlement_required in the same push parks instead, and the next sign-in re-sends it as a new mutation with its clock.",
    rules: ["parked-rejection", "push-1-last-mutation-id"],
    init: init(),
    steps: [
      ...started(2, [change(QUAL, "low", 2, hlc(T0 - 1000))]),
      local("set", [QUAL, "high"]),
      local("set", [VOL, 0.6]),
      advance(2000),
      assert({
        requests: [
          pushReq(C1, 2, [
            set(1, VOL, 0.6, hlc(T0, 1)),
            set(2, QUAL, "high", hlc(T0)),
          ]),
        ],
        events: [
          changed([QUAL], "remote"),
          changed([QUAL], "local"),
          changed([VOL], "local"),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 2,
          lastMutationId: 2,
          results: [
            rejected(1, "entitlement_required"),
            rejected(2, "value_invalid"),
          ],
        }),
      ),
      assert({
        events: [
          { type: "rejected", mutationId: 2, code: "value_invalid" },
          changed([QUAL], "remote"),
        ],
        values: { [QUAL]: val("low", "cloud"), [VOL]: val(0.6, "pending") },
        journal: {
          [ALICE]: partition(C1, 3, 2, [
            j(set(1, VOL, 0.6, hlc(T0, 1)), { parked: "entitlement" }),
          ]),
        },
        requests: [],
        status: st("pending", 1, "entitlement"),
      }),
      signOut(),
      signIn(ALICE),
      assert({
        requests: [pushReq(C1, 0, [set(3, VOL, 0.6, hlc(T0, 1))])],
        events: [
          signedOut("signOut", 1),
          unsynced(1),
          changed([VOL, QUAL], "remote"),
          changed([VOL], "remote"),
        ],
        journal: {
          [ALICE]: partition(C1, 4, 0, [set(3, VOL, 0.6, hlc(T0, 1))]),
        },
        status: st("syncing", 1),
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 4,
          lastMutationId: 3,
          results: [ok(3, 3)],
          changes: [
            change(VOL, 0.6, 3, hlc(T0, 1)),
            change(QUAL, "low", 2, hlc(T0 - 1000)),
          ],
        }),
      ),
      assert({
        values: { [VOL]: val(0.6, "cloud"), [QUAL]: val("low", "cloud") },
        status: st("idle", 0),
      }),
    ],
  });

  // ── version 3 (U-35.2; WIRE-CONTRACT-V5 §11.5, §13.10) ──────────────────────────────────────
  // The fake transport speaks plaintext. What the host codec found for each opened row rides on
  // `respond` as `opened`; the machine takes sealed, invalid and seq from nowhere else.

  const LAP = "stats.fastestLap";
  const E2E_CATALOG: Obj = {
    settings: [
      ...(CATALOG.settings as Obj[]),
      synced(LAP, "min", { type: "integer", minimum: 0 }),
    ],
    collections: CATALOG.collections as Obj[],
  };
  const E2E_DOCUMENT: Obj = {
    values: { ...(DOCUMENT.values as Obj), [LAP]: 0 },
    locked: DOCUMENT.locked!,
  };
  const e2e = (over: Obj = {}): Obj =>
    init({
      catalog: E2E_CATALOG,
      document: E2E_DOCUMENT,
      encryption: "e2e",
      ...over,
    });
  const e2eBody = (a: PullArgs & { since?: number; results?: Obj[] }): Obj => ({
    ...(a.results ? pushBody({ ...a, results: a.results }) : pullBody(a)),
    encryption: "e2e",
    encryptionSince: a.since ?? 0,
  });
  /** The start-up pull answered `e2e`; the host opened every change as sealed. */
  const e2eStarted = (cursor: number, changes: Obj[]): Obj[] => [
    assert({ requests: [pullReq(0, C1)], status: st("syncing", 0) }),
    respond(
      e2eBody({ serverNow: T0, cursor, changes }),
      200,
      sealed(changes.length),
    ),
  ];
  /** Another pull at `cursor`, answered `e2e` with the boundary at `since`. */
  const repull = (cursor: number, since: number, T = T0): Obj[] => [
    network("offline"),
    network("online"),
    assert({ requests: [pullReq(cursor, C1)] }),
    respond(e2eBody({ serverNow: T, cursor, since })),
  ];
  const invalidity = (key: string, invalid: boolean): Obj => ({
    states: { [key]: { sync: "synced", invalid, locked: false } },
  });
  const sealed = (n = 1): Obj => ({
    changes: Array.from({ length: n }, () => ({ sealed: true })),
  });
  /** An E2E max/min write: a compare-and-swap on the version seen (§13.10.5). */
  const cas = (
    id: number,
    key: string,
    value: J,
    baseVersion: number | "*",
    h: string,
  ): Obj => ({ ...set(id, key, value, h), baseVersion });

  add3({
    name: "e2e-max-conflict-remerged",
    description:
      "In E2E mode a max key is written against the version the client saw. When the server's sealed copy is smaller, the client re-pushes its own larger value on the server's version, with origin merge and no prompt.",
    rules: ["e2e-client-policy"],
    init: e2e(),
    steps: [
      ...e2eStarted(2, [change(BEST, 120, 2, hlc(T0 - 1000))]),
      assert({
        values: { [BEST]: val(120, "cloud") },
        events: [changed([BEST], "remote")],
        status: st("idle", 0),
      }),
      local("set", [BEST, 150], { ok: true }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 2, [cas(1, BEST, 150, 2, hlc(T0))])],
        events: [changed([BEST], "local")],
      }),
      respond(
        e2eBody({
          serverNow: T0 + 2000,
          cursor: 3,
          lastMutationId: 1,
          results: [
            conflict(1, { value: 130, version: 3, editedHlc: hlc(T0 - 500) }),
          ],
        }),
        200,
        { conflicts: { 1: { sealed: true } } },
      ),
      assert({
        requests: [pushReq(C1, 3, [cas(2, BEST, 150, 3, hlc(T0))])],
        values: { [BEST]: val(150, "pending") },
        status: st("syncing", 1),
      }),
      respond(
        e2eBody({
          serverNow: T0 + 2000,
          cursor: 4,
          lastMutationId: 2,
          results: [ok(2, 4)],
          changes: [change(BEST, 150, 4, hlc(T0))],
        }),
        200,
        sealed(),
      ),
      assert({
        values: { [BEST]: val(150, "cloud") },
        journal: { [ALICE]: partition(C1, 3, 4, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add3({
    name: "e2e-min-server-wins",
    description:
      "In E2E mode a min key whose server copy is smaller keeps the server's value: the client enqueues nothing and never re-pushes.",
    rules: ["e2e-client-policy"],
    init: e2e(),
    steps: [
      ...e2eStarted(2, [change(LAP, 80, 2, hlc(T0 - 1000))]),
      assert({
        values: { [LAP]: val(80, "cloud") },
        events: [changed([LAP], "remote")],
      }),
      local("set", [LAP, 90], { ok: true }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 2, [cas(1, LAP, 90, 2, hlc(T0))])],
      }),
      respond(
        e2eBody({
          serverNow: T0 + 2000,
          cursor: 3,
          lastMutationId: 1,
          results: [
            conflict(1, { value: 80, version: 3, editedHlc: hlc(T0 - 500) }),
          ],
        }),
        200,
        { conflicts: { 1: { sealed: true } } },
      ),
      assert({
        values: { [LAP]: val(80, "cloud") },
        requests: [],
        journal: { [ALICE]: partition(C1, 2, 3, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add3({
    name: "e2e-merge-member-cells",
    description:
      "A merge key in E2E mode is still one member op per changed member, with no base version and no client loop: the server settles each sealed member cell by its clock, and the client only reads the sealed result.",
    rules: ["e2e-client-policy"],
    init: e2e(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        e2eBody({
          serverNow: T0,
          cursor: 2,
          changes: [change(BIND, { jump: "space" }, 2, hlc(T0 - 1000))],
        }),
        200,
        sealed(),
      ),
      local("set", [BIND, { jump: "space", dash: "shift" }]),
      advance(2000),
      assert({
        requests: [
          pushReq(C1, 2, [setMember(1, BIND, "dash", "shift", hlc(T0))]),
        ],
        events: [changed([BIND], "remote"), changed([BIND], "local")],
      }),
      respond(
        e2eBody({
          serverNow: T0 + 2000,
          cursor: 4,
          lastMutationId: 1,
          results: [ok(1, 3)],
          changes: [
            change(BIND, { jump: "j", dash: "shift" }, 4, hlc(T0 + 500)),
          ],
        }),
        200,
        sealed(),
      ),
      assert({
        values: { [BIND]: val({ jump: "j", dash: "shift" }, "cloud") },
        events: [changed([BIND], "remote")],
        requests: [],
        journal: { [ALICE]: partition(C1, 2, 4, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add3({
    name: "e2e-locked-keeps-journal",
    description:
      "With no root for the ring the machine is locked: it sends nothing whatever the trigger, keeps the journal across a relaunch, reads its own edit in the clear and reads the snapshot as invalid.",
    rules: ["e2e-locked"],
    init: e2e({ hasRoot: false }),
    steps: [
      assert({ requests: [], status: st("locked", 0, "keyring") }),
      local("set", [VOL, 0.2], { ok: true }),
      advance(2000),
      assert({
        requests: [],
        values: { [VOL]: val(0.2, "pending") },
        states: { [VOL]: { sync: "pending", invalid: false, locked: false } },
        journal: {
          [ALICE]: partition(C1, 2, 0, [set(1, VOL, 0.2, hlc(T0))]),
        },
        status: st("locked", 1, "keyring"),
      }),
      local("flush"),
      local("refresh"),
      network("offline"),
      network("online"),
      assert({ requests: [], status: st("locked", 1, "keyring") }),
      { relaunch: {} },
      assert({
        requests: [],
        journal: {
          [ALICE]: partition(C1, 2, 0, [set(1, VOL, 0.2, hlc(T0))]),
        },
        status: st("locked", 1, "keyring"),
      }),
    ],
  });

  add3({
    name: "e2e-unlock-pushes",
    description:
      "Giving the machine its root confirms the Worker first (a pull), then pushes the held operations in mutationId order.",
    rules: ["e2e-locked"],
    init: e2e({ hasRoot: false }),
    steps: [
      local("set", [VOL, 0.1], { ok: true }),
      local("set", [BEST, 4], { ok: true }),
      advance(2000),
      assert({ requests: [], status: st("locked", 2, "keyring") }),
      root(true),
      assert({ requests: [pullReq(0, C1)], status: st("syncing", 2) }),
      respond(e2eBody({ serverNow: T0 + 2000, cursor: 1 })),
      assert({
        requests: [
          pushReq(C1, 1, [
            set(1, VOL, 0.1, hlc(T0)),
            cas(2, BEST, 4, "*", hlc(T0, 1)),
          ]),
        ],
        status: st("syncing", 2),
      }),
      respond(
        e2eBody({
          serverNow: T0 + 2000,
          cursor: 3,
          lastMutationId: 2,
          results: [ok(1, 2), ok(2, 3)],
          changes: [change(VOL, 0.1, 2, hlc(T0)), change(BEST, 4, 3, hlc(T0))],
        }),
        200,
        sealed(2),
      ),
      assert({
        values: { [VOL]: val(0.1, "cloud"), [BEST]: val(4, "cloud") },
        journal: { [ALICE]: partition(C1, 3, 3, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add3({
    name: "e2e-downgrade-refused",
    description:
      "An app that requires E2E (the default) drops a body that says server unread: the status is unsupported with sync-encryption-pinned, the journal and snapshot are kept, and nothing is sent until the Worker says e2e again.",
    rules: ["encryption-pinned"],
    init: e2e(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        e2eBody({
          serverNow: T0,
          cursor: 2,
          changes: [change(VOL, 0.5, 2, hlc(T0 - 1000))],
        }),
        200,
        sealed(),
      ),
      local("set", [QUAL, "high"], { ok: true }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 2, [set(1, QUAL, "high", hlc(T0))])],
      }),
      respond({
        ...pushBody({
          serverNow: T0 + 2000,
          cursor: 9,
          lastMutationId: 1,
          results: [ok(1, 9)],
          changes: [change(VOL, 0.9, 9, hlc(T0))],
        }),
        encryption: "server",
      }),
      assert({
        values: { [VOL]: val(0.5, "cloud"), [QUAL]: val("high", "pending") },
        journal: {
          [ALICE]: partition(C1, 2, 2, [set(1, QUAL, "high", hlc(T0))]),
        },
        status: {
          state: "unsupported",
          pending: 1,
          reason: "encryption",
          code: "sync-encryption-pinned",
        },
      }),
      advance(2000),
      local("flush"),
      network("offline"),
      network("online"),
      assert({
        requests: [],
        status: {
          state: "unsupported",
          pending: 1,
          reason: "encryption",
          code: "sync-encryption-pinned",
        },
      }),
    ],
  });

  add3({
    name: "e2e-legacy-plain-below-since",
    description:
      "A plaintext row is legacy data, and read, only while the host-mapped seq is below encryptionSince; at or above it the row is invalid. A sealed row is read, a later higher boundary does not revive a refused row, and a lower one reaches rows already held.",
    rules: ["encryption-since"],
    init: e2e(),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        e2eBody({
          serverNow: T0,
          cursor: 9,
          since: 5,
          changes: [
            change(VOL, 0.4, 3, hlc(T0 - 3000)),
            change(QUAL, "low", 7, hlc(T0 - 2000)),
            change(BEST, 15, 9, hlc(T0 - 1000)),
          ],
        }),
        200,
        { changes: [{ seq: 3 }, { seq: 7 }, { sealed: true }] },
      ),
      assert({
        values: {
          [VOL]: val(0.4, "cloud"),
          [QUAL]: val("medium", "document"),
          [BEST]: val(15, "cloud"),
        },
        states: {
          [VOL]: { sync: "synced", invalid: false, locked: false },
          [QUAL]: { sync: "synced", invalid: true, locked: false },
        },
        encryptionSince: 5,
      }),
      ...repull(9, 20),
      assert({ ...invalidity(QUAL, true), encryptionSince: 5 }),
      ...repull(9, 2),
      assert({ ...invalidity(VOL, true), encryptionSince: 2 }),
    ],
  });

  /** A pull at `cursor` goes out; the next step answers it. */
  const nextPull = (cursor: number): Obj[] => [
    network("offline"),
    network("online"),
    assert({ requests: [pullReq(cursor, C1)] }),
  ];
  /** A pull answered with `changes`, which the host found as `opened`. */
  const answer = (cursor: number, changes: Obj[], opened: Obj[]): Obj =>
    respond(e2eBody({ serverNow: T0, cursor, since: 5, changes }), 200, {
      changes: opened,
    });
  const forged = (name: string, description: string, steps: Obj[]): void =>
    add3({
      name,
      description,
      rules: ["forged-plaintext-rows"],
      init: e2e(),
      steps: [assert({ requests: [pullReq(0, C1)] }), ...steps],
    });
  const QUAL_UNSET = { [QUAL]: val("medium", "document") };

  forged(
    "e2e-forged-plain-change-at-or-below-cursor",
    "In E2E mode a pull made at cursor 9 cannot be answered with a change at version 2: it is ignored outright, so a plaintext row posing as legacy data (seq 2, below the boundary) neither shows nor marks the key invalid.",
    [
      answer(9, [change(VOL, 0.4, 9, hlc(T0 - 1000))], [{ sealed: true }]),
      ...nextPull(9),
      answer(12, [change(QUAL, "high", 2, hlc(T0))], [{ seq: 2 }]),
      assert({
        values: { [VOL]: val(0.4, "cloud"), ...QUAL_UNSET },
        ...invalidity(QUAL, false),
        encryptionSince: 5,
      }),
    ],
  );

  forged(
    "e2e-forged-plain-needs-cursor-below-since",
    "A plaintext row served to a pull whose cursor is already at or above encryptionSince is invalid, even when the host reports a seq below the boundary: legacy rows can only arrive before the boundary.",
    [
      answer(9, [], []),
      ...nextPull(9),
      answer(12, [change(QUAL, "high", 10, hlc(T0))], [{ seq: 3 }]),
      assert({
        values: QUAL_UNSET,
        ...invalidity(QUAL, true),
        encryptionSince: 5,
      }),
    ],
  );

  forged(
    "e2e-forged-plain-sealed-key-latched",
    "A key the device has opened sealed refuses plaintext for good: after the cursor expires and a snapshot replaces the rows, a plaintext row for that key with a seq below the boundary is invalid, while a plaintext row for a key never seen sealed stays legacy data.",
    [
      answer(
        9,
        [
          change(VOL, 0.4, 8, hlc(T0 - 2000)),
          change(QUAL, "low", 2, hlc(T0 - 1000)),
        ],
        [{ sealed: true }, { seq: 2 }],
      ),
      ...nextPull(9),
      respond(
        errorBody(
          "cursor_expired",
          "Cursor is older than the tombstone horizon.",
        ),
        410,
      ),
      assert({ requests: [pullReq(0, C1)] }),
      answer(
        20,
        [change(VOL, 0.9, 3, hlc(T0)), change(QUAL, "low", 2, hlc(T0 - 1000))],
        [{ seq: 3 }, { seq: 2 }],
      ),
      assert({
        values: { [VOL]: val(0.8, "document"), [QUAL]: val("low", "cloud") },
        ...invalidity(VOL, true),
        encryptionSince: 5,
      }),
    ],
  );

  add3({
    name: "server-mode-unchanged",
    description:
      "An app in server mode is not locked, not pinned and not subject to the client policy: it pushes at once, reads a body with no encryption member, writes a max key with no base version, and on conflict takes the server copy.",
    rules: ["e2e-client-policy", "encryption-pinned"],
    init: init({ hasRoot: false }),
    steps: [
      ...started(2, [change(BEST, 120, 2, hlc(T0 - 1000))]),
      local("set", [BEST, 150], { ok: true }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 2, [set(1, BEST, 150, hlc(T0))])],
        status: st("syncing", 1),
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 2,
          lastMutationId: 1,
          results: [
            conflict(1, { value: 200, version: 3, editedHlc: hlc(T0 - 500) }),
          ],
        }),
      ),
      assert({
        values: { [BEST]: val(200, "cloud") },
        requests: [],
        journal: { [ALICE]: partition(C1, 2, 2, []) },
        status: st("idle", 0),
      }),
    ],
  });

  forged(
    "e2e-conflict-plaintext-copy-refused",
    "A conflict's server copy is judged like a pulled row against the cursor the push carried: with that cursor already at or above encryptionSince, a plaintext copy is invalid even when the host reports a seq below the boundary, and the key never reads it as a cloud value.",
    [
      answer(9, [], []),
      local("set", [QUAL, "high"], { ok: true }),
      advance(2000),
      assert({ requests: [pushReq(C1, 9, [set(1, QUAL, "high", hlc(T0))])] }),
      respond(
        e2eBody({
          serverNow: T0 + 2000,
          cursor: 9,
          since: 5,
          lastMutationId: 1,
          results: [
            conflict(1, {
              value: "low",
              version: 8,
              editedHlc: hlc(T0 + 10_000),
            }),
          ],
        }),
        200,
        { conflicts: { 1: { seq: 3 } } },
      ),
      assert({
        values: QUAL_UNSET,
        ...invalidity(QUAL, true),
        journal: { [ALICE]: partition(C1, 2, 9, []) },
        encryptionSince: 5,
        status: st("idle", 0),
      }),
    ],
  );

  // ── U-09.11 (appended to version 4; WIRE-CONTRACT-V5 §13.3) ─────────────────────────────────

  const MERGE_CATALOG: Obj = {
    settings: CATALOG.settings!,
    collections: [
      ...(CATALOG.collections as Obj[]),
      { name: "profile", policy: "merge" },
    ],
  };
  s.push({
    name: "record-merge-fields",
    description:
      "A record in a merge collection sends one setField per changed field and one removeField per dropped field, each stamped, never a whole value; a field another device wrote arrives with the cloud copy.",
    rules: ["record-merge-fields"],
    wp: "U-09.11",
    init: init({ catalog: MERGE_CATALOG }),
    steps: [
      assert({ requests: [pullReq(0, C1)] }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 3,
          changes: [
            recChange("profile", "main", { name: "A", color: "red" }, 2),
          ],
        }),
      ),
      local(
        "put",
        ["profile", "main", { name: "A", color: "blue", level: 2 }],
        {
          ok: true,
        },
      ),
      assert({
        requests: [
          pushReq(C1, 3, [
            setField(1, "profile", "main", "color", "blue", hlc(T0)),
            setField(2, "profile", "main", "level", 2, hlc(T0)),
          ]),
        ],
        records: {
          "profile/main": val(
            { name: "A", color: "blue", level: 2 },
            "pending",
          ),
        },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 5,
          lastMutationId: 2,
          results: [ok(1, 3), ok(2, 4)],
          changes: [
            recChange(
              "profile",
              "main",
              { name: "A", color: "blue", level: 2, mood: "calm" },
              4,
            ),
          ],
        }),
      ),
      assert({
        records: {
          "profile/main": val(
            { name: "A", color: "blue", level: 2, mood: "calm" },
            "cloud",
          ),
        },
        status: st("idle", 0),
      }),
      advance(1000),
      local("put", ["profile", "main", { name: "A", level: 2, mood: "calm" }], {
        ok: true,
      }),
      assert({
        requests: [
          pushReq(C1, 5, [
            removeField(3, "profile", "main", "color", hlc(T0 + 1000)),
          ]),
        ],
        records: {
          "profile/main": val({ name: "A", level: 2, mood: "calm" }, "pending"),
        },
      }),
      respond(
        pushBody({
          serverNow: T0 + 1000,
          cursor: 6,
          lastMutationId: 3,
          results: [ok(3, 6)],
          changes: [
            recChange(
              "profile",
              "main",
              { name: "A", level: 2, mood: "calm" },
              6,
            ),
          ],
        }),
      ),
      assert({
        records: {
          "profile/main": val({ name: "A", level: 2, mood: "calm" }, "cloud"),
        },
        status: st("idle", 0),
      }),
    ],
  });

  // ── version 5 (U-08; plans/U-08.md §5) ───────────────────────────────────────────────────────
  const addV5 = (sc: Omit<Scenario, "wp">): void => {
    s.push({ ...sc, wp: "U-08" });
  };
  const PROGRESS_REQ = mergeReq(
    "progress",
    "main",
    side({ level: 4 }, 7),
    side({ level: 5 }, 8),
  );
  /** A pull, then a put that the server answers with a conflict: one request is open. */
  const opened = (): Obj[] => [
    ...started(9, [recChange("progress", "main", { level: 3 }, 7)]),
    local("put", ["progress", "main", { level: 4 }], { ok: true }),
    assert({
      requests: [pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)])],
      records: { "progress/main": val({ level: 4 }, "pending") },
    }),
    respond(
      pushBody({
        serverNow: T0,
        cursor: 10,
        lastMutationId: 1,
        results: [conflict(1, { value: { level: 5 }, version: 8 })],
        changes: [recChange("progress", "main", { level: 5 }, 8)],
      }),
    ),
  ];
  const openAsserts: Obj = {
    requests: [],
    conflicts: [PROGRESS_REQ],
    records: { "progress/main": val({ level: 4 }, "pending") },
    events: [conflictEv("progress", "main")],
    status: stc("idle", 0, 1),
  };

  addV5({
    name: "revision-conflict-opens-request",
    description:
      "A plain put on a revision collection that meets a conflict opens one MergeRequest: the server copy is remote, the device's copy is local on the version it was written on, nothing is enqueued, and the record keeps reading the device's copy.",
    rules: ["merge-request-open"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      advance(10_000),
      assert({
        requests: [],
        conflicts: [PROGRESS_REQ],
        status: stc("idle", 0, 1),
      }),
    ],
  });

  addV5({
    name: "merge-request-survives-relaunch",
    description:
      "An open request is journalled with the device's copy: after a relaunch it is listed again, with the same sides, and the record still reads the device's copy.",
    rules: ["merge-request-open", "relaunch"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      network("offline"),
      { relaunch: {} },
      assert({
        requests: [],
        conflicts: [PROGRESS_REQ],
        records: { "progress/main": val({ level: 4 }, "pending") },
        events: [],
        status: stc("offline", 0, 1),
      }),
    ],
  });

  addV5({
    name: "merge-request-partitioned",
    description:
      "A request belongs to its subject: signing out counts it as unsynced, another subject sees none, and the first subject's request is back at the next sign-in.",
    rules: ["merge-request-open", "partition"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      signOut(),
      assert({
        requests: [],
        conflicts: [],
        events: [signedOut("signOut", 1), unsynced(1)],
        status: st("local", 0),
      }),
      signIn(BOB),
      assert({ requests: [pullReq(0, C2)] }),
      respond(pullBody({ subject: BOB, serverNow: T0, cursor: 2 })),
      assert({
        conflicts: [],
        events: [],
        status: st("idle", 0),
      }),
      signOut(),
      signIn(ALICE),
      assert({
        requests: [pullReq(0, C1)],
        events: [signedOut("signOut", 0)],
      }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 10,
          changes: [recChange("progress", "main", { level: 5 }, 8)],
        }),
      ),
      assert({
        conflicts: [PROGRESS_REQ],
        records: { "progress/main": val({ level: 4 }, "pending") },
        events: [],
        status: stc("idle", 0, 1),
      }),
    ],
  });

  addV5({
    name: "merge-request-held-put",
    description:
      "While a request is open a later plain put replaces the request's local copy, is not sent, and the record reads it; the local version stays the base the copy was first written on.",
    rules: ["merge-request-freeze"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      local("put", ["progress", "main", { level: 6 }], { ok: true }),
      advance(10_000),
      assert({
        requests: [],
        conflicts: [
          mergeReq(
            "progress",
            "main",
            side({ level: 6 }, 7),
            side({ level: 5 }, 8),
          ),
        ],
        records: { "progress/main": val({ level: 6 }, "pending") },
        events: [],
        status: stc("idle", 0, 1),
      }),
    ],
  });

  addV5({
    name: "held-edit-joins-request",
    description:
      "An edit held behind an in-flight compare-and-swap that then meets a conflict becomes the request's local copy; nothing is rebased and nothing is enqueued.",
    rules: ["merge-request-freeze", "push-3-one-outstanding-cas"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...started(9, [recChange("progress", "main", { level: 3 }, 7)]),
      local("put", ["progress", "main", { level: 4 }]),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
      }),
      local("put", ["progress", "main", { level: 6 }]),
      assert({
        requests: [],
        journal: {
          [ALICE]: partition(
            C1,
            2,
            9,
            [put(1, "progress", "main", { level: 4 }, 7)],
            { "progress/main": { level: 6 } },
          ),
        },
        records: { "progress/main": val({ level: 6 }, "pending") },
        conflicts: [],
        status: st("syncing", 1),
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [conflict(1, { value: { level: 5 }, version: 8 })],
          changes: [recChange("progress", "main", { level: 5 }, 8)],
        }),
      ),
      assert({
        requests: [],
        conflicts: [
          mergeReq(
            "progress",
            "main",
            side({ level: 6 }, 7),
            side({ level: 5 }, 8),
          ),
        ],
        records: { "progress/main": val({ level: 6 }, "pending") },
        events: [conflictEv("progress", "main")],
        status: stc("idle", 0, 1),
      }),
      advance(10_000),
      assert({ requests: [], status: stc("idle", 0, 1) }),
    ],
  });

  addV5({
    name: "merge-request-delete-keeps-other",
    description:
      "While a request is open the collection's default delete is based on the device's version, so the server answers conflict: the other copy survives, the request closes as superseded and nothing is opened for the delete.",
    rules: ["merge-request-freeze"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      local("delete", ["progress", "main"], { ok: true }),
      assert({ requests: [pushReq(C1, 10, [del(2, "progress", "main", 7)])] }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 2,
          results: [conflict(2, { value: { level: 5 }, version: 8 })],
        }),
      ),
      assert({
        requests: [],
        conflicts: [],
        records: { "progress/main": val({ level: 5 }, "cloud") },
        events: [closedEv("progress", "main", "superseded")],
        status: st("idle", 0),
      }),
    ],
  });

  // Rule 38: keep.
  const applying = (): Obj =>
    mergeReq("progress", "main", side({ level: 4 }, 7), side({ level: 5 }, 8), {
      state: "applying",
    });
  /** The answer to the keep's set (mutation 2, based on the remote version 8). */
  const keepAck = (value: J): Obj =>
    respond(
      pushBody({
        serverNow: T0,
        cursor: 11,
        lastMutationId: 2,
        results: [ok(2, 9)],
        changes: [recChange("progress", "main", value, 9)],
      }),
    );

  addV5({
    name: "merge-keep-local",
    description:
      "Keeping the device's copy sends one set of it on the remote version; the request is applying until that set is acknowledged, then closes as local and the record reads the cloud.",
    rules: ["merge-request-keep"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      keep(PROGRESS_ID, "local"),
      assert({
        requests: [
          pushReq(C1, 10, [put(2, "progress", "main", { level: 4 }, 8)]),
        ],
        conflicts: [applying()],
        records: { "progress/main": val({ level: 4 }, "pending") },
        events: [],
      }),
      keepAck({ level: 4 }),
      assert({
        requests: [],
        conflicts: [],
        records: { "progress/main": val({ level: 4 }, "cloud") },
        events: [closedEv("progress", "main", "local")],
        status: st("idle", 0),
      }),
    ],
  });

  addV5({
    name: "merge-keep-remote",
    description:
      "Keeping the server's copy sends nothing: the request closes as remote at once and the record reads the server copy.",
    rules: ["merge-request-keep"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      keep(PROGRESS_ID, "remote"),
      assert({
        requests: [],
        conflicts: [],
        records: { "progress/main": val({ level: 5 }, "cloud") },
        events: [closedEv("progress", "main", "remote")],
        status: st("idle", 0),
      }),
      advance(10_000),
      assert({ requests: [], conflicts: [], status: st("idle", 0) }),
    ],
  });

  addV5({
    name: "merge-keep-value",
    description:
      "Keeping a value the person or the app composed sends one set of that value on the remote version, and closes as value once acknowledged.",
    rules: ["merge-request-keep"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      keep(PROGRESS_ID, { value: { level: 9 } }),
      assert({
        requests: [
          pushReq(C1, 10, [put(2, "progress", "main", { level: 9 }, 8)]),
        ],
        events: [],
      }),
      keepAck({ level: 9 }),
      assert({
        requests: [],
        conflicts: [],
        records: { "progress/main": val({ level: 9 }, "cloud") },
        events: [closedEv("progress", "main", "value")],
        status: st("idle", 0),
      }),
    ],
  });

  addV5({
    name: "merge-keep-conflicts-again",
    description:
      "A keep whose set meets another conflict reopens the request with the new server copy as remote and fires conflict again; the device's copy is unchanged and a second keep sends it on the new version.",
    rules: ["merge-request-keep"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      keep(PROGRESS_ID, "local"),
      assert({
        requests: [
          pushReq(C1, 10, [put(2, "progress", "main", { level: 4 }, 8)]),
        ],
        conflicts: [applying()],
        events: [],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 11,
          lastMutationId: 2,
          results: [conflict(2, { value: { level: 6 }, version: 10 })],
          changes: [recChange("progress", "main", { level: 6 }, 10)],
        }),
      ),
      assert({
        requests: [],
        conflicts: [
          mergeReq(
            "progress",
            "main",
            side({ level: 4 }, 7),
            side({ level: 6 }, 10),
          ),
        ],
        records: { "progress/main": val({ level: 4 }, "pending") },
        events: [conflictEv("progress", "main")],
        status: stc("idle", 0, 1),
      }),
      keep(PROGRESS_ID, "local"),
      assert({
        requests: [
          pushReq(C1, 11, [put(3, "progress", "main", { level: 4 }, 10)]),
        ],
        events: [],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 12,
          lastMutationId: 3,
          results: [ok(3, 11)],
          changes: [recChange("progress", "main", { level: 4 }, 11)],
        }),
      ),
      assert({
        requests: [],
        conflicts: [],
        records: { "progress/main": val({ level: 4 }, "cloud") },
        events: [closedEv("progress", "main", "local")],
        status: st("idle", 0),
      }),
    ],
  });

  addV5({
    name: "merge-decided-inline",
    description:
      "A host decider that answers keepRemote synchronously decides at once: no request is listed, no conflict event fires, nothing is sent and the record reads the server copy.",
    rules: ["merge-request-keep"],
    init: init({ catalog: INLINE_REMOTE_CATALOG }),
    steps: [
      ...started(9, [recChange("progress", "main", { level: 3 }, 7)]),
      local("put", ["progress", "main", { level: 4 }], { ok: true }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [conflict(1, { value: { level: 5 }, version: 8 })],
          changes: [recChange("progress", "main", { level: 5 }, 8)],
        }),
      ),
      assert({
        requests: [],
        conflicts: [],
        records: { "progress/main": val({ level: 5 }, "cloud") },
        events: [],
        status: st("idle", 0),
      }),
      advance(10_000),
      assert({ requests: [], conflicts: [], status: st("idle", 0) }),
    ],
  });

  addV5({
    name: "merge-keep-closed-refused",
    description:
      "A choice the request does not offer is bad_request and leaves it open; a keep on a request that has closed is sync-merge-closed. Neither sends anything or changes the record.",
    rules: ["merge-request-keep"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      keep(PROGRESS_ID, "both", { ok: false, error: "bad_request" }),
      assert({
        requests: [],
        conflicts: [PROGRESS_REQ],
        records: { "progress/main": val({ level: 4 }, "pending") },
        events: [],
        status: stc("idle", 0, 1),
      }),
      keep(PROGRESS_ID, "remote"),
      assert({
        conflicts: [],
        records: { "progress/main": val({ level: 5 }, "cloud") },
        events: [closedEv("progress", "main", "remote")],
        status: st("idle", 0),
      }),
      keep(PROGRESS_ID, "local", { ok: false, error: "sync-merge-closed" }),
      advance(10_000),
      assert({
        requests: [],
        conflicts: [],
        records: { "progress/main": val({ level: 5 }, "cloud") },
        events: [],
        status: st("idle", 0),
      }),
    ],
  });

  // Rule 39: the remote side follows the cloud.
  addV5({
    name: "merge-remote-moves-then-deleted",
    description:
      "A pulled change of the record replaces the request's remote; a pulled tombstone makes it null; keeping the device's copy then creates the record on a star base. The device's copy stays as written throughout.",
    rules: ["merge-request-remote"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...opened(),
      assert(openAsserts),
      network("offline"),
      network("online"),
      assert({ requests: [pullReq(10, C1)] }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 11,
          changes: [recChange("progress", "main", { level: 6 }, 9)],
        }),
      ),
      assert({
        requests: [],
        conflicts: [
          mergeReq(
            "progress",
            "main",
            side({ level: 4 }, 7),
            side({ level: 6 }, 9),
          ),
        ],
        records: { "progress/main": val({ level: 4 }, "pending") },
        events: [],
        status: stc("idle", 0, 1),
      }),
      network("offline"),
      network("online"),
      assert({ requests: [pullReq(11, C1)] }),
      respond(
        pullBody({
          serverNow: T0,
          cursor: 12,
          tombstones: [{ record: ["progress", "main"], version: 10 }],
        }),
      ),
      assert({
        requests: [],
        conflicts: [mergeReq("progress", "main", side({ level: 4 }, 7), null)],
        records: { "progress/main": val({ level: 4 }, "pending") },
        events: [],
        status: stc("idle", 0, 1),
      }),
      keep(PROGRESS_ID, "local"),
      assert({
        requests: [
          pushReq(C1, 12, [put(2, "progress", "main", { level: 4 }, "*")]),
        ],
        events: [],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 13,
          lastMutationId: 2,
          results: [ok(2, 11)],
          changes: [recChange("progress", "main", { level: 4 }, 11)],
        }),
      ),
      assert({
        requests: [],
        conflicts: [],
        records: { "progress/main": val({ level: 4 }, "cloud") },
        events: [closedEv("progress", "main", "local")],
        status: st("idle", 0),
      }),
    ],
  });

  // Rule 40: cloudEmpty.
  addV5({
    name: "cloud-empty-first-sign-in",
    description:
      "cloudEmpty is null before the first answer, true after a cursor-0 answer that says empty, and false once anything changes in the cloud.",
    rules: ["cloud-empty"],
    init: init(),
    steps: [
      assert({
        requests: [pullReq(0, C1)],
        cloudEmpty: null,
        status: st("syncing", 0),
      }),
      respond(pullBody({ serverNow: T0, cursor: 0 })),
      assert({ cloudEmpty: true, status: st("idle", 0) }),
      local("set", [VOL, 0.6], { ok: true }),
      advance(2000),
      assert({
        requests: [pushReq(C1, 0, [set(1, VOL, 0.6, hlc(T0))])],
        cloudEmpty: true,
      }),
      respond(
        pushBody({
          serverNow: T0 + 2000,
          cursor: 1,
          lastMutationId: 1,
          results: [ok(1, 1)],
          changes: [change(VOL, 0.6, 1, hlc(T0))],
        }),
      ),
      assert({ cloudEmpty: false, status: st("idle", 0) }),
    ],
  });

  addV5({
    name: "cloud-not-empty",
    description:
      "A cursor-0 answer that carries data does not say empty, so cloudEmpty is false; it is a per-subject view, null for a subject whose first answer has not come.",
    rules: ["cloud-empty"],
    init: init(),
    steps: [
      ...started(9, [recChange("progress", "main", { level: 3 }, 7)]),
      assert({ cloudEmpty: false, status: st("idle", 0) }),
      signOut(),
      signIn(BOB),
      assert({ requests: [pullReq(0, C2)], cloudEmpty: null }),
      respond(pullBody({ subject: BOB, serverNow: T0, cursor: 0 })),
      assert({ cloudEmpty: true, status: st("idle", 0) }),
    ],
  });

  return s;
}

// ── settingCases: catalog entries in, `syncedSettings` routes out (plans/U-01b.md §3.1) ──────

interface SettingCase {
  name: string;
  description: string;
  entries: Obj[];
  /** `userSettingIssues` of every entry, in entry order: a publish refuses any `error`. */
  issues: Obj[];
  /** `syncedSettings(entries)`, or `null` when an `error` issue means the catalog never
   *  publishes, so no client derives routes from it. */
  routes: Obj[] | null;
  /** Keys no entry declares: each has no route, so a client treats it as an open setting. */
  open: string[];
}

const entry = (key: string, schema: Obj, over: Obj = {}): Obj => ({
  key,
  kind: "config",
  category: "general",
  label: key,
  description: `The ${key} setting.`,
  schema,
  ...over,
});

function settingCases(): SettingCase[] {
  const volume = { type: "number", minimum: 0, maximum: 1 };
  const best = { type: "integer", minimum: 0 };
  return [
    {
      name: "default-user-scope",
      description:
        "An Editable config key with no user block is a synced setting: user scope, lastWrite, listed, with its schema.",
      entries: [entry(VOL, volume)],
      issues: [],
      routes: [
        {
          key: VOL,
          route: "synced",
          scope: "user",
          policy: "lastWrite",
          listed: true,
          schema: volume,
        },
      ],
      open: [],
    },
    {
      name: "platform-max",
      description:
        "A user block tunes the route: platform scope, the max policy on a number, and listed false.",
      entries: [
        entry(BEST, best, {
          user: { sync: "platform", conflict: "max", listed: false },
        }),
      ],
      issues: [],
      routes: [
        {
          key: BEST,
          route: "synced",
          scope: "platform",
          policy: "max",
          listed: false,
          schema: best,
        },
      ],
      open: [],
    },
    {
      name: "local-key",
      description:
        "user.sync local keeps the key on the device: a local route.",
      entries: [entry(WINDOW, { type: "string" }, { user: { sync: "local" } })],
      issues: [],
      routes: [{ key: WINDOW, route: "local" }],
      open: [],
    },
    {
      name: "catalog-locked",
      description:
        "managementDefault enforced or hidden locks the key whatever its user block says; the block is a no-op warning.",
      entries: [
        entry(
          THEME,
          { type: "string" },
          { managementDefault: "enforced", user: { sync: "user" } },
        ),
        entry(REGION, { type: "string" }, { managementDefault: "hidden" }),
      ],
      issues: [
        {
          key: THEME,
          code: "user_setting_locked_default",
          severity: "warning",
        },
      ],
      routes: [
        { key: THEME, route: "locked" },
        { key: REGION, route: "locked" },
      ],
      open: [],
    },
    {
      name: "secret-and-flag",
      description:
        "A secret and a flag are never a person's setting: refused routes (config.set answers bad_request while Cloud Sync is on).",
      entries: [
        entry(TOKEN, { type: "string" }, { kind: "secret" }),
        entry(BETA, { type: "boolean" }, { kind: "flag" }),
      ],
      issues: [],
      routes: [
        { key: TOKEN, route: "refused" },
        { key: BETA, route: "refused" },
      ],
      open: [],
    },
    {
      name: "undeclared-key-is-open",
      description:
        "A key the catalog does not declare gets no route: the client syncs it as an open setting.",
      entries: [entry(QUAL, { type: "string" })],
      issues: [],
      routes: [
        {
          key: QUAL,
          route: "synced",
          scope: "user",
          policy: "lastWrite",
          listed: true,
          schema: { type: "string" },
        },
      ],
      open: [OPEN, OPEN2],
    },
    {
      name: "array-merge-refused",
      description:
        "merge stays object-only: a list setting cannot combine (a set is an object of booleans), so a publish refuses it and no client derives routes.",
      entries: [
        entry(
          "ui.recentDecks",
          { type: "array", items: { type: "string" }, uniqueItems: true },
          { user: { conflict: "merge" } },
        ),
      ],
      issues: [
        {
          key: "ui.recentDecks",
          code: "user_conflict_type_mismatch",
          severity: "error",
        },
      ],
      routes: null,
      open: [],
    },
    {
      name: "device-scope-retired",
      description:
        "user.sync device is retired with no alias: a publish refuses it (use local).",
      entries: [entry(BIND, { type: "object" }, { user: { sync: "device" } })],
      issues: [{ key: BIND, code: "invalid_user_setting", severity: "error" }],
      routes: null,
      open: [],
    },
  ];
}

// ── the self-check ─────────────────────────────────────────────────────────────────────────

const HLC_RE = /^[0-9a-f]{12}:[0-9a-f]{4}$/;
const CLIENT_ID_RE = /^c_[A-Za-z0-9_-]{22}$/;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(v: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(v)) for (const x of v) walk(x, visit);
  else if (isObj(v))
    for (const [k, x] of Object.entries(v)) {
      visit(k, x);
      walk(x, visit);
    }
}

function selfCheck(file: Obj): void {
  const fail = (m: string): never => {
    throw new Error(`sync-scenarios: ${m}`);
  };
  const ruleIds = new Set(RULES.map((r) => r.id));
  if (ruleIds.size !== RULES.length) fail("duplicate rule id");
  const covered = new Set<string>();
  const names = new Set<string>();
  for (const sc of file.scenarios as unknown as Scenario[]) {
    const at = (m: string): never => fail(`${sc.name}: ${m}`);
    if (!NAME_RE.test(sc.name)) at("name is not kebab-case");
    if (names.has(sc.name)) at("duplicate name");
    names.add(sc.name);
    if (sc.rules.length === 0) at("no rules");
    for (const r of sc.rules) {
      if (!ruleIds.has(r)) at(`unknown rule ${r}`);
      covered.add(r);
    }
    for (const id of sc.init.clientIds as string[])
      if (!CLIENT_ID_RE.test(id)) at(`bad clientId ${id}`);
    if (sc.steps.length === 0) at("no steps");
    if (!("assert" in sc.steps[sc.steps.length - 1]!))
      at("does not end with an assert");
    // A fresh mutationId is above every id the same clientId already sent; a resend repeats one.
    const sent = new Map<string, Set<number>>();
    // Request ids a `conflicts` assert or a `conflict` event shows before a `keep` names one.
    const opened = new Set<string>();
    sc.steps.forEach((step, i) => {
      const keys = Object.keys(step);
      if (keys.length !== 1 || !(STEPS as readonly string[]).includes(keys[0]!))
        at(`step ${i} is not exactly one of ${STEPS.join(", ")}`);
      const body = step[keys[0]!];
      if (!isObj(body)) return at(`step ${i} is not an object`);
      if (
        keys[0] === "local" &&
        !(CALLS as readonly string[]).includes(String(body.call))
      )
        at(`step ${i}: unknown call ${String(body.call)}`);
      if (keys[0] === "keep") {
        const c = body.choice;
        const valid =
          c === "local" ||
          c === "remote" ||
          c === "both" ||
          (isObj(c) && Object.keys(c).join() === "value");
        if (typeof body.request !== "string" || !valid)
          at(`step ${i}: keep needs a request id and a choice`);
        if (
          body.expect !== undefined &&
          !(
            isObj(body.expect) &&
            body.expect.ok === false &&
            typeof body.expect.error === "string"
          )
        )
          at(`step ${i}: keep expect is {ok: false, error}`);
        if (!opened.has(String(body.request)))
          at(
            `step ${i}: keep names ${String(body.request)}, which no earlier step opened`,
          );
      }
      if (
        keys[0] === "respond" &&
        !(body.error === "transport" || Number.isInteger(body.status))
      )
        at(`step ${i}: respond needs a status or error: transport`);
      if (keys[0] === "assert") {
        for (const r of (body.conflicts as Obj[] | undefined) ?? [])
          opened.add(String(r.id));
        for (const e of (body.events as Obj[] | undefined) ?? [])
          if (e.type === "conflict") opened.add(String(e.id));
        for (const k of Object.keys(body))
          if (!(ASSERTS as readonly string[]).includes(k))
            at(`step ${i}: unknown assert ${k}`);
        for (const req of (body.requests as Obj[] | undefined) ?? []) {
          const b = req.body;
          if (!isObj(b)) continue;
          const id = String(b.clientId);
          if (!CLIENT_ID_RE.test(id)) at(`step ${i}: bad clientId ${id}`);
          const seen = sent.get(id) ?? new Set<number>();
          const ids = (b.mutations as Obj[]).map((m) => m.mutationId as number);
          for (let k = 1; k < ids.length; k++)
            if (ids[k]! <= ids[k - 1]!)
              at(`step ${i}: mutationIds not increasing in one push`);
          const max = Math.max(0, ...seen);
          for (const m of ids)
            if (!seen.has(m) && m <= max)
              at(`step ${i}: fresh mutationId ${m} ≤ ${max}`);
          for (const m of ids) seen.add(m);
          sent.set(id, seen);
        }
      }
    });
    walk(sc, (k, v) => {
      if (k === "editedHlc" && (typeof v !== "string" || !HLC_RE.test(v)))
        at(`bad editedHlc ${String(v)}`);
    });
  }
  for (const r of ruleIds)
    if (!covered.has(r)) fail(`rule ${r} has no scenario`);
  const caseNames = new Set<string>();
  for (const c of file.settingCases as unknown as SettingCase[]) {
    const at = (m: string): never => fail(`settingCases ${c.name}: ${m}`);
    if (!NAME_RE.test(c.name)) at("name is not kebab-case");
    if (caseNames.has(c.name)) at("duplicate name");
    caseNames.add(c.name);
    const keys = new Set(c.entries.map((e) => String(e.key)));
    const refused = c.issues.some((i) => i.severity === "error");
    if (refused !== (c.routes === null))
      at("routes is null exactly when an issue is an error");
    for (const i of c.issues)
      if (!keys.has(String(i.key))) at(`issue for undeclared ${String(i.key)}`);
    if (c.routes) {
      const routed = c.routes.map((r) => String(r.key));
      if (routed.join() !== [...keys].join())
        at("one route per entry, in entry order");
    }
    for (const k of c.open) if (keys.has(k)) at(`open key ${k} is declared`);
  }
}

// ── file records (U-22.5; plans/U-22.5.md §2–§3) ────────────────────────────────────────────
// The records binding of `cloudSync.saves`: rows keep the pull's `file` pointer, `records()` lists
// a collection, `putAt` / `removeAt` write at an exact version and report one outcome each. A
// separate family, so every case above is untouched. Steps and asserts are the ones above plus
// `local` calls `putAt` and `removeAt`, and the asserts `rows` (a collection's cloud rows, as
// `records(collection)` lists them) and `outcomes` (what `onOutcome` reported since the previous
// assert, in order). The host codec's `wireId` is not a machine call and has no case here.

const FILE_RECORD_CALLS = ["putAt", "removeAt"] as const;
const FILE_RECORD_ASSERTS = ["rows", "outcomes"] as const;

const F1: Obj = {
  version: 6,
  size: 1200,
  sha256: "a".repeat(64),
  format: "whole",
};
const F2: Obj = {
  version: 7,
  size: 90000,
  sha256: "b".repeat(64),
  format: "chunks",
};

/** A record change; `value` undefined is a file-only row (§13.4). */
const recF = (
  collection: string,
  rid: string,
  value: J | undefined,
  version: number,
  file?: Obj,
): Obj => ({
  record: [collection, rid],
  ...(value === undefined ? {} : { value }),
  version,
  ...(file ? { file } : {}),
});
/** A blinded record id (`x:` and 43 base64url characters), as an E2E file-only row carries. */
const BLINDED = `x:${"A".repeat(43)}`;
const ticketed = (m: Obj, ticket: number): Obj => ({ ...m, ticket });
const del = (
  id: number,
  collection: string,
  rid: string,
  base: number,
): Obj => ({
  mutationId: id,
  target: { record: [collection, rid] },
  op: "delete",
  baseVersion: base,
});
const rowOf = (
  id: string,
  value: J,
  version: number,
  file: Obj | null,
): Obj => ({
  id,
  value,
  version,
  file,
});
const rowsAre = (rows: Obj[]): Obj => ({ rows: { progress: rows } });
const outOk = (id: number, version: number): Obj => ({
  mutationId: id,
  status: "ok",
  version,
});

function fileRecordCases(): Scenario[] {
  const s: Scenario[] = [];
  const add = (sc: Omit<Scenario, "wp">): void => {
    s.push({ ...sc, wp: "U-22.5" });
  };
  const rule = ["push-2-conflict-new-mutation"];
  const e2eBody = (a: PullArgs): Obj => ({
    ...pullBody(a),
    encryption: "e2e",
    encryptionSince: 0,
  });

  add({
    name: "file-row-keeps-pointer",
    description:
      "A pulled record keeps its file pointer next to its value; records() lists it.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7, F1)]),
      assert({
        ...rowsAre([rowOf("main", { level: 3 }, 7, F1)]),
        records: { "progress/main": val({ level: 3 }, "cloud") },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "file-only-row-is-good",
    description:
      "A record with a file and no value is a good row with a null value (server mode).",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "slot", undefined, 8, F2)]),
      assert({
        ...rowsAre([rowOf("slot", null, 8, F2)]),
        records: { "progress/slot": val(null, "cloud") },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "file-only-row-e2e",
    description:
      "In end-to-end mode a file-only row carries nothing to judge and stays readable, while a plaintext row with a value at or above encryptionSince is still unreadable.",
    rules: rule,
    init: init({ encryption: "e2e" }),
    steps: [
      assert({ requests: [pullReq(0, C1)], status: st("syncing", 0) }),
      respond(
        e2eBody({
          serverNow: T0,
          cursor: 9,
          changes: [
            recF("progress", BLINDED, undefined, 8, F2),
            recF("progress", "plain", { level: 1 }, 9, F1),
          ],
        }),
        200,
        { changes: [{ seq: 8 }, { seq: 9 }] },
      ),
      assert({
        ...rowsAre([rowOf(BLINDED, null, 8, F2)]),
        records: { [`progress/${BLINDED}`]: val(null, "cloud") },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "file-only-row-invalid-is-bad",
    description:
      "A record change the host could not open (a garbage ct) is unreadable even when it names a file: the pointer is not taken and the row is not listed.",
    rules: rule,
    init: init({ encryption: "e2e" }),
    steps: [
      assert({ requests: [pullReq(0, C1)], status: st("syncing", 0) }),
      respond(
        e2eBody({
          serverNow: T0,
          cursor: 9,
          changes: [recF("progress", BLINDED, undefined, 8, F2)],
        }),
        200,
        { changes: [{ invalid: true }] },
      ),
      assert({
        ...rowsAre([]),
        records: { [`progress/${BLINDED}`]: null },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "file-only-row-e2e-plain-id-is-not-a-save",
    description:
      "In end-to-end mode a file-only row under a plain (unblinded) id is not a save: it is unreadable, like any plaintext row at or above encryptionSince.",
    rules: rule,
    init: init({ encryption: "e2e" }),
    steps: [
      assert({ requests: [pullReq(0, C1)], status: st("syncing", 0) }),
      respond(
        e2eBody({
          serverNow: T0,
          cursor: 9,
          changes: [recF("progress", "slot1", undefined, 8, F2)],
        }),
        200,
        { changes: [{ seq: 8 }] },
      ),
      assert({
        ...rowsAre([]),
        records: { "progress/slot1": null },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "file-row-e2e-sealed",
    description:
      "A sealed record that has a file keeps the pointer beside the value the host opened.",
    rules: rule,
    init: init({ encryption: "e2e" }),
    steps: [
      assert({ requests: [pullReq(0, C1)], status: st("syncing", 0) }),
      respond(
        e2eBody({
          serverNow: T0,
          cursor: 9,
          changes: [recF("progress", "main", { level: 3 }, 7, F1)],
        }),
        200,
        { changes: [{ sealed: true }] },
      ),
      assert({
        ...rowsAre([rowOf("main", { level: 3 }, 7, F1)]),
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-ok",
    description:
      "putAt pushes one set at exactly the version given; its acknowledgement is one ok outcome and the row moves to the new version, file kept.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7, F1)]),
      local("putAt", ["progress", "main", { level: 4 }, 7], {
        ok: true,
        mutationId: 1,
      }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
        journal: {
          [ALICE]: partition(C1, 2, 9, [
            ticketed(put(1, "progress", "main", { level: 4 }, 7), 1),
          ]),
        },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [ok(1, 8)],
          changes: [recF("progress", "main", { level: 4 }, 8, F1)],
        }),
      ),
      assert({
        outcomes: [outOk(1, 8)],
        ...rowsAre([rowOf("main", { level: 4 }, 8, F1)]),
        journal: { [ALICE]: partition(C1, 2, 10, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-create",
    description: 'putAt at "*" creates a record that does not exist yet.',
    rules: rule,
    init: init(),
    steps: [
      ...started(9),
      local("putAt", ["progress", "fresh", { level: 1 }, "*"], {
        ok: true,
        mutationId: 1,
      }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "fresh", { level: 1 }, "*")]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [ok(1, 10)],
          changes: [recF("progress", "fresh", { level: 1 }, 10)],
        }),
      ),
      assert({
        outcomes: [outOk(1, 10)],
        ...rowsAre([rowOf("fresh", { level: 1 }, 10, null)]),
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-not-coalesced",
    description:
      "A putAt is its own mutation: a later put coalesces into the queued put, never into the putAt. When the server has moved on, the putAt reports a conflict with the server copy and is not rebased.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7)]),
      network("offline"),
      local("put", ["progress", "main", { level: 4 }], { ok: true }),
      local("putAt", ["progress", "main", { level: 5 }, 7], {
        ok: true,
        mutationId: 1,
      }),
      local("put", ["progress", "main", { level: 6 }], { ok: true }),
      assert({
        journal: {
          [ALICE]: partition(C1, 3, 9, [
            put(1, "progress", "main", { level: 6 }, 7),
            ticketed(put(2, "progress", "main", { level: 5 }, 7), 1),
          ]),
        },
      }),
      network("online"),
      assert({
        requests: [
          pushReq(C1, 9, [
            put(1, "progress", "main", { level: 6 }, 7),
            put(2, "progress", "main", { level: 5 }, 7),
          ]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 2,
          results: [ok(1, 8), conflict(2, { value: { level: 6 }, version: 8 })],
          changes: [recF("progress", "main", { level: 6 }, 8)],
        }),
      ),
      assert({
        outcomes: [
          {
            mutationId: 1,
            status: "conflict",
            server: { value: { level: 6 }, version: 8, file: null },
          },
        ],
        requests: [],
        ...rowsAre([rowOf("main", { level: 6 }, 8, null)]),
        journal: { [ALICE]: partition(C1, 3, 10, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-conflict-not-rebased",
    description:
      "A stale putAt under a keep-local collection reports the server copy, file pointer included, and sends nothing more.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7, F1)]),
      local("putAt", ["progress", "main", { level: 4 }, 7], {
        ok: true,
        mutationId: 1,
      }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [conflict(1, { value: { level: 5 }, version: 8, file: F1 })],
          changes: [recF("progress", "main", { level: 5 }, 8, F1)],
        }),
      ),
      assert({
        outcomes: [
          {
            mutationId: 1,
            status: "conflict",
            server: { value: { level: 5 }, version: 8, file: F1 },
          },
        ],
        requests: [],
        ...rowsAre([rowOf("main", { level: 5 }, 8, F1)]),
        journal: { [ALICE]: partition(C1, 2, 10, []) },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-rejected",
    description:
      "A refused putAt reports one rejected outcome (and the rejected event); the row is unchanged.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7, F1)]),
      local("putAt", ["progress", "main", { level: 4 }, 7], {
        ok: true,
        mutationId: 1,
      }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 9,
          lastMutationId: 1,
          results: [rejected(1, "quota_exceeded")],
        }),
      ),
      assert({
        outcomes: [
          { mutationId: 1, status: "rejected", code: "quota_exceeded" },
        ],
        events: [{ type: "rejected", mutationId: 1, code: "quota_exceeded" }],
        ...rowsAre([rowOf("main", { level: 3 }, 7, F1)]),
        journal: { [ALICE]: partition(C1, 2, 9, []) },
      }),
    ],
  });

  add({
    name: "remove-at-ok",
    description:
      "removeAt pushes one delete at exactly the version given; the acknowledgement removes the row.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7, F1)]),
      local("removeAt", ["progress", "main", 7], { ok: true, mutationId: 1 }),
      assert({
        requests: [pushReq(C1, 9, [del(1, "progress", "main", 7)])],
        records: { "progress/main": null },
        journal: {
          [ALICE]: partition(C1, 2, 9, [
            ticketed(del(1, "progress", "main", 7), 1),
          ]),
        },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [ok(1, 9)],
          tombstones: [{ record: ["progress", "main"], version: 9 }],
        }),
      ),
      assert({
        outcomes: [outOk(1, 9)],
        ...rowsAre([]),
        records: { "progress/main": null },
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-dropped-on-sign-out",
    description:
      "A putAt still pending at sign-out is not kept: its caller is told it was dropped, and it is not counted as unsynced data.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7)]),
      network("offline"),
      local("putAt", ["progress", "main", { level: 4 }, 7], {
        ok: true,
        mutationId: 1,
      }),
      signOut(),
      assert({
        outcomes: [{ mutationId: 1, status: "dropped" }],
        events: [signedOut("signOut", 0)],
        ...rowsAre([]),
        journal: { [ALICE]: partition(C1, 2, 0, []) },
        status: st("local", 0),
      }),
    ],
  });

  add({
    name: "put-at-survives-relaunch",
    description:
      "A queued putAt is journalled with its id: after a relaunch it is sent unchanged and still reports its outcome under the id it returned.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7)]),
      network("offline"),
      local("putAt", ["progress", "main", { level: 4 }, 7], {
        ok: true,
        mutationId: 1,
      }),
      { relaunch: {} },
      assert({
        journal: {
          [ALICE]: partition(C1, 2, 9, [
            ticketed(put(1, "progress", "main", { level: 4 }, 7), 1),
          ]),
        },
      }),
      network("online"),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [ok(1, 8)],
          changes: [recF("progress", "main", { level: 4 }, 8)],
        }),
      ),
      assert({
        outcomes: [outOk(1, 8)],
        ...rowsAre([rowOf("main", { level: 4 }, 8, null)]),
      }),
    ],
  });

  add({
    name: "put-at-ticket-survives-renumbering",
    description:
      "A client_mismatch renumbers pending mutations from 1; tickets are a separate counter, so a ticket stays what putAt returned and a new one never collides with a pending one.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9),
      local("putAt", ["progress", "a", { n: 1 }, "*"], {
        ok: true,
        mutationId: 1,
      }),
      assert({
        requests: [pushReq(C1, 9, [put(1, "progress", "a", { n: 1 }, "*")])],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [ok(1, 10)],
          changes: [recF("progress", "a", { n: 1 }, 10)],
        }),
      ),
      local("putAt", ["progress", "b", { n: 2 }, "*"], {
        ok: true,
        mutationId: 2,
      }),
      assert({
        outcomes: [outOk(1, 10)],
        requests: [pushReq(C1, 10, [put(2, "progress", "b", { n: 2 }, "*")])],
      }),
      respond(
        errorBody("client_mismatch", "clientId belongs to another device."),
        409,
      ),
      local("putAt", ["progress", "c", { n: 3 }, "*"], {
        ok: true,
        mutationId: 3,
      }),
      assert({
        requests: [pushReq(C2, 10, [put(1, "progress", "b", { n: 2 }, "*")])],
        journal: {
          [ALICE]: partition(C2, 3, 10, [
            ticketed(put(1, "progress", "b", { n: 2 }, "*"), 2),
            ticketed(put(2, "progress", "c", { n: 3 }, "*"), 3),
          ]),
        },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 11,
          lastMutationId: 1,
          results: [ok(1, 11)],
          changes: [recF("progress", "b", { n: 2 }, 11)],
        }),
      ),
      assert({
        outcomes: [outOk(2, 11)],
        requests: [pushReq(C2, 11, [put(2, "progress", "c", { n: 3 }, "*")])],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 12,
          lastMutationId: 2,
          results: [ok(2, 12)],
          changes: [recF("progress", "c", { n: 3 }, 12)],
        }),
      ),
      assert({
        outcomes: [outOk(3, 12)],
        ...rowsAre([
          rowOf("a", { n: 1 }, 10, null),
          rowOf("b", { n: 2 }, 11, null),
          rowOf("c", { n: 3 }, 12, null),
        ]),
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-refused",
    description:
      "putAt and removeAt answer collection-unknown for a collection that is not a declared revision collection, and signed-out with no person.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9),
      local("putAt", ["unlocks", "x", 1, "*"], {
        ok: false,
        error: "collection-unknown",
      }),
      local("putAt", ["nope", "x", 1, "*"], {
        ok: false,
        error: "collection-unknown",
      }),
      local("removeAt", ["unlocks", "x", 1], {
        ok: false,
        error: "collection-unknown",
      }),
      signOut(),
      local("putAt", ["progress", "x", 1, "*"], {
        ok: false,
        error: "signed-out",
      }),
      assert({
        requests: [],
        outcomes: [],
        journal: { [ALICE]: partition(C1, 1, 0, []) },
        status: st("local", 0),
      }),
    ],
  });

  add({
    name: "put-at-file-pointer-create",
    description:
      "putAt given the pointer finalize returned: the request carries no file, the journal holds it beside the ticket, and after ok a new row lists that file with the new version.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9),
      local("putAt", ["progress", "fresh", { level: 1 }, "*", F2], {
        ok: true,
        mutationId: 1,
      }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "fresh", { level: 1 }, "*")]),
        ],
        journal: {
          [ALICE]: partition(C1, 2, 9, [
            ticketed(
              { ...put(1, "progress", "fresh", { level: 1 }, "*"), file: F2 },
              1,
            ),
          ]),
        },
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [ok(1, 10)],
        }),
      ),
      assert({
        outcomes: [outOk(1, 10)],
        ...rowsAre([rowOf("fresh", { level: 1 }, 10, F2)]),
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-file-pointer-update",
    description:
      "putAt given a newer pointer on a row that has a file: after ok the row holds the new pointer, not the old one.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7, F1)]),
      local("putAt", ["progress", "main", { level: 4 }, 7, F2], {
        ok: true,
        mutationId: 1,
      }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [ok(1, 8)],
        }),
      ),
      assert({
        outcomes: [outOk(1, 8)],
        ...rowsAre([rowOf("main", { level: 4 }, 8, F2)]),
        status: st("idle", 0),
      }),
    ],
  });

  add({
    name: "put-at-without-pointer-keeps-file",
    description:
      "putAt with no pointer on a row that has a file: after ok the row keeps the prior file.",
    rules: rule,
    init: init(),
    steps: [
      ...started(9, [recF("progress", "main", { level: 3 }, 7, F1)]),
      local("putAt", ["progress", "main", { level: 4 }, 7], {
        ok: true,
        mutationId: 1,
      }),
      assert({
        requests: [
          pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)]),
        ],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 10,
          lastMutationId: 1,
          results: [ok(1, 8)],
        }),
      ),
      assert({
        outcomes: [outOk(1, 8)],
        ...rowsAre([rowOf("main", { level: 4 }, 8, F1)]),
        status: st("idle", 0),
      }),
    ],
  });

  // Version 5: an exact write of a record with an open request supersedes it (plans/U-08.md §2.3
  // rule 4). These two use a revision collection with no inline decider.
  const addV5 = (sc: Omit<Scenario, "wp">): void => {
    s.push({ ...sc, wp: "U-08" });
  };
  const openedRequest = (): Obj[] => [
    ...started(9, [recF("progress", "main", { level: 3 }, 7)]),
    local("put", ["progress", "main", { level: 4 }], { ok: true }),
    assert({
      requests: [pushReq(C1, 9, [put(1, "progress", "main", { level: 4 }, 7)])],
    }),
    respond(
      pushBody({
        serverNow: T0,
        cursor: 10,
        lastMutationId: 1,
        results: [conflict(1, { value: { level: 5 }, version: 8 })],
        changes: [recF("progress", "main", { level: 5 }, 8)],
      }),
    ),
    assert({
      requests: [],
      conflicts: [
        mergeReq(
          "progress",
          "main",
          side({ level: 4 }, 7),
          side({ level: 5 }, 8),
        ),
      ],
      events: [conflictEv("progress", "main")],
      status: stc("idle", 0, 1),
    }),
  ];

  addV5({
    name: "put-at-supersedes-request",
    description:
      "A putAt of a record with an open request closes the request as superseded and is sent as asked, on the version given; the outcome is the putAt's own.",
    rules: ["merge-request-freeze"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...openedRequest(),
      local("putAt", ["progress", "main", { level: 7 }, 8], {
        ok: true,
        mutationId: 2,
      }),
      assert({
        requests: [
          pushReq(C1, 10, [put(2, "progress", "main", { level: 7 }, 8)]),
        ],
        conflicts: [],
        events: [closedEv("progress", "main", "superseded")],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 11,
          lastMutationId: 2,
          results: [ok(2, 9)],
          changes: [recF("progress", "main", { level: 7 }, 9)],
        }),
      ),
      assert({
        outcomes: [outOk(2, 9)],
        conflicts: [],
        ...rowsAre([rowOf("main", { level: 7 }, 9, null)]),
        status: st("idle", 0),
      }),
    ],
  });

  addV5({
    name: "remove-at-supersedes-request",
    description:
      "A removeAt of a record with an open request closes the request as superseded and is sent as asked, on the version given.",
    rules: ["merge-request-freeze"],
    init: init({ catalog: CONFLICT_CATALOG }),
    steps: [
      ...openedRequest(),
      local("removeAt", ["progress", "main", 8], { ok: true, mutationId: 2 }),
      assert({
        requests: [pushReq(C1, 10, [del(2, "progress", "main", 8)])],
        conflicts: [],
        events: [closedEv("progress", "main", "superseded")],
      }),
      respond(
        pushBody({
          serverNow: T0,
          cursor: 11,
          lastMutationId: 2,
          results: [ok(2, 9)],
          tombstones: [{ record: ["progress", "main"], version: 9 }],
        }),
      ),
      assert({
        outcomes: [outOk(2, 9)],
        conflicts: [],
        ...rowsAre([]),
        records: { "progress/main": null },
        status: st("idle", 0),
      }),
    ],
  });

  return s;
}

function checkFileRecordCases(cases: Scenario[]): void {
  const fail = (m: string): never => {
    throw new Error(`sync-scenarios fileRecordCases: ${m}`);
  };
  const names = new Set<string>();
  for (const sc of cases) {
    if (!NAME_RE.test(sc.name)) fail(`${sc.name}: name is not kebab-case`);
    if (names.has(sc.name)) fail(`${sc.name}: duplicate name`);
    names.add(sc.name);
    if (!("assert" in sc.steps[sc.steps.length - 1]!))
      fail(`${sc.name}: does not end with an assert`);
    for (const step of sc.steps) {
      const body = Object.values(step)[0];
      if (!isObj(body)) fail(`${sc.name}: a step is not an object`);
      if ("assert" in step)
        for (const k of Object.keys(body as Obj))
          if (
            !(ASSERTS as readonly string[]).includes(k) &&
            !(FILE_RECORD_ASSERTS as readonly string[]).includes(k)
          )
            fail(`${sc.name}: unknown assert ${k}`);
      if (
        "local" in step &&
        !(CALLS as readonly string[]).includes(String((body as Obj).call)) &&
        !(FILE_RECORD_CALLS as readonly string[]).includes(
          String((body as Obj).call),
        )
      )
        fail(`${sc.name}: unknown call`);
    }
  }
}

export function buildSyncScenarios(): Obj {
  const file: Obj = {
    syncScenariosVersion: SYNC_SCENARIOS_VERSION,
    description:
      "Cloud Sync client behaviour, outside the wire contract (WIRE-CONTRACT-V4 §11.5, plans/U-01.md §4.1 as amended by plans/U-01b.md §4). Each scenario starts from `init` (when `legacyLocal` is not null, the client first imports it as its legacy `config.local` store) and runs its steps in order against a fake clock and a fake transport: `local` calls the SDK, `advance` moves the clock (firing debounce commits and the sign-out deadline), `network` goes online or offline, `respond` answers the one request in flight, `signIn`, `signOut` and `relaunch` act on the device, and `assert` compares the listed views. `requests` and `events` are what was sent and emitted since the previous assert. `settingCases` pins the setting routes a host derives from catalog entries (`syncedSettings`) and the user-block issues a publish reports. Version 5 adds the conflict vocabulary: the `keep` step (`request`, `choice`, and an `expect` of `{ok: false, error}` when the keep is refused at once), the `delete` call, the asserts `conflicts` and `cloudEmpty`, the events `conflict` and `conflictClosed`, and `status.conflicts` (the open count, present only above 0); a collection's `resolve` is the host's inline decider (`keepLocal` or `keepRemote`). Version 3 adds the end-to-end policy: `init.encryption` and `init.hasRoot`, the `root` step (the device gains or loses the ring's root), `respond.opened` (what the host codec found for each opened row; the fake transport itself speaks plaintext) and the `encryptionSince` assert. Literal data, not generated by an implementation. `fileRecordCases` (appended with the records binding of cloudSync.saves, plans/U-22.5.md) is a second family run by the same steps: its `calls` add `putAt` and `removeAt`, its `asserts` add `rows` (a collection's cloud rows, as `records(collection)` lists them) and `outcomes` (what `onOutcome` reported since the previous assert); its rows keep the pull's `file` pointer, and `putAt` takes an optional fifth argument, the file pointer the save's finalize returned, which an acknowledged `ok` adopts. A runner without the binding skips the family by name.",
    product: PRODUCT,
    constants: {
      debounceMs: 2000,
      signOutFlushMs: 5000,
      pendingDays: 30,
      maxMutationsPerPush: 100,
      maxClockSkewMs: 300000,
      maxValueBytes: 8192,
    },
    steps: [...STEPS],
    calls: [...CALLS],
    asserts: [...ASSERTS],
    rules: RULES,
    scenarios: scenarios() as unknown as J,
    settingCases: settingCases() as unknown as J,
    fileRecordCases: {
      calls: [...FILE_RECORD_CALLS],
      asserts: [...FILE_RECORD_ASSERTS],
      scenarios: fileRecordCases() as unknown as J,
    },
  };
  selfCheck(file);
  checkFileRecordCases(fileRecordCases());
  return file;
}
