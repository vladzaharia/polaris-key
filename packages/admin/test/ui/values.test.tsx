import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { DiffViewer } from "../../src/ui/DiffViewer.js";
import { Hash } from "../../src/ui/Hash.js";
import { IdChip } from "../../src/ui/IdChip.js";
import { JsonViewer } from "../../src/ui/JsonViewer.js";
import { KeyDisplay } from "../../src/ui/KeyDisplay.js";
import { Timestamp } from "../../src/ui/Timestamp.js";
import { Version } from "../../src/ui/Version.js";
import { CodeBlock } from "../../src/ui/CodeBlock.js";
import {
  EntityLink,
  entityHref,
  type EntityRef,
} from "../../src/console/components/EntityLink.js";

afterEach(cleanup);

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const HOUR = 3_600_000;

describe("JsonViewer", () => {
  const value = { a: { b: [1, 2] }, c: "x" };

  it("is a tree with one tab stop and expands/collapses with the arrow keys", async () => {
    render(<JsonViewer label="Doc" value={value} collapsedDepth={1} />);
    const tree = screen.getByRole("tree", { name: "Doc" });
    const items = within(tree).getAllByRole("treeitem");
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1);
    const root = items[0]!;
    expect(root.getAttribute("aria-expanded")).toBe("true");
    const a = screen.getByRole("treeitem", { name: /^a:/ });
    expect(a.getAttribute("aria-expanded")).toBe("false");

    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("treeitem", { name: /^a:/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("treeitem", { name: /^b:/ })).toBeTruthy();
    fireEvent.keyDown(a, { key: "ArrowLeft" });
    expect(
      screen
        .getByRole("treeitem", { name: /^a:/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.keyDown(a, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("treeitem", { name: /^c:/ }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(root);
  });

  it("copies the focused node's path with p and value with c", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<JsonViewer label="Doc" value={value} collapsedDepth={3} />);
    const b = screen.getByRole("treeitem", { name: /^b:/ });
    b.focus();
    fireEvent.keyDown(b, { key: "p" });
    expect(writeText).toHaveBeenLastCalledWith("a.b");
    const item = screen.getByRole("treeitem", { name: /^1:/ });
    item.focus();
    fireEvent.keyDown(item, { key: "p" });
    expect(writeText).toHaveBeenLastCalledWith("a.b[1]");
    fireEvent.keyDown(item, { key: "c" });
    expect(writeText).toHaveBeenLastCalledWith("2");
  });

  it("pages large arrays by 100", () => {
    render(
      <JsonViewer
        label="Big"
        value={{ list: Array.from({ length: 250 }, (_, i) => i) }}
        collapsedDepth={2}
      />,
    );
    expect(
      screen.getAllByRole("treeitem", { name: /^\d+: \d+$/ }),
    ).toHaveLength(100);
    fireEvent.click(screen.getByText(/Show 100 more/));
    expect(
      screen.getAllByRole("treeitem", { name: /^\d+: \d+$/ }),
    ).toHaveLength(200);
  });
});

describe("DiffViewer", () => {
  it("structured rows carry text prefixes and the breaking warning", () => {
    render(
      <DiffViewer
        mode="structured"
        before={[
          { key: "x", v: 1 },
          { key: "gone", v: 1 },
        ]}
        after={[
          { key: "x", v: 2 },
          { key: "new", v: 1 },
        ]}
        entryKey="key"
        referencedBy={{ gone: ["profile base"] }}
      />,
    );
    expect(screen.getByText("+1 key · −1 key · 1 changed")).toBeTruthy();
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.getByText("Removed")).toBeTruthy();
    expect(screen.getByText("Changed")).toBeTruthy();
    expect(
      screen.getByText(/Breaking: referenced by profile base/),
    ).toBeTruthy();
  });

  it("text rows announce Added and Removed, and switch to split", async () => {
    render(
      <DiffViewer mode="text" label="Doc" before={"a\nb"} after={"a\nc"} />,
    );
    expect(screen.getByText("Added:")).toBeTruthy();
    expect(screen.getByText("Removed:")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "split" }));
    expect(
      screen
        .getByRole("button", { name: "split" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("Before")).toBeTruthy();
  });
});

describe("Hash and IdChip", () => {
  const sha =
    "3f9a1c0e7b2d4f6a8c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d8d02";
  it("truncates and shows the full value in a popover", async () => {
    render(<Hash value={sha} label="SHA-256" />);
    expect(screen.getByText("3f9a1c…8d02")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /show full value/ }),
    );
    expect(await screen.findByText(sha)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy SHA-256" })).toBeTruthy();
  });
  it("IdChip keeps the full id in its accessible name", () => {
    render(<IdChip value="lic_01J9ZK4Q7M2V8X3B5N6P" noun="license id" />);
    expect(
      screen.getByRole("button", {
        name: /^lic_01J9ZK4Q7M2V8X3B5N6P, show full/,
      }),
    ).toBeTruthy();
  });
});

describe("Timestamp", () => {
  it("table: relative visible, absolute in the accessible text, not focusable", () => {
    const { container } = render(
      <Timestamp at={NOW - 3 * HOUR} now={NOW} locale="en-GB" timeZone="UTC" />,
    );
    const time = container.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe(
      new Date(NOW - 3 * HOUR).toISOString(),
    );
    expect(time.hasAttribute("tabindex")).toBe(false);
    expect(time.textContent).toContain("3 hr ago");
    expect(time.textContent).toContain("3 Oct 2026, 09:00 UTC");
  });
  it("table: a date past 7 days; detail shows absolute then relative", () => {
    render(
      <Timestamp
        at={NOW - 9 * 24 * HOUR}
        now={NOW}
        locale="en-GB"
        timeZone="UTC"
      />,
    );
    expect(screen.getAllByText(/24 Sept? 2026/).length).toBeGreaterThan(0);
    cleanup();
    const { container } = render(
      <Timestamp
        at={NOW - 2 * HOUR}
        now={NOW}
        format="detail"
        locale="en-GB"
        timeZone="UTC"
      />,
    );
    expect(container.textContent).toBe("3 Oct 2026, 10:00 UTC · 2 hr ago");
  });
});

describe("Version and KeyDisplay", () => {
  it("a yanked version is struck through and labelled", () => {
    render(<Version value="2.3.9" yanked />);
    expect(screen.getByText("2.3.9").className).toContain("line-through");
    expect(screen.getByText("Yanked")).toBeTruthy();
  });
  it("a secret never shows a value", () => {
    render(
      <KeyDisplay
        label="Webhook secret"
        kind="secret"
        configured
        value="leak"
      />,
    );
    expect(screen.queryByText("leak")).toBeNull();
    expect(screen.getByText(/Configured/)).toBeTruthy();
  });
  it("a signing key shows its status and kid", () => {
    render(
      <KeyDisplay
        label="Signing key"
        kind="signing"
        kid="pk-1"
        status="active"
        value="MCow"
      />,
    );
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/pk-1/)).toBeTruthy();
  });
});

