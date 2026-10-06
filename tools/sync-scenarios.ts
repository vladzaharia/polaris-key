// `conformance/corpus/v2/sync-scenarios.json`: the Cloud Sync client scenario corpus
// (plans/U-01.md §4.1, Q1; S-17 §5.13; WIRE-CONTRACT-V4 §11.5).
//
// HTTP transcripts pin the wire; this file pins what a client does between requests: optimistic
// reads over the journal, the debounce, HLC folding and pre-contact re-stamping, conflict rebase,
// one outstanding compare-and-swap per target, the per-subject partitions, the first-sign-in
// move, sign-out with pending operations, principal changes, `403 account_required` and a `/sync`
// 401. Every push and journal rule of S-17 §5.4 has at least one scenario.
//
// LITERAL DATA. Unlike the matrices whose expectations a generator-local reference recomputes,
// every expectation here is written out by hand and this module imports NO `client-core`: the
// reference state machine (`@polaris-key/client-core/cloud-sync`) is the first implementation
// checked against it, by `conformance/runners/node/syncScenarios.test.ts`, exactly as every
// other SDK's runner is. The self-check below validates the file's own shape and the invariants
// that hold whatever the implementation: the vocabulary, rule coverage, HLC and clientId
// syntax, and that a client never sends a fresh mutationId at or below one it already sent.
//
// Append-only: a scenario's expectations never change under the same `syncScenariosVersion`;
// a vocabulary or expectation change bumps it.

export const SYNC_SCENARIOS_VERSION = 1;

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
  "assert",
] as const;

