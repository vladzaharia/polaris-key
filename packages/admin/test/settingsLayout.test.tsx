/** Layout fixes on the settings pages that a class on the right element pins (B-045, B-046). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({ productMembers: vi.fn() }));
vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      ...actual.api,
      productMembers: (...a: unknown[]) => fns.productMembers(...a),
    },
  };
});

const { SettingsMembersPage } =
  await import("../src/console/sections/core/pages/SettingsMembers.js");
const { PresentationPreview } =
  await import("../src/console/sections/core/components/PresentationPreview.js");

beforeEach(resetCore);
afterEach(cleanup);

describe("settings layout", () => {
  it("B-046: Members gives the name column the width and Role a fixed end track", async () => {
    fns.productMembers.mockResolvedValue({
      product: "djdl",
      truncated: false,
      incomplete: false,
      members: [
        {
          memberId: "m1",
          name: "Ana",
          email: "ana@x.io",
          lastSignInAt: null,
          disabled: false,
          you: false,
          roles: [
            {
              role: "product_admin",
              scope: "product:djdl",
              areas: null,
              source: "grant",
              bindingId: "b1",
              grantedBy: null,
              grantedAt: null,
            },
          ],
        },
      ],
      invites: [],
      platformRoles: [],
    });
    renderAt("#/p/djdl/settings/members", <SettingsMembersPage slug="djdl" />);
    const head = (
      await screen.findAllByRole("columnheader", { name: "Member" })
    )[0]!;
    expect(head.className).not.toContain("w-3/5");
    expect(
      screen.getAllByRole("columnheader", { name: "Role" })[0]!.className,
    ).toContain("w-48");
  });

  it("B-045: the miniatures sit three across only at lg, and the sign-in head wraps instead of truncating", () => {
    const { container } = renderAt(
      "#/p/djdl/settings/presentation",
      <PresentationPreview
        name="A long product name"
        presentation={undefined}
        heroUrl={null}
      />,
    );
    const grid = container.querySelector("[data-theme]")!;
    expect(grid.className).toContain("lg:grid-cols-3");
    expect(grid.className).not.toContain("md:grid-cols-3");
    const head = screen.getByText(/wants you to sign in/).className;
    expect(head).toContain("[overflow-wrap:anywhere]");
    expect(head).not.toContain("truncate");
    expect(head).not.toContain("line-clamp");
  });
});
