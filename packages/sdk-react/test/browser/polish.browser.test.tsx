// @pkey-feature ui.kit ui.signin ui.activate
//
// UK-04/UK-05 polish in the React kit, in real Chromium: the sign-in sheet and the key step at large
// text. The same scenes run on the elements (packages/elements/test/browser/polish.browser.test.ts),
// so a divergence between the two kits shows as a failure on one side only.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/polish.<scene>/<size>-<scheme>.png.

import { useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import type { UiInput } from "@polaris-key/ui-core";

import * as Kit from "@polaris-key/react/kit";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;

type Obj = Record<string, unknown>;
type Row = { name: string; input: Obj };
const m = matrixJson as unknown as Record<string, Row[]> & {
  vocabulary: { defaults: Obj };
};
const rowOf = (name: string): Row => {
  for (const k of Object.keys(m))
    if (Array.isArray(m[k])) {
      const r = (m[k] as Row[]).find((x) => x.name === name);
      if (r) return r;
    }
  throw new Error(`no row ${name}`);
};
function inputOf(name: string, patch: Partial<UiInput> = {}): UiInput {
  const base: Obj = { ...rowOf(name).input };
  for (const [k, v] of Object.entries(m.vocabulary.defaults)) {
    if (k === "capabilities")
      base[k] = { ...(v as Obj), ...((base[k] as Obj) ?? {}) };
    else if (!(k in base)) base[k] = v;
  }
  return { elapsedMs: 60_000, ...base, ...patch } as UiInput;
}

beforeAll(async () => {
  // The QR encoder and the settings, device and account rows load on demand.
  await Kit.preloadKitParts();
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../../../brand/fonts/fonts.css", import.meta.url).href;
  document.head.append(link);
  await new Promise<void>((resolve) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.documentElement.style.fontSize = "";
});

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));
const THEME = {
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
  colorScheme: "dark" as const,
};

