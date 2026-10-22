import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TrustPolicyDto, TrustPolicyResponse } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";
import { WriteLock } from "../src/ui/WriteLock.js";

import { setStepUpRedirectForTests } from "../src/lib/stepUp.js";

const fns = vi.hoisted(() => ({
  trustPolicy: vi.fn(),
  putTrustPolicy: vi.fn(),
  resetTrustPolicy: vi.fn(),
  startStepUp: vi.fn(),
}));

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: Object.fromEntries(
      ["trustPolicy", "putTrustPolicy", "resetTrustPolicy"].map((k) => [
        k,
        (...a: unknown[]) =>
          (fns as Record<string, (...x: unknown[]) => unknown>)[k]!(...a),
      ]),
    ),
  };
});

const { ApiError } = await import("../src/api.js");
const { TrustPolicySection } =
  await import("../src/console/sections/core/pages/KeysTrust.js");
const { relaxesTrustPolicy, changeLines, DEFAULT_POLICY } =
  await import("../src/console/sections/core/model/trustPolicy.js");

const STRICT: TrustPolicyDto = {
  mint: "attested",
  gatedDelivery: "basic",
  commerceClaim: "basic",
  enforce: true,
  appAttest: { teamId: "ABCDE12345", environment: "production" },
  playIntegrity: null,
};

const reply = (
  policy: TrustPolicyDto,
  source: "default" | "admin",
  version: number,
): TrustPolicyResponse => ({ ok: true, policy, source, version });

const ALL_OFF = {
  distribution: { enabled: false },
  update: { enabled: false },
  commerce: { enabled: false },
  sync: { enabled: false },
};
const mount = (
  locked = false,
  services?: Record<string, { enabled: boolean }>,
) =>
  renderAt(
    "#/p/djdl/settings/keys",
    <WriteLock locked={locked} reason="View-only">
      <TrustPolicySection slug="djdl" services={services} />
    </WriteLock>,
  );

async function openEditor() {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Edit device trust" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "Device trust policy",
  });
  return { user, drawer };
}

beforeEach(() => {
  resetCore();
  for (const f of Object.values(fns)) f.mockReset();
  setStepUpRedirectForTests(() => fns.startStepUp());
  fns.trustPolicy.mockResolvedValue(reply(STRICT, "admin", 3));
});
afterEach(cleanup);

