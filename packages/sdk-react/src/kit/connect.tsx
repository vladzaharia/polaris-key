"use client";
// The two inter-account screens (CC-19.9), styled: `<LinkPairing>` (two people pair their devices
// once, in person: the code both compare, the data categories listed before the confirm button,
// the other device's label worded as reported) and `<TransferOffer>` (D-8: a contact offers to
// send something; consent per transfer). The headless half is connectHooks.ts, the views are
// ui-core's `linkPairingView` and `transferOfferView`, and the machines `LinkPairingModel` and
// `TransferOfferModel`. They load on demand (connectLazy.tsx), so the gate's entry carries none
// of it.
//
// Rules: the code is drawn as served and spelled out for a screen reader; nothing takes focus but
// the heading, so Enter on arrival never confirms a code nobody compared; the categories come
// before the confirm button, in the DOM too; a label the other device sent is wrapped in `<bdi>`
// and worded as reported; Escape declines a code and cancels a window.

import { useEffect, useInsertionEffect, useRef, type ReactNode } from "react";
import {
  platformClass,
  categoryFallback,
  connectEscape,
  formatBytes,
  shortName,
  CONNECT_MODELS,
  type ComponentName,
  type ConnectScreenName,
  type LinkPairingDriver,
  type TransferOfferDriver,
  type View,
} from "@polaris-key/ui-core";

import { KitRoot, useKit, type KitAction, type KitProps } from "./component.js";
import { spellOut, type Layout } from "./contract.js";
import { useLinkPairing, useTransferOffer } from "./connectHooks.js";
import {
  actions,
  plain,
  progressBar,
  successMark,
  text,
  type Chrome,
  type KitCtx,
} from "./parts.js";
import { CONNECT_LAYOUTS } from "./syncAssets.js";
import { renderView } from "./views.js";

// ── Rules ────────────────────────────────────────────────────────────────────────────────────

/** The rules these screens add to the kit's sheet: the code, the reported line, the categories. */
/**
 * Two panes (UI-KITS, LinkPairing and TransferOffer): the start pane is the title, the lede and the
 * code or the offer card; the end pane is the reported-device line, the categories and the actions,
 * top-aligned, in the DOM order they already have. Only the code, confirm and ask states are cards
 * with a pane (`.pair-end`, or the ask card's own actions); a message state never matches.
 */
function panes(root: string): string {
  const lp = `${root}[data-component="LinkPairing"] .stage[data-kind="screen"] .card:has(> .pair-end)`;
  const to = `${root}[data-component="TransferOffer"][data-state="ask"] .stage[data-kind="screen"] .card`;
  const stage = `${root}[data-component="LinkPairing"] .stage[data-kind="screen"]:has(.pair-end),
${root}[data-component="TransferOffer"][data-state="ask"] .stage[data-kind="screen"]`;
  // A TV keeps its title-safe area (5 % each side) at any text size.
  const safe =
    root === ".pk-root.pk-tv"
      ? `
  padding-inline: max(var(--pk-space-6), 5vw);
  padding-block: max(var(--pk-space-6), 5vh);`
      : "";
  return `
${stage} {
  /* safe: a card taller than the window starts at its top edge and the window scrolls. */
  align-content: safe center;${safe}
}
${lp},
${to} {
  inline-size: min(46rem, 100%);
  padding-inline: var(--pk-space-5);
  padding-block: var(--pk-space-4);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-rows: auto auto 1fr;
  column-gap: var(--pk-space-6);
  row-gap: var(--pk-space-3);
  align-items: start;
  align-content: start;
  text-align: start;
}
${lp} > *,
${to} > * {
  grid-column: 1;
}
${lp} > .pair-end,
${to} > .actions {
  grid-column: 2;
  grid-row: 1 / -1;
  display: grid;
  gap: var(--pk-space-3);
  align-content: start;
}
${to} > .actions {
  position: static;
  margin: 0;
  padding: 0;
  background: none;
  flex-direction: column;
  justify-content: stretch;
  grid-template-columns: minmax(0, 1fr);
}
${to} > .actions::before {
  content: none;
}
${to} > .actions .btn {
  inline-size: 100%;
  flex: none;
}
`;
}

