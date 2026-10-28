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

// A real code: eight Crockford groups joined by hyphens, as the engine hands it over.
const CODE = "K7QF-2M9D-XR4T-8WHB-3JNC-6PEZ-V5GD-HT0S";
const GROUPS = CODE.split("-");
const SERVED = { ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c" };

async function mount(
  tag: keyof typeof TAGS,
  input: UiInput,
  props: Record<string, unknown> = {},
): Promise<PkElement> {
  const el = document.createElement(TAGS[tag]) as PkElement;
  el.input = { elapsedMs: 60_000, ...input };
  el.handles = "unlock review use-code";
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

/** The actions Escape produces on `el`. */
function escapeActions(el: PkElement): string[] {
  const seen = actions(el);
  q(el, ".pk-root")!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  return seen.map((a) => a.key);
}

describe("pk-unlock-sync", () => {
  it("hands the typed code over with Unlock only; the field is the only place it lives", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "code" } });
    const seen = actions(el);
    const field = q(el, '[data-key="unlockSync.field"]') as HTMLTextAreaElement;
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
    const field = q(el, '[data-key="unlockSync.field"]') as HTMLTextAreaElement;
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
    expect(groups.map((g) => g.textContent)).toEqual(GROUPS);
    expect(q(el, 'input[type="text"]')).toBeNull();
    expect(JSON.stringify(el.input)).not.toContain("K7QF");
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
    expect(escapeActions(el)).toEqual([]);
  });
});

