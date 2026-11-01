// The main-process half of the v5 automatic and nearby sign-in methods (I-47b). The renderer
// never holds a permit: it holds an `askId` (128 random bits, single use, bound to the window
// that received it) and calls `approverPick`, which makes THIS process call the SDK's own
// `ask.pick`. Nothing in a reply or a state push is a token, a key, a request id or a wrap: every
// shape below is built field by field from the SDK's answer, never spread.

import { randomBytes } from "node:crypto";
import type { PolarisKeyClient } from "../client.js";
import type {
  NearbyApproverHandle,
  NearbyStopReason,
} from "../connect/nearbyApprover.js";
import type {
  NearbyApprovalStep,
  NearbyAsk,
} from "../identity/nearbyApprover.js";
import type { NearbySignInSession } from "../identity/nearbySession.js";
import { cleanLabel } from "@polaris-key/client-core/peer";
import { ErrorCode } from "../constants.generated.js";

/** The refusal a method answers with (the host maps it onto its envelope). */
export class NearbyRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type RequesterPhase =
  | "searching"
  | "choose-approver"
  | "waiting"
  | "confirm-account"
  | "confirming"
  | "done"
  | "denied"
  | "expired"
  | "not-nearby"
  | "unsupported"
  | "device-limit"
  | "rate-limited"
  | "cancelled";

const TERMINAL: ReadonlySet<RequesterPhase> = new Set([
  "done",
  "denied",
  "expired",
  "not-nearby",
  "unsupported",
  "device-limit",
  "rate-limited",
  "cancelled",
]);

export interface NearbyRequesterView {
  sessionId: string;
  phase: Exclude<RequesterPhase, "confirming">;
  approvers: { id: string; device: string | null; platform: string }[];
  code?: string;
  email?: string;
}

export interface NearbyAskView {
  askId: string;
  device: string | null;
  platform: string;
  codes: [string, string, string];
}

export interface NearbyApproverView {
  listening: boolean;
  /** Why the advert stopped on its own (declined requests, sign-out, discovery). */
  stopped?: Exclude<NearbyStopReason, "host">;
  asks: NearbyAskView[];
}

export interface NearbyStateView {
  requester?: NearbyRequesterView;
  approver?: NearbyApproverView;
}

export type NearbyStepView =
  | {
      kind:
        | "approved"
        | "not-nearby"
        | "mismatch"
        | "denied"
        | "expired"
        | "device-limit"
        | "account-required"
        | "rate-limited"
        | "failed";
    }
  | { kind: "choose"; choices: { licenseId: string; name: string }[] };

/** The window a method came from. */
export interface NearbyWindow {
  readonly id: number;
  isDestroyed?(): boolean;
  once?(event: "destroyed", listener: () => void): unknown;
}

export interface NearbyHostDeps {
  identity: PolarisKeyClient["identity"];
  /** Send the window its state now (a no-op when it is not subscribed). The host re-checks
   *  `allowSender` for the window first; `false` means it was refused and its asks must die. */
  push(wc: NearbyWindow): boolean;
  /** The client's state changed (a sign-in finished): push every subscriber. */
  pushAll(): void;
  /** OS notification hook for a finished sign-in. */
  signedIn(): void;
  /** The device name a sign-in reports when the renderer names none. */
  deviceName?: string;
}

interface RequesterRec {
  id: string;
  wc: NearbyWindow;
  session: NearbySignInSession;
  phase: RequesterPhase;
  /** Opaque ref → the SDK's approver id (the SDK's id never leaves this process). */
  refs: Map<string, string>;
  byId: Map<string, string>;
  code?: string;
  email?: string;
  offs: (() => void)[];
  waiting: boolean;
}

type AskPhase = "open" | "picking" | "choosing";

interface AskRec {
  id: string;
  ask: NearbyAsk;
  phase: AskPhase;
  step?: Extract<NearbyApprovalStep, { kind: "choose" }>;
  choiceIds?: Set<string>;
}

