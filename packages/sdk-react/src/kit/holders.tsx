"use client";
// The two screens activation without an account adds (UK-42), styled: `<ActivateDone>` (the step
// after a license key: "<Product> is ready", the license line and, once, a quiet recommendation to
// keep the license in an account) and `<AddToAccount>` (name and email; the browser confirms the
// email). The headless half is holderHooks.ts; the views are ui-core's `activateDoneView` and
// `addToAccountView`. They load on demand (holdersLazy.tsx), so the gate's entry carries none of it.
//
// Rules (plans/UK-42 §DL): one primary, "Start using <Product>"; the recommendation is a quiet card
// with the Recommended badge; "Continue without an account" is a line, never a second filled
// control; focus goes to the primary on Done and to Name on AddToAccount; a reason shows only when
// the product has it; the device line is left out when its numbers are unknown, never drawn as
// "{n}". Motion (Web Animations API, CSP-safe): the card morphs between states, at most three
// reason lines enter one after another, the check draws once; reduced motion swaps instantly.
//
// Name and email live in `useAddToAccount`'s state only. They leave in `attach` (self-driven) or in
// the `common.continue` action (a host that drives the step itself), and nowhere else.

import {
  useEffect,
  useState,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  activateDoneView,
  addToAccountView,
  contextOf,
  reasonsOf,
  type ComponentName,
  type HolderScreenName,
  type View,
} from "@polaris-key/ui-core";

import { KitRoot, useKit, type KitAction, type KitProps } from "./component.js";
import type { Layout } from "./contract.js";
import {
  useAddToAccount,
  type AttachOutcome,
  type UseAddToAccount,
} from "./holderHooks.js";
import {
  actions,
  button,
  callout,
  links,
  plain,
  text,
  usableKey,
  type KitCtx,
} from "./parts.js";
import { renderView } from "./views.js";

export type { AttachOutcome } from "./holderHooks.js";

// ── Layouts and rules ────────────────────────────────────────────────────────────────────────

/** Both screens draw their own fields, card and controls in `content`; what is left is text. */
const HOLDER_LAYOUTS: Readonly<Record<HolderScreenName, Layout>> = {
  ActivateDone: {
    kind: "screen",
    header: "compact",
    controls: [],
    content: [
      "activate.recommend.title",
      "activate.recommend.badge",
      "activate.recommend.sync",
      "activate.recommend.recover",
      "activate.recommend.devices",
      "activate.recommend.portal",
      "activate.recommend.action",
      "activate.recommend.skip",
      "activate.waitingSignIn",
      "signin.done.start",
    ],
  },
  AddToAccount: {
    kind: "screen",
    header: "compact",
    // A form like Activate: two panes in a landscape box, the controls in the docked bar.
    split: true,
    controls: [],
    // The form's title is the action that opened it ("Add your name and email").
    titles: [
      "activate.recommend.action",
      "activate.owned.title",
      "activate.otherEmail.title",
      "activate.attach.done",
    ],
    content: [
      "signin.gate.name",
      "signin.email.label",
      "signin.gate.nameRequired",
      "signin.email.invalid",
      "activate.attach.lede",
      "activate.attach.fine",
      "common.continue",
      "common.cancel",
      "common.working",
      "common.tryAgain",
      "locker.activate.addFailed",
      "signin.done.start",
      "signin.key.ownedSignIn",
      "activate.otherEmail.verify",
      "signin.auto.confirm.other",
    ],
  },
};

/** The rules these two screens add to the kit's sheet: the quiet card, the reason lines, the form's
 *  hint, and the check that the Web Animations API draws (so the sheet's own CSS draw is off). */