const CALLS = [
  "setConfig",
  "clearConfig",
  "put",
  "add",
  "remove",
  "flush",
  "refresh",
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
      "A set on an enforced or hidden key is refused locally with setting-locked and journals nothing",
    ref: "plans/U-01.md §2.3; S-17 §5.5",
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

const ALICE = "sub_alice";
const BOB = "sub_bob";
const ZED = "sub_zed";

const hlc = (ms: number, counter = 0): string =>
  `${ms.toString(16).padStart(12, "0")}:${counter.toString(16).padStart(4, "0")}`;
const cid = (n: number): string => `c_${`client${n}`.padStart(22, "0")}`;
const C1 = cid(1);
const C2 = cid(2);

const CATALOG: Obj = {
  settings: [
    {
      key: VOL,
      policy: "lastWrite",
      schema: { type: "number", minimum: 0, maximum: 1 },
    },
    {
      key: QUAL,
      policy: "lastWrite",
      schema: { type: "string", enum: ["low", "medium", "high"] },
    },
    { key: BIND, policy: "merge", schema: { type: "object" } },
    { key: BEST, policy: "max", schema: { type: "integer", minimum: 0 } },
    { key: THEME, policy: "lastWrite", schema: { type: "string" } },
  ],
  collections: [
    { name: "progress", policy: "revision", resolve: "keepLocal" },
    { name: "unlocks", policy: "union" },
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

const LICENCE: Obj = {
  state: "valid",
  lastSyncUnauthorized: false,
  documents: ["license", "config"],
};

const LIMITS: Obj = {
  maxMutationsPerPush: 100,
  maxPushBytes: 262144,
  maxValueBytes: 8192,
  settingsBytes: 65536,
  totalBytes: 268435456,
};

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
    ...over,
  };
}

// Mutations (the wire form; `j` adds the journal-only marks).
const target = (key: string): Obj => ({ setting: key, scope: "user" });
const set = (id: number, key: string, value: J, h: string): Obj => ({
  mutationId: id,
  target: target(key),
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
const j = (m: Obj, marks: { preContact?: true; moved?: true }): Obj => ({
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
const change = (key: string, value: J, version: number, h: string): Obj => ({
  setting: key,
  scope: "user",
  value,
  version,
  editedHlc: h,
  updatedBy: "device",
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
}
const pullBody = (a: PullArgs): Obj => ({
  subject: a.subject ?? ALICE,
  serverNow: a.serverNow,
  cursor: a.cursor,
  more: a.more ?? false,
  lastMutationId: a.lastMutationId ?? 0,
  catalogVersion: 1,
  aliases: a.aliases ?? {},
  limits: LIMITS,
  usage: { bytes: 0, records: 0, saves: 0 },
  changes: a.changes ?? [],
  tombstones: a.tombstones ?? [],
});
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
const respond = (body: Obj, status = 200): Obj => ({
  respond: { status, body },
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
      local("setConfig", [VOL, 0.6], { ok: true }),
      assert({
        values: { [VOL]: val(0.6, "pending") },
        states: { [VOL]: { pending: true, invalid: false, locked: false } },
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
        states: { [VOL]: { pending: false, invalid: false, locked: false } },
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
      local("setConfig", [BEST, 100], { ok: true }),
      assert({
        values: { [BEST]: val(120, "pending") },
        events: [changed([BEST], "remote")],
      }),
      local("setConfig", [BEST, 150], { ok: true }),
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
      local("setConfig", [VOL, 0.3]),
      advance(500),
      local("setConfig", [VOL, 0.4]),
      advance(500),
      local("setConfig", [VOL, 0.5]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.7]),
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
      local("setConfig", [VOL, 0.6]),
      advance(2000),
      local("setConfig", [QUAL, "high"]),
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
      local("setConfig", [VOL, 0.7]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
      local("setConfig", [QUAL, "high"]),
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
      local("setConfig", [QUAL, "low"]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
      local("setConfig", [BIND, { jump: "j", crouch: "ctrl" }]),
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
      local("setConfig", [VOL, 0.6]),
      local("setConfig", [QUAL, "high"]),
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
      local("setConfig", [VOL, 0.7]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.4]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
      advance(2000),
      assert({ requests: [pushReq(C1, 2, [set(1, VOL, 0.6, hlc(T0))])] }),
      respond(errorBody("unauthorized", "Device token revoked."), 401),
      local("setConfig", [QUAL, "high"]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.6]),
      advance(2000),
      { relaunch: { journal: "lost" } },
      assert({
        journal: { [ALICE]: partition(C2, 1, 0, []) },
        values: { [VOL]: val(0.8, "document") },
        requests: [],
      }),
      local("setConfig", [VOL, 0.7]),
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
      local("setConfig", [VOL, 0.6]),
      local("setConfig", [QUAL, "high"]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [BIND, { jump: "j", crouch: "ctrl", dash: "shift" }]),
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
      local("setConfig", [BIND, { jump: "j", crouch: "c" }]),
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
      {
        key: "gfx.q",
        policy: "lastWrite",
        schema: { type: "string", enum: ["low", "medium", "high"] },
      },
      {
        key: "audio.legacyReverb",
        policy: "lastWrite",
        schema: { type: "boolean" },
      },
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
      local("setConfig", ["gfx.q", "low"]),
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
      local("setConfig", ["audio.legacyReverb", true]),
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
      "A set on a key the document enforces is refused with setting-locked and journals nothing, while the server's stored value stays out of the read; an unknown key is setting-unknown.",
    rules: ["locked-key"],
    init: init(),
    steps: [
      ...started(2, [change(THEME, "light", 2, hlc(T0 - 1000))]),
      local("setConfig", [THEME, "light"], {
        ok: false,
        error: "setting-locked",
      }),
      local("setConfig", ["no.such.key", 1], {
        ok: false,
        error: "setting-unknown",
      }),
      advance(2000),
      assert({
        values: { [THEME]: val("dark", "document") },
        states: { [THEME]: { pending: false, invalid: false, locked: true } },
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
        states: { [VOL]: { pending: false, invalid: true, locked: false } },
        events: [],
      }),
      local("setConfig", [VOL, 0.4]),
      assert({
        values: { [VOL]: val(0.4, "pending") },
        states: { [VOL]: { pending: true, invalid: false, locked: false } },
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
      local("setConfig", [QUAL, "high"]),
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
      local("setConfig", [VOL, 0.6]),
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
      local("setConfig", [VOL, 0.7]),
      advance(2000),
      assert({
        requests: [pushReq(C1, 3, [set(2, VOL, 0.7, hlc(T0 + 1000))])],
      }),
    ],
  });

  return s;
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
      if (
        keys[0] === "respond" &&
        !(body.error === "transport" || Number.isInteger(body.status))
      )
        at(`step ${i}: respond needs a status or error: transport`);
      if (keys[0] === "assert") {
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
}

export function buildSyncScenarios(): Obj {
  const file: Obj = {
    syncScenariosVersion: SYNC_SCENARIOS_VERSION,
    description:
      "Cloud Sync client behaviour, outside the wire contract (WIRE-CONTRACT-V4 §11.5, plans/U-01.md §4.1). Each scenario starts from `init` and runs its steps in order against a fake clock and a fake transport: `local` calls the SDK, `advance` moves the clock (firing debounce commits and the sign-out deadline), `network` goes online or offline, `respond` answers the one request in flight, `signIn`, `signOut` and `relaunch` act on the device, and `assert` compares the listed views. `requests` and `events` are what was sent and emitted since the previous assert. Literal data, not generated by an implementation.",
    product: PRODUCT,
    constants: {
      debounceMs: 2000,
      signOutFlushMs: 5000,
      pendingDays: 30,
      maxMutationsPerPush: 100,
      maxClockSkewMs: 300000,
    },
    steps: [...STEPS],
    calls: [...CALLS],
    asserts: [...ASSERTS],
    rules: RULES,
    scenarios: scenarios() as unknown as J,
  };
  selfCheck(file);
  return file;
}
