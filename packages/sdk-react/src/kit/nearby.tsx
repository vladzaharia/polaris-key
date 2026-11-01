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
  type ReactNode,
} from "react";
import {
  MODELS,
  type AutoSignInInput,
  type NearbyApprovalInput,
  type View,
} from "@polaris-key/ui-core";

import type { PolarisAdapter } from "../core/index.js";
import type { DesktopAdapter } from "../desktop/desktopAdapter.js";
import type {
  DesktopNearbyApprover,
  DesktopNearbyRequester,
} from "../desktop/nearby.js";
import { PolarisContext } from "../react/context.js";
import { KitRoot, useKit, type KitAction, type KitProps } from "./component.js";
import { withChoice } from "./licenseRows.js";
import type { KitCtx } from "./parts.js";
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
  font-family: var(--pk-kit-type-code-family);
  font-weight: var(--pk-kit-type-code-weight);
  letter-spacing: 0.08em;
  font-size: 1.5rem;
}
.pk-root .nearby-codes bdi {
  overflow-wrap: anywhere;
}
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
  if (kit.view.state === "hidden") return null;
  const view = adapt ? adapt(kit.view) : kit.view;
  const ctx = withChoice(kit.ctxFor(view));
  const withBody: KitCtx = body ? { ...ctx, content: body(ctx) } : ctx;
  const esc = escape?.(withBody.view) ?? null;
  return (
    <KitRoot
      kit={kit}
      bare={props.bare}
      fill={props.fill}
      className={props.className}
      onEscape={esc ? () => withBody.act(esc) : undefined}
    >
      {renderView(withBody)}
    </KitRoot>
  );
}

/** One choice the host reported (a code, a licence, a device name): its text is data, not copy. */
function choice(
  c: KitCtx,
  key: string,
  label: string,
  detail: Record<string, unknown>,
): ReactNode {
  return (
    <button
      type="button"
      className="btn"
      data-part="secondary"
      data-variant="secondary"
      data-key={key}
      onClick={() => c.act(key, detail)}
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
}

/** The requester's session as the kit draws it, or null where the phase has no step of its own. */
const TERMINAL_NO_STEP = new Set([
  "denied",
  "expired",
  "not-nearby",
  "unsupported",
  "rate-limited",
  "cancelled",
]);

export function NearbySignIn(props: NearbySignInProps): ReactNode {
  const ctx = useContext(PolarisContext);
  const adapter = props.adapter ?? ctx?.adapter ?? null;
  const nearby = nearbyOf(adapter);
  const [asked, setAsked] = useState(props.prompt === false);
  const [session, setSession] = useState<DesktopNearbyRequester | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const started = useRef(false);
  const ended = useRef(false);
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

  // A bridge without nearby (a v4 host, or a browser): the host hears it, nothing draws.
  useEffect(() => {
    if (!nearby) end({ kind: "ended", phase: "unsupported" });
  }, [nearby, end]);

  useEffect(() => {
    if (!nearby || !asked || started.current) return;
    started.current = true;
    const opts = props.deviceName ? { deviceName: props.deviceName } : {};
    nearby
      .request(opts)
      .then(setSession)
      .catch((error: unknown) => end({ kind: "failed", error }));
  }, [nearby, asked, props.deviceName, end]);

  useEffect(() => {
    if (!session) return;
    const off = session.subscribe(redraw);
    return off;
  }, [session]);

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
  // Lone approver: ask it at once (the codes protect against the wrong one); more: the list.
  const lone =
    st?.phase === "choose-approver" && st.approvers.length === 1
      ? st.approvers[0]!.id
      : null;
  useEffect(() => {
    if (lone && session)
      void session
        .choose(lone)
        .catch((error: unknown) => end({ kind: "failed", error }));
  }, [lone, session, end]);

  const phase = st?.phase ?? null;
  useEffect(() => {
    if (session && st === null) end({ kind: "cancelled" });
    else if (phase && TERMINAL_NO_STEP.has(phase) && phase !== "cancelled")
      end({ kind: "ended", phase });
  }, [session, st, phase, end]);

  if (!nearby) return null;

  const auto: AutoSignInInput | null = !asked
    ? { step: "nearby-prompt" }
    : session && st
      ? auto_(st, email.current)
      : { step: "nearby-wait" };
  if (!auto) return null;

  const run = (p: Promise<unknown>): void => {
    p.catch((error: unknown) => end({ kind: "failed", error }));
  };
  const onKey = (a: KitAction): void => {
    switch (a.key) {
      case "common.continue":
        if (!asked) setAsked(true);
        else end({ kind: "signed-in" });
        return;
      case "common.notNow":
        end({ kind: "not-now" });
        return;
      case "signin.nearby.code":
      case "common.cancel":
      case "signin.auto.confirm.other":
        if (
          a.key === "signin.auto.confirm.other" &&
          phase === "confirm-account"
        ) {
          run(session!.decline().then(() => end({ kind: "declined" })));
          return;
        }
        run(
          (session ? session.cancel() : Promise.resolve()).then(() =>
            end({
              kind: a.key === "signin.nearby.code" ? "use-code" : "cancelled",
            }),
          ),
        );
        return;
      case "signin.auto.confirm.primary":
        if (session) run(session.confirm());
        return;
      case "signin.nearby.notYou":
        run(
          Promise.resolve(adapter?.signOut()).then(() =>
            end({ kind: "signed-out" }),
          ),
        );
        return;
      case "nearby.approver":
        if (session && typeof a.id === "string") run(session.choose(a.id));
        return;
    }
  };
  const approvers = st?.phase === "choose-approver" ? st.approvers : [];
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
      onKey={onKey}
      adapt={(v) =>
        // Before a device is chosen there is no code to tap.
        auto.step === "nearby-wait" && !auto.code
          ? { ...v, copy: v.copy.filter((k) => k !== "signin.nearby.match") }
          : v
      }
      escape={(v) =>
        v.copy.includes("common.cancel")
          ? "common.cancel"
          : v.copy.includes("common.notNow")
            ? "common.notNow"
            : null
      }
      body={
        approvers.length > 1
          ? (c) => (
              <ul className="nearby-codes" data-part="approvers">
                {approvers.map((x) => (
                  <li key={x.id}>
                    {choice(c, "nearby.approver", x.device ?? x.platform, {
                      id: x.id,
                    })}
                  </li>
                ))}
              </ul>
            )
          : undefined
      }
    />
  );
}

