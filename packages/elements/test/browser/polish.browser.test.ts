// @pkey-feature ui.signin ui.activate ui.update
//
// UK-04/UK-05 polish, in real Chromium: the sign-in sheet and the key step at large text. The same
// scenes run in the React kit (packages/sdk-react/test/browser/polish.browser.test.tsx), so a
// divergence between the two shows as a failure on one side only.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/polish.<scene>/<size>-<scheme>.png.

import { fixtureTheme } from "./support.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import type { UiInput } from "@polaris-key/ui-core";
import matrix from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };

import {
  PolarisKey,
  TAGS,
  type PkElement,
  type PkSignIn,
} from "../../src/index.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_FONTS__: string;

type Row = { name: string; input: Record<string, unknown> };
const m = matrix as unknown as Record<string, Row[]> & {
  vocabulary: { defaults: Record<string, unknown> };
};
const defaults = m.vocabulary.defaults;
const rowOf = (name: string): Row => {
  for (const k of Object.keys(m))
    if (Array.isArray(m[k])) {
      const r = (m[k] as Row[]).find((x) => x.name === name);
      if (r) return r;
    }
  throw new Error(`no row ${name}`);
};
function inputOf(name: string, patch: Partial<UiInput> = {}): UiInput {
  const base: Record<string, unknown> = { ...rowOf(name).input };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "capabilities")
      base[k] = { ...(v as object), ...((base[k] as object) ?? {}) };
    else if (!(k in base)) base[k] = v;
  }
  return { elapsedMs: 60_000, ...base, ...patch } as UiInput;
}

beforeAll(() => {
  fixtureTheme(__PKEY_FONTS__);
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.fontSize = "";
});

