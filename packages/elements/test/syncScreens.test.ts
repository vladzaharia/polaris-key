// @pkey-feature ui.kit sync.keyring
//
// U-42.2: the Cloud Sync screens as elements. Layer (b): the host sets `input`, hears `pk-action`.
// The recovery code is typed only into UnlockSync's field and leaves only with the Unlock press;
// RecoveryCode draws the code the host hands it as text (never an input, never in `input`); a
// changed ring passes the ring it was shown. The matrix rows are matrix.test.ts's `cloudSync`.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { UiInput } from "@polaris-key/ui-core";

import { TAGS, type PkElement, type PkActionDetail } from "../src/index.js";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    },
  );
});
afterEach(() => document.body.replaceChildren());

const CODE = "ABCD EFGH JKLM NPQR STUV WXYZ 2345 6789";
const SERVED = { ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c" };

async function mount(
  tag: keyof typeof TAGS,
  input: UiInput,
  props: Record<string, unknown> = {},
): Promise<PkElement> {
  const el = document.createElement(TAGS[tag]) as PkElement;
  el.input = { elapsedMs: 60_000, ...input };
  Object.assign(el, props);
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}
const q = (el: PkElement, sel: string) => el.shadowRoot!.querySelector(sel);
const actions = (el: PkElement) => {
  const seen: PkActionDetail[] = [];
  el.addEventListener("pk-action", (e) =>
    seen.push((e as CustomEvent<PkActionDetail>).detail),
  );
  return seen;
};

describe("pk-unlock-sync", () => {
  it("hands the typed code over with Unlock only; the field is the only place it lives", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "code" } });
    const seen = actions(el);
    const field = q(el, '[data-key="unlockSync.field"]') as HTMLInputElement;
    field.value = " abcd efgh ";
    field.dispatchEvent(new Event("input"));
    expect(seen).toEqual([]);
    expect(JSON.stringify(el.input)).not.toContain("abcd");
    (q(el, 'button[data-key="unlockSync.unlock"]') as HTMLElement).click();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      key: "unlockSync.unlock",
      action: "unlock",
      value: "abcd efgh",
    });
  });

  it("editing clears 'That code isn't right'", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "invalid" } });
    expect(q(el, '[data-key="unlockSync.invalid"]')).not.toBeNull();
    const field = q(el, '[data-key="unlockSync.field"]') as HTMLInputElement;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    field.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(q(el, '[data-key="unlockSync.invalid"]')).toBeNull();
    expect(el.view.state).toBe("code");
  });

  it("offers Paste, Start over and the note; Escape cancels", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "code" } });
    const seen = actions(el);
    expect(q(el, 'button[data-key="common.paste"]')).not.toBeNull();
    expect(q(el, 'button[data-key="unlockSync.startOver"]')).not.toBeNull();
    expect(q(el, '[data-key="recoveryCode.noAsk"]')).not.toBeNull();
    q(el, ".pk-root")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(seen.map((s) => s.key)).toEqual(["common.cancel"]);
  });

  it("the Start over warning confirms in danger, first, Cancel last", async () => {
    const el = await mount("UnlockSync", {
      unlockSync: { step: "start-over" },
    });
    const keys = [
      ...el.shadowRoot!.querySelectorAll<HTMLElement>(".actions button"),
    ];
    expect(keys.map((b) => b.dataset.key)).toEqual([
      "unlockSync.startOverConfirm",
      "common.cancel",
    ]);
    expect(keys[0]!.dataset.variant).toBe("danger");
  });
});

describe("pk-recovery-code", () => {
  it("draws the code the host hands it as eight groups, never as an input or in the input", async () => {
    const el = await mount(
      "RecoveryCode",
      { recoveryCode: {} },
      { code: CODE },
    );
    const groups = [...el.shadowRoot!.querySelectorAll(".recovery-groups .g")];
    expect(groups.map((g) => g.textContent)).toEqual(CODE.split(" "));
    expect(q(el, 'input[type="text"]')).toBeNull();
    expect(JSON.stringify(el.input)).not.toContain("ABCD");
    expect(el.getAttribute("code")).toBeNull();
  });

  it("Done appears only after 'I've saved it'", async () => {
    const el = await mount(
      "RecoveryCode",
      { recoveryCode: {} },
      { code: CODE },
    );
    const seen = actions(el);
    expect(q(el, 'button[data-key="common.done"]')).toBeNull();
    const box = q(el, 'input[type="checkbox"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await el.updateComplete;
    expect(el.view.state).toBe("saved");
    (q(el, 'button[data-key="common.done"]') as HTMLElement).click();
    expect(seen.map((s) => s.key)).toEqual(["common.done"]);
  });

  it("Escape does not leave it", async () => {
    const el = await mount(
      "RecoveryCode",
      { recoveryCode: {} },
      { code: CODE },
    );
    const seen = actions(el);
    q(el, ".pk-root")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(seen).toEqual([]);
  });
});

describe("pk-ring-change", () => {
  it("Accept carries the ring that was shown", async () => {
    const el = await mount("RingChange", {
      ringChange: { by: "Maya's MacBook", served: SERVED },
    });
    const seen = actions(el);
    expect(el.shadowRoot!.textContent).toContain("Maya's MacBook");
    (q(el, 'button[data-key="ringChange.accept"]') as HTMLElement).click();
    expect(seen[0]).toMatchObject({
      key: "ringChange.accept",
      action: "accept-ring-change",
      served: SERVED,
    });
  });

  it("without a served ring there is no Accept; the recovery code is the primary", async () => {
    const el = await mount("RingChange", { ringChange: {} });
    expect(q(el, 'button[data-key="ringChange.accept"]')).toBeNull();
    expect(
      (q(el, 'button[data-key="ringChange.useCode"]') as HTMLElement).dataset
        .variant,
    ).toBe("primary");
    expect(el.shadowRoot!.textContent).toContain("A device set up a new key");
  });
});

describe("pk-cloud-sync-status: locked and ring-changed", () => {
  it("locked offers Unlock sync; ring-changed offers Review", async () => {
    const a = await mount("CloudSyncStatus", {
      cloudSync: { state: "locked" },
    });
    expect(q(a, 'button[data-key="cloudSync.unlock"]')).not.toBeNull();
    expect(q(a, "[data-status]")!.getAttribute("data-status")).toBe("neutral");
    const b = await mount("CloudSyncStatus", {
      cloudSync: { state: "ring-changed" },
    });
    expect(q(b, 'button[data-key="common.review"]')).not.toBeNull();
  });
});