const HOLDERS_CSS = `@layer polaris-key {
.pk-root .recommend {
  display: grid;
  gap: var(--pk-space-3);
  padding: var(--pk-space-4);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  text-align: start;
}
.pk-root .recommend-head {
  display: grid;
  justify-items: start;
  gap: var(--pk-space-2);
}
.pk-root .recommend .pill {
  background: color-mix(in srgb, var(--pk-text-strong) 9%, transparent);
  color: var(--pk-text-strong);
}
.pk-root .recommend-head .title {
  margin: 0;
  min-inline-size: 0;
}
.pk-root .reasons {
  display: grid;
  gap: var(--pk-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.pk-root .reasons li {
  display: grid;
  grid-template-columns: 1.25rem minmax(0, 1fr);
  align-items: start;
  gap: var(--pk-space-3);
  color: var(--pk-text-default);
}
.pk-root .reasons svg {
  inline-size: 1.25rem;
  block-size: 1.25rem;
  color: var(--pk-text-muted);
}
.pk-root .holder-skip {
  margin: 0;
  color: var(--pk-text-muted);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
}
.pk-root .holder-form {
  display: grid;
  gap: var(--pk-space-4);
}
.pk-root .holder-form .field-error {
  margin: var(--pk-space-2) 0 0;
  color: var(--pk-danger);
  font-size: var(--pk-kit-type-meta-size);
}
.pk-root .holder-form .hint {
  margin: var(--pk-space-2) 0 0;
  color: var(--pk-text-muted);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
}
.pk-root .holder-form .field input[readonly] {
  color: var(--pk-text-muted);
}
.success[data-waapi] svg,
.pk-root .success[data-waapi] path {
  animation: none;
}
}
`;

const sheets = new WeakMap<Document, CSSStyleSheet>();

/** Adopt the rules once per document, with the first screen drawn (never a `<style>` element). */
function adoptHolderStyles(doc: Document): void {
  if (sheets.has(doc) || typeof CSSStyleSheet !== "function") return;
  try {
    const own = new CSSStyleSheet();
    own.replaceSync(HOLDERS_CSS);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, own];
    sheets.set(doc, own);
  } catch {
    // No constructable sheets, or a document of another realm: it links styles.css.
  }
}

// ── Glyphs: one lucide icon per reason ───────────────────────────────────────────────────────

function Icon(props: { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

const REASON_ICONS: Readonly<Record<string, () => ReactNode>> = {
  // RefreshCw
  "activate.recommend.sync": () => (
    <Icon>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </Icon>
  ),
  // KeyRound
  "activate.recommend.recover": () => (
    <Icon>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </Icon>
  ),
  // MonitorSmartphone
  "activate.recommend.devices": () => (
    <Icon>
      <path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" />
      <path d="M10 19v-3.96 3.15" />
      <path d="M7 19h5" />
      <rect width="6" height="10" x="16" y="12" rx="2" />
    </Icon>
  ),
  // Check
  "activate.recommend.portal": () => (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  ),
};

// ── Motion ───────────────────────────────────────────────────────────────────────────────────

const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

const reducedMotion = (motion: string): boolean =>
  motion !== "full" ||
  (typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches);

/** The numbers a motion uses, from the card's own variables. */
function timing(card: HTMLElement) {
  const css = getComputedStyle(card);
  const ms = (name: string, fallback: number) =>
    Number.parseFloat(css.getPropertyValue(name)) || fallback;
  return {
    moderate: ms("--pk-duration-moderate", 260),
    base: ms("--pk-duration-base", 200),
    micro: ms("--pk-duration-micro", 80),
    standard: css.getPropertyValue("--pk-ease-standard").trim() || "ease-out",
    enter: css.getPropertyValue("--pk-ease-enter").trim() || "ease-out",
  };
}

/** The card's height from the old state's to the new, and the new body entering. */
function morphCard(card: HTMLElement, fromHeight: number): void {
  const t = timing(card);
  const to = card.getBoundingClientRect().height;
  if (Math.abs(to - fromHeight) > 1)
    card.animate([{ blockSize: `${fromHeight}px` }, { blockSize: `${to}px` }], {
      duration: t.moderate,
      easing: t.standard,
    });
  for (const n of card.children) {
    if (n.classList.contains("split") || n.classList.contains("shimmer"))
      continue;
    n.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: t.base,
      delay: t.micro,
      easing: t.enter,
      fill: "backwards",
    });
  }
}

