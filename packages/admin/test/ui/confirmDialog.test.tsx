import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import {
  ConfirmDialog,
  type ConfirmDialogProps,
} from "../../src/ui/ConfirmDialog.js";
import { ConfirmDialog as LegacyConfirmDialog } from "../../src/components/ui/ConfirmDialog.js";

afterEach(cleanup);

function Harness(
  props: Partial<ConfirmDialogProps> & {
    onConfirm: ConfirmDialogProps["onConfirm"];
  },
): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete DJDL?"
        confirmLabel="Delete product"
        {...props}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("defaults to neutral: a primary confirm, no danger icon, focus on Cancel", async () => {
    render(
      <Harness onConfirm={() => undefined} consequences={["One", "Two"]} />,
    );
    const dialog = await screen.findByRole("alertdialog");
    const confirm = screen.getByRole("button", { name: "Delete product" });
    expect(confirm.className).toContain("bg-accent");
    expect(confirm.className).not.toContain("bg-danger");
    expect(dialog.querySelectorAll("li")).toHaveLength(2);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Cancel" }),
      ),
    );
  });

  it("danger intent styles the confirm as danger", async () => {
    render(<Harness intent="danger" onConfirm={() => undefined} />);
    const confirm = await screen.findByRole("button", {
      name: "Delete product",
    });
    expect(confirm.className).toContain("bg-danger");
  });

  it("gates the confirm until the typed value matches exactly, and paste works", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <Harness
        intent="danger"
        typedConfirmation={{
          value: "djdl",
          label: "Type the product slug to confirm",
        }}
        onConfirm={onConfirm}
      />,
    );
    const confirm = await screen.findByRole("button", {
      name: "Delete product",
    });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    const input = screen.getByLabelText(/Type the product slug to confirm/);
    await user.type(input, "DJDL");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await user.clear(input);
    input.focus();
    await user.paste("djdl");
    // The button re-renders without its disabled-reason tooltip: query it again.
    const enabled = screen.getByRole("button", { name: "Delete product" });
    expect(enabled.getAttribute("aria-disabled")).toBeNull();
    await user.click(enabled);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("closed"),
    );
  });

  it("keeps the dialog open with the error inline, then retries", async () => {
    const user = userEvent.setup();
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("Someone changed this rollout."))
      .mockResolvedValueOnce(undefined);
    render(
      <Harness
        intent="caution"
        consequences={["Pauses it"]}
        onConfirm={onConfirm}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Delete product" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Someone changed this rollout.");
    expect(screen.getByTestId("state").textContent).toBe("open");
    await user.click(screen.getByRole("button", { name: "Delete product" }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("closed"),
    );
  });

  it("is busy while pending: Escape does nothing and Cancel is disabled", async () => {
    const user = userEvent.setup();
    let resolve: () => void = () => undefined;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<Harness onConfirm={onConfirm} />);
    await user.click(
      await screen.findByRole("button", { name: "Delete product" }),
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("state").textContent).toBe("open");
    resolve();
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("closed"),
    );
  });

  it("legacy re-export keeps the destructive default and leaves closing to the caller", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <LegacyConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Revoke key?"
        onConfirm={() => undefined}
      />,
    );
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(confirm.className).toContain("bg-danger");
    await user.click(confirm);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
