import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  FilterBar,
  SEARCH_DEBOUNCE_MS,
  type DataColumn,
  type DataTableProps,
  type Facet,
  type FilterBarFacet,
  type TableState,
} from "../../src/ui/data-table/index.js";
import { changedRowIds } from "../../src/ui/data-table/DataTable.js";
import { LIST_BUDGET, viewTransition } from "../../src/ui/motion/index.js";
import { StatusPill } from "../../src/ui/StatusPill.js";
import { SignedBadge } from "../../src/ui/SignedBadge.js";
import { PageSkeleton, Skeleton } from "../../src/ui/Skeleton.js";
import { RefetchBar } from "../../src/ui/loading.js";
import { Stepper } from "../../src/ui/Stepper.js";
import { BarList } from "../../src/ui/charts/BarList.js";
import { Funnel } from "../../src/ui/charts/Funnel.js";
import { Meter } from "../../src/ui/charts/Meter.js";
import { StatTile, headlineCount } from "../../src/ui/charts/StatTile.js";

/**
 * The console's data surfaces in motion (notes/S-23 §6.1 list, status, meter, count, skeleton;
 * MO-09). jsdom has no View Transitions and no Web Animations API, so the browser half is stubbed
 * here (a `startViewTransition` that runs its update a microtask later, as the browser does after
 * capturing the old state, and a `getAnimations` whose exit we finish by hand); the real motion
 * runs in e2e/dataMotion.e2e.test.ts.
 */

const html = document.documentElement;
const doc = document as unknown as { startViewTransition?: unknown };

interface VtCall {
  type: string | undefined;
  /** Rows the list carried a name for when the transition started (`.pk-vt-list`). */
  listed: boolean;
}

/** Install a View Transitions stand-in; returns the calls it saw. */
function withViewTransitions(): VtCall[] {
  const calls: VtCall[] = [];
  doc.startViewTransition = (update: () => void) => {
    calls.push({
      type: html.dataset.vt,
      listed: document.querySelector(".pk-vt-list") !== null,
    });
    const done = Promise.resolve().then(update);
    return {
      updateCallbackDone: done,
      ready: done,
      finished: done,
      skipTransition: () => undefined,
    };
  };
  return calls;
}

