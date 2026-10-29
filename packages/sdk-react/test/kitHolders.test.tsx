// @pkey-feature ui.kit.holders
//
// UK-42.9: the React kit's two holder screens, ActivateDone and AddToAccount, and their hooks.
// Every `holders` row of ui-core's matrix for those two components is drawn: the view is ui-core's,
// every key it lists is on screen, every button key is a button, at most one control is filled and
// it is the view's primary. Then the rules the rows cannot say: the device line is left out when
// its numbers are unknown (never "{n}"), reasons carry their own icons and only the product's, the
// one primary is Start using, name and email are checked and leave only in `attach`, focus goes to
// Name, each refusal draws its own state, and the public exports load on demand.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Copy, viewOf, type UiInput } from "@polaris-key/ui-core";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";

import * as Kit from "../src/kit/index.js";
import type {
  AddToAccountValues,
  AttachOutcome,
  UseActivateDone,
  UseActivateDoneOptions,
  UseAddToAccount,
  UseAddToAccountOptions,
} from "../src/kit/index.js";
import { ActivateDone, AddToAccount } from "../src/kit/holders.js";
import { useActivateDone, useAddToAccount } from "../src/kit/holderHooks.js";

type Obj = Record<string, unknown>;
interface Row {
  name: string;
  input: UiInput;
  expect: { component: string; state: string; copy: string[] };
}

const REPO = join(import.meta.dirname, "..", "..", "..");
const readJson = <T,>(path: string): T =>
  JSON.parse(readFileSync(join(REPO, path), "utf8")) as T;
const matrix = readJson<
  Obj & { vocabulary: Obj & { defaults: Obj }; holders: Row[] }
>("conformance/corpus/v2/ui-matrix.json");
const ROLE = new Map(
  Object.entries(
    readJson<{ messages: Record<string, { role: string }> }>(
      "packages/brand/kit-copy/en.json",
    ).messages,
  ).map(([key, message]) => [key, message.role] as const),
);
class NoResize {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}
const en = new Copy({ tables: { en: KIT_COPY_EN } });

beforeAll(() => {
  // jsdom has no layout.
  vi.stubGlobal("ResizeObserver", NoResize);
});
afterEach(cleanup);

const literal = (message: string): string =>
  message
    .replace(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "\u0000")
    .split("\u0000")
    .map((r) => r.trim())
    .sort((a, b) => b.length - a.length)[0] ?? "";

const SCREENS = { ActivateDone, AddToAccount } as const;
const rows = matrix.holders.filter(
  (r) => r.expect.component in SCREENS,
) as (Row & { expect: { component: keyof typeof SCREENS } })[];

describe("React kit × ui-matrix.json holders", () => {
  it("contains both screens' rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
  });

  it.each(rows.map((r) => [r.name, r] as const))("%s", async (_n, row) => {
    const input: UiInput = {
      elapsedMs: 60_000,
      ...matrix.vocabulary.defaults,
      ...row.input,
    } as UiInput;
    const view = viewOf(row.expect.component, input);
    expect(view.state).toBe(row.expect.state);
    const Screen = SCREENS[row.expect.component];
    const { container } = render(<Screen input={input} />);
    const root = container.querySelector<HTMLElement>(".pk-root");
    if (view.state === "hidden") {
      expect(root).toBeNull();
      return;
    }
    expect(root!.dataset.component).toBe(row.expect.component);
    expect(root!.dataset.state).toBe(view.state);
    const shown = root!.textContent ?? "";
    for (const key of view.copy) {
      const lit = literal(en.raw(key) ?? "");
      const keyed = root!.querySelector(`[data-key="${key}"]`);
      expect(keyed !== null || shown.includes(lit), `${key} is on screen`).toBe(
        true,
      );
      // "Add your name and email" is a button on Done and the heading of the form.
      const asTitle =
        key === "activate.recommend.action" &&
        row.expect.component === "AddToAccount";
      if (ROLE.get(key) === "button" && !asTitle)
        expect(
          root!.querySelector(`button[data-key="${key}"]`),
          `${key} is a control`,
        ).not.toBeNull();
      if (ROLE.get(key) === "title")
        expect(
          keyed?.closest("h1,h2") ?? null,
          `${key} is a heading`,
        ).not.toBeNull();
    }
    const filled = root!.querySelectorAll('[data-variant="primary"]');
    expect(filled.length).toBeLessThanOrEqual(1);
    if (view.decisions.primary !== null)
      expect(
        root!.querySelector(
          `[data-variant="primary"][data-key="${view.decisions.primary}"]`,
        ),
      ).not.toBeNull();
  });
});

