// @pkey-feature identity.nearby ui.kit
//
// I-47b.3 / UXR-47: the desktop's nearby sign-in screens in real Chromium at the §7.1 rows that
// matter (a phone, a phone on its side, a laptop, 200 % text), dark and light. The new device
// draws the pre-prompt, the code and the device list; the signed-in device draws the three codes
// and the licence choice. Assertions: no sideways scroll, every target 24 px or more, the codes
// fully visible, axe finds nothing.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";

import { PolarisKeyProvider } from "@polaris-key/react";
import * as Kit from "@polaris-key/react/kit";
import { DesktopAdapter } from "../../src/desktop/desktopAdapter.js";
import type { PolarisBridge } from "../../src/desktop/bridge.js";
import { emptyBridgeState, makeFakeBridge, NOW_SEC } from "../fixtures.js";
import { axeFindings } from "./axe.js";

const SIZES = [
  { label: "390x844", width: 390, height: 844, rootPx: 16 },
  { label: "844x390", width: 844, height: 390, rootPx: 16 },
  { label: "1440x900", width: 1440, height: 900, rootPx: 16 },
  { label: "390x844@200", width: 390, height: 844, rootPx: 32 },
] as const;
const PRODUCT = {
  name: "Tidewater",
  developer: "Lumen Games",
  accent: "#369186",
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = host = null;
  document.documentElement.style.fontSize = "";
});
beforeAll(async () => {
  await Kit.preloadKitParts();
});

const ASK = {
  askId: "ask-1",
  device: "Studio PC",
  platform: "windows",
  codes: ["111 111", "222 222", "333 333"] as [string, string, string],
};
const requester = (phase: "waiting" | "choose-approver") => ({
  sessionId: "s-1",
  phase,
  code: phase === "waiting" ? "482 913" : undefined,
  approvers: [
    { id: "r1", device: "Ana's laptop", platform: "macos" },
    { id: "r2", device: "Desk PC", platform: "windows" },
  ],
});

const SCENES: Record<
  string,
  Partial<PolarisBridge> & { ui: "d" | "m"; prompt?: boolean }
> = {
  "D.prompt": { ui: "d" },
  "D.wait": {
    ui: "d",
    prompt: false,
    nearbyStart: async () => requester("waiting") as never,
  },
  "D.pick": {
    ui: "d",
    prompt: false,
    nearbyStart: async () => requester("choose-approver") as never,
  },
  "M.ask": {
    ui: "m",
    approverStart: async () => ({ listening: true, asks: [ASK] }),
    approverStop: async () => undefined,
  },
};

async function mount(id: string, scheme: "dark" | "light", rootPx: number) {
  const { ui, prompt, ...over } = SCENES[id]!;
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  host = document.createElement("div");
  document.body.append(host);
  const bridge = Object.assign(makeFakeBridge(emptyBridgeState()), {
    version: 5,
    ...over,
  }) as PolarisBridge;
  const adapter = new DesktopAdapter({ bridge, now: () => NOW_SEC });
  root = createRoot(host);
  const theme = { product: PRODUCT, colorScheme: scheme } as const;
  root.render(
    <PolarisKeyProvider
      config={{ productSlug: "acme", adapter }}
      autoSignIn={false}
    >
      {ui === "d" ? (
        <Kit.NearbySignIn
          fill
          theme={theme}
          {...(prompt === false ? { prompt: false } : {})}
        />
      ) : (
        <Kit.NearbyApprover fill theme={theme} />
      )}
    </PolarisKeyProvider>,
  );
  for (let i = 0; i < 150 && !host.querySelector(".btn"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await document.fonts.ready;
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  return host.querySelector<HTMLElement>(".pk-root")!;
}

const visible = (el: Element): DOMRect | null => {
  const box = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return box.width > 0 &&
    box.height > 0 &&
    s.visibility !== "hidden" &&
    s.display !== "none"
    ? box
    : null;
};

describe("nearby sign-in on the desktop at the §7.1 rows", () => {
  for (const id of Object.keys(SCENES))
    for (const scheme of ["dark", "light"] as const)
      for (const size of SIZES)
        it(`${id} ${size.label} ${scheme}`, async () => {
          await page.viewport(size.width, size.height);
          const kit = await mount(id, scheme, size.rootPx);
          expect(
            document.documentElement.scrollWidth,
            "sideways scroll",
          ).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
          const buttons = [...kit.querySelectorAll(".btn")];
          expect(buttons.length).toBeGreaterThan(0);
          const small = buttons.flatMap((el) => {
            const r = visible(el);
            return r && (r.width < 24 || r.height < 24)
              ? [`${el.tagName} ${(el.textContent ?? "").slice(0, 20)}`]
              : [];
          });
          expect(small.join("\n")).toBe("");
          for (const b of kit.querySelectorAll('[data-key="nearby.code"]')) {
            const r = b.getBoundingClientRect();
            expect(r.left, "a code is cut off").toBeGreaterThanOrEqual(0);
            expect(r.right, "a code is cut off").toBeLessThanOrEqual(
              innerWidth + 0.5,
            );
          }
          expect(await axeFindings(kit)).toEqual([]);
        });
});