const isDone = (p: string): boolean =>
  p === "done" || TERMINAL_NO_STEP.has(p) || p === "device-limit";

function auto_(
  r: NonNullable<DesktopNearbyRequester["state"]>,
  email: string | undefined,
): AutoSignInInput | null {
  switch (r.phase) {
    case "searching":
    case "choose-approver":
      return { step: "nearby-wait" };
    case "waiting":
      return { step: "nearby-wait", ...(r.code ? { code: r.code } : {}) };
    case "confirm-account":
      return { step: "confirm", ...(r.email ? { email: r.email } : {}) };
    case "done":
      return { step: "nearby-done", ...(email ? { email } : {}) };
    case "device-limit":
      return { step: "device-limit" };
    default:
      return null;
  }
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
  const nearby = nearbyOf(adapter);
  const [approver, setApprover] = useState<DesktopNearbyApprover | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  // The ask on screen, and the ones answered (their outcome stays until Done).
  const [shown, setShown] = useState<string | null>(null);

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
  const current = shown ?? asks[0]?.askId ?? null;
  const ask = asks.find((a) => a.askId === current) ?? null;
  // The host forgets an ask once it is answered; its name stays for the outcome.
  const names = useRef(new Map<string, string>());
  for (const x of asks) if (x.device) names.current.set(x.askId, x.device);
  const named = current ? names.current.get(current) : undefined;
  const base: NearbyApprovalInput = (current && approver?.input(current)) || {
    step: "entry",
  };
  const input: NearbyApprovalInput =
    named && base.device === undefined ? { ...base, device: named } : base;
  const choices = current && approver ? approver.choices(current) : [];
  const done = (): void => {
    setShown(null);
    closeRef.current?.();
  };

  if (!nearby || failed) return null;

  const onKey = (a: KitAction): void => {
    if (!approver) return;
    const id = current;
    const swallow = (p: Promise<unknown>): void => void p.catch(() => {});
    switch (a.key) {
      case "nearby.code":
        if (id && typeof a.code === "string") {
          setShown(id);
          swallow(approver.pick(id, a.code));
        }
        return;
      case "nearby.license":
        if (id && typeof a.id === "string")
          swallow(
            approver.choose(
              id,
              a.id === "create"
                ? { kind: "create" }
                : { kind: "license", licenseId: a.id },
            ),
          );
        return;
      case "signin.approve.deny":
        if (id)
          swallow(
            input.step === "choose"
              ? approver.choose(id, { kind: "decline" })
              : approver.deny(id),
          );
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
                <li key={code}>{choice(c, "nearby.code", code, { code })}</li>
              ))}
            </ul>
          );
        if (c.view.state === "choose")
          return (
            <ul className="nearby-codes" data-part="licenses">
              {choices.map((l) => (
                <li key={l.licenseId}>
                  {choice(c, "nearby.license", l.name, { id: l.licenseId })}
                </li>
              ))}
            </ul>
          );
        return null;
      }}
    />
  );
}
