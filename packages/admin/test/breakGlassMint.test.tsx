import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { createQueryClient } from "../src/console/data/queryClient.js";
import { qk } from "../src/console/data/queries.js";
import { CiPublishingSection } from "../src/console/sections/core/pages/KeysCi.js";
import {
  LicenseRegistryTokens,
  RegistryTokensPage,
} from "../src/console/sections/feeds/pages/RegistryTokens.js";
import { ME } from "./consoleHarness.js";
import { mountAt } from "./releaseHarness.js";

/**
 * ST-30c.2 (N3): while the session is an emergency sign-in, every action that creates a durable
 * credential is soft-disabled (focusable, `aria-disabled`, the reason on it) and does nothing.
 * The worker refuses them anyway (`break_glass_session`).
 */

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(
        typeof input === "string" ? input : (input as Request).url,
      );
      if (url.includes("ci-publisher")) return json({ ok: true, policy: null });
      if (url.includes("ci-tokens")) return json({ ok: true, tokens: [] });
      if (url.includes("/feeds/tokens"))
        return json({
          ok: true,
          tokens: [],
          registryOrigin: "https://registry.example",
          limits: {},
        });
      return json({ ok: true });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const seeded = (breakGlass: boolean): QueryClient => {
  const client = createQueryClient();
  client.setQueryData(qk.me(), {
    ...ME,
    ...(breakGlass ? { breakGlass } : {}),
  });
  return client;
};

describe("mint actions in an emergency sign-in", () => {
  it("CI publishing: Set trusted publisher… and Issue token… are soft-disabled", async () => {
    mountAt(
      "#/p/djdl/settings/keys",
      <CiPublishingSection slug="djdl" />,
      seeded(true),
    );
    for (const name of ["Set trusted publisher…", "Issue token…"]) {
      const b = await screen.findByRole("button", { name });
      expect(b.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("and they are live in a normal session", async () => {
    mountAt(
      "#/p/djdl/settings/keys",
      <CiPublishingSection slug="djdl" />,
      seeded(false),
    );
    const b = await screen.findByRole("button", { name: "Issue token…" });
    expect(b.getAttribute("aria-disabled")).toBeNull();
  });

  it("product feeds: both registry New token… buttons are soft-disabled", async () => {
    mountAt(
      "#/p/djdl/distribution/feeds/tokens",
      <RegistryTokensPage scope={{ kind: "product", slug: "djdl" }} />,
      seeded(true),
    );
    const buttons = await screen.findAllByRole("button", {
      name: "New token…",
    });
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons)
      expect(b.getAttribute("aria-disabled")).toBe("true");
  });

  it("a licence's Keys tab: New token… is soft-disabled", async () => {
    mountAt(
      "#/p/djdl/license/licenses/lic_1/keys",
      <LicenseRegistryTokens slug="djdl" licenseId="lic_1" />,
      seeded(true),
    );
    const b = await screen.findByRole("button", { name: "New token…" });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(within(document.body).queryByRole("dialog")).toBeNull();
  });
});
