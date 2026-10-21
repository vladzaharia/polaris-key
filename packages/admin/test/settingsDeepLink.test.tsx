/**
 * ST-10: a palette deep link (`?setting=<key>`) lands on the setting's row in All settings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import type * as ApiModule from "../src/api.js";
import { SettingsAllPage } from "../src/console/sections/core/pages/SettingsAll.js";
import { SETTINGS_INDEX } from "../src/console/settings.generated.js";
import { ALL_ON, ME } from "./consoleHarness.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  me: vi.fn(),
  product: vi.fn(),
  productSettings: vi.fn(),
}));
vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../src/api.js");
  return {
    ...actual,
    api: new Proxy(actual.api, {
      get: (t, k: string) =>
        k in fns
          ? (...a: unknown[]) =>
              (fns as Record<string, (...x: unknown[]) => unknown>)[k]!(...a)
          : (t as unknown as Record<string, unknown>)[k],
    }),
  };
});

describe("the deep link", () => {
  beforeEach(() => {
    resetCore();
    for (const f of Object.values(fns)) f.mockReset();
    fns.me.mockResolvedValue({ ...ME, platformAdmin: true });
    fns.product.mockResolvedValue({
      product: { slug: "djdl", name: "DJDL", services: ALL_ON },
    });
    fns.productSettings.mockResolvedValue({ settings: [] });
  });
  afterEach(cleanup);

  it("lands on the setting's row in All settings", async () => {
    const e = SETTINGS_INDEX.find(
      (x) =>
        x.scope === "product" &&
        x.rbacArea === "core" &&
        x.service === "core" &&
        x.pending === null &&
        x.deprecated === null,
    )!;
    const { container } = renderAt(
      `#/p/djdl/settings/all?setting=${encodeURIComponent(e.key)}`,
      <SettingsAllPage slug="djdl" />,
    );
    await waitFor(() =>
      expect(document.activeElement?.id).toBe(`all-setting-${e.key}`),
    );
    await expectNoAxeViolations(container);
  });
});
