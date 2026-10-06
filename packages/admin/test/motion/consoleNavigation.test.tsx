import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Link,
  blockNavigation,
  navigate,
  navigationTransition,
  resetRouterForTests,
  useLocation,
} from "../../src/console/router.js";
import { PageTabs, TabPanel } from "../../src/console/components/PageTabs.js";
import { SegmentedControl } from "../../src/ui/SegmentedControl.js";
import { markViewTransitionSupport } from "../../src/ui/motion/index.js";
import { ALL_ON, boot, resetConsole } from "../consoleHarness.js";

/**
 * Console navigation motion (notes/S-23 §6.1, §6.3; MO-04): the router runs a change of page in a
 * View Transition typed by the hash path, a record's tabs morph their indicator and fade their
 * panel, and the SegmentedControl's thumb slides. jsdom has no View Transitions API and no Web
 * Animations, so a fake `startViewTransition` (which, like the browser, calls the update later) and
 * a stub `animate` stand in where the motion itself is under test; without them every change is
 * the instant swap it always was.
 */

const html = document.documentElement;
type Doc = { startViewTransition?: unknown };

interface Started {
  /** `html[data-vt]` when the transition started. */
  type: string | undefined;
  /** The hash the page showed when the transition started (the old page, still held). */
  shown: string | null;
  /** Elements named through the CSSOM for the old snapshot: `text:name`. */
  named: string[];
}

