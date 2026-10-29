// I-49.5: the Platform sign-in card's "Purge restore keys": a danger confirmation that needs the
// product slug typed, sends it as confirmSlug, and keeps the dialog open with the error when the
// server refuses (a missing step-up included).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const purgeRestoreKeys =
  vi.fn<(slug: string, confirmSlug: string) => Promise<unknown>>();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      purgeRestoreKeys: (slug: string, confirmSlug: string) =>
        purgeRestoreKeys(slug, confirmSlug),
    },
  };
});

const { HttpError } = await import("../src/api.js");
const { RestorePurge } =
  await import("../src/console/sections/identity/components/RestorePurge.js");

const mount = () => renderAt("#/p/djdl/identity", <RestorePurge slug="djdl" />);

beforeEach(() => {
  resetCore();
  purgeRestoreKeys.mockReset();
});
afterEach(cleanup);

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Purge restore keys…" }),
  );
  return screen.findByRole("alertdialog");
}

describe("Purge restore keys", () => {
  it("stays disabled until the slug is typed, then sends it as confirmSlug and reports the count", async () => {
    const user = userEvent.setup();
    purgeRestoreKeys.mockResolvedValue({ ok: true, purged: 3 });
    mount();
    const dialog = await openDialog(user);
    const confirm = within(dialog).getByRole("button", {
      name: "Purge restore keys",
    });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await user.click(confirm);
    expect(purgeRestoreKeys).not.toHaveBeenCalled();
    await user.type(
      within(dialog).getByLabelText(/Type the product slug/),
      "djdl",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Purge restore keys" }),
    );
    await waitFor(() =>
      expect(purgeRestoreKeys).toHaveBeenCalledWith("djdl", "djdl"),
    );
    expect(await screen.findByText("Deleted 3 restore keys")).toBeTruthy();
  });

  it("keeps the dialog open when the server refuses", async () => {
    const user = userEvent.setup();
    purgeRestoreKeys.mockRejectedValue(new HttpError(500));
    mount();
    const dialog = await openDialog(user);
    await user.type(
      within(dialog).getByLabelText(/Type the product slug/),
      "djdl",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Purge restore keys" }),
    );
    await waitFor(() => expect(purgeRestoreKeys).toHaveBeenCalled());
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByRole("button", { name: "Purge restore keys…" });
    await expectNoAxeViolations(container);
  });
});