async function draw(
  node: ReactNode,
  w: number,
  h: number,
  scale: number,
): Promise<HTMLElement> {
  document.documentElement.style.fontSize = `${scale * 100}%`;
  await page.viewport(w, h);
  document.body.style.margin = "0";
  document.body.style.background = "#060912";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(node);
  for (let i = 0; i < 100 && !host.querySelector(".pk-root"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await document.fonts.ready;
  for (let i = 0; i < 4; i++) await frame();
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  await frame();
  return host;
}

function Sheet(props: {
  input: UiInput;
  onClosed?: () => void;
  scheme?: "dark" | "light";
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <Kit.SignIn
      input={props.input}
      presentation="sheet"
      open={open}
      theme={{ ...THEME, colorScheme: props.scheme ?? "dark" }}
      onClose={() => {
        setOpen(false);
        props.onClosed?.();
      }}
    />
  );
}

const sheet = (input: UiInput, w: number, h: number, scale: number) =>
  draw(<Sheet input={input} />, w, h, scale);

async function shot(id: string, label: string): Promise<void> {
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(`${__PKEY_KIT_SHOTS__}/polish.${id}/${label}.png`);
}
const q = <T extends Element = HTMLElement>(el: Element, s: string) =>
  el.querySelector<T>(s);
const qa = <T extends Element = HTMLElement>(el: Element, s: string) => [
  ...el.querySelectorAll<T>(s),
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
      await frame();
      await shot("choose-mixed", `${w}-200-dark`);
      const lr = q(el, '[data-part="license-list"]')!.getBoundingClientRect();
      for (const row of qa(el, '[data-part="license-row"]'))
        for (const n of row.querySelectorAll<HTMLElement>("*")) {
          expect(n.getBoundingClientRect().right).toBeLessThanOrEqual(
            lr.right + 1,
          );
          if (n.children.length === 0 && n.textContent)
            expect(n.scrollWidth, n.textContent).toBeLessThanOrEqual(
              n.clientWidth + 1,
            );
        }
      const close = q(el, '[data-part="close"]')!.getBoundingClientRect();
      const name = q(el, ".identity .name");
      if (name) expect(hit(close, name.getBoundingClientRect())).toBe(false);
    });

    it(`${w}: the full row of a mixed list carries its own Replace`, async () => {
      const el = await sheet(
        inputOf("SignIn/choose: desktop (sheet)"),
        w,
        h,
        2,
      );
      const full = qa(el, '[data-part="license-row"]').filter(
        (r) => r.getAttribute("role") === "group",
      );
      expect(full).toHaveLength(1);
      expect(q(full[0]!, '[data-key="signin.replace.open"]')).not.toBeNull();
    });

    it(`${w}: all-full rows keep their Replace and do not clip`, async () => {
      const el = await sheet(
        inputOf("LicenseChoice/all-full (sheet)"),
        w,
        h,
        2,
      );
      q(el, '[data-part="license-list"]')?.scrollIntoView({ block: "center" });
      await frame();
      await shot("choose-allfull", `${w}-200-dark`);
      const lr = q(el, '[data-part="license-list"]')!.getBoundingClientRect();
      for (const n of qa(el, '[data-part="license-row"] *'))
        expect(n.getBoundingClientRect().right).toBeLessThanOrEqual(
          lr.right + 1,
        );
    });

    it(`${w}: 12 devices scroll without rows overlapping`, async () => {
      const el = await sheet(devices12(), w, h, 2);
      q(el, '[data-part="device-list"]')?.scrollIntoView({ block: "center" });
      await frame();
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

    it(`${w}: the sheet's bar scrolls with the text`, async () => {
      const el = await sheet(
        inputOf("SignIn/choose: desktop (sheet)"),
        w,
        h,
        2,
      );
      const bar = q(el, '.card > [data-part="actions"]')!;
      expect(getComputedStyle(bar).position).toBe("static");
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
    expect(btns[1]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      btns[0]!.getBoundingClientRect().bottom - 1,
    );
  });
});

describe("a short window at large text: the key step", () => {
  const activate = (scale: number) =>
    draw(
      <Kit.Activate input={inputOf("Activate/parsed")} fill theme={THEME} />,
      844,
      390,
      scale,
    );
  it("844 x 390 at 200%: the bar undocks", async () => {
    const el = await activate(2);
    await shot("activate", "844x390-200-dark");
    expect(q(el, ".pk-root")!.hasAttribute("data-tight")).toBe(true);
    expect(
      getComputedStyle(q(el, '.card > [data-part="actions"]')!).position,
    ).toBe("static");
  });
  it("844 x 390 at 100% docks the bar in one row", async () => {
    const el = await activate(1);
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
      let closed = 0;
      const el = await draw(
        <Sheet input={done(named)} onClosed={() => closed++} />,
        1440,
        900,
        1,
      );
      for (let i = 0; i < 5; i++) await frame();
      expect(closed).toBe(1);
      expect(q<HTMLDialogElement>(el, "dialog")!.open).toBe(false);
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
    const el = await draw(
      <Kit.Activate
        input={inputOf("Activate/rejected: not a key")}
        theme={THEME}
      />,
      390,
      844,
      1,
    );
    const input = q<HTMLInputElement>(el, "input")!;
    input.focus();
    await frame();
    await shot("refused", "390-dark");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(getComputedStyle(input).boxShadow).not.toBe("none");
  });

  it("the update prompt's header lines up with its title", async () => {
    const el = await draw(
      <Kit.UpdatePrompt
        input={inputOf("UpdatePrompt/available", {
          platform: { os: "web", formFactor: "computer" },
        } as Partial<UiInput>)}
        theme={THEME}
      />,
      390,
      844,
      1,
    );
    await shot("update", "390-dark");
    const icon = q(el, ".identity .icon, .identity .monogram, .identity img")!;
    expect(
      Math.abs(
        icon.getBoundingClientRect().left -
          q(el, "h1")!.getBoundingClientRect().left,
      ),
    ).toBeLessThan(2);
  });
});

describe("the same scenes in the light scheme (shots only)", () => {
  for (const [w, h, scale] of [
    [390, 844, 2],
    [360, 740, 2],
    [1440, 900, 1],
  ] as const)
    it(`sheet at ${w} x ${h}, ${scale * 100}%`, async () => {
      const el = await draw(
        <Sheet
          input={inputOf("SignIn/choose: desktop (sheet)")}
          scheme="light"
        />,
        w,
        h,
        scale,
      );
      document.body.style.background = "#f6f8ff";
      q(el, '[data-part="license-list"]')?.scrollIntoView({ block: "center" });
      await frame();
      await shot("light-choose-mixed", `${w}-${scale * 100}-light`);
      expect(q(el, '[data-part="license-list"]')).not.toBeNull();
    });
});

describe("the product monogram is centred in its tile", () => {
  // A tile with no icon draws its initial. The initial's glyph box sits on the tile's centre within
  // 1 px, at both widths, on the sign-in sheet's header.
  const centred = (el: HTMLElement): void => {
    const tiles = qa(el, '[data-part="monogram"]').filter(
      (t) => t.getBoundingClientRect().width > 0,
    );
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      const box = tile.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(tile);
      const text = range.getBoundingClientRect();
      expect(text.width).toBeGreaterThan(0);
      expect(
        Math.abs(text.left + text.width / 2 - (box.left + box.width / 2)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(text.top + text.height / 2 - (box.top + box.height / 2)),
      ).toBeLessThanOrEqual(1);
    }
  };
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ] as const)
    for (const scheme of ["dark", "light"] as const)
      it(`link offer sheet at ${w} x ${h}, ${scheme}`, async () => {
        const el = await draw(
          <Sheet
            input={inputOf(
              "SignIn/link-offer: Google shared across apps (sheet)",
            )}
            scheme={scheme}
          />,
          w,
          h,
          1,
        );
        await shot("monogram", `${w}-${scheme}`);
        centred(el);
      });
});
