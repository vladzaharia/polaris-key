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
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "./fixtures.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CONSENT = {
  client: {
    appName: "Acme Studio",
    developerName: null,
    iconUrl: null,
    nameVerified: true,
  },
  as: { provider: "google", email: "maya@example.com" },
  items: [
    { kind: "license", anchor: null, more: 0 },
    { kind: "profile", claims: ["email", "name"] },
  ],
  scopeHash: "0".repeat(64),
  firstTime: true,
  changed: false,
} as never;

const VIEW = {
  state: "many",
  preselected: "lic_pro",
  choices: [
    {
      id: "lic_pro",
      tierName: "Pro",
      origin: "signin",
      state: "free",
      expiresAt: null,
      seats: { used: 1, limit: 3 },
    },
  ],
} as never;

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
      licenses: async () => ({ kind: "ok", view: VIEW }),
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

describe("automatic sign-in in the gate", () => {
  it("runs once at boot and shows the confirm; Continue sends the consent", async () => {
    const m = mount({
      kind: "confirm",
      grant: "sg_1",
      expiresIn: 300,
      consent: CONSENT,
    });
    await waitFor(() =>
      expect(
        control(m.container, "signin.auto.confirm.primary"),
      ).not.toBeNull(),
    );
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
    await waitFor(() =>
      expect(control(m.container, "signin.auto.confirm.other")).not.toBeNull(),
    );
    fireEvent.click(control(m.container, "signin.auto.confirm.other")!);
    await waitFor(() =>
      expect(control(m.container, "signin.provider.continue")).not.toBeNull(),
    );
    expect(m.cancel).toHaveBeenCalledWith("sg_2");
  });

  it("a license list shows the existing license choice", async () => {
    const m = mount({
      kind: "choose",
      grant: "sg_3",
      expiresIn: 300,
      choices: VIEW,
    });
    await waitFor(() =>
      expect(control(m.container, "signin.choice.continue")).not.toBeNull(),
    );
  });

  it("needs sign-in (no link) shows the form with the provider's button", async () => {
    const m = mount({ kind: "needsSignIn", reason: "noLink" });
    await waitFor(() =>
      expect(control(m.container, "signin.provider.continue")).not.toBeNull(),
    );
  });

  it("signed out: Welcome, then Sign in shows the methods with the Google button", async () => {
    const m = mount({ kind: "needsSignIn", reason: "signedOut" });
    await waitFor(() =>
      expect(control(m.container, "welcome.signIn")).not.toBeNull(),
    );
    // Not the form at boot...
    expect(control(m.container, "signin.provider.continue")).toBeNull();
    fireEvent.click(control(m.container, "welcome.signIn")!);
    await waitFor(() =>
      expect(control(m.container, "signin.provider.continue")).not.toBeNull(),
    );
    expect(
      control(m.container, "signin.provider.continue")!.textContent,
    ).toContain("Google");
  });

  it("no credential: Sign in reaches the Google button too", async () => {
    const m = mount({ kind: "needsSignIn", reason: "noCredential" });
    await waitFor(() =>
      expect(control(m.container, "welcome.signIn")).not.toBeNull(),
    );
    fireEvent.click(control(m.container, "welcome.signIn")!);
    await waitFor(() =>
      expect(control(m.container, "signin.provider.continue")).not.toBeNull(),
    );
  });

  it("the provider's button asks with the chooser and lifts a sign-out", async () => {
    const m = mount({ kind: "needsSignIn", reason: "noLink" });
    await waitFor(() =>
      expect(control(m.container, "signin.provider.continue")).not.toBeNull(),
    );
    m.autoSignIn.mockResolvedValueOnce({
      kind: "confirm",
      grant: "sg_4",
      expiresIn: 300,
      consent: CONSENT,
    });
    fireEvent.click(control(m.container, "signin.provider.continue")!);
    await waitFor(() =>
      expect(
        control(m.container, "signin.auto.confirm.primary"),
      ).not.toBeNull(),
    );
    expect(m.autoSignIn).toHaveBeenLastCalledWith({
      prompt: "optional",
      explicit: true,
    });
  });

  it("unavailable falls back to the normal sign-in, silently", async () => {
    const m = mount({ kind: "unavailable", code: "runtime" });
    await waitFor(() =>
      expect(control(m.container, "welcome.signIn")).not.toBeNull(),
    );
    expect(m.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("autoSignIn={false} on the Provider never asks", async () => {
    const m = mount(null, { off: true });
    await waitFor(() =>
      expect(control(m.container, "welcome.signIn")).not.toBeNull(),
    );
    expect(m.autoSignIn).not.toHaveBeenCalled();
  });
});
