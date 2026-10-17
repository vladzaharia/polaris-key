import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Book } from "lucide-react";
import { lineDiff } from "../src/console/sections/config/model/edgeMintFields.js";
import { SidebarItem } from "../src/console/shell/Sidebar.js";

describe("lineDiff", () => {
  it("does not mark the previous last line when a claim is added after it (N17)", () => {
    const was = ["{", '  "iss": "TEAM"', "}"];
    const now = ["{", '  "iss": "TEAM",', '  "aud": "x"', "}"];
    expect(lineDiff(was, now).map((l) => [l.kind, l.text])).toEqual([
      ["same", "{"],
      ["same", '  "iss": "TEAM",'],
      ["add", '  "aud": "x"'],
      ["same", "}"],
    ]);
  });
});

describe("the collapsed rail's attention count (N9)", () => {
  it("names the count and draws a dot", () => {
    const { container } = render(
      <SidebarItem
        page={{ page: "catalog", label: "Catalog", icon: Book } as never}
        to="#/p/djdl/config/catalog"
        active={false}
        rail
        badge={2}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Catalog, 2 recipes need approval" }),
    ).toBeTruthy();
    expect(container.querySelector("[data-nav-dot]")).not.toBeNull();
  });
});