/** Short and wide enough (600 px at the root size, so 200 % text keeps one column), or a TV. */
const CONNECT_PANES = `@media (max-height: 480px) {
  @container pk (min-width: 37.5rem) {${panes(".pk-root")}}
}
${panes(".pk-root.pk-tv")}`;

/** The rules every pairing screen shares: the categories (`.pair-shares`) and the waiting row. */
export const PAIR_SHARED_CSS = `@layer polaris-key {
.pk-root .pair-shares {
  display: grid;
  gap: var(--pk-space-2);
}
.pk-root .pair-shares .label {
  margin: 0;
}
.pk-root .pair-cats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pk-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.pk-root .pair-cats li {
  padding: var(--pk-space-1) var(--pk-space-3);
  border-radius: var(--pk-radius-full);
  background: color-mix(in srgb, var(--pk-text-strong) 9%, transparent);
  color: var(--pk-text-strong);
  overflow-wrap: anywhere;
}
.pk-root .pair-wait {
  display: flex;
  align-items: center;
  gap: var(--pk-space-3);
  margin: 0;
  color: var(--pk-text-muted);
}
.pk-root .pair-dot {
  flex: none;
  inline-size: 0.75rem;
  block-size: 0.75rem;
  border-radius: var(--pk-radius-full);
  background: var(--pk-accent-fg);
  animation: pk-pair-pulse 1.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .pk-root .pair-dot {
    animation: none;
  }
}
@keyframes pk-pair-pulse {
  50% {
    opacity: 0.35;
  }
}
}
`;

const CONNECT_CSS = `@layer polaris-key {
.pk-root .pair-code {
  display: block;
  padding: var(--pk-space-4);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  font-family: var(--pk-kit-type-code-family);
  font-weight: var(--pk-kit-type-code-weight);
  font-size: 2rem;
  line-height: 1.2;
  letter-spacing: 0.08em;
  color: var(--pk-text-strong);
  text-align: center;
  overflow-wrap: anywhere;
}
.pk-root .pair-reported {
  margin: 0;
  color: var(--pk-text-strong);
  overflow-wrap: anywhere;
}
.pk-root .pair-actions,
.pk-root .pair-end {
  display: contents;
}
.pk-root .pair-offer {
  display: grid;
  gap: var(--pk-space-1);
}
.pk-root .pair-meta {
  margin: 0;
  color: var(--pk-text-muted);
  overflow-wrap: anywhere;
}
.pk-root .pair-file {
  margin: 0;
  color: var(--pk-text-strong);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}
${PAIR_SHARED_CSS}
${CONNECT_PANES}
}
`;

const sheets = new WeakMap<Document, Set<string>>();

/** Adopt `css` once per document, with the first screen drawn (never a `<style>` element). */
export function adoptStyles(doc: Document, css: string): void {
  const seen = sheets.get(doc) ?? new Set<string>();
  if (seen.has(css) || typeof CSSStyleSheet !== "function") return;
  try {
    const own = new CSSStyleSheet();
    own.replaceSync(css);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, own];
    sheets.set(doc, seen.add(css));
  } catch {
    // No constructable sheets, or a document of another realm: it links styles.css.
  }
}

// ── One screen ───────────────────────────────────────────────────────────────────────────────

interface ScreenProps extends KitProps {
  /** Press routes for the host: called after `onAction`. */
  route?: (a: KitAction) => void;
}

