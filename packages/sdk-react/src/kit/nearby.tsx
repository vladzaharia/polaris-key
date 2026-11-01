"use client";
// Nearby sign-in on the desktop, drawn by the kit (I-47b.3; UXR-47). `<NearbySignIn>` is the new
// device ("D"): it asks a signed-in device nearby, shows the code to choose there, and holds the
// sign-in until the person confirms the account. `<NearbyApprover>` is the signed-in device
// ("M"): it listens while it is on screen, draws the three codes, and answers the pick. Both run
// over `adapter.nearby` (the desktop adapter's, bridge v5) and draw the kit's own SignIn and
// NearbyApproval views, so the words, the states and the keys are the web kit's. They load on
// demand (nearbyLazy.tsx), so the gate's entry carries none of this.
//
// Rules (UXR-47): leaving the code or licence step answers Deny; the name of the other device is
// worded as it reported itself; nothing says "Signed in" before the host has committed it; the
// codes are the only way to approve, and nothing here sees a key, a token or a request id.

import {
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  MODELS,
  type AutoSignInInput,
  type AutoSignInStep,
  type NearbyApprovalInput,
  type View,
} from "@polaris-key/ui-core";
import { focusClear } from "@polaris-key/ui-core/browser/reveal";

import type { PolarisAdapter } from "../core/index.js";
import type { DesktopAdapter } from "../desktop/desktopAdapter.js";
import {
  requesterInput,
  type DesktopNearbyApprover,
  type DesktopNearbyRequester,
} from "../desktop/nearby.js";
import { PolarisContext } from "../react/context.js";
import { KitRoot, useKit, type KitAction, type KitProps } from "./component.js";
import { withChoice } from "./licenseRows.js";
import { nearbyCode, plain, successMark, type KitCtx } from "./parts.js";
import { SignIn } from "./signin.js";
import { renderView } from "./views.js";

type Nearby = DesktopAdapter["nearby"];

const FEATURE = "identity.nearby";

/** The adapter's nearby namespace where it can run: a desktop adapter on a bridge v5 host. */
function nearbyOf(a: PolarisAdapter | null | undefined): Nearby | null {
  if (!a || a.supports(FEATURE).supported !== true) return null;
  const n = (a as { nearby?: Nearby }).nearby;
  return n &&
    typeof n.request === "function" &&
    typeof n.approver === "function"
    ? n
    : null;
}

/** True until the adapter has its first state from the host. Before that `supports()` answers
 *  from the configured expectation, so a fresh mount must wait, not end "unsupported". */
function useAdapterLoading(a: PolarisAdapter | null): boolean {
  const subscribe = useCallback(
    (cb: () => void) =>
      a && typeof a.subscribe === "function"
        ? a.subscribe(() => cb())
        : () => {},
    [a],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      a && typeof a.snapshot === "function"
        ? a.snapshot().phase === "loading"
        : false,
    () => false,
  );
}

/** How a screen ended, for the host. */
export type NearbyEnd =
  | { kind: "signed-in" }
  | { kind: "signed-out" }
  | { kind: "not-now" }
  | { kind: "cancelled" }
  | { kind: "declined" }
  /** Use a code instead: the host shows its other sign-in. */
  | { kind: "use-code" }
  /** The host reported a refusal or an end the app words itself (`denied`, `expired`,
   *  `not-nearby`, `device-limit`, `rate-limited`, `unsupported`), or the bridge is v4. */
  | { kind: "ended"; phase: string }
  | { kind: "failed"; error: unknown };