const DONE: UiInput = {
  elapsedMs: 60_000,
  activateDone: {
    tier: "Pro",
    term: "Lifetime",
    deviceKind: "computer",
    position: 1,
    limit: 3,
  },
} as UiInput;

describe("ActivateDone", () => {
  it("draws the license line, then the quiet card with its badge and one filled control", () => {
    const { container } = render(<ActivateDone input={DONE} />);
    const root = container.querySelector(".pk-root")!;
    expect(root.textContent).toContain(
      "Pro · Lifetime · this computer is device 1 of 3.",
    );
    const card = root.querySelector(".recommend")!;
    expect(
      card.querySelector('[data-key="activate.recommend.badge"]'),
    ).not.toBeNull();
    expect(card.querySelector("button")?.getAttribute("data-variant")).toBe(
      "secondary",
    );
    const filled = root.querySelectorAll('[data-variant="primary"]');
    expect(filled).toHaveLength(1);
    expect(filled[0]!.getAttribute("data-key")).toBe("signin.done.start");
    // The skip is a line, not a control.
    expect(
      root.querySelector('p[data-key="activate.recommend.skip"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('button[data-key="activate.recommend.skip"]'),
    ).toBeNull();
  });

  it("leaves the device line out when its numbers are unknown, never as a placeholder", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container } = render(
      <ActivateDone
        input={
          {
            ...DONE,
            activateDone: { tier: "Pro", term: "Lifetime" },
          } as UiInput
        }
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(
      container.querySelector('[data-key="activate.done.device"]'),
    ).toBeNull();
    warn.mockRestore();
  });

  it("gives each reason its own icon, in order, and only the ones the product has", () => {
    const { container } = render(<ActivateDone input={DONE} />);
    const lines = [...container.querySelectorAll(".reasons li")];
    expect(lines.map((l) => l.getAttribute("data-key"))).toEqual([
      "activate.recommend.sync",
      "activate.recommend.recover",
      "activate.recommend.devices",
    ]);
    for (const l of lines) {
      expect(l.querySelector("svg")).not.toBeNull();
      // No bold lead-in: plain text.
      expect(l.querySelector("strong,b")).toBeNull();
    }
    cleanup();
    const off = render(
      <ActivateDone
        input={
          { ...DONE, services: ["license", "identity", "update"] } as UiInput
        }
      />,
    );
    expect(
      [...off.container.querySelectorAll(".reasons li")].map((l) =>
        l.getAttribute("data-key"),
      ),
    ).toEqual(["activate.recommend.recover", "activate.recommend.devices"]);
    cleanup();
    const portal = render(
      <ActivateDone
        input={
          {
            ...DONE,
            services: ["license"],
            capabilities: { signIn: false },
          } as UiInput
        }
      />,
    );
    expect(
      [...portal.container.querySelectorAll(".reasons li")].map((l) =>
        l.getAttribute("data-key"),
      ),
    ).toEqual(["activate.recommend.portal"]);
  });

  it("waiting: the masked email, Start using filled, Sign in as it", () => {
    const onSignIn = vi.fn();
    const { container } = render(
      <ActivateDone
        input={
          { ...DONE, licenseHolder: { email: "maya@example.com" } } as UiInput
        }
        onSignIn={onSignIn}
      />,
    );
    const root = container.querySelector(".pk-root")!;
    expect(root.textContent).not.toContain("maya@example.com");
    expect(root.querySelector(".recommend")).toBeNull();
    fireEvent.click(
      root.querySelector('button[data-key="activate.waitingSignIn"]')!,
    );
    expect(onSignIn).toHaveBeenCalled();
  });

  it("reports Start using and Add your name and email", () => {
    const onStart = vi.fn();
    const onAddToAccount = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <ActivateDone
        input={DONE}
        onStart={onStart}
        onAddToAccount={onAddToAccount}
        onAction={onAction}
      />,
    );
    fireEvent.click(
      container.querySelector('button[data-key="activate.recommend.action"]')!,
    );
    fireEvent.click(
      container.querySelector('button[data-key="signin.done.start"]')!,
    );
    expect(onAddToAccount).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls.map((c) => c[0].key)).toEqual([
      "activate.recommend.action",
      "signin.done.start",
    ]);
  });

  it("is hidden without its facts", () => {
    const { container } = render(<ActivateDone input={{}} />);
    expect(container.querySelector(".pk-root")).toBeNull();
  });
});