/** jsdom has no Element.getAnimations: one running exit per element, finished by `finish()`. */
function withExitAnimations(): { finish: () => Promise<void> } {
  let resolve: () => void = () => undefined;
  let finished = new Promise<void>((r) => (resolve = r));
  const proto = Element.prototype as unknown as { getAnimations?: unknown };
  proto.getAnimations = function (this: Element) {
    return this.getAttribute("data-state") === "closed" ? [{ finished }] : [];
  };
  return {
    finish: async () => {
      resolve();
      await act(async () => {
        await finished;
      });
      finished = new Promise<void>((r) => (resolve = r));
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete doc.startViewTransition;
  delete (Element.prototype as unknown as { getAnimations?: unknown })
    .getAnimations;
  delete html.dataset.motion;
  delete html.dataset.vt;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── DataTable ─────────────────────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  name: string;
  status: string;
}

const statuses = ["active", "expired", "suspended"];
const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`,
    name: `Seat ${String(i + 1).padStart(3, "0")}`,
    status: statuses[i % 3]!,
  }));

const COLUMNS: DataColumn<Row>[] = [
  { id: "name", header: "Holder", accessorKey: "name" },
  { id: "status", header: "Status", accessorKey: "status" },
];
const FACETS: Facet<Row>[] = [
  {
    id: "status",
    label: "Status",
    options: statuses.map((s) => ({ value: s, label: s })),
  },
];

function Table(
  props: Partial<DataTableProps<Row>> & { initial?: Partial<TableState> },
): React.ReactElement {
  const { initial, ...rest } = props;
  const [state, setState] = React.useState<TableState>({
    ...EMPTY_TABLE_STATE,
    ...initial,
  });
  return (
    <DataTable<Row>
      id="t"
      caption="Licenses"
      data={rows(8)}
      columns={COLUMNS}
      getRowId={(r) => r.id}
      rowLabel={(r) => r.name}
      facets={FACETS}
      search={{ placeholder: "Search licenses" }}
      state={state}
      onStateChange={setState}
      {...rest}
    />
  );
}

const bodyRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>("tbody tr[data-row-id]"));
const ids = (): string[] => bodyRows().map((r) => r.dataset.rowId!);

async function pickFacet(label: string): Promise<void> {
  await userEvent.click(
    screen.getByRole("button", { name: "Filter by status" }),
  );
  await userEvent.click(
    screen.getByRole("checkbox", { name: new RegExp(`^${label}`) }),
  );
  // The transition runs its update a microtask later.
  await act(async () => undefined);
}

describe("DataTable list transitions", () => {
  it("runs a facet change as one list transition over the body, and the filter lands", async () => {
    const calls = withViewTransitions();
    render(<Table />);
    const before = bodyRows();
    await pickFacet("active");
    expect(calls).toEqual([{ type: "list", listed: true }]);
    expect(ids()).toEqual(["r1", "r4", "r7"]);
    // React kept the keyed rows: the survivors are the same elements, so they pair and move.
    expect(bodyRows()).toEqual([before[0], before[3], before[6]]);
  });

  it("runs a filter set from outside the table (a page's tile, Back) as a list transition too", async () => {
    const calls = withViewTransitions();
    function Tile(): React.ReactElement {
      const [state, setState] = React.useState<TableState>(EMPTY_TABLE_STATE);
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setState({ ...state, filters: { status: ["expired"] } })
            }
          >
            Expired tile
          </button>
          <Table state={state} onStateChange={setState} />
        </>
      );
    }
    render(<Tile />);
    await userEvent.click(screen.getByRole("button", { name: "Expired tile" }));
    await act(async () => undefined);
    expect(calls).toEqual([{ type: "list", listed: true }]);
    expect(ids()).toEqual(["r2", "r5", "r8"]);
  });

  it("runs a sort as a list transition", async () => {
    const calls = withViewTransitions();
    render(<Table />);
    await userEvent.click(screen.getByRole("button", { name: /Holder/ }));
    await act(async () => undefined);
    await userEvent.click(screen.getByRole("button", { name: /Holder/ }));
    await act(async () => undefined);
    expect(calls.map((c) => c.type)).toEqual(["list", "list"]);
    expect(ids()[0]).toBe("r8");
  });

  it("never animates typing in search", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = withViewTransitions();
    render(<Table />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Seat 002" },
    });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    });
    expect(ids()).toEqual(["r2"]);
    expect(calls).toEqual([]);
  });

  it("never animates the virtualised path (over 200 rows)", async () => {
    const calls = withViewTransitions();
    render(<Table data={rows(240)} />);
    await pickFacet("active");
    expect(calls).toEqual([]);
  });

  it("never animates server paging", async () => {
    const calls = withViewTransitions();
    render(
      <Table
        pagination={{
          mode: "cursor",
          onLoadMore: () => undefined,
          hasMore: false,
          loadingMore: false,
        }}
      />,
    );
    await pickFacet("active");
    expect(calls).toEqual([]);
  });

  it("is an instant swap under reduced motion", async () => {
    html.dataset.motion = "reduce";
    const calls = withViewTransitions();
    render(<Table />);
    await pickFacet("active");
    expect(calls).toEqual([]);
    expect(ids()).toEqual(["r1", "r4", "r7"]);
  });

  it("a created row arrives through a list transition, tinted; a refetch that changes nothing does neither", async () => {
    const calls = withViewTransitions();
    const data = rows(4);
    const { rerender } = render(<Table data={data} />);
    // A refetch: new objects, same rows.
    rerender(<Table data={data.map((r) => ({ ...r }))} />);
    await act(async () => undefined);
    expect(calls).toEqual([]);
    expect(document.querySelector(".pk-row-highlight")).toBeNull();

    const created = { id: "new", name: "Seat 000", status: "active" };
    rerender(<Table data={[created, ...data]} />);
    await act(async () => undefined);
    expect(calls).toEqual([{ type: "list", listed: true }]);
    expect(ids()).toEqual(["new", "r1", "r2", "r3", "r4"]);
    const tinted = document.querySelectorAll("tr.pk-row-highlight");
    expect(
      Array.from(tinted).map((r) => r.getAttribute("data-row-id")),
    ).toEqual(["new"]);
  });

  it("a deleted row leaves through a list transition", async () => {
    const calls = withViewTransitions();
    const data = rows(4);
    const { rerender } = render(<Table data={data} />);
    rerender(<Table data={data.filter((r) => r.id !== "r2")} />);
    await act(async () => undefined);
    expect(calls).toEqual([{ type: "list", listed: true }]);
    expect(ids()).toEqual(["r1", "r3", "r4"]);
  });

  it("an edited row is tinted in place, with no transition", async () => {
    const calls = withViewTransitions();
    const data = rows(3);
    const { rerender } = render(<Table data={data} />);
    rerender(
      <Table
        data={data.map((r) => (r.id === "r2" ? { ...r, status: "active" } : r))}
      />,
    );
    await act(async () => undefined);
    expect(calls).toEqual([]);
    expect(
      Array.from(document.querySelectorAll("tr.pk-row-highlight")).map((r) =>
        r.getAttribute("data-row-id"),
      ),
    ).toEqual(["r2"]);
  });

  it("the first load is neither a transition nor a tint: the skeleton waits out its grace, the rows fade in", async () => {
    const calls = withViewTransitions();
    const { rerender } = render(<Table data={[]} loading />);
    expect(document.querySelector("tbody")!.className).toContain(
      "pk-skeleton-group",
    );
    expect(
      document.querySelectorAll("tbody .pk-skeleton").length,
    ).toBeGreaterThan(0);
    rerender(<Table data={rows(3)} loading={false} />);
    await act(async () => undefined);
    expect(calls).toEqual([]);
    expect(document.querySelector(".pk-row-highlight")).toBeNull();
    expect(document.querySelector("tbody")!.className).toContain(
      "pk-content-in",
    );
  });

  it("rows already there do not fade in", () => {
    render(<Table />);
    expect(document.querySelector("tbody")!.className).not.toContain(
      "pk-content-in",
    );
  });

  it("marks the table as the list's scope, and draws each row's line on its own cells", () => {
    render(<Table />);
    expect(
      document
        .querySelector("table")!
        .closest(".pk-vt-scope")!
        .parentElement!.matches("[data-table-id]"),
    ).toBe(true);
    // border-separate: the line under a row belongs to the row, so it moves with it.
    expect(document.querySelector("table")!.className).toContain(
      "border-separate",
    );
    expect(bodyRows()[0]!.className).toContain("[&>td]:border-b");
  });
});

describe("the list budget on both sides of the update", () => {
  it(`a list that grows past ${LIST_BUDGET} rows names only its on-screen rows in the new state`, async () => {
    let finish: () => void = () => undefined;
    doc.startViewTransition = (update: () => void) => {
      const done = Promise.resolve().then(update);
      const finished = done.then(() => new Promise<void>((r) => (finish = r)));
      return {
        updateCallbackDone: done,
        finished,
        skipTransition: () => finish(),
      };
    };
    const list = document.createElement("ul");
    document.body.append(list);
    const add = (n: number): HTMLLIElement[] =>
      Array.from({ length: n }, () => {
        const li = document.createElement("li");
        const i = list.children.length;
        li.getBoundingClientRect = () =>
          ({ top: i * 40, bottom: i * 40 + 40 }) as DOMRect;
        list.append(li);
        return li;
      });
    add(20);
    const handle = viewTransition(() => add(40), { type: "list", list });
    // The old state: 20 rows, all taking part.
    expect(list.classList.contains("pk-vt-list")).toBe(true);
    await handle.updateCallbackDone;
    // The new state: 60 rows, so only the ones on screen are named.
    expect(list.classList.contains("pk-vt-list")).toBe(false);
    const named = Array.from(list.children).filter(
      (r) =>
        (r as HTMLElement).style.getPropertyValue("view-transition-name") ===
        "match-element",
    );
    expect(named.length).toBe(Math.ceil(window.innerHeight / 40));
    expect(named.length).toBeLessThanOrEqual(LIST_BUDGET);
    finish();
    await handle.finished;
    list.remove();
  });
});

describe("changedRowIds", () => {
  it("names created and edited rows only", () => {
    const a = rows(3);
    const b = [
      { ...a[0]! },
      { ...a[1]!, name: "Renamed" },
      { id: "x", name: "New", status: "active" },
    ];
    expect(changedRowIds(a, b, (r) => r.id, COLUMNS)).toEqual(["r2", "x"]);
    expect(
      changedRowIds(
        a,
        a.map((r) => ({ ...r })),
        (r) => r.id,
        COLUMNS,
      ),
    ).toEqual([]);
  });
});

describe("the bulk-action bar", () => {
  const selection = {
    mode: "multi" as const,
    bulkActions: [{ label: "Suspend", onSelect: vi.fn() }],
  };

  it("enters through Presence and leaves through its exit, keeping its count, then the filter bar returns", async () => {
    const anim = withExitAnimations();
    render(<Table selection={selection} />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Select Seat 001" }),
    );
    const bar = screen.getByText("1 selected").parentElement!;
    expect(bar.className).toContain("pk-transient");
    expect(bar.getAttribute("data-state")).toBe("open");
    expect(screen.queryByRole("searchbox")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Clear selection" }),
    );
    // Leaving: still in the DOM, closed, inert, and still saying what it acted on.
    expect(bar.isConnected).toBe(true);
    expect(bar.getAttribute("data-state")).toBe("closed");
    expect(bar.hasAttribute("inert")).toBe(true);
    expect(bar.textContent).toContain("1 selected");
    expect(screen.queryByRole("searchbox")).toBeNull();

    await anim.finish();
    expect(bar.isConnected).toBe(false);
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("goes at once under reduced motion", async () => {
    html.dataset.motion = "reduce";
    withExitAnimations();
    render(<Table selection={selection} />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Select Seat 001" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Clear selection" }),
    );
    expect(screen.queryByText(/selected$/)).toBeNull();
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });
});

// ── FilterBar chips ───────────────────────────────────────────────────────────────────────────────

function Chips({ initial = [] as string[] }): React.ReactElement {
  const [selected, setSelected] = React.useState<string[]>(initial);
  const facet: FilterBarFacet = {
    id: "status",
    label: "Status",
    options: statuses.map((s) => ({ value: s, label: s, count: 3 })),
    selected,
    onChange: setSelected,
  };
  return (
    <>
      <FilterBar facets={[facet]} />
      <button
        type="button"
        onClick={() => setSelected((s) => [...s, "expired"])}
      >
        add
      </button>
    </>
  );
}

const chip = (label: string): HTMLElement =>
  screen
    .getByRole("button", { name: `Remove filter Status: ${label}` })
    .closest("li")!;

describe("FilterBar chips", () => {
  it("a chip added after mount pops in; chips there on the first render do not", async () => {
    render(<Chips initial={["active"]} />);
    expect(chip("active").className).not.toContain("pk-pop-in");
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    expect(chip("expired").className).toContain("pk-pop-in");
    expect(chip("active").className).not.toContain("pk-pop-in");
  });

  it("a removed chip fades out in place, inert, then goes", async () => {
    const anim = withExitAnimations();
    render(<Chips initial={["active", "suspended"]} />);
    const li = chip("active");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove filter Status: active" }),
    );
    expect(li.isConnected).toBe(true);
    expect(li.getAttribute("data-state")).toBe("closed");
    expect(li.hasAttribute("inert")).toBe(true);
    expect(li.className).toContain("data-[state=closed]:animate-pk-fade-out");
    // Still first: it fades where it was, then the others close up.
    const list = screen.getByRole("list", { name: "Active filters" });
    expect(list.firstElementChild).toBe(li);
    // Hidden from assistive technology while it leaves: only the live chip is a list item.
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((x) => x.textContent),
    ).toEqual(["Status: suspended"]);
    await anim.finish();
    expect(li.isConnected).toBe(false);
    expect(chip("suspended")).toBeTruthy();
  });

  it("a removed chip goes at once under reduced motion", async () => {
    html.dataset.motion = "reduce";
    withExitAnimations();
    render(<Chips initial={["active"]} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove filter Status: active" }),
    );
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
  });

  it("facet counts are plain text, never animated", async () => {
    render(<Chips />);
    await userEvent.click(
      screen.getByRole("button", { name: "Filter by status" }),
    );
    const label = screen
      .getByRole("checkbox", { name: /active/ })
      .closest("label")!;
    const count = within(label).getByText("3");
    expect(count.className).not.toMatch(/pk-|animate-/);
  });
});

// ── Status pills ──────────────────────────────────────────────────────────────────────────────────

describe("status pills ease and pop", () => {
  it("a pill's colours ease, and it does not pop when it first appears", () => {
    render(<StatusPill domain="license" state="suspended" />);
    const pill = document.querySelector("[data-status]")!;
    expect(pill.className).toContain("pk-pill");
    expect(pill.querySelector(".pk-pop-in")).toBeNull();
  });

  it("a changed word pops, once per change, on the same pill element", () => {
    const { rerender } = render(
      <StatusPill tone="warning">Suspended</StatusPill>,
    );
    const pill = document.querySelector("[data-status]")!;
    rerender(<StatusPill tone="danger">Revoked</StatusPill>);
    expect(document.querySelector("[data-status]")).toBe(pill);
    const word = pill.querySelector(".pk-pop-in")!;
    expect(word.textContent).toBe("Revoked");
    rerender(<StatusPill tone="danger">Revoked</StatusPill>);
    expect(pill.querySelector(".pk-pop-in")).toBe(word);
  });

  it("a healthy state is quiet text that eases too", () => {
    const { rerender } = render(
      <StatusPill tone="warning">Expiring</StatusPill>,
    );
    rerender(<StatusPill tone="success">Active</StatusPill>);
    const text = document.querySelector('[data-status="text"]')!;
    expect(text.className).toContain("pk-pill");
    expect(text.querySelector(".pk-pop-in")!.textContent).toBe("Active");
  });

  it("SignedBadge pops its word when a record becomes verified", () => {
    const { rerender } = render(<SignedBadge kid="rk-1" />);
    expect(document.querySelector(".pk-pop-in")).toBeNull();
    rerender(<SignedBadge kid="rk-1" verified />);
    expect(document.querySelector(".pk-pop-in")!.textContent).toBe(
      "Signature verified",
    );
  });
});

// ── Charts ────────────────────────────────────────────────────────────────────────────────────────

const fills = (): SVGRectElement[] =>
  Array.from(document.querySelectorAll<SVGRectElement>("rect[data-fill]"));
const meterOf = (el: Element): string =>
  (el as SVGElement).style.getPropertyValue("--pk-meter");

describe("chart fills move by transform only", () => {
  it("Meter: a full-width fill scaled by --pk-meter, never a computed width", () => {
    const { rerender } = render(<Meter label="Seats" value={3} max={5} />);
    const [fill] = fills();
    expect(fill!.getAttribute("width")).toBe("100%");
    expect(fill!.getAttribute("class")).toContain("pk-meter-fill");
    expect(fill!.getAttribute("class")).toContain("transform-fill");
    expect(meterOf(fill!)).toBe("0.6");
    rerender(<Meter label="Seats" value={4} max={5} />);
    expect(fills()[0]).toBe(fill);
    expect(fill!.getAttribute("width")).toBe("100%");
    expect(meterOf(fill!)).toBe("0.8");
    rerender(<Meter label="Seats" value={0} max={5} />);
    expect(meterOf(fills()[0]!)).toBe("0");
  });

  it("BarList and Funnel: every bar is a scaled full-width fill", () => {
    render(
      <>
        <BarList
          label="Platforms"
          items={[
            { label: "macOS", value: 50 },
            { label: "Windows", value: 25 },
          ]}
        />
        <Funnel
          label="Funnel"
          steps={[
            { label: "Offered", value: 100 },
            { label: "Applied", value: 40 },
          ]}
          failures={[{ label: "Reverted", value: 0 }]}
        />
      </>,
    );
    const all = fills();
    expect(all.map((f) => f.getAttribute("width"))).toEqual(
      all.map(() => "100%"),
    );
    expect(all.map(meterOf)).toEqual(["1", "0.5", "1", "0.4", "0"]);
  });
});

describe("the chart sources set no computed SVG width (the motion lint for charts)", () => {
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/ui/charts",
  );
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
    it(file, () => {
      const src = readFileSync(join(dir, file), "utf8");
      // A fill's share is a transform (FillRect), never `width={`${…}%`}` or a width expression.
      expect(src).not.toMatch(/\bwidth=\{(?!\s*(width|\d))/);
      expect(src).not.toMatch(/\b(width|x2?)=\{`/);
    });
  }
});