const CSS = `@layer polaris-key {
.pk-root .nearby-codes {
  display: grid;
  gap: var(--pk-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.pk-root .nearby-codes .btn {
  inline-size: 100%;
  min-block-size: max(3rem, var(--pk-kit-control-height));
}
/* The codes are codes: the code face, spaced. */
.pk-root .nearby-codes .btn[data-nearby="code"] {
  font-family: var(--pk-kit-type-code-family);
  font-weight: var(--pk-kit-type-code-weight);
  letter-spacing: 0.08em;
  font-size: 1.5rem;
}
/* Devices and licences are names: the body face, from the start edge, no spacing, so words and
   joined scripts never break. */
.pk-root .nearby-codes .btn[data-nearby="row"] {
  justify-content: flex-start;
  text-align: start;
  font-family: var(--pk-kit-type-button-family);
  font-size: var(--pk-kit-type-button-size);
  letter-spacing: normal;
  white-space: normal;
}
.pk-root .nearby-codes bdi {
  overflow-wrap: break-word;
}
.pk-root .nearby-codes .btn[data-nearby="code"] bdi {
  overflow-wrap: anywhere;
}
/* WCAG 2.4.11: choices and Deny sit in the flow, never under a docked bar. */
.pk-root[data-component="NearbyApproval"][data-state="ask"] .stage[data-kind="screen"] .card > .actions,
.pk-root[data-component="NearbyApproval"][data-state="choose"] .stage[data-kind="screen"] .card > .actions,
.pk-root[data-component="SignIn"][data-state="nearby-choose"] .stage[data-kind="screen"] .card > .actions {
  position: static;
  margin: 0;
  padding: 0;
  background: none;
}
.pk-root[data-component="NearbyApproval"][data-state="ask"] .stage[data-kind="screen"] .card > .actions::before,
.pk-root[data-component="NearbyApproval"][data-state="choose"] .stage[data-kind="screen"] .card > .actions::before,
.pk-root[data-component="SignIn"][data-state="nearby-choose"] .stage[data-kind="screen"] .card > .actions::before {
  content: none;
}
.pk-root .nearby-codes .btn:focus-visible,
.pk-root .nearby-more:focus-visible {
  scroll-margin-block: var(--pk-space-6);
}
/* The code to read out is the hero. */
.pk-root[data-component="SignIn"][data-state="nearby-wait"] [data-part="code"] {
  text-align: center;
}
.pk-root[data-component="SignIn"][data-state="nearby-wait"] [data-part="code"] .code-row {
  justify-content: center;
}
.pk-root[data-component="SignIn"][data-state="nearby-wait"] [data-part="code"] .code {
  font-size: clamp(2.25rem, 1.5rem + 4cqi, 3rem);
}
.pk-root .nearby-status {
  display: flex;
  align-items: center;
  gap: var(--pk-space-3);
  margin: 0;
  color: var(--pk-text-muted, inherit);
}
.pk-root .nearby-spin {
  flex: none;
  inline-size: 1rem;
  block-size: 1rem;
  border: 2px solid currentColor;
  border-inline-end-color: transparent;
  border-radius: 50%;
  animation: pk-nearby-spin 0.9s linear infinite;
}
@keyframes pk-nearby-spin {
  to {
    transform: rotate(360deg);
  }
}
.pk-root[data-motion="reduced"] .nearby-spin {
  animation: none;
}
.pk-root .nearby-more {
  justify-self: start;
}
.pk-root .nearby-warn {
  justify-self: center;
  inline-size: 3.5rem;
  block-size: 3.5rem;
  color: var(--pk-warning);
}
.pk-root .card[data-align="start"] .nearby-warn {
  justify-self: start;
}
.pk-root .nearby-warn svg {
  inline-size: 100%;
  block-size: 100%;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
}
.nearby-dialog {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: grid;
  background: Canvas;
}
`;

const sheets = new WeakMap<Document, CSSStyleSheet>();

function adopt(doc: Document): void {
  if (sheets.has(doc) || typeof CSSStyleSheet !== "function") return;
  try {
    const own = new CSSStyleSheet();
    own.replaceSync(CSS);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, own];
    sheets.set(doc, own);
  } catch {
    // No constructable sheets: the host links styles.css.
  }
}

/** A line of copy the view's own list does not carry (a status line, an extra control): left out
 *  while English's second table is still loading, drawn once it is (the kit redraws on load). */
const said = (c: KitCtx, key: string): string | null =>
  c.copy.has(key) ? plain(c, key) : null;

/** The warning mark (▲) above an outcome that did not sign anyone in; decorative, the title says it. */
function warningMark(): ReactNode {
  return (
    <div className="nearby-warn" aria-hidden="true">
      <svg viewBox="0 0 48 48">
        <path d="M24 6 3 42h42z" />
        <path d="M24 19v11M24 35.5v.5" />
      </svg>
    </div>
  );
}