const ADD: UiInput = { elapsedMs: 60_000 } as UiInput;

describe("AddToAccount", () => {
  it("is titled by its action, with Name and Email and one filled Continue", () => {
    const { container } = render(<AddToAccount input={ADD} />);
    const root = container.querySelector(".pk-root")!;
    expect(root.querySelector("h1")?.textContent).toBe(
      "Add your name and email",
    );
    expect(
      root.querySelector('input[data-key="signin.gate.name"]'),
    ).not.toBeNull();
    expect(root.querySelector('input[type="email"]')).not.toBeNull();
    expect(
      root.querySelector('[data-variant="primary"]')?.getAttribute("data-key"),
    ).toBe("common.continue");
  });

  it("checks both fields, says which, and attaches nothing", () => {
    const attach = vi.fn();
    const { container } = render(<AddToAccount input={ADD} attach={attach} />);
    fireEvent.click(
      container.querySelector('button[data-key="common.continue"]')!,
    );
    const root = container.querySelector<HTMLElement>(".pk-root")!;
    expect(root.dataset.state).toBe("invalid");
    expect(
      root.querySelector('[data-key="signin.gate.nameRequired"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-key="signin.email.invalid"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-field="name"]')?.getAttribute("aria-invalid"),
    ).toBe("true");
    expect(attach).not.toHaveBeenCalled();
  });

  async function fill(container: HTMLElement) {
    fireEvent.change(container.querySelector('[data-field="name"]')!, {
      target: { value: "  Maya  " },
    });
    fireEvent.change(container.querySelector('[data-field="email"]')!, {
      target: { value: "maya@example.com" },
    });
    await act(async () => {
      fireEvent.click(
        container.querySelector('button[data-key="common.continue"]')!,
      );
    });
  }

  it.each([
    ["added", "added"],
    ["owned", "owned"],
    ["email-bound", "email-bound"],
    ["failed", "failed"],
  ] as const)("attach resolving %s draws %s", async (outcome, state) => {
    const attach = vi.fn().mockResolvedValue(outcome);
    const { container } = render(
      <AddToAccount
        input={
          { ...ADD, licenseHolder: { email: "maya@example.com" } } as UiInput
        }
        attach={attach}
      />,
    );
    await fill(container);
    await waitFor(() =>
      expect(
        container.querySelector<HTMLElement>(".pk-root")!.dataset.state,
      ).toBe(state),
    );
    // The name is trimmed; the values leave in `attach` only.
    expect(attach).toHaveBeenCalledWith({
      name: "Maya",
      email: "maya@example.com",
    });
    expect(container.textContent).not.toContain("maya@example.com");
  });

  it("a rejected attach is failed, and Try again attaches again", async () => {
    const attach = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("added");
    const { container } = render(<AddToAccount input={ADD} attach={attach} />);
    await fill(container);
    await waitFor(() =>
      expect(
        container.querySelector<HTMLElement>(".pk-root")!.dataset.state,
      ).toBe("failed"),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[role="alert"]')?.textContent ?? "",
      ).toContain("Couldn't add"),
    );
    await act(async () => {
      fireEvent.click(
        container.querySelector('button[data-key="common.tryAgain"]')!,
      );
    });
    await waitFor(() =>
      expect(
        container.querySelector<HTMLElement>(".pk-root")!.dataset.state,
      ).toBe("added"),
    );
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("a host that drives the step hears the values in the pressing action only", () => {
    const onAction = vi.fn();
    const { container } = render(
      <AddToAccount
        input={{ ...ADD, addToAccount: { step: "form" } } as UiInput}
        onAction={onAction}
      />,
    );
    fireEvent.change(container.querySelector('[data-field="name"]')!, {
      target: { value: "Maya" },
    });
    fireEvent.change(container.querySelector('[data-field="email"]')!, {
      target: { value: "maya@example.com" },
    });
    fireEvent.click(
      container.querySelector('button[data-key="common.continue"]')!,
    );
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "common.continue",
        name: "Maya",
        email: "maya@example.com",
      }),
    );
    expect(
      container.querySelector<HTMLElement>(".pk-root")!.dataset.state,
    ).toBe("form");
  });

  it("routes Cancel, Start using, Sign in and Verify to the host", async () => {
    const h = {
      onCancel: vi.fn(),
      onStart: vi.fn(),
      onSignIn: vi.fn(),
      onVerify: vi.fn(),
    };
    const press = (input: UiInput, key: string) => {
      const r = render(<AddToAccount input={input} {...h} />);
      fireEvent.click(r.container.querySelector(`button[data-key="${key}"]`)!);
      r.unmount();
    };
    press(
      { ...ADD, addToAccount: { step: "form" } } as UiInput,
      "common.cancel",
    );
    press(
      { ...ADD, addToAccount: { step: "added" } } as UiInput,
      "signin.done.start",
    );
    press(
      { ...ADD, addToAccount: { step: "owned" } } as UiInput,
      "signin.key.ownedSignIn",
    );
    press(
      {
        ...ADD,
        addToAccount: { step: "email-bound" },
        licenseHolder: { email: "a@b.co" },
      } as UiInput,
      "activate.otherEmail.verify",
    );
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.onStart).toHaveBeenCalledTimes(1);
    expect(h.onSignIn).toHaveBeenCalledTimes(1);
    expect(h.onVerify).toHaveBeenCalledTimes(1);
  });

  it("mounts with focus on Name when asked", () => {
    const { container } = render(<AddToAccount input={ADD} autoFocus />);
    expect(document.activeElement).toBe(
      container.querySelector('[data-field="name"]'),
    );
  });

  it("added names Cloud Sync only when the product has it", () => {
    const withSync = render(
      <AddToAccount
        input={
          {
            ...ADD,
            addToAccount: { step: "added", deviceKind: "computer" },
          } as UiInput
        }
      />,
    );
    expect(withSync.container.textContent).toContain(
      "Cloud Sync is on for this computer",
    );
    cleanup();
    const without = render(
      <AddToAccount
        input={
          {
            ...ADD,
            services: ["license", "identity"],
            addToAccount: { step: "added", deviceKind: "computer" },
          } as UiInput
        }
      />,
    );
    expect(without.container.textContent).not.toContain("Cloud Sync");
  });
});

