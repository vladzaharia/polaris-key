import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { boot, resetConsole } from "./consoleHarness.js";
import { TestResultView } from "../src/console/sections/platform/pages/platformConnectionParts.js";
import { claimMapOf } from "../src/console/sections/platform/pages/platformConnectionParts.js";
import { CONNECTION_FLOW } from "../src/console/wizard/flows.js";
import { lintFlow } from "../src/ui/wizard/index.js";
import type { PlatformConnection } from "../src/api.js";

/**
 * Platform → Connections (I-31): the page by kind, a connection's domains with the TXT record
 * and the live check, the add wizard's first step, and the claims preview as plain text. No
 * client secret is ever on a page or in a response.
 */

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const BASE = "/manage/api/platform/connections";
const ME = { authAt: Math.floor(Date.now() / 1000) };
const SECRET = "must-never-appear";

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const main = (): HTMLElement => screen.getByRole("main");

const WORK: PlatformConnection = {
  id: "conn_work",
  label: "Work",
  issuer: "https://sso.corp.example",
  clientId: "client-1",
  jwksUri: null,
  audience: "customers",
  claimMap: { groups: "groups", claims: ["department"] },
  status: "active",
  source: "console",
  hasSecret: true,
  domains: [
    {
      domain: "corp.example",
      verified: false,
      verifiedAt: null,
      checkedAt: null,
      enforce: false,
      record: {
        name: "_pkey-challenge.corp.example",
        value: "pkey-domain-verification=tok123",
      },
    },
  ],
  links: 0,
  lastSuccessAt: null,
  lastError: null,
};

const PAGE = {
  connections: [WORK],
  redirectUri: "https://key.plrs.im/callback",
  builtIns: [
    { kind: "google", label: "Google", configured: true },
    { kind: "apple", label: "Apple", configured: false },
    { kind: "steam", label: "Steam", configured: false },
  ],
  email: { configured: true },
  turnstile: { enabled: false },
};

describe("Connections page", () => {
  it("groups by kind, with status as words and no secret", async () => {
    boot("#/platform/connections", { me: ME, extra: { [BASE]: PAGE } });
    await screen.findByRole("heading", { level: 1, name: "Connections" });
    await within(main()).findByRole("link", { name: "Work" });
    expect(main().textContent).toContain("0 of 1 domains verified");
    for (const h of [
      "Single sign-on",
      "Sign-in providers",
      "Email",
      "Turnstile",
    ]) {
      expect(within(main()).getByRole("heading", { name: h })).toBeTruthy();
    }
    expect(within(main()).getAllByText("Not set up")[0]).toBeTruthy();
    expect(main().textContent).not.toContain(SECRET);
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });

  it("first run says what to do", async () => {
    boot("#/platform/connections", {
      me: ME,
      extra: { [BASE]: { ...PAGE, connections: [] } },
    });
    expect(await screen.findByText("No connections yet")).toBeTruthy();
    expect(
      within(main()).getAllByRole("link", { name: /Add connection/ }).length,
    ).toBeGreaterThan(0);
  });
});

describe("one connection", () => {
  it("shows the TXT record to publish and checks it now", async () => {
    const log = boot(`#/platform/connections/conn_work`, {
      me: ME,
      extra: {
        [`${BASE}/conn_work`]: { connection: WORK },
        [BASE]: PAGE,
        [`POST ${BASE}/conn_work/domains/verify`]: {
          ok: true,
          verify: "absent",
          connection: WORK,
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Work" });
    expect(
      await screen.findByText("_pkey-challenge.corp.example"),
    ).toBeTruthy();
    expect(screen.getByText("pkey-domain-verification=tok123")).toBeTruthy();
    expect(main().textContent).toContain("Sealed");
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() =>
      expect(
        log.calls.find(
          (c) => c.method === "POST" && c.path.endsWith("/domains/verify"),
        )?.json,
      ).toEqual({ domain: "corp.example" }),
    );
    expect(await screen.findByText(/Record not found yet/)).toBeTruthy();
  });

  it("a stale sign-in says so before any change", async () => {
    boot(`#/platform/connections/conn_work`, {
      me: { authAt: 1 },
      extra: { [`${BASE}/conn_work`]: { connection: WORK }, [BASE]: PAGE },
    });
    expect(
      (await screen.findAllByText("Sign in again to continue")).length,
    ).toBeGreaterThan(0);
    expect(
      screen
        .getByRole("button", { name: "Check now" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("add wizard", () => {
  it("opens on the provider step and needs a successful check to go on", async () => {
    const log = boot("#/platform/connections/new", {
      me: ME,
      extra: {
        [`POST ${BASE}/discover`]: {
          ok: true,
          discovery: {
            issuer: "https://sso.corp.example",
            authorizationHost: "sso.corp.example",
            tokenHost: "sso.corp.example",
            jwksHost: "sso.corp.example",
            redirectUri: "https://key.plrs.im/callback",
            issParameter: false,
          },
        },
      },
    });
    await screen.findByRole("heading", { level: 2, name: "Which provider?" });
    const cont = screen.getByRole("button", { name: /Continue/ });
    expect(cont.getAttribute("aria-disabled")).toBe("true");
    await userEvent.type(
      screen.getByLabelText(/Issuer/),
      "https://sso.corp.example",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Check provider" }),
    );
    await waitFor(() =>
      expect(log.calls.some((c) => c.path === `${BASE}/discover`)).toBe(true),
    );
    await screen.findByText("Found");
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Continue/ })
          .getAttribute("aria-disabled"),
      ).not.toBe("true"),
    );
  });

  it("the flow is within the kit's rules", () => {
    expect(lintFlow(CONNECTION_FLOW)).toEqual([]);
  });
});

describe("claims preview", () => {
  it("shows the provider's words as plain text, never markup", () => {
    render(
      <TestResultView
        result={{
          ok: false,
          message: "<img src=x onerror=alert(1)> access_denied",
        }}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/access_denied/).textContent).toContain("<img");
  });

  it("lists the mapped values and the names of the claims", () => {
    render(
      <TestResultView
        result={{
          ok: true,
          preview: {
            issuer: "https://sso.corp.example",
            email: "ada@corp.example",
            emailVerified: true,
            name: "Ada",
            groups: ["eng"],
            claims: { department: "Engineering" },
            claimNames: ["email", "groups", "sub"],
          },
        }}
      />,
    );
    expect(screen.getByText("ada@corp.example")).toBeTruthy();
    expect(screen.getByText("eng")).toBeTruthy();
    expect(screen.getByText("department: Engineering")).toBeTruthy();
  });

  it("builds the claim map from the fields", () => {
    expect(
      claimMapOf({ groups: " groups ", claims: "a, b  a", name: "" }),
    ).toEqual({
      groups: "groups",
      claims: ["a", "b"],
    });
  });
});