const GOOD = new Set(["nearby-done", "approved"]);
const WARN = new Set([
  "nearby-denied",
  "nearby-expired",
  "nearby-not-nearby",
  "nearby-failed",
  "nearby-rate-limited",
  "nearby-unavailable",
  "mismatch",
  "denied",
  "expired",
  "not-nearby",
  "device-limit",
  "rate-limited",
  "failed",
  "stopped",
  "account-required",
]);

/** An outcome's mark: ✓ for a sign-in that happened, ▲ for one that did not, none for the rest. */
function markOf(v: View): ReactNode | undefined {
  if (GOOD.has(v.state)) return successMark();
  if (WARN.has(v.state)) return warningMark();
  return undefined;
}

interface ScreenProps extends KitProps {
  component: "SignIn" | "NearbyApproval";
  input: NonNullable<KitProps["input"]>;
  /** What the step draws between its text and its controls. */
  body?: (c: KitCtx) => ReactNode;
  /** A view's own adaptation (the step's copy), before the kit's. */
  adapt?: (v: View) => View;
  /** The control Escape answers. */
  escape?: (v: View) => string | null;
  onKey: (a: KitAction) => void;
  /** A control is busy until its reply (the confirm's Continue). */
  busy?: boolean;
}

function Screen(props: ScreenProps): ReactNode {
  const { component, body, adapt, escape, onKey } = props;
  const kit = useKit(component, MODELS[component], {
    ...props,
    onAction: (a) => {
      props.onAction?.(a);
      onKey(a);
    },
  });
  useInsertionEffect(() => {
    if (typeof document !== "undefined") adopt(document);
  }, []);
  const hidden = kit.view.state === "hidden";
  const view = adapt && !hidden ? adapt(kit.view) : kit.view;
  const ctx = withChoice(kit.ctxFor(view));
  const withBody: KitCtx = {
    ...ctx,
    ...(body ? { content: body(ctx) } : {}),
    ...(markOf(view) !== undefined ? { mark: markOf(view) } : {}),
  };
  const esc = hidden ? null : (escape?.(withBody.view) ?? null);
  const escRef = useRef<(() => void) | null>(null);
  escRef.current = esc ? () => withBody.act(esc) : null;

  // Escape works wherever focus is (the screen replaces its own controls, so focus is often on the
  // page after an asynchronous change).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented || !escRef.current) return;
      e.preventDefault();
      escRef.current();
    };
    document.addEventListener("keydown", onDown);
    return () => document.removeEventListener("keydown", onDown);
  }, []);

  // Focus follows the screen: a step that arrives on its own (a code, an approval, an ask, an
  // outcome) takes focus on its heading, so the change is announced and the controls are reached.
  const key = `${view.component}.${view.state}`;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const first = lastKey.current === null;
    lastKey.current = key;
    if (hidden) return;
    const root = kit.rootRef.current;
    if (!root || typeof document === "undefined") return;
    const active = document.activeElement;
    if (first && active && active !== document.body && root.contains(active))
      return;
    const h =
      root.querySelector<HTMLElement>('[data-part="title"]') ??
      root.querySelector<HTMLElement>("h1");
    if (h) focusClear(h);
  }, [key, hidden, kit.rootRef]);

  if (hidden) return null;
  return (
    <KitRoot
      kit={kit}
      bare={props.bare}
      fill={props.fill}
      className={props.className}
      onEscape={esc ? () => withBody.act(esc) : undefined}
    >
      <div aria-busy={props.busy ? "true" : undefined} data-part="nearby">
        {renderView(withBody)}
      </div>
    </KitRoot>
  );
}

/** One choice the host reported (a code, a licence, a device name): its text is data, not copy. */
function choice(
  c: KitCtx,
  key: string,
  label: string,
  detail: Record<string, unknown>,
  kind: "code" | "row",
  disabled = false,
): ReactNode {
  return (
    <button
      type="button"
      className="btn"
      data-part="secondary"
      data-variant="secondary"
      data-key={key}
      data-nearby={kind}
      aria-disabled={disabled ? "true" : undefined}
      onClick={() => {
        if (!disabled) c.act(key, detail);
      }}
    >
      <span>
        <bdi>{label}</bdi>
      </span>
    </button>
  );
}

