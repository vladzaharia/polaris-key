import { vi } from "vitest";

/** The `vi.mock("../src/api.js")` factory the page suites share: `api.<name>` calls `fns.<name>`. */
export async function apiFnsMock(
  fns: Record<string, (...a: unknown[]) => unknown>,
): Promise<Record<string, unknown>> {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: Object.fromEntries(
      Object.keys(fns).map((k) => [k, (...a: unknown[]) => fns[k]!(...a)]),
    ),
  };
}
