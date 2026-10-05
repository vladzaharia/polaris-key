import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { AttentionList, Panel } from "../src/console/templates/Dashboard.js";

/**
 * The dashboard template's shared pieces keep the layout fixes the layout lint found
 * (`e2e/layoutProbe.ts`): a long object name cannot crush an attention item's reason, and a
 * panel's action cannot grow or skew its header.
 */

afterEach(cleanup);

const LONG =
  "Northwind Broadcast Audio Workstation — Enterprise Edition for Studios";

describe("AttentionList", () => {
  it("caps a long object and keeps a floor under the reason (overflow/text-crush)", () => {
    render(
      <AttentionList
        items={[
          {
            id: "a",
            tone: "warning",
            object: <a href="#/p/northwind">{LONG}</a>,
            objectTitle: LONG,
            reason: "Missing required secret OIDC_CLIENT_SECRET",
            action: { label: "Set secret", href: "#/p/northwind/keys" },
          },
        ]}
      />,
    );
    const object = screen.getByRole("link", { name: LONG }).parentElement!;
    // The full name is the truncated span's tooltip, and the span may shrink (no shrink-0).
    expect(object.getAttribute("title")).toBe(LONG);
    expect(object.className).toContain("truncate");
    expect(object.className).toContain("min-w-0");
    expect(object.className).toContain("sm:max-w-[40%]");
    expect(object.className).not.toContain("shrink-0");
    const reason = screen.getByText(
      "Missing required secret OIDC_CLIENT_SECRET",
    );
    expect(reason.className).toContain("sm:min-w-[16ch]");
  });

  it("titles a plain-text object by its own text", () => {
    render(
      <AttentionList
        items={[{ id: "a", tone: "info", object: LONG, reason: "r" }]}
      />,
    );
    expect(screen.getByText(LONG).getAttribute("title")).toBe(LONG);
  });
});

describe("Panel", () => {
  it("centres the action on the title and hangs it into the padding (rhythm/header-*)", () => {
    render(
      <Panel title="Setup" action={<button type="button">Hide</button>}>
        body
      </Panel>,
    );
    const header = screen
      .getByRole("heading", { name: "Setup" })
      .closest("[data-card-header]")!;
    expect(header.className).toContain("items-center");
    expect(header.className).not.toContain("items-start");
    const action = screen.getByRole("button", { name: "Hide" }).parentElement!;
    expect(action.className).toContain("-my-1.5");
  });
});
