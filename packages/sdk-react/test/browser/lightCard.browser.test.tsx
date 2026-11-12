// @pkey-feature connect.local
//
// The Light Card on the Pair with a Code show step, in real Chromium (UK-67.1): the ready frame is
// a real QR code and decodes; Reduce Motion (the OS setting or the kit's own `motion`) draws the
// finished card once, with no frame loop; after 10 s of waiting the paint rate drops to 30 fps;
// nothing paints while the page is hidden. The run's clock is injected (the renderer's test seam),
// so none of it waits on real time.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { commands, page } from "vitest/browser";
import jsQRModule from "jsqr";

// The package is UMD: under the bundler its default export is the function itself.
const jsQR = jsQRModule as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

import { encodeQr } from "@polaris-key/elements/contract";
import * as Kit from "@polaris-key/react/kit";
import type { UiInput } from "@polaris-key/ui-core";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMotion: (motion: "reduce" | null) => Promise<void>;
  }
}

const PAYLOAD = "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y";
const matrix = matrixJson as unknown as {
  vocabulary: { defaults: Record<string, unknown> };
};
const inputFor = (qr: string): UiInput =>
  ({
    ...matrix.vocabulary.defaults,
    localPairing: {
      step: "show",
      code: "4812 3456",
      qr,
      view: "qr",
      secondsLeft: 291,
    },
  }) as unknown as UiInput;
const input = inputFor(PAYLOAD);
const expiredInput = (): UiInput =>
  ({
    ...inputFor(PAYLOAD),
    localPairing: {
      step: "show",
      code: "4812 3456",
      qr: PAYLOAD,
      view: "qr",
      secondsLeft: 0,
      expired: true,
    },
  }) as unknown as UiInput;

const SEAM = Symbol.for("polaris-key.lightCard.seam");
interface Paint {
  rate: number;
  now: number;
  phase: string;
  tint: string;
  mark: boolean;
}
const clock = { t: 0 };
let paints: Paint[] = [];
function useClock(): void {
  paints = [];
  (globalThis as Record<symbol, unknown>)[SEAM] = {
    clock: () => clock.t,
    seed: 7,
    onPaint: (p: Paint) => paints.push(p),
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[SEAM];
  await commands.emulateMotion(null);
  setVisibility(null);
  root?.unmount();
  host?.remove();
  root = host = null;
});
beforeAll(async () => {
  await Kit.preloadKitParts();
});

const frame = (): Promise<void> =>
  new Promise((done) => requestAnimationFrame(() => done()));
const frames = async (n: number, each?: () => void): Promise<void> => {
  for (let i = 0; i < n; i++) {
    each?.();
    await frame();
  }
};

function setVisibility(state: "hidden" | null): void {
  if (state)
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
  else delete (document as unknown as Record<string, unknown>).visibilityState;
  document.dispatchEvent(new Event("visibilitychange"));
}

async function mount(
  theme: Record<string, unknown> = { colorScheme: "dark" },
  qr: string = PAYLOAD,
): Promise<HTMLCanvasElement> {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  root.render(<Kit.LocalPairing input={inputFor(qr)} fill theme={theme} />);
  let canvas: HTMLCanvasElement | null = null;
  for (let i = 0; i < 400 && !canvas; i++) {
    await frame();
    canvas = host.querySelector("figure[data-lightcard] canvas");
  }
  expect(canvas, "the Light Card canvas").not.toBeNull();
  // The run starts in the canvas's effect: let it take its first reading of the clock.
  await frames(3);
  return canvas!;
}

/** What a camera framing the card reads: the stage's middle, the card and its margin, not the
 *  light orbiting at the stage's edge (a decoder may take a streak for a finder). */
function decode(canvas: HTMLCanvasElement, inset = 0.18): string | null {
  const ctx = canvas.getContext("2d")!;
  const margin = Math.round(canvas.width * inset);
  const side = canvas.width - 2 * margin;
  const img = ctx.getImageData(margin, margin, side, side);
  return jsQR(img.data, img.width, img.height)?.data ?? null;
}

/** The card's side in screen pixels: its share of the stage, from the stage's own width. */
const cardPx = (canvas: HTMLCanvasElement, share: number): number =>
  canvas.clientWidth * share;

