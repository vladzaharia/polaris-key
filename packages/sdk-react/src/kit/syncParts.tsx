// The Cloud Sync screens' own content (U-42.2): the recovery-code field, the recovery code and its
// copy control, "No one will ever ask for this code", the saved checkbox and each screen's actions.
// The elements' twin is packages/elements/src/syncViews.ts: the same DOM, so one stylesheet draws
// both. Security points (U-sync clients plan §9): the code is never an input value, never in the
// view or the input (the host hands it to the screen as a prop), and a typed code leaves only in
// the `onAction` of Unlock (S13).

import { useInsertionEffect, useRef, type ReactNode } from "react";

import { lightDomSyncCss, SYNC_LAYOUTS } from "./syncAssets.js";
import { button, GLYPHS, plain, text, type KitCtx } from "./parts.js";

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

/** The screen's controls: the primary first, the rest after; a destructive confirm is danger. */
function row(c: KitCtx, keys: string[]): ReactNode {
  const present = keys.filter((k) => shown(c, k));
  if (!present.length) return null;
  const primary = c.view.decisions.primary;
  const sorted = [...present].sort(
    (a, b) => Number(b === primary) - Number(a === primary),
  );
  return (
    <div className="actions" data-layout="stack" data-part="actions">
      {sorted.map((k) =>
        button(
          c,
          k,
          k === "unlockSync.startOverConfirm"
            ? "danger"
            : k === primary
              ? "primary"
              : "secondary",
        ),
      )}
    </div>
  );
}

/** The clipboard's text goes straight into the field: nothing keeps or sends it (S13). React reads
 *  the value through its tracker, so it is set the way a keystroke sets it. */
function pasteInto(input: HTMLInputElement | null, edited: () => void): void {
  void navigator.clipboard
    ?.readText()
    .then((t) => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, t.trim());
      edited();
    })
    .catch(() => {
      // A refused read leaves the field to type or paste into.
    });
}

/** The recovery code field and the unlock row. The field is uncontrolled: its text stays in the
 *  field until Unlock reads it at the press, and is in no state, input or view (S13). Editing it
 *  tells the host only that it changed (`recoveryEdited`), never what it holds. */
function UnlockBody(props: { c: KitCtx }): ReactNode {
  const ref = useRef<HTMLInputElement | null>(null);
  const c: KitCtx = {
    ...props.c,
    act: (key, extra) =>
      props.c.act(
        key,
        key === "unlockSync.unlock"
          ? { ...extra, value: ref.current?.value.trim() ?? "" }
          : extra,
      ),
  };
  const invalid = shown(c, "unlockSync.invalid");
  const edited = () => c.edit("recoveryEdited", "1");
  return (
    <>
      <div className="field" data-part="key-field">
        <label className="label" htmlFor="pk-recovery">
          {text(c, "unlockSync.field")}
        </label>
        <div className="field-row field-paste">
          <input
            ref={ref}
            id="pk-recovery"
            data-key="unlockSync.field"
            data-mono=""
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-invalid={invalid ? "true" : "false"}
            aria-describedby={invalid ? "pk-recovery-error" : undefined}
            onChange={edited}
            onKeyDown={(e) => {
              if (e.key === "Enter") c.act("unlockSync.unlock");
            }}
          />
          {c.copy.has("common.paste") ? (
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
      {noAsk(c)}
      {row(c, ["unlockSync.unlock", "unlockSync.startOver", "common.cancel"])}
    </>
  );
}

/** The code as eight groups of four, for the eye; read out whole, group by group.
 *  TODO(U-42.2, Swift fix round): the label becomes the catalog's `a11y.recoveryCode`
 *  ("Recovery code {code}") once that key is on this branch. */
function codeBlock(c: KitCtx, code: string): ReactNode {
  const groups = code.trim().split(/\s+/).filter(Boolean);
  return (
    <div className="field" data-part="code">
      <div
        className="recovery-groups"
        data-key="recoveryCode.title"
        role="text"
        aria-label={groups.join(", ")}
      >
        {groups.map((g, i) => (
          <span key={i} className="g" aria-hidden="true">
            {g}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="btn"
        data-variant="secondary"
        data-part="secondary"
        data-key="recoveryCode.copy"
        aria-disabled={groups.length ? undefined : "true"}
        onClick={() => {
          if (!groups.length) return;
          void navigator.clipboard?.writeText(groups.join(" "))?.catch(() => {
            // A refused write leaves the code on screen to copy by hand.
          });
          c.act("recoveryCode.copy");
        }}
      >
        {GLYPHS.copy()}
        {text(c, "recoveryCode.copy")}
      </button>
    </div>
  );
}

/** UnlockSync, RecoveryCode and RingChange draw their fields and actions here.
 *  TODO(U-42.2, Swift fix round): RingChange gets a `failed` state (ui-matrix row) beside `confirm`. `code` is the
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
  if (view.component === "UnlockSync")
    switch (view.state) {
      case "code":
      case "invalid":
        return <UnlockBody c={c} />;
      case "failed":
        return row(c, ["common.tryAgain", "common.cancel"]);
      case "start-over":
        return row(c, ["unlockSync.startOverConfirm", "common.cancel"]);
      default:
        return null;
    }
  if (view.component === "RecoveryCode")
    return (
      <>
        {codeBlock(c, code)}
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
    return row(c, ["ringChange.useCode", "ringChange.accept", "common.cancel"]);
  return null;
}