describe("pk-unlock-sync: every step, one field", () => {
  const field = (el: PkElement) =>
    q(el, '[data-key="unlockSync.field"]') as HTMLTextAreaElement;

  it("keeps the typed text through invalid, failed, the warning and back", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "code" } });
    const f = field(el);
    f.value = "k7qf 2m9d";
    for (const step of [
      "working",
      "invalid",
      "failed",
      "start-over",
      "no-code",
      "code",
    ] as const) {
      el.input = { ...el.input, unlockSync: { step } };
      await el.updateComplete;
      expect(field(el), step).toBe(f);
      expect(f.value).toBe("k7qf 2m9d");
    }
  });

  it("working keeps the pressed control, busy, and offers neither Cancel nor Start over", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "code" } });
    const unlock = q(el, 'button[data-key="unlockSync.unlock"]');
    el.input = { unlockSync: { step: "working" } };
    await el.updateComplete;
    expect(q(el, 'button[data-key="unlockSync.unlock"]')).toBe(unlock);
    expect(unlock!.getAttribute("aria-disabled")).toBe("true");
    expect(q(el, 'button[data-key="common.cancel"]')).toBeNull();
    expect(field(el).readOnly).toBe(true);
    expect(escapeActions(el)).toEqual([]);
  });

  it("an empty field sends nothing and keeps focus in it", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "code" } });
    const seen = actions(el);
    (q(el, 'button[data-key="unlockSync.unlock"]') as HTMLElement).click();
    expect(seen).toEqual([]);
    expect(el.shadowRoot!.activeElement).toBe(field(el));
  });

  it("the failure reason sits above the actions", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "failed" } });
    const reason = q(el, '[data-key="unlockSync.failed"]')!;
    const actionsEl = q(el, ".actions")!;
    expect(
      reason.compareDocumentPosition(actionsEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("the Start over confirm takes no press for 500 ms; the warning is the group's description", async () => {
    vi.useFakeTimers();
    try {
      const el = await mount("UnlockSync", { unlockSync: { step: "code" } });
      const seen = actions(el);
      (q(el, 'button[data-key="unlockSync.startOver"]') as HTMLElement).click();
      await el.updateComplete;
      expect(el.view.state).toBe("start-over");
      const confirm = q(
        el,
        'button[data-key="unlockSync.startOverConfirm"]',
      ) as HTMLElement;
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      confirm.click();
      expect(seen.map((s) => s.key)).toEqual(["unlockSync.startOver"]);
      expect(q(el, ".actions")!.getAttribute("aria-describedby")).toBe(
        "pk-start-warning",
      );
      await vi.advanceTimersByTimeAsync(600);
      await el.updateComplete;
      const armed = q(
        el,
        'button[data-key="unlockSync.startOverConfirm"]',
      ) as HTMLElement;
      expect(armed.getAttribute("aria-disabled")).toBeNull();
      armed.click();
      expect(seen.map((s) => s.key)).toEqual([
        "unlockSync.startOver",
        "unlockSync.startOverConfirm",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers its own steps and still reports them: Start over, Cancel back, Try again", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "no-code" } });
    const seen = actions(el);
    (q(el, 'button[data-key="unlockSync.startOver"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.view.state).toBe("start-over");
    (q(el, 'button[data-key="common.cancel"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.view.state).toBe("no-code");
    expect(seen.map((s) => s.key)).toEqual([
      "unlockSync.startOver",
      "common.cancel",
    ]);
    el.input = { unlockSync: { step: "failed" } };
    await el.updateComplete;
    (q(el, 'button[data-key="common.tryAgain"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.view.state).toBe("code");
  });

  it("a failed Start over has its own line above the actions; Try again is left to the host", async () => {
    const el = await mount("UnlockSync", {
      unlockSync: { step: "start-over-failed" },
    });
    const seen = actions(el);
    const reason = q(el, '[data-key="unlockSync.startOverFailed"]')!;
    expect(
      reason.compareDocumentPosition(q(el, ".actions")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    (q(el, 'button[data-key="common.tryAgain"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.view.state).toBe("start-over-failed");
    expect(seen.map((s) => s.key)).toEqual(["common.tryAgain"]);
  });

  it("the no-code step says so and leads with Start over; Cancel is quiet", async () => {
    const el = await mount("UnlockSync", { unlockSync: { step: "no-code" } });
    expect(q(el, '[data-key="unlockSync.noCode"]')).not.toBeNull();
    expect(
      (q(el, 'button[data-key="unlockSync.startOver"]') as HTMLElement).dataset
        .variant,
    ).toBe("primary");
    expect(
      (q(el, 'button[data-key="common.cancel"]') as HTMLElement).dataset
        .variant,
    ).toBe("link");
  });
});

describe("controls only a host can act on (handles)", () => {
  it("are not drawn unless the page says it answers them", async () => {
    const locked = await mount(
      "CloudSyncStatus",
      { cloudSync: { state: "locked" } },
      { handles: "" },
    );
    expect(q(locked, 'button[data-key="cloudSync.unlock"]')).toBeNull();
    const ring = await mount(
      "CloudSyncStatus",
      { cloudSync: { state: "ring-changed" } },
      { handles: "unlock" },
    );
    expect(q(ring, 'button[data-key="common.review"]')).toBeNull();
    const change = await mount(
      "RingChange",
      { ringChange: { served: SERVED } },
      { handles: "" },
    );
    expect(q(change, 'button[data-key="ringChange.useCode"]')).toBeNull();
    expect(q(change, 'button[data-key="ringChange.accept"]')).not.toBeNull();
  });
});

describe("pk-recovery-code: the real code", () => {
  it("is read out group by group as an image with a label, and copied hyphenated", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const el = await mount(
      "RecoveryCode",
      { recoveryCode: {} },
      { code: CODE.toLowerCase().replace(/-/g, " ") },
    );
    const box = q(el, ".recovery-groups")!;
    expect(box.getAttribute("role")).toBe("img");
    expect(box.getAttribute("aria-label")).toContain("K 7 Q F, 2 M 9 D");
    expect(
      [...el.shadowRoot!.querySelectorAll(".recovery-groups .g")].map(
        (g) => g.textContent,
      ),
    ).toEqual(GROUPS);
    vi.useFakeTimers();
    try {
      (q(el, 'button[data-key="recoveryCode.copy"]') as HTMLElement).click();
      expect(writeText).toHaveBeenCalledWith(CODE);
      expect(
        q(el, 'button[data-key="recoveryCode.copy"]')!.textContent,
      ).toContain("Copied");
      expect(q(el, "[data-copied-status]")!.textContent).toBe("Copied");
      await vi.advanceTimersByTimeAsync(2100);
      expect(
        q(el, 'button[data-key="recoveryCode.copy"]')!.textContent,
      ).toContain("Copy code");
    } finally {
      vi.useRealTimers();
    }
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

describe("pk-ring-change: failed and busy", () => {
  it("says accepting failed above the actions, keeps Accept, and shows progress while it runs", async () => {
    const el = await mount("RingChange", {
      ringChange: { by: "Maya's MacBook", served: SERVED, failed: true },
    });
    expect(el.view.state).toBe("failed");
    const reason = q(el, '[data-key="ringChange.failed"]')!;
    expect(
      reason.compareDocumentPosition(q(el, ".actions")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(q(el, 'button[data-key="ringChange.accept"]')).not.toBeNull();
    el.input = { ringChange: { served: SERVED, busy: true } };
    await el.updateComplete;
    expect(
      q(el, 'button[data-key="ringChange.accept"]')!.getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
  });
});
