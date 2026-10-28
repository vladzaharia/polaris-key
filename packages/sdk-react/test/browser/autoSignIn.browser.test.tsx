// @pkey-feature ui.kit identity.autosignin
//
// Automatic sign-in in the React gate, in real Chromium (I-46.8): the confirm step, "needs sign-in"
// (Welcome, then the form with the provider's button) and the device limit, at 390 and 1440 in
// dark and light. No sideways scroll and the main action inside the first viewport.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/react.auto.<scene>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import { PolarisKeyProvider } from "@polaris-key/react";
import * as Kit from "@polaris-key/react/kit";
import { KIT_COPY_EN_LEAN } from "@polaris-key/brand/kit-copy/lean";
import enRest from "../../../brand/src/generated/kit-copy/en-rest.json" with { type: "json" };
import type { AutoSignInResult } from "../../src/core/index.js";
import { desktopAdapter } from "../../src/desktop/desktopAdapter.js";
import {
  CONSENT,
  VIEW_FULL,
  VIEW_FULL_LINKED,
  fakeAdapter,
  frame,
  hostCleanup,
  loadFonts,
  renderInto,
} from "../autoFixtures.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "../fixtures.js";
import { axeFindings } from "./axe.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;

beforeAll(async () => {
  await Kit.preloadKitParts();
  // English's second copy table loads on demand; the scenes start with the whole table.
  Kit.provideKitCopy("en", { ...KIT_COPY_EN_LEAN, ...enRest });
  await loadFonts();
});

let host: HTMLElement | null = null;
const cleanup = hostCleanup();
afterEach(() => {
  cleanup();
  host = null;
});

const until = (f: () => boolean): Promise<void> =>
  vi.waitFor(() => expect(f()).toBe(true), { timeout: 3000 });

async function scene(
  name: string,
  result: AutoSignInResult,
  w: number,
  h: number,
  scheme: "dark" | "light",
  ready: (el: HTMLElement) => boolean,
  before?: (el: HTMLElement) => void,
): Promise<HTMLElement> {
  await page.viewport(w, h);
  document.body.style.margin = "0";
  document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
  const adapter = fakeAdapter(result);
  host = renderInto(
    <PolarisKeyProvider config={{ productSlug: "tidewater", adapter }}>
      <Kit.PolarisKeyGate
        theme={{
          product: { name: "Tidewater Studio", accent: "#369186" },
          colorScheme: scheme,
        }}
      >
        <div>APP</div>
      </Kit.PolarisKeyGate>
    </PolarisKeyProvider>,
  );
  await until(() => ready(host!));
  before?.(host);
  if (before)
    await until(() => host!.querySelector("form, [data-part]") !== null);
  await document.fonts.ready;
  for (let i = 0; i < 6; i++) await frame();
  // The step's entrance fades in: measure and shoot the settled colours.
  for (const a of document.getAnimations())
    try {
      a.finish();
    } catch {
      // An infinite animation (a spinner) has no end.
    }
  await frame();
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/react.auto.${name}/${w}-${scheme}.png`,
    );
  return host;
}

const has = (key: string) => (el: HTMLElement) =>
  el.querySelector(`button[data-key="${key}"]`) !== null;

/** The page does not scroll sideways and the main action is in the first viewport. */
function fits(el: HTMLElement, key: string): void {
  const root = document.documentElement;
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  const b = el
    .querySelector(`button[data-key="${key}"]`)!
    .getBoundingClientRect();
  expect(b.top).toBeGreaterThanOrEqual(0);
  expect(b.bottom).toBeLessThanOrEqual(window.innerHeight);
}

describe("automatic sign-in in the React gate (real Chromium)", () => {
  for (const scheme of ["dark", "light"] as const)
    for (const [w, h] of [
      [390, 844],
      [1440, 900],
    ] as const) {
      it(`confirm at ${w} ${scheme}`, async () => {
        const el = await scene(
          "confirm",
          { kind: "confirm", grant: "sg_1", expiresIn: 300, consent: CONSENT },
          w,
          h,
          scheme,
          has("signin.auto.confirm.primary"),
        );
        fits(el, "signin.auto.confirm.primary");
        // The existing-license line has its arguments (never an empty placeholder).
        expect(el.textContent).toContain("Pro");
        expect(el.textContent).not.toMatch(/\{[a-z]+\}/);
        expect((await axeFindings(el)).join("\n")).toBe("");
        // Continue and Use another account only.
        expect(el.querySelector('button[data-key="common.cancel"]')).toBeNull();
      });

      it(`needs sign-in at ${w} ${scheme}: Welcome, then the form with the provider button`, async () => {
        const el = await scene(
          "needs-sign-in",
          { kind: "needsSignIn", reason: "signedOut" },
          w,
          h,
          scheme,
          has("welcome.signIn"),
        );
        fits(el, "welcome.signIn");
      });

      it(`google button at ${w} ${scheme}`, async () => {
        const el = await scene(
          "google-button",
          { kind: "needsSignIn", reason: "noLink" },
          w,
          h,
          scheme,
          has("signin.provider.continue"),
        );
        fits(el, "signin.provider.continue");
        const b = el.querySelector<HTMLElement>(
          'button[data-key="signin.provider.continue"]',
        )!;
        // Google's own fill and label, never the accent.
        const css = getComputedStyle(b);
        expect(css.backgroundColor).toBe(
          scheme === "dark" ? "rgb(19, 19, 20)" : "rgb(255, 255, 255)",
        );
        expect(b.querySelectorAll("svg.mark path")).toHaveLength(4);
        expect((await axeFindings(el)).join("\n")).toBe("");
      });

      it(`device limit with no rows at ${w} ${scheme}`, async () => {
        const el = await scene(
          "device-limit-no-rows",
          { kind: "deviceLimit", manageUrl: "https://key.plrs.im/m" },
          w,
          h,
          scheme,
          has("signin.deviceLimit.replace"),
        );
        fits(el, "signin.deviceLimit.replace");
        // Its own step: never the key field.
        expect(el.querySelector("#pk-key")).toBeNull();
        expect(
          el.querySelector('button[data-key="signin.key.differentKey"]'),
        ).toBeNull();
        expect(document.activeElement?.id).toBe("pk-title");
        expect((await axeFindings(el)).join("\n")).toBe("");
      });

      it(`device limit with rows at ${w} ${scheme}`, async () => {
        const el = await scene(
          "device-limit",
          {
            kind: "deviceLimit",
            view: VIEW_FULL,
            manageUrl: "https://key.plrs.im/m",
          },
          w,
          h,
          scheme,
          has("signin.replace.open"),
        );
        expect(el.textContent).toContain("Pro");
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          document.documentElement.clientWidth,
        );
        // The row grows to fit its content: nothing overflows its box.
        const row = el.querySelector<HTMLElement>('[data-part="license-row"]')!;
        const box = row.getBoundingClientRect();
        for (const n of row.querySelectorAll("*")) {
          const r = n.getBoundingClientRect();
          expect(r.bottom).toBeLessThanOrEqual(box.bottom + 1);
          expect(r.right).toBeLessThanOrEqual(box.right + 1);
        }
        expect((await axeFindings(el)).join("\n")).toBe("");
      });

      it(`device limit, row with its own link at ${w} ${scheme}`, async () => {
        const el = await scene(
          "device-limit-linked",
          { kind: "deviceLimit", view: VIEW_FULL_LINKED },
          w,
          h,
          scheme,
          has("signin.replace.open"),
        );
        expect((await axeFindings(el)).join("\n")).toBe("");
      });
    }
});