const frames = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function settle(el: PkElement): Promise<void> {
  await el.updateComplete;
  await document.fonts.ready;
  await frames();
  await el.updateComplete;
  await Promise.all(
    el
      .shadowRoot!.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
}

async function sheet(
  input: UiInput,
  w: number,
  h: number,
  scale: number,
  scheme: "dark" | "light" = "dark",
): Promise<PkSignIn> {
  document.documentElement.style.fontSize = `${scale * 100}%`;
  await page.viewport(w, h);
  document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
  const el = document.createElement("pk-sign-in") as PkSignIn;
  el.presentation = "sheet";
  el.colorScheme = scheme;
  el.input = input;
  document.body.replaceChildren(el);
  el.open = true;
  await settle(el);
  return el;
}

async function screen(
  component: string,
  input: UiInput,
  w: number,
  h: number,
  scale: number,
): Promise<PkElement> {
  document.documentElement.style.fontSize = `${scale * 100}%`;
  await page.viewport(w, h);
  document.body.style.background = "#060912";
  const el = document.createElement(
    TAGS[component as keyof typeof TAGS],
  ) as PkElement;
  el.colorScheme = "dark";
  el.input = input;
  el.style.minBlockSize = `${h}px`;
  el.style.display = "grid";
  document.body.replaceChildren(el);
  await settle(el);
  return el;
}

async function shot(id: string, label: string): Promise<void> {
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(`${__PKEY_KIT_SHOTS__}/polish.${id}/${label}.png`);
}

const q = <T extends Element = HTMLElement>(el: PkElement, s: string) =>
  el.shadowRoot!.querySelector<T>(s);
const qa = <T extends Element = HTMLElement>(el: PkElement, s: string) => [
  ...el.shadowRoot!.querySelectorAll<T>(s),
];
const hit = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const devices12 = (): UiInput => {
  const base = inputOf("SignIn/replace: the web confirms inline (sheet)");
  const rv = base.replaceView!;
  const devs = Array.from({ length: 12 }, (_, i) => ({
    ...rv.devices[i % 3]!,
    id: `dev_${i}`,
    label:
      i % 2
        ? "Harbor Audio mastering workstation in the second studio"
        : `Device ${i}`,
    leastRecent: i === 0,
  }));
  return { ...base, replaceView: { ...rv, devices: devs } };
};

describe("large text on a phone: the sheet", () => {
  for (const [w, h] of [
    [390, 844],
    [360, 740],
  ] as const) {
    it(`${w}: licence rows do not clip and the close button clears the name (mixed)`, async () => {
      const el = await sheet(
        inputOf("SignIn/choose: desktop (sheet)"),
        w,
        h,
        2,
      );
      q(el, '[data-part="license-list"]')?.scrollIntoView({ block: "center" });
      await frames();
      await shot("choose-mixed", `${w}-200-dark`);
      const list = q(el, '[data-part="license-list"]')!;
      const lr = list.getBoundingClientRect();
      for (const row of qa(el, '[data-part="license-row"]'))
        for (const n of row.querySelectorAll<HTMLElement>("*")) {
          const r = n.getBoundingClientRect();
          expect(r.right, n.className).toBeLessThanOrEqual(lr.right + 1);
          if (n.children.length === 0 && n.textContent)
            expect(n.scrollWidth, n.textContent).toBeLessThanOrEqual(
              n.clientWidth + 1,
            );
        }
      const close = q(el, '[data-part="close"]')!.getBoundingClientRect();
      const name = q(el, ".identity .name");
      if (name) expect(hit(close, name.getBoundingClientRect())).toBe(false);
    });

    it(`${w}: all-full rows keep their Replace and do not clip`, async () => {
      const el = await sheet(
        inputOf("LicenseChoice/all-full (sheet)"),
        w,
        h,
        2,
      );
      q(el, '[data-part="license-list"]')?.scrollIntoView({ block: "center" });
      await frames();
      await shot("choose-allfull", `${w}-200-dark`);
      const list = q(el, '[data-part="license-list"]')!;
      const lr = list.getBoundingClientRect();
      for (const n of qa(el, '[data-part="license-row"] *'))
        expect(n.getBoundingClientRect().right).toBeLessThanOrEqual(
          lr.right + 1,
        );
    });

    it(`${w}: 12 devices scroll without rows overlapping`, async () => {
      const el = await sheet(devices12(), w, h, 2);
      q(el, '[data-part="device-list"]')?.scrollIntoView({ block: "center" });
      await frames();
      await shot("replace-12", `${w}-200-dark`);
      const rows = qa(el, '[data-part="device-list"] .row');
      expect(rows.length).toBe(12);
      for (const r of rows)
        expect(r.getBoundingClientRect().height + 1).toBeGreaterThanOrEqual(
          r.scrollHeight,
        );
      for (const r of rows) {
        const rr = r.getBoundingClientRect();
        for (const n of r.querySelectorAll<HTMLElement>("*")) {
          const nr = n.getBoundingClientRect();
          if (nr.height === 0) continue;
          expect(
            nr.top + 1,
            n.textContent ?? n.className,
          ).toBeGreaterThanOrEqual(rr.top);
          expect(nr.bottom - 1).toBeLessThanOrEqual(rr.bottom);
        }
      }
      for (let i = 1; i < rows.length; i++)
        expect(rows[i]!.getBoundingClientRect().top + 1).toBeGreaterThanOrEqual(
          rows[i - 1]!.getBoundingClientRect().bottom,
        );
    });

    it(`${w}: the sheet's bar docks at its foot`, async () => {
      const el = await sheet(
        inputOf("SignIn/choose: desktop (sheet)"),
        w,
        h,
        2,
      );
      const bar = q(el, '.card > [data-part="actions"]')!;
      expect(getComputedStyle(bar).position).toBe("sticky");
    });
  }

  it("the replace step has no Replace opener", async () => {
    const el = await sheet(devices12(), 1440, 900, 1);
    await shot("replace-12", "1440-100-dark");
    expect(q(el, '[data-key="signin.replace.open"]')).toBeNull();
    expect(q(el, '[data-key="signin.replace.openSystem"]')).toBeNull();
  });

  it("desktop at 200% keeps the product name and stacks the buttons", async () => {
    const el = await sheet(
      inputOf("SignIn/choose: desktop (sheet)"),
      1440,
      900,
      2,
    );
    await shot("choose-mixed", "1440-200-dark");
    const name = q(el, ".identity .name");
    expect(name).not.toBeNull();
    expect(getComputedStyle(name!).display).not.toBe("none");
    const btns = qa(el, '.card > [data-part="actions"] .btn');
    expect(btns.length).toBeGreaterThan(1);
    expect(
      btns[1]!.getBoundingClientRect().top,
      "buttons stack",
    ).toBeGreaterThanOrEqual(btns[0]!.getBoundingClientRect().bottom - 1);
  });
});

describe("a short window at large text: the key step", () => {
  it("844 x 390 at 200%: the bar stays docked, so the primary is in view", async () => {
    const el = await screen(
      "Activate",
      inputOf("Activate/parsed"),
      844,
      390,
      2,
    );
    await shot("activate", "844x390-200-dark");
    const root = q(el, ".pk-root")!;
    expect(root.hasAttribute("data-tight")).toBe(true);
    const bar = q(el, '.card > [data-part="actions"]')!;
    expect(getComputedStyle(bar).position).toBe("sticky");
  });

  it("844 x 390 at 100% docks the bar in one row", async () => {
    const el = await screen(
      "Activate",
      inputOf("Activate/parsed"),
      844,
      390,
      1,
    );
    await shot("activate", "844x390-100-dark");
    const bar = q(el, '.card > [data-part="actions"]')!;
    expect(getComputedStyle(bar).position).toBe("sticky");
    expect(bar.getBoundingClientRect().height).toBeLessThan(390 * 0.4);
  });
});

describe("the sheet leaves a toast after an existing license", () => {
  const done = (named: boolean) =>
    inputOf(
      "SignIn/done: inline, an existing license opens the app with the toast (sheet)",
      {
        account: named
          ? { signedIn: true, holder: "Mara", tier: "Pro" }
          : { signedIn: true, tier: "Pro" },
      } as Partial<UiInput>,
    );

  for (const named of [true, false])
    it(`${named ? "named" : "nameless"}: the sheet closes and a toast says so`, async () => {
      const el = await sheet(done(named), 1440, 900, 1);
      await settle(el);
      await new Promise((r) => setTimeout(r, 50));
      await settle(el);
      expect(el.open).toBe(false);
      const toast = q(el, '[data-part="toast"]');
      expect(toast).not.toBeNull();
      expect(toast!.textContent).toContain(named ? "Mara" : "signed in");
      await shot(`toast-${named ? "named" : "nameless"}`, "1440-100-dark");
      const r = toast!.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.bottom).toBeLessThanOrEqual(900);
    });
});

