// @pkey-feature ui.kit ui.kit.manage ui.theme ui.i18n
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
import { KIT_COPY_EN_LEAN } from "@polaris-key/brand/kit-copy/lean";
import enRest from "../../../brand/src/generated/kit-copy/en-rest.json" with { type: "json" };
import de from "../../../brand/kit-copy/de.json" with { type: "json" };
import es from "../../../brand/kit-copy/es.json" with { type: "json" };
import fr from "../../../brand/kit-copy/fr.json" with { type: "json" };
import it_ from "../../../brand/kit-copy/it.json" with { type: "json" };
import ja from "../../../brand/kit-copy/ja.json" with { type: "json" };
import ko from "../../../brand/kit-copy/ko.json" with { type: "json" };
import ptBR from "../../../brand/kit-copy/pt-BR.json" with { type: "json" };
import zhHans from "../../../brand/kit-copy/zh-Hans.json" with { type: "json" };

import { PolarisKeyProvider } from "@polaris-key/react";
import * as Kit from "@polaris-key/react/kit";
import { kitComponent } from "../../src/kit/kitComponent.js";
import { desktopAdapter } from "../../src/desktop/desktopAdapter.js";
import {
  NOW_SEC,
  emptyBridgeState,
  makeDoc,
  makeFakeBridge,
  okBridgeState,
} from "../fixtures.js";
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
  "cloudSync",
] as const;

const matrix = matrixJson as Obj & { vocabulary: Obj & { defaults: Obj } };
const COMPONENT_ROWS = FAMILIES.flatMap((family) => matrix[family] as Row[]);
const ROWS: Record<string, Row> = Object.fromEntries(
  COMPONENT_ROWS.map((row) => [row.name, row]),
);

