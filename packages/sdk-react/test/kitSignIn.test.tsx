// @pkey-feature ui.signin
//
// The one sign-in form in React (SIGN-IN.md §3.17), held to the elements' own tests
// (packages/elements/test/signin.test.ts): `<SignIn>` morphs its body through the steps of
// ui-matrix.json's signIn family (the handoff's code view, the license choice, Replace a device,
// Done), the step parts draw one step each, `presentation="sheet"` puts the form in a `<dialog>`,
// and with SDK primitives the form drives ui-core's SignInModel from its own controls.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode, type ReactNode } from "react";

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  LicenseChoiceView,
  SignInPrimitives,
  SignInWait,
  UiInput,
} from "@polaris-key/ui-core";

import { formStep as formStepOf } from "@polaris-key/elements/contract";

import {
  ReplaceDevice,
  SignIn,
  SignInDone,
  SignInMethods,
  type KitAction,
} from "../src/kit/index.js";

type Obj = Record<string, unknown>;
interface Row {
  name: string;
  input: Obj;
  expect: { component: string; state: string; copy: string[] };
}

const REPO = join(import.meta.dirname, "..", "..", "..");
const matrix = JSON.parse(
  readFileSync(join(REPO, "conformance/corpus/v2/ui-matrix.json"), "utf8"),
) as Obj & { signIn: Row[]; vocabulary: Obj & { defaults: Obj } };

function withDefaults(input: Obj, defaults: Obj): UiInput {
  const out: Obj = { ...input };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((input[k] as Obj | undefined) ?? {}) };
    else if (!(k in input)) out[k] = v;
  }
  return out as UiInput;
}

const input = (name: string): UiInput => {
  const r = matrix.signIn.find((x) => x.name === name);
  if (!r) throw new Error(`no signIn row ${name}`);
  return {
    elapsedMs: 60_000,
    ...withDefaults(r.input, matrix.vocabulary.defaults),
  };
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
  vi.restoreAllMocks();
});

const root = (c: HTMLElement) => c.querySelector<HTMLElement>(".pk-root");
const flush = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};

describe("the form's steps", () => {
  it("draws the code view in the form's body", () => {
    const i = input("SignIn/code: a device-code sign-in");
    expect(formStepOf(i).body.component).toBe("SignInHandoff");
    const { container } = render(<SignIn input={i} />);
    expect(container.querySelector('[data-part="code"]')).not.toBeNull();
  });

  it("draws the license choice with one title and its rows", () => {
    const { container } = render(
      <SignIn input={input("SignIn/choose: desktop")} />,
    );
    expect(root(container)?.dataset.component).toBe("SignIn");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(
      container.querySelector('[data-part="license-list"]'),
    ).not.toBeNull();
  });

  it("titles Replace a device, preselects the least recent and names it in the confirm", () => {
    const actions: KitAction[] = [];
    const { container } = render(
      <SignIn
        input={input("SignIn/replace: the web confirms inline")}
        onAction={(a) => actions.push(a)}
      />,
    );
    expect(container.querySelector("h1")?.getAttribute("data-key")).toBe(
      "deviceLimit.title",
    );
    const devices = container.querySelectorAll('[data-part="device-row"]');
    expect(devices).toHaveLength(3);
    expect(devices[0]!.getAttribute("aria-checked")).toBe("true");
    expect(devices[0]!.textContent).toContain("Windows");
    expect(
      container.querySelector('[data-key="signin.replace.title"]')?.textContent,
    ).toContain("Work laptop");
    // Picking another device moves the confirm with it, and Replace and continue carries it.
    fireEvent.click(devices[1]!);
    expect(
      container.querySelector('[data-key="signin.replace.title"]')?.textContent,
    ).toContain("Mara's iPad");
    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-key="signin.replace.confirm"]',
      )!,
    );
    expect(actions.at(-1)).toMatchObject({
      key: "signin.replace.confirm",
      deviceId: "dev_ipad",
    });
  });

  it("ends on Done with the success mark, and Start reports done", () => {
    const r = matrix.signIn.find(
      (x) =>
        x.expect.component === "SignIn" &&
        x.expect.state === "done" &&
        x.expect.copy.includes("signin.done.start"),
    )!;
    const onDone = vi.fn();
    const { container } = render(
      <SignIn
        input={{
          elapsedMs: 60_000,
          ...withDefaults(r.input, matrix.vocabulary.defaults),
        }}
        onDone={onDone}
      />,
    );
    expect(container.querySelector(".success")).not.toBeNull();
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-key="signin.done.start"]')!,
    );
    expect(onDone).toHaveBeenCalledOnce();
  });
});