// ── D: the new device ────────────────────────────────────────────────────────────────────────

export interface NearbySignInProps extends KitProps {
  /** The adapter; default the provider's. */
  adapter?: PolarisAdapter;
  /** The name this device goes by on the other one. */
  deviceName?: string;
  /** `false`: skip the pre-prompt and ask at once (the host explained the permission). */
  prompt?: boolean;
  /** The screen ended; see {@link NearbyEnd}. */
  onClose?: (end: NearbyEnd) => void;
  /** Milliseconds the browse runs before a lone approver is asked (default 3000). */
  settleMs?: number;
  /** Milliseconds with no approver before "No device found" (default 15000). */
  noneFoundMs?: number;
}

/** The phases that end the session with a refusal or an end the app words itself. */
const TERMINAL_NO_STEP = new Set([
  "denied",
  "expired",
  "not-nearby",
  "unsupported",
  "rate-limited",
  "cancelled",
]);

const SETTLE_MS = 3000;
const NONE_FOUND_MS = 15000;

const isDone = (p: string): boolean =>
  p === "done" || TERMINAL_NO_STEP.has(p) || p === "device-limit";

export function NearbySignIn(props: NearbySignInProps): ReactNode {
  const ctx = useContext(PolarisContext);
  const adapter = props.adapter ?? ctx?.adapter ?? null;
  const loading = useAdapterLoading(adapter);
  const nearby = loading ? null : nearbyOf(adapter);
  const [asked, setAsked] = useState(props.prompt === false);
  const [attempt, setAttempt] = useState(0);
  const [manual, setManual] = useState(false);
  const [session, setSession] = useState<DesktopNearbyRequester | null>(null);
  const [local, setLocal] = useState<AutoSignInStep | null>(null);
  const [settled, setSettled] = useState(false);
  const [long, setLong] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [useCode, setUseCode] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const started = useRef<number | null>(null);
  const ended = useRef(false);
  const chosenId = useRef<string | null>(null);
  const email = useRef<string | undefined>(undefined);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const live = useRef<DesktopNearbyRequester | null>(null);
  live.current = session;

  const end = useCallback((e: NearbyEnd): void => {
    if (ended.current) return;
    ended.current = true;
    closeRef.current?.(e);
  }, []);

  // A bridge without nearby (a v4 host, or a browser), once the host has answered: the host hears
  // it, nothing draws.
  useEffect(() => {
    if (!loading && !nearby) end({ kind: "ended", phase: "unsupported" });
  }, [loading, nearby, end]);

  useEffect(() => {
    if (!nearby || !asked || started.current === attempt) return;
    started.current = attempt;
    const mine = attempt;
    const opts = props.deviceName ? { deviceName: props.deviceName } : {};
    nearby
      .request(opts)
      .then((s) => {
        if (started.current === mine) setSession(s);
        else void s.cancel().catch(() => {});
      })
      .catch((error: unknown) => {
        if (started.current !== mine) return;
        setLocal("nearby-failed");
        end({ kind: "failed", error });
      });
  }, [nearby, asked, attempt, props.deviceName, end]);

  useEffect(() => {
    if (!session) return;
    const off = session.subscribe(redraw);
    return off;
  }, [session]);

  // The browse settles before a lone approver is asked; with none after a while, say so.
  const settleMs = props.settleMs ?? SETTLE_MS;
  const noneMs = props.noneFoundMs ?? NONE_FOUND_MS;
  useEffect(() => {
    if (!session) return;
    const a = setTimeout(() => setSettled(true), settleMs);
    const b = setTimeout(() => setLong(true), noneMs);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [session, settleMs, noneMs]);

  // Leaving while the request is open withdraws it.
  useEffect(
    () => () => {
      const s = live.current;
      if (s && s.state && !isDone(s.state.phase))
        void s.cancel().catch(() => {});
    },
    [],
  );

  const st = session?.state ?? null;
  if (st?.email) email.current = st.email;
  const phase = st?.phase ?? null;
  const approvers = st?.phase === "choose-approver" ? st.approvers : [];
  // One approver, after the browse settled and the person did not ask for the list: ask it (the
  // codes protect against the wrong one). Several: the list, named, never a silent pick.
  const lone =
    !manual && settled && approvers.length === 1 ? approvers[0]! : null;
  useEffect(() => {
    if (!lone || !session || chosenId.current === lone.id) return;
    chosenId.current = lone.id;
    setChosen(lone.device ?? undefined);
    session.choose(lone.id).catch((error: unknown) => {
      setLocal("nearby-failed");
      end({ kind: "failed", error });
    });
  }, [lone, session, end]);

  useEffect(() => {
    if (session && st === null) end({ kind: "cancelled" });
    else if (phase && TERMINAL_NO_STEP.has(phase) && phase !== "cancelled")
      end({ kind: "ended", phase });
  }, [session, st, phase, end]);

  const retry = (again: boolean): void => {
    const s = live.current;
    if (s && s.state && !isDone(s.state.phase)) void s.cancel().catch(() => {});
    started.current = null;
    ended.current = false;
    chosenId.current = null;
    setSession(null);
    setLocal(null);
    setSettled(false);
    setLong(false);
    setChosen(undefined);
    setConfirming(false);
    setManual(again);
    setAttempt((n) => n + 1);
  };

  const run = (p: Promise<unknown>): void => {
    p.catch((error: unknown) => {
      setLocal("nearby-failed");
      end({ kind: "failed", error });
    });
  };

  // The code path, when the host mounted this alone and keeps no other sign-in of its own.
  if (useCode && !props.onClose && nearby) {
    const { onClose: _c, ...rest } = props as NearbySignInProps;
    return <SignIn {...(rest as Record<string, never>)} />;
  }
  if (!nearby) return null;

  let auto: AutoSignInInput;
  if (!asked) auto = { step: "nearby-prompt" };
  else if (local) auto = { step: local };
  else if (session && st === null) auto = { step: "nearby-cancelled" };
  else if (session && st) {
    const base = requesterInput(st) ?? { step: "nearby-wait" as const };
    if (st.phase === "searching" && long) auto = { step: "nearby-none-found" };
    else if (st.phase === "choose-approver" && manual && approvers.length > 0)
      auto = { step: "nearby-choose" };
    else if (st.phase === "done")
      auto = {
        step: "nearby-done",
        ...(email.current ? { email: email.current } : {}),
      };
    else if (st.phase === "waiting")
      auto = { ...base, ...(chosen ? { device: chosen } : {}) };
    else auto = base;
  } else auto = { step: "nearby-wait" };

  const onKey = (a: KitAction): void => {
    switch (a.key) {
      case "common.continue":
        if (!asked) setAsked(true);
        else end({ kind: "signed-in" });
        return;
      case "common.notNow":
        end({ kind: "not-now" });
        return;
      case "common.tryAgain":
        retry(false);
        return;
      case "signin.nearby.another":
        retry(true);
        return;
      case "nearby.close":
        end({ kind: "cancelled" });
        return;
      case "signin.nearby.code":
        setUseCode(true);
        run(
          (session && !isDone(session.phase ?? "done")
            ? session.cancel()
            : Promise.resolve()
          ).then(() => end({ kind: "use-code" })),
        );
        return;
      case "common.cancel":
        setLocal("nearby-cancelled");
        run(
          (session ? session.cancel() : Promise.resolve()).then(() =>
            end({ kind: "cancelled" }),
          ),
        );
        return;
      case "signin.auto.confirm.other":
        if (phase === "confirm-account" && session) {
          setLocal("nearby-cancelled");
          run(session.decline().then(() => end({ kind: "declined" })));
          return;
        }
        setLocal("nearby-cancelled");
        run(
          (session ? session.cancel() : Promise.resolve()).then(() =>
            end({ kind: "cancelled" }),
          ),
        );
        return;
      case "signin.auto.confirm.primary":
        if (session && !confirming) {
          setConfirming(true);
          session
            .confirm()
            .catch((error: unknown) => {
              setLocal("nearby-failed");
              end({ kind: "failed", error });
            })
            .finally(() => setConfirming(false));
        }
        return;
      case "signin.nearby.notYou":
        setLocal("nearby-signed-out");
        run(
          Promise.resolve(adapter?.signOut()).then(() =>
            end({ kind: "signed-out" }),
          ),
        );
        return;
      case "nearby.approver":
        if (session && typeof a.id === "string") {
          const id = a.id;
          chosenId.current = id;
          setChosen(
            (st?.phase === "choose-approver"
              ? st.approvers.find((x) => x.id === id)?.device
              : undefined) ?? undefined,
          );
          run(session.choose(id));
        }
        return;
    }
  };
  const showList = auto.step === "nearby-choose";
  return (
    <Screen
      {...props}
      component="SignIn"
      input={{
        ...props.input,
        signIn: {
          presentation: "inline",
          replace: "inline",
          channel: "browser",
          ...props.input?.signIn,
        },
        autoSignIn: auto,
      }}
      busy={confirming}
      onKey={onKey}
      adapt={(v) => {
        let copy = v.copy;
        if (auto.step === "nearby-wait") {
          // Before a device is chosen there is no code to read out; once it is, name it.
          if (!auto.code)
            copy = copy.filter((k) => k !== "signin.nearby.match");
          if (auto.device)
            copy = copy.map((k) =>
              k === "signin.nearby.body" ? "signin.nearby.bodyOn" : k,
            );
        }
        // The confirm was the decision; the done step does not ask it again.
        if (auto.step === "nearby-done")
          copy = copy.filter((k) => k !== "signin.nearby.notYou");
        return {
          ...v,
          copy,
          args: {
            ...v.args,
            ...(auto.device ? { device: auto.device } : {}),
            app: v.args.app ? v.args.app : "this app",
          },
        };
      }}
      escape={(v) =>
        v.copy.includes("common.cancel")
          ? "common.cancel"
          : v.copy.includes("common.notNow")
            ? "common.notNow"
            : v.state === "nearby-done"
              ? "common.continue"
              : v.state.startsWith("nearby-")
                ? "nearby.close"
                : null
      }
      body={(c) => {
        if (showList)
          return (
            <ul className="nearby-codes" data-part="approvers">
              {approvers.map((x) => (
                <li key={x.id}>
                  {choice(
                    c,
                    "nearby.approver",
                    x.device ?? x.platform,
                    { id: x.id },
                    "row",
                  )}
                </li>
              ))}
            </ul>
          );
        if (c.view.state === "nearby-wait")
          return (
            <>
              {nearbyCode(c)}
              <p className="nearby-status" role="status" data-part="status">
                <span className="nearby-spin" aria-hidden="true" />
                <span>
                  {said(
                    c,
                    auto.code
                      ? "signin.cli.nearbyWaiting"
                      : "signin.cli.nearbyLooking",
                  )}
                </span>
              </p>
              {auto.code ? (
                <button
                  type="button"
                  className="btn nearby-more"
                  data-variant="link"
                  data-key="signin.nearby.another"
                  onClick={() => c.act("signin.nearby.another")}
                >
                  {said(c, "signin.nearby.another")}
                </button>
              ) : null}
            </>
          );
        return null;
      }}
    />
  );
}

// ── M: the signed-in device ──────────────────────────────────────────────────────────────────

export interface NearbyApproverProps extends KitProps {
  /** The adapter; default the provider's. */
  adapter?: PolarisAdapter;
  /** Done, Deny or Escape on the last ask: the host closes the screen. */
  onClose?: () => void;
}

export function NearbyApprover(props: NearbyApproverProps): ReactNode {
  const ctx = useContext(PolarisContext);
  const adapter = props.adapter ?? ctx?.adapter ?? null;
  const loading = useAdapterLoading(adapter);
  const nearby = loading ? null : nearbyOf(adapter);
  const [approver, setApprover] = useState<DesktopNearbyApprover | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  // The ask the person answered (its outcome stays until Done, unless a new ask arrives), the
  // answer in flight, and an ask that ended before it was answered.
  const [shown, setShown] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [gone, setGone] = useState<{ id: string; device?: string } | null>(
    null,
  );
  const names = useRef(new Map<string, string>());
  const answered = useRef(new Set<string>());
  const viewed = useRef<string | null>(null);

  // Listening only while this screen is open (D-4).
  useEffect(() => {
    if (!nearby) return;
    let off = (): void => {};
    let mine: DesktopNearbyApprover | null = null;
    let alive = true;
    void nearby
      .approver()
      .then(async (a) => {
        if (!alive) return;
        mine = a;
        off = a.subscribe(redraw);
        await a.start();
        if (alive) setApprover(a);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      off();
      if (mine) void mine.stop().catch(() => {});
    };
  }, [nearby]);

  const asks = approver?.asks ?? [];
  for (const x of asks) if (x.device) names.current.set(x.askId, x.device);
  const open = asks[0] ?? null;
  const shownStep = shown && approver ? approver.outcome(shown) : null;
  // The person's own answer stays while it is being given, at a licence choice, and until Done;
  // a new ask replaces a finished outcome (it must not wait unseen behind it).
  const keepShown =
    shown !== null &&
    (shownStep?.kind === "choose" ||
      (shownStep === null && pending) ||
      (shownStep !== null && (open === null || open.askId === shown)));
  const current: string | null = keepShown
    ? shown
    : open
      ? open.askId
      : (gone?.id ?? null);

  // A new ask replaces the finished outcome and any "ended" note.
  useEffect(() => {
    if (!open) return;
    if (
      shown &&
      shownStep &&
      shownStep.kind !== "choose" &&
      open.askId !== shown
    ) {
      approver?.dismiss(shown);
      setShown(null);
    }
    if (gone) setGone(null);
  }, [open, shown, shownStep, gone, approver]);

  // The ask on screen is no longer open and nobody answered it: its requester left.
  const openIds = asks.map((a) => a.askId).join(",");
  useEffect(() => {
    const v = viewed.current;
    if (
      v &&
      !asks.some((a) => a.askId === v) &&
      !answered.current.has(v) &&
      (approver?.outcome(v) ?? null) === null
    ) {
      const device = names.current.get(v);
      setGone({ id: v, ...(device ? { device } : {}) });
      viewed.current = null;
    }
    if (open && !keepShown) viewed.current = open.askId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIds, approver]);

  const named = current ? names.current.get(current) : undefined;
  let base: NearbyApprovalInput;
  if (current && approver && approver.input(current))
    base = approver.input(current)!;
  else if (current && gone?.id === current) base = { step: "expired" };
  else if (current && pending) base = { step: "ask" };
  else if (approver?.stopped) base = { step: "stopped" };
  else base = { step: "listening" };
  const input: NearbyApprovalInput =
    named && base.device === undefined ? { ...base, device: named } : base;
  const choices = current && approver ? approver.choices(current) : [];
  const ask = current ? (asks.find((a) => a.askId === current) ?? null) : null;

  const done = (): void => {
    if (current && approver) approver.dismiss(current);
    if (shown && approver) approver.dismiss(shown);
    setShown(null);
    setGone(null);
    setPending(false);
    closeRef.current?.();
  };

  if (!nearby) return null;
  if (failed && !approver) {
    // The host would not start listening (another window is approving): say so, with a way out.
    return (
      <Screen
        {...props}
        component="NearbyApproval"
        input={{ ...props.input, nearbyApproval: { step: "failed" } }}
        onKey={(a) => {
          if (a.key === "common.done") closeRef.current?.();
        }}
        escape={() => "common.done"}
      />
    );
  }

  const answer = (id: string, p: Promise<unknown> | undefined): void => {
    answered.current.add(id);
    setShown(id);
    setPending(true);
    void (p ?? Promise.resolve())
      .catch(() => approver?.fail(id))
      .finally(() => setPending(false));
  };
  const onKey = (a: KitAction): void => {
    if (!approver) return;
    const id = current;
    switch (a.key) {
      case "nearby.code":
        if (id && !pending && typeof a.code === "string")
          answer(id, approver.pick(id, a.code));
        return;
      case "nearby.license":
        if (id && !pending && typeof a.id === "string")
          answer(
            id,
            approver.choose(
              id,
              a.id === "create"
                ? { kind: "create" }
                : { kind: "license", licenseId: a.id },
            ),
          );
        return;
      case "signin.approve.deny":
        if (id && !pending)
          answer(
            id,
            input.step === "choose"
              ? approver.choose(id, { kind: "decline" })
              : approver.deny(id),
          );
        return;
      case "signin.nearby.startAgain":
        void approver.start().catch(() => approver.fail("stopped"));
        return;
      case "common.done":
      case "common.cancel":
        done();
        return;
    }
  };

  return (
    <Screen
      {...props}
      component="NearbyApproval"
      input={{ ...props.input, nearbyApproval: input }}
      onKey={onKey}
      busy={pending}
      adapt={(v) =>
        // Done closes the host's screen; without a host handler it would do nothing.
        (v.state === "listening" || v.state === "stopped") && !props.onClose
          ? {
              ...v,
              copy: v.copy.filter((k) => k !== "common.done"),
              decisions: {
                ...v.decisions,
                primary:
                  v.state === "stopped" ? "signin.nearby.startAgain" : null,
              },
            }
          : v
      }
      escape={(v) =>
        v.copy.includes("signin.approve.deny")
          ? "signin.approve.deny"
          : v.copy.includes("common.done")
            ? "common.done"
            : null
      }
      body={(c) => {
        if (c.view.state === "ask" && ask)
          return (
            <ul className="nearby-codes" data-part="codes">
              {ask.codes.map((code) => (
                <li key={code}>
                  {choice(c, "nearby.code", code, { code }, "code", pending)}
                </li>
              ))}
            </ul>
          );
        if (c.view.state === "choose")
          return (
            <ul className="nearby-codes" data-part="licenses">
              {choices.map((l) => (
                <li key={l.licenseId}>
                  {choice(
                    c,
                    "nearby.license",
                    l.name,
                    { id: l.licenseId },
                    "row",
                    pending,
                  )}
                </li>
              ))}
            </ul>
          );
        if (c.view.state === "listening")
          return (
            <p className="nearby-status" role="status" data-part="status">
              <span className="nearby-spin" aria-hidden="true" />
              <span>{said(c, "signin.cli.approveWaiting")}</span>
            </p>
          );
        return null;
      }}
    />
  );
}

/** The approver over the app, as a host menu item opens it (`openedViews.tsx`): a full-window
 *  dialog that returns focus to what held it when it closes. */
export function NearbyDialog(props: {
  adapter: PolarisAdapter;
  theme?: KitProps["theme"];
  onClose: () => void;
}): ReactNode {
  const back = useRef<Element | null>(null);
  useInsertionEffect(() => {
    if (typeof document !== "undefined") adopt(document);
    back.current = document.activeElement;
  }, []);
  useEffect(
    () => () => {
      if (back.current instanceof HTMLElement) back.current.focus();
    },
    [],
  );
  return (
    <div className="nearby-dialog" role="dialog" aria-modal="true">
      <NearbyApprover
        adapter={props.adapter}
        {...(props.theme ? { theme: props.theme } : {})}
        fill
        onClose={props.onClose}
      />
    </div>
  );
}

/** The Settings row that opens the approver (UXR-47b M5): "Approve a Nearby Device" where a nearby
 *  device can be approved from, and nothing where it cannot. */
export function NearbyEntry(props: {
  adapter?: PolarisAdapter;
  theme?: KitProps["theme"];
}): ReactNode {
  const ctx = useContext(PolarisContext);
  const adapter = props.adapter ?? ctx?.adapter ?? null;
  const loading = useAdapterLoading(adapter);
  const nearby = loading ? null : nearbyOf(adapter);
  const [open, setOpen] = useState(false);
  if (!nearby || !adapter) return null;
  return (
    <>
      <Screen
        component="NearbyApproval"
        bare
        {...(props.theme ? { theme: props.theme } : {})}
        input={{ nearbyApproval: { step: "entry" } }}
        onKey={(a) => {
          if (a.key === "signin.nearby.menu") setOpen(true);
        }}
      />
      {open ? (
        <NearbyDialog
          adapter={adapter}
          {...(props.theme ? { theme: props.theme } : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