beforeAll(async () => {
  // The QR encoder and the settings, device and account rows load on demand.
  await Kit.preloadKitParts();
  // The wire codes' English texts (`core.codes.*`) arrive on demand in the app; the runner's
  // server cannot serve that chunk, so a refusal's render never shows the fallback sentence.
  Kit.provideKitCopy("en", { ...KIT_COPY_EN_LEAN, ...enRest });
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
  // The runner plays a host that can renew: the corpus lists Renew on the expired row, and a kit
  // draws it only for such a host (SwiftUI `renewURL`, Compose `onRenew`).
  if (!("renew" in out)) out["renew"] = { url: "https://example.com/renew" };
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
  // The two key refusals no other key can fix: one focused step each (refusal.ts).
  {
    id: "Activate.key-entry-limit",
    fixture: {
      id: "Activate.key-entry-limit",
      component: "Activate",
      state: "key-entry-limit",
      row: "Activate/key-entry-limit: a link to add the key in Polaris Locker",
      input: {
        ...(ROWS[
          "Activate/key-entry-limit: a link to add the key in Polaris Locker"
        ]!.input as UiInput),
        activation: {
          result: "key-entry-limit",
          manageUrl: "https://key.plrs.im/activate?product=tidewater",
        },
      },
    },
  },
  {
    id: "Activate.license-owned",
    row: "Activate/license-owned: another account holds the license",
  },
  {
    id: "SignIn.key-license-owned",
    row: "SignIn/key-refused: another account holds the key's license",
  },
  { id: "SignIn.methods-web", row: "SignIn/methods: web" },
  { id: "SignIn.error-kept", row: "SignIn/error: a sign-in method failed" },
  { id: "SignIn.code-live", row: "SignIn/code: a device-code sign-in" },
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

// NearbyApproval is not a public export (UXR-kits-v7 B4): the suite draws the internal component.
const COMPONENTS = {
  ...Kit,
  NearbyApproval: kitComponent("NearbyApproval"),
  // The Cloud Sync screens' public exports load on demand: the suite draws the part they load.
  UnlockSync: kitComponent("UnlockSync"),
  RecoveryCode: kitComponent("RecoveryCode"),
  RingChange: kitComponent("RingChange"),
} as unknown as Record<
  string,
  (p: Kit.KitProps & { children?: ReactNode; code?: string }) => ReactNode
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
  locale?: string,
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
      // The recovery code reaches RecoveryCode as a prop, never in the input (U-42.2).
      code={
        fixture.component === "RecoveryCode"
          ? "K7QF-2M9D-XR4T-8WHB-3JNC-6PEZ-V5GD-HT0S"
          : undefined
      }
      fill={LAYOUTS[fixture.component].kind === "screen"}
      theme={{
        product: PRODUCT,
        colorScheme: preset === "native" ? "system" : scheme,
        preset,
        ...(locale === undefined ? {} : { locale }),
      }}
    >
      <main data-host-content="">
        <p>The app</p>
      </main>
    </Component>,
  );
  for (let i = 0; i < 100 && !host.querySelector(".pk-root"); i++)
    await new Promise((r) => setTimeout(r, 20));
  // A launch locale's copy pack loads on demand: wait for the kit to redraw in it.
  if (locale !== undefined)
    for (
      let i = 0;
      i < 150 &&
      host.querySelector(".pk-root")?.getAttribute("lang") !== locale;
      i++
    )
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
  locale?: string,
): Promise<void> {
  await page.viewport(size.width, size.height);
  await mount(scene, scheme, preset, size.rootPx, locale);
  if (__PKEY_KIT_SHOTS__)
    await commands.kitShot(
      `${__PKEY_KIT_SHOTS__}/react.${scene.id}${locale === undefined ? "" : `.${locale}`}/${size.label}-${scheme}${preset === "native" ? "-native" : ""}.png`,
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
  // A control with no name is a line whose fact was missing: never an empty button.
  expect(
    [...kit!.querySelectorAll("button")]
      .filter((b) => !(b.textContent ?? "").trim() && !b.ariaLabel)
      .map(describeEl)
      .join("\n"),
  ).toBe("");
  expect((await contrast()).join("\n")).toBe("");
  expect(offFont(preset).join("\n")).toBe("");
  expect(document.documentElement.getAttribute("style") ?? "").not.toMatch(
    /--pk-/,
  );
}

/** The gate over the app, after a key activation that leaves entries and after a sign-in that
 *  lands: the toast each leaves (shots: react.Gate.toast-entries, react.Gate.toast-signed-in). */
type GateKind = "entries" | "signed-in" | "key-entry-limit" | "license-owned";
/** Set by a test that wants the refusal's Sign in to fail to start (UXR-kits-v7 M1). */
let signInFails = false;
async function gateToast(
  kind: GateKind,
  scheme: Scheme = "dark",
): Promise<void> {
  const bridge = makeFakeBridge(emptyBridgeState());
  if (kind === "entries")
    bridge.submitKey = async () => {
      bridge.push(okBridgeState());
      return { kind: "ok", keyEntries: { used: 1, limit: 3 } };
    };
  else if (kind === "key-entry-limit")
    bridge.submitKey = async () => ({
      kind: "key-entry-limit",
      manageUrl: "https://key.plrs.im/activate?product=tidewater&next=add-key",
      keyEntries: { used: 3, limit: 3 },
    });
  else if (kind === "license-owned")
    bridge.submitKey = async () => ({
      kind: "license-owned",
      signInUrl: "https://key.plrs.im/signin?product=tidewater",
    });
  else bridge.pollSignIn = () => new Promise(() => {});
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
  document.body.style.margin = "0";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <PolarisKeyProvider config={{ productSlug: "tidewater", adapter }}>
      <Kit.PolarisKeyGate theme={{ product: PRODUCT, colorScheme: scheme }}>
        <main data-host-content="">
          <p>The app</p>
        </main>
      </Kit.PolarisKeyGate>
    </PolarisKeyProvider>,
  );
  const until = async (f: () => boolean): Promise<void> => {
    for (let i = 0; i < 150 && !f(); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(f()).toBe(true);
  };
  const press = (key: string): void =>
    host!
      .querySelector<HTMLButtonElement>(`button[data-key="${key}"]`)!
      .click();
  if (kind !== "signed-in") {
    await until(
      () => host!.querySelector('[data-key="welcome.useKey"]') !== null,
    );
    press("welcome.useKey");
    await until(() => host!.querySelector("#pk-key") !== null);
    const field = host!.querySelector<HTMLInputElement>("#pk-key")!;
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    set.call(field, "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpbG");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await frame();
    press("activate.submit");
  } else {
    await until(
      () => host!.querySelector('[data-key="welcome.signIn"]') !== null,
    );
    press("welcome.signIn");
    await until(() => host!.querySelector('[data-key="a11y.code"]') !== null);
    bridge.push(
      okBridgeState({
        doc: makeDoc({
          entitlements: {
            tier: { state: "enforced", value: "Pro", updatedAt: 950 },
          },
        }),
      }),
    );
  }
  if (kind === "key-entry-limit" || kind === "license-owned") {
    await until(
      () =>
        host!.querySelector('[data-key="signin.key.differentKey"]') !== null,
    );
    if (signInFails) {
      bridge.beginSignIn = async () => {
        throw new Error("network");
      };
      press(
        kind === "license-owned"
          ? "signin.key.ownedSignIn"
          : "signin.key.signIn",
      );
      await until(
        () =>
          host!.querySelector(
            '[data-key="core.codes.sign-in-failed.message"]',
          ) !== null,
      );
    }
  } else await until(() => host!.querySelector('[data-part="toast"]') !== null);
  await document.fonts.ready;
  await frame();
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  await frame();
  adapter.dispose();
}

describe("the gate's toasts after a key activation and a sign-in", () => {
  for (const kind of ["entries", "signed-in"] as const)
    for (const size of SIZES.filter((s) =>
      ["320", "390", "1440"].includes(s.label),
    ))
      it(`${kind} ${size.label} dark`, async () => {
        await page.viewport(size.width, size.height);
        await gateToast(kind);
        if (__PKEY_KIT_SHOTS__)
          await commands.kitShot(
            `${__PKEY_KIT_SHOTS__}/react.Gate.toast-${kind}/${size.label}-dark.png`,
          );
        const toast = document.querySelector('[data-part="toast"]')!;
        expect(toast.textContent).toContain(
          kind === "entries" ? "2 key entries left" : "Pro license",
        );
        expect(inFirstViewport(toast)).toBeNull();
        expect(sidewaysOverflow().join("\n")).toBe("");
        expect(document.querySelector("[data-host-content]")).not.toBeNull();
      });
});

describe("the live gate's two key refusals, with its chrome", () => {
  for (const kind of ["key-entry-limit", "license-owned"] as const)
    for (const scheme of SCHEMES)
      for (const size of SIZES.filter((s) =>
        ["320", "390", "844x390", "1440"].includes(s.label),
      ))
        it(`${kind} ${size.label} ${scheme}`, async () => {
          await page.viewport(size.width, size.height);
          await gateToast(kind, scheme);
          if (__PKEY_KIT_SHOTS__)
            await commands.kitShot(
              `${__PKEY_KIT_SHOTS__}/react.Gate.refusal-${kind}/${size.label}-${scheme}.png`,
            );
          expect(document.querySelector("#pk-key")).toBeNull();
          expect(sidewaysOverflow().join("\n")).toBe("");
          expect(smallTargets().join("\n")).toBe("");
          expect(
            inFirstViewport(document.querySelector('[data-variant="primary"]')),
          ).toBeNull();
          expect((await contrast()).join("\n")).toBe("");
        });
});

describe("a refusal's Sign in that fails to start", () => {
  for (const kind of ["key-entry-limit", "license-owned"] as const)
    it(`${kind} says so on the step`, async () => {
      await page.viewport(1440, 900);
      signInFails = true;
      try {
        await gateToast(kind);
        if (__PKEY_KIT_SHOTS__)
          await commands.kitShot(
            `${__PKEY_KIT_SHOTS__}/react.Gate.refusal-${kind}-signin-fails/1440-dark.png`,
          );
        expect(
          document.querySelector(
            '[data-key="core.codes.sign-in-failed.message"]',
          ),
        ).not.toBeNull();
      } finally {
        signInFails = false;
      }
    });
});

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
  it("selects every registered non-hidden component state exactly once", () => {
    const expected = [...REGISTERED_COMPONENT_STATE_IDS].sort();
    const actual = BASELINE_SCENES.map((scene) => scene.id).sort();
    expect(actual).toHaveLength(expected.length);
    expect(new Set(actual).size).toBe(expected.length);
    expect(actual).toEqual(expected);
  });

  for (const scheme of SCHEMES)
    for (const size of BASELINE_SIZES)
      for (const scene of BASELINE_SCENES)
        it(`${scene.id} at ${size.label} ${scheme}`, () =>
          check(scene, scheme, size, "polaris-key"));
});

