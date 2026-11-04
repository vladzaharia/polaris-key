// The inter-account screens' own content (CC-19.L): LinkPairing's code, the line that says which
// device reported it, the categories and the wait; TransferOffer's file row and its bar. The React
// twin is sdk-react/src/kit/connect.tsx: the same DOM, so one set of rules (connectStyles.ts)
// draws both.
//
// Rules the DOM keeps: the code stays through `confirm` (the other person may still be comparing
// against this screen); the categories come before Codes match, in reading order too; the actions
// sit in a wrapper that is not the card's child, so the kit's docked bar never applies and nothing
// precedes what would be shared; one live region persists across the pairing's states, so the wait
// is announced where it changes; a label the other device sent is isolated text.

import { html, nothing, type TemplateResult } from "lit";
import { categoryFallback, formatBytes, shortName } from "@polaris-key/ui-core";

import { actions, plain, progressBar, text, type RenderCtx } from "./render.js";
import { spellOut } from "./spell.js";

type Out = TemplateResult | typeof nothing;
const shown = (c: RenderCtx, k: string): boolean => c.view.copy.includes(k);

/** The code as served, spelled out for a screen reader, and the line that says which device
 *  reported it. Kept on screen through `confirm`. */
function codeBlock(c: RenderCtx): Out {
  if (!c.input.linkPairing?.code) return nothing;
  const code = c.input.linkPairing.code;
  return html`<span
    class="pair-code"
    part="code"
    data-part="code"
    role="img"
    data-key="a11y.linkCode"
    aria-label=${shown(c, "a11y.linkCode")
      ? plain(c, "a11y.linkCode", { code: spellOut(code) })
      : spellOut(code)}
    >${code}</span
  >`;
}

/** The line that says which device reported the code: the end pane's first line. */
function reportedLine(c: RenderCtx): Out {
  if (!c.input.linkPairing?.code) return nothing;
  const reported = shown(c, "linkPairing.reported")
    ? "linkPairing.reported"
    : "linkPairing.reportedUnnamed";
  return html`<p class="pair-reported" data-key=${reported}>
    ${text(c, reported)}
  </p>`;
}

/** What would be shared: the categories as chips, or the line that says nothing is shared yet. */
function shares(c: RenderCtx): Out {
  const head = shown(c, "linkPairing.shares")
    ? "linkPairing.shares"
    : shown(c, "linkPairing.sharesNone")
      ? "linkPairing.sharesNone"
      : null;
  if (!head) return nothing;
  const labels = c.categoryLabels ?? {};
  return html`<div class="pair-shares" part="shares" data-part="shares">
    ${head === "linkPairing.shares"
      ? html`<span class="label" id="pk-shares" data-key=${head}
            >${text(c, head)}</span
          >
          <ul class="pair-cats" aria-labelledby="pk-shares">
            ${(c.input.linkPairing?.categories ?? []).map(
              (id) =>
                html`<li data-key=${`category.${id}`}>
                  <bdi>${labels[id] ?? categoryFallback(id)}</bdi>
                </li>`,
            )}
          </ul>`
      : html`<p class="body" data-key=${head}>${text(c, head)}</p>`}
  </div>`;
}

/** The one live region of the pairing window. It is the same node in every state, so the search is
 *  announced where it appears. After Codes match the title says the wait (focus lands on it), so the
 *  visible words beside the dot are not read a second time. The template has no whitespace around its
 *  parts: an idle region is `:empty`, and the kit's rhythm leaves it out. */
// prettier-ignore
function wait(c: RenderCtx): Out {
  const state = c.view.state;
  if (!["open", "code", "confirm"].includes(state)) return nothing;
  const dot = html`<span class="pair-dot" aria-hidden="true"></span>`;
  const searching = html`${dot}<span data-key="linkPairing.searching">${text(c, "linkPairing.searching")}</span>`;
  const waiting = html`${dot}<span aria-hidden="true">${text(c, "linkPairing.waiting")}</span>`;
  return html`<p class="pair-wait" role="status" data-part="wait">${state === "open" ? searching : state === "confirm" ? waiting : nothing}</p>`;
}

/** LinkPairing: in the DOM order the person reads and acts in. */
function pairing(c: RenderCtx): Out {
  const state = c.view.state;
  const keys: Record<string, string[]> = {
    open: ["common.cancel"],
    code: ["linkPairing.confirm", "linkPairing.decline"],
    confirm: ["common.cancel"],
    linked: ["common.done"],
    failed: ["common.tryAgain", "common.done"],
    unavailable: ["common.done"],
  };
  return html`${codeBlock(c)}
    <div class="pair-end" data-part="pair-end">
      ${reportedLine(c)}${shares(c)}${wait(c)}${state === "unavailable" &&
      shown(c, "core.codes.connect_links_disabled.message")
        ? html`<p
            class="body"
            data-key="core.codes.connect_links_disabled.message"
          >
            ${text(c, "core.codes.connect_links_disabled.message")}
          </p>`
        : nothing}
      <div class="pair-actions" data-part="pair-actions">
        ${actions(
          c,
          (keys[state] ?? []).filter((k) => shown(c, k)),
        )}
      </div>
    </div>`;
}

/** TransferOffer: the offered file on its own row, apart from the heading: its name with the middle
 *  elided so the extension stays, then its size and type when the contact said; a bar while it
 *  arrives. */
function offer(c: RenderCtx): Out {
  const t = c.input.transferOffer;
  const name = t?.name ?? "";
  if (c.view.state === "ask" && name !== "") {
    const facts = [
      t?.size !== undefined ? formatBytes(t.size, c.copy.locale) : "",
      t?.type ?? "",
    ].filter(Boolean);
    return html`<div class="pair-offer" part="file" data-part="file">
      <p class="pair-file" title=${name}><bdi>${shortName(name, 48)}</bdi></p>
      ${facts.length
        ? html`<p class="meta pair-meta" data-part="file-meta">
            <bdi>${facts.join(" · ")}</bdi>
          </p>`
        : nothing}
    </div>`;
  }
  if (c.view.state === "receiving") return progressBar(c, undefined);
  return nothing;
}

/** True for the two inter-account screens. */
export const isConnect = (component: string): boolean =>
  component === "LinkPairing" || component === "TransferOffer";

/** The content of LinkPairing and TransferOffer, under the title and the body text. */
export function connectContent(c: RenderCtx): Out {
  return (c.view.component as string) === "LinkPairing" ? pairing(c) : offer(c);
}
