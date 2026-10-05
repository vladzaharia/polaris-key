import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Clock } from "lucide-react";
import { ServiceBadge, ServiceGlyph } from "../../src/ui/ServiceBadge.js";
import { SignedBadge, SignedGlyph } from "../../src/ui/SignedBadge.js";
import { SourceBadge } from "../../src/ui/SourceBadge.js";
import { StatusPill } from "../../src/ui/StatusPill.js";

afterEach(cleanup);

describe("StatusPill", () => {
  it("is icon plus text from the vocabulary", () => {
    const { container } = render(
      <StatusPill domain="rollout" state="halted" />,
    );
    expect(screen.getByText("Halted")).toBeTruthy();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.firstElementChild!.getAttribute("data-tone")).toBe(
      "danger",
    );
  });

  it("takes an explicit tone, icon and label", () => {
    render(
      <StatusPill tone="warning" icon={Clock}>
        Expires in 3 days
      </StatusPill>,
    );
    expect(screen.getByText("Expires in 3 days")).toBeTruthy();
  });

  it("renders a dot when the icon is null, never colour alone", () => {
    const { container } = render(
      <StatusPill tone="success" icon={null}>
        Live
      </StatusPill>,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("span[aria-hidden]")).not.toBeNull();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("draws a healthy state as quiet text, never a pill (pills mean attention)", () => {
    const { container } = render(
      <StatusPill tone="success">Enabled</StatusPill>,
    );
    const el = container.firstElementChild!;
    expect(el.getAttribute("data-tone")).toBe("success");
    expect(el.getAttribute("data-status")).toBe("text");
    expect(el.className).not.toMatch(/rounded-full|border|bg-/);
    expect(container.querySelector("svg")).not.toBeNull();
    const issue = render(<StatusPill tone="warning">Needs setup</StatusPill>)
      .container.firstElementChild!;
    expect(issue.getAttribute("data-status")).toBe("pill");
  });

  it("current is a ring and the word", () => {
    const { container } = render(
      <StatusPill domain="compat" state="current" />,
    );
    expect(screen.getByText("Current")).toBeTruthy();
    expect(container.firstElementChild!.getAttribute("data-tone")).toBe(
      "outline",
    );
  });
});

describe("SignedBadge", () => {
  it("is gold glyph plus text, with the kid", () => {
    render(<SignedBadge kid="rk-2026-09" by="release key" />);
    expect(screen.getByText("rk-2026-09")).toBeTruthy();
    expect(screen.getByText(/Signed/)).toBeTruthy();
    expect(screen.getByText(/by release key/).className).toContain("sr-only");
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toContain("fill-signed");
  });

  it("verified reads Signature verified", () => {
    render(<SignedBadge verified />);
    expect(screen.getByText("Signature verified")).toBeTruthy();
  });

  it("the glyph uses the brand's terminal-bit path", () => {
    const { container } = render(<SignedGlyph />);
    expect(container.querySelector("path")!.getAttribute("d")).toBe(
      "M70 85 L84 71 L90 77 L76 91 Z",
    );
  });
});

describe("ServiceGlyph and ServiceBadge", () => {
  it("draws the Star Cut for the delivery family", () => {
    const { container } = render(<ServiceGlyph id="update" />);
    const wrap = container.firstElementChild!;
    expect(wrap.getAttribute("data-service")).toBe("update");
    expect(wrap.querySelector("svg path")).not.toBeNull();
    expect(wrap.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses a lucide icon for the others, in their accent", () => {
    const { container } = render(<ServiceGlyph id="license" size={24} />);
    expect(container.firstElementChild!.getAttribute("data-service")).toBe(
      "license",
    );
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("24");
  });

  it("labels the badge from the service table", () => {
    render(<ServiceBadge id="distribution" />);
    expect(screen.getByText("Distribution")).toBeTruthy();
  });
});

describe("SourceBadge", () => {
  it.each([
    ["manifest", "From manifest", /next resync re-applies/],
    ["admin", "Set in console", /survives a resync/],
    ["default", "Code default", /built into Polaris Key/],
    ["deploy", "Deploy var", /wrangler vars/],
    ["runtime", "Set in console", /overrides the deploy var/],
  ] as const)("%s explains itself in a popover", (source, label, copy) => {
    render(<SourceBadge source={source} path=".pkey/schema" />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revert…" })).toBeNull();
  });

  it("runtime shows who set it and offers Revert when given", () => {
    const revert = vi.fn();
    render(
      <SourceBadge
        source="runtime"
        by="Ada"
        at={Date.UTC(2026, 8, 3)}
        onRevert={revert}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Set in console/ }));
    expect(screen.getByText(/Set by Ada/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revert…" }));
    expect(revert).toHaveBeenCalled();
  });
});