// ── StatTile ──────────────────────────────────────────────────────────────────────────────────────

describe("StatTile counts up on first load only", () => {
  it("knows a whole count when it sees one", () => {
    expect(headlineCount("1,284")).toBe(1284);
    expect(headlineCount(96)).toBe(96);
    expect(headlineCount("0")).toBe(0);
    for (const v of [
      "0.4 %",
      "3 of 5",
      "in 3 min",
      "-3",
      "1,28",
      "",
      undefined,
    ])
      expect(headlineCount(v)).toBeNull();
  });

  it("counts from 0 with one accessible value, then shows the value as given", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) =>
      frames.push(cb),
    );
    const { container, rerender } = render(<StatTile label="Active" loading />);
    rerender(<StatTile label="Active" value="1,284" />);
    const value = container.querySelector("p.text-2xl")!;
    expect(value.querySelector('[aria-hidden="true"]')!.textContent).toBe("0");
    expect(value.querySelector(".sr-only")!.textContent).toBe("1,284");
    // The content that replaced the skeleton fades in.
    expect(value.parentElement!.className).toContain("pk-content-in");
    act(() => frames.shift()!(1000));
    act(() => frames.shift()!(2000));
    expect(value.textContent).toBe("1,284");
    expect(value.children.length).toBe(0);
    // A refetch that changes the value swaps it at once.
    rerender(<StatTile label="Active" value="1,300" />);
    expect(value.textContent).toBe("1,300");
    expect(value.children.length).toBe(0);
  });

  it("a number reads as formatCount draws it, while counting and after", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) =>
      frames.push(cb),
    );
    const { container } = render(<StatTile label="Seats" value={1284} />);
    const value = container.querySelector("p.text-2xl")!;
    expect(value.querySelector(".sr-only")!.textContent).toBe("1,284");
    act(() => frames.shift()!(1000));
    act(() => frames.shift()!(2000));
    expect(value.textContent).toBe("1,284");
  });

  it("shows any other value as it is, and every value at once under reduced motion", () => {
    const { container, rerender } = render(
      <StatTile label="Rate" value="0.4 %" />,
    );
    expect(container.querySelector("p.text-2xl")!.textContent).toBe("0.4 %");
    html.dataset.motion = "reduce";
    rerender(<StatTile label="Count" value="42" key="b" />);
    const value = container.querySelector("p.text-2xl")!;
    expect(value.textContent).toBe("42");
    expect(value.children.length).toBe(0);
  });

  it("loading is a shaped pk-skeleton behind the grace", () => {
    const { container } = render(<StatTile label="Active" loading />);
    expect(container.querySelector(".pk-skeleton-group")).not.toBeNull();
    expect(container.querySelectorAll(".pk-skeleton").length).toBe(2);
  });
});

