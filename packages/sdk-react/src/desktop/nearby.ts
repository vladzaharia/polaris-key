// Nearby sign-in over the v5 desktop bridge (I-47b.2). The host owns every session and every
// permit; this file holds the renderer's view of them and maps it onto the ui-core inputs the
// kit already draws (`AutoSignInInput` for the new device "D", `NearbyApprovalInput` for the
// signed-in device "M"). An `askId` and a `sessionId` are opaque: they are read from the host's
// pushes and replies and handed back as they came, never built here. The renderer never sees a
// request id, a key, a token or the key-ring wrap.

import type {
  AutoSignInInput,
  NearbyApprovalInput,
} from "@polaris-key/ui-core";
import { ErrorCode, Feature } from "../constants.generated.js";
import { PolarisError, UnsupportedError } from "../core/index.js";
import type {
  BridgeNearbyApproverState,
  BridgeNearbyAsk,
  BridgeNearbyChoice,
  BridgeNearbyRequester,
  BridgeNearbyState,
  BridgeNearbyStep,
  PolarisBridge,
} from "./bridge.js";

/** The requester's phase as the `AutoSignInInput` step the kit draws, or null when the phase has
 *  no step of its own (a refusal or an end the app words itself: read `phase`). */
export function requesterInput(
  r: BridgeNearbyRequester | null,
): AutoSignInInput | null {
  if (!r) return null;
  switch (r.phase) {
    case "searching":
    case "choose-approver":
      return { step: "nearby-wait" };
    case "waiting":
      return { step: "nearby-wait", ...(r.code ? { code: r.code } : {}) };
    case "confirm-account":
      return { step: "confirm", ...(r.email ? { email: r.email } : {}) };
    case "done":
      return { step: "nearby-done" };
    case "device-limit":
      return { step: "device-limit" };
    default:
      return null;
  }
}

/** One ask or its outcome as the `NearbyApprovalInput` the kit draws. */
export function approvalInput(
  ask: BridgeNearbyAsk | null,
  step: BridgeNearbyStep | null,
): NearbyApprovalInput {
  const device = ask?.device ?? undefined;
  const named = device === undefined ? {} : { device };
  if (!step) return { step: "ask", ...named };
  return { step: step.kind, ...named };
}

/** The typed refusal every method returns on a host that predates bridge protocol v5. */
export function nearbyUnsupported(version: number | undefined): PolarisError {
  return new UnsupportedError(
    {
      supported: false,
      feature: Feature.identityNearby,
      reason: "version",
      detail: `This desktop bridge (protocol v${version ?? 1}) does not carry nearby sign-in; bridge protocol v5 adds it.`,
    },
    "unsupported",
  );
}

/** A host refusal (a stale or foreign `askId`, a closed session) keeps the host's code and words.
 *  Anything else is a transport failure. */
