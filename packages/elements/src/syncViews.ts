// The Cloud Sync screens' own content (U-42.2): the recovery-code field, the recovery code and its
// copy control, "No one will ever ask for this code", the saved checkbox and each screen's actions.
// The React twin is packages/sdk-react/src/kit/syncParts.tsx: the same DOM, so one stylesheet
// draws both. Security points (U-sync clients plan §9): the code is never an input value, never in
// the view or the input (the host hands it to the element as a property), and a typed code leaves
// only in the `pk-action` of Unlock (S13).

import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";

import { copyForm, recoveryGroups, spokenForm } from "./recoveryCode.js";
import {
  GLYPHS,
  button,
  callout,
  plain,
  text,
  type RenderCtx,
} from "./render.js";

type Out = TemplateResult | typeof nothing;
const shown = (c: RenderCtx, k: string): boolean => c.view.copy.includes(k);

/** The note under the field and the code: nothing asks for it (T23). */
function noAsk(c: RenderCtx): Out {
  return shown(c, "recoveryCode.noAsk")
    ? html`<p class="body note" data-key="recoveryCode.noAsk">
        ${text(c, "recoveryCode.noAsk")}
      </p>`
    : nothing;
}

/** The screen's controls: the primary first, the rest after; a destructive confirm is danger, and
 *  a quiet Cancel (a link) leaves the steps that are not a confirmation. `busy` carries progress;
 *  `waiting` keys ignore presses until armed. */
function row(
  c: RenderCtx,
  keys: string[],
  o: { busy?: string; waiting?: string; quiet?: boolean; group?: boolean } = {},
): Out {
  const present = keys.filter((k) => shown(c, k) || k === o.busy);
  if (!present.length) return nothing;
  const primary = c.view.decisions.primary;
  const sorted = [...present].sort(
    (a, b) =>
      Number(b === primary || b === o.busy) -
      Number(a === primary || a === o.busy),
  );
  return html`<div
    class="actions"
    part="actions"
    data-part="actions"
    data-layout="stack"
    role=${ifDefined(o.group ? "group" : undefined)}
    aria-labelledby=${ifDefined(o.group ? "pk-title" : undefined)}
    aria-describedby=${ifDefined(o.group ? "pk-start-warning" : undefined)}
  >
    ${sorted.map((k) =>
      button(
        c,
        k,
        k === "unlockSync.startOverConfirm"
          ? "danger"
          : k === primary || k === o.busy
            ? "primary"
            : k === "common.cancel" && o.quiet
              ? "link"
              : "secondary",
        { busy: k === o.busy, disabled: k === o.waiting },
      ),
    )}
  </div>`;
}

/** The recovery code the person types: two wrapping lines, upper-cased as it shows, never a copy
 *  of the code shown anywhere. It stays mounted (read-only while working, hidden on the warning
 *  and the failure) so a typo costs one edit, not 32 characters. */
function codeField(c: RenderCtx, mode: "edit" | "busy" | "hidden"): Out {
  const invalid = shown(c, "unlockSync.invalid");
  const edited = () => c.edit("recoveryEdited", true);
  return html`<div
    class="field"
    part="key-field"
    data-part="key-field"
    ?hidden=${mode === "hidden"}
  >
    <label class="label" for="pk-recovery"
      >${text(c, "unlockSync.field")}</label
    >
    <div class="field-row field-paste">
      <textarea
        id="pk-recovery"
        data-key="unlockSync.field"
        data-mono
        rows="2"
        autocomplete="off"
        autocapitalize="characters"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="go"
        ?readonly=${mode === "busy"}
        aria-invalid=${invalid ? "true" : "false"}
        aria-describedby=${ifDefined(invalid ? "pk-recovery-error" : undefined)}
        @input=${edited}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key !== "Enter" || e.shiftKey) return;
          e.preventDefault();
          if (mode === "edit") c.act("unlockSync.unlock");
        }}
      ></textarea>
      ${c.copy.has("common.paste") && mode === "edit"
        ? html`<button
            type="button"
            class="btn paste"
            part="link"
            data-part="link"
            data-variant="link"
            data-key="common.paste"
            aria-label=${plain(c, "common.paste")}
            title=${plain(c, "common.paste")}
            @click=${(e: Event) =>
              pasteInto(e.currentTarget as HTMLElement, edited)}
          >
            ${GLYPHS.paste()}
          </button>`
        : nothing}
    </div>
    ${invalid
      ? html`<p
          class="field-error"
          id="pk-recovery-error"
          role="alert"
          data-key="unlockSync.invalid"
        >
          ${text(c, "unlockSync.invalid")}
        </p>`
      : nothing}
  </div>`;
}

/** The clipboard's text goes straight into the field: nothing keeps or sends it (S13). */
function pasteInto(from: HTMLElement, edited: () => void): void {
  const field = from
    .closest(".field")
    ?.querySelector<HTMLTextAreaElement>("textarea");
  void navigator.clipboard
    ?.readText()
    .then((t) => {
      if (field) field.value = t.trim();
      edited();
    })
    .catch(() => {
      // A refused read leaves the field to type or paste into.
    });
}