/** The reason lines come in one after another (three at most), and the check draws once. */
function introduce(card: HTMLElement): void {
  const t = timing(card);
  const lines = [...card.querySelectorAll<HTMLElement>(".reasons li")].slice(
    0,
    3,
  );
  lines.forEach((li, i) =>
    li.animate(
      [
        { opacity: 0, translate: "0 6px" },
        { opacity: 1, translate: "0 0" },
      ],
      {
        duration: t.base,
        delay: t.moderate + i * t.micro,
        easing: t.enter,
        fill: "backwards",
      },
    ),
  );
  const path = card.querySelector<SVGPathElement>(".success path");
  path?.animate([{ strokeDashoffset: 40 }, { strokeDashoffset: 0 }], {
    duration: t.moderate,
    delay: t.micro,
    easing: t.enter,
    fill: "backwards",
  });
}

/** The mark above the title: the sheet's success circle, its check drawn by `introduce`. */
function mark(): ReactNode {
  return (
    <div className="success" data-waapi="" aria-hidden="true">
      <svg viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="22" />
        <path d="m14 25 7 7 13-15" strokeDasharray="40" />
      </svg>
    </div>
  );
}

// ── The failure line ─────────────────────────────────────────────────────────────────────────

const FAILED_KEY = "locker.activate.addFailed";

interface PortalLine {
  /** The locale the kit asked for. */
  locale: string;
  /** English, and the locale's own line when its pack has one. */
  en: string;
  own?: string;
}

/** The failure line from the portal's table: English, and `locale`'s pack when it has one. */
async function loadPortalLine(locale: string): Promise<PortalLine> {
  const brand = await import("@polaris-key/brand/kit-copy/portal");
  const en = brand.PORTAL_COPY_EN[FAILED_KEY];
  type Locale = Parameters<typeof brand.loadPortalCopy>[0];
  let own: string | undefined;
  for (const tag of [locale, locale.split("-")[0]!]) {
    try {
      own = (await brand.loadPortalCopy(tag as Locale))?.[FAILED_KEY];
    } catch {
      // A locale with no pack: the next, then English.
    }
    if (own !== undefined) break;
  }
  return { locale, en, ...(own !== undefined ? { own } : {}) };
}

/** `theme` with the failure line as a copy override: English, then the locale's own. */
function withPortalLine(
  theme: KitProps["theme"],
  line: PortalLine | null,
): KitProps["theme"] {
  if (!line) return theme;
  const copy = { ...theme?.copy };
  for (const [tag, value] of [
    ["en", line.en],
    ...(line.own !== undefined ? [[line.locale, line.own]] : []),
  ] as [string, string][])
    copy[tag] = { [FAILED_KEY]: value, ...copy[tag] };
  return { ...theme, copy };
}

// ── One screen ───────────────────────────────────────────────────────────────────────────────

type Name = HolderScreenName;

interface ScreenProps extends KitProps {
  /** Press routes for the host: called after `onAction`. */
  route?: (a: KitAction) => void;
}

