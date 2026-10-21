// @pkey-feature ui.signin ui.kit
//
// The UK-kits polish slice in React: a full row of a mixed list carries its own Replace (as in the
// elements), an existing license closes the sheet with a toast (nameless when the holder has no
// name), and the revoked screen's initial focus is its Sign in.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { viewOf, type UiInput } from "@polaris-key/ui-core";

import { SignIn } from "@polaris-key/react/kit";

type Obj = Record<string, unknown>;
interface Row {
  name: string;
  input: Obj;
}
const REPO = join(import.meta.dirname, "..", "..", "..");
const matrix = JSON.parse(
  readFileSync(join(REPO, "conformance/corpus/v2/ui-matrix.json"), "utf8"),
) as Record<string, Row[]> & { vocabulary: { defaults: Obj } };

const input = (name: string, patch: Partial<UiInput> = {}): UiInput => {
  const r = Object.values(matrix)
    .filter(Array.isArray)
    .flat()
    .find((x) => (x as Row).name === name) as Row | undefined;
  if (!r) throw new Error(`no row ${name}`);
  const out: Obj = { ...r.input };
  for (const [k, v] of Object.entries(matrix.vocabulary.defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((out[k] as Obj | undefined) ?? {}) };
    else if (!(k in out)) out[k] = v;
  }
  return { elapsedMs: 60_000, ...out, ...patch } as UiInput;
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => vi.restoreAllMocks());

describe("a mixed license list", () => {
  it("gives the full row its own Replace and leaves the free rows chooseable", () => {
    const { container } = render(
      <SignIn input={input("SignIn/choose: desktop")} />,
    );
    const rows = [
      ...container.querySelectorAll<HTMLElement>('[data-part="license-row"]'),
    ];
    const full = rows.filter((r) => r.getAttribute("role") === "group");
    expect(full).toHaveLength(1);
    expect(
      full[0]!.querySelector('button[data-key="signin.replace.open"]'),
    ).not.toBeNull();
    expect(
      rows.filter((r) => r.getAttribute("role") === "radio").length,
    ).toBeGreaterThan(1);
  });
});

describe("an existing license in a sheet", () => {
  const done = (account: UiInput["account"]) =>
    input(
      "SignIn/done: inline, an existing license opens the app with the toast (sheet)",
      { account },
    );

  it("closes the sheet and toasts the holder", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SignIn
        input={done({ signedIn: true, holder: "Mara", tier: "Pro" })}
        presentation="sheet"
        open
        onClose={onClose}
      />,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    const toast = container.querySelector('[data-part="toast"]');
    expect(toast?.getAttribute("data-key")).toBe("signin.desktop.toast");
    expect(toast?.textContent).toContain("Mara");
  });

  it("toasts without a name when the holder has none", () => {
    const { container } = render(
      <SignIn
        input={done({ signedIn: true, tier: "Pro" })}
        presentation="sheet"
        open
        onClose={() => {}}
      />,
    );
    const toast = container.querySelector('[data-part="toast"]');
    expect(toast?.getAttribute("data-key")).toBe("signin.return.signedInShort");
    expect(toast?.textContent).not.toContain("{");
  });
});

describe("the revoked screen", () => {
  it("focuses Sign in, the primary", () => {
    const i = input("StatusScreen/revoked");
    const v = viewOf("StatusScreen", i);
    expect(v.copy).toContain("welcome.signIn");
    expect(v.copy).not.toContain("common.signOut");
    expect(v.decisions.primary).toBe("welcome.signIn");
    expect(v.decisions.focus).toBe("welcome.signIn");
  });
});
