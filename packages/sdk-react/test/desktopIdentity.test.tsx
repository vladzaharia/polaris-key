// @pkey-feature ui.kit ui.theme
//
// The desktop kit's identity and theme (UK-06.10), over a fake bridge:
//
//   * an empty theme draws the product's accent, name and verified icon from what the host's
//     Node client reports, with no integrator code and no kit-side fetch;
//   * `host` (the bridge's OS facts) picks the chrome under `platform: "auto"`, gives
//     `preset: "native"` the system accent, and draws Increase Contrast and Reduce Transparency;
//   * every UI-KITS.md §3.1 theme field the web kits take reaches the rendered kit (a table).
//     `serviceCues`, `colors` and `typography` are not in the web kits' theme (reported with this
//     package, not tested here); `poweredBy` is drawn and measured in the browser lane
//     (poweredby.browser.test.tsx).

import { createHash, webcrypto } from "node:crypto";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { coreAccent, resolveKitColors } from "@polaris-key/ui-core/theme";

import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate, Welcome, type KitTheme } from "@polaris-key/react/kit";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeHost, BridgeState } from "../src/desktop/bridge.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "./fixtures.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  // jsdom has no object URLs.
  URL.createObjectURL = () => "blob:icon";
  URL.revokeObjectURL = () => undefined;
  // jsdom's typed arrays are another realm to Node's `crypto.subtle`, which refuses them: hand it
  // a Node copy of the same bytes (the icon check itself is the product's).
  const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation((algo, data) =>
    digest(algo as string, Buffer.from(new Uint8Array(data as ArrayBuffer))),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ICON = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const MEMBER = {
  name: "Driftkart",
  accent: "#ff6a3d",
  accentDark: "#ff8a5c",
  icon: {
    sha256: createHash("sha256").update(ICON).digest("hex"),
    contentType: "image/png",
    original: "https://cdn.example/driftkart.png",
  },
};

type Bridge = ReturnType<typeof makeFakeBridge>;

/** A v4 host: the state carries the presentation member and `host`; the icon crosses `invoke`. */
function hosted(host?: BridgeHost, presentation: unknown = MEMBER) {
  const state = {
    ...emptyBridgeState(),
    presentation,
    ...(host ? { host } : {}),
  } as BridgeState;
  const bridge = makeFakeBridge(state);
  (bridge as { version: number }).version = 4;
  bridge.invoke = vi.fn(async (_s: string, m: string) =>
    m === "presentationIcon" ? ICON.slice() : undefined,
  ) as unknown as Bridge["invoke"];
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
  return { bridge, adapter };
}

function gate(adapter: ReturnType<typeof hosted>["adapter"], theme?: KitTheme) {
  return render(
    <PolarisKeyProvider config={{ productSlug: "acme", adapter }}>
      <PolarisKeyGate {...(theme ? { theme } : {})}>
        <div>APP</div>
      </PolarisKeyGate>
    </PolarisKeyProvider>,
  );
}
const rootOf = (c: HTMLElement) =>
  c.querySelector<HTMLElement>(".pk-root") as HTMLElement;
const ready = (c: HTMLElement) =>
  waitFor(() => expect(rootOf(c)?.dataset.state).toBe("needs-activation"));

describe("the product's identity over the bridge, with zero integrator code", () => {
  it("an empty theme draws the host's accent, name and verified icon", async () => {
    const { adapter, bridge } = hosted();
    const { container } = gate(adapter);
    await ready(container);
    const want = resolveKitColors("#ff8a5c", "dark");
    await waitFor(() =>
      expect(rootOf(container).style.getPropertyValue("--pk-accent")).toBe(
        want.primary,
      ),
    );
    await waitFor(() =>
      expect(
        container.querySelector<HTMLImageElement>('img[data-part="icon"]')?.src,
      ).toMatch(/^blob:/),
    );
    expect(container.querySelector("h1")?.textContent).toContain("Driftkart");
    // The icon came through the host's verified bytes: the renderer fetched nothing itself.
    expect(bridge.invoke).toHaveBeenCalledWith(
      "core",
      "presentationIcon",
      expect.anything(),
    );
    adapter.dispose();
  });

  it("an icon whose bytes do not match the reported hash leaves the monogram", async () => {
    const { adapter } = hosted(undefined, {
      ...MEMBER,
      icon: { ...MEMBER.icon, sha256: "0".repeat(64) },
    });
    const { container } = gate(adapter);
    await ready(container);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('img[data-part="icon"]')).toBeNull();
    expect(container.querySelector('[data-part="monogram"]')).not.toBeNull();
    adapter.dispose();
  });
});

