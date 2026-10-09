// The React components, rendered to static markup. This suite runs twice: under React 18 (the
// react18 project) and React 19 (the react19 project, vitest.config.ts), because the peer range
// is ">=18". Each component must render exactly the markup of its string twin in src/marks/svg.ts.

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  PolarisLockup,
  PolarisMark,
  PoweredByBadge,
  ServiceIcon,
} from "../src/react.js";
import {
  lockupSvg,
  markSvg,
  poweredBySvg,
  serviceIconSvg,
  serviceIconTileSvg,
} from "../src/svg.js";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe(`React ${React.version}`, () => {
  it("is the React major this project means to test", () => {
    expect(["18", "19"]).toContain(React.version.split(".")[0]);
  });

  const markCases = [
    {},
    { size: 16 },
    { size: 32, theme: "light" as const },
    { size: 48, signed: true },
    { size: 96, signed: true, theme: "light" as const, title: "Polaris Key" },
    { size: 64, theme: "mono" as const, signed: true },
    { size: 48, bit: "release" as const },
    { size: 48, bit: "section" as const, theme: "light" as const },
    { size: 40, bit: "identity" as const },
    { kind: "update" as const, size: 24, title: "Polaris Key Delivery" },
  ];
  it.each(markCases.map((c) => [JSON.stringify(c), c] as const))(
    "PolarisMark %s renders markSvg's markup",
    (_, props) => {
      expect(render(<PolarisMark {...props} />)).toBe(markSvg(props));
    },
  );

  const lockupCases = [
    {},
    {
      kind: "update" as const,
      layout: "stacked" as const,
      theme: "light" as const,
    },
    { layout: "compact" as const, theme: "mono" as const, height: 32 },
    { height: 60 },
    { bit: "config" as const },
    { bit: "section" as const, title: "" },
    { trim: true, height: 48 },
    { kind: "delivery" as const, trim: true, theme: "light" as const },
    { trim: true, height: 48, bit: "release" as const },
  ];
  it.each(lockupCases.map((c) => [JSON.stringify(c), c] as const))(
    "PolarisLockup %s renders lockupSvg's markup",
    (_, props) => {
      expect(render(<PolarisLockup {...props} />)).toBe(lockupSvg(props));
    },
  );

  const badgeCases = [
    {},
    {
      layout: "horizontal" as const,
      treatment: "sticker" as const,
      theme: "light" as const,
    },
    {
      layout: "stacked" as const,
      treatment: "outline" as const,
      theme: "mono-white" as const,
      width: 576,
    },
  ];
  it.each(badgeCases.map((c) => [JSON.stringify(c), c] as const))(
    "PoweredByBadge %s renders poweredBySvg's markup",
    (_, props) => {
      expect(render(<PoweredByBadge {...props} />)).toBe(poweredBySvg(props));
    },
  );

  it("PoweredByBadge raises a too-small width to the minimum and warns outside production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = render(<PoweredByBadge layout="compact" width={100} />);
    expect(html).toContain('width="232" height="88"');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("passes extra SVG props through (className, data-*)", () => {
    const html = render(
      <PolarisMark className="polaris-mark" data-testid="m" />,
    );
    expect(html).toContain('class="polaris-mark"');
    expect(html).toContain('data-testid="m"');
  });

  it.each([
    ["license", {}],
    ["distribution", { size: 16 }],
    ["commerce", { size: 20, title: "Commerce" }],
    ["sync", { size: 32 }],
    ["packs", { size: 64 }],
  ] as const)("ServiceIcon %s renders serviceIconSvg's markup", (id, props) => {
    expect(render(<ServiceIcon id={id} {...props} />)).toBe(
      serviceIconSvg(id, props),
    );
  });

  it.each([
    ["core", 64, "dark"],
    ["update", 48, "light"],
    ["packs", 28, "dark"],
    ["identity", 20, "light"],
  ] as const)(
    "ServiceIcon tile %s %i %s renders the tile markup",
    (id, size, theme) => {
      expect(
        render(<ServiceIcon id={id} tile size={size} theme={theme} />),
      ).toBe(serviceIconTileSvg(id, { size, theme }));
    },
  );
});
