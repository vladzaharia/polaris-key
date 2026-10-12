// @pkey-feature ui.kit ui.kit.manage
//
// The React kit (`@polaris-key/react/kit`) in real Chromium. The responsive scenes cover every
// UI-KITS §7.1 size in dark and light, and the complete fixture state matrix covers the 390 and
// 1440 baseline rows in both schemes. On every render:
//
//   * nothing scrolls sideways (DL15);
//   * a screen's h1 and its primary are fully in the first viewport (DL1), and there is one h1;
//   * every control is at least 24 x 24 px (WCAG 2.5.8);
//   * axe's color-contrast rule passes on the kit (text 4.5:1, DL13);
//   * the kit's text is set in Rubik or the kit mono (native: the host's face);
//   * nothing the kit sets lands on :root (§3.2).
//
// `PKEY_KIT_SHOTS=<dir>` writes every responsive render to
// `<dir>/react.<component>.<state>/<size>-<scheme>[-native].png`.
// `PKEY_KIT_BASELINES=<dir>` writes the complete 390 and 1440 dark/light state matrix directly
// under `<dir>/<Component>.<state>/<size>-<scheme>.png`, the paths UK-04's elements renderer
// records so ui:report can compare them.

import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import componentRegistryJson from "../../../../packages/brand/kit-copy/components.json" with { type: "json" };
import type { UiInput } from "@polaris-key/ui-core";

import { LAYOUTS } from "@polaris-key/elements/contract";

import * as Kit from "@polaris-key/react/kit";
import {
  DIRECT_COMPONENT_STATE_FIXTURES,
  matrixComponentStateFixtures,
  type ComponentStateFixture,
  type MatrixComponentRow,
} from "../kitFixtures.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_KIT_BASELINES__: string;

type Obj = Record<string, unknown>;
interface Row extends MatrixComponentRow {}

const FAMILIES = [
  "gate",
  "activate",
  "signIn",
  "deviceLimit",
  "devices",
  "update",
  "settings",
  "paywall",
] as const;

const matrix = matrixJson as Obj & { vocabulary: Obj & { defaults: Obj } };
const COMPONENT_ROWS = FAMILIES.flatMap((family) => matrix[family] as Row[]);
const ROWS: Record<string, Row> = Object.fromEntries(
  COMPONENT_ROWS.map((row) => [row.name, row]),
);

beforeAll(async () => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../../../brand/fonts/fonts.css", import.meta.url).href;
  document.head.append(link);
  // ES2023 is the package's public type target, before Promise.withResolvers().
  await new Promise<void>((resolve) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
  });
});

function withDefaults(input: UiInput, defaults: Obj): UiInput {
  const out: Obj = { ...input };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((out[k] as Obj | undefined) ?? {}) };
    else if (!(k in out)) out[k] = v;
  }
  return out as UiInput;
}

interface Scene {
  id: string;
  row?: string;
  fixture?: ComponentStateFixture;
  /** Record in `PKEY_KIT_BASELINES`, unlike the representative responsive scenes. */
  baseline?: boolean;
  /** Under the native preset too. */
  native?: boolean;
}

