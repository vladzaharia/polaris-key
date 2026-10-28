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
  fakeAdapter,
  frame,
  hostCleanup,
  loadFonts,
  renderInto,
} from "../autoFixtures.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "../fixtures.js";

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
      });

      it(`device limit with no list at ${w} ${scheme}`, async () => {
        const el = await scene(
          "device-limit-no-list",
          { kind: "deviceLimit", manageUrl: "https://key.plrs.im/m" },
          w,
          h,
          scheme,
          (e) => e.querySelector('[data-part="title"]') !== null,
        );
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          document.documentElement.clientWidth,
        );
        // The gate's device-limit step, with the portal link.
        expect(
          el.querySelector('button[data-key^="deviceLimit."]'),
        ).not.toBeNull();
      });

      it(`device limit at ${w} ${scheme}`, async () => {
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
          (e) => e.querySelector('[data-part="title"]') !== null,
        );
        expect(el.textContent).toContain("Pro");
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          document.documentElement.clientWidth,
        );
      });
    }
});
