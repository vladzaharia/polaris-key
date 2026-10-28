// The Cloud Sync screens' own content (U-42.2): the recovery-code field, the recovery code and its
// copy control, "No one will ever ask for this code", the saved checkbox and each screen's actions.
// The elements' twin is packages/elements/src/syncViews.ts: the same DOM, so one stylesheet draws
// both. Security points (U-sync clients plan §9): the code is never an input value, never in the
// view or the input (the host hands it to the screen as a prop), and a typed code leaves only in
// the `onAction` of Unlock (S13).

import {
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  copyForm,
  lightDomSyncCss,
  recoveryGroups,
  spokenForm,
  SYNC_LAYOUTS,
} from "./syncAssets.js";
import { button, callout, GLYPHS, plain, text, type KitCtx } from "./parts.js";

export { SYNC_LAYOUTS };

// The screens' rules (the recovery code's groups, its note, the saved checkbox) are their own sheet,
// adopted with the first screen drawn, so the gate's web sheet does not carry them.
let sheet: CSSStyleSheet | null = null;
const adopted = new WeakSet<Document>();

function adoptSyncStyles(doc: Document): void {
  if (adopted.has(doc)) return;
  adopted.add(doc);
  if (
    !("adoptedStyleSheets" in doc) ||
    typeof CSSStyleSheet !== "function" ||
    !("replaceSync" in CSSStyleSheet.prototype)
  )
    return;
  try {
    sheet ??= new CSSStyleSheet();
    if (sheet.cssRules.length === 0) sheet.replaceSync(lightDomSyncCss());
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    // A document of another realm: it links styles.css, which has these rules.
  }
}

function SyncStyles(): ReactNode {
  useInsertionEffect(() => {
    if (typeof document !== "undefined") adoptSyncStyles(document);
  }, []);
  return null;
}

const shown = (c: KitCtx, k: string): boolean => c.view.copy.includes(k);

/** The note under the field and the code: nothing asks for it (T23). */
function noAsk(c: KitCtx): ReactNode {
  return shown(c, "recoveryCode.noAsk") ? (
    <p className="body note" data-key="recoveryCode.noAsk">
      {text(c, "recoveryCode.noAsk")}
    </p>
  ) : null;
}

/** The screen's controls: the primary first, the rest after; a destructive confirm is danger, and
 *  a quiet Cancel (a link) leaves the steps that are not a confirmation. `busy` carries progress;
 *  `waiting` ignores presses and reads as unavailable until it is armed. */
function Row(props: {
  c: KitCtx;
  keys: string[];
  busy?: string;
  waiting?: string;
  quiet?: boolean;
  group?: boolean;
}): ReactNode {
  const { c, keys, busy, waiting } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  // The React button has no unavailable state of its own; the armed delay marks it here.
  useEffect(() => {
    const el = waiting
      ? ref.current?.querySelector<HTMLElement>(`[data-key="${waiting}"]`)
      : null;
    el?.setAttribute("aria-disabled", "true");
    return () => el?.removeAttribute("aria-disabled");
  }, [waiting]);
  const present = keys.filter((k) => shown(c, k) || k === busy);
  if (!present.length) return null;
  const primary = c.view.decisions.primary;
  const sorted = [...present].sort(
    (a, b) =>
      Number(b === primary || b === busy) - Number(a === primary || a === busy),
  );
  return (
    <div
      ref={ref}
      className="actions"
      data-layout="stack"
      data-part="actions"
      role={props.group ? "group" : undefined}
      aria-labelledby={props.group ? "pk-title" : undefined}
      aria-describedby={props.group ? "pk-start-warning" : undefined}
    >
      {sorted.map((k) =>
        button(
          c,
          k,
          k === "unlockSync.startOverConfirm"
            ? "danger"
            : k === primary || k === busy
              ? "primary"
              : k === "common.cancel" && props.quiet
                ? "link"
                : "secondary",
          { busy: k === busy },
        ),
      )}
    </div>
  );
}
const row = (
  c: KitCtx,
  keys: string[],
  o: Omit<Parameters<typeof Row>[0], "c" | "keys"> = {},
): ReactNode => <Row c={c} keys={keys} {...o} />;