const SCENES: Scene[] = [
  {
    id: "PolarisKeyGate.needs-activation",
    row: "PolarisKeyGate/needs-activation",
    native: true,
  },
  {
    id: "Welcome.default",
    row: "Welcome/default: sign-in and a key",
    native: true,
  },
  { id: "Welcome.long-name", row: "Welcome/default: a long product name" },
  { id: "Activate.parsed", row: "Activate/parsed", native: true },
  {
    id: "Activate.device-limit",
    row: "Activate/device-limit: a link to replace a device",
    native: true,
  },
  { id: "Activate.rejected", row: "Activate/rejected: not a key" },
  { id: "SignIn.code", row: "SignIn/code: Use a code instead" },
  { id: "SignIn.choose", row: "SignIn/choose: desktop" },
  { id: "SignIn.replace", row: "SignIn/replace: the web confirms inline" },
  {
    id: "DeviceLimit.default",
    row: "DeviceLimit/default: the devices listed in the app",
  },
  { id: "DeviceLimit.browser-mode", row: "DeviceLimit/browser-mode: desktop" },
  { id: "StatusScreen.revoked", row: "StatusScreen/revoked", native: true },
  { id: "StatusScreen.expired", row: "StatusScreen/expired" },
  {
    id: "PolarisKeyGate.error",
    row: "PolarisKeyGate/error: the boot ended in error",
  },
  { id: "GraceBanner.days-left", row: "GraceBanner/days-left" },
  { id: "Devices.list", row: "Devices/list", native: true },
  { id: "Devices.error", row: "Devices/error: the list could not load" },
  { id: "UpdateProgress.downloading", row: "UpdateProgress/downloading" },
  { id: "Settings.list", row: "Settings/list" },
  { id: "AccountAndLicense.signed-in", row: "AccountAndLicense/signed-in" },
  {
    id: "Paywall.not-available",
    row: "Paywall/not-available: the web waits for checkout",
  },
];

const COMPONENT_STATE_FIXTURES: readonly ComponentStateFixture[] = [
  ...matrixComponentStateFixtures(COMPONENT_ROWS),
  ...DIRECT_COMPONENT_STATE_FIXTURES,
];

/** One representative fixture input for every visible component state in the registry. */
const BASELINE_SCENES: readonly Scene[] = COMPONENT_STATE_FIXTURES.map(
  (fixture) => ({ id: fixture.id, fixture, baseline: true }),
);

const REGISTERED_COMPONENT_STATE_IDS = Object.entries(
  componentRegistryJson.components,
).flatMap(([component, definition]) =>
  Object.keys(definition.states)
    .filter((state) => state !== "hidden")
    .map((state) => `${component}.${state}`),
);

interface Size {
  label: string;
  width: number;
  height: number;
  rootPx?: number;
}

/** UI-KITS §7.1's web rows, the React suite's short landscape rows, 200 % zoom and a 24 px root. */
const SIZES: Size[] = [
  { label: "320", width: 320, height: 640 },
  { label: "390", width: 390, height: 844 },
  { label: "844x390", width: 844, height: 390 },
  { label: "640x360", width: 640, height: 360 },
  { label: "568x320", width: 568, height: 320 },
  { label: "667x375", width: 667, height: 375 },
  { label: "768", width: 768, height: 1024 },
  { label: "820x1180", width: 820, height: 1180 },
  { label: "1180x820", width: 1180, height: 820 },
  { label: "800x600", width: 800, height: 600 },
  { label: "1024", width: 1024, height: 768 },
  { label: "1440", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560", width: 2560, height: 1440 },
  { label: "1280x800-zoom200", width: 640, height: 400 },
  { label: "390-font24", width: 390, height: 844, rootPx: 24 },
];
const BASELINE_SIZES = SIZES.filter(
  (size) => size.label === "390" || size.label === "1440",
);
const NATIVE_SIZES = SIZES.filter((s) =>
  ["390", "1440", "667x375"].includes(s.label),
);
const SCHEMES = ["dark", "light"] as const;
type Scheme = (typeof SCHEMES)[number];

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
  root = null;
  host = null;
  document.documentElement.style.fontSize = "";
  document.body.style.background = "";
});

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()));

const COMPONENTS = Kit as unknown as Record<
  string,
  (p: Kit.KitProps & { children?: ReactNode }) => ReactNode
>;

/** The corpus elides the served device code; a visual render must show a real grouped value. */
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

function fixtureFor(scene: Scene): ComponentStateFixture {
  if (scene.fixture) return scene.fixture;
  const row = scene.row === undefined ? undefined : ROWS[scene.row];
  if (!row) throw new Error(`no ui-matrix row "${scene.row ?? scene.id}"`);
  return {
    id: scene.id,
    component: row.expect.component,
    state: row.expect.state,
    input: row.input,
    row: row.name,
  };
}

