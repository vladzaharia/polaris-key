// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall
//
// The elements' committed visual baselines (UI-KITS.md §7.1): one render of every component state
// the React visual suite covers (the same fixtures, from sdk-react's kitFixtures), at the phone
// (390 x 844) and desktop (1440 x 900) rows in dark and light, in the same host page and product
// as the React suite so `pnpm ui:report` can diff the two renderers pixel for pixel.
//
//   PKEY_KIT_BASELINES=test/visual/__screenshots__ pnpm test:browser   (or `pnpm test:visual`)
//
// writes <dir>/<Component>.<state>/<size>-<scheme>.png, the layout the React suite records.
// Without the variable the test still renders every state and checks it drew.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import type { ComponentName, UiInput } from "@polaris-key/ui-core";
import matrix from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import registry from "../../../brand/kit-copy/components.json" with { type: "json" };
import {
  DIRECT_COMPONENT_STATE_FIXTURES,
  matrixComponentStateFixtures,
  type ComponentStateFixture,
  type MatrixComponentRow,
} from "../../../sdk-react/test/kitFixtures.js";
import { HOLDER_COPY, isHolderScreen } from "./support.js";
import { PolarisKey, TAGS, LAYOUTS, type PkElement } from "../../src/index.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_BASELINES__: string;
declare const __PKEY_FONTS__: string;

type Obj = Record<string, unknown>;
const m = matrix as unknown as Obj & { vocabulary: { defaults: Obj } };

const FAMILIES = [
  "gate",
  "activate",
  "signIn",
  "deviceLimit",
  "devices",
  "update",
  "settings",
  "paywall",
  "cloudSync",
  "holders",
] as const;
const ROWS = FAMILIES.flatMap((f) =>
  (m[f] as MatrixComponentRow[]).filter(
    (r) => f !== "holders" || isHolderScreen(r),
  ),
);
const FIXTURES: readonly ComponentStateFixture[] = [
  ...matrixComponentStateFixtures(ROWS),
  ...DIRECT_COMPONENT_STATE_FIXTURES,
];

const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "1440", width: 1440, height: 900 },
] as const;
const SCHEMES = ["dark", "light"] as const;

// The React suite's product: the same name, developer and accent, and no icon.
const PRODUCT = {
  name: "Tidewater",
  developer: "Lumen Games",
  accent: "#369186",
};

function withDefaults(input: UiInput): UiInput {
  const out: Obj = { ...(input as Obj) };
  for (const [k, v] of Object.entries(m.vocabulary.defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((out[k] as Obj | undefined) ?? {}) };
    else if (!(k in out)) out[k] = v;
  }
  // The runner plays a host that can renew: the corpus lists Renew on the expired row, and a kit
  // draws it only for such a host (SwiftUI `renewURL`, Compose `onRenew`).
  if (!("renew" in out)) out["renew"] = { url: "https://example.com/renew" };
  return out as UiInput;
}

/** The corpus elides the served device code; a visual render shows a real grouped value. */
function extras(input: UiInput): Partial<UiInput> {
  const deviceCode = input.deviceCode;
  if (!deviceCode) return {};
  return {
    deviceCode: {
      ...deviceCode,
      ...(deviceCode.userCode === undefined ? { userCode: "WDJB-MJHT" } : {}),
    },
  };
}

beforeAll(() => {
  PolarisKey.fonts(__PKEY_FONTS__);
  PolarisKey.theme({ product: PRODUCT, copy: HOLDER_COPY });
  document.body.style.margin = "0";
});

afterEach(() => {
  document.body.replaceChildren();
});

async function mount(
  f: ComponentStateFixture,
  scheme: "dark" | "light",
): Promise<PkElement> {
  document.documentElement.style.fontSize = "16px";
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const el = document.createElement(TAGS[f.component]) as PkElement;
  el.colorScheme = scheme;
  el.input = {
    elapsedMs: 60_000,
    ...withDefaults(f.input),
    ...extras(f.input),
  };
  // The React suite's `fill` for a screen: the window is the page. The gate decides for itself.
  if (
    f.component !== "PolarisKeyGate" &&
    LAYOUTS[f.component].kind === "screen"
  )
    el.fill = true;
  // The same host content the React suite wraps: a licensed gate gets out of its way.
  const main = document.createElement("main");
  main.dataset.hostContent = "";
  main.innerHTML = "<p>The app</p>";
  el.append(main);
  document.body.replaceChildren(el);
  await el.updateComplete;
  await document.fonts.ready;
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  await el.updateComplete;
  await Promise.all(
    [...document.getAnimations(), ...(el.shadowRoot?.getAnimations() ?? [])]
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  return el;
}

describe("the registry is covered", () => {
  it("renders every visible component state of the registry", () => {
    const want = Object.entries(registry.components).flatMap(([c, d]) =>
      Object.keys(d.states)
        .filter((s) => s !== "hidden")
        .map((s) => `${c}.${s}`),
    );
    const have = new Set(FIXTURES.map((f) => f.id));
    // The sign-in form's holder steps are drawn by UK-42.8 (its baselines come with it).
    const later = new Set(["SignIn.key-done", "SignIn.attach", "SignIn.added"]);
    expect(want.filter((id) => !have.has(id) && !later.has(id))).toEqual([]);
  });
});

describe("every component state at the baseline rows", () => {
  for (const scheme of SCHEMES)
    for (const size of SIZES)
      it.each(FIXTURES.map((f) => [f.id, f] as const))(
        `%s ${size.label} ${scheme}`,
        async (id, f) => {
          await page.viewport(size.width, size.height);
          const el = await mount(f, scheme);
          // A licensed gate gets out of the way: its baseline is the host app.
          if (id !== "PolarisKeyGate.licensed")
            expect(el.shadowRoot!.querySelector(".pk-root")).not.toBeNull();
          if (__PKEY_KIT_BASELINES__)
            await commands.kitShot(
              `${__PKEY_KIT_BASELINES__}/${id}/${size.label}-${scheme}.png`,
            );
        },
      );
});
