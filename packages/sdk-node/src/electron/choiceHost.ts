// The main-process half of the v6 licence and device choice (UK-42.22.7). A device sign-in that
// started with `licenseChoice: "app"` ends in `choose` with a grant. The grant is a credential,
// so it stays in THIS process: the renderer gets an opaque ref (128 random bits) bound to the
// window that polled, and every choice call names the ref. The ref is released when the choice
// completes, is cancelled, expires, or the window goes away. Nothing below is spread from the
// SDK's answer except the views the Worker built for the person to read.

import { randomBytes } from "node:crypto";
import type { PolarisKeyClient } from "../client.js";

/** The window a call came from. */
export interface ChoiceWindow {
  readonly id: number;
  isDestroyed?(): boolean;
  once?(event: "destroyed", listener: () => void): unknown;
}

/** What the renderer reads once a poll ends in `choose`. `grant` is the ref, never the grant. */
export interface ChooseView {
  kind: "choose";
  grant: string;
  expiresIn: number;
  choices: Record<string, unknown>;
}

export interface ChoiceHostDeps {
  choice(): PolarisKeyClient["identity"]["choice"];
  /** A choice completed: push state and notify. */
  signedIn(): void;
  /** A choice finished after its ref had ended (a sign-out, expiry or closed window got there
   *  first): undo what the late result stored. */
  discard(): Promise<unknown>;
  /** A ref ended (its sign-in flow can go). */
  ended(flowId: string): void;
  now?: () => number;
}

interface Rec {
  flowId: string;
  grant: string;
  windowId: number;
  expiresAt: number;
  choices: Record<string, unknown>;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const REFUSED = {
  kind: "refused",
  code: "invalid_grant",
  httpStatus: 400,
} as const;

export class ChoiceInputError extends Error {}

const text = (v: unknown, name: string, max: number): string => {
  if (typeof v !== "string" || v === "" || v.length > max)
    throw new ChoiceInputError(`${name} must be a non-empty string.`);
  return v;
};

/** The person's choice, rebuilt member by member: an unknown kind or member is refused. */
export function choiceInput(
  v: unknown,
): Parameters<PolarisKeyClient["identity"]["choice"]["complete"]>[1] {
  const b = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  switch (b.kind) {
    case "keep":
      return { kind: "keep" };
    case "create":
      return { kind: "create" };
    case "key":
      return { kind: "key", key: text(b.key, "key", 256) };
    case "license":
      return {
        kind: "license",
        licenseId: text(b.licenseId, "licenseId", 128),
        ...(b.replaceDeviceId !== undefined
          ? { replaceDeviceId: text(b.replaceDeviceId, "replaceDeviceId", 128) }
          : {}),
      };
    default:
      throw new ChoiceInputError("choice.kind is not one the bridge accepts.");
  }
}

export function createChoiceHost(deps: ChoiceHostDeps) {
  const now = deps.now ?? Date.now;
  const recs = new Map<string, Rec>();
  const byFlow = new Map<string, string>();

  const end = (ref: string): void => {
    const r = recs.get(ref);
    if (!r) return;
    clearTimeout(r.timer);
    recs.delete(ref);
    byFlow.delete(r.flowId);
    deps.ended(r.flowId);
  };

  /** The live record for `ref` when `windowId` made it; else nothing (one answer for unknown,
   *  expired and foreign refs). */
  const live = (windowId: number, ref: unknown): [string, Rec] | null => {
    if (typeof ref !== "string") return null;
    const r = recs.get(ref);
    if (!r || r.windowId !== windowId) return null;
    if (now() >= r.expiresAt) {
      end(ref);
      return null;
    }
    return [ref, r];
  };

  const view = (ref: string, r: Rec): ChooseView => ({
    kind: "choose",
    grant: ref,
    expiresIn: Math.max(0, Math.ceil((r.expiresAt - now()) / 1000)),
    choices: r.choices,
  });

  const bag = (a: unknown): Record<string, unknown> =>
    typeof a === "object" && a !== null ? (a as Record<string, unknown>) : {};

  return {
    /** A poll ended in `choose`: bind the grant to `wc` (the same flow polled again gets the
     *  same ref back). */
    issue(
      wc: ChoiceWindow,
      flowId: string,
      o: { grant: string; expiresIn: number; choices: Record<string, unknown> },
    ): ChooseView {
      const known = byFlow.get(flowId);
      const again = known ? live(wc.id, known) : null;
      if (again) return view(again[0], again[1]);
      const ref = randomBytes(16).toString("hex");
      const ms = Math.max(0, o.expiresIn) * 1000;
      const timer = setTimeout(() => end(ref), ms);
      timer.unref?.();
      const r: Rec = {
        flowId,
        grant: o.grant,
        windowId: wc.id,
        expiresAt: now() + ms,
        choices: o.choices,
        busy: false,
        timer,
      };
      recs.set(ref, r);
      byFlow.set(flowId, ref);
      wc.once?.("destroyed", () => end(ref));
      return view(ref, r);
    },
    /** Has this flow ended in `choose` (for any window) and not yet been released? */
    has(flowId: string): boolean {
      return byFlow.has(flowId);
    },
    /** Has this flow already ended in `choose` for this window? */
    again(wc: ChoiceWindow, flowId: string): ChooseView | null {
      const ref = byFlow.get(flowId);
      const l = ref ? live(wc.id, ref) : null;
      return l ? view(l[0], l[1]) : null;
    },
    async licenses(wc: ChoiceWindow, a: unknown) {
      const l = live(wc.id, bag(a).grant);
      return l ? deps.choice().licenses(l[1].grant) : REFUSED;
    },
    async devices(wc: ChoiceWindow, a: unknown) {
      const b = bag(a);
      const l = live(wc.id, b.grant);
      if (!l) return REFUSED;
      return deps
        .choice()
        .devices(l[1].grant, text(b.licenseId, "licenseId", 128));
    },
    async complete(wc: ChoiceWindow, a: unknown) {
      const b = bag(a);
      const l = live(wc.id, b.grant);
      if (!l) return REFUSED;
      const choice = choiceInput(b.choice);
      const [ref, r] = l;
      if (r.busy) return REFUSED;
      r.busy = true;
      try {
        const res = await deps.choice().complete(r.grant, choice);
        if (res.kind === "ok") {
          // The ref may have ended while the Worker answered. The client has stored the token by
          // now, so the late result is undone, not announced.
          if (recs.get(ref) !== r) {
            await deps.discard().catch(() => undefined);
            return REFUSED;
          }
          end(ref);
          deps.signedIn();
        }
        return res;
      } finally {
        r.busy = false;
      }
    },
    async cancel(wc: ChoiceWindow, a: unknown) {
      const l = live(wc.id, bag(a).grant);
      if (!l) return REFUSED;
      const [ref, r] = l;
      if (r.busy) return REFUSED;
      try {
        return await deps.choice().cancel(r.grant);
      } finally {
        end(ref);
      }
    },
    /** The flow is over: release the ref it holds, if any. */
    dropFlow(flowId: string): void {
      const ref = byFlow.get(flowId);
      if (ref) end(ref);
    },
    dropAll(): void {
      for (const ref of [...recs.keys()]) end(ref);
    },
  };
}