async function mount(
  scene: Scene,
  scheme: Scheme,
  preset: "polaris-key" | "native",
  rootPx = 16,
): Promise<HTMLElement> {
  const fixture = fixtureFor(scene);
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.body.style.margin = "0";
  // A host page: light or dark ground (the native preset resolves against it).
  document.body.style.background = scheme === "dark" ? "#101114" : "#ffffff";
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  host = document.createElement("div");
  document.body.append(host);
  const Component = COMPONENTS[fixture.component];
  if (!Component)
    throw new Error(`no React kit component "${fixture.component}"`);
  const input: UiInput = {
    elapsedMs: 60_000,
    ...withDefaults(fixture.input, matrix.vocabulary.defaults),
    ...extras(fixture.input),
  };
  root = createRoot(host);
  root.render(
    <Component
      input={input}
      fill={LAYOUTS[fixture.component].kind === "screen"}
      theme={{
        product: PRODUCT,
        colorScheme: preset === "native" ? "system" : scheme,
        preset,
      }}
    >
      <main data-host-content="">
        <p>The app</p>
      </main>
    </Component>,
  );
  for (let i = 0; i < 100 && !host.querySelector(".pk-root"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await document.fonts.ready;
  await frame();
  // The step's entrance runs to its end before anything is measured (a fade blends colours).
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  await frame();
  await frame();
  return host;
}

function describeEl(el: Element): string {
  const data = [...el.attributes]
    .filter((a) => a.name.startsWith("data-") || a.name === "class")
    .map((a) => `[${a.name}=${a.value}]`)
    .join("");
  return `<${el.tagName.toLowerCase()}${data}> "${(el.textContent ?? "").trim().slice(0, 30)}"`;
}

function visible(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return null;
  return r;
}

/** The part of `el` its clipping ancestors let through (text inside a visually hidden label,
 *  the moving part of a progress bar), or null when they hide it all. */
function shown(el: Element): DOMRect | null {
  const r = visible(el);
  if (!r) return null;
  let { left, right } = r;
  for (let a = el.parentElement; a; a = a.parentElement) {
    if (getComputedStyle(a).overflowX === "visible") continue;
    const box = a.getBoundingClientRect();
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
    if (right <= left) return null;
  }
  return new DOMRect(left, r.top, right - left, r.height);
}

function sidewaysOverflow(): string[] {
  const vw = document.documentElement.clientWidth;
  const out: string[] = [];
  if (document.documentElement.scrollWidth > vw + 1)
    out.push(
      `the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`,
    );
  for (const el of document.querySelectorAll(".pk-root *")) {
    const r = shown(el);
    if (!r || (r.width <= 1 && r.height <= 1)) continue;
    // The ambient's decoration bleeds by design and is clipped by its stage.
    if (el.closest(".ambient")) continue;
    if (r.left < -1 || r.right > vw + 1)
      out.push(
        `${describeEl(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`,
      );
  }
  return out;
}

function smallTargets(): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll(
    ".pk-root button, .pk-root input, .pk-root [role=radio], .pk-root a[href]",
  )) {
    const r = visible(el);
    if (r && (r.width < 24 || r.height < 24))
      out.push(
        `${describeEl(el)} is ${Math.round(r.width)}x${Math.round(r.height)}`,
      );
  }
  return out;
}

function inFirstViewport(el: Element | null): string | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.top >= -1 &&
    r.bottom <= innerHeight + 1 &&
    r.left >= -1 &&
    r.right <= innerWidth + 1
    ? null
    : `${describeEl(el)} at ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight}`;
}