describe("the hooks", () => {
  it("useActivateDone gives the view, the reasons and the handlers", () => {
    const onStart = vi.fn();
    const { result } = renderHook(() =>
      useActivateDone({ input: DONE, onStart }),
    );
    expect(result.current.view.state).toBe("ready");
    expect(result.current.reasons).toEqual([
      "activate.recommend.sync",
      "activate.recommend.recover",
      "activate.recommend.devices",
    ]);
    result.current.start();
    expect(onStart).toHaveBeenCalled();
  });

  it("useAddToAccount holds the fields and walks the steps", async () => {
    const attach = vi.fn().mockResolvedValue("added");
    const { result } = renderHook(() =>
      useAddToAccount({ attach, input: ADD }),
    );
    expect(result.current.step).toBe("form");
    act(() => {
      result.current.submit();
    });
    expect(result.current.step).toBe("invalid");
    expect(result.current.view.state).toBe("invalid");
    act(() => {
      result.current.setName("Maya");
      result.current.setEmail("maya@example.com");
    });
    await act(async () => {
      result.current.submit();
    });
    expect(result.current.step).toBe("added");
    expect(JSON.stringify(result.current.input)).not.toContain(
      "maya@example.com",
    );
  });
});

describe("the public exports", () => {
  it("load on demand and draw", async () => {
    render(<Kit.ActivateDone input={DONE} />);
    await waitFor(() =>
      expect(
        document.querySelector(".pk-root[data-component='ActivateDone']"),
      ).not.toBeNull(),
    );
    expect(screen.getByText("Start using", { exact: false })).toBeTruthy();
    expect(Kit.AddToAccount).toBeTypeOf("function");
    expect(Kit.useAddToAccount).toBeTypeOf("function");
  });
});

describe("the public types", () => {
  it("name what a host writes and reads", () => {
    const attach = async (who: AddToAccountValues): Promise<AttachOutcome> =>
      who.email === "" ? "failed" : "added";
    const options: UseAddToAccountOptions & UseActivateDoneOptions = {
      attach,
      input: DONE,
    };
    const hooks = (a: UseActivateDone, b: UseAddToAccount): string =>
      `${a.view.state}.${b.step}`;
    expect(hooks).toBeTypeOf("function");
    expect(Kit.useActivateDone).toBeTypeOf("function");
    expect(options.attach).toBe(attach);
  });
});