describe("minor polish", () => {
  it("a refused key keeps its danger stroke under the focus ring", async () => {
    const el = await screen(
      "Activate",
      inputOf("Activate/rejected: not a key"),
      390,
      844,
      1,
    );
    const input = q<HTMLInputElement>(el, "input")!;
    input.focus();
    await frames();
    await shot("refused", "390-dark");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const cs = getComputedStyle(input);
    expect(cs.boxShadow).not.toBe("none");
  });

  it("the update prompt's header lines up with its title; Download has the glyph", async () => {
    const el = await screen(
      "UpdatePrompt",
      inputOf("UpdatePrompt/available", {
        platform: { os: "web", formFactor: "computer" },
      } as Partial<UiInput>),
      390,
      844,
      1,
    );
    await shot("update", "390-dark");
    const id = q(el, ".identity")!;
    const h1 = q(el, "h1")!;
    const icon = id.querySelector(".icon, .monogram, img")!;
    expect(
      Math.abs(
        icon.getBoundingClientRect().left - h1.getBoundingClientRect().left,
      ),
    ).toBeLessThan(2);
    expect(
      q(
        el,
        '[data-key="update.install"] .glyph, [data-key="update.install"] svg',
      ),
    ).not.toBeNull();
  });
});

describe("the same scenes in the light scheme (shots only)", () => {
  for (const [w, h, scale] of [
    [390, 844, 2],
    [360, 740, 2],
    [1440, 900, 1],
  ] as const)
    it(`sheet at ${w} x ${h}, ${scale * 100}%`, async () => {
      const el = await sheet(
        inputOf("SignIn/choose: desktop (sheet)"),
        w,
        h,
        scale,
        "light",
      );
      q(el, '[data-part="license-list"]')?.scrollIntoView({ block: "center" });
      await frames();
      await shot("light-choose-mixed", `${w}-${scale * 100}-light`);
      expect(q(el, '[data-part="license-list"]')).not.toBeNull();
    });
});
