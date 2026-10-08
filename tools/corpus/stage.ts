// `stage-matrix.json`: the boot stage machine of `@polaris-key/client-core/stages`, client boot
// behaviour outside the wire contract (version 2 adds boot confirmation, version 3 packs).

// ── stage-matrix v1 (client boot behaviour, outside the wire contract) ───────
// The boot stage machine (`@polaris-key/client-core/stages` and its Python and Swift ports),
// pinned as data. Unsigned, like the gate matrix: it pins a reducer, not a signature. The rows,
// `accepts` and `probes` are literal data built with small step helpers. Nothing here imports
// `client-core`: a golden file that shares code with the implementation it checks cannot catch
// a bug in that shared code. `buildStageMatrix` self-checks the rows before writing, so a row
// that contradicts the vocabulary, the `accepts` table or its own stage list fails
// `gen:corpus`.
//
// Append-only, like `CARRIED_MATRIX_ROWS`. Rows that use only v1 semantics keep
// `stageMatrixVersion: 1`; a change to the vocabulary, to `accepts`, to an existing row's
// expectation, or a `canPlayOffline: true` path bumps the version, and the package that does it
// updates every port.

/** `MAX_FAILED_BOOTS`, restated rather than imported (as `MAX_BUNDLE_BYTES` is). */
const STAGE_MAX_FAILED_BOOTS = 2;

/** The nine `LicenseStatus` values, restated from `@polaris-key/protocol/license`. */
const LICENSE_STATUSES = [
  "ok",
  "grace",
  "expired",
  "revoked",
  "needs-activation",
  "version-too-old",
  "version-too-new",
  "channel-not-entitled",
  "not-applicable",
] as const;

const STAGE_VOCABULARY = {
  stages: [
    "idle",
    "shell",
    "guard",
    "sync",
    "gate",
    "decide",
    "fetch",
    "mount",
    "ready",
    "background",
    "offline",
    "blocked",
    "error",
  ],
  outcomes: ["running", "waiting", "ready", "blocked", "offline", "error"],
  events: [
    "start",
    "shell.done",
    "guard.done",
    "sync.done",
    "sync.timeout",
    "gate.status",
    "decide.done",
    "fetch.done",
    "mount.done",
    "background.start",
    "background.done",
    "retry",
    "play-offline",
    "fail",
    // Version 3 (plans/P4-01.md §2.10): fetch consent and progress.
    "fetch.consent",
    "fetch.progress",
  ],
  emits: [
    "stage_changed",
    "waiting",
    "update_available",
    "blocked",
    "offline",
    "error",
    "boot_rolled_back",
    "boot_ready",
    "consent_needed",
    "fetch_progress",
  ],
  guardActions: ["none", "apply-staged", "roll-back"],
};

/** The plan's "Accepted in" table. A key is a stage, `gate:waiting` for the gate while it waits
 *  for the player, `fetch:waiting` for the fetch while it waits for download consent, or
 *  `offline:playable` for an offline stop that can play what is present (version 3). */
const STAGE_ACCEPTS: Record<string, string[]> = {
  idle: ["start"],
  shell: ["shell.done", "fail"],
  guard: ["guard.done", "fail"],
  sync: ["sync.done", "sync.timeout", "fail"],
  gate: ["gate.status", "fail"],
  "gate:waiting": ["gate.status", "retry"],
  decide: ["decide.done", "fail"],
  fetch: ["fetch.done", "fetch.consent", "fetch.progress", "fail"],
  "fetch:waiting": ["fetch.done", "fetch.progress"],
  mount: ["mount.done", "fail"],
  ready: ["background.start"],
  background: ["background.done"],
  offline: ["retry"],
  "offline:playable": ["retry", "play-offline"],
  blocked: ["retry"],
  error: ["retry"],
};

type StageEvent = { type: string } & Record<string, unknown>;
type StageEmit = { type: string } & Record<string, unknown>;
interface StageStep {
  event: StageEvent;
  emits: StageEmit[];
}
interface StageInit {
  allowOffline?: boolean;
  allowGrace?: boolean;
  requiredPacks?: string[];
  essentialPacks?: string[];
}
interface StageRow {
  name: string;
  init: StageInit;
  steps: StageStep[];
  expect: { stages: string[]; outcome: string };
}

// Events.
const evStart: StageEvent = { type: "start" };
const evShellDone: StageEvent = { type: "shell.done" };
const evGuard = (result: string): StageEvent => ({
  type: "guard.done",
  result,
});
const evSync = (result: string): StageEvent => ({ type: "sync.done", result });
const evTimeout: StageEvent = { type: "sync.timeout" };
const evGate = (status: string): StageEvent => ({
  type: "gate.status",
  status,
});
const evDecide = (decision: string): StageEvent => ({
  type: "decide.done",
  decision,
});
const evFetch = (result: string, installed: string[]): StageEvent => ({
  type: "fetch.done",
  result,
  installed,
});
const evMountDone: StageEvent = { type: "mount.done" };
const evBackgroundStart: StageEvent = { type: "background.start" };
const evBackgroundDone: StageEvent = { type: "background.done" };
const evRetry: StageEvent = { type: "retry" };
const evPlayOffline: StageEvent = { type: "play-offline" };
const evFail = (code: string): StageEvent => ({ type: "fail", code });
const evConsent = (bytes: number, metered: boolean): StageEvent => ({
  type: "fetch.consent",
  bytes,
  metered,
});
const evProgress = (done: number, total: number): StageEvent => ({
  type: "fetch.progress",
  done,
  total,
});

