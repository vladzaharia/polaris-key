/**
 * Cloud Connect → Setup (CC-16.1): the relay switch with its control, the operator's ceiling
 * read-only, the launch gates in words, and the states around them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type {
  PlatformSettingsView,
  ProductDetail,
  ProductSetting,
} from "../src/api.js";
import { KitProviders } from "../src/kit/KitProviders.js";

const platformAdmin = vi.hoisted(() => ({ allowed: true, connect: true }));
vi.mock("../src/console/access/useCan.js", () => ({
  useWriteGate: (area: string) => {
    const allowed =
      area === "connect" ? platformAdmin.connect : platformAdmin.allowed;
    return {
      allowed,
      canView: true,
      disabledReason: allowed ? undefined : "Ask Ana for Cloud Connect edit.",
    };
  },
  useCan: () => platformAdmin.allowed,
}));

const reads = {
  product: vi.fn(),
  products: vi.fn(),
  platformSettings: vi.fn<() => Promise<PlatformSettingsView>>(),
  productSettings: vi.fn(),
};
const { product, products, platformSettings, productSettings } = reads;

vi.mock("../src/api.js", async (load) => ({
  ...(await load<typeof import("../src/api.js")>()),
  api: {
    product: (slug: string) => reads.product(slug),
    products: () => reads.products(),
    productSettings: (slug: string, area?: string) =>
      reads.productSettings(slug, area),
    platformSettings: () => reads.platformSettings(),
  },
}));

const { ConnectSetupPage } =
  await import("../src/console/sections/connect/ConnectSetup.js");

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const GiB = 1024 ** 3;
const RELAY: ProductSetting = {
  key: "cloudConnect.relay.enabled",
  area: "cloudConnect",
  service: "connect",
  label: "Relay",
  description: "Whether the relay carries this product's device traffic.",
  docs: "",
  spec: { kind: "boolean" },
  confirm: { on: "L0", off: "L1" },
  critical: false,
  manifestPath: "product:connect.relay",
  visibleWhen: { service: "connect", offBehaviour: "hide" },
  serviceEnabled: true,
  value: true,
  source: "default",
  defaultValue: true,
  version: 0,
  updatedAt: null,
  updatedBy: null,
  reason: null,
  rbacArea: "settings",
  ownership: "claimable",
};
const CEILING: ProductSetting = {
  ...RELAY,
  key: "cloudConnect.ceiling.relayBytes",
  label: "Monthly relay ceiling",
  description: "The most relay data all people may use together.",
  spec: { kind: "integer", unit: "bytes", min: 0, max: 1024 ** 5 },
  manifestPath: null,
  value: 500 * GiB,
  defaultValue: 500 * GiB,
  ownership: "operator",
  critical: true,
};
const gateSetting = (key: string, value: "on" | "off") => ({
  key,
  kind: "switch",
  value,
  default: "on",
  label: key,
  area: "launch",
  version: 0,
  stored: null,
  confirm: { on: "L0", off: "L1" },
});
const view = (...s: unknown[]) =>
  ({
    settings: s,
    storeAvailable: true,
    propagationSeconds: 30,
    deployTime: [],
    secrets: [],
  }) as unknown as PlatformSettingsView;
const detail = (connect = true, license = true): ProductDetail =>
  ({
    slug: "djdl",
    name: "DJDL",
    services: {
      connect: { enabled: connect },
      license: { enabled: license },
    },
  }) as ProductDetail;

function renderPage() {
  return render(
    <KitProviders>
      <div data-service="connect">
        <ConnectSetupPage slug="djdl" />
      </div>
    </KitProviders>,
  );
}

beforeEach(() => {
  platformAdmin.allowed = true;
  platformAdmin.connect = true;
  for (const m of Object.values(reads)) m.mockReset();
  product.mockResolvedValue({ product: detail(true) });
  products.mockResolvedValue({ products: [detail(true)] });
  productSettings.mockResolvedValue({ settings: [RELAY, CEILING] });
  platformSettings.mockResolvedValue(
    view(
      gateSetting("launch.connect", "on"),
      gateSetting("launch.relay", "on"),
    ),
  );
});
afterEach(cleanup);

const quota = {
  key: "cloudConnect.quota.defaultRelayBytes",
  kind: "integer",
  value: 2 * GiB,
  default: 2 * GiB,
  min: 0,
  max: 1024 ** 5,
  unit: "bytes",
  label: "Default relay quota",
  area: "cloudConnect",
  version: 0,
  stored: null,
  confirm: { raise: "L2", lower: "L2" },
};

describe("Cloud Connect → Setup", () => {
  it("shows the relay switch and the ceiling with Change…, in one Relay card", async () => {
    const { container } = renderPage();
    expect(await screen.findByRole("switch")).toBeTruthy();
    expect(
      (await screen.findByTestId("connect-ceiling-value")).textContent,
    ).toBe("500 GiB a month");
    expect(screen.getAllByRole("heading", { name: "Relay" })).toHaveLength(1);
    expect(screen.queryByText(/platform operator/)).toBeNull();
    expect(screen.getByText("Platform default")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Change the relay ceiling" }),
    ).toBeTruthy();
    expect(screen.queryByText(/not live yet|is paused/)).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it("opens the ceiling dialog with the relay's own title and field", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Change the relay ceiling" }),
    );
    expect(await screen.findByText("Change the relay ceiling")).toBeTruthy();
    expect(
      screen.getByLabelText("Relay data per month for this product (GiB)"),
    ).toBeTruthy();
  });

  it("says what a ceiling of 0 means", async () => {
    productSettings.mockResolvedValue({
      settings: [RELAY, { ...CEILING, value: 0 }],
    });
    renderPage();
    expect(
      (await screen.findByTestId("connect-ceiling-value")).textContent,
    ).toBe("0 GiB: no relay traffic");
  });

  it("gates Change… on Cloud Connect edit and says who can", async () => {
    platformAdmin.connect = false;
    renderPage();
    await screen.findByTestId("connect-ceiling-value");
    expect(
      screen.queryByRole("button", { name: "Change the relay ceiling" }),
    ).toBeNull();
    expect(
      screen.getAllByText("Ask Ana for Cloud Connect edit.").length,
    ).toBeGreaterThan(0);
  });

  it("names the consequence of turning the relay off", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("switch"));
    await userEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    expect(
      await screen.findByText(/Devices on different networks stop connecting/),
    ).toBeTruthy();
  });

  it("says plainly that Cloud Connect is not live while its gate is off, with a way forward", async () => {
    platformSettings.mockResolvedValue(
      view(
        gateSetting("launch.connect", "off"),
        gateSetting("launch.relay", "off"),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("Cloud Connect is not live yet"),
    ).toBeTruthy();
    expect(screen.getByText(/Launch gate: Cloud Connect is on/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Platform settings" }),
    ).toBeTruthy();
    expect(screen.queryByText("The relay is not live yet")).toBeNull();
  });

  it("says the relay is not live while only its gate is off", async () => {
    platformSettings.mockResolvedValue(
      view(
        gateSetting("launch.connect", "on"),
        gateSetting("launch.relay", "off"),
      ),
    );
    renderPage();
    expect(await screen.findByText("The relay is not live yet")).toBeTruthy();
  });

  it("says the relay is paused while the kill switch is on", async () => {
    platformSettings.mockResolvedValue(
      view(
        gateSetting("launch.connect", "on"),
        gateSetting("launch.relay", "on"),
        gateSetting("cloudConnect.relayPaused", "on"),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("The relay is paused for every product"),
    ).toBeTruthy();
  });

  it("points the per-person quota at the tier editor, with the platform default for a platform admin", async () => {
    platformSettings.mockResolvedValue(view(quota));
    renderPage();
    expect(await screen.findByText("2 GiB a day by default")).toBeTruthy();
    expect(screen.getByText("Relay quota per person")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Edit tiers" }).getAttribute("href"),
    ).toContain("/license/tiers");
  });

  it("leaves the tier quota row out while Licensing is off, as there are no tiers to edit", async () => {
    product.mockResolvedValue({ product: detail(true, false) });
    products.mockResolvedValue({ products: [detail(true, false)] });
    platformSettings.mockResolvedValue(view(quota));
    renderPage();
    await screen.findByText("Monthly relay ceiling");
    expect(screen.queryByText("Relay quota per person")).toBeNull();
  });

  it("draws no platform rows or notices for a member who cannot read the platform list", async () => {
    platformAdmin.allowed = false;
    renderPage();
    await screen.findByText("Monthly relay ceiling");
    expect(platformSettings).not.toHaveBeenCalled();
    expect(screen.queryByText(/not live yet|is paused/)).toBeNull();
    expect(screen.queryByText(/a day by default/)).toBeNull();
    // The row and its link stay: the quota is set per tier, whoever may read the platform list.
    expect(screen.getByRole("link", { name: "Edit tiers" })).toBeTruthy();
  });
});