/** The clipboard's text goes straight into the field: nothing keeps or sends it (S13). React reads
 *  the value through its tracker, so it is set the way a keystroke sets it. */
function pasteInto(
  input: HTMLTextAreaElement | null,
  edited: () => void,
): void {
  void navigator.clipboard
    ?.readText()
    .then((t) => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(input, t.trim());
      edited();
    })
    .catch(() => {
      // A refused read leaves the field to type or paste into.
    });
}

/** True from 500 ms after `on` turned true: the Start over confirm takes no press before that, so
 *  a double-click on Start over cannot also confirm it. */
function useArmed(on: boolean): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!on) return;
    const t = setTimeout(() => setArmed(true), 500);
    return () => clearTimeout(t);
  }, [on]);
  return armed;
}

/** Every UnlockSync step, in one tree: the field keeps its text (read-only while working, hidden on
 *  the warning and the failure) and the pressed control keeps focus from step to step. The field is
 *  uncontrolled: its text stays in the field until Unlock reads it at the press, and is in no
 *  state, input or view (S13). Editing tells the host only that it changed (`recoveryEdited`). */
function UnlockBody(props: { c: KitCtx }): ReactNode {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const s = props.c.view.state;
  const armed = useArmed(s === "start-over");
  const c: KitCtx = {
    ...props.c,
    act: (key, extra) => {
      if (key === "unlockSync.startOverConfirm" && !armed) return;
      if (key !== "unlockSync.unlock") return props.c.act(key, extra);
      // An empty field sends nothing and keeps focus in it.
      const value = (ref.current?.value ?? "").replace(/\s+/g, " ").trim();
      if (value === "") ref.current?.focus();
      else props.c.act(key, { ...extra, value });
    },
  };
  const mode =
    s === "code" || s === "invalid"
      ? "edit"
      : s === "working"
        ? "busy"
        : "hidden";
  const invalid = shown(c, "unlockSync.invalid");
  const edited = () => c.edit("recoveryEdited", "1");
  const busy =
    c.input.unlockSync?.busy === "start-over"
      ? "unlockSync.startOverConfirm"
      : "unlockSync.unlock";
  return (
    <>
      <div className="field" data-part="key-field" hidden={mode === "hidden"}>
        <label className="label" htmlFor="pk-recovery">
          {text(c, "unlockSync.field")}
        </label>
        <div className="field-row field-paste">
          <textarea
            ref={ref}
            id="pk-recovery"
            data-key="unlockSync.field"
            data-mono=""
            rows={2}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            readOnly={mode === "busy"}
            aria-invalid={invalid ? "true" : "false"}
            aria-describedby={invalid ? "pk-recovery-error" : undefined}
            onChange={edited}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey) return;
              e.preventDefault();
              if (mode === "edit") c.act("unlockSync.unlock");
            }}
          />
          {c.copy.has("common.paste") && mode === "edit" ? (
            <button
              type="button"
              className="btn paste"
              data-part="link"
              data-variant="link"
              data-key="common.paste"
              aria-label={plain(c, "common.paste")}
              onClick={() => pasteInto(ref.current, edited)}
            >
              {GLYPHS.paste()}
            </button>
          ) : null}
        </div>
        {invalid ? (
          <p
            className="field-error"
            id="pk-recovery-error"
            role="alert"
            data-key="unlockSync.invalid"
          >
            {text(c, "unlockSync.invalid")}
          </p>
        ) : null}
      </div>
      {s === "code" || s === "invalid" ? noAsk(c) : null}
      {s === "start-over" ? (
        <p
          className="body"
          id="pk-start-warning"
          data-key="unlockSync.startOverWarning"
        >
          {text(c, "unlockSync.startOverWarning")}
        </p>
      ) : null}
      {s === "no-code" ? (
        <p className="body" role="status" data-key="unlockSync.noCode">
          {text(c, "unlockSync.noCode")}
        </p>
      ) : null}
      {s === "failed" || s === "start-over-failed"
        ? callout(c, [
            s === "failed" ? "unlockSync.failed" : "unlockSync.startOverFailed",
          ])
        : null}
      {s === "working"
        ? row(c, [busy], { busy })
        : s === "failed" || s === "start-over-failed"
          ? row(c, ["common.tryAgain", "common.cancel"], { quiet: true })
          : s === "no-code"
            ? row(c, ["unlockSync.startOver", "common.cancel"], { quiet: true })
            : s === "start-over"
              ? row(c, ["unlockSync.startOverConfirm", "common.cancel"], {
                  group: true,
                  waiting: armed ? undefined : "unlockSync.startOverConfirm",
                })
              : row(
                  c,
                  [
                    "unlockSync.unlock",
                    "unlockSync.startOver",
                    "common.cancel",
                  ],
                  { quiet: true },
                )}
    </>
  );
}