/** A fake API: the update runs in a later task (as the browser's does), then the transition ends. */
function installFake(): Started[] {
  const started: Started[] = [];
  (document as unknown as Doc).startViewTransition = (update: () => void) => {
    started.push({
      type: html.dataset.vt,
      shown:
        document.querySelector("output[aria-label=hash]")?.textContent ?? null,
      named: [...document.querySelectorAll<HTMLElement>("*")]
        .filter((el) => el.style?.getPropertyValue("view-transition-name"))
        .map(
          (el) =>
            `${el.textContent}:${el.style.getPropertyValue("view-transition-name")}`,
        ),
    });
    const updateCallbackDone = new Promise<void>((r) => setTimeout(r, 0)).then(
      () => act(() => update()),
    );
    return {
      updateCallbackDone,
      finished: updateCallbackDone,
      skipTransition: () => undefined,
    };
  };
  markViewTransitionSupport();
  return started;
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

afterEach(() => {
  cleanup();
  delete (document as unknown as Doc).startViewTransition;
  delete html.dataset.motion;
  delete html.dataset.vt;
  markViewTransitionSupport();
  vi.restoreAllMocks();
});

// ── The transition a navigation runs ─────────────────────────────────────────────────────────────

describe("navigationTransition: typed by the hash path (S-23 §6.3)", () => {
  const list = "#/p/djdl/license/licenses";
  const record = "#/p/djdl/license/licenses/lic_1";

  it("a change of query alone runs none (the tables animate their own list changes)", () => {
    expect(navigationTransition(list, `${list}?q=ada`)).toBeNull();
    expect(navigationTransition(`${list}?q=a`, `${list}?q=b`)).toBeNull();
    expect(navigationTransition(`${list}?q=a`, list)).toBeNull();
  });

  it("a deeper path is forward, a shallower one back, the same depth a sibling route", () => {
    expect(navigationTransition(list, record)).toBe("forward");
    expect(navigationTransition(record, list)).toBe("back");
    expect(navigationTransition(list, "#/p/djdl/license/tiers")).toBe("route");
    expect(navigationTransition(`${list}?q=a`, `${record}?x=1`)).toBe(
      "forward",
    );
  });

  it("another tab of the same record is a tab, whichever way the path moves", () => {
    expect(navigationTransition(record, `${record}/keys`)).toBe("tab");
    expect(navigationTransition(`${record}/keys`, `${record}/devices`)).toBe(
      "tab",
    );
    expect(navigationTransition(`${record}/devices`, record)).toBe("tab");
    // A different record is not a tab switch.
    expect(
      navigationTransition(
        `${record}/keys`,
        "#/p/djdl/license/licenses/lic_2/keys",
      ),
    ).toBe("route");
  });

  it("an old URL counts by the page it redirects to", () => {
    expect(navigationTransition("#/p/djdl/licenses", list)).toBeNull();
    expect(navigationTransition("#/p/djdl/licenses", record)).toBe("forward");
  });
});

// ── The router ───────────────────────────────────────────────────────────────────────────────────

function Probe(): React.ReactElement {
  const { hash } = useLocation();
  return (
    <>
      <output aria-label="hash">{hash}</output>
      <Link to="#/p/djdl/license/licenses/lic_1">
        <span data-vt-shared="pk-key">Ada Lovelace</span>
      </Link>
      <Link to="#/p/djdl/license/tiers">Tiers</Link>
      <Link to="#/p/djdl/license/licenses?tab=x" transition="tab">
        Query tab
      </Link>
    </>
  );
}

const shown = (): string | null => screen.getByLabelText("hash").textContent;

describe("the router: a change of page runs in a View Transition", () => {
  beforeEach(() => {
    window.location.hash = "#/p/djdl/license/licenses";
    resetRouterForTests();
  });

  it("a drill-down is forward; the page keeps the old hash until the transition's update", async () => {
    const started = installFake();
    render(<Probe />);
    await userEvent.click(screen.getByRole("link", { name: "Ada Lovelace" }));
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({
      type: "forward",
      shown: "#/p/djdl/license/licenses",
    });
    await waitFor(() =>
      expect(shown()).toBe("#/p/djdl/license/licenses/lic_1"),
    );
    await settle();
    expect(started).toHaveLength(1);
  });

  it("the drill-down's shared element is named pk-key for the old page only", async () => {
    const started = installFake();
    render(<Probe />);
    await userEvent.click(screen.getByRole("link", { name: "Ada Lovelace" }));
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.named).toEqual(["Ada Lovelace:pk-key"]);
    await settle();
    expect(
      screen
        .getByText("Ada Lovelace")
        .style.getPropertyValue("view-transition-name"),
    ).toBe("");
  });

  it("Back to a shallower page is back, and a sibling is a route", async () => {
    window.location.hash = "#/p/djdl/license/licenses/lic_1";
    const started = installFake();
    render(<Probe />);
    act(() => {
      window.location.hash = "#/p/djdl/license/licenses";
    });
    await waitFor(() => expect(started.map((s) => s.type)).toEqual(["back"]));
    await waitFor(() => expect(shown()).toBe("#/p/djdl/license/licenses"));
    await userEvent.click(screen.getByRole("link", { name: "Tiers" }));
    await waitFor(() =>
      expect(started.map((s) => s.type)).toEqual(["back", "route"]),
    );
    await settle();
  });

  it("popstate and hashchange of one navigation start one transition", async () => {
    const started = installFake();
    render(<Probe />);
    act(() => {
      window.history.pushState(null, "", "#/p/djdl/license/tiers");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();
    expect(started.map((s) => s.type)).toEqual(["route"]);
    expect(shown()).toBe("#/p/djdl/license/tiers");
  });

  it("a change of query alone starts none and updates at once (MO-09 relies on it)", async () => {
    const started = installFake();
    render(<Probe />);
    act(() => {
      navigate("#/p/djdl/license/licenses?q=ada", { replace: true });
    });
    expect(shown()).toBe("#/p/djdl/license/licenses?q=ada");
    await settle();
    expect(started).toEqual([]);
  });

  it("a link may name its transition: a tab kept in the query still runs a tab transition", async () => {
    const started = installFake();
    render(<Probe />);
    await userEvent.click(screen.getByRole("link", { name: "Query tab" }));
    await waitFor(() => expect(started.map((s) => s.type)).toEqual(["tab"]));
    await settle();
  });

  it("the unsaved-changes blocker answers first: a refused navigation starts nothing", async () => {
    const started = installFake();
    render(<Probe />);
    const unblock = blockNavigation(() => false);
    await userEvent.click(screen.getByRole("link", { name: "Tiers" }));
    expect(navigate("#/p/djdl/license/licenses/lic_1")).toBe(false);
    window.location.hash = "#/p/djdl/license/tiers";
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/licenses"),
    );
    await settle();
    expect(started).toEqual([]);
    expect(shown()).toBe("#/p/djdl/license/licenses");
    unblock();
  });

  it("under reduced motion (the in-app preference) the page swaps at once and nothing starts", async () => {
    html.dataset.motion = "reduce";
    const started = installFake();
    render(<Probe />);
    await userEvent.click(screen.getByRole("link", { name: "Ada Lovelace" }));
    await waitFor(() =>
      expect(shown()).toBe("#/p/djdl/license/licenses/lic_1"),
    );
    await settle();
    expect(started).toEqual([]);
    expect(html.dataset.vt).toBeUndefined();
    expect(screen.getByText("Ada Lovelace").style.cssText).toBe("");
  });
});

describe("the shell keeps its route focus through a transition", () => {
  beforeEach(resetConsole);

  it("a sibling page runs a route transition; focus lands on its h1 and it is announced", async () => {
    const started = installFake();
    boot("#/p/djdl/license/licenses", { services: ALL_ON });
    const nav = (
      await screen.findAllByRole("navigation", {
        name: "Console",
      })
    )[0]!;
    await userEvent.click(within(nav).getByRole("link", { name: "Tiers" }));
    const h1 = await screen.findByRole("heading", { level: 1, name: "Tiers" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(document.getElementById("route-announcer")!.textContent).toBe(
      "Tiers, page loaded",
    );
    expect(started.map((s) => s.type)).toEqual(["route"]);
  });
});

// ── PageTabs ─────────────────────────────────────────────────────────────────────────────────────

const indicators = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(".pk-vt-indicator"),
];

function PanelTabs({
  onChange,
  dirty,
}: {
  onChange?: (v: string) => void;
  dirty?: boolean;
}): React.ReactElement {
  const [tab, setTab] = React.useState("runs");
  return (
    <>
      <PageTabs
        label="Sections"
        idPrefix="t"
        value={tab}
        onChange={(v) => {
          onChange?.(v);
          setTab(v);
        }}
        items={[
          { value: "runs", label: "Runs", dirty },
          { value: "deploys", label: "Deploys" },
          { value: "logs", label: "Logs" },
        ]}
      />
      <TabPanel idPrefix="t" value="runs" current={tab} dirty={dirty}>
        <input aria-label="Draft" />
      </TabPanel>
      <TabPanel idPrefix="t" value="deploys" current={tab}>
        Deploys panel
      </TabPanel>
      <TabPanel idPrefix="t" value="logs" current={tab}>
        Logs panel
      </TabPanel>
    </>
  );
}

describe("PageTabs: the indicator morphs and the panel fades through", () => {
  beforeEach(() => {
    window.location.hash = "#/p/djdl/license/licenses/lic_1";
    resetRouterForTests();
  });

  it("route tabs: the active tab alone holds the indicator; a switch runs a tab transition", async () => {
    const started = installFake();
    function Record(): React.ReactElement {
      const { route } = useLocation();
      const tab = route.kind === "product" ? (route.tab ?? "overview") : "";
      return (
        <PageTabs
          label="License sections"
          value={tab}
          items={["overview", "keys", "devices"].map((t) => ({
            value: t,
            label: t,
            to: `#/p/djdl/license/licenses/lic_1${t === "overview" ? "" : `/${t}`}`,
          }))}
        />
      );
    }
    render(<Record />);
    const active = (): HTMLElement =>
      screen
        .getAllByRole("link")
        .find((a) => a.getAttribute("aria-current") === "page")!;
    expect(indicators()).toHaveLength(1);
    expect(active().contains(indicators()[0]!)).toBe(true);
    expect(indicators()[0]!.getAttribute("aria-hidden")).toBe("true");

    await userEvent.click(screen.getByRole("link", { name: "devices" }));
    await waitFor(() => expect(active().textContent).toBe("devices"));
    expect(started.map((s) => s.type)).toEqual(["tab"]);
    expect(indicators()).toHaveLength(1);
    expect(active().contains(indicators()[0]!)).toBe(true);
    await settle();
  });

  it("panel tabs: a click runs one tab transition and the new panel lands inside it", async () => {
    const started = installFake();
    const onChange = vi.fn();
    render(<PanelTabs onChange={onChange} />);
    expect(screen.getByRole("tabpanel").classList).toContain("pk-vt-tabpanel");
    await userEvent.click(screen.getByRole("tab", { name: "Deploys" }));
    await waitFor(() =>
      expect(screen.getByRole("tabpanel").textContent).toBe("Deploys panel"),
    );
    expect(started.map((s) => s.type)).toEqual(["tab"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const tab = screen.getByRole("tab", { name: "Deploys" });
    expect(tab.contains(indicators()[0]!)).toBe(true);
    expect(indicators()).toHaveLength(1);
    // Clicking the active tab again changes nothing and starts nothing.
    await userEvent.click(tab);
    await settle();
    expect(started).toHaveLength(1);
  });

  it("keyboard order is unchanged: arrows move focus and select, one tab stop", async () => {
    installFake();
    render(<PanelTabs />);
    const runs = screen.getByRole("tab", { name: "Runs" });
    runs.focus();
    fireEvent.keyDown(runs, { key: "ArrowRight" });
    const deploys = screen.getByRole("tab", { name: "Deploys" });
    expect(document.activeElement).toBe(deploys);
    await waitFor(() =>
      expect(deploys.getAttribute("aria-selected")).toBe("true"),
    );
    expect(
      screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex")),
    ).toEqual(["-1", "0", "-1"]);
    fireEvent.keyDown(deploys, { key: "End" });
    const logs = screen.getByRole("tab", { name: "Logs" });
    expect(document.activeElement).toBe(logs);
    await waitFor(() =>
      expect(logs.getAttribute("aria-selected")).toBe("true"),
    );
    await settle();
  });

  it("a dirty panel stays mounted (hidden) across a switch", async () => {
    installFake();
    render(<PanelTabs dirty />);
    await userEvent.type(screen.getByLabelText("Draft"), "half done");
    await userEvent.click(screen.getByRole("tab", { name: /Logs/ }));
    await waitFor(() =>
      expect(screen.getByRole("tabpanel").textContent).toBe("Logs panel"),
    );
    const draft = document.querySelector<HTMLInputElement>(
      "input[aria-label=Draft]",
    )!;
    expect(draft.value).toBe("half done");
    expect(draft.closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(true);
    await settle();
  });

  it("under reduced motion a switch is an instant swap: nothing starts", async () => {
    html.dataset.motion = "reduce";
    const started = installFake();
    render(<PanelTabs />);
    await userEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("Logs panel");
    expect(started).toEqual([]);
  });
});

// ── SegmentedControl ─────────────────────────────────────────────────────────────────────────────

function Segmented(): React.ReactElement {
  const [v, setV] = React.useState<"day" | "week" | "month">("day");
  return (
    <SegmentedControl
      aria-label="Window"
      value={v}
      onChange={setV}
      options={[
        { value: "day", label: "Day" },
        { value: "week", label: "Week" },
        { value: "month", label: "Month" },
      ]}
    />
  );
}

/** Lay the items out in a row (jsdom has no layout): each 60 px wide, the next one 64 px on. */
function layOut(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const items = [...document.querySelectorAll("[role=radio]")];
      const i = items.indexOf(this);
      const left = i === -1 ? 100 : 103 + i * 64;
      const width = i === -1 ? 200 : 60;
      return {
        left,
        top: i === -1 ? 50 : 53,
        width,
        height: i === -1 ? 38 : 32,
        right: left + width,
        bottom: 0,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}

interface FakeAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  finish: () => void;
}

function stubAnimate(): FakeAnimation[] {
  const made: FakeAnimation[] = [];
  (HTMLElement.prototype as unknown as { animate: unknown }).animate =
    function (keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      made.push({ keyframes, options, finish });
      return { finished, cancel: () => finish() } as unknown as Animation;
    };
  return made;
}

describe("SegmentedControl: the checked background slides", () => {
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });

  it("without layout or Web Animations (jsdom) it swaps at once", async () => {
    render(<Segmented />);
    await userEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(screen.getByRole("radio", { name: "Week" }).dataset.state).toBe(
      "checked",
    );
    expect(screen.getByRole("radiogroup").hasAttribute("data-moving")).toBe(
      false,
    );
  });

  it("slides a transform-only thumb from the old option to the new one on the slow token", async () => {
    layOut();
    const made = stubAnimate();
    render(<Segmented />);
    const group = screen.getByRole("radiogroup");
    await userEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(made).toHaveLength(1);
    expect(made[0]!.keyframes).toEqual([
      { transform: "translateX(-128px) scaleX(1)" },
      { transform: "none" },
    ]);
    expect(made[0]!.options.duration).toBe(320);
    const thumb = group.querySelector<HTMLElement>("[data-segmented-thumb]")!;
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    // The thumb takes the new option's box (relative to the group's padding edge).
    expect(thumb.style.getPropertyValue("--pk-thumb-x")).toBe("131px");
    expect(thumb.style.getPropertyValue("--pk-thumb-w")).toBe("60px");
    expect(group.hasAttribute("data-moving")).toBe(true);
    await act(async () => made[0]!.finish());
    expect(group.hasAttribute("data-moving")).toBe(false);
  });

  it("under reduced motion nothing animates", async () => {
    layOut();
    const made = stubAnimate();
    html.dataset.motion = "reduce";
    render(<Segmented />);
    await userEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(made).toEqual([]);
    expect(screen.getByRole("radiogroup").hasAttribute("data-moving")).toBe(
      false,
    );
  });
});
