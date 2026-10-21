import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";
import { SaveBar } from "../../src/ui/SaveBar.js";
import { useAdminForm } from "../../src/ui/form.js";
import { AppToaster, SAVE_BAR_INSET_VAR, toast } from "../../src/ui/toast.js";

afterEach(cleanup);

/** The toaster sits above a sticky save bar: the bar reports its height while it is up. */
describe("SaveBar and toasts", () => {
  it("sets the toast inset while the bar shows and clears it when it goes", () => {
    let form!: ReturnType<typeof useAdminForm<{ name: string }>>;
    function Page(): React.ReactElement {
      form = useAdminForm<{ name: string }>({
        values: { name: "a" },
        onSubmit: () => undefined,
      });
      return <SaveBar form={form} />;
    }
    render(<Page />);
    const root = document.documentElement.style;
    expect(root.getPropertyValue(SAVE_BAR_INSET_VAR)).toBe("");
    act(() => {
      form.rhf.setValue("name", "b", { shouldDirty: true });
    });
    expect(root.getPropertyValue(SAVE_BAR_INSET_VAR)).toMatch(/^\d+px$/);
    act(() => form.discard());
    expect(root.getPropertyValue(SAVE_BAR_INSET_VAR)).toBe("");
  });

  it("lifts an error toast (which stays until dismissed) by the same inset", async () => {
    const { findByText, container } = render(<AppToaster />);
    act(() => void toast.error("Nothing was saved. Try again."));
    await findByText("Nothing was saved. Try again.");
    const list = document.querySelector("[data-sonner-toaster]") as HTMLElement;
    expect(list.getAttribute("style")).toContain(SAVE_BAR_INSET_VAR);
    void container;
  });
});
