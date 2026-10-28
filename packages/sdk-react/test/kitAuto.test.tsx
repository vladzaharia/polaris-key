// @pkey-feature ui.kit identity.autosignin
//
// Automatic sign-in in the gate (I-46.8): `<PolarisKeyGate>` calls `identity.autoSignIn()` once at
// boot, unless the Provider says `autoSignIn={false}`. A confirm shows the consent lines and
// Continue completes with them; Use another account shows the methods; a license list, a device
// limit and "needs sign-in" reach the existing steps; "unavailable" changes nothing.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import type { AutoSignInResult } from "../src/core/index.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  CONSENT,
  VIEW_FREE,
  VIEW_FULL,
  VIEW_FULL_FIXED,
  VIEW_FULL_LINKED,
  stubResizeObserver,
} from "./autoFixtures.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "./fixtures.js";

beforeAll(stubResizeObserver);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(
  result: AutoSignInResult | null,
  over: { off?: boolean; complete?: unknown } = {},
) {
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(emptyBridgeState()),
    now: () => NOW_SEC,
  });
  const autoSignIn = vi.fn(async (): Promise<AutoSignInResult> => {
    if (result === null) throw new Error("not asked");
    return result;
  });
  const complete = vi.fn(
    async () => over.complete ?? { kind: "ok", licenseId: null },
  );
  const cancel = vi.fn(async () => ({ kind: "ok" }));
  Object.assign(adapter, {
    autoSignIn,
    choice: {
      licenses: async () => ({ kind: "ok", view: VIEW_FREE }),
      devices: async () => ({ kind: "ok", view: {} }),
      complete,
      cancel,
    },
  });
  const view = render(
    <PolarisKeyProvider
      config={{ productSlug: "acme", adapter }}
      {...(over.off ? { autoSignIn: false } : {})}
    >
      <PolarisKeyGate theme={{ product: { name: "Acme Studio" } }}>
        <div data-testid="app">APP</div>
      </PolarisKeyGate>
    </PolarisKeyProvider>,
  );
  return { adapter, autoSignIn, complete, cancel, ...view };
}

const control = (c: HTMLElement, key: string) =>
  c.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);
/** Waits until the control is drawn. */
const shows = (m: { container: HTMLElement }, key: string) =>
  waitFor(() => expect(control(m.container, key)).not.toBeNull());

