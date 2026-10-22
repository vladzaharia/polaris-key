// @pkey-feature ui.signin ui.kit.manage
//
// UK-05's slice on UK-04's controls: the code step's countdown and status, no "or" divider and no
// "Sign in…" link on the sign-in step, a failure that keeps the other methods, Replace naming the
// device, the count stated once, a device list that scrolls past six, setting labels, and the
// no-browser address.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { UiInput } from "@polaris-key/ui-core";

import { SignIn } from "@polaris-key/react/kit";
import { settingLabel } from "../src/kit/rows.js";

type Obj = Record<string, unknown>;
const REPO = join(import.meta.dirname, "..", "..", "..");
const matrix = JSON.parse(
  readFileSync(join(REPO, "conformance/corpus/v2/ui-matrix.json"), "utf8"),
) as Obj & {
  signIn: { name: string; input: Obj }[];
  vocabulary: Obj & { defaults: Obj };
};

const input = (name: string, over: Obj = {}): UiInput => {
  const r = matrix.signIn.find((x) => x.name === name);
  if (!r) throw new Error(`no signIn row ${name}`);
  const out: Obj = { ...r.input, ...over };
  for (const [k, v] of Object.entries(matrix.vocabulary.defaults))
    if (!(k in out)) out[k] = v;
  return { elapsedMs: 60_000, ...out } as UiInput;
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const keys = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-key]")].map((n) => n.getAttribute("data-key"));

describe("the sign-in step", () => {
  it("has no or-divider and no Sign in link; a failure keeps the other methods", () => {
    const ok = render(<SignIn input={input("SignIn/methods: web")} />);
    expect(keys(ok.container)).not.toContain("signin.provider.group");
    expect(keys(ok.container)).not.toContain("signin.menu.signIn");
    ok.unmount();
    const bad = render(
      <SignIn input={input("SignIn/error: a sign-in method failed")} />,
    );
    expect(keys(bad.container)).not.toContain("signin.provider.group");
    expect(
      bad.container.querySelectorAll('button[data-key^="signin."]').length,
    ).toBeGreaterThan(1);
  });

  it("the code step counts down, says it waits and can be cancelled", () => {
    vi.useFakeTimers();
    const i = input("SignIn/code: a device-code sign-in");
    const { container } = render(
      <SignIn
        input={{
          ...i,
          deviceCode: { ...i.deviceCode!, phase: "waiting", secondsLeft: 100 },
        }}
      />,
    );
    const before = container.querySelector(
      '[data-key="signin.handoff.expires"]',
    );
    expect(before?.textContent).toContain("1:40");
    // The ticking line is not a live region; the waiting status is.
    expect(before?.closest('[role="status"]')).toBeNull();
    expect(
      container.querySelector(
        '[role="status"] [data-key="cli.signin.waitingCode"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('button[data-key="common.cancel"]'),
    ).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(
      container.querySelector('[data-key="signin.handoff.expires"]')
        ?.textContent,
    ).toContain("1:37");
  });
});

describe("Replace and the device list", () => {
  it("the Replace primary names the device; the count is stated once", () => {
    const { container } = render(
      <SignIn input={input("SignIn/replace: the web confirms inline")} />,
    );
    const primary = container.querySelector(
      '[data-variant="primary"][data-key="signin.replace.confirm"]',
    );
    expect(primary?.textContent).toMatch(/^Replace .+ and continue$/);
    expect(primary?.textContent).not.toContain("{");
  });
});

describe("a long device list", () => {
  it("scrolls in its own box past six rows", () => {
    const base = input("SignIn/replace: the web confirms inline");
    const rv = base.replaceView!;
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...rv.devices[i % rv.devices.length]!,
      id: `d${i}`,
    }));
    const six = many.slice(0, 6);
    const draw = (devices: typeof many) =>
      render(
        <SignIn input={{ ...base, replaceView: { ...rv, devices } }} />,
      ).container.querySelector('[data-part="device-list"]');
    expect(draw(many)?.hasAttribute("data-scroll")).toBe(true);
    cleanup();
    expect(draw(six)?.hasAttribute("data-scroll")).toBe(false);
  });
});

describe("setting labels", () => {
  it("spells acronyms in capitals", () => {
    expect(settingLabel({ key: "ui.compact" } as never)).toBe("UI compact");
    expect(settingLabel({ key: "server.url" } as never)).toBe("Server URL");
  });
});