export function Screen(
  props: ScreenProps & {
    name: ConnectScreenName;
    /** The sheet this screen adopts: the pairing screens' own rules by default. */
    css?: string;
    /** What the drop-in adds around the view's own controls (Back above the card). */
    chrome?: Chrome;
    input: NonNullable<KitProps["input"]>;
    body?: (c: KitCtx) => ReactNode;
    /** The control Escape answers (decline a code, cancel a window). */
    escape: (view: View) => string | null;
  },
): ReactNode {
  const { name, body, route, escape } = props;
  const model = CONNECT_MODELS[name];
  const kit = useKit(
    name as unknown as ComponentName,
    (ctx) => model(ctx) as unknown as View,
    {
      ...props,
      input: props.input,
      onAction: (a) => {
        props.onAction?.(a);
        route?.(a);
      },
    },
  );
  useInsertionEffect(() => {
    if (typeof document !== "undefined")
      adoptStyles(document, props.css ?? CONNECT_CSS);
  }, []);
  if (kit.view.state === "hidden") return null;
  const base = kit.ctxFor(kit.view);
  const layout: Layout = CONNECT_LAYOUTS[name];
  const done =
    (name === "TransferOffer" && kit.view.state === "done") ||
    (name === "LocalPairing" && kit.view.state === "paired");
  const ctx: KitCtx = {
    ...base,
    layout,
    chrome: props.chrome,
    mark: done ? successMark() : null,
    content: null,
  };
  const content = body ? body(ctx) : null;
  const esc = escape(kit.view);
  // A TV, or a pad-only screen on one, is always two panes (the width rule does not apply).
  const pc = platformClass(ctx.input.platform ?? null);
  const tv = pc === "tv" || pc === "console";
  return (
    <KitRoot
      kit={kit}
      bare={props.bare}
      fill={props.fill}
      className={[props.className, tv ? "pk-tv" : ""].filter(Boolean).join(" ")}
      onEscape={esc ? () => ctx.act(esc) : undefined}
    >
      {renderView({ ...ctx, content })}
    </KitRoot>
  );
}

// ── LinkPairing ──────────────────────────────────────────────────────────────────────────────

export interface LinkPairingProps extends KitProps {
  /** Drive the window: `linkPairingDriver(client.cloudConnect.links)`, or any driver. Without it
   *  the part draws `input.linkPairing` and the host does the rest. */
  driver?: LinkPairingDriver;
  /** The data categories this app asks both people to approve (ids). Listed before Codes match. */
  categories?: readonly string[];
  /** The name each category goes by on screen, by id; an id without one is drawn as it is. */
  categoryLabels?: Readonly<Record<string, string>>;
  /** This device's label, sent to the other device. */
  label?: string;
  /** Seconds the window stays open (at most 300). */
  seconds?: number;
  /** A link was made. */
  onLinked?: () => void;
  /** Done, Cancel or Escape: the host closes the screen. */
  onClose?: () => void;
}