export function nearbyError(e: unknown): PolarisError {
  if (e instanceof PolarisError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : "The host refused.";
  // A host refusal is the caller's argument being wrong (a spent or foreign id, a code not
  // shown); its own code rides along as the wire code.
  return typeof code === "string"
    ? new PolarisError(ErrorCode.invalidArgument, message, code)
    : new PolarisError(ErrorCode.network, message);
}

const TERMINAL: ReadonlySet<BridgeNearbyRequester["phase"]> = new Set([
  "done",
  "denied",
  "expired",
  "not-nearby",
  "unsupported",
  "device-limit",
  "rate-limited",
  "cancelled",
]);

/** The new device's session ("D"). It follows the host's replies and the pushed state. */
export class DesktopNearbyRequester {
  private cur: BridgeNearbyRequester | null = null;
  private readonly subs = new Set<() => void>();

  constructor(
    private readonly bridge: PolarisBridge,
    first: BridgeNearbyRequester,
    private readonly drop: () => void,
  ) {
    this.cur = first;
  }

  get state(): BridgeNearbyRequester | null {
    return this.cur;
  }
  get phase(): BridgeNearbyRequester["phase"] | null {
    return this.cur?.phase ?? null;
  }
  get input(): AutoSignInInput | null {
    return requesterInput(this.cur);
  }
  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** Called with every pushed `BridgeState.nearby`. Another session's push is ignored. */
  adopt(n: BridgeNearbyState | undefined): void {
    if (!this.cur) return;
    const r = n?.requester;
    if (r && r.sessionId === this.cur.sessionId) this.set(r);
    else if (!r && !TERMINAL.has(this.cur.phase)) {
      // The host ended a live session (sign-out, window close): nothing to ask any more.
      this.cur = null;
      this.notify();
      this.drop();
    }
  }

  async choose(approverId: string): Promise<void> {
    await this.step((id) => this.bridge.nearbyChoose!(id, approverId));
  }
  async confirm(): Promise<void> {
    await this.step((id) => this.bridge.nearbyConfirm!(id));
  }
  async decline(): Promise<void> {
    await this.step((id) => this.bridge.nearbyDecline!(id));
  }
  async cancel(): Promise<void> {
    const id = this.cur?.sessionId;
    if (id === undefined) return;
    try {
      await this.bridge.nearbyCancel!(id);
    } catch (e) {
      throw nearbyError(e);
    } finally {
      this.cur = null;
      this.notify();
      this.drop();
    }
  }

  private async step(
    run: (sessionId: string) => Promise<BridgeNearbyRequester>,
  ): Promise<void> {
    const id = this.cur?.sessionId;
    if (id === undefined)
      throw new PolarisError(
        ErrorCode.invalidArgument,
        "That nearby request is not open.",
      );
    try {
      this.set(await run(id));
    } catch (e) {
      throw nearbyError(e);
    }
  }

  private set(r: BridgeNearbyRequester): void {
    this.cur = r;
    this.notify();
  }
  private notify(): void {
    for (const cb of [...this.subs]) cb();
  }
}

/** The signed-in device's approver ("M"): the asks the host holds, and what became of each. */
export class DesktopNearbyApprover {
  private cur: BridgeNearbyApproverState = { listening: false, asks: [] };
  private readonly out = new Map<string, BridgeNearbyStep>();
  private readonly subs = new Set<() => void>();

  constructor(private readonly bridge: PolarisBridge) {}

  get listening(): boolean {
    return this.cur.listening;
  }
  get asks(): readonly BridgeNearbyAsk[] {
    return this.cur.asks;
  }
  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** What the kit draws for one ask: the prompt, then the outcome of the pick. */
  input(askId: string): NearbyApprovalInput | null {
    const ask = this.cur.asks.find((a) => a.askId === askId) ?? null;
    const step = this.out.get(askId) ?? null;
    return ask || step ? approvalInput(ask, step) : null;
  }
  /** The licences a `choose` step offers; empty for any other state. */
  choices(askId: string): { licenseId: string; name: string }[] {
    const s = this.out.get(askId);
    return s?.kind === "choose" ? s.choices : [];
  }

  adopt(n: BridgeNearbyState | undefined): void {
    this.cur = n?.approver ?? { listening: false, asks: [] };
    // An outcome is kept only while the host still knows the ask, or it is a settled outcome.
    this.notify();
  }

  async start(): Promise<void> {
    try {
      this.cur = await this.bridge.approverStart!();
      this.notify();
    } catch (e) {
      throw nearbyError(e);
    }
  }
  async stop(): Promise<void> {
    try {
      await this.bridge.approverStop!();
    } catch (e) {
      throw nearbyError(e);
    } finally {
      this.cur = { listening: false, asks: [] };
      this.out.clear();
      this.notify();
    }
  }
  /** Tap one of the three codes. The host's own pick runs; a code that is not shown is refused. */
  async pick(askId: string, code: string): Promise<BridgeNearbyStep> {
    return this.settle(askId, () => this.bridge.approverPick!(askId, code));
  }
  /** Give the new device a licence, a new one, or decline (after a `choose` step). */
  async choose(
    askId: string,
    choice: BridgeNearbyChoice,
  ): Promise<BridgeNearbyStep> {
    return this.settle(askId, () => this.bridge.approverChoose!(askId, choice));
  }
  /** "None of these match", or Deny at the licence choice. */
  async deny(askId: string): Promise<void> {
    try {
      await this.bridge.approverDeny!(askId);
    } catch (e) {
      this.forget(askId);
      throw nearbyError(e);
    }
    this.out.set(askId, { kind: "denied" });
    this.notify();
  }
  /** The person closed an outcome. */
  dismiss(askId: string): void {
    this.forget(askId);
  }

  private async settle(
    askId: string,
    run: () => Promise<BridgeNearbyStep>,
  ): Promise<BridgeNearbyStep> {
    let step: BridgeNearbyStep;
    try {
      step = await run();
    } catch (e) {
      // The host spent or never knew this ask: drop what we hold for it.
      this.forget(askId);
      throw nearbyError(e);
    }
    this.out.set(askId, step);
    this.notify();
    return step;
  }
  private forget(askId: string): void {
    this.out.delete(askId);
    this.notify();
  }
  private notify(): void {
    for (const cb of [...this.subs]) cb();
  }
}
