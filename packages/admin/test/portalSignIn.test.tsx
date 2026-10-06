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
    "POST /api/signin/email/start": { ok: true },
    ...extra,
  };
  mockFetch(routes);
  return { signIn: () => (me = { account: ACCOUNT, csrf: "c" }) };
}

describe("LoginCard (SIGN-IN.md §3.1–§3.4, §3.9)", () => {
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
    expect(fetchedRequests()).not.toContain("POST /api/signin/email/start");
  });

  it("says when too many emails were sent", async () => {
    signedOut(CAPS_ALL, {
      "POST /api/signin/email/start": {
        status: 429,
        body: { error: "rate_limited" },
      },
    });
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Too many codes/,
    );
  });

  it("sends a code and a link: one six-cell input, a resend countdown and change-email", async () => {
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
    expect(fetchedRequests()).toContain("POST /api/signin/email/start");
    expect(
      screen.getByText(/We sent a code and a sign-in link to/).textContent,
    ).toBe(
      "We sent a code and a sign-in link to mara@fennick.studio. Both work for 10 minutes.",
    );
    const code = screen.getByRole("textbox", { name: "6-digit code" });
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("inputmode")).toBe("numeric");
    expect(
      (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Send a new code in \d:\d\d/)).toBeTruthy();
    expect(
      screen.getByText("Or open the link in the email. Keep this tab open."),
    ).toBeTruthy();
    expect(document.title).toBe("Check your email · Polaris Key");
    // The live region announces the new step once.
    await waitFor(() =>
      expect(document.querySelector("[data-step-announcer]")?.textContent).toBe(
        "Check your email",
      ),
    );
    expect(await axeViolations()).toEqual([]);
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

  it("signs in on the sixth digit of the code", async () => {
    const s = signedOut(CAPS_ALL, {
      "POST /api/signin/email/verify": () => {
        s.signIn();
        return { status: "signed_in", next: "/" };
      },
    });
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(
      await screen.findByRole("textbox", { name: "6-digit code" }),
      "48 1-207",
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your library" }),
    ).toBeTruthy();
    const verify = vi
      .mocked(fetch)
      .mock.calls.find(([u]) =>
        String(u).includes("/api/signin/email/verify"),
      )!;
    expect(JSON.parse(String(verify[1]!.body))).toEqual({ code: "481207" });
  });

  it("says a wrong code plainly, with the tries left once two or fewer remain", async () => {
    signedOut(CAPS_ALL, {
      "POST /api/signin/email/verify": {
        status: 400,
        body: { error: "invalid_code", message: "x", triesLeft: 2 },
      },
    });
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const code = await screen.findByRole("textbox", { name: "6-digit code" });
    await userEvent.type(code, "000000");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That code isn't right. Check the email and try again. 2 tries left.",
    );
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect((code as HTMLInputElement).value).toBe("");
  });

  it("puts the quiet Have a license key? link under a rule, centred", async () => {
    signedOut();
    renderPortal();
    const link = await screen.findByRole("button", {
      name: "Have a license key?",
    });
    const row = link.closest("[data-quiet-links]")!;
    expect(row.className).toContain("justify-center");
    expect(row.className).toContain("border-t");
    // 24 px from the rule to the text and from the text to the card's edge: 12 px of padding
    // plus half the 44 px target's slack above; the body's 24 / 32 px padding pulled in by
    // 12 / 20 px below.
    expect(row.className).toMatch(/(^| )pt-3( |$)/);
    expect(row.className).toMatch(/(^| )-mb-3( |$)/);
    expect(row.className).toMatch(/(^| )sm:-mb-5( |$)/);
    expect(link.className).toContain("min-h-11");
    expect(row.parentElement!.className).toMatch(/(^| )py-6( |$)/);
    expect(row.parentElement!.className).toMatch(/(^| )sm:py-8( |$)/);
  });

  it("takes a license key before sign-in and carries it through (the on-ramp)", async () => {
    signedOut();
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Have a license key?" }),
    );
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Have a license key?",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    const field = screen.getByRole("textbox", { name: "License key" });
    await userEvent.type(field, "pkey_mossgarden_short");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toMatch(/cut short/);
    await userEvent.clear(field);
    await userEvent.type(field, "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w");
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" && el.textContent === "Key for Mossgarden",
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to add Mossgarden",
      }),
    ).toBeTruthy();
    expect(window.location.hash).toBe(
      "#/?activate=pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in without the key" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to Polaris Key",
      }),
    ).toBeTruthy();
    expect(window.location.hash).not.toContain("activate");
  });

  it("goes Back from the key step to the methods", async () => {
    signedOut();
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Have a license key?" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to Polaris Key",
      }),
    ).toBeTruthy();
  });

  it("has no Polaris Key · key.plrs.im line and no Getting… line", async () => {
    signedOut();
    renderPortal();
    await screen.findByRole("textbox", { name: "Email" });
    expect(document.body.textContent).not.toMatch(/key\.plrs\.im/);
    expect(document.body.textContent).not.toMatch(/Getting the ways/);
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
      await screen.findByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Use the email you bought Nightfall with."),
    ).toBeTruthy();
    expect(screen.getByText("Lanternworks", { exact: false }).textContent).toBe(
      "Nightfall · Lanternworks",
    );
    expect(
      screen.getByText("Your license, downloads and devices"),
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
