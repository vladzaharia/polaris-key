// @pkey-feature ui.kit.holders
//
// Activation without an account in the elements drop-in, in real Chromium (UK-42.8): the whole
// path through `<pk-gate config>` (a key, Done, Add your name and email, back, Start using, and
// the Settings row's Add) and the sign-in form's own steps (key-done, attach, added) driven by SDK
// primitives, at 390 and 1440 in dark and light. Every render: axe (WCAG 2.x A and AA) finds
// nothing, nothing scrolls sideways, the main action is in the first viewport.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/elements.flow.<step>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import { type PkElement, type PkGate, type PkSignIn } from "../../src/index.js";
import { fakeFetch, NOW, PAGE, typeKey, world } from "../driveWorld.js";
import { fakeHolders, floatingRow, KEY } from "../holdersFixtures.js";
import {
  axeViolations,
  fixtureTheme,
  inputRow,
  SCHEMES,
  settle,
  SIZES,
} from "./support.js";

declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_FONTS__: string;

beforeAll(() => {
  fixtureTheme(__PKEY_FONTS__);
});
afterEach(() => {
  document.body.replaceChildren();
});

type El = HTMLElement & { updateComplete: Promise<unknown> };

const key = (root: ParentNode, k: string) =>
  root.querySelector<HTMLElement>(`[data-key="${k}"]`);
const button = (root: ParentNode, k: string) =>
  root.querySelector<HTMLElement>(`button[data-key="${k}"]`);

async function check(
  el: El,
  id: string,
  size: (typeof SIZES)[number],
  scheme: string,
  main?: string,
) {
  expect(
    document.documentElement.scrollWidth,
    "no sideways scroll",
  ).toBeLessThanOrEqual(size.width);
  const root = (el.shadowRoot!.querySelector("pk-sign-in") ?? el).shadowRoot!;
  if (main) {
    const node = button(root, main) ?? button(el.shadowRoot!, main);
    expect(node, main).not.toBeNull();
    expect(
      node!.getBoundingClientRect().bottom,
      `${main} in the first viewport`,
    ).toBeLessThanOrEqual(size.height);
  }
  expect(await axeViolations(el)).toEqual([]);
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/elements.flow.${id}/${size.label}-${scheme}.png`,
    );
}

function type(root: ParentNode, label: string, value: string) {
  const f = root.querySelector<HTMLInputElement>(`[data-key="${label}"]`)!;
  f.value = value;
  f.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the sign-in form: a key with no account, then Add your name and email", () => {
  for (const size of SIZES)
    for (const scheme of SCHEMES)
      it(`key-done, attach, added at ${size.label} ${scheme}`, async () => {
        await page.viewport(size.width, size.height);
        const el = document.createElement("pk-sign-in") as PkSignIn;
        el.colorScheme = scheme;
        el.fill = true;
        const base = inputRow("SignIn/methods: web");
        delete base.signIn;
        el.input = { ...base, services: ["license", "identity"] };
        el.primitives = fakeHolders().primitives;
        document.body.style.background =
          scheme === "dark" ? "#060912" : "#f6f8ff";
        document.body.replaceChildren(el);
        await settle(el);
        await el.signIn!.submitKey(KEY);
        await settle(el, () => el.view.state === "key-done");
        expect(el.view.state).toBe("key-done");
        await check(el, "form-key-done", size, scheme, "signin.done.start");

        button(el.shadowRoot!, "activate.recommend.action")!.click();
        await settle(el, () => el.view.state === "attach");
        expect(el.view.state).toBe("attach");
        // Name takes focus on a fine pointer, the heading (Add your name and email) on a coarse
        // one (DL9).
        expect(["signin.gate.name", "activate.recommend.action"]).toContain(
          (el.shadowRoot!.activeElement?.getAttribute("data-key") ??
            el.shadowRoot!.activeElement?.id) as string,
        );
        await check(el, "form-attach", size, scheme, "common.continue");

        type(el.shadowRoot!, "signin.gate.name", "Mara Quill");
        type(el.shadowRoot!, "signin.email.label", "mara@example.test");
        button(el.shadowRoot!, "common.continue")!.click();
        await settle(el, () => el.view.state === "added");
        expect(el.view.state).toBe("added");
        await check(el, "form-added", size, scheme, "signin.done.start");
      });
});

describe("<pk-gate config>: the whole path", () => {
  for (const size of SIZES)
    for (const scheme of SCHEMES)
      it(`key, Done, Add, back, Start using, and the Settings row at ${size.label} ${scheme}`, async () => {
        await page.viewport(size.width, size.height);
        const w = world();
        const gate = document.createElement("pk-gate") as PkGate;
        gate.colorScheme = scheme;
        gate.innerHTML = `<main data-testid="app"><p>The app</p></main>`;
        gate.seams = {
          fetchImpl: fakeFetch(w),
          navigate: () => {},
          now: () => NOW,
          // The in-page Add is off on the web by default; this path pins the form's layout.
          addIn: "app",
        };
        gate.config = { ...PAGE, version: "1.0.0" };
        document.body.style.background =
          scheme === "dark" ? "#060912" : "#f6f8ff";
        document.body.replaceChildren(gate);
        const root = gate.shadowRoot!;
        await settle(gate, () => button(root, "welcome.useKey") !== null);
        button(root, "welcome.useKey")!.click();
        await settle(gate, () => root.querySelector("#pk-key") !== null);
        await typeKey(gate, "pkey_acme_KEY");
        button(root, "activate.submit")!.click();
        await settle(gate, () => button(root, "signin.done.start") !== null);
        await check(gate, "gate-done", size, scheme, "signin.done.start");

        button(root, "activate.recommend.action")!.click();
        await settle(gate, () => button(root, "common.continue") !== null);
        await check(gate, "gate-add", size, scheme, "common.continue");

        // Cancel goes back to Done with the key held; Start using lets the app in.
        key(root, "common.cancel")!.click();
        await settle(gate, () => button(root, "signin.done.start") !== null);
        button(root, "signin.done.start")!.click();
        await settle(gate, () => root.querySelector("slot") !== null);
        expect(gate.querySelector('[data-testid="app"]')).not.toBeNull();

        // The Settings row, drawn by the app inside the gate: Add opens AddToAccount.
        const row = document.createElement(
          "pk-account-and-license",
        ) as PkElement;
        row.colorScheme = scheme;
        row.input = floatingRow();
        gate.append(row);
        await settle(row);
        await check(
          row,
          "settings-row",
          size,
          scheme,
          "activate.recommend.action",
        );
        button(row.shadowRoot!, "activate.recommend.action")!.click();
        await settle(gate, () => button(root, "common.continue") !== null);
        expect(root.querySelector("slot")).toBeNull();
        key(root, "common.cancel")!.click();
        await settle(gate, () => root.querySelector("slot") !== null);
        expect(gate.querySelector('[data-testid="app"]')).not.toBeNull();
      });
});