/** Draw one holder screen: the kit root, the layout and content of `name`, the motion and focus. */
function Screen(
  props: ScreenProps & {
    name: Name;
    input: NonNullable<KitProps["input"]>;
    body: (c: KitCtx) => ReactNode;
    markStates: readonly string[];
    detail?: (key: string) => Record<string, unknown>;
  },
): ReactNode {
  const { name, body, markStates, route, detail } = props;
  const model = name === "ActivateDone" ? activateDoneView : addToAccountView;
  const [portal, setPortal] = useState<PortalLine | null>(null);
  const kit = useKit(
    name as unknown as ComponentName,
    (ctx) => model(ctx) as unknown as View,
    {
      ...props,
      input: props.input,
      theme: withPortalLine(props.theme, portal),
      onAction: (a) => {
        props.onAction?.(a);
        route?.(a);
      },
    },
    undefined,
    detail ? { detail: (key) => detail(key) } : {},
  );
  useInsertionEffect(() => {
    if (typeof document !== "undefined") adoptHolderStyles(document);
  }, []);
  // The failure line is a portal string (no SDK table carries the portal's namespaces): fetched
  // the first time a failure is drawn, for the locale the kit speaks.
  const locale = kit.resolved.locale;
  const failed = kit.view.copy.includes(FAILED_KEY);
  useEffect(() => {
    if (!failed || portal?.locale === locale) return;
    let live = true;
    void loadPortalLine(locale).then((line) => live && setPortal(line));
    return () => {
      live = false;
    };
  }, [failed, locale, portal?.locale]);

  // The card morphs between states; the first draw (and a new check) introduces itself.
  const last = useRef<{ key: string; height: number } | null>(null);
  const inside = useRef(false);
  useEffect(() => {
    const root = kit.rootRef.current;
    if (!root) return;
    const on = (e: FocusEvent) => {
      inside.current = root.contains(e.target as Node);
    };
    document.addEventListener("focusin", on);
    return () => document.removeEventListener("focusin", on);
  }, [kit.rootRef]);
  const motion = kit.resolved.theme.motion;
  const stateKey = `${kit.view.component}.${kit.view.state}`;
  useIsoLayoutEffect(() => {
    const root = kit.rootRef.current;
    const card = root?.querySelector<HTMLElement>(".card");
    const prev = last.current;
    const height = card?.getBoundingClientRect().height ?? 0;
    last.current = { key: stateKey, height };
    if (!root || !card || (prev && prev.key === stateKey)) return;
    // Focus was on a control the new state replaced: it follows the view (DL9).
    if (prev && inside.current && !root.contains(document.activeElement)) {
      const target = kit.view.decisions.focus;
      const el =
        target && target !== "heading"
          ? root.querySelector<HTMLElement>(
              `[data-key="${target.replace(/["\\]/g, "")}"]`,
            )
          : null;
      (el ?? root.querySelector<HTMLElement>("#pk-title"))?.focus({
        preventScroll: true,
      });
    }
    if (typeof card.animate !== "function" || reducedMotion(motion)) return;
    if (prev) morphCard(card, prev.height);
    introduce(card);
  });

  if (kit.view.state === "hidden") return null;
  const base = kit.ctxFor(kit.view);
  const ctx: KitCtx = {
    ...base,
    layout: HOLDER_LAYOUTS[name],
    mark: markStates.includes(kit.view.state) ? mark() : null,
    content: null,
  };
  const content = body(ctx);
  return (
    <KitRoot
      kit={kit}
      bare={props.bare}
      fill={props.fill}
      className={props.className}
      onEscape={
        kit.view.copy.includes("common.cancel")
          ? () => ctx.act("common.cancel")
          : undefined
      }
    >
      {renderView({ ...ctx, content })}
    </KitRoot>
  );
}

// ── ActivateDone ─────────────────────────────────────────────────────────────────────────────

export interface ActivateDoneProps extends KitProps {
  /** Start using the product (the one primary). */
  onStart?: () => void;
  /** Add your name and email: open AddToAccount. */
  onAddToAccount?: () => void;
  /** Sign in as the email the license was sent to (the waiting state). */
  onSignIn?: () => void;
}

/** The recommendation: a quiet card, its badge, only the reasons the product has, one action. */
function Recommendation(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  const has = (k: string) => c.view.copy.includes(k);
  const reasons = reasonsOf(contextOf(c.input)).filter(has);
  return (
    <div className="recommend" data-part="recommend">
      <div className="recommend-head">
        <span className="pill" data-key="activate.recommend.badge">
          {text(c, "activate.recommend.badge")}
        </span>
        <h2
          className="title"
          data-size="section"
          data-part="heading"
          data-key="activate.recommend.title"
        >
          {text(c, "activate.recommend.title")}
        </h2>
      </div>
      <ul className="reasons" data-part="reasons">
        {reasons.map((k) => (
          <li key={k} data-key={k}>
            {REASON_ICONS[k]?.()}
            <span>{text(c, k)}</span>
          </li>
        ))}
      </ul>
      <div className="actions" data-part="actions" data-layout="stack">
        {button(c, "activate.recommend.action", "secondary")}
      </div>
    </div>
  );
}

