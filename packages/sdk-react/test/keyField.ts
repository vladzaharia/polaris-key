// The sign-in card's key field. When Sign in is offered too, the key form sits behind "Use a
// license key"; this opens it first, as a person would.
import { fireEvent, waitFor } from "@testing-library/react";
import { expect } from "vitest";

export async function keyField(
  container: HTMLElement,
): Promise<HTMLInputElement> {
  await waitFor(() =>
    expect(
      container.querySelector(
        "[data-polaris-key-input], [data-polaris-use-key]",
      ),
    ).toBeTruthy(),
  );
  const reveal = container.querySelector("[data-polaris-use-key]");
  if (reveal) fireEvent.click(reveal);
  return (await waitFor(() => {
    const el = container.querySelector("[data-polaris-key-input]");
    expect(el).toBeTruthy();
    return el;
  })) as HTMLInputElement;
}