describe("Light Card", () => {
  it("draws a ready frame that decodes, under the plain QR's accessible name", async () => {
    useClock();
    clock.t = 0;
    const canvas = await mount();
    expect(canvas.getAttribute("role")).toBe("img");
    expect(canvas.getAttribute("aria-label")).toBeTruthy();
    // The card forms in 2.4 s of the run's own clock.
    clock.t = 3;
    for (let i = 0; i < 120 && paints.at(-1)?.phase !== "ready"; i++)
      await frame();
    await frames(2);
    expect(JSON.stringify(paints.slice(-3))).toContain("ready");
    expect(decode(canvas)).toBe(PAYLOAD);
  });

  it("draws the finished card once when the OS asks for less motion", async () => {
    await commands.emulateMotion("reduce");
    useClock();
    const canvas = await mount();
    await frames(10);
    expect(paints, "no frame loop").toHaveLength(0);
    expect(decode(canvas)).toBe(PAYLOAD);
  });

  it("draws the finished card once when the kit's motion is reduced", async () => {
    useClock();
    const canvas = await mount({ colorScheme: "light", motion: "reduced" });
    await frames(10);
    expect(paints).toHaveLength(0);
    expect(decode(canvas)).toBe(PAYLOAD);
  });

  it("drops to 30 fps after 10 s of waiting", async () => {
    useClock();
    clock.t = 0;
    await mount();
    clock.t = 3;
    await frames(2);
    paints = [];
    await frames(60, () => (clock.t += 1 / 60));
    const early = paints.length;
    expect(early).toBeGreaterThanOrEqual(56);
    expect(new Set(paints.map((p) => p.rate))).toEqual(new Set([60]));
    // Ready since 2.4 s: from 12.4 s the orbit idles.
    clock.t = 12.5;
    await frames(2);
    paints = [];
    await frames(60, () => (clock.t += 1 / 60));
    expect(paints.length).toBeGreaterThanOrEqual(26);
    expect(paints.length).toBeLessThanOrEqual(34);
    expect(new Set(paints.map((p) => p.rate))).toEqual(new Set([30]));
  });

  it("pauses while the page is hidden and carries on when it is back", async () => {
    useClock();
    clock.t = 0;
    await mount();
    await frames(5, () => (clock.t += 1 / 60));
    expect(paints.length).toBeGreaterThan(0);
    setVisibility("hidden");
    await frame();
    paints = [];
    await frames(20, () => (clock.t += 1 / 60));
    expect(paints).toHaveLength(0);
    setVisibility(null);
    await frames(5, () => (clock.t += 1 / 60));
    expect(paints.length).toBeGreaterThan(0);
  });
});

