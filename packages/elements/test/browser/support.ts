// What the elements' browser suites share: the fixture product's icon, axe, and a corpus row.

import axe from "axe-core";
import type { UiInput } from "@polaris-key/ui-core";
import { PolarisKey } from "../../src/index.js";
import matrix from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };

type Obj = Record<string, unknown>;
type Row = { name: string; input: Obj };
const m = matrix as unknown as Record<string, Row[]> & {
  vocabulary: { defaults: Obj };
};

/** The input of a corpus row (of one family, else the first family that has it), with its
 *  defaults and a patch over them. */
export function inputRow(
  name: string,
  patch: Obj = {},
  family?: string,
): UiInput {
  const r = (
    family
      ? (m[family] ?? [])
      : Object.values(m)
          .filter((v): v is Row[] => Array.isArray(v))
          .flat()
  ).find((x) => x.name === name);
  if (!r) throw new Error(`no ui-matrix row ${name}`);
  const out: Obj = { ...r.input };
  for (const [k, v] of Object.entries(m.vocabulary.defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((out[k] as Obj) ?? {}) };
    else if (!(k in out)) out[k] = v;
  }
  return { elapsedMs: 60_000, ...out, ...patch } as UiInput;
}

/** The fixture product's icon (the waves of Tidewater Studio), as an image the page can load. */
export const ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#0f3b45"/><circle cx="66" cy="28" r="9" fill="#f7c873"/><path d="M8 58q10-10 20 0t20 0 20 0 20 0" stroke="#5be0c8" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M8 74q10-10 20 0t20 0 20 0 20 0" stroke="#7fb8b0" stroke-width="7" fill="none" stroke-linecap="round"/></svg>`,
)}`;

/** axe's WCAG 2.x A and AA findings under `el`, as one line each. */
export async function axeViolations(
  el: Element,
  skip: string[] = [],
): Promise<string[]> {
  const result = await axe.run(el as unknown as axe.ElementContext, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
    },
    rules: Object.fromEntries(skip.map((r) => [r, { enabled: false }])),
  });
  return result.violations.flatMap((v) =>
    v.nodes.map(
      (n) => `${v.id}: ${n.target.join(" ")} ${n.failureSummary ?? ""}`,
    ),
  );
}

/** The page the suites draw on: the brand fonts and the fixture product (Tidewater Studio, teal,
 *  by Harbor Audio). */
/** The `holders` family's rows this kit draws: the two screens, the sign-in form's own steps and
 *  the settings row (UK-42.8). */
export const isHolderScreen = (r: { expect: { component: string } }): boolean =>
  ["ActivateDone", "AddToAccount", "SignIn", "AccountAndLicense"].includes(
    r.expect.component,
  );

export function fixtureTheme(fonts: string): void {
  PolarisKey.fonts(fonts);
  PolarisKey.theme({
    product: {
      name: "Tidewater Studio",
      developer: "Harbor Audio",
      accent: "#369186",
    },
    iconSrc: ICON,
  });
  document.body.style.margin = "0";
}

/** The two rows the flows run at (UI-KITS §7.1): a phone and a desktop window. */
export const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "1440", width: 1440, height: 900 },
] as const;
export const SCHEMES = ["dark", "light"] as const;

/** Let an element (and the sign-in form it may draw) finish drawing and animating: `until` ends
 *  the wait early once it holds, after a few frames. */
export async function settle(
  el: HTMLElement & { updateComplete: Promise<unknown> },
  until: () => boolean = () => true,
): Promise<void> {
  for (let i = 0; i < 60 && (i < 3 || !until()); i++) {
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;
  }
  await document.fonts.ready;
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  const root = el.shadowRoot;
  const nested = root?.querySelector<HTMLElement>("pk-sign-in");
  const running = [
    ...document.getAnimations(),
    ...(root?.getAnimations() ?? []),
    ...(nested?.shadowRoot?.getAnimations() ?? []),
  ].filter((a) => a.effect?.getTiming().iterations !== Infinity);
  await Promise.allSettled(running.map((a) => a.finished));
}