describe("automatic sign-in in the gate", () => {
  it("runs once at boot and shows the confirm; Continue sends the consent", async () => {
    const m = mount({
      kind: "confirm",
      grant: "sg_1",
      expiresIn: 300,
      consent: CONSENT,
    });
    await shows(m, "signin.auto.confirm.primary");
    expect(m.autoSignIn).toHaveBeenCalledTimes(1);
    expect(m.container.textContent).toContain("maya@example.com");
    fireEvent.click(control(m.container, "signin.auto.confirm.primary")!);
    await waitFor(() => expect(m.complete).toHaveBeenCalled());
    expect(m.complete).toHaveBeenCalledWith("sg_1", undefined, {
      consent: { claims: ["email", "name"] },
    });
  });

  it("Use another account gives the grant up and shows the methods", async () => {
    const m = mount({
      kind: "confirm",
      grant: "sg_2",
      expiresIn: 300,
      consent: CONSENT,
    });
    await shows(m, "signin.auto.confirm.other");
    fireEvent.click(control(m.container, "signin.auto.confirm.other")!);
    await shows(m, "signin.provider.continue");
    expect(m.cancel).toHaveBeenCalledWith("sg_2");
  });

  it("a license list shows the existing license choice", async () => {
    const m = mount({
      kind: "choose",
      grant: "sg_3",
      expiresIn: 300,
      choices: VIEW_FREE,
    });
    await shows(m, "signin.choice.continue");
  });

  it("needs sign-in (no link) shows the form with the provider's button", async () => {
    const m = mount({ kind: "needsSignIn", reason: "noLink" });
    await shows(m, "signin.provider.continue");
  });

  for (const reason of ["signedOut", "noCredential"] as const)
    it(`${reason}: Welcome, then Sign in shows the methods with the Google button`, async () => {
      const m = mount({ kind: "needsSignIn", reason });
      await shows(m, "welcome.signIn");
      // Not the form at boot...
      expect(control(m.container, "signin.provider.continue")).toBeNull();
      fireEvent.click(control(m.container, "welcome.signIn")!);
      await shows(m, "signin.provider.continue");
      expect(
        control(m.container, "signin.provider.continue")!.textContent,
      ).toContain("Google");
    });

  it("the provider's button asks with the chooser and lifts a sign-out", async () => {
    const m = mount({ kind: "needsSignIn", reason: "noLink" });
    await shows(m, "signin.provider.continue");
    m.autoSignIn.mockResolvedValueOnce({
      kind: "confirm",
      grant: "sg_4",
      expiresIn: 300,
      consent: CONSENT,
    });
    fireEvent.click(control(m.container, "signin.provider.continue")!);
    await shows(m, "signin.auto.confirm.primary");
    expect(m.autoSignIn).toHaveBeenLastCalledWith({
      prompt: "optional",
      explicit: true,
    });
  });

  it("unavailable falls back to the normal sign-in, silently", async () => {
    const m = mount({ kind: "unavailable", code: "runtime" });
    await shows(m, "welcome.signIn");
    expect(m.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("autoSignIn={false} on the Provider never asks", async () => {
    const m = mount(null, { off: true });
    await shows(m, "welcome.signIn");
    expect(m.autoSignIn).not.toHaveBeenCalled();
  });
});

describe("automatic sign-in: device limit, Replace and the return (KFA-react)", () => {
  const MANAGE = "https://key.plrs.im/m";

  /** The page opens a tab (a spy), the person returns (focus). */
  function back(): void {
    window.dispatchEvent(new Event("focus"));
  }

  it("a device limit with no rows is its own step: Replace, Use another account, Cancel", async () => {
    const m = mount({ kind: "deviceLimit", manageUrl: MANAGE });
    await shows(m, "signin.deviceLimit.replace");
    const keys = [...m.container.querySelectorAll("button[data-key]")].map(
      (b) => b.getAttribute("data-key"),
    );
    expect(keys).toEqual([
      "signin.deviceLimit.replace",
      "signin.auto.confirm.other",
      "common.cancel",
    ]);
    // Never the key screen.
    expect(m.container.querySelector("#pk-key")).toBeNull();
    expect(control(m.container, "signin.key.differentKey")).toBeNull();
    expect(
      control(m.container, "signin.deviceLimit.replace")!.getAttribute(
        "data-variant",
      ),
    ).toBe("primary");
  });

  it("after Replace opened the browser, coming back runs the provider sign-in once more", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const m = mount({ kind: "deviceLimit", manageUrl: MANAGE });
    await shows(m, "signin.deviceLimit.replace");
    expect(m.autoSignIn).toHaveBeenCalledTimes(1);
    fireEvent.click(control(m.container, "signin.deviceLimit.replace")!);
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]![0])).toContain(MANAGE);
    m.autoSignIn.mockResolvedValueOnce({
      kind: "confirm",
      grant: "sg_9",
      expiresIn: 300,
      consent: CONSENT,
    });
    back();
    await shows(m, "signin.auto.confirm.primary");
    expect(m.autoSignIn).toHaveBeenCalledTimes(2);
    expect(m.autoSignIn).toHaveBeenLastCalledWith({
      prompt: "optional",
      explicit: true,
    });
    // Once per Replace.
    back();
    expect(m.autoSignIn).toHaveBeenCalledTimes(2);
  });

  it("with no link the step says so and offers no Replace", async () => {
    const m = mount({ kind: "deviceLimit" });
    await shows(m, "signin.auto.confirm.other");
    expect(control(m.container, "signin.deviceLimit.replace")).toBeNull();
    expect(
      m.container.querySelector('[data-key="deviceLimit.noManage"]'),
    ).not.toBeNull();
  });

  it("Cancel leaves the step for Welcome", async () => {
    const m = mount({ kind: "deviceLimit", manageUrl: MANAGE });
    await shows(m, "common.cancel");
    fireEvent.click(control(m.container, "common.cancel")!);
    await shows(m, "welcome.signIn");
  });

  it("a full row whose license has no link of its own replaces through the refusal's manageUrl", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const m = mount({
      kind: "deviceLimit",
      view: VIEW_FULL,
      manageUrl: MANAGE,
    });
    await shows(m, "signin.replace.open");
    // The new full-row layout: name, then pill, count and tag on one line.
    const row = m.container.querySelector('[data-part="license-row"]')!;
    expect(row.getAttribute("data-layout")).toBe("full");
    expect(row.querySelector(".row-name")?.textContent).toBe("Tidewater Pro");
    expect(row.querySelector(".row-line .pill")?.textContent).toBe("Pro");
    fireEvent.click(control(m.container, "signin.replace.open")!);
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]![0])).toContain(MANAGE);
    m.autoSignIn.mockResolvedValueOnce({
      kind: "signedIn",
      via: "stored",
      subject: null,
    });
    back();
    await waitFor(() => expect(m.autoSignIn).toHaveBeenCalledTimes(2));
  });

  it("the row's own link wins over the refusal's", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const m = mount({
      kind: "deviceLimit",
      view: VIEW_FULL_LINKED,
      manageUrl: MANAGE,
    });
    await shows(m, "signin.replace.open");
    fireEvent.click(control(m.container, "signin.replace.open")!);
    expect(String(open.mock.calls[0]![0])).toContain("free-device");
  });

  it("when no row can replace, there is no Replace button", async () => {
    const m = mount({
      kind: "deviceLimit",
      view: VIEW_FULL_FIXED,
      manageUrl: MANAGE,
    });
    await shows(m, "common.cancel");
    expect(control(m.container, "signin.replace.open")).toBeNull();
  });
});