/** The code as groups of four, for the eye; spelled out group by group for a screen reader (an
 *  image with a label: Chromium and Firefox read it, a `text` role they do not know). Copy writes
 *  the hyphenated form and says so for two seconds. */
function CodeBlock(props: { c: KitCtx; code: string }): ReactNode {
  const { c } = props;
  const groups = recoveryGroups(props.code);
  const spoken = spokenForm(groups);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const said = copied && c.copy.has("common.copied");
  return (
    <div className="field" data-part="code">
      {groups.length ? (
        <div
          className="recovery-groups"
          data-key="recoveryCode.title"
          role="img"
          aria-label={
            c.copy.has("a11y.recoveryCode")
              ? plain(c, "a11y.recoveryCode", { code: spoken })
              : spoken
          }
        >
          {groups.map((g, i) => (
            <span key={i} className="g" aria-hidden="true">
              {g}
            </span>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="btn"
        data-variant="secondary"
        data-part="secondary"
        data-key="recoveryCode.copy"
        aria-disabled={groups.length ? undefined : "true"}
        onClick={() => {
          if (!groups.length) return;
          void navigator.clipboard?.writeText(copyForm(groups))?.catch(() => {
            // A refused write leaves the code on screen to copy by hand.
          });
          setCopied(true);
          c.act("recoveryCode.copy");
        }}
      >
        {GLYPHS.copy()}
        <span>{text(c, said ? "common.copied" : "recoveryCode.copy")}</span>
      </button>
      <span className="visually-hidden" role="status">
        {said ? text(c, "common.copied") : ""}
      </span>
    </div>
  );
}

/** UnlockSync, RecoveryCode and RingChange draw their fields and actions here. `code` is the
 *  recovery code the host handed RecoveryCode (it is in no input). */
export function syncContent(c: KitCtx, code: string): ReactNode {
  return (
    <>
      <SyncStyles />
      {screenContent(c, code)}
    </>
  );
}

function screenContent(c: KitCtx, code: string): ReactNode {
  const { view } = c;
  if (view.component === "UnlockSync") return <UnlockBody c={c} />;
  if (view.component === "RecoveryCode")
    return (
      <>
        <CodeBlock c={c} code={code} />
        {noAsk(c)}
        {shown(c, "recoveryCode.saved") ? (
          <label className="check-row" data-key="recoveryCode.saved">
            <input
              type="checkbox"
              checked={view.state === "saved"}
              onChange={(e) =>
                c.edit("recoverySaved", e.currentTarget.checked ? "1" : "")
              }
            />
            <span>{text(c, "recoveryCode.saved")}</span>
          </label>
        ) : null}
        {row(c, ["common.done"])}
      </>
    );
  if (view.component === "RingChange")
    return (
      <>
        {shown(c, "ringChange.failed")
          ? callout(c, ["ringChange.failed"])
          : null}
        {row(c, ["ringChange.useCode", "ringChange.accept", "common.cancel"], {
          busy: c.input.ringChange?.busy ? "ringChange.accept" : undefined,
          quiet: true,
        })}
      </>
    );
  return null;
}