describe("the step parts", () => {
  it("each draws its own step and nothing else", () => {
    const methods = input("SignIn/methods: web");
    const replace = input("SignIn/replace: the web confirms inline");
    const draw = (node: ReactNode) => {
      cleanup();
      return render(<>{node}</>).container;
    };
    expect(
      draw(<SignInMethods input={methods} />).querySelector("h1"),
    ).not.toBeNull();
    expect(
      draw(<SignInMethods input={replace} />).querySelector("h1"),
    ).toBeNull();
    expect(
      draw(<ReplaceDevice input={replace} />).querySelectorAll(
        '[data-part="device-row"]',
      ),
    ).toHaveLength(3);
    expect(
      draw(<ReplaceDevice input={methods} />).querySelector("h1"),
    ).toBeNull();
    expect(draw(<SignInDone input={methods} />).querySelector("h1")).toBeNull();
  });
});

describe('presentation="sheet"', () => {
  it("puts the form in a dialog labelled by its title, open while `open`", () => {
    const { container, rerender } = render(
      <SignIn input={input("SignIn/methods: web")} presentation="sheet" />,
    );
    const dialog = container.querySelector("dialog.sheet");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-labelledby")).toBe("pk-title");
    expect(dialog!.querySelector("#pk-title")).not.toBeNull();
    expect(dialog!.hasAttribute("open")).toBe(false);
    rerender(
      <SignIn input={input("SignIn/methods: web")} presentation="sheet" open />,
    );
    expect(dialog!.hasAttribute("open")).toBe(true);
  });

  it("Escape closes the sheet", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SignIn
        input={input("SignIn/methods: web")}
        presentation="sheet"
        open
        onClose={onClose}
      />,
    );
    fireEvent(
      container.querySelector("dialog.sheet")!,
      new Event("cancel", { cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("live: the form drives the SDK primitives", () => {
  const choices: LicenseChoiceView = {
    state: "choose",
    keep: false,
    preselected: "lic_pro",
    create: null,
    getLicense: null,
    choices: [
      {
        id: "lic_pro",
        tierName: "Pro",
        name: null,
        origin: "store",
        access: "seats",
        seats: { used: 1, limit: 3 },
        current: false,
        expiresAt: null,
        state: "free",
        replace: null,
        freeDeviceUrl: null,
      },
    ],
  };

  function primitivesOf(calls: string[]): SignInPrimitives {
    let answered = false;
    return {
      async start(o) {
        calls.push(`start:${o.channel}:${o.licenseChoice}`);
        return {
          browserOpened: true,
          async wait(): Promise<SignInWait> {
            if (answered) return new Promise(() => {});
            answered = true;
            return { outcome: "choose", grant: "g1", choices };
          },
          reopen: () => true,
          cancel: () => {},
        };
      },
      choice: {
        licenses: async () => choices,
        devices: async () => {
          throw new Error("unused");
        },
        async complete(grant, choice) {
          calls.push(`complete:${grant}:${JSON.stringify(choice)}`);
          return { outcome: "signedIn", issuedNow: true };
        },
        cancel: async () => {},
      },
    };
  }

  it("Continue in browser → choose → Use this license → Done, under StrictMode", async () => {
    const calls: string[] = [];
    const primitives = primitivesOf(calls);
    const base = input("SignIn/methods: web");
    delete base.signIn;
    const { container } = render(
      <StrictMode>
        <SignIn input={base} primitives={primitives} />
      </StrictMode>,
    );
    await flush();
    expect(root(container)?.dataset.state).toBe("methods");
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-variant="primary"]')!,
    );
    await flush();
    expect(calls[0]).toBe("start:browser:app");
    expect(root(container)?.dataset.state).toBe("choose");
    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-key="signin.choice.continue"]',
      )!,
    );
    await flush();
    expect(calls[1]).toBe(
      'complete:g1:{"kind":"license","licenseId":"lic_pro"}',
    );
    expect(root(container)?.dataset.state).toBe("done");
    expect(container.querySelector(".success")).not.toBeNull();
  });
});
