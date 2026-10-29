// The two screens activation without an account adds (UK-42.7): ActivateDone's recommendation card
// and AddToAccount's name and email. Their own module, as the Cloud Sync screens' is: the React
// twin (UK-42.9) draws the same DOM, so one stylesheet (holderStyles.ts) draws both. The model
// (ui-core holders.ts) says which keys show; this draws them. Name and email are read from the
// fields when a control is pressed and leave only in that `pk-action`: no input, view or event
// before it holds them.

import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";

import { button, text, GLYPHS, type RenderCtx } from "./render.js";

type Out = TemplateResult | typeof nothing;
const shown = (c: RenderCtx, k: string): boolean => c.view.copy.includes(k);

/** The icon of each reason line: lucide's, drawn like the kit's other glyphs. */
const REASON_GLYPH: Readonly<Record<string, () => TemplateResult>> = {
  "activate.recommend.sync": GLYPHS.refresh,
  "activate.recommend.recover": GLYPHS.keyRound,
  "activate.recommend.devices": GLYPHS.monitorSmartphone,
  "activate.recommend.portal": () => GLYPHS.check("holder-glyph"),
};

/** The recommendation: a quiet card, its reasons (only the product's), and the one action that
 *  opens AddToAccount. Never filled: Start using is the screen's primary. */
function recommendation(c: RenderCtx): Out {
  if (!shown(c, "activate.recommend.title")) return nothing;
  const reasons = Object.keys(REASON_GLYPH).filter((k) => shown(c, k));
  return html`<section
      class="holder-card"
      part="recommend"
      data-part="recommend"
      aria-labelledby="pk-recommend"
    >
      <div class="holder-head">
        <h2
          id="pk-recommend"
          class="title"
          data-size="section"
          data-key="activate.recommend.title"
        >
          ${text(c, "activate.recommend.title")}
        </h2>
        ${shown(c, "activate.recommend.badge")
          ? html`<span
              class="holder-badge"
              part="badge"
              data-part="badge"
              data-key="activate.recommend.badge"
              >${text(c, "activate.recommend.badge")}</span
            >`
          : nothing}
      </div>
      <ul class="holder-reasons pk-stagger" role="list">
        ${reasons.map(
          (k) =>
            html`<li data-key=${k}>
              <span class="holder-icon" aria-hidden="true"
                >${REASON_GLYPH[k]!()}</span
              ><span>${text(c, k)}</span>
            </li>`,
        )}
      </ul>
      ${shown(c, "activate.recommend.action")
        ? button(c, "activate.recommend.action", "secondary")
        : nothing}
    </section>
    ${shown(c, "activate.recommend.skip")
      ? html`<p class="body holder-skip" data-key="activate.recommend.skip">
          ${text(c, "activate.recommend.skip")}
        </p>`
      : nothing}`;
}

/** One field: its label, the input, the hint or the refusal under it. */
function field(
  c: RenderCtx,
  id: "name" | "email",
  o: { bad: boolean; locked: boolean; submit: () => void },
): TemplateResult {
  const label = id === "name" ? "signin.gate.name" : "signin.email.label";
  const error =
    id === "name" ? "signin.gate.nameRequired" : "signin.email.invalid";
  const note = id === "email" ? "activate.attach.fine" : null;
  const refused = o.bad && shown(c, error);
  const described = [refused ? `pk-${id}-error` : null, note ? "pk-fine" : null]
    .filter(Boolean)
    .join(" ");
  return html`<div class="field" part="field" data-part="field">
    <label class="label" for=${`pk-${id}`}>${text(c, label)}</label>
    <input
      id=${`pk-${id}`}
      data-key=${label}
      type=${id === "email" ? "email" : "text"}
      name=${id}
      autocomplete=${id === "email" ? "email" : "name"}
      inputmode=${ifDefined(id === "email" ? "email" : undefined)}
      autocapitalize=${id === "email" ? "off" : "words"}
      autocorrect="off"
      spellcheck="false"
      enterkeyhint=${id === "email" ? "go" : "next"}
      ?readonly=${o.locked}
      aria-invalid=${o.bad ? "true" : "false"}
      aria-describedby=${ifDefined(described || undefined)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" && id === "email" && !o.locked) o.submit();
      }}
    />
    ${refused
      ? html`<p
          id=${`pk-${id}-error`}
          class="message"
          data-tone="danger"
          data-key=${error}
          role="alert"
        >
          ${text(c, error)}
        </p>`
      : nothing}
    ${note && shown(c, note)
      ? html`<p id="pk-fine" class="meta" data-key=${note}>${text(c, note)}</p>`
      : nothing}
  </div>`;
}

/** Name and email, and the sentence under them. The control that sends them is the screen's own
 *  (docked with the others); the element reads the two fields when it is pressed, so the values
 *  leave only in that `pk-action` (element.ts, `act`). */
function form(c: RenderCtx): Out {
  const { state } = c.view;
  if (!["form", "invalid", "busy", "failed"].includes(state)) return nothing;
  const bad = state === "invalid" ? c.view.copy : [];
  const locked = state === "busy";
  const submit = () => c.act("common.continue");
  return html`<form
    class="holder-form"
    part="form"
    data-part="form"
    ?hidden=${state === "failed"}
    aria-busy=${ifDefined(locked ? "true" : undefined)}
    novalidate
    @submit=${(e: Event) => e.preventDefault()}
  >
    ${field(c, "name", {
      bad: bad.includes("signin.gate.nameRequired"),
      locked,
      submit,
    })}
    ${field(c, "email", {
      bad: bad.includes("signin.email.invalid"),
      locked,
      submit,
    })}
    ${shown(c, "activate.attach.lede")
      ? html`<p class="body" data-key="activate.attach.lede">
          ${text(c, "activate.attach.lede")}
        </p>`
      : nothing}
  </form>`;
}

/** True for the two holder screens (their views are not in `ComponentName`). */
export const isHolder = (component: string): boolean =>
  component === "ActivateDone" || component === "AddToAccount";

/** The content of ActivateDone and AddToAccount, under the title and the body text. */
export function holderContent(c: RenderCtx): Out {
  return (c.view.component as string) === "ActivateDone"
    ? recommendation(c)
    : form(c);
}