// Emits.
const changed = (stage: string, previous: string): StageEmit => ({
  type: "stage_changed",
  stage,
  previous,
});
const emWaiting = (status: string): StageEmit => ({ type: "waiting", status });
const emBlocked = (reason: string): StageEmit => ({ type: "blocked", reason });
const emOffline: StageEmit = { type: "offline", canPlayOffline: false };
const emError = (code: string): StageEmit => ({ type: "error", code });
const emUpdateAvailable: StageEmit = { type: "update_available" };
const emRolledBack: StageEmit = { type: "boot_rolled_back" };
const emBootReady: StageEmit = { type: "boot_ready" };
const emOfflinePlayable: StageEmit = { type: "offline", canPlayOffline: true };
const emConsent = (bytes: number, metered: boolean): StageEmit => ({
  type: "consent_needed",
  bytes,
  metered,
});
const emProgress = (done: number, total: number): StageEmit => ({
  type: "fetch_progress",
  done,
  total,
});

const step = (event: StageEvent, ...emits: StageEmit[]): StageStep => ({
  event,
  emits,
});
/** An event the current stage does not accept: it emits nothing. */
const ignored = (event: StageEvent): StageStep => ({ event, emits: [] });

// Shared step runs.
/** `P`: start, shell.done, guard.done with `result` (ok unless a row says otherwise). */
const prefix = (result = "ok"): StageStep[] => [
  step(evStart, changed("shell", "idle")),
  step(evShellDone, changed("guard", "shell")),
  result === "rolled-back"
    ? step(evGuard(result), changed("sync", "guard"), emRolledBack)
    : step(evGuard(result), changed("sync", "guard")),
];
/** A sync result that continues to the gate. */
const toGate = (result: string): StageStep =>
  step(evSync(result), changed("gate", "sync"));
/** A gate status that passes to decide. */
const pass = (status = "ok"): StageStep =>
  step(evGate(status), changed("decide", "gate"));
/** `T`: decide.done none, fetch.done ok [], mount.done. */
const tail = (): StageStep[] => [
  step(evDecide("none"), changed("fetch", "decide")),
  step(evFetch("ok", []), changed("mount", "fetch")),
  step(evMountDone, changed("ready", "mount"), emBootReady),
];

const INIT_D: StageInit = {
  allowOffline: true,
  allowGrace: true,
  requiredPacks: [],
};
const INIT_D_O: StageInit = { ...INIT_D, allowOffline: false };
const INIT_D_G: StageInit = { ...INIT_D, allowGrace: false };
const INIT_D_K: StageInit = { ...INIT_D, requiredPacks: ["core"] };
/** Version 3's `essentialPacks` (plans/P4-01.md §4.7): `D+KE` and `D+E`. */
const INIT_D_KE: StageInit = {
  ...INIT_D,
  requiredPacks: ["core"],
  essentialPacks: ["core", "hd"],
};
const INIT_D_E: StageInit = { ...INIT_D, essentialPacks: ["hd"] };

/** The stages every row except 34 and 35 enters first. */
const S_BASE = ["shell", "guard", "sync"];
/** Row 1's stages: the whole normal path. */
const S_READY = [...S_BASE, "gate", "decide", "fetch", "mount", "ready"];
/** After a retry that resumes at the sync: the normal path from there. */
const S_RESYNC = ["sync", "gate", "decide", "fetch", "mount", "ready"];