// ── Skeleton, RefetchBar, Stepper ─────────────────────────────────────────────────────────────────

describe("skeleton and refetch bar", () => {
  it("every Skeleton block carries the sheen; a PageSkeleton waits out the grace", () => {
    const { container } = render(
      <>
        <Skeleton className="h-4" />
        <PageSkeleton template="table" label="licenses" />
      </>,
    );
    expect(container.firstElementChild!.className).toContain("pk-skeleton");
    const page = container.querySelector("[data-skeleton]")!;
    expect(page.className).toContain("pk-skeleton-group");
    expect(page.querySelectorAll(".pk-skeleton").length).toBeGreaterThan(10);
    expect(container.innerHTML).not.toMatch(/animate-pulse/);
  });

  it("the refetch bar shows after 400 ms, fades in and sweeps, and stands still under reduced motion", () => {
    vi.useFakeTimers();
    const { container } = render(<RefetchBar active />);
    const track = container.firstElementChild!;
    expect(track.hasAttribute("data-active")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(track.hasAttribute("data-active")).toBe(true);
    expect(track.className).toContain("data-[active]:animate-pk-fade-in");
    const bar = track.firstElementChild!;
    expect(bar.className).toContain("animate-pk-refetch");
    expect(bar.className).toContain("motion-reduce:animate-none");
  });
});

describe("Stepper", () => {
  const STEPS = [
    { id: "a", label: "Basics" },
    { id: "b", label: "Tiers" },
    { id: "c", label: "Review" },
  ];

  it("fills the connectors up to the current step, by transform", () => {
    render(<Stepper steps={STEPS} current="b" />);
    const lines = Array.from(
      document.querySelectorAll<HTMLElement>(".pk-meter-fill"),
    );
    expect(lines.map((l) => l.style.getPropertyValue("--pk-meter"))).toEqual([
      "1",
      "0",
    ]);
  });

  it("pops the new current step when it changes, never on first render", () => {
    const { rerender } = render(<Stepper steps={STEPS} current="a" />);
    expect(document.querySelector(".pk-pop-in")).toBeNull();
    rerender(<Stepper steps={STEPS} current="b" />);
    const popped = document.querySelector(".pk-pop-in")!;
    expect(popped.closest("[aria-current=step]")!.textContent).toContain(
      "Tiers",
    );
    expect(
      Array.from(document.querySelectorAll<HTMLElement>(".pk-meter-fill")).map(
        (l) => l.style.getPropertyValue("--pk-meter"),
      ),
    ).toEqual(["1", "0"]);
  });
});