describe("CodeBlock", () => {
  it("names its scroll region and toggles wrap", async () => {
    render(<CodeBlock language="ts" code="const a = 1;" filename="a.ts" />);
    expect(screen.getByRole("region", { name: "a.ts" })).toBeTruthy();
    const wrap = screen.getByRole("button", { name: "Wrap" });
    await userEvent.click(wrap);
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("EntityLink", () => {
  const cases: [EntityRef, string][] = [
    [{ kind: "license", id: "l1" }, "#/p/djdl/license/licenses/l1"],
    [
      { kind: "license", id: "l1", tab: "keys" },
      "#/p/djdl/license/licenses/l1/keys",
    ],
    [{ kind: "tier", id: "pro" }, "#/p/djdl/license/tiers/pro"],
    [{ kind: "profile", id: "base" }, "#/p/djdl/config/profiles/base"],
    [{ kind: "release", id: "r1" }, "#/p/djdl/release/releases/r1"],
    [{ kind: "deliverable", id: "tex" }, "#/p/djdl/release/deliverables/tex"],
    [
      { kind: "pack-release", deliverable: "tex", id: "pr1" },
      "#/p/djdl/release/deliverables/tex/releases?release=pr1",
    ],
    [{ kind: "device", id: "d1" }, "#/p/djdl/devices/d1"],
    [{ kind: "catalog-key", id: "a.b" }, "#/p/djdl/config/catalog?q=a.b"],
    [
      { kind: "outlet", id: "appstore" },
      "#/p/djdl/distribution/outlets?outlet=appstore",
    ],
    [
      { kind: "rollout", release: "r1", outlet: "play" },
      "#/p/djdl/distribution/matrix?cell=r1%3Aplay",
    ],
  ];
  it.each(cases)("%o → %s", (ref, href) => {
    expect(entityHref("djdl", ref)).toBe(href);
  });
  it("renders a link with the label, or the id in mono", () => {
    render(
      <>
        <EntityLink slug="djdl" kind="tier" id="pro" label="Pro" />
        <EntityLink slug="djdl" kind="device" id="dev_1" />
      </>,
    );
    expect(screen.getByRole("link", { name: "Pro" }).getAttribute("href")).toBe(
      "#/p/djdl/license/tiers/pro",
    );
    expect(screen.getByRole("link", { name: "dev_1" }).className).toContain(
      "font-mono",
    );
  });
});