function DoneBody(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  const state = c.view.state;
  const skip = "activate.recommend.skip";
  return (
    <>
      {state === "ready" ? <Recommendation c={c} /> : null}
      {state === "ready" && c.view.copy.includes(skip) && usableKey(c, skip) ? (
        <p className="holder-skip" data-key={skip}>
          {text(c, skip)}
        </p>
      ) : null}
      {actions(
        c,
        state === "waiting"
          ? ["signin.done.start", "activate.waitingSignIn"]
          : ["signin.done.start"],
      )}
    </>
  );
}

/** The step after a license key activates: "<Product> is ready", the license line, and a quiet
 *  recommendation to keep the license in an account. Hidden without `input.activateDone`. */
export function ActivateDone(props: ActivateDoneProps): ReactNode {
  const { onStart, onAddToAccount, onSignIn } = props;
  return (
    <Screen
      {...props}
      name="ActivateDone"
      input={props.input ?? {}}
      markStates={["ready", "waiting"]}
      body={(c) => <DoneBody c={c} />}
      route={(a) => {
        if (a.key === "signin.done.start") onStart?.();
        else if (a.key === "activate.recommend.action") onAddToAccount?.();
        else if (a.key === "activate.waitingSignIn") onSignIn?.();
      }}
    />
  );
}

// ── AddToAccount ─────────────────────────────────────────────────────────────────────────────

export interface AddToAccountProps extends KitProps {
  /** Confirm the email in the browser and attach the license; resolves with the outcome. The
   *  screen then draws added, owned, email-bound or failed itself. Without it (or with
   *  `input.addToAccount`) the host drives the step and hears `common.continue` with `name` and
   *  `email` in the action. */
  attach?: (who: { name: string; email: string }) => Promise<AttachOutcome>;
  /** The device kind already worded ("computer", "phone"). */
  deviceKind?: string;
  /** Cancel (or Escape). */
  onCancel?: () => void;
  /** Start using the product, from added or email-bound. */
  onStart?: () => void;
  /** Sign in to the account that holds the license (owned), or use another one (email-bound). */
  onSignIn?: () => void;
  /** Verify the license's email in the portal (email-bound). */
  onVerify?: () => void;
}

function Fields(props: { c: KitCtx; flow: UseAddToAccount }): ReactNode {
  const { c, flow } = props;
  const keys = new Set(c.view.copy);
  const busy = c.view.state === "busy";
  const badName = keys.has("signin.gate.nameRequired");
  const badEmail = keys.has("signin.email.invalid");
  return (
    <>
      <div className="field" data-part="field">
        <label className="label" htmlFor="pk-holder-name">
          {text(c, "signin.gate.name")}
        </label>
        <input
          id="pk-holder-name"
          data-key="signin.gate.name"
          data-field="name"
          type="text"
          autoComplete="nickname"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          required
          readOnly={busy}
          value={flow.name}
          aria-invalid={badName ? "true" : "false"}
          aria-describedby={badName ? "pk-holder-name-error" : undefined}
          onChange={(e) => flow.setName(e.currentTarget.value)}
        />
        {badName ? (
          <p
            className="field-error"
            id="pk-holder-name-error"
            role="alert"
            data-key="signin.gate.nameRequired"
          >
            {text(c, "signin.gate.nameRequired")}
          </p>
        ) : null}
      </div>
      <div className="field" data-part="field">
        <label className="label" htmlFor="pk-holder-email">
          {text(c, "signin.email.label")}
        </label>
        <input
          id="pk-holder-email"
          data-key="signin.email.label"
          data-field="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          required
          readOnly={busy}
          value={flow.email}
          aria-invalid={badEmail ? "true" : "false"}
          aria-describedby={
            badEmail
              ? "pk-holder-email-error"
              : c.copy.has("activate.attach.fine")
                ? "pk-holder-fine"
                : undefined
          }
          onChange={(e) => flow.setEmail(e.currentTarget.value)}
        />
        {badEmail ? (
          <p
            className="field-error"
            id="pk-holder-email-error"
            role="alert"
            data-key="signin.email.invalid"
          >
            {text(c, "signin.email.invalid")}
          </p>
        ) : null}
        {usableKey(c, "activate.attach.fine") ? (
          <p
            className="hint"
            id="pk-holder-fine"
            data-key="activate.attach.fine"
          >
            {text(c, "activate.attach.fine")}
          </p>
        ) : null}
      </div>
    </>
  );
}

