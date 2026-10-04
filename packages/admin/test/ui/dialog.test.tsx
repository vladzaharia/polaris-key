import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { Dialog, DialogBody } from "../../src/ui/Dialog.js";
import { Drawer, routedDrawer } from "../../src/ui/Drawer.js";

afterEach(cleanup);

function Harness({
  dismissible,
}: {
  dismissible: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Edit holder"
        dismissible={dismissible}
      >
        <DialogBody>
          <input aria-label="Name" />
        </DialogBody>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("closes on Escape when dismissible", async () => {
    const user = userEvent.setup();
    render(<Harness dismissible />);
    await screen.findByRole("dialog", { name: "Edit holder" });
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("dismissible={false} blocks Escape, outside click and drops the close button", async () => {
    const user = userEvent.setup();
    render(<Harness dismissible={false} />);
    await screen.findByRole("dialog", { name: "Edit holder" });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("is a bottom sheet below 640 px and centred from sm up", async () => {
    render(<Harness dismissible />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("bottom-0");
    expect(dialog.className).toContain("max-h-[92dvh]");
    expect(dialog.className).toContain("sm:top-1/2");
  });
});

describe("Drawer", () => {
  it("has a Back button (shown below 1024 px) that closes it", async () => {
    const user = userEvent.setup();
    function D(): React.ReactElement {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <span data-testid="state">{open ? "open" : "closed"}</span>
          <Drawer open={open} onOpenChange={setOpen} title="dev_1" />
        </>
      );
    }
    render(<D />);
    const back = await screen.findByRole("button", { name: "Back" });
    expect(back.className).toContain("lg:hidden");
    await user.click(back);
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("routedDrawer opens for an id and closes through the route", () => {
    let closed = false;
    const props = routedDrawer("dev_1", () => (closed = true));
    expect(props.open).toBe(true);
    props.onOpenChange(false);
    expect(closed).toBe(true);
    expect(routedDrawer(undefined, () => undefined).open).toBe(false);
  });
});
