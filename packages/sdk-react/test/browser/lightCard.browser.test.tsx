// @pkey-feature connect.local
//
// The Light Card on the Pair with a Code show step, in real Chromium (UK-67.1): the ready frame is
// a real QR code and decodes; Reduce Motion (the OS setting or the kit's own `motion`) draws the
// finished card once, with no frame loop; after 10 s of waiting the paint rate drops to 30 fps;
// nothing paints while the page is hidden. The run's clock is injected (the renderer's test seam),
// so none of it waits on real time.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { commands } from "vitest/browser";
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
const input = {
  ...matrix.vocabulary.defaults,
  localPairing: {
    step: "show",
    code: "4812 3456",
    qr: PAYLOAD,
    secondsLeft: 291,
  },
} as unknown as UiInput;

const SEAM = Symbol.for("polaris-key.lightCard.seam");
interface Paint {
  rate: number;
  now: number;
  phase: string;
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
): Promise<HTMLCanvasElement> {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  root.render(<Kit.LocalPairing input={input} fill theme={theme} />);
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

function decode(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height)?.data ?? null;
}

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
      expect(decode(cv), `${len} bytes, version ${q.version}`).toBe(text);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});