/** UI-KITS §7.1's variants: the launch locales at the phone-portrait and desktop rows. DL12: the
 *  CJK fallback has its own 600 face, so a heading stays a heading in `ja`, `ko` and `zh-Hans`. */
/** Chromium's dev server cannot serve the packs' lazy JSON imports, so the suite registers them. */
const PACKS: Record<string, { messages: Record<string, string> }> = {
  de,
  es,
  fr,
  it: it_,
  ja,
  ko,
  "pt-BR": ptBR,
  "zh-Hans": zhHans,
};
beforeAll(() => {
  for (const [locale, pack] of Object.entries(PACKS))
    Kit.provideKitCopy(locale, pack.messages);
});

const LOCALES = ["de", "fr", "es", "pt-BR", "it", "ja", "ko", "zh-Hans"];
const LOCALE_SCENES = SCENES.filter((s) =>
  [
    "Welcome.default",
    "Activate.parsed",
    "Devices.list",
    "Settings.list",
  ].includes(s.id),
);

describe("the React kit in the launch locales", () => {
  for (const locale of LOCALES)
    for (const scene of LOCALE_SCENES)
      for (const scheme of SCHEMES)
        for (const size of SIZES.filter((s) =>
          ["390", "1440"].includes(s.label),
        ))
          it(`${scene.id} ${locale} at ${size.label} ${scheme}`, async () => {
            await check(scene, scheme, size, "polaris-key", locale);
            const kit = document.querySelector<HTMLElement>(".pk-root")!;
            expect(kit.closest("[lang]")?.getAttribute("lang")).toBe(locale);
            const h1 = kit.querySelector("h1");
            if (h1) expect(getComputedStyle(h1).fontWeight).toBe("600");
          });
});