describe("automatic sign-in: the confirm step and the Google button (KFA-react)", () => {
  it("the confirm has Continue and Use another account only, the license line strong and lower case", async () => {
    const m = mount({
      kind: "confirm",
      grant: "sg_1",
      expiresIn: 300,
      consent: CONSENT,
    });
    await shows(m, "signin.auto.confirm.primary");
    expect(control(m.container, "common.cancel")).toBeNull();
    const line = m.container.querySelector(
      '[data-key="signin.consent.licenseLine"]',
    )!;
    expect(line.className).toBe("consent-line");
    expect(line.textContent).toMatch(/becomes device 2 of 3/);
    // Mid-line: lower case, never "This device".
    expect(line.textContent).toMatch(/· this \w+ becomes/);
    expect(
      m.container.querySelector('[data-key="signin.consent.license"]')!
        .className,
    ).toBe("consent-label");
    // "as <email>" is the title's subtitle.
    expect(m.container.querySelector("h1 + .subtitle")?.textContent).toContain(
      "maya@example.com",
    );
  });

  it("Escape on the confirm leaves for Welcome, as Cancel did", async () => {
    const m = mount({
      kind: "confirm",
      grant: "sg_1",
      expiresIn: 300,
      consent: CONSENT,
    });
    await shows(m, "signin.auto.confirm.primary");
    fireEvent.keyDown(m.container.querySelector(".pk-root")!, {
      key: "Escape",
    });
    await shows(m, "welcome.signIn");
    expect(m.cancel).toHaveBeenCalledWith("sg_1");
  });

  it("the Google button carries Google's G and its own fills, never the accent", async () => {
    const m = mount({ kind: "needsSignIn", reason: "noLink" });
    await shows(m, "signin.provider.continue");
    const b = control(m.container, "signin.provider.continue")!;
    expect(b.getAttribute("data-provider")).toBe("google");
    const paths = [...b.querySelectorAll("svg.mark path")].map((p) =>
      p.getAttribute("fill"),
    );
    expect(paths).toEqual(["#EA4335", "#4285F4", "#FBBC05", "#34A853"]);
    expect(b.textContent).toContain("Continue with Google");
  });
});
