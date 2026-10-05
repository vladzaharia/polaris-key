import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderRow } from "../src/portal/components/signin/ProviderRow.js";
import { SESSION_CHANNEL } from "../src/portal/session.js";
import {
  ACCOUNT,
  axeViolations,
  CAPS_ALL,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function signedOut(caps = CAPS_ALL, extra = {}) {
  let me: unknown = { status: 401 };
  const routes = {
    ...signedIn(),
    "/api/me": () => me,
    "/api/capabilities": caps,
    "POST /api/magic/start": { ok: true },
    ...extra,
  };
  mockFetch(routes);
  return { signIn: () => (me = { account: ACCOUNT, csrf: "c" }) };
}

describe("LoginCard on today's auth (PX-05)", () => {
  it("is one card: email first, one primary, then single sign-on", async () => {
    signedOut();
    renderPortal();
    expect(
      (await screen.findByRole("textbox", { name: "Email" })).getAttribute(
        "autocomplete",
      ),
    ).toBe("email");
    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in to Polaris Key" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue" }).className,
    ).toContain("bg-accent");
    const sso = screen.getByRole("link", {
      name: "Continue with single sign-on",
    });
    expect(sso.getAttribute("href")).toMatch(/^\/login\?return_to=/);
    expect(sso.className).not.toContain("bg-accent");
    // No providers until the Worker names them (G11), and never OIDC jargon or "Portal".
    expect(
      screen.queryByRole("group", { name: "Or continue with" }),
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(/OIDC|Portal|Discord/);
    expect(await axeViolations()).toEqual([]);
  });

  it("makes single sign-on the primary when it is the only way in", async () => {
    signedOut({
      ...CAPS_ALL,
      auth: { oidc: true, magic: false, oidcName: "Acme SSO" },
    });
    renderPortal();
    const sso = await screen.findByRole("link", {
      name: "Continue with Acme SSO",
    });
    expect(sso.className).toContain("bg-accent");
    expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
  });

  it("never shows an empty card when no method is on", async () => {
    signedOut({ ...CAPS_ALL, auth: { oidc: false, magic: false } });
    renderPortal();
    expect(
      await screen.findByRole("heading", { name: "Sign-in is turned off" }),
    ).toBeTruthy();
  });

  it("tells a network failure apart, with Retry", async () => {
    mockFetch({ "/api/me": { status: 401 }, "/api/capabilities": "network" });
    renderPortal();
    expect(
      await screen.findByRole("heading", { name: "Can't reach Polaris Key" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("checks the email inline before sending", async () => {
    signedOut();
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const field = screen.getByRole("textbox", { name: "Email" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/full email address/);
    expect(fetchedRequests()).not.toContain("POST /api/magic/start");
  });

  it("says when too many emails were sent", async () => {
    signedOut(CAPS_ALL, {
      "POST /api/magic/start": { status: 429, body: { error: "rate_limited" } },
    });
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Too many sign-in emails/,
    );
  });

  it("sends the link to an honest sent screen with resend and change-email", async () => {
    signedOut();
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Check your email",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(screen.getByText(/It works for 10 minutes/)).toBeTruthy();
    expect(screen.getByText(/this page signs you in by itself/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Resend in \d+ s/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(document.title).toBe("Check your email · Polaris Key");
    await userEvent.click(
      screen.getByRole("button", { name: "Use a different email" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to Polaris Key",
      }),
    ).toBeTruthy();
  });

  it("signs this tab in by itself when the link is used (focus re-check)", async () => {
    const s = signedOut();
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Check your email" });
    s.signIn();
    act(() => {
      fireEvent.focus(window);
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your library" }),
    ).toBeTruthy();
  });

  it("signs in when another tab announces it on the session channel", async () => {
    const s = signedOut();
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Check your email" });
    s.signIn();
    const other = new BroadcastChannel(SESSION_CHANNEL);
    other.postMessage({ type: "signed-in" });
    other.close();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your library" }),
    ).toBeTruthy();
  });

  it("shows the product context header when the Worker names the product", async () => {
    window.history.replaceState(null, "", "/?product=nightfall");
    signedOut({
      ...CAPS_ALL,
      product: {
        slug: "nightfall",
        name: "Nightfall",
        developerName: "Lanternworks",
      },
    });
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in or create an account",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Manage your copy of/).textContent).toBe(
      "Manage your copy of Nightfall",
    );
    expect(
      screen.getByText("Lanternworks · downloads, license and devices"),
    ).toBeTruthy();
    expect(fetchedRequests()).toContain(
      "GET /api/capabilities?product=nightfall",
    );
  });
});

describe("ProviderRow (§4.1)", () => {
  const hrefFor = (p: string) => `/x/${p}`;
  it("is one row, Apple · Google · Steam, logo only and named", () => {
    render(
      <ProviderRow
        providers={["steam", "apple", "google"]}
        hrefFor={hrefFor}
      />,
    );
    const group = screen.getByRole("group", { name: "Or continue with" });
    const links = within(group).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual([
      "Continue with Apple",
      "Continue with Google",
      "Continue with Steam",
    ]);
    for (const l of links) {
      expect(l.textContent).toBe("");
      expect(l.getAttribute("title")).toBe(l.getAttribute("aria-label"));
    }
    expect(group.className).toContain("grid-cols-3");
  });

  it("splits two in halves and keeps one at half width, centred", () => {
    const { rerender } = render(
      <ProviderRow providers={["google", "steam"]} hrefFor={hrefFor} />,
    );
    expect(screen.getByRole("group").className).toContain("grid-cols-2");
    rerender(<ProviderRow providers={["steam"]} hrefFor={hrefFor} />);
    const only = screen.getByRole("link", { name: "Continue with Steam" });
    expect(only.className).toContain("mx-auto");
    expect(only.className).toContain("w-[calc(50%-0.375rem)]");
  });

  it("names the buttons Connect … when adding a method", () => {
    render(
      <ProviderRow
        providers={["apple", "google"]}
        hrefFor={hrefFor}
        mode="connect"
      />,
    );
    expect(screen.getByRole("link", { name: "Connect Apple" })).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Or connect another account" }),
    ).toBeTruthy();
  });

  it("renders nothing without providers", () => {
    const { container } = render(
      <ProviderRow providers={[]} hrefFor={hrefFor} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