describe("the host's OS facts", () => {
  const CHROMES = [
    ["windows", "windows"],
    ["linux", "gnome"],
    ["macos", "macos"],
  ] as const;
  for (const [os, variant] of CHROMES)
    it(`platform "auto" draws the ${variant} chrome on ${os}`, async () => {
      const { adapter } = hosted({ os });
      const { container } = gate(adapter, { platform: "auto" });
      await ready(container);
      expect(rootOf(container).dataset.pkPlatform).toBe(variant);
      adapter.dispose();
    });

  it("draws the web chrome with no host facts, or without platform: auto", async () => {
    const a = hosted();
    const one = gate(a.adapter, { platform: "auto" });
    await ready(one.container);
    expect(rootOf(one.container).dataset.pkPlatform).toBe("web");
    cleanup();
    const b = hosted({ os: "windows" });
    const two = gate(b.adapter);
    await ready(two.container);
    expect(rootOf(two.container).dataset.pkPlatform).toBe("web");
    a.adapter.dispose();
    b.adapter.dispose();
  });

  it("preset native takes the system accent, resolved for contrast", async () => {
    const { adapter } = hosted({ os: "windows", accentColor: "#0067c0" }, null);
    const { container } = gate(adapter, { preset: "native", platform: "auto" });
    await ready(container);
    const want = resolveKitColors("#0067c0", "dark");
    await waitFor(() =>
      expect(rootOf(container).style.getPropertyValue("--pk-accent")).toBe(
        want.primary,
      ),
    );
    adapter.dispose();
  });

  it("native with no system accent leaves the browser's AccentColor", async () => {
    const { adapter } = hosted({ os: "linux" }, null);
    const { container } = gate(adapter, { preset: "native" });
    await ready(container);
    expect(rootOf(container).style.getPropertyValue("--pk-accent")).toBe("");
    adapter.dispose();
  });

  it("an integrator's accent wins over the system's", async () => {
    const { adapter } = hosted({ os: "macos", accentColor: "#0067c0" }, null);
    const { container } = gate(adapter, {
      preset: "native",
      accent: "#ff6a3d",
    });
    await ready(container);
    expect(rootOf(container).style.getPropertyValue("--pk-accent")).toBe(
      resolveKitColors("#ff6a3d", "dark").primary,
    );
    adapter.dispose();
  });

  it("reports high contrast and reduced transparency on the kit root", async () => {
    const { adapter, bridge } = hosted({ os: "macos" });
    const { container } = gate(adapter);
    await ready(container);
    expect(rootOf(container).dataset.contrast).toBeUndefined();
    expect(rootOf(container).dataset.transparency).toBeUndefined();
    bridge.push({
      ...emptyBridgeState(),
      presentation: MEMBER,
      host: { os: "macos", highContrast: true, reducedTransparency: true },
    } as BridgeState);
    await waitFor(() =>
      expect(rootOf(container).dataset.contrast).toBe("more"),
    );
    expect(rootOf(container).dataset.transparency).toBe("reduce");
    adapter.dispose();
  });
});

describe("every §3.1 theme field the web kits take", () => {
  const input = { elapsedMs: 60_000, gate: { status: "none" } } as const;
  const root = (theme: KitTheme) =>
    rootOf(render(<Welcome input={input} theme={theme} />).container);
  afterEach(cleanup);

  const rows: [string, KitTheme, (r: HTMLElement) => void][] = [
    [
      "preset",
      { preset: "native" },
      (r) => expect(r.dataset.preset).toBe("native"),
    ],
    [
      "colorScheme dark",
      { colorScheme: "dark" },
      (r) => expect(r.dataset.theme).toBe("dark"),
    ],
    [
      "colorScheme light",
      { colorScheme: "light" },
      (r) => expect(r.dataset.theme).toBe("light"),
    ],
    [
      "accent colour",
      { accent: "#ff6a3d", colorScheme: "light" },
      (r) =>
        expect(r.style.getPropertyValue("--pk-accent")).toBe(
          resolveKitColors("#ff6a3d", "light").primary,
        ),
    ],
    [
      "accent core",
      { accent: "core", colorScheme: "dark" },
      (r) =>
        expect(r.style.getPropertyValue("--pk-accent")).toBe(
          resolveKitColors(coreAccent("dark"), "dark").primary,
        ),
    ],
    [
      "density",
      { density: "compact" },
      (r) => expect(r.dataset.density).toBe("compact"),
    ],
    [
      "motion reduced",
      { motion: "reduced" },
      (r) => expect(r.dataset.motion).toBe("reduced"),
    ],
    [
      "motion none",
      { motion: "none" },
      (r) => expect(r.dataset.motion).toBe("reduced"),
    ],
    [
      "motion system",
      { motion: "system" },
      (r) => expect(r.dataset.motion).toBe("full"),
    ],
    [
      "ambient on",
      { ambient: true, preset: "native" },
      (r) => expect(r.querySelector(".ambient")).not.toBeNull(),
    ],
    [
      "ambient off",
      { ambient: false },
      (r) => expect(r.querySelector(".ambient")).toBeNull(),
    ],
    [
      "product name",
      { product: { name: "Tidewater" } },
      (r) => expect(r.textContent).toContain("Tidewater"),
    ],
    [
      "copy override",
      {
        locale: "en",
        product: { name: "Tidewater" },
        copy: { en: { "welcome.title": "Hello there" } },
      },
      (r) => expect(r.textContent).toContain("Hello there"),
    ],

    [
      "platform",
      { platform: "windows" },
      (r) => expect(r.dataset.pkPlatform).toBe("windows"),
    ],
    [
      "platform linux",
      { platform: "linux" },
      (r) => expect(r.dataset.pkPlatform).toBe("gnome"),
    ],
    [
      "radius lg",
      { radius: "lg" },
      (r) =>
        expect(r.style.getPropertyValue("--pk-kit-radius-control")).toBe(
          "1rem",
        ),
    ],
    [
      "radius px",
      { radius: 8 },
      (r) =>
        expect(r.style.getPropertyValue("--pk-kit-radius-control")).toBe(
          "0.5rem",
        ),
    ],
  ];
  for (const [name, theme, check] of rows) it(name, () => check(root(theme)));
});
