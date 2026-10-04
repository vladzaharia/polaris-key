import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import * as React from "react";
import { ApiError } from "../../src/api.js";
import { DateInput } from "../../src/ui/DateInput.js";
import { useAdminForm } from "../../src/ui/form.js";

afterEach(cleanup);

interface Terms {
  name: string;
  seats: number;
}

function useTerms(values: Terms, onSubmit = vi.fn()) {
  return useAdminForm<Terms>({ values, onSubmit });
}

describe("useAdminForm", () => {
  it("re-seeds from the server while the draft is clean", () => {
    const { result, rerender } = renderHook(({ v }) => useTerms(v), {
      initialProps: { v: { name: "Pro", seats: 3 } },
    });
    expect(result.current.rhf.getValues("name")).toBe("Pro");
    rerender({ v: { name: "Pro plus", seats: 3 } });
    expect(result.current.rhf.getValues("name")).toBe("Pro plus");
    expect(result.current.server.name).toBe("Pro plus");
    expect(result.current.serverChanged).toBe(false);
    expect(result.current.isDirty).toBe(false);
  });

  it("does not re-seed while dirty: the draft survives a refetch and serverChanged turns on", () => {
    const { result, rerender } = renderHook(({ v }) => useTerms(v), {
      initialProps: { v: { name: "Pro", seats: 3 } },
    });
    act(() => {
      result.current.rhf.setValue("seats", 5, { shouldDirty: true });
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.dirtyFields).toEqual(["seats"]);

    rerender({ v: { name: "Pro (renamed elsewhere)", seats: 3 } });
    expect(result.current.rhf.getValues()).toEqual({ name: "Pro", seats: 5 });
    expect(result.current.serverChanged).toBe(true);
    expect(result.current.incoming).toEqual({
      name: "Pro (renamed elsewhere)",
      seats: 3,
    });
    expect(result.current.server.name).toBe("Pro");
  });

  it("an identical refetch while dirty changes nothing", () => {
    const { result, rerender } = renderHook(({ v }) => useTerms(v), {
      initialProps: { v: { name: "Pro", seats: 3 } },
    });
    act(() => {
      result.current.rhf.setValue("seats", 5, { shouldDirty: true });
    });
    rerender({ v: { name: "Pro", seats: 3 } });
    expect(result.current.serverChanged).toBe(false);
    expect(result.current.rhf.getValues("seats")).toBe(5);
  });

  it("acceptServer takes the new values; keepMine keeps the draft against them", () => {
    const { result, rerender } = renderHook(({ v }) => useTerms(v), {
      initialProps: { v: { name: "Pro", seats: 3 } },
    });
    act(() => {
      result.current.rhf.setValue("seats", 5, { shouldDirty: true });
    });
    rerender({ v: { name: "Pro 2", seats: 3 } });
    act(() => result.current.keepMine());
    expect(result.current.server).toEqual({ name: "Pro 2", seats: 3 });
    expect(result.current.rhf.getValues("seats")).toBe(5);
    expect(result.current.isDirty).toBe(true);
    expect(result.current.serverChanged).toBe(false);

    rerender({ v: { name: "Pro 3", seats: 4 } });
    expect(result.current.serverChanged).toBe(true);
    act(() => result.current.acceptServer());
    expect(result.current.rhf.getValues()).toEqual({ name: "Pro 3", seats: 4 });
    expect(result.current.isDirty).toBe(false);
  });

  it("maps an ApiError's fields onto the fields and keeps the draft", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new ApiError(422, ["seats"], "invalid"));
    const { result } = renderHook(() =>
      useTerms({ name: "Pro", seats: 3 }, onSubmit),
    );
    act(() => {
      result.current.rhf.setValue("seats", -1, { shouldDirty: true });
    });
    await act(() => result.current.submit());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(result.current.errors).toEqual({ seats: "Check this value." });
    expect(result.current.submitError).toBeInstanceOf(ApiError);
    expect(result.current.rhf.getValues("seats")).toBe(-1);
  });

  it("a successful submit makes the draft the new baseline", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useTerms({ name: "Pro", seats: 3 }, onSubmit),
    );
    act(() => {
      result.current.rhf.setValue("seats", 4, { shouldDirty: true });
    });
    await act(() => result.current.submit());
    expect(onSubmit.mock.calls[0]![0]).toEqual({ name: "Pro", seats: 4 });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.server.seats).toBe(4);
  });
});

describe("DateInput zone semantics (LIC-5)", () => {
  function Harness({
    timeZone,
    initial = null,
    onChange,
  }: {
    timeZone: string;
    initial?: number | null;
    onChange?: (v: number | null) => void;
  }) {
    const [v, setV] = React.useState<number | null>(initial);
    return (
      <DateInput
        aria-label="Expires"
        resolvedLabel="Expires"
        timeZone={timeZone}
        locale="en-GB"
        value={v}
        onChange={(next) => {
          setV(next);
          onChange?.(next);
        }}
      />
    );
  }

  it("stores the chosen day as its last second in the operator's zone, not midnight UTC", () => {
    const onChange = vi.fn();
    render(<Harness timeZone="America/Los_Angeles" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Expires"), {
      target: { value: "2026-09-30" },
    });
    // 30 Sep 23:59:59 PDT (UTC−7) is 1 Oct 06:59:59 UTC.
    expect(onChange).toHaveBeenCalledWith(Date.UTC(2026, 9, 1, 6, 59, 59));
  });

  it("east of UTC the instant falls on the previous UTC day", () => {
    const onChange = vi.fn();
    render(<Harness timeZone="Asia/Tokyo" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Expires"), {
      target: { value: "2026-09-30" },
    });
    // 30 Sep 23:59:59 JST (UTC+9) is 30 Sep 14:59:59 UTC.
    expect(onChange).toHaveBeenCalledWith(Date.UTC(2026, 8, 30, 14, 59, 59));
  });

  it("shows the stored instant as the same local day, with the resolved time and zone", () => {
    render(
      <Harness
        timeZone="America/Los_Angeles"
        initial={Date.UTC(2026, 9, 1, 6, 59, 59)}
      />,
    );
    const input = screen.getByLabelText("Expires") as HTMLInputElement;
    expect(input.value).toBe("2026-09-30");
    const resolved = document.getElementById(
      input.getAttribute("aria-describedby")!.split(" ").pop()!,
    )!;
    expect(resolved.textContent).toMatch(/^Expires 30 Sept? 2026/);
    expect(resolved.textContent).toMatch(/23:59/);
    expect(resolved.textContent).toMatch(/PDT|GMT-7|UTC-7/);
  });

  it("handles a DST change: the day ends at 23:59:59 local on either side", () => {
    const onChange = vi.fn();
    render(<Harness timeZone="Europe/Berlin" onChange={onChange} />);
    const input = screen.getByLabelText("Expires");
    fireEvent.change(input, { target: { value: "2026-10-25" } }); // CEST → CET that morning
    expect(onChange).toHaveBeenLastCalledWith(
      Date.UTC(2026, 9, 25, 22, 59, 59),
    );
    fireEvent.change(input, { target: { value: "2026-10-24" } });
    expect(onChange).toHaveBeenLastCalledWith(
      Date.UTC(2026, 9, 24, 21, 59, 59),
    );
  });

  it("clearing sends null and says so", () => {
    const onChange = vi.fn();
    render(
      <Harness
        timeZone="UTC"
        initial={Date.UTC(2026, 8, 30, 23, 59, 59)}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Expires"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.getByText("No date set.")).toBeTruthy();
  });
});
