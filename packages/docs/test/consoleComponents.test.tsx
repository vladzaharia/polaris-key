/**
 * The console's static components, as the docs render them at build time (docs plan 8.2): each
 * one renders to markup with no router, store or query client, and the docs' MDX components that
 * stand on them name the console's tone, not a class of their own.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  Callout,
  Kbd,
  ServiceBadge,
  ServiceGlyph,
  SignedBadge,
  StatusPill,
} from "../src/components/console";

const here = dirname(fileURLToPath(import.meta.url));

describe("console components render in the docs build", () => {
  const cases: [string, () => string, RegExp][] = [
    [
      "Callout",
      () =>
        renderToStaticMarkup(
          createElement(
            Callout,
            { tone: "warning", title: "Heads up" },
            "Body",
          ),
        ),
      /data-tone="warning"[\s\S]*Heads up[\s\S]*Body/,
    ],
    [
      "StatusPill",
      () =>
        renderToStaticMarkup(
          createElement(StatusPill, { tone: "info" }, "Beta"),
        ),
      /data-tone="info"[\s\S]*Beta/,
    ],
    [
      "Kbd",
      () => renderToStaticMarkup(createElement(Kbd, { keys: "Ctrl+K" })),
      /kbd/i,
    ],
    [
      "ServiceBadge",
      () =>
        renderToStaticMarkup(createElement(ServiceBadge, { id: "license" })),
      /data-service="license"/,
    ],
    [
      "ServiceGlyph",
      () => renderToStaticMarkup(createElement(ServiceGlyph, { id: "config" })),
      /data-service="config"/,
    ],
    [
      "SignedBadge",
      () =>
        renderToStaticMarkup(createElement(SignedBadge, { kid: "rk-2026-09" })),
      /rk-2026-09/,
    ],
  ];
  it.each(cases)("%s", (_name, render, expected) => {
    expect(render()).toMatch(expected);
  });
});

describe("MDX components stand on the console's", () => {
  const read = (f: string): string =>
    readFileSync(join(here, "..", "src", "components", "docs", f), "utf8");
  it.each([
    ["Callout.astro", "ConsoleCallout"],
    ["Pill.astro", "StatusPill"],
    ["Status.astro", "StatusPill"],
    ["Requires.astro", "StatusPill"],
    ["ConsoleLink.astro", "BUTTON_VARIANTS"],
    ["PortalLink.astro", "BUTTON_VARIANTS"],
  ])("%s uses %s", (file, name) => {
    expect(read(file)).toContain(name);
  });
});