function stageRows(): StageRow[] {
  return [
    {
      name: "ready — every stage is entered in order",
      init: INIT_D,
      steps: [...prefix(), toGate("ok"), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — not-applicable passes the gate",
      init: INIT_D,
      steps: [...prefix(), toGate("ok"), pass("not-applicable"), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — needs-activation waits for the player, then continues",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        pass(),
        ...tail(),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "waiting — revoked waits for the player",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("revoked"), emWaiting("revoked")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "offline — expired without a network cannot continue",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("expired"), changed("offline", "gate"), emOffline),
      ],
      expect: { stages: [...S_BASE, "gate", "offline"], outcome: "offline" },
    },
    {
      name: "ready — expired while online waits, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("expired"), emWaiting("expired")),
        step(evRetry, changed("sync", "gate")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: { stages: [...S_BASE, "gate", ...S_RESYNC], outcome: "ready" },
    },
    {
      name: "blocked — version-too-old requires an update",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(
          evGate("version-too-old"),
          changed("blocked", "gate"),
          emBlocked("update-required"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — version-too-new is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(
          evGate("version-too-new"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "ready — channel-not-entitled blocks, and retry continues once entitled",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(
          evGate("channel-not-entitled"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
        step(evRetry, changed("sync", "blocked")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [...S_BASE, "gate", "blocked", ...S_RESYNC],
        outcome: "ready",
      },
    },
    {
      name: "ready — by default a sync timeout continues offline and grace passes",
      init: {},
      steps: [
        ...prefix(),
        step(evTimeout, changed("gate", "sync")),
        pass("grace"),
        ...tail(),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "offline — allowGrace false refuses grace offline",
      init: INIT_D_G,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("grace"), changed("offline", "gate"), emOffline),
      ],
      expect: { stages: [...S_BASE, "gate", "offline"], outcome: "offline" },
    },
    {
      name: "waiting — offline and not yet activated still reaches activation",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "ready — an offline first launch of a config-only product continues on its defaults",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        pass("not-applicable"),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("offline", []), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — a sync error continues from local state",
      init: INIT_D,
      steps: [...prefix(), toGate("error"), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "offline — allowOffline false stops when the network is unreachable",
      init: INIT_D_O,
      steps: [
        ...prefix(),
        step(evSync("offline"), changed("offline", "sync"), emOffline),
      ],
      expect: { stages: [...S_BASE, "offline"], outcome: "offline" },
    },
    {
      name: "error — allowOffline false stops with sync-failed on a server error",
      init: INIT_D_O,
      steps: [
        ...prefix(),
        step(evSync("error"), changed("error", "sync"), emError("sync-failed")),
      ],
      expect: { stages: [...S_BASE, "error"], outcome: "error" },
    },
    {
      name: "ready — allowOffline false: a timeout stops, play-offline is ignored, retry syncs",
      init: INIT_D_O,
      steps: [
        ...prefix(),
        step(evTimeout, changed("offline", "sync"), emOffline),
        ignored(evPlayOffline),
        step(evRetry, changed("sync", "offline")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: { stages: [...S_BASE, "offline", ...S_RESYNC], outcome: "ready" },
    },
    {
      name: "ready — an optional update continues and emits update_available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(
          evDecide("optional"),
          changed("fetch", "decide"),
          emUpdateAvailable,
        ),
        step(evFetch("ok", []), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "blocked — a required update blocks",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(
          evDecide("required"),
          changed("blocked", "decide"),
          emBlocked("update-required"),
        ),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "blocked"],
        outcome: "blocked",
      },
    },
    {
      name: "ready — a missing required pack is fetched",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("ok", ["core"]), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "offline — a required pack is missing and there is no network",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("offline"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("offline", []), changed("offline", "fetch"), emOffline),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "fetch", "offline"],
        outcome: "offline",
      },
    },
    {
      name: "error — a required pack is still missing after a failed fetch",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(
          evFetch("failed", []),
          changed("error", "fetch"),
          emError("fetch-failed"),
        ),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "fetch", "error"],
        outcome: "error",
      },
    },
    {
      name: "ready — a failed download never blocks when the required set is present",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("failed", ["core"]), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — a rolled-back boot continues and emits boot_rolled_back",
      init: INIT_D,
      steps: [...prefix("rolled-back"), toGate("ok"), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — an applied staged update continues",
      init: INIT_D,
      steps: [...prefix("applied"), toGate("ok"), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — a late sync.timeout after sync.done is ignored",
      init: INIT_D,
      steps: [...prefix(), toGate("ok"), ignored(evTimeout), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — a host failure ends in error, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("ok", []), changed("mount", "fetch")),
        step(
          evFail("mount-failed"),
          changed("error", "mount"),
          emError("mount-failed"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [
          ...S_BASE,
          "gate",
          "decide",
          "fetch",
          "mount",
          "error",
          ...S_RESYNC,
        ],
        outcome: "ready",
      },
    },
    {
      name: "ready — background work after ready returns to ready",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        ...tail(),
        step(evBackgroundStart, changed("background", "ready")),
        step(evBackgroundDone, changed("ready", "background")),
      ],
      expect: { stages: [...S_READY, "background", "ready"], outcome: "ready" },
    },
    {
      name: "error — expired after a server error stops with sync-failed",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(
          evGate("expired"),
          changed("error", "gate"),
          emError("sync-failed"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "error"], outcome: "error" },
    },
    {
      name: "running — events outside their stage are ignored mid-boot",
      init: INIT_D,
      steps: [
        step(evStart, changed("shell", "idle")),
        ignored(evStart),
        ignored(evMountDone),
        step(evShellDone, changed("guard", "shell")),
        ignored(evRetry),
        step(evGuard("ok"), changed("sync", "guard")),
        ignored(evBackgroundDone),
        step(evTimeout, changed("gate", "sync")),
        ignored(evSync("ok")),
        ignored(evRetry),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "running" },
    },
    {
      name: "ready — fail while the gate waits, and fail and retry after ready, are ignored",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        ignored(evFail("activation-failed")),
        pass(),
        ...tail(),
        ignored(evFail("late-failure")),
        ignored(evRetry),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "error — fetch reports ok but a required pack is still missing",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(
          evFetch("ok", []),
          changed("error", "fetch"),
          emError("fetch-failed"),
        ),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "fetch", "error"],
        outcome: "error",
      },
    },
    {
      name: "waiting — allowGrace false holds grace for the player after a sync",
      init: INIT_D_G,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("grace"), emWaiting("grace")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "ready — a shell failure ends in error, and retry runs the shell again",
      init: INIT_D,
      steps: [
        step(evStart, changed("shell", "idle")),
        step(
          evFail("shell-failed"),
          changed("error", "shell"),
          emError("shell-failed"),
        ),
        step(evRetry, changed("shell", "error")),
        step(evShellDone, changed("guard", "shell")),
        step(evGuard("ok"), changed("sync", "guard")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [
          "shell",
          "error",
          "shell",
          "guard",
          "sync",
          "gate",
          "decide",
          "fetch",
          "mount",
          "ready",
        ],
        outcome: "ready",
      },
    },
    {
      name: "ready — a guard failure ends in error, and retry runs the guard again",
      init: INIT_D,
      steps: [
        step(evStart, changed("shell", "idle")),
        step(evShellDone, changed("guard", "shell")),
        step(
          evFail("guard-failed"),
          changed("error", "guard"),
          emError("guard-failed"),
        ),
        step(evRetry, changed("guard", "error")),
        step(evGuard("ok"), changed("sync", "guard")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [
          "shell",
          "guard",
          "error",
          "guard",
          "sync",
          "gate",
          "decide",
          "fetch",
          "mount",
          "ready",
        ],
        outcome: "ready",
      },
    },
    {
      name: "ready — a sync failure ends in error even with allowOffline, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        step(
          evFail("sync-exception"),
          changed("error", "sync"),
          emError("sync-exception"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: { stages: [...S_BASE, "error", ...S_RESYNC], outcome: "ready" },
    },
    {
      name: "ready — a gate failure before any status ends in error, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(
          evFail("gate-exception"),
          changed("error", "gate"),
          emError("gate-exception"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [...S_BASE, "gate", "error", ...S_RESYNC],
        outcome: "ready",
      },
    },
    {
      name: "ready — a decide failure ends in error, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(
          evFail("decide-exception"),
          changed("error", "decide"),
          emError("decide-exception"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "error", ...S_RESYNC],
        outcome: "ready",
      },
    },
    {
      name: "ready — a fetch failure ends in error, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(
          evFail("fetch-exception"),
          changed("error", "fetch"),
          emError("fetch-exception"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "fetch", "error", ...S_RESYNC],
        outcome: "ready",
      },
    },
    {
      name: "waiting — revoked without a network waits for the player",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("revoked"), emWaiting("revoked")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "blocked — version-too-old without a network still requires an update",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(
          evGate("version-too-old"),
          changed("blocked", "gate"),
          emBlocked("update-required"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — version-too-new without a network is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(
          evGate("version-too-new"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — channel-not-entitled without a network is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(
          evGate("channel-not-entitled"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "ready — not-applicable passes the gate after a server error",
      init: INIT_D,
      steps: [...prefix(), toGate("error"), pass("not-applicable"), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — grace passes the gate after a server error",
      init: INIT_D,
      steps: [...prefix(), toGate("error"), pass("grace"), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "error — allowGrace false refuses grace after a server error",
      init: INIT_D_G,
      steps: [
        ...prefix(),
        toGate("error"),
        step(evGate("grace"), changed("error", "gate"), emError("sync-failed")),
      ],
      expect: { stages: [...S_BASE, "gate", "error"], outcome: "error" },
    },
    {
      name: "waiting — needs-activation after a server error still reaches activation",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "waiting — revoked after a server error waits for the player",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(evGate("revoked"), emWaiting("revoked")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "blocked — version-too-old after a server error requires an update",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(
          evGate("version-too-old"),
          changed("blocked", "gate"),
          emBlocked("update-required"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — version-too-new after a server error is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(
          evGate("version-too-new"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — channel-not-entitled after a server error is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(
          evGate("channel-not-entitled"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "ready — grace passes the gate after a sync",
      init: INIT_D,
      steps: [...prefix(), toGate("ok"), pass("grace"), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "blocked — a gate that waits for the player still blocks on channel-not-entitled",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        step(
          evGate("channel-not-entitled"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "offline — a gate that waits without a network still stops on expired",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        step(evGate("expired"), changed("offline", "gate"), emOffline),
      ],
      expect: { stages: [...S_BASE, "gate", "offline"], outcome: "offline" },
    },
    {
      name: "offline — expired after a sync timeout stops as offline, not as sync-failed",
      init: INIT_D,
      steps: [
        ...prefix(),
        step(evTimeout, changed("gate", "sync")),
        step(evGate("expired"), changed("offline", "gate"), emOffline),
      ],
      expect: { stages: [...S_BASE, "gate", "offline"], outcome: "offline" },
    },
    {
      name: "waiting — allowOffline false does not change the gate: expired after a sync waits",
      init: INIT_D_O,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("expired"), emWaiting("expired")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    // ── Version 3 (plans/P4-01.md §2.10, §4.7): packs — consent, progress, a playable
    // offline. Every row runs `P`, then `sync ok`, `gate ok`, `decide.done none`.
    ...packStageRows(),
  ];
}

/** `P`, `sync ok`, `gate ok`, `decide.done none`: every version 3 row's lead-in. */
const toFetch = (): StageStep[] => [
  ...prefix(),
  toGate("ok"),
  pass(),
  step(evDecide("none"), changed("fetch", "decide")),
];
/** The stages `toFetch` enters. */
const S_FETCH = [...S_BASE, "gate", "decide", "fetch"];
const MB50 = 52428800;

/** plans/P4-01.md §4.7's thirteen rows (57–69). */
function packStageRows(): StageRow[] {
  const resync = (): StageStep[] => [
    step(evRetry, changed("sync", "blocked")),
    toGate("ok"),
    pass(),
    step(evDecide("none"), changed("fetch", "decide")),
  ];
  const declined = (): StageStep[] => [
    ...toFetch(),
    step(evConsent(MB50, true), emConsent(MB50, true)),
    step(
      evFetch("declined", []),
      changed("blocked", "fetch"),
      emBlocked("content-declined"),
    ),
  ];
  const offlinePlayable = (): StageStep[] => [
    ...toFetch(),
    step(
      evFetch("offline", ["core"]),
      changed("offline", "fetch"),
      emOfflinePlayable,
    ),
  ];
  const mountReady = (installed: string[], from = "fetch"): StageStep[] => [
    step(evFetch("ok", installed), changed("mount", from)),
    step(evMountDone, changed("ready", "mount"), emBootReady),
  ];
  return [
    {
      name: "ready — a required download asks first, then fetches with progress",
      init: INIT_D_K,
      steps: [
        ...toFetch(),
        step(evConsent(MB50, false), emConsent(MB50, false)),
        step(evProgress(0, MB50), emProgress(0, MB50)),
        step(evProgress(MB50, MB50), emProgress(MB50, MB50)),
        ...mountReady(["core"]),
      ],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
    {
      name: "waiting — consent waits for the player on a metered network",
      init: INIT_D_K,
      steps: [...toFetch(), step(evConsent(MB50, true), emConsent(MB50, true))],
      expect: { stages: S_FETCH, outcome: "waiting" },
    },
    {
      name: "blocked — the player declines a required download",
      init: INIT_D_K,
      steps: declined(),
      expect: { stages: [...S_FETCH, "blocked"], outcome: "blocked" },
    },
    {
      name: "ready — retry after a declined download asks again",
      init: INIT_D_K,
      steps: [
        ...declined(),
        ...resync(),
        step(evConsent(MB50, false), emConsent(MB50, false)),
        step(evProgress(0, MB50), emProgress(0, MB50)),
        ...mountReady(["core"]),
      ],
      expect: {
        stages: [
          ...S_FETCH,
          "blocked",
          "sync",
          "gate",
          "decide",
          "fetch",
          "mount",
          "ready",
        ],
        outcome: "ready",
      },
    },
    {
      name: "ready — declining essential content that is not required plays without it",
      init: INIT_D_E,
      steps: [
        ...toFetch(),
        step(evConsent(1048576, true), emConsent(1048576, true)),
        step(evFetch("declined", []), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
    {
      name: "offline — essential content cannot download, and the required set is present",
      init: INIT_D_KE,
      steps: offlinePlayable(),
      expect: { stages: [...S_FETCH, "offline"], outcome: "offline" },
    },
    {
      name: "ready — play-offline from that card plays what is present",
      init: INIT_D_KE,
      steps: [
        ...offlinePlayable(),
        step(evPlayOffline, changed("mount", "offline")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: {
        stages: [...S_FETCH, "offline", "mount", "ready"],
        outcome: "ready",
      },
    },
    {
      name: "ready — retry from that card syncs again",
      init: INIT_D_KE,
      steps: [
        ...offlinePlayable(),
        step(evRetry, changed("sync", "offline")),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        ...mountReady(["core", "hd"]),
      ],
      expect: {
        stages: [
          ...S_FETCH,
          "offline",
          "sync",
          "gate",
          "decide",
          "fetch",
          "mount",
          "ready",
        ],
        outcome: "ready",
      },
    },
    {
      name: "offline — a missing required pack stays unplayable, and play-offline is ignored",
      init: INIT_D_KE,
      steps: [
        ...toFetch(),
        step(evFetch("offline", []), changed("offline", "fetch"), emOffline),
        ignored(evPlayOffline),
      ],
      expect: { stages: [...S_FETCH, "offline"], outcome: "offline" },
    },
    {
      name: "ready — a failed essential download never blocks when the required set is present",
      init: INIT_D_KE,
      steps: [
        ...toFetch(),
        step(evFetch("failed", ["core"]), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
    {
      name: "ready — progress without a consent step",
      init: INIT_D_K,
      steps: [
        ...toFetch(),
        step(evProgress(0, 1000), emProgress(0, 1000)),
        step(evProgress(1000, 1000), emProgress(1000, 1000)),
        ...mountReady(["core"]),
      ],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
    {
      name: "waiting — fail, a second consent and play-offline are ignored while consent waits",
      init: INIT_D_K,
      steps: [
        ...toFetch(),
        step(evConsent(1000, false), emConsent(1000, false)),
        ignored(evFail("consent-failed")),
        ignored(evConsent(2000, false)),
        ignored(evPlayOffline),
      ],
      expect: { stages: S_FETCH, outcome: "waiting" },
    },
    {
      name: "ready — every essential pack is present: nothing is asked",
      init: INIT_D_KE,
      steps: [...toFetch(), ...mountReady(["core", "hd"])],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
  ];
}

/** The boot guard's launch decision, G1–G7. */
const STAGE_GUARD_CASES = [
  {
    name: "none — nothing staged and no failed boots",
    input: { staged: false, failedBoots: 0 },
    expect: { action: "none" },
  },
  {
    name: "apply-staged — a staged update is applied",
    input: { staged: true, failedBoots: 0 },
    expect: { action: "apply-staged" },
  },
  {
    name: "none — one failed boot does not roll back",
    input: { staged: false, failedBoots: 1 },
    expect: { action: "none" },
  },
  {
    name: "apply-staged — a staged update replaces a slot with one failure",
    input: { staged: true, failedBoots: 1 },
    expect: { action: "apply-staged" },
  },
  {
    name: "roll-back — two failed boots roll back",
    input: { staged: false, failedBoots: 2 },
    expect: { action: "roll-back" },
  },
  {
    name: "roll-back — a rollback takes precedence over a staged update",
    input: { staged: true, failedBoots: 2 },
    expect: { action: "roll-back" },
  },
  {
    name: "roll-back — more than two failed boots still roll back",
    input: { staged: false, failedBoots: 3 },
    expect: { action: "roll-back" },
  },
];

/** One well-formed event per vocabulary event type, in vocabulary order. */
const STAGE_PROBES: StageEvent[] = [
  evStart,
  evShellDone,
  evGuard("ok"),
  evSync("ok"),
  evTimeout,
  evGate("ok"),
  evDecide("none"),
  evFetch("ok", []),
  evMountDone,
  evBackgroundStart,
  evBackgroundDone,
  evRetry,
  evPlayOffline,
  evFail("probe"),
  evConsent(0, false),
  evProgress(0, 0),
];

/** Throws unless the rows agree with the vocabulary, `accepts`, their own stage lists, and
 *  cover every cell of the plan's sync and gate tables. Nothing here computes an expectation:
 *  it only checks the hand-authored ones against each other. */
function checkStageMatrix(
  rows: StageRow[],
  guardCases: typeof STAGE_GUARD_CASES,
): void {
  const fail = (msg: string): never => {
    throw new Error(`stage-matrix: ${msg}`);
  };
  const v = STAGE_VOCABULARY;
  const same = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  // accepts: exactly the 13 stages plus gate:waiting, fetch:waiting and offline:playable,
  // listing vocabulary events only.
  const keys = [
    ...v.stages,
    "gate:waiting",
    "fetch:waiting",
    "offline:playable",
  ];
  if (!same(Object.keys(STAGE_ACCEPTS).sort(), [...keys].sort()))
    fail(
      "accepts must have the 13 stages, gate:waiting, fetch:waiting and offline:playable as its keys",
    );
  for (const [key, events] of Object.entries(STAGE_ACCEPTS))
    for (const e of events)
      if (!v.events.includes(e)) fail(`accepts.${key} lists unknown ${e}`);
  // probes: one per vocabulary event type, in order.
  if (
    !same(
      STAGE_PROBES.map((p) => p.type),
      v.events,
    )
  )
    fail("probes must hold one event per vocabulary event type, in order");

  const used = {
    stages: new Set<string>(),
    outcomes: new Set<string>(),
    events: new Set<string>(),
    emits: new Set<string>(),
    statuses: new Set<string>(),
  };
  const acceptCells = new Set<string>();
  const syncCells = new Set<string>();
  const gateCells = new Set<string>();
  const names = new Set<string>();
  const finalOutcomes: Record<string, string[]> = {
    idle: ["running"],
    shell: ["running"],
    guard: ["running"],
    sync: ["running"],
    gate: ["running", "waiting"],
    decide: ["running"],
    fetch: ["running", "waiting"],
    mount: ["running"],
    ready: ["ready"],
    background: ["ready"],
    offline: ["offline"],
    blocked: ["blocked"],
    error: ["error"],
  };

  for (const row of rows) {
    if (names.has(row.name)) fail(`duplicate row name: ${row.name}`);
    names.add(row.name);
    const allowOffline = row.init.allowOffline ?? true;
    const allowGrace = row.init.allowGrace ?? true;
    let key = "idle";
    let sync = "pending";
    const stages: string[] = [];
    for (const [i, s] of row.steps.entries()) {
      const where = `${row.name}, step ${i + 1}`;
      const type = s.event.type;
      if (!v.events.includes(type)) fail(`${where}: unknown event ${type}`);
      used.events.add(type);
      const accepted = STAGE_ACCEPTS[key]!.includes(type);
      if (accepted !== s.emits.length > 0)
        fail(
          `${where}: ${type} in ${key} must ${accepted ? "emit something" : "emit nothing"}`,
        );
      if (!accepted) continue;
      acceptCells.add(`${key}|${type}`);
      if (type === "sync.done" || type === "sync.timeout") {
        const result = type === "sync.timeout" ? "timeout" : s.event.result;
        syncCells.add(`${result}|${allowOffline}`);
        sync = result === "timeout" ? "offline" : String(s.event.result);
      }
      if (type === "gate.status") {
        const status = String(s.event.status);
        used.statuses.add(status);
        const cls = status === "grace" ? `grace:${allowGrace}` : status;
        gateCells.add(`${cls}|${sync}`);
      }
      for (const [j, em] of s.emits.entries()) {
        if (!v.emits.includes(em.type))
          fail(`${where}: unknown emit ${em.type}`);
        used.emits.add(em.type);
        if (em.type === "stage_changed") {
          if (j !== 0) fail(`${where}: stage_changed must come first`);
          const stage = String(em.stage);
          if (!v.stages.includes(stage)) fail(`${where}: unknown ${stage}`);
          if (em.previous !== key.split(":")[0])
            fail(`${where}: stage_changed.previous must be ${key}`);
          used.stages.add(stage);
          used.stages.add(String(em.previous));
          stages.push(stage);
          key = stage;
        } else if (j > 1 || (j === 1 && s.emits[0]!.type !== "stage_changed")) {
          fail(`${where}: at most one emit besides stage_changed`);
        }
        if (em.type === "waiting") {
          if (key !== "gate" && key !== "gate:waiting")
            fail(`${where}: waiting outside the gate`);
          key = "gate:waiting";
        }
        // Version 3: consent waits in the fetch, progress resumes it, and a playable offline
        // stop takes play-offline.
        if (em.type === "consent_needed") {
          if (key !== "fetch")
            fail(`${where}: consent_needed outside the fetch`);
          key = "fetch:waiting";
        }
        if (em.type === "fetch_progress") {
          if (key !== "fetch" && key !== "fetch:waiting")
            fail(`${where}: fetch_progress outside the fetch`);
          key = "fetch";
        }
        if (em.type === "offline" && em.canPlayOffline === true) {
          if (key !== "offline")
            fail(`${where}: a playable offline outside offline`);
          key = "offline:playable";
        }
      }
    }
    if (!same(stages, row.expect.stages))
      fail(`${row.name}: expect.stages differs from the stage_changed emits`);
    const final = stages[stages.length - 1] ?? "idle";
    if (!finalOutcomes[final]!.includes(row.expect.outcome))
      fail(`${row.name}: ${final} cannot end ${row.expect.outcome}`);
    if (
      final === "gate" &&
      (row.expect.outcome === "waiting") !== (key === "gate:waiting")
    )
      fail(`${row.name}: the gate's outcome disagrees with its waiting emit`);
    if (
      final === "fetch" &&
      (row.expect.outcome === "waiting") !== (key === "fetch:waiting")
    )
      fail(`${row.name}: the fetch's outcome disagrees with its consent emit`);
    used.outcomes.add(row.expect.outcome);
  }

  const guardActions = new Set(guardCases.map((c) => c.expect.action));
  for (const [list, set] of [
    [v.stages, used.stages],
    [v.outcomes, used.outcomes],
    [v.events, used.events],
    [v.emits, used.emits],
    [v.guardActions, guardActions],
    [LICENSE_STATUSES, used.statuses],
  ] as const)
    for (const entry of list)
      if (!set.has(entry)) fail(`${entry} is used by no row or case`);
  for (const action of guardActions)
    if (!v.guardActions.includes(action))
      fail(`unknown guard action ${action}`);

  for (const [key, events] of Object.entries(STAGE_ACCEPTS))
    for (const e of events)
      if (!acceptCells.has(`${key}|${e}`))
        fail(`no row step takes the accepts cell ${key} × ${e}`);
  for (const result of ["ok", "offline", "error", "timeout"])
    for (const allow of [true, false])
      if (!syncCells.has(`${result}|${allow}`))
        fail(`no row takes the sync cell ${result}, allowOffline ${allow}`);
  const gateClasses = [
    ...LICENSE_STATUSES.filter((s) => s !== "grace"),
    "grace:true",
    "grace:false",
  ];
  for (const cls of gateClasses)
    for (const sync of ["ok", "offline", "error"])
      if (!gateCells.has(`${cls}|${sync}`))
        fail(`no row takes the gate cell ${cls} after sync ${sync}`);
}

export function buildStageMatrix(): unknown {
  const rows = stageRows();
  checkStageMatrix(rows, STAGE_GUARD_CASES);
  checkConfirmCases();
  return {
    stageMatrixVersion: 3,
    description:
      "The boot stage machine (client boot behaviour, outside the wire contract), owned by `@polaris-key/client-core/stages` and ported to every SDK. Each row starts from `initialBootState(init)` (an omitted option takes its default: allowOffline true, allowGrace true, requiredPacks []) and feeds `bootTransition` its steps in order; each step lists the exact emits that event produces, `stage_changed` first. `expect.stages` is every stage entered, in order, and its last entry is the final stage; `expect.outcome` is the final outcome. Events are dotted, emits snake_case, payload keys camelCase and payload values kebab-case. An event the current stage does not accept, or a malformed one, is ignored: the state comes back unchanged with no emits. `accepts` lists what each stage accepts (`gate:waiting` is the gate while it waits for the player), and a runner sends every probe at the initial state and after every step of every row, asserting an unchanged state and no emits exactly when the probe's type is not accepted there. `guardCases` pin `bootGuardAction`, which rolls back at `maxFailedBoots`. Version 2 (plans/P3-01.md §2.10) adds boot confirmation: `confirmCases` pin `bootConfirmation(outcome)`, one per outcome (`now` for waiting, blocked and offline; `after-ok-seconds` for ready, confirmed once the outcome has been `ready` for `bootOkSeconds` with the process alive, or by the game's `confirmBoot()`; `never` for running and error), and a confirmed launch resets `failedBoots` to 0. Version 3 (plans/P4-01.md §2.10) adds packs: the option `essentialPacks` (default []: packs the boot wants before ready but can play without), `fetch.consent {bytes, metered}` (accepted in `fetch`: the outcome waits, key `fetch:waiting`, and `consent_needed` is emitted), `fetch.progress {done, total}` (integers, 0 <= done <= total; accepted in `fetch` and `fetch:waiting`: the outcome runs, `fetch_progress` is emitted), `fetch.done` accepted in `fetch:waiting` and its result `declined`. The fetch rule: with a required pack missing, `offline` stops at `offline {canPlayOffline: false}`, `declined` at `blocked {reason: content-declined}` and anything else at `error {fetch-failed}`; with every required pack present and an essential one missing, `offline` stops at `offline {canPlayOffline: true}` (key `offline:playable`, where `play-offline` goes to `mount`); otherwise `mount`. `BootState.canPlayOffline` is true only at that playable offline stop. Append-only: a change to the vocabulary, to `accepts` or to an existing row's expectation bumps `stageMatrixVersion`.",
    maxFailedBoots: STAGE_MAX_FAILED_BOOTS,
    bootOkSeconds: STAGE_BOOT_OK_SECONDS,
    vocabulary: { ...STAGE_VOCABULARY, confirmations: STAGE_CONFIRMATIONS },
    accepts: STAGE_ACCEPTS,
    probes: STAGE_PROBES,
    rows,
    guardCases: STAGE_GUARD_CASES,
    confirmCases: STAGE_CONFIRM_CASES,
  };
}

// ── §4.8 the stage matrix, version 2: boot confirmation ─────────────────────────────────────

const STAGE_BOOT_OK_SECONDS = 10;
const STAGE_CONFIRMATIONS = ["now", "after-ok-seconds", "never"];
const STAGE_CONFIRM_CASES = [
  { outcome: "running", expect: "never" },
  { outcome: "waiting", expect: "now" },
  { outcome: "ready", expect: "after-ok-seconds" },
  { outcome: "blocked", expect: "now" },
  { outcome: "offline", expect: "now" },
  { outcome: "error", expect: "never" },
];

/** The stage matrix's self-check gains "every outcome has one confirm case" (§4.8). */
function checkConfirmCases(): void {
  const outcomes = STAGE_VOCABULARY.outcomes;
  const listed = STAGE_CONFIRM_CASES.map((c) => c.outcome);
  if (
    JSON.stringify([...listed].sort()) !==
      JSON.stringify([...outcomes].sort()) ||
    new Set(listed).size !== listed.length
  )
    throw new Error(
      "stage-matrix: every outcome needs exactly one confirm case",
    );
  for (const c of STAGE_CONFIRM_CASES)
    if (!STAGE_CONFIRMATIONS.includes(c.expect))
      throw new Error(`stage-matrix: confirm ${c.outcome}`);
}
