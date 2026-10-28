/**
 * Cloud Connect → Setup (CC-16.1): the relay switch with its control, the operator's ceiling
 * read-only, the launch gates in words, and the states around them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { configureAxe } from "vitest-axe";
import type {
  PlatformSettingsView,
  ProductDetail,
  ProductSetting,
} from "../src/api.js";
import { KitProviders } from "../src/kit/KitProviders.js";

const platformAdmin = vi.hoisted(() => ({ allowed: true }));
vi.mock("../src/console/access/useCan.js", () => ({
  useWriteGate: () => ({
    allowed: platformAdmin.allowed,
    canView: true,
    disabledReason: platformAdmin.allowed ? undefined : "No.",
  }),
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
const detail = (connect: boolean): ProductDetail =>
  ({
    slug: "djdl",
    name: "DJDL",
    services: { connect: { enabled: connect } },
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

describe("Cloud Connect → Setup", () => {
  it("shows the relay switch and the operator's ceiling read-only", async () => {
    const { container } = renderPage();
    expect(await screen.findByRole("switch")).toBeTruthy();
    expect(screen.getByText("Monthly relay ceiling")).toBeTruthy();
    expect(
      (await screen.findByTestId("connect-ceiling-value")).textContent,
    ).toBe("500 GiB a month");
    expect(screen.getByText("Set by the platform operator.")).toBeTruthy();
    // The ceiling has no control; the one switch is the relay's.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.queryByText(/not live yet/)).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it("says plainly that Cloud Connect is not live while its gate is off", async () => {
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

  it("draws no gate notice for a member who cannot read the platform list", async () => {
    platformAdmin.allowed = false;
    renderPage();
    await screen.findByText("Monthly relay ceiling");
    expect(platformSettings).not.toHaveBeenCalled();
    expect(screen.queryByText(/not live yet/)).toBeNull();
  });

  it("explains a product with Cloud Connect off", async () => {
    product.mockResolvedValue({ product: detail(false) });
    renderPage();
    expect(
      await screen.findByText("Cloud Connect is off for this product"),
    ).toBeTruthy();
    expect(screen.queryByText("Monthly relay ceiling")).toBeNull();
  });
});