async function contrast(): Promise<string[]> {
  const kits = [...document.querySelectorAll(".pk-root")];
  if (kits.length === 0) return [];
  const result = await axe.run(
    { include: kits } as unknown as axe.ElementContext,
    { runOnly: { type: "rule", values: ["color-contrast"] } },
  );
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary}`),
  );
}

function offFont(preset: "polaris-key" | "native"): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll(".pk-root *")) {
    if (!visible(el)) continue;
    if (
      ![...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
      )
    )
      continue;
    const f = getComputedStyle(el).fontFamily.replace(/["']/g, "");
    const ok =
      preset === "native"
        ? !f.startsWith("Rubik")
        : f.startsWith("Rubik") || f.startsWith("JetBrains Mono");
    if (!ok) out.push(`${describeEl(el)}: ${f}`);
  }
  return out;
}

async function check(
  scene: Scene,
  scheme: Scheme,
  size: Size,
  preset: "polaris-key" | "native",
): Promise<void> {
  await page.viewport(size.width, size.height);
  await mount(scene, scheme, preset, size.rootPx);
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/react.${scene.id}/${size.label}-${scheme}${preset === "native" ? "-native" : ""}.png`,
    );
  if (
    __PKEY_KIT_BASELINES__ &&
    scene.baseline &&
    preset === "polaris-key" &&
    BASELINE_SIZES.some((baseline) => baseline.label === size.label)
  )
    await commands.kitShot(
      `${__PKEY_KIT_BASELINES__}/${scene.id}/${size.label}-${scheme}.png`,
    );
  const kit = document.querySelector<HTMLElement>(".pk-root");
  // A licensed gate correctly gets out of the way: its baseline is the host app, not a kit root.
  if (!kit) {
    expect(scene.id).toBe("PolarisKeyGate.licensed");
    expect(document.querySelector("[data-host-content]")).not.toBeNull();
    return;
  }
  expect(sidewaysOverflow().join("\n")).toBe("");
  // One h1 at most; a screen whose view names a title has exactly one, in the first viewport (a
  // step inside the sign-in form whose view carries no title, Activate's key step, has none).
  const h1s = [...kit!.querySelectorAll("h1")].filter((h) => visible(h));
  expect(h1s.length, "at most one h1").toBeLessThanOrEqual(1);
  if (kit!.querySelector(".stage")) {
    if (h1s[0]) expect(inFirstViewport(h1s[0])).toBeNull();
    expect(
      inFirstViewport(kit!.querySelector('[data-variant="primary"]')),
    ).toBeNull();
  }
  expect(smallTargets().join("\n")).toBe("");
  expect((await contrast()).join("\n")).toBe("");
  expect(offFont(preset).join("\n")).toBe("");
  expect(document.documentElement.getAttribute("style") ?? "").not.toMatch(
    /--pk-/,
  );
}

describe("the React kit at every size", () => {
  for (const scene of SCENES)
    describe(scene.id, () => {
      for (const scheme of SCHEMES)
        for (const size of SIZES)
          it(`${size.label} ${scheme}`, () =>
            check(scene, scheme, size, "polaris-key"));
      if (scene.native)
        for (const scheme of SCHEMES)
          for (const size of NATIVE_SIZES)
            it(`${size.label} ${scheme} native`, () =>
              check(scene, scheme, size, "native"));
    });
});

describe("the complete fixture baseline matrix", () => {
  it("selects all 133 registered non-hidden component states exactly once", () => {
    const expected = [...REGISTERED_COMPONENT_STATE_IDS].sort();
    const actual = BASELINE_SCENES.map((scene) => scene.id).sort();
    expect(expected).toHaveLength(133);
    expect(actual).toHaveLength(133);
    expect(new Set(actual).size).toBe(133);
    expect(actual).toEqual(expected);
  });

  for (const scheme of SCHEMES)
    for (const size of BASELINE_SIZES)
      for (const scene of BASELINE_SCENES)
        it(`${scene.id} at ${size.label} ${scheme}`, () =>
          check(scene, scheme, size, "polaris-key"));
});
