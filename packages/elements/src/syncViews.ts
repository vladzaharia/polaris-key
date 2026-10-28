// The Cloud Sync screens' own content (U-42.2): the recovery-code field, the recovery code and its
// copy control, "No one will ever ask for this code", the saved checkbox and each screen's actions.
// The React twin is packages/sdk-react/src/kit/syncParts.tsx: the same DOM, so one stylesheet
// draws both. Security points (U-sync clients plan §9): the code is never an input value, never in
// the view or the input (the host hands it to the element as a property), and a typed code leaves
// only in the `pk-action` of Unlock (S13).

import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";

import { GLYPHS, button, plain, text, type RenderCtx } from "./render.js";

const shown = (c: RenderCtx, k: string): boolean => c.view.copy.includes(k);

/** The note under the field and the code: nothing asks for it (T23). */
function noAsk(c: RenderCtx): TemplateResult | typeof nothing {
  return shown(c, "recoveryCode.noAsk")
    ? html`<p class="body note" data-key="recoveryCode.noAsk">
        ${text(c, "recoveryCode.noAsk")}
      </p>`
    : nothing;
}

/** The screen's controls: the primary first, the rest after; a destructive confirm is danger. */
function row(c: RenderCtx, keys: string[]): TemplateResult | typeof nothing {
  const present = keys.filter((k) => shown(c, k));
  if (!present.length) return nothing;
  const primary = c.view.decisions.primary;
  const sorted = [...present].sort(
    (a, b) => Number(b === primary) - Number(a === primary),
  );
  return html`<div
    class="actions"
    part="actions"
    data-part="actions"
    data-layout="stack"
  >
    ${sorted.map((k) =>
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
  </div>`;
}

/** The recovery code the person types: a field, never a copy of the code shown anywhere. Editing
 *  clears "That code isn't right" (the element's input leaves `invalid`). */
function codeField(c: RenderCtx): TemplateResult {
  const invalid = shown(c, "unlockSync.invalid");
  const edited = () => c.edit("recoveryEdited", true);
  return html`<div class="field" part="key-field" data-part="key-field">
    <label class="label" for="pk-recovery"
      >${text(c, "unlockSync.field")}</label
    >
    <div class="field-row field-paste">
      <input
        id="pk-recovery"
        data-key="unlockSync.field"
        data-mono
        type="text"
        inputmode="text"
        autocomplete="off"
        autocapitalize="characters"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="go"
        aria-invalid=${invalid ? "true" : "false"}
        aria-describedby=${ifDefined(invalid ? "pk-recovery-error" : undefined)}
        @input=${edited}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") c.act("unlockSync.unlock");
        }}
      />
      ${c.copy.has("common.paste")
        ? html`<button
            type="button"
            class="btn paste"
            part="link"
            data-part="link"
            data-variant="link"
            data-key="common.paste"
            aria-label=${plain(c, "common.paste")}
            title=${plain(c, "common.paste")}
            @click=${(e: Event) => {
              const input = (e.currentTarget as HTMLElement)
                .closest(".field")
                ?.querySelector<HTMLInputElement>("input");
              // The text goes straight into the field: nothing keeps or sends it (S13).
              void navigator.clipboard
                ?.readText()
                .then((t) => {
                  if (input) input.value = t.trim();
                  edited();
                })
                .catch(() => {
                  // A refused read leaves the field to type or paste into.
                });
            }}
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

/** The code as eight groups of four, for the eye; read out whole, group by group.
 *  TODO(U-42.2, Swift fix round): the label becomes the catalog's `a11y.recoveryCode`
 *  ("Recovery code {code}") once that key is on this branch. */
function codeBlock(c: RenderCtx, code: string): TemplateResult {
  const groups = code.trim().split(/\s+/).filter(Boolean);
  return html`<div class="field" part="code" data-part="code">
    <div
      class="recovery-groups"
      data-key="recoveryCode.title"
      role="text"
      aria-label=${groups.join(", ")}
    >
      ${groups.map((g) => html`<span class="g" aria-hidden="true">${g}</span>`)}
    </div>
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
        void navigator.clipboard?.writeText(groups.join(" "))?.catch(() => {
          // A refused write leaves the code on screen to copy by hand.
        });
        c.act("recoveryCode.copy");
      }}
    >
      ${GLYPHS.copy()}${text(c, "recoveryCode.copy")}
    </button>
  </div>`;
}

/** UnlockSync, RecoveryCode and RingChange draw their fields and actions here.
 *  TODO(U-42.2, Swift fix round): RingChange gets a `failed` state (ui-matrix row) beside `confirm`. `code` is the
 *  recovery code the host handed the RecoveryCode element (`c.code`; it is in no input). */
export function syncContent(c: RenderCtx): TemplateResult | typeof nothing {
  const { view } = c;
  const code = c.code ?? "";
  if (view.component === "UnlockSync")
    switch (view.state) {
      case "code":
      case "invalid":
        return html`${codeField(c)}${noAsk(c)}${row(c, [
          "unlockSync.unlock",
          "unlockSync.startOver",
          "common.cancel",
        ])}`;
      case "failed":
        return row(c, ["common.tryAgain", "common.cancel"]);
      case "start-over":
        return row(c, ["unlockSync.startOverConfirm", "common.cancel"]);
      default:
        return nothing;
    }
  if (view.component === "RecoveryCode")
    return html`${codeBlock(c, code)}${noAsk(c)}
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
  if (view.component === "RingChange")
    return row(c, ["ringChange.useCode", "ringChange.accept", "common.cancel"]);
  return nothing;
}
