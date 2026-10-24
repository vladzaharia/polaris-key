// F-37.2: renderCombinedFeedSetup and userConfigPlan (pure). Goldens: fixtures/feed-setup/combined-*.
// Regenerate with `vitest run -u` and review.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isExecStep,
  renderCombinedFeedSetup,
  userConfigPlan,
  type CombinedFeed,
} from "../../src/integration/index.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "feed-setup",
);
const ORIGIN = "https://pkg.plrs.im";
const TOKEN = "pkeyp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const FEEDS: CombinedFeed[] = [
  {
    ecosystem: "go",
    owner: "acme",
    namespace: { modulePrefixes: ["go.acme.dev"] },
  },
  { ecosystem: "godot", owner: "acme" },
  { ecosystem: "cargo", owner: "acme" },
  {
    ecosystem: "maven",
    owner: "acme",
    namespace: { groupPrefixes: ["gg.acme"] },
  },
  { ecosystem: "swift", owner: "acme", namespace: { scope: "acme" } },
  { ecosystem: "oci", owner: "acme" },
  { ecosystem: "pypi", owner: "acme", namespace: { names: ["acme-sdk"] } },
  { ecosystem: "npm", owner: "acme", namespace: { scope: "@acme" } },
];

describe("renderCombinedFeedSetup", () => {
  it("renders every ecosystem in order with one netrc entry (token)", async () => {
    const out = renderCombinedFeedSetup(FEEDS, {
      origin: ORIGIN,
      credential: { kind: "token", value: TOKEN },
    });
    await expect(out).toMatchFileSnapshot(join(FIXTURES, "combined-token.txt"));
    expect(out.match(/^machine /gm)).toHaveLength(1);
    expect(out).not.toMatch(/>> ~\/\.netrc/);
  });

  it("renders the env form with one netrc line", async () => {
    const out = renderCombinedFeedSetup(FEEDS, {
      origin: ORIGIN,
      credential: { kind: "env", name: "PKEY_REGISTRY_TOKEN" },
    });
    await expect(out).toMatchFileSnapshot(join(FIXTURES, "combined-env.txt"));
    expect(out.match(/>> ~\/\.netrc/g)).toHaveLength(1);
  });

  it("is independent of the input order", () => {
    const ctx = { origin: ORIGIN };
    expect(renderCombinedFeedSetup([...FEEDS].reverse(), ctx)).toBe(
      renderCombinedFeedSetup(FEEDS, ctx),
    );
  });
});

describe("userConfigPlan", () => {
  const plan = userConfigPlan(FEEDS, { origin: ORIGIN, token: TOKEN });

  it("matches the golden", async () => {
    await expect(JSON.stringify(plan, null, 2) + "\n").toMatchFileSnapshot(
      join(FIXTURES, "combined-plan.txt"),
    );
  });

  it("never puts the token in argv", () => {
    for (const s of plan.steps)
      if (isExecStep(s))
        expect(JSON.stringify(s.exec.argv)).not.toContain(TOKEN);
  });

  it("carries the token only in steps marked secret", () => {
    for (const s of plan.steps)
      if (JSON.stringify(s).includes(TOKEN)) expect(s.secret).toBe(true);
  });

  it("writes one netrc entry for pypi and go on one host", () => {
    const n = plan.steps.filter((s) => !isExecStep(s) && s.file === ".netrc");
    expect(n).toHaveLength(1);
  });

  it("skips godot, orders files before commands", () => {
    expect(plan.skipped.map((s) => s.ecosystem)).toEqual(["godot"]);
    const firstExec = plan.steps.findIndex(isExecStep);
    expect(plan.steps.slice(firstExec).every(isExecStep)).toBe(true);
  });

  it("skips an npm feed without a scope and refuses a bad token", () => {
    expect(
      userConfigPlan([{ ecosystem: "npm", owner: "acme" }], {
        origin: ORIGIN,
        token: TOKEN,
      }),
    ).toEqual({
      steps: [],
      skipped: [
        {
          ecosystem: "npm",
          owner: "acme",
          reason: "the feed has no npm scope to route",
        },
      ],
    });
    expect(() =>
      userConfigPlan(FEEDS, { origin: ORIGIN, token: "x y" }),
    ).toThrow(/token/);
  });
});
