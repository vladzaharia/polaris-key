import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CiPublishingSection } from "../src/console/sections/core/pages/KeysCi.js";
import { mountAt } from "./releaseHarness.js";

/** Publish from CI's entry points (A-32 UX fix F9): Keys offers it with no publisher, and `?setup=ci` opens it. */

const json = (body: unknown): Response => Response.json(body);

const POLICY = {
  repository: "acme/tonebox",
  workflow: ".github/workflows/release.yml",
  environment: "release",
  scopes: ["release:publish"],
  source: "admin",
};

const READINESS = {
  repository: "acme/tonebox",
  capabilities: {
    pullRequest: true,
    workflow: true,
    environment: true,
    ruleset: true,
  },
  environmentName: "release",
  checks: [{ id: "app", state: "ok" }],
  workflowPreview: null,
  releaseKeys: false,
  links: { install: null, installation: null },
};

/** The Worker, as these pages see it: what each path answers. */
function stub(policy: unknown): void {
  const answers: [string, unknown][] = [
    ["ci-publisher", { ok: true, policy }],
    ["ci-tokens", { ok: true, tokens: [] }],
    ["ci-readiness", READINESS],
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const hit = answers.find(([part]) => url.includes(part));
      return json(
        hit ? hit[1] : { ok: true, releases: [], channels: [], floors: [] },
      );
    }),
  );
}

beforeEach(() => stub(null));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Publish from CI entry points", () => {
  it("Keys offers 'Set up publishing from CI…' with no trusted publisher yet", async () => {
    mountAt(
      "#/p/tonebox/settings/keys",
      <CiPublishingSection slug="tonebox" />,
    );
    expect(
      await screen.findByRole("button", { name: "Set up publishing from CI…" }),
    ).toBeTruthy();
  });

  it("and 'Publish from CI…' once there is one", async () => {
    stub(POLICY);
    mountAt(
      "#/p/tonebox/settings/keys",
      <CiPublishingSection slug="tonebox" />,
    );
    expect(
      await screen.findByRole("button", { name: "Publish from CI…" }),
    ).toBeTruthy();
  });

  it("the button puts ?setup=ci in the URL and opens the drawer; closing takes it out", async () => {
    mountAt(
      "#/p/tonebox/settings/keys",
      <CiPublishingSection slug="tonebox" />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Set up publishing from CI…" }),
    );
    expect(window.location.hash).toContain("setup=ci");
    expect(
      await screen.findByRole("dialog", { name: /Publish from CI/ }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(window.location.hash).not.toContain("setup=ci"));
  });

  it("a reload at ?setup=ci opens the drawer", async () => {
    mountAt(
      "#/p/tonebox/settings/keys?setup=ci",
      <CiPublishingSection slug="tonebox" />,
    );
    expect(
      await screen.findByRole("dialog", { name: /Publish from CI/ }),
    ).toBeTruthy();
  });
});