describe("Keys and secrets → Device trust", () => {
  it("reads the stored policy in words", async () => {
    mount();
    expect(await screen.findByText("ABCDE12345, production")).toBeTruthy();
    expect(screen.getByText("Refused")).toBeTruthy();
    expect(screen.getByText("Set in console")).toBeTruthy();
  });

  it("tightening asks once (L1), types nothing, and sends the version it read", async () => {
    fns.putTrustPolicy.mockResolvedValue(reply(STRICT, "admin", 4));
    mount();
    const { user, drawer } = await openEditor();
    await user.click(
      within(drawer).getByRole("combobox", { name: "Gated downloads" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Attested device" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Review changes…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Tighten the device trust policy?"),
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText(/Type core.trustPolicy/)).toBeNull();
    expect(within(dialog).queryByLabelText("Reason")).toBeNull();
    await user.click(
      within(dialog).getByRole("button", { name: "Tighten policy" }),
    );
    await waitFor(() => expect(fns.putTrustPolicy).toHaveBeenCalledTimes(1));
    expect(fns.putTrustPolicy).toHaveBeenCalledWith("djdl", {
      policy: { ...STRICT, gatedDelivery: "attested" },
      expectedVersion: 3,
    });
  });

  it("relaxing names the consequence, needs a reason and the typed key, then sends the guard", async () => {
    fns.putTrustPolicy.mockResolvedValue(reply(DEFAULT_POLICY, "admin", 4));
    mount();
    const { user, drawer } = await openEditor();
    await user.click(
      within(drawer).getByRole("switch", { name: /Refuse a device/ }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Review changes…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "Devices that fall short are logged and let through.",
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Relax policy",
    });
    expect(
      confirm.getAttribute("aria-disabled") ?? confirm.hasAttribute("disabled"),
    ).toBeTruthy();
    await user.type(
      within(dialog).getByLabelText("Reason"),
      "Beta cohort on sideloaded builds",
    );
    await user.type(
      within(dialog).getByLabelText(/Type core.trustPolicy/),
      "core.trustPolicy",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Relax policy" }),
    );
    await waitFor(() => expect(fns.putTrustPolicy).toHaveBeenCalledTimes(1));
    expect(fns.putTrustPolicy).toHaveBeenCalledWith("djdl", {
      policy: { ...STRICT, enforce: false },
      expectedVersion: 3,
      reason: "Beta cohort on sideloaded builds",
      confirm: "core.trustPolicy",
    });
  });

  it("a missing step-up keeps the dialog, says why and offers the sign-in", async () => {
    fns.putTrustPolicy.mockRejectedValue(
      new ApiError(403, undefined, "step_up_required"),
    );
    mount();
    const { user, drawer } = await openEditor();
    await user.click(
      within(drawer).getByRole("switch", { name: /Refuse a device/ }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Review changes…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Reason"), "Testing");
    await user.type(
      within(dialog).getByLabelText(/Type core.trustPolicy/),
      "core.trustPolicy",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Relax policy" }),
    );
    expect(
      await within(dialog).findByText("Sign in again to confirm it's you"),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Sign in again" }),
    );
    expect(fns.startStepUp).toHaveBeenCalled();
  });

  it("reset to default is a relaxation: same guard, then DELETE with it", async () => {
    fns.resetTrustPolicy.mockResolvedValue(reply(DEFAULT_POLICY, "default", 4));
    mount();
    const { user, drawer } = await openEditor();
    await user.click(
      within(drawer).getByRole("button", { name: "Reset to default…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.type(
      within(dialog).getByLabelText("Reason"),
      "Dropping attestation",
    );
    await user.type(
      within(dialog).getByLabelText(/Type core.trustPolicy/),
      "core.trustPolicy",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Reset policy" }),
    );
    await waitFor(() => expect(fns.resetTrustPolicy).toHaveBeenCalledTimes(1));
    expect(fns.resetTrustPolicy).toHaveBeenCalledWith("djdl", {
      expectedVersion: 3,
      reason: "Dropping attestation",
      confirm: "core.trustPolicy",
    });
  });

  it("a policy changed since opening names the conflict, keeps the edits and offers Reload", async () => {
    fns.putTrustPolicy.mockRejectedValue(
      new ApiError(
        409,
        undefined,
        "bad_request",
        undefined,
        "version_conflict",
      ),
    );
    mount();
    const { user, drawer } = await openEditor();
    await user.click(
      within(drawer).getByRole("combobox", { name: "Gated downloads" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Attested device" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Review changes…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Tighten policy" }),
    );
    expect(
      await screen.findByText("This policy changed since you opened it"),
    ).toBeTruthy();
    fns.trustPolicy.mockResolvedValue(
      reply({ ...STRICT, commerceClaim: "attested" }, "admin", 4),
    );
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByText("Reloaded")).toBeTruthy();
    // The edit survives the reload.
    expect(
      within(
        screen.getByRole("dialog", { name: "Device trust policy" }),
      ).getByRole("combobox", {
        name: "Gated downloads",
      }).textContent,
    ).toContain("Attested device");
    await expectNoAxeViolations(document.body);
  });

  it("a view-only member reads the policy; Edit is locked and opens nothing", async () => {
    mount(true);
    expect(await screen.findByText("ABCDE12345, production")).toBeTruthy();
    const edit = screen.getByRole("button", { name: "Edit device trust" });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    await userEvent.setup().click(edit);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the error state with Retry when the policy cannot load", async () => {
    fns.trustPolicy.mockRejectedValue(new ApiError(500));
    mount();
    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeTruthy();
  });

  it("passes axe: the section, the editor and the confirmation", async () => {
    const { container } = mount();
    await screen.findByText("ABCDE12345, production");
    await expectNoAxeViolations(container);
    const { user, drawer } = await openEditor();
    await expectNoAxeViolations(document.body);
    await user.click(
      within(drawer).getByRole("switch", { name: /Refuse a device/ }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Review changes…" }),
    );
    await screen.findByRole("alertdialog");
    await expectNoAxeViolations(document.body);
  });
});

const valueOf = async (term: string) =>
  (await screen.findByText(term)).nextElementSibling?.textContent;

describe("Cloud Sync writes row (U-05.11)", () => {
  it("is hidden while Cloud Sync is off, as are the other service-tied rows", async () => {
    mount(false, ALL_OFF);
    await screen.findByText("ABCDE12345, production");
    expect(screen.queryByText("Cloud Sync writes")).toBeNull();
    expect(screen.queryByText("Gated downloads")).toBeNull();
    expect(screen.queryByText("Store purchase claims")).toBeNull();
    expect(screen.getByText("Device license and config")).toBeTruthy();
  });

  it("an attested level is never invisible: it shows with the service that is off", async () => {
    fns.trustPolicy.mockResolvedValue(
      reply(
        { ...STRICT, cloudSyncWrite: "attested", commerceClaim: "attested" },
        "admin",
        3,
      ),
    );
    mount(false, ALL_OFF);
    expect(await valueOf("Cloud Sync writes")).toBe(
      "Attested device (Cloud Sync is off)",
    );
    expect(await valueOf("Store purchase claims")).toBe(
      "Attested device (Commerce is off)",
    );
    expect(screen.queryByText("Gated downloads")).toBeNull();
  });

  it("Distribution or Update on keeps Gated downloads", async () => {
    mount(false, { ...ALL_OFF, update: { enabled: true } });
    expect(await valueOf("Gated downloads")).toBe("Any device");
  });

  it("reads Any device for a policy that predates it", async () => {
    mount();
    expect(await valueOf("Cloud Sync writes")).toBe("Any device");
  });

  it("reads Attested device when set", async () => {
    fns.trustPolicy.mockResolvedValue(
      reply({ ...STRICT, cloudSyncWrite: "attested" }, "admin", 3),
    );
    mount();
    expect(await valueOf("Cloud Sync writes")).toBe("Attested device");
  });

  it("groups the operations apart from the policy-wide facts", async () => {
    mount();
    const op = (await screen.findByText("Cloud Sync writes")).closest("dl")!;
    const facts = screen.getByText("A miss").closest("dl")!;
    expect(op).not.toBe(facts);
    expect(op.className).toContain("lg:grid-cols-4");
    expect(facts.textContent).not.toContain("Cloud Sync writes");
  });

  it("the drawer says what a refusal means", async () => {
    mount();
    const { drawer } = await openEditor();
    expect(
      within(drawer).getByText(
        "Web and desktop builds can't attest. A refused change stays on the device.",
      ),
    ).toBeTruthy();
  });

  it("raising it is L1 and enforcing it says what is refused", async () => {
    fns.putTrustPolicy.mockResolvedValue(reply(STRICT, "admin", 4));
    mount();
    const { user, drawer } = await openEditor();
    await user.click(
      within(drawer).getByRole("combobox", { name: "Cloud Sync writes" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Attested device" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Review changes…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "Cloud Sync writes now need an attested device (was any device).",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Web, desktop and sideloaded builds can't attest, so they're refused: Device license and config, Cloud Sync writes.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/can't upload Cloud Sync/)).toBeNull();
    expect(
      within(dialog).getByText("Tighten the device trust policy?"),
    ).toBeTruthy();
  });

  it("changeLines names every attested operation once, only when enforced", () => {
    const all = {
      ...STRICT,
      gatedDelivery: "attested" as const,
      commerceClaim: "attested" as const,
      cloudSyncWrite: "attested" as const,
    };
    const on = changeLines({ ...STRICT, enforce: false }, all);
    expect(on.at(-1)).toBe(
      "Web, desktop and sideloaded builds can't attest, so they're refused: Device license and config, Gated downloads, Store purchase claims, Cloud Sync writes.",
    );
    expect(on.indexOf("Devices that fall short are refused.")).toBeLessThan(
      on.length - 1,
    );
    expect(
      on.filter((l) => /Cloud Sync/.test(l) && /refused:/.test(l)),
    ).toHaveLength(1);
    expect(on.some((l) => /can't upload/.test(l))).toBe(false);
    expect(
      changeLines(
        { ...STRICT, enforce: false },
        { ...all, enforce: false },
      ).some((l) => /refused:/.test(l)),
    ).toBe(false);
    expect(
      changeLines(
        { ...STRICT, enforce: true, mint: "basic" },
        { ...STRICT, enforce: true, mint: "basic" },
      ),
    ).toEqual([]);
  });

  it("changeLines uses one template for every operation and the relax confirm drops the enrol sentence", async () => {
    const lines = changeLines(
      { ...STRICT, mint: "attested", enforce: false },
      { ...STRICT, mint: "basic", enforce: false, commerceClaim: "attested" },
    );
    expect(lines).toEqual([
      "Device license and config now accept any device (was attested only).",
      "Store purchase claims now need an attested device (was any device).",
    ]);
    fns.putTrustPolicy.mockResolvedValue(reply(DEFAULT_POLICY, "admin", 4));
    mount();
    const { user, drawer } = await openEditor();
    await user.click(
      within(drawer).getByRole("switch", { name: /Refuse a device/ }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Review changes…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByText(/enrol|clients/)).toBeNull();
    expect(within(dialog).getByText(/Devices need to prove less/)).toBeTruthy();
  });

  it("relaxing it is L2; raising it is not", () => {
    expect(
      relaxesTrustPolicy(
        { ...STRICT, cloudSyncWrite: "attested" },
        { ...STRICT, cloudSyncWrite: "basic" },
      ),
    ).toBe(true);
    expect(
      relaxesTrustPolicy(STRICT, { ...STRICT, cloudSyncWrite: "attested" }),
    ).toBe(false);
  });
});

describe("relaxesTrustPolicy (the console's copy of the Worker's rule)", () => {
  it("catches each relaxing shape and passes tightening ones", () => {
    const relaxing: TrustPolicyDto[] = [
      { ...STRICT, mint: "basic" },
      { ...STRICT, enforce: false },
      { ...STRICT, appAttest: null },
      {
        ...STRICT,
        appAttest: { teamId: "ZZZZZ99999", environment: "production" },
      },
      {
        ...STRICT,
        appAttest: { teamId: "ABCDE12345", environment: "development" },
      },
      DEFAULT_POLICY,
    ];
    for (const after of relaxing)
      expect(relaxesTrustPolicy(STRICT, after)).toBe(true);
    expect(relaxesTrustPolicy(STRICT, STRICT)).toBe(false);
    // The first App Attest block opens an attestation path (N1), unless it is the default shape.
    expect(relaxesTrustPolicy(DEFAULT_POLICY, STRICT)).toBe(true);
    expect(
      relaxesTrustPolicy(DEFAULT_POLICY, {
        ...DEFAULT_POLICY,
        appAttest: { teamId: null, environment: "production" },
      }),
    ).toBe(false);
    expect(
      relaxesTrustPolicy(STRICT, { ...STRICT, commerceClaim: "attested" }),
    ).toBe(false);
    expect(
      relaxesTrustPolicy(STRICT, {
        ...STRICT,
        playIntegrity: { cloudProjectNumber: null },
      }),
    ).toBe(false);
    expect(
      relaxesTrustPolicy(
        { ...STRICT, playIntegrity: { cloudProjectNumber: "1" } },
        {
          ...STRICT,
          playIntegrity: {
            cloudProjectNumber: "1",
            allowTestingResponses: true,
          },
        },
      ),
    ).toBe(true);
  });
});
