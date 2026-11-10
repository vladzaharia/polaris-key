// @pkey-feature ui.kit
//
// The Cloud Sync "Sync stopped." row in real Chromium: the documented drop-in inside the provider
// (no input) shows it once the SDK reads blocked with `account_required`; the glyph stays with the
// label at 390 px and at 200 % text; the action sits on the label's line when it fits and under
// the label's start when it does not; the strip keeps its height when the row appears.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/syncstopped.<scene>/<size>-<scheme>.png.

import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";

import * as Kit from "@polaris-key/react/kit";
import { PolarisKeyProvider } from "@polaris-key/react";
import { KIT_COPY_EN_LEAN } from "@polaris-key/brand/kit-copy/lean";
import enRest from "../../../brand/src/generated/kit-copy/en-rest.json" with { type: "json" };
import { desktopAdapter } from "../../src/desktop/desktopAdapter.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "../fixtures.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;

beforeAll(async () => {
  await Kit.preloadKitParts();
  Kit.provideKitCopy("en", { ...KIT_COPY_EN_LEAN, ...enRest });
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

async function draw(node: ReactNode, w: number, scale: number) {
  document.documentElement.style.fontSize = `${scale * 100}%`;
  await page.viewport(w, 700);
  document.body.style.margin = "0";
  document.body.style.background = "#060912";
  host ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(host);
  root.render(node);
  for (let i = 0; i < 100 && !host.querySelector("[data-grouped]"); i++)
    await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 4; i++) await frame();
  return host;
}

async function shot(id: string, label: string): Promise<void> {
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/syncstopped.${id}/${label}.png`,
    );
}

/** A provider whose SDK reads blocked with `account_required`: the documented drop-in's world. */
function Blocked(props: { children: ReactNode }): ReactNode {
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(emptyBridgeState()),
    now: () => NOW_SEC,
  });
  Object.assign(adapter, {
    cloudSync: {
      unsupported: null,
      status: () => ({
        state: "blocked",
        pending: 0,
        reason: "account_required",
      }),
      onStatus: () => () => undefined,
      onEvents: () => () => undefined,
    },
  });
  return (
    <PolarisKeyProvider config={{ productSlug: "tidewater", adapter }}>
      {props.children}
    </PolarisKeyProvider>
  );
}

const THEME = { colorScheme: "dark" } as const;
const strip = (el: Element) =>
  el.querySelector<HTMLElement>('[data-part="status"]')!;
const rect = (el: Element | null) => el!.getBoundingClientRect();

describe("Sync stopped: the drop-in", () => {
  for (const [w, scale] of [
    [390, 1],
    [390, 2],
    [1440, 1],
  ] as const) {
    it(`${w}px at ${scale * 100}%: the glyph stays with the label; the action is a quiet button`, async () => {
      const el = await draw(
        <Blocked>
          <Kit.CloudSyncStatus theme={THEME} />
        </Blocked>,
        w,
        scale,
      );
      await shot("dropin", `${w}-${scale * 100}-dark`);
      const label = el.querySelector('[data-key="cloudSync.syncStopped"]');
      const glyph = el.querySelector(".status-glyph");
      const button = el.querySelector<HTMLElement>(
        'button[data-key="cloudSync.signIn"]',
      );
      expect(label?.textContent).toBe("Sync stopped.");
      expect(button?.getAttribute("data-variant")).toBe("secondary");
      // The glyph is left of the label, on its first line.
      expect(rect(glyph).right).toBeLessThanOrEqual(rect(label).left + 1);
      expect(rect(glyph).top).toBeLessThan(rect(label).bottom);
      // The action is on the label's line, or under its start.
      const b = rect(button);
      const l = rect(label);
      const same = b.top < l.bottom;
      if (same) expect(b.left).toBeGreaterThanOrEqual(l.right - 1);
      else expect(Math.abs(b.left - l.left)).toBeLessThanOrEqual(1);
      expect(b.height).toBeGreaterThanOrEqual(43);
      // Nothing scrolls sideways.
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w);
    });
  }

  it("the strip keeps its height when the row appears", async () => {
    const synced = { cloudSync: { state: "synced", lastSynced: "2 min ago" } };
    const stopped = { cloudSync: { state: "error", signedIn: false } };
    const el = await draw(
      <Kit.CloudSyncStatus theme={THEME} input={synced as never} />,
      1440,
      1,
    );
    const before = rect(strip(el)).height;
    await draw(
      <Kit.CloudSyncStatus theme={THEME} input={stopped as never} />,
      1440,
      1,
    );
    expect(rect(strip(el)).height).toBe(before);
  });
});