function AddBody(props: { c: KitCtx; flow: UseAddToAccount }): ReactNode {
  const { c, flow } = props;
  const s = c.view.state;
  if (s === "added") return actions(c, ["signin.done.start"]);
  if (s === "owned")
    return (
      <>
        {actions(c, ["signin.key.ownedSignIn"])}
        {links(c, ["common.cancel"])}
      </>
    );
  if (s === "email-bound")
    return (
      <>
        {actions(c, [
          "activate.otherEmail.verify",
          "signin.auto.confirm.other",
        ])}
        {links(c, ["signin.done.start"])}
      </>
    );
  const busy = s === "busy";
  const failed = s === "failed";
  const go = () => {
    if (!busy) c.act(failed ? "common.tryAgain" : "common.continue");
  };
  // The controls sit directly in the card, so a short window docks them in its action bar.
  return (
    <>
      <form
        className="holder-form"
        noValidate
        aria-busy={busy ? "true" : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            go();
          }
        }}
      >
        <Fields c={c} flow={flow} />
        {usableKey(c, "activate.attach.lede") ? (
          <p className="body" data-key="activate.attach.lede">
            {text(c, "activate.attach.lede")}
          </p>
        ) : null}
        {failed && c.copy.has(FAILED_KEY) ? callout(c, [FAILED_KEY]) : null}
      </form>
      <div className="actions" data-part="actions" data-layout="stack">
        {button(c, failed ? "common.tryAgain" : "common.continue", "primary", {
          busy,
        })}
      </div>
      {busy ? (
        <span
          className="visually-hidden"
          role="status"
          data-key="common.working"
        >
          {plain(c, "common.working")}
        </span>
      ) : null}
      {links(c, ["common.cancel"])}
    </>
  );
}

/** Add your name and email: the person types them here; the browser confirms the email. */
export function AddToAccount(props: AddToAccountProps): ReactNode {
  const { onCancel, onStart, onSignIn, onVerify } = props;
  const hosted = props.input?.addToAccount !== undefined;
  const flow = useAddToAccount({
    ...(props.attach && !hosted ? { attach: props.attach } : {}),
    ...(props.input ? { input: props.input } : {}),
    ...(props.deviceKind ? { deviceKind: props.deviceKind } : {}),
  });
  return (
    <Screen
      {...props}
      name="AddToAccount"
      input={flow.input}
      markStates={["added"]}
      body={(c) => <AddBody c={c} flow={flow} />}
      detail={(key) =>
        // A host that drives the step hears the values in the press that submits them (S13).
        hosted && key === "common.continue"
          ? { name: flow.name.trim(), email: flow.email.trim() }
          : {}
      }
      route={(a) => {
        switch (a.key) {
          case "common.continue": {
            const bad = flow.submit();
            if (bad) focusField(bad);
            return;
          }
          case "common.tryAgain":
            flow.retry();
            return;
          case "common.cancel":
            onCancel?.();
            return;
          case "signin.done.start":
            onStart?.();
            return;
          case "signin.key.ownedSignIn":
          case "signin.auto.confirm.other":
            onSignIn?.();
            return;
          case "activate.otherEmail.verify":
            onVerify?.();
            return;
        }
      }}
    />
  );
}

/** Focus the first wrong field again, when the state stays `invalid` and so does not refocus. */
function focusField(field: "name" | "email"): void {
  document
    .querySelector<HTMLElement>(`.pk-root [data-field="${field}"]`)
    ?.focus({ preventScroll: true });
}
