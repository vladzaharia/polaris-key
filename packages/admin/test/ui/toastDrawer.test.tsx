import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";
import { Drawer } from "../../src/ui/Drawer.js";
import { AppToaster, toast } from "../../src/ui/toast.js";

afterEach(cleanup);

/** An open drawer keeps toasts off its footer (ST-31.12). */
describe("toasts beside a drawer", () => {
  it("moves the toaster out from under an open drawer, and back when it closes", async () => {
    const wide = (q: string) => ({
      matches: q.includes("min-width: 1024px"),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    window.matchMedia = wide as never;
    function Page({ open }: { open: boolean }): React.ReactElement {
      return (
        <>
          <AppToaster />
          <Drawer open={open} onOpenChange={() => undefined} title="Roles" />
        </>
      );
    }
    const { rerender, findByText } = render(<Page open />);
    act(() => void toast.success("Areas saved"));
    await findByText("Areas saved");
    const list = () =>
      document.querySelector("[data-sonner-toaster]") as HTMLElement;
    // The panel is 28rem wide: the toast sits beside it.
    expect(list().getAttribute("style")).toContain("28rem");
    rerender(<Page open={false} />);
    expect(list().getAttribute("style") ?? "").not.toContain("28rem");
  });
});
