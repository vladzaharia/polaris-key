import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { Dialog, DialogBody, useDismissGuard } from "../../src/ui/Dialog.js";
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
  it("brings the focused field into view (nearest) where the body scrolls", async () => {
    const calls: unknown[] = [];
    const proto = Element.prototype as unknown as {
      scrollIntoView?: (o?: unknown) => void;
    };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = function (o) {
      calls.push([(this as HTMLElement).getAttribute("aria-label"), o]);
    };
    try {
      render(<Harness dismissible />);
      await screen.findByRole("dialog", { name: "Edit holder" });
      await waitFor(() =>
        expect(calls).toContainEqual(["Name", { block: "nearest" }]),
      );
    } finally {
      proto.scrollIntoView = had;
    }
  });

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

// ── Flow conformance (FLOWS.md §2 C13, C18; UX-77) ─────────────────────────────────────────────

function Opened({
  children,
  unsaved,
  drawer = false,
}: {
  children?: React.ReactNode;
  unsaved?: boolean;
  drawer?: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const Overlay = drawer ? Drawer : Dialog;
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      <Overlay
        open={open}
        onOpenChange={setOpen}
        title="Edit holder"
        unsaved={unsaved}
      >
        {children}
      </Overlay>
    </>
  );
}

describe("Dialog and Drawer focus (C18)", () => {
  it("puts first focus on the first field, never on Close", async () => {
    const user = userEvent.setup();
    render(
      <Opened>
        <DialogBody>
          <button type="button">Help</button>
          <input aria-label="Name" />
        </DialogBody>
      </Opened>,
    );
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Name")),
    );
  });

  it("puts first focus on the title when there is no field", async () => {
    const user = userEvent.setup();
    render(
      <Opened>
        <DialogBody>
          <button type="button">Help</button>
        </DialogBody>
      </Opened>,
    );
    await user.click(screen.getByRole("button", { name: "Open it" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Edit holder"),
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("drawers skip Back and Close too", async () => {
    const user = userEvent.setup();
    render(
      <Opened drawer>
        <input aria-label="Name" readOnly />
        <input aria-label="Value" />
      </Opened>,
    );
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await screen.findByRole("dialog");
    // A read-only field is skipped as well (Set secret with a preselected name).
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Value")),
    );
  });

  it("returns focus to the opener on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Opened>
        <input aria-label="Name" />
      </Opened>,
    );
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("state").textContent).toBe("closed");
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("Dialog and Drawer unsaved guard (C13)", () => {
  it("asks before Escape drops unsaved input; Keep editing keeps it open", async () => {
    const user = userEvent.setup();
    render(
      <Opened unsaved>
        <input aria-label="Name" />
      </Opened>,
    );
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("state").textContent).toBe("open");
    expect(screen.getByRole("alert").textContent).toContain(
      "Discard your changes?",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Keep editing" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("state").textContent).toBe("open");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("a child marks the drawer unsaved with useDismissGuard", async () => {
    const user = userEvent.setup();
    function Field(): React.ReactElement {
      const [v, setV] = React.useState("");
      useDismissGuard(v !== "");
      return (
        <input
          aria-label="Name"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
      );
    }
    render(
      <Opened drawer>
        <Field />
      </Opened>,
    );
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await screen.findByRole("dialog");
    // Clean: Back closes at once.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("state").textContent).toBe("closed");
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await user.type(await screen.findByLabelText("Name"), "Ada");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("state").textContent).toBe("open");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });
});

describe("DialogBody tab stop", () => {
  it("joins the tab order only once its overflow has settled (B-092)", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const realRO = g.ResizeObserver;
    const callbacks: Array<() => void> = [];
    g.ResizeObserver = class {
      constructor(cb: () => void) {
        callbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    };
    // Animation frames run by hand, so the test decides what each reading sees.
    const queue: FrameRequestCallback[] = [];
    const realRaf = globalThis.requestAnimationFrame;
    const realCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => queue.push(cb);
    globalThis.cancelAnimationFrame = (id) => {
      queue[id - 1] = () => undefined;
    };
    const flush = (): void => {
      while (queue.length) queue.shift()!(0);
    };
    let scrollHeight = 500;
    const sh = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const ch = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 300,
    });
    try {
      render(<Harness dismissible />);
      const body = (): Element =>
        document.querySelector("[data-pk-dialog-body]")!;
      // A transient overflow that is gone by the second frame never becomes a tab stop.
      const first = queue.shift()!;
      first(0);
      scrollHeight = 200;
      flush();
      expect(body().getAttribute("tabindex")).toBeNull();
      // A resize while it still overflows, steady across both frames, does.
      scrollHeight = 500;
      callbacks.forEach((cb) => cb());
      await React.act(async () => flush());
      expect(body().getAttribute("tabindex")).toBe("0");
      // And it leaves the tab order once the content fits again.
      scrollHeight = 200;
      callbacks.forEach((cb) => cb());
      await React.act(async () => flush());
      expect(body().getAttribute("tabindex")).toBeNull();
    } finally {
      g.ResizeObserver = realRO;
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCaf;
      if (sh) Object.defineProperty(HTMLElement.prototype, "scrollHeight", sh);
      else
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)
          .scrollHeight;
      if (ch) Object.defineProperty(HTMLElement.prototype, "clientHeight", ch);
      else
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)
          .clientHeight;
    }
  });
});
