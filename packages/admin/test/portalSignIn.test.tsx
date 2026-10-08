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
  window.sessionStorage.clear();
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
    ).toBe("username webauthn");
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

  it("ends the code step for an account that can't sign in: no Continue, no resend, a different email", async () => {
    signedOut(CAPS_ALL, {
      "POST /api/signin/email/verify": {
        status: 403,
        body: {
          error: "forbidden",
          message: "This account can't sign in.",
        },
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
      "481207",
    );
    // A terminal step (SIGN-IN.md §3.13): its own h1, focused, and nothing that would end the
    // same way again.
    const title = await screen.findByRole("heading", {
      level: 1,
      name: "This account can't sign in",
    });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(
      screen.getByText(/belongs to an account that can't sign in/).textContent,
    ).toBe(
      "mara@fennick.studio belongs to an account that can't sign in. Try a different email or another way to sign in.",
    );
    expect(screen.queryByRole("textbox", { name: "6-digit code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByText(/Send a new code/)).toBeNull();
    expect(screen.queryByText(/Polaris Key support/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
    // The way on: the email step, empty.
    await userEvent.click(
      screen.getByRole("button", { name: "Use a different email" }),
    );
    const email = await screen.findByRole("textbox", { name: "Email" });
    expect((email as HTMLInputElement).value).toBe("");
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

  it("never sends the carried key: not in the email start, the SSO link or a provider link", async () => {
    const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
    window.history.replaceState(null, "", `/#/?activate=${KEY}&tab=x`);
    signedOut({
      ...CAPS_ALL,
      auth: { ...CAPS_ALL.auth, providers: ["apple", "google", "steam"] },
    });
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Sign in to add Mossgarden",
    });
    const sso = screen.getByRole("link", { name: /single sign-on/ });
    expect(sso.getAttribute("href")).not.toContain("pkey_");
    expect(decodeURIComponent(sso.getAttribute("href")!)).toContain("tab=x");
    const providers = within(
      screen.getByRole("group", { name: "Or continue with" }),
    ).getAllByRole("link");
    expect(providers).toHaveLength(3);
    for (const p of providers)
      expect(p.getAttribute("href")).not.toContain("pkey_");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Check your email" });
    const start = vi
      .mocked(fetch)
      .mock.calls.find(([u]) => String(u).includes("/api/signin/email/start"))!;
    expect(String(start[1]!.body)).not.toContain("pkey_");
    // Email-code sign-in stays in this tab, so the key stays in the tab's URL.
    expect(window.location.hash).toContain(`activate=${KEY}`);
  });

  it("keeps the key in this tab across a navigating sign-in, then puts it back once", async () => {
    const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
    window.history.replaceState(null, "", `/#/?activate=${KEY}`);
    const { stashCarriedKey, restoreCarriedKey } =
      await import("../src/portal/carriedKey.js");
    stashCarriedKey();
    expect(window.sessionStorage.getItem("pk-portal-carried-key")).toBe(KEY);
    // Back from the provider: the return URL had no key.
    window.history.replaceState(null, "", "/#/");
    restoreCarriedKey();
    expect(window.location.hash).toBe(`#/?activate=${KEY}`);
    expect(window.sessionStorage.getItem("pk-portal-carried-key")).toBeNull();
    window.history.replaceState(null, "", "/#/");
    restoreCarriedKey();
    expect(window.location.hash).toBe("#/");
  });

  it("offers Send a new code at once when the tries run out", async () => {
    signedOut(CAPS_ALL, {
      "POST /api/signin/email/verify": {
        status: 400,
        body: { error: "invalid_code", message: "x", triesLeft: 0 },
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
      "000000",
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many tries. Send a new code.",
    );
    expect(
      screen.getByRole("button", { name: "Send a new code" }),
    ).toBeTruthy();
    // The resent region stays in the tree while empty (visually hidden, never display:none).
    expect(
      screen.getAllByRole("status").some((el) => el.className === "sr-only"),
    ).toBe(true);
  });

  describe("Send a new code (PX-W4)", () => {
    /** Type the address, Continue, and wait for the code step. */
    async function toCodeStep(): Promise<void> {
      await userEvent.type(
        await screen.findByRole("textbox", { name: "Email" }),
        "mara@fennick.studio",
      );
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("heading", {
        level: 1,
        name: "Check your email",
      });
    }

    it("counts down from the start's resendIn", async () => {
      signedOut(CAPS_ALL, {
        "POST /api/signin/email/start": {
          ok: true,
          expiresIn: 600,
          codeLength: 6,
          resendIn: 30,
        },
      });
      renderPortal();
      await toCodeStep();
      expect(
        screen.getByText(/^Send a new code in 0:(30|29|28)$/),
      ).toBeTruthy();
    });

    it("resends this sign-in (never a second start) and restarts the countdown from the answer", async () => {
      signedOut(CAPS_ALL, {
        "POST /api/signin/email/start": { ok: true, resendIn: 0 },
        "POST /api/signin/email/resend": {
          ok: true,
          expiresIn: 600,
          codeLength: 6,
          resendIn: 45,
        },
      });
      renderPortal();
      await toCodeStep();
      await userEvent.click(
        screen.getByRole("button", { name: "Send a new code" }),
      );
      expect(
        await screen.findByText(
          "We sent a new code and link to mara@fennick.studio.",
        ),
      ).toBeTruthy();
      expect(screen.getByText(/^Send a new code in 0:4[3-5]$/)).toBeTruthy();
      // The button became a countdown: focus is on the code, not lost to the page.
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "6-digit code" }),
      );
      expect(
        fetchedRequests().filter((r) =>
          r.startsWith("POST /api/signin/email/"),
        ),
      ).toEqual([
        "POST /api/signin/email/start",
        "POST /api/signin/email/resend",
      ]);
      // No body: the Worker reads the address from this tab's sign-in.
      const resend = vi
        .mocked(fetch)
        .mock.calls.find(([u]) =>
          String(u).includes("/api/signin/email/resend"),
        )!;
      expect(resend[1]!.body).toBeUndefined();
      expect(await axeViolations()).toEqual([]);
    });

    it("asked too soon, shows the Worker's wait as the countdown", async () => {
      signedOut(CAPS_ALL, {
        "POST /api/signin/email/start": { ok: true, resendIn: 0 },
        "POST /api/signin/email/resend": {
          status: 429,
          body: {
            error: "rate_limited",
            message: "Wait a minute, then send a new code.",
            retryAfter: 42,
          },
        },
      });
      renderPortal();
      await toCodeStep();
      await userEvent.click(
        screen.getByRole("button", { name: "Send a new code" }),
      );
      expect(
        await screen.findByText(/^Send a new code in 0:(42|41|40)$/),
      ).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Send a new code" }),
      ).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "6-digit code" }),
      );
    });

    it("a bare 429 from the edge (no JSON) is a retry-later error, not the cap", async () => {
      signedOut(CAPS_ALL, {
        "POST /api/signin/email/start": { ok: true, resendIn: 0 },
        "POST /api/signin/email/resend": { status: 429, body: undefined },
      });
      renderPortal();
      await toCodeStep();
      await userEvent.click(
        screen.getByRole("button", { name: "Send a new code" }),
      );
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Too many codes. Try again in a few minutes.",
      );
      expect(screen.queryByText(/No more codes can be sent/)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Send a new code" }),
      ).toBeTruthy();
    });

    it("at the sign-in's limit, says no more codes can be sent and the latest still works", async () => {
      signedOut(CAPS_ALL, {
        "POST /api/signin/email/start": { ok: true, resendIn: 0 },
        "POST /api/signin/email/resend": {
          status: 429,
          body: {
            error: "rate_limited",
            message: "Too many codes for this sign-in. Start again.",
          },
        },
      });
      renderPortal();
      await toCodeStep();
      await userEvent.click(
        screen.getByRole("button", { name: "Send a new code" }),
      );
      expect(
        await screen.findByText(
          "No more codes can be sent for this sign-in. The latest code still works.",
        ),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Send a new code" }),
      ).toBeNull();
      expect(screen.queryByText(/Send a new code in/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      // The button went away: focus is on the code that still works.
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "6-digit code" }),
      );
      expect(
        screen.getByRole("button", { name: "Use a different email" }),
      ).toBeTruthy();
      expect(await axeViolations()).toEqual([]);
    });

    it("an expired sign-in goes back to the email step with the address kept", async () => {
      signedOut(CAPS_ALL, {
        "POST /api/signin/email/start": { ok: true, resendIn: 0 },
        "POST /api/signin/email/resend": {
          status: 400,
          body: {
            error: "signin_expired",
            message: "This sign-in has expired. Start again.",
          },
        },
      });
      renderPortal();
      await toCodeStep();
      await userEvent.click(
        screen.getByRole("button", { name: "Send a new code" }),
      );
      const h1 = await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to Polaris Key",
      });
      await waitFor(() => expect(document.activeElement).toBe(h1));
      expect(
        (screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement)
          .value,
      ).toBe("mara@fennick.studio");
      // The reason is announced with the step change (an alert), not only shown.
      expect(screen.getByRole("alert").textContent).toBe(
        "That sign-in has expired. Continue to get a new code.",
      );
      expect(await axeViolations()).toEqual([]);
      // Continue starts a new sign-in for the kept address.
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("heading", { name: "Check your email" });
      expect(
        fetchedRequests().filter((r) => r === "POST /api/signin/email/start"),
      ).toHaveLength(2);
    });
  });

  it("does not treat the first load as a step change: no announcement", async () => {
    signedOut();
    renderPortal();
    await screen.findByRole("textbox", { name: "Email" });
    expect(document.querySelector("[data-step-announcer]")?.textContent).toBe(
      "",
    );
    expect(document.querySelector("[data-step]")?.className).not.toMatch(
      /animate-pk-step/,
    );
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
