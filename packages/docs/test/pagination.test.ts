/** Previous and next stay inside the door's own sidebar (B-163). */

import { describe, expect, it } from "vitest";
import { scopedPagination } from "../src/lib/helpHost";

const link = (id: string, label: string, isCurrent = false) => ({
  type: "link" as const,
  href: `/docs/${id}/`,
  label,
  isCurrent,
});

describe("scopedPagination", () => {
  const sidebar = [
    {
      type: "group" as const,
      entries: [link("start/a", "A"), link("start/b", "B", true)],
    },
    link("start/c", "C"),
  ];
  const crossDoor = {
    prev: { href: "/docs/help/x/", label: "Help X" },
    next: undefined,
  };

  it("replaces a neighbour from another door with the door's own", () => {
    const out = scopedPagination(sidebar, crossDoor, {
      prev: false,
      next: false,
    });
    expect(out.prev).toMatchObject({ href: "/docs/start/a/", label: "A" });
    expect(out.next).toMatchObject({ href: "/docs/start/c/", label: "C" });
  });

  it("has no previous on the first page of a door", () => {
    const first = [link("start/a", "A", true), link("start/b", "B")];
    const out = scopedPagination(first, crossDoor, {
      prev: false,
      next: false,
    });
    expect(out.prev).toBeUndefined();
  });

  it("keeps a direction the frontmatter sets", () => {
    const out = scopedPagination(sidebar, crossDoor, {
      prev: true,
      next: false,
    });
    expect(out.prev).toBe(crossDoor.prev);
  });
});
