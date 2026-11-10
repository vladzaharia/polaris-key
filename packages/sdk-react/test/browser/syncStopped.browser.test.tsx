// @pkey-feature ui.kit
//
// The Cloud Sync "Sync stopped." row in real Chromium: the documented drop-in inside the provider
// (no input) shows it once the SDK reads blocked with `account_required`; the glyph stays with the
// label at 390 px and at 200 % text; the action sits on the label's line when it fits and under
// the label's start when it does not; the strip keeps its height when the row appears.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/syncstopped.<scene>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import { PolarisKeyProvider } from "@polaris-key/react";
import * as Kit from "@polaris-key/react/kit";
import {
  fakeAdapter,
  frame,
  hostCleanup,
  renderInto,
} from "../autoFixtures.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;

beforeAll(async () => {
  await Kit.preloadKitParts();
});

const cleanup = hostCleanup();
afterEach(() => {
  cleanup();
  document.documentElement.style.fontSize = "";
});

const BLOCKED = { state: "blocked", pending: 0, reason: "account_required" };
const THEME = { colorScheme: "dark" } as const;

/** The documented drop-in's world: a provider whose SDK reads blocked with `account_required`. */
function blocked(children: React.ReactNode): React.ReactNode {
  const adapter = fakeAdapter({ kind: "needsSignIn" } as never);
  Object.assign(adapter, {
    cloudSync: {
      unsupported: null,
      status: () => BLOCKED,
      onStatus: () => () => undefined,
      onEvents: () => () => undefined,
    },
  });
  return (
    <PolarisKeyProvider config={{ productSlug: "tidewater", adapter }}>
      {children}
    </PolarisKeyProvider>
  );
}

async function draw(node: React.ReactNode, w: number, scale: number) {
  document.documentElement.style.fontSize = `${scale * 100}%`;
  await page.viewport(w, 700);
  document.body.style.cssText = "margin:0;background:#060912";
  const el = renderInto(node);
  await until(() => el.querySelector("[data-grouped]") !== null);
  for (let i = 0; i < 4; i++) await frame();
  return el;
}

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 20));
}

const rect = (el: Element | null) => el!.getBoundingClientRect();

describe("Sync stopped: the drop-in", () => {
  for (const [w, scale] of [
    [390, 1],
    [390, 2],
    [1440, 1],
  ] as const) {
    it(`${w}px at ${scale * 100}%: the glyph stays with the label; the action is a quiet button`, async () => {
      const el = await draw(
        blocked(<Kit.CloudSyncStatus theme={THEME} />),
        w,
        scale,
      );
      if (__PKEY_KIT_SHOTS__)
        await commands.kitShot(
          `${__PKEY_KIT_SHOTS__}/syncstopped.dropin/${w}-${scale * 100}-dark.png`,
        );
      const label = el.querySelector('[data-key="cloudSync.syncStopped"]');
      const glyph = el.querySelector(".status-glyph");
      const button = el.querySelector('button[data-key="cloudSync.signIn"]');
      expect(label?.textContent).toBe("Sync stopped.");
      expect(button?.getAttribute("data-variant")).toBe("secondary");
      // The glyph is left of the label, on its first line.
      expect(rect(glyph).right).toBeLessThanOrEqual(rect(label).left + 1);
      expect(rect(glyph).top).toBeLessThan(rect(label).bottom);
      // The action is on the label's line, or under its start.
      const [b, l] = [rect(button), rect(label)];
      if (b.top < l.bottom) expect(b.left).toBeGreaterThanOrEqual(l.right - 1);
      else expect(Math.abs(b.left - l.left)).toBeLessThanOrEqual(1);
      expect(b.height).toBeGreaterThanOrEqual(43);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w);
    });
  }

  it("the strip keeps its height when the row appears", async () => {
    const height = async (cloudSync: object) => {
      const el = await draw(
        <Kit.CloudSyncStatus theme={THEME} input={{ cloudSync } as never} />,
        1440,
        1,
      );
      const h = rect(el.querySelector('[data-part="status"]')).height;
      cleanup();
      return h;
    };
    const synced = await height({ state: "synced", lastSynced: "2 min ago" });
    const stopped = await height({ state: "error", signedIn: false });
    expect(stopped).toBe(synced);
  });
});
