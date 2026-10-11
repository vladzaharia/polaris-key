// @pkey-feature ui.kit ui.gate ui.update ui.signin
//
// The kit draws the arguments ui-core fills (test/uiMatrix.test.ts "no raw placeholder" in
// ui-core): the SDK gate hands the models the date grace ends, in the kit's locale; the models
// format the boot stage's bytes in it; the update prompt's "You have …" names the installed
// version; and a license row never draws an origin it cannot name as "From {store}".

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Boot,
  GraceBanner,
  LicenseChoice,
  UpdatePrompt,
} from "@polaris-key/react/kit";
import type { PolarisState } from "../src/core/index.js";
import { gateInput } from "../src/kit/sdk.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const OPEN = /\{[A-Za-z]\w*\}/;
const presentation = {
  name: "Tidewater Studio",
  developerName: "Harbor Audio",
  icon: false,
};
const text = (c: HTMLElement) => c.querySelector(".pk-root")?.textContent ?? "";

describe("the SDK gate's date", () => {
  const state = (graceUntil: number | undefined) =>
    ({
      phase: "ready",
      mode: "browser",
      status: "grace",
      gate: { status: "grace", graceUntil },
      activation: { kind: "token" },
      capabilities: { license: { enabled: true }, identity: { enabled: true } },
      error: {},
      busy: {},
    }) as unknown as PolarisState;
  const extra = {
    step: "home" as const,
    key: "",
    submitted: false,
    handle: null,
    secondsLeft: undefined,
  };
  // Noon UTC: the same calendar day in every time zone the suite runs in.
  const noon = Date.UTC(2026, 11, 4, 12) / 1000;

  it("is graceUntil, formatted in the kit's locale", () => {
    expect(
      gateInput(state(noon), { ...extra, locale: "en" }).gate?.graceDate,
    ).toBe("Dec 4, 2026");
    expect(
      gateInput(state(noon), { ...extra, locale: "de" }).gate?.graceDate,
    ).toBe("04.12.2026");
  });

  it("reads in the runtime's locale for a tag Intl does not know, and is absent with no deadline", () => {
    expect(
      gateInput(state(noon), { ...extra, locale: "not a locale" }).gate
        ?.graceDate,
    ).toMatch(/2026/);
    expect(gateInput(state(undefined), extra).gate).not.toHaveProperty(
      "graceDate",
    );
  });

  it("reaches the grace banner", () => {
    const input = gateInput(state(noon), { ...extra, locale: "en" });
    const { container } = render(
      <GraceBanner input={{ ...input, presentation }} />,
    );
    expect(text(container)).toContain("Reconnect by Dec 4, 2026");
    expect(text(container)).not.toMatch(OPEN);
  });
});

describe("the models' arguments in the kit", () => {
  it("formats the boot stage's bytes in the kit's locale", () => {
    const input = {
      presentation,
      stage: {
        stage: "fetch",
        outcome: "waiting",
        emit: { type: "consent_needed", bytes: 1_500_000, metered: false },
      },
    };
    const { container } = render(
      <Boot input={input} theme={{ locale: "de" }} />,
    );
    expect(text(container)).toContain("Tidewater Studio needs 1,5 MB");
    expect(text(container)).not.toMatch(OPEN);
  });

  it("says the installed version where the update prompt says what you have", () => {
    const { container } = render(
      <UpdatePrompt
        input={{
          presentation,
          bundle: { slug: "tidewater", version: "2.4.1" },
          update: { action: "binary", version: "2.5.0", size: "52 MB" },
        }}
      />,
    );
    expect(text(container)).toContain("Tidewater Studio 2.5.0");
    expect(text(container)).toContain("You have 2.4.1 · 52 MB download");
    expect(text(container)).not.toMatch(OPEN);
  });

  it("never reads the new version as the installed one when the app's is unknown", () => {
    const { container } = render(
      <UpdatePrompt
        input={{
          presentation,
          update: { action: "binary", version: "2.5.0", size: "52 MB" },
        }}
      />,
    );
    expect(text(container)).toContain("You have {version} · 52 MB download");
  });

  it("leaves out the origin of a license row that names no store", () => {
    const row = (id: string, origin: string) => ({
      id,
      tierName: "Pro",
      name: null,
      origin,
      access: "seats" as const,
      seats: { used: 1, limit: 3 },
      current: false,
      expiresAt: 1_798_761_600,
      state: "free" as const,
      replace: null,
      freeDeviceUrl: null,
    });
    const { container } = render(
      <LicenseChoice
        input={{
          presentation,
          signIn: {
            presentation: "inline",
            replace: "inline",
            channel: "browser",
            outcome: "choose",
          },
          choices: {
            state: "choose",
            choices: [row("lic_store", "store"), row("lic_dev", "developer")],
            keep: false,
            preselected: "lic_dev",
            create: null,
            getLicense: null,
          },
        }}
      />,
    );
    expect(text(container)).not.toMatch(OPEN);
    expect(text(container)).toContain("From Harbor Audio");
    expect(text(container)).not.toContain("From {store}");
    expect(text(container)).toMatch(/Until/);
  });
});