/** What both people approve: the heading and one chip per category (`cats`, or the input's). */
export function Categories(props: {
  c: KitCtx;
  labels?: Readonly<Record<string, string>>;
  cats?: readonly string[];
}): ReactNode {
  const { c, labels } = props;
  const keys = c.view.copy;
  const head = keys.includes("linkPairing.shares")
    ? "linkPairing.shares"
    : keys.includes("linkPairing.sharesNone")
      ? "linkPairing.sharesNone"
      : null;
  if (!head) return null;
  const cats = props.cats ?? c.input.linkPairing?.categories ?? [];
  return (
    <div className="pair-shares" data-part="shares">
      {head === "linkPairing.shares" ? (
        <>
          <span className="label" id="pk-shares" data-key={head}>
            {text(c, head)}
          </span>
          <ul className="pair-cats" aria-labelledby="pk-shares">
            {cats.map((id) => (
              <li key={id} data-key={`category.${id}`}>
                <bdi>{labels?.[id] ?? categoryFallback(id)}</bdi>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="body" data-key={head}>
          {text(c, head)}
        </p>
      )}
    </div>
  );
}

/** The code, kept on screen through `confirm`. The line that says which device reported it follows
 *  in the end pane (`.pair-end`, which is transparent to layout in one column). */
function PairCode(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  const has = (k: string) => c.view.copy.includes(k);
  const code = c.input.linkPairing?.code ?? "";
  return (
    <span
      className="pair-code"
      role="text"
      data-key="a11y.linkCode"
      aria-label={
        has("a11y.linkCode")
          ? plain(c, "a11y.linkCode", { code: spellOut(code) })
          : spellOut(code)
      }
    >
      {code}
    </span>
  );
}

function Reported(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  const reported = c.view.copy.includes("linkPairing.reported")
    ? "linkPairing.reported"
    : "linkPairing.reportedUnnamed";
  return (
    <p className="pair-reported" data-key={reported}>
      {text(c, reported)}
    </p>
  );
}

/**
 * What each state draws in its `content`: in the DOM order the person reads and acts in. The actions
 * sit in a wrapper that is not the card's direct child, so the kit's docked action bar never applies:
 * they flow after the categories, and Codes match cannot be on screen before what would be shared.
 */
function PairBody(props: {
  c: KitCtx;
  labels?: Readonly<Record<string, string>>;
}): ReactNode {
  const { c, labels } = props;
  const act = (keys: string[]) => (
    <div className="pair-actions">{actions(c, keys)}</div>
  );
  switch (c.view.state) {
    case "open":
      return (
        <>
          <p
            className="pair-wait"
            role="status"
            data-key="linkPairing.searching"
          >
            <span className="pair-dot" aria-hidden="true" />
            <span>{text(c, "linkPairing.searching")}</span>
          </p>
          {act(["common.cancel"])}
        </>
      );
    case "code":
      return (
        <>
          <PairCode c={c} />
          <div className="pair-end">
            <Reported c={c} />
            <Categories c={c} labels={labels} />
            {act(["linkPairing.confirm", "linkPairing.decline"])}
          </div>
        </>
      );
    case "confirm":
      // The other person may still be comparing against this screen: the code stays, and the wait is
      // said beside the dot (the title, where focus lands, is what a screen reader reads).
      return (
        <>
          <PairCode c={c} />
          <div className="pair-end">
            <Reported c={c} />
            <Categories c={c} labels={labels} />
            <p className="pair-wait" role="status">
              <span className="pair-dot" aria-hidden="true" />
              <span aria-hidden="true">{plain(c, "linkPairing.waiting")}</span>
            </p>
            {act(["common.cancel"])}
          </div>
        </>
      );
    case "linked":
      return (
        <>
          <Categories c={c} labels={labels} />
          {act(["common.done"])}
        </>
      );
    case "failed":
      return act(["common.tryAgain", "common.done"]);
    case "unavailable":
      // The explanation comes before Done, on screen and in reading order.
      return (
        <>
          <p
            className="body"
            data-key="core.codes.connect_links_disabled.message"
          >
            {text(c, "core.codes.connect_links_disabled.message")}
          </p>
          {act(["common.done"])}
        </>
      );
    default:
      return null;
  }
}

/**
 * Pair with someone nearby: both people open it, compare the code, check what would be shared and
 * confirm. Given a `driver` it runs the window itself and closes it on unmount; given an `input`
 * it is the plain part and the host drives it. Hidden without `input.linkPairing` or a driver.
 */
export function LinkPairing(props: LinkPairingProps): ReactNode {
  return props.driver ? (
    <DrivenPairing {...props} driver={props.driver} />
  ) : (
    <Screen
      {...props}
      name="LinkPairing"
      input={props.input ?? {}}
      escape={connectEscape}
      body={(c) => <PairBody c={c} labels={props.categoryLabels} />}
      route={(a) => {
        if (a.key === "common.done" || a.key === "common.cancel")
          props.onClose?.();
      }}
    />
  );
}

function DrivenPairing(
  props: LinkPairingProps & { driver: LinkPairingDriver },
): ReactNode {
  const { driver, categories, label, seconds, onLinked, onClose } = props;
  const pair = useLinkPairing({
    driver,
    categories: categories ?? [],
    label,
    seconds,
    base: props.input,
  });
  const step = pair.snapshot.step;
  const told = useRef(false);
  useEffect(() => {
    if (step === "linked" && !told.current) {
      told.current = true;
      onLinked?.();
    }
    if (step !== "linked") told.current = false;
  }, [step, onLinked]);
  return (
    <Screen
      {...props}
      name="LinkPairing"
      input={pair.input}
      escape={connectEscape}
      body={(c) => <PairBody c={c} labels={props.categoryLabels} />}
      route={(a) => {
        switch (a.key) {
          case "linkPairing.confirm":
            void pair.confirmMatch();
            break;
          case "linkPairing.decline":
            void pair.declineMatch();
            break;
          case "common.tryAgain":
            void pair.start();
            break;
          case "common.cancel":
          case "common.done":
            void pair.cancel().then(() => onClose?.());
            break;
        }
      }}
    />
  );
}

// ── TransferOffer ────────────────────────────────────────────────────────────────────────────

export interface TransferOfferProps extends KitProps {
  /** Answer the offer: accept resolves when everything arrived and was saved. Without it the part
   *  draws `input.transferOffer` and the host hears the presses in `onAction`. */
  driver?: TransferOfferDriver;
  /** The contact's label (text the contact chose). */
  device?: string | null;
  /** What it offers (text the contact chose). */
  name?: string;
  /** Its size in bytes and media type, when the contact said. */
  size?: number;
  type?: string;
  /** Decline, Cancel, Done or Escape: the host closes the prompt. */
  onClose?: () => void;
}

/** The offer's own row, apart from the heading: the name with its middle elided, then the size and
 *  type when the contact said; a bar while receiving. */
function offerBody(c: KitCtx): ReactNode {
  const t = c.input.transferOffer;
  const name = t?.name ?? "";
  if (c.view.state === "ask" && name !== "") {
    const facts = [
      t?.size !== undefined ? formatBytes(t.size, c.copy.locale) : "",
      t?.type ?? "",
    ].filter(Boolean);
    return (
      <div className="pair-offer" data-part="file">
        <p className="pair-file" title={name}>
          <bdi>{shortName(name, 48)}</bdi>
        </p>
        {facts.length ? (
          <p className="meta pair-meta" data-part="file-meta">
            <bdi>{facts.join(" · ")}</bdi>
          </p>
        ) : null}
      </div>
    );
  }
  if (c.view.state === "receiving") return progressBar(c, undefined);
  return null;
}

/**
 * A contact offers to send something: its label and the name it chose, Accept and Decline
 * (D-8, consent per transfer). Given a `driver`, `device` and `name` it runs the transfer itself.
 */
export function TransferOffer(props: TransferOfferProps): ReactNode {
  return props.driver ? (
    <DrivenOffer {...props} driver={props.driver} />
  ) : (
    <Screen
      {...props}
      name="TransferOffer"
      input={props.input ?? {}}
      escape={connectEscape}
      body={offerBody}
      route={(a) => {
        if (
          a.key === "transferOffer.decline" ||
          a.key === "common.cancel" ||
          a.key === "common.done"
        )
          props.onClose?.();
      }}
    />
  );
}

function DrivenOffer(
  props: TransferOfferProps & { driver: TransferOfferDriver },
): ReactNode {
  const offer = useTransferOffer({
    driver: props.driver,
    device: props.device,
    name: props.name ?? "",
    size: props.size,
    type: props.type,
    base: props.input,
  });
  return (
    <Screen
      {...props}
      name="TransferOffer"
      input={offer.input}
      escape={connectEscape}
      body={offerBody}
      route={(a) => {
        switch (a.key) {
          case "transferOffer.accept":
            void offer.accept();
            break;
          case "transferOffer.decline":
            void offer.decline().then(() => props.onClose?.());
            break;
          case "common.cancel":
            void offer.cancel();
            break;
          case "common.done":
            offer.close();
            props.onClose?.();
            break;
        }
      }}
    />
  );
}
