// @pkey-feature ui.kit identity.autosignin
//
// Automatic sign-in in the elements, in real Chromium (I-46.9): the confirm, the device limit with
// and without a link, the provider's Google button and the opt-out, at 390 and 1440 in dark and
// light. Every render: axe (WCAG 2.x A and AA) finds nothing and nothing scrolls sideways.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/elements.auto.<name>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import type { UiInput } from "@polaris-key/ui-core";

import { PolarisKey, type PkGate, type PkSignIn } from "../../src/index.js";
import { CONSENT, fakeClient } from "../autoFixtures.js";
import {
  axeViolations,
  fixtureTheme,
  inputRow,
  SCHEMES,
  settle,
  SIZES,
} from "./support.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_FONTS__: string;

beforeAll(() => {
  fixtureTheme(__PKEY_FONTS__);
});
afterEach(() => {
  document.body.replaceChildren();
});

interface Scene {
  id: string;
  draw: (
    scheme: "dark" | "light",
  ) => Promise<HTMLElement & { updateComplete: Promise<unknown> }>;
  /** The control that must be there. */
  has: string;
}

const form = (id: string, has: string, input: UiInput): Scene => ({
  id,
  has,
  draw: async (scheme) => {
    const el = document.createElement("pk-sign-in") as PkSignIn;
    el.colorScheme = scheme;
    el.fill = true;
    el.input = input;
    document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
    document.body.replaceChildren(el);
    await settle(el);
    return el;
  },
});

const gate = (
  id: string,
  has: string,
  result: unknown,
  attrs: Record<string, string> = {},
  press?: string,
): Scene => ({
  id,
  has,
  draw: async (scheme) => {
    const { adapter } = fakeClient(result);
    const el = document.createElement("pk-gate") as PkGate;
    el.colorScheme = scheme;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.setAttribute("config", '{"product":"acme"}');
    el.seams = { client: adapter as never };
    document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
    document.body.replaceChildren(el);
    await settle(el);
    if (press) {
      el.shadowRoot!.querySelector<HTMLElement>(
        `[data-key="${press}"]`,
      )!.click();
      await settle(el);
    }
    return el;
  },
});

const SCENES: Scene[] = [
  form(
    "confirm",
    "signin.auto.confirm.primary",
    inputRow("SignIn/confirm: the account's email, a new license"),
  ),
  form(
    "device-limit",
    "signin.deviceLimit.replace",
    inputRow(
      "SignIn/device-limit: no license rows, with a link to replace a device",
    ),
  ),
  form(
    "device-limit-no-link",
    "signin.auto.confirm.other",
    inputRow("SignIn/device-limit: no license rows, no link"),
  ),
  gate(
    "google-button",
    "signin.provider.continue",
    { kind: "needsSignIn", reason: "signedOut" },
    {},
    "welcome.signIn",
  ),
  gate("gate-confirm", "signin.auto.confirm.primary", {
    kind: "confirm",
    grant: "sg_1",
    expiresIn: 300,
    consent: CONSENT,
  }),
  gate(
    "opt-out",
    "welcome.signIn",
    { kind: "unavailable", code: "refused" },
    { "auto-sign-in": "off" },
  ),
];

describe("automatic sign-in in the elements", () => {
  for (const size of SIZES)
    for (const scheme of SCHEMES)
      it.each(SCENES.map((s) => [s.id, s] as const))(
        `%s at ${size.label} ${scheme}`,
        async (id, scene) => {
          await page.viewport(size.width, size.height);
          const el = await scene.draw(scheme);
          const nested = el.shadowRoot!.querySelector("pk-sign-in");
          const root = (nested ?? el).shadowRoot!;
          expect(
            root.querySelector(`[data-key="${scene.has}"]`),
            scene.has,
          ).not.toBeNull();
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
            size.width,
          );
          for (const sel of ["h1", '[data-part="primary"]']) {
            const node = root.querySelector(sel);
            if (!node) continue;
            expect(
              node.getBoundingClientRect().bottom,
              `${sel} in the first viewport`,
            ).toBeLessThanOrEqual(size.height);
          }
          expect(await axeViolations(el)).toEqual([]);
          if (__PKEY_KIT_SHOTS__)
            await commands.kitShot(
              `${__PKEY_KIT_SHOTS__}/elements.auto.${id}/${size.label}-${scheme}.png`,
            );
        },
      );
});