interface ApproverRec {
  wc: NearbyWindow;
  handle: NearbyApproverHandle | null;
  asks: Map<string, AskRec>;
  stopped: boolean;
  /** The advert stopped on its own (`onStopped`); the screen says so and may start it again. */
  ended?: Exclude<NearbyStopReason, "host">;
}

/** Waiting asks at once (the SDK's own session cap). */
const MAX_ASKS = 8;

const hex = (n: number): string => randomBytes(n).toString("hex");

const refuse = (message: string, code = "invalid-argument"): never => {
  throw new NearbyRefusal(code, message);
};

/** A renderer's device name, cleaned and cut as the SDK's own device label is (64 code points);
 *  `undefined` when nothing is left. */
const boundName = (v: unknown): string | undefined =>
  (typeof v === "string" ? cleanLabel(v) : null) ?? undefined;

/** What this computer is called on the other device when the app names none: the kind of
 *  computer, never its host name. */
const friendlyDevice = (): string =>
  process.platform === "darwin"
    ? "Mac"
    : process.platform === "win32"
      ? "Windows PC"
      : "Linux PC";

const NOT_OPEN = "That nearby request is not open.";

export function createNearbyHost(deps: NearbyHostDeps) {
  let requester: RequesterRec | null = null;
  let approver: ApproverRec | null = null;
  const watched = new Set<number>();

  /** A window going away ends everything bound to it. */
  const watch = (wc: NearbyWindow): void => {
    if (watched.has(wc.id)) return;
    watched.add(wc.id);
    wc.once?.("destroyed", () => {
      watched.delete(wc.id);
      dropFor(wc.id);
    });
  };

  const requesterView = (r: RequesterRec): NearbyRequesterView => ({
    sessionId: r.id,
    // `confirming` is the host's own step; the renderer keeps seeing the account it is confirming.
    phase: r.phase === "confirming" ? "confirm-account" : r.phase,
    approvers: [...r.session.approvers].map((a) => {
      let ref = r.byId.get(a.id);
      if (ref === undefined) {
        ref = hex(8);
        r.byId.set(a.id, ref);
        r.refs.set(ref, a.id);
      }
      return { id: ref, device: a.label, platform: a.platform };
    }),
    ...(r.code !== undefined ? { code: r.code } : {}),
    ...(r.email !== undefined ? { email: r.email } : {}),
  });

  const approverView = (a: ApproverRec): NearbyApproverView => ({
    listening: !a.stopped && a.ended === undefined,
    ...(a.ended !== undefined ? { stopped: a.ended } : {}),
    asks: [...a.asks.values()]
      .filter((k) => k.phase === "open")
      .map((k) => ({
        askId: k.id,
        device: k.ask.device,
        platform: k.ask.platform,
        codes: [k.ask.codes[0], k.ask.codes[1], k.ask.codes[2]],
      })),
  });

  /** The nearby member of the state pushed to (or read by) one window. */
  const stateFor = (wcId: number): NearbyStateView => {
    const out: NearbyStateView = {};
    if (requester && requester.wc.id === wcId)
      out.requester = requesterView(requester);
    if (approver && approver.wc.id === wcId)
      out.approver = approverView(approver);
    return out;
  };

  const pushTo = (wc: NearbyWindow): void => {
    if (!deps.push(wc)) dropFor(wc.id);
  };

  const setPhase = (r: RequesterRec, phase: RequesterPhase): void => {
    if (TERMINAL.has(r.phase)) return;
    r.phase = phase;
  };

  const endRequester = (r: RequesterRec, phase: RequesterPhase): void => {
    for (const off of r.offs.splice(0)) off();
    if (!TERMINAL.has(r.phase)) {
      try {
        r.session.cancel();
      } catch {
        // Already over.
      }
    }
    setPhase(r, phase);
  };

  const failedPhase = (e: unknown): RequesterPhase => {
    switch ((e as { code?: unknown } | null)?.code) {
      case ErrorCode.signInDenied:
        return "denied";
      case ErrorCode.notNearby:
        return "not-nearby";
      case ErrorCode.nearbyUnsupported:
        return "unsupported";
      case ErrorCode.deviceLimit:
        return "device-limit";
      case ErrorCode.rateLimited:
        return "rate-limited";
      default:
        return "expired";
    }
  };

  const runWait = async (r: RequesterRec): Promise<void> => {
    if (r.waiting) return;
    r.waiting = true;
    try {
      const o = await r.session.wait();
      if (requester !== r) return;
      if (o.kind === "signedIn") {
        r.email = o.identity?.email;
        if (r.email === undefined) delete r.email;
        setPhase(r, "confirm-account");
      } else if (o.kind === "cancelled") {
        setPhase(r, "cancelled");
      } else {
        setPhase(r, "expired");
      }
    } catch (e) {
      if (requester !== r) return;
      setPhase(r, failedPhase(e));
    }
    pushTo(r.wc);
  };

  const mine = (wc: NearbyWindow, sessionId: unknown): RequesterRec => {
    const r = requester;
    if (
      r === null ||
      typeof sessionId !== "string" ||
      r.id !== sessionId ||
      r.wc.id !== wc.id
    )
      return refuse(NOT_OPEN);
    return r;
  };

  const stepView = (s: NearbyApprovalStep): NearbyStepView =>
    s.kind === "choose"
      ? {
          kind: "choose",
          choices: s.choices.choices.map((c) => ({
            licenseId: c.id,
            name: c.name ?? c.tierName,
          })),
        }
      : { kind: s.kind };

  const askOf = (wc: NearbyWindow, askId: unknown): AskRec => {
    const a = approver;
    const k =
      a !== null && !a.stopped && a.wc.id === wc.id && typeof askId === "string"
        ? a.asks.get(askId)
        : undefined;
    return k ?? refuse(NOT_OPEN);
  };

  /** After a pick or a choice: a `choose` step keeps the ask for one `approverChoose`; any other
   *  step ends it. */
  const settle = (
    a: ApproverRec,
    k: AskRec,
    step: NearbyApprovalStep,
  ): NearbyStepView => {
    if (step.kind === "choose" && !a.stopped) {
      k.phase = "choosing";
      k.step = step;
      k.choiceIds = new Set(step.choices.choices.map((c) => c.id));
    } else {
      a.asks.delete(k.id);
    }
    pushTo(a.wc);
    return stepView(step);
  };

  const stopApprover = (a: ApproverRec): void => {
    if (a.stopped) return;
    a.stopped = true;
    if (approver === a) approver = null;
    const asks = [...a.asks.values()];
    a.asks.clear();
    void a.handle?.stop().catch(() => undefined);
    for (const k of asks) {
      if (k.phase === "open") void k.ask.deny().catch(() => undefined);
      else if (k.phase === "choosing")
        void k.step?.cancel().catch(() => undefined);
    }
  };

  function dropFor(wcId: number): void {
    if (approver && approver.wc.id === wcId) stopApprover(approver);
    if (requester && requester.wc.id === wcId)
      endRequester(requester, "cancelled");
  }

  return {
    stateFor,

    async autoSignIn(args: unknown) {
      const b =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const o: Parameters<PolarisKeyClient["identity"]["autoSignIn"]>[0] = {};
      if (b.prompt === "none" || b.prompt === "optional") o.prompt = b.prompt;
      if (b.licenseChoice === "app" || b.licenseChoice === "card")
        o.licenseChoice = b.licenseChoice;
      const name = boundName(b.deviceName) ?? deps.deviceName;
      if (name !== undefined) o.deviceName = name;
      const r = await deps.identity.autoSignIn(o);
      if (r.kind === "signedIn") {
        deps.pushAll();
        return {
          kind: "signedIn",
          via: r.via,
          subject: r.subject,
          activation: { licenseId: r.activation.licenseId },
        };
      }
      if (r.kind === "needsSignIn")
        return { kind: "needsSignIn", reason: r.reason };
      return { kind: "unavailable", code: r.code };
    },

    async nearbyStart(wc: NearbyWindow, args: unknown) {
      const b =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const name = boundName(b.deviceName) ?? deps.deviceName;
      const session = await deps.identity.signIn.start({
        channel: "nearby",
        ...(name ? { deviceName: name } : {}),
      });
      // One requester per host: a new one replaces the old.
      if (requester) {
        const old = requester;
        endRequester(old, "cancelled");
        // Tell the window that lost its session (a no-op when it is the same window).
        pushTo(old.wc);
      }
      const r: RequesterRec = {
        id: hex(16),
        wc,
        session,
        phase: session.approvers.length > 0 ? "choose-approver" : "searching",
        refs: new Map(),
        byId: new Map(),
        offs: [],
        waiting: false,
      };
      requester = r;
      watch(wc);
      r.offs.push(
        session.onApprovers((list) => {
          if (requester !== r) return;
          if (r.phase === "searching" || r.phase === "choose-approver")
            r.phase = list.length > 0 ? "choose-approver" : "searching";
          pushTo(wc);
        }),
        session.onResult((status) => {
          // Display only: the poll is the authority.
          if (requester !== r || r.phase !== "waiting") return;
          if (status === "denied") setPhase(r, "denied");
          else if (status === "expired") setPhase(r, "expired");
          pushTo(wc);
        }),
      );
      return requesterView(r);
    },

    async nearbyChoose(wc: NearbyWindow, sessionId: unknown, ref: unknown) {
      const r = mine(wc, sessionId);
      if (r.phase !== "searching" && r.phase !== "choose-approver")
        return refuse("An approver is already chosen.");
      const id = typeof ref === "string" ? r.refs.get(ref) : undefined;
      if (id === undefined) return refuse("That approver is not listed.");
      const { code } = await r.session.choose(id);
      if (requester !== r) return refuse(NOT_OPEN);
      r.code = code;
      setPhase(r, "waiting");
      void runWait(r);
      return requesterView(r);
    },

    async nearbyConfirm(wc: NearbyWindow, sessionId: unknown) {
      const r = mine(wc, sessionId);
      if (r.phase !== "confirm-account")
        return refuse("There is no account to confirm.");
      // Synchronously, before the await: a second confirm or a decline now finds no account.
      r.phase = "confirming";
      try {
        await r.session.confirmAccount();
      } catch (e) {
        if (r.phase === "confirming") r.phase = "confirm-account";
        throw e;
      }
      for (const off of r.offs.splice(0)) off();
      // A sign-out that landed meanwhile ended the requester: nothing is signed in to announce.
      if (r.phase !== "confirming") return requesterView(r);
      r.phase = "done";
      deps.pushAll();
      deps.signedIn();
      return requesterView(r);
    },

    async nearbyDecline(wc: NearbyWindow, sessionId: unknown) {
      const r = mine(wc, sessionId);
      if (r.phase !== "confirm-account")
        return refuse("There is no account to decline.");
      r.phase = "confirming";
      for (const off of r.offs.splice(0)) off();
      try {
        await r.session.declineAccount();
      } finally {
        r.phase = "cancelled";
      }
      deps.pushAll();
      return requesterView(r);
    },

    async nearbyCancel(wc: NearbyWindow, sessionId: unknown) {
      const r = mine(wc, sessionId);
      endRequester(r, "cancelled");
      pushTo(wc);
      return null;
    },

    async approverStart(wc: NearbyWindow) {
      if (approver) {
        if (approver.wc.id !== wc.id && approver.wc.isDestroyed?.() !== true)
          return refuse("Another window is already approving.", "busy");
        if (approver.wc.id === wc.id) {
          // Stopped by the declined-request budget: opening the screen again counts from zero.
          if (approver.ended === "budget" && approver.handle) {
            await approver.handle.reopen();
            delete approver.ended;
            pushTo(wc);
            return approverView(approver);
          }
          // Stopped for good (signed out, discovery): a fresh approver below.
          if (approver.ended === undefined) return approverView(approver);
        }
        stopApprover(approver);
      }
      const a: ApproverRec = {
        wc,
        handle: null,
        asks: new Map(),
        stopped: false,
      };
      approver = a;
      watch(wc);
      try {
        const handle = await deps.identity.nearby.onRequest(
          (ask) => {
            if (a.stopped) return;
            if (a.asks.size >= MAX_ASKS) {
              void ask.deny().catch(() => undefined);
              return;
            }
            const k: AskRec = { id: hex(16), ask, phase: "open" };
            a.asks.set(k.id, k);
            // The session ended unanswered (expired, or the peer left): the ask is no longer open.
            ask.onEnd?.(() => {
              if (a.asks.get(k.id) !== k || k.phase !== "open") return;
              a.asks.delete(k.id);
              pushTo(wc);
            });
            pushTo(wc);
          },
          {
            prompt: true,
            label: deps.deviceName ?? friendlyDevice(),
            onStopped: (why) => {
              if (why === "host" || a.stopped) return;
              a.ended = why;
              // Whatever was waiting can no longer be answered.
              const asks = [...a.asks.values()];
              a.asks.clear();
              for (const k of asks)
                if (k.phase === "open")
                  void k.ask.deny().catch(() => undefined);
              pushTo(wc);
            },
          },
        );
        a.handle = handle;
        // Stopped (or the window left) while the advert was starting.
        if (a.stopped) await handle.stop().catch(() => undefined);
      } catch (e) {
        if (approver === a) approver = null;
        a.stopped = true;
        throw e;
      }
      return approverView(a);
    },

    async approverStop(wc: NearbyWindow) {
      if (approver && approver.wc.id === wc.id) {
        stopApprover(approver);
        pushTo(wc);
      }
      return null;
    },

    async approverPick(wc: NearbyWindow, askId: unknown, code: unknown) {
      const k = askOf(wc, askId);
      const a = approver!;
      if (k.phase !== "open") return refuse(NOT_OPEN);
      if (typeof code !== "string" || !k.ask.codes.includes(code))
        return refuse("That is not one of the codes shown.");
      // Single use: the ask is spent before the pick runs.
      k.phase = "picking";
      let step: NearbyApprovalStep;
      try {
        step = await k.ask.pick(code);
      } catch (e) {
        a.asks.delete(k.id);
        pushTo(wc);
        throw e;
      }
      return settle(a, k, step);
    },

    async approverDeny(wc: NearbyWindow, askId: unknown) {
      const k = askOf(wc, askId);
      const a = approver!;
      if (k.phase === "picking") return refuse(NOT_OPEN);
      a.asks.delete(k.id);
      pushTo(wc);
      if (k.phase === "choosing") await k.step!.cancel();
      else await k.ask.deny();
      return null;
    },

    async approverChoose(wc: NearbyWindow, askId: unknown, choice: unknown) {
      const k = askOf(wc, askId);
      const a = approver!;
      if (k.phase !== "choosing" || !k.step) return refuse(NOT_OPEN);
      const c =
        choice && typeof choice === "object"
          ? (choice as Record<string, unknown>)
          : {};
      const step = k.step;
      let run: () => Promise<NearbyApprovalStep>;
      if (c.kind === "decline") run = () => step.cancel();
      else if (c.kind === "create") run = () => step.choose({ kind: "create" });
      else if (
        c.kind === "license" &&
        typeof c.licenseId === "string" &&
        k.choiceIds?.has(c.licenseId)
      ) {
        const licenseId = c.licenseId;
        run = () => step.choose({ kind: "license", licenseId });
      } else return refuse("That is not one of the licenses offered.");
      k.phase = "picking";
      delete k.step;
      let next: NearbyApprovalStep;
      try {
        next = await run();
      } catch (e) {
        a.asks.delete(k.id);
        pushTo(wc);
        throw e;
      }
      return settle(a, k, next);
    },

    /** Sign-out, `close()` and a signed-out event: every ask, the approver and the requester go. */
    dropAll(): void {
      if (approver) stopApprover(approver);
      if (requester) endRequester(requester, "cancelled");
    },
  };
}