/** The code as groups of four, for the eye; spelled out group by group for a screen reader (an
 *  image with a label: Chromium and Firefox read it, a `text` role they do not know). */
function codeBlock(c: RenderCtx, code: string): Out {
  const groups = recoveryGroups(code);
  const spoken = spokenForm(groups);
  const said = c.copied === true && c.copy.has("common.copied");
  const label = c.copy.has("a11y.recoveryCode")
    ? plain(c, "a11y.recoveryCode", { code: spoken })
    : spoken;
  return html`<div class="field" part="code" data-part="code">
    ${groups.length
      ? html`<div
          class="recovery-groups"
          data-key="recoveryCode.title"
          role="img"
          aria-label=${label}
        >
          ${groups.map(
            (g) => html`<span class="g" aria-hidden="true">${g}</span>`,
          )}
        </div>`
      : nothing}
    <button
      type="button"
      class="btn"
      part="secondary"
      data-part="secondary"
      data-variant="secondary"
      data-key="recoveryCode.copy"
      aria-disabled=${ifDefined(groups.length ? undefined : "true")}
      @click=${() => {
        if (!groups.length) return;
        void navigator.clipboard?.writeText(copyForm(groups))?.catch(() => {
          // A refused write leaves the code on screen to copy by hand.
        });
        c.act("recoveryCode.copy");
        c.markCopied?.();
      }}
    >
      ${GLYPHS.copy()}<span
        >${text(c, said ? "common.copied" : "recoveryCode.copy")}</span
      >
    </button>
    <span class="visually-hidden" role="status" data-copied-status
      >${said ? text(c, "common.copied") : ""}</span
    >
  </div>`;
}

/** UnlockSync, RecoveryCode and RingChange draw their fields and actions here. `c.code` is the
 *  recovery code the host handed RecoveryCode (it is in no input). */
export function syncContent(c: RenderCtx): Out {
  const { view } = c;
  if (view.component === "UnlockSync") return unlockContent(c);
  if (view.component === "RecoveryCode")
    return html`${codeBlock(c, c.code ?? "")}${noAsk(c)}
    ${shown(c, "recoveryCode.saved")
      ? html`<label class="check-row" data-key="recoveryCode.saved">
          <input
            type="checkbox"
            .checked=${view.state === "saved"}
            @change=${(e: Event) =>
              c.edit("recoverySaved", (e.target as HTMLInputElement).checked)}
          />
          <span>${text(c, "recoveryCode.saved")}</span>
        </label>`
      : nothing}
    ${row(c, ["common.done"])}`;
  if (view.component === "RingChange") {
    const busy = c.input.ringChange?.busy === true;
    return html`${shown(c, "ringChange.failed")
      ? callout(c, ["ringChange.failed"])
      : nothing}
    ${row(c, ["ringChange.useCode", "ringChange.accept", "common.cancel"], {
      busy: busy ? "ringChange.accept" : undefined,
      quiet: true,
    })}`;
  }
  return nothing;
}

/** One template for every UnlockSync step, so the field keeps its text and the pressed control
 *  keeps focus from one step to the next. */
function unlockContent(c: RenderCtx): Out {
  const s = c.view.state;
  const field = codeField(
    c,
    s === "code" || s === "invalid"
      ? "edit"
      : s === "working"
        ? "busy"
        : "hidden",
  );
  const busy =
    c.input.unlockSync?.busy === "start-over"
      ? "unlockSync.startOverConfirm"
      : "unlockSync.unlock";
  // One template for every step: the field, the note, the warning, the reason and the actions are
  // slots, so lit keeps the same nodes (the typed text, the pressed control) from step to step.
  const warning =
    s === "start-over"
      ? html`<p
          class="body"
          id="pk-start-warning"
          data-key="unlockSync.startOverWarning"
        >
          ${text(c, "unlockSync.startOverWarning")}
        </p>`
      : nothing;
  const noCode =
    s === "no-code"
      ? html`<p class="body" role="status" data-key="unlockSync.noCode">
          ${text(c, "unlockSync.noCode")}
        </p>`
      : nothing;
  const actions =
    s === "working"
      ? row(c, [busy], { busy })
      : s === "failed" || s === "start-over-failed"
        ? row(c, ["common.tryAgain", "common.cancel"], { quiet: true })
        : s === "no-code"
          ? row(c, ["unlockSync.startOver", "common.cancel"], { quiet: true })
          : s === "start-over"
            ? row(c, ["unlockSync.startOverConfirm", "common.cancel"], {
                group: true,
                waiting:
                  c.armed === false ? "unlockSync.startOverConfirm" : undefined,
              })
            : row(
                c,
                ["unlockSync.unlock", "unlockSync.startOver", "common.cancel"],
                { quiet: true },
              );
  return html`${field}${s === "code" || s === "invalid"
    ? noAsk(c)
    : nothing}${warning}${noCode}${s === "failed" || s === "start-over-failed"
    ? callout(c, [
        s === "failed" ? "unlockSync.failed" : "unlockSync.startOverFailed",
      ])
    : nothing}${actions}`;
}