describe("the level Q encoder", () => {
  // Every version the encoder offers, from its smallest to its largest payload, decodes.
  it("makes symbols a scanner reads, version 1 to 10", () => {
    const seen = new Set<number>();
    for (const len of [5, 11, 17, 25, 32, 46, 60, 74, 80, 90, 106, 122, 151]) {
      const text = Array.from({ length: len }, (_, i) =>
        String.fromCharCode(65 + ((i * 7 + len) % 26)),
      ).join("");
      const q = encodeQr(text, 1, -1, "Q")!;
      seen.add(q.version);
      const cell = 6;
      const n = q.size + 8;
      const cv = document.createElement("canvas");
      cv.width = cv.height = n * cell;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = "#000";
      for (let y = 0; y < q.size; y++)
        for (let x = 0; x < q.size; x++)
          if (q.modules[y * q.size + x])
            ctx.fillRect((x + 4) * cell, (y + 4) * cell, cell, cell);
      expect(decode(cv, 0), `${len} bytes, version ${q.version}`).toBe(text);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});

const SLUG =
  "PKP1:driftkart-mobile-companion-beta-channel:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y";

/** The platform's own decoder (Apple Vision on macOS): the bar a phone's camera sets. */
async function platformDecode(canvas: HTMLCanvasElement): Promise<string[]> {
  const Detector = (
    globalThis as unknown as {
      BarcodeDetector?: new (o: { formats: string[] }) => {
        detect(s: CanvasImageSource): Promise<{ rawValue: string }[]>;
      };
    }
  ).BarcodeDetector;
  expect(Detector, "a platform QR decoder (BarcodeDetector)").toBeDefined();
  const found = await new Detector!({ formats: ["qr_code"] }).detect(canvas);
  return found.map((f) => f.rawValue);
}

/** What auto-exposure does to a faint code: the card's own levels stretched to the full range. */
function stretched(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width;
  const ctx0 = canvas.getContext("2d")!;
  const luma = (d: Uint8ClampedArray, i: number): number =>
    (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
  // The levels come from the paper alone (inside the card), the crop is the card and its margin.
  const inner = Math.round(w * 0.3);
  const core = ctx0.getImageData(inner, inner, w - 2 * inner, w - 2 * inner);
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < core.data.length; i += 4) {
    lo = Math.min(lo, luma(core.data, i));
    hi = Math.max(hi, luma(core.data, i));
  }
  const inset = Math.round(w * 0.22);
  const side = w - 2 * inset;
  const src = ctx0.getImageData(inset, inset, side, side);
  const out = document.createElement("canvas");
  out.width = out.height = side;
  const ctx = out.getContext("2d")!;
  const dst = ctx.createImageData(side, side);
  for (let i = 0; i < src.data.length; i += 4) {
    const v = Math.max(
      0,
      Math.min(255, ((luma(src.data, i) - lo) / Math.max(1, hi - lo)) * 255),
    );
    dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = v;
    dst.data[i + 3] = 255;
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}

describe("an expired card", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const)
    for (const scheme of ["dark", "light"] as const)
      it(`${width}x${height} ${scheme}: the live card decodes and the expired card does not, in the platform's decoder and jsQR`, async () => {
        await page.viewport(width, height);
        useClock();
        clock.t = 0;
        const live = await mount({ colorScheme: scheme });
        clock.t = 3;
        for (let i = 0; i < 120 && paints.at(-1)?.phase !== "ready"; i++)
          await frame();
        await frames(2);
        expect(decode(live)).toBe(PAYLOAD);
        expect(await platformDecode(live)).toEqual([PAYLOAD]);
        root?.unmount();
        host?.remove();

        paints = [];
        clock.t = 0;
        host = document.body.appendChild(document.createElement("div"));
        root = createRoot(host);
        root.render(
          <Kit.LocalPairing
            input={expiredInput()}
            fill
            theme={{ colorScheme: scheme }}
          />,
        );
        let canvas: HTMLCanvasElement | null = null;
        for (let i = 0; i < 400 && !canvas; i++) {
          await frame();
          canvas = host.querySelector("figure[data-lightcard] canvas");
        }
        await frames(3);
        // Over the same second the card dims, the dark modules fade and blur.
        for (let i = 0; i < 240; i++) {
          clock.t += 1 / 60;
          await frame();
        }
        expect(paints.at(-1)?.phase).toBe("expired");
        expect(decode(canvas!)).toBeNull();
        expect(await platformDecode(canvas!)).toEqual([]);
        // Even with the card's levels stretched to the full range, as a camera's exposure would.
        const levels = stretched(canvas!);
        expect(await platformDecode(levels)).toEqual([]);
        const lctx = levels.getContext("2d")!;
        const px = lctx.getImageData(0, 0, levels.width, levels.height);
        expect(jsQR(px.data, px.width, px.height)).toBeNull();
      });
});

describe("size and look", () => {
  it("keeps the card at 12 rem or more on a 390 phone, and reads a long product slug", async () => {
    await page.viewport(390, 844);
    useClock();
    clock.t = 0;
    const canvas = await mount({ colorScheme: "light" }, SLUG);
    expect(canvas.clientWidth, "the stage fills the column").toBeGreaterThan(
      300,
    );
    // The card's share is read from the run: 12 rem over the stage, never under half.
    clock.t = 3;
    for (let i = 0; i < 120 && paints.at(-1)?.phase !== "ready"; i++)
      await frame();
    await frames(2);
    const share = Math.max(0.5, 192 / canvas.clientWidth);
    expect(cardPx(canvas, share)).toBeGreaterThanOrEqual(191.5);
    expect(SLUG.length).toBeGreaterThan(80);
    expect(decode(canvas)).toBe(SLUG);
  });

  it("takes the product's accent for the glow and its mark for the centre; violet and the star by default", async () => {
    useClock();
    clock.t = 0;
    await mount({ colorScheme: "dark" });
    clock.t = 0.5;
    await frames(3);
    expect(paints.at(-1)).toMatchObject({ tint: "#9a5cff", mark: false });
    root?.unmount();
    host?.remove();

    // A 8x8 orange tile stands in for the product's icon.
    const tile = document.createElement("canvas");
    tile.width = tile.height = 8;
    const t = tile.getContext("2d")!;
    t.fillStyle = "#e8553d";
    t.fillRect(0, 0, 8, 8);
    paints = [];
    clock.t = 0;
    const canvas = await mount({
      colorScheme: "dark",
      product: { name: "DJDL", accent: "#e8553d" },
      iconSrc: tile.toDataURL(),
    });
    clock.t = 3;
    for (let i = 0; i < 120 && !paints.at(-1)?.mark; i++) await frame();
    for (let i = 0; i < 120 && paints.at(-1)?.phase !== "ready"; i++)
      await frame();
    await frames(2);
    expect(paints.at(-1)).toMatchObject({ tint: "#e8553d", mark: true });
    // The ink stays dark on the light card whatever the accent, and the mark is in the clearing.
    const ctx = canvas.getContext("2d")!;
    const at = (x: number, y: number) =>
      ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    const mid = canvas.width / 2;
    const centre = at(mid, mid);
    expect([centre[0], centre[1], centre[2]]).toEqual([232, 85, 61]);
    expect(decode(canvas)).toBe(PAYLOAD);
  });
});
