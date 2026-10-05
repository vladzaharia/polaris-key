/**
 * F-12: `renderFeedSetup`, the one function behind the console's Setup tabs and `pkey feeds setup`.
 *
 * The shared cases (`fixtures/feed-setup/cases.json`) each have a golden (`<id>.txt`, the output of
 * `formatFeedSetup`). The CLI's test runs `pkey feeds setup` on the same cases and the console's
 * test renders the Setup tab on them; both compare against these goldens, so the CLI and the
 * console are byte-identical for the same input. Regenerate with `vitest run -u` and review.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FEED_SETUP,
  PACKAGE_ECOSYSTEMS,
  PACKAGE_ECOSYSTEM_RULES,
  feedSetupBaseUrl,
  feedSetupProblem,
  formatFeedSetup,
  renderFeedSetup,
  type FeedSetupContext,
  type PackageEcosystem,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "feed-setup");

interface Case {
  id: string;
  ecosystem: PackageEcosystem;
  owner: string;
  namespace?: Record<string, unknown>;
  package?: { name: string; version?: string };
  credential?: FeedSetupContext["credential"];
}

const { origin, cases } = JSON.parse(
  readFileSync(join(FIXTURES, "cases.json"), "utf8"),
) as { origin: string; cases: Case[] };

function contextOf(c: Case): FeedSetupContext {
  return {
    origin,
    owner: c.owner,
    ...(c.namespace ? { namespace: c.namespace } : {}),
    ...(c.package ? { package: c.package } : {}),
    ...(c.credential ? { credential: c.credential } : {}),
  };
}

describe("renderFeedSetup goldens (shared with the CLI and the console)", () => {
  it("covers every ecosystem", () => {
    for (const e of PACKAGE_ECOSYSTEMS)
      expect(
        cases.some((c) => c.ecosystem === e),
        e,
      ).toBe(true);
  });

  for (const c of cases)
    it(c.id, async () => {
      const text = formatFeedSetup(renderFeedSetup(c.ecosystem, contextOf(c)));
      await expect(text).toMatchFileSnapshot(join(FIXTURES, `${c.id}.txt`));
    });
});

describe("renderFeedSetup", () => {
  const ctx = (over: Partial<FeedSetupContext> = {}): FeedSetupContext => ({
    origin,
    owner: "acme",
    ...over,
  });

  it("is pure: the same input renders the same bytes", () => {
    for (const c of cases)
      expect(renderFeedSetup(c.ecosystem, contextOf(c))).toEqual(
        renderFeedSetup(c.ecosystem, contextOf(c)),
      );
  });

  it("reads only the inputs each ecosystem declares", () => {
    for (const e of PACKAGE_ECOSYSTEMS) {
      const decl = FEED_SETUP[e];
      expect(
        decl.inputs.includes("baseUrl") || decl.inputs.includes("registryHost"),
        e,
      ).toBe(true);
      for (const input of decl.inputs) {
        const key = /^namespace\.(.+)$/.exec(input)?.[1];
        if (key !== undefined)
          expect(
            Object.hasOwn(PACKAGE_ECOSYSTEM_RULES[e].namespace.fields, key),
            `${e}: ${input}`,
          ).toBe(true);
      }
      // A template reading an undeclared input throws, so this is the whole dependency list.
      const narrowed = {
        ...decl,
        inputs: decl.inputs.filter((i) => i !== decl.inputs[0]),
      };
      const original = FEED_SETUP[e];
      (FEED_SETUP as Record<string, unknown>)[e] = narrowed;
      try {
        expect(() => renderFeedSetup(e, ctx({ namespace: {} }))).toThrow(
          /does not declare/,
        );
      } finally {
        (FEED_SETUP as Record<string, unknown>)[e] = original;
      }
    }
  });

  it("base URLs follow the feed paths, the owner URL-encoded", () => {
    expect(feedSetupBaseUrl("npm", "https://pkg.plrs.im/", "acme")).toBe(
      "https://pkg.plrs.im/npm/acme/",
    );
    expect(feedSetupBaseUrl("pypi", origin, "acme")).toBe(
      "https://pkg.plrs.im/pypi/acme/simple/",
    );
    expect(feedSetupBaseUrl("oci", origin, "acme")).toBe(
      "https://pkg.plrs.im/v2/acme/",
    );
  });

  it("uses only strict routers", () => {
    const all = (e: PackageEcosystem, c: Partial<FeedSetupContext> = {}) =>
      renderFeedSetup(e, ctx(c))
        .map((s) => s.code)
        .join("\n");
    expect(all("npm", { namespace: { scope: "@acme" } })).toMatch(
      /^@acme:registry=/m,
    );
    expect(all("npm", { namespace: { scope: "@acme" } })).not.toMatch(
      /^registry=/m,
    );
    expect(all("pypi")).toContain("explicit = true");
    expect(all("pypi")).toContain("--priority=explicit");
    expect(all("pypi")).not.toContain("--extra-index-url");
    expect(
      all("maven", { namespace: { groupPrefixes: ["gg.acme"] } }),
    ).toContain("exclusiveContent");
    expect(all("swift", { namespace: { scope: "acme" } })).toContain(
      '"acme": {',
    );
    expect(all("swift", { namespace: { scope: "acme" } })).toContain(
      '"version": 1',
    );
    expect(all("oci", { package: { name: "server" } })).toContain(
      "docker pull pkg.plrs.im/acme/server:latest",
    );
  });

  it("sets GOPROXY with GONOSUMDB, never GOPRIVATE, and a .netrc entry for a token (F-31)", () => {
    const go = renderFeedSetup(
      "go",
      ctx({
        namespace: { modulePrefixes: ["go.acme.dev"] },
        credential: { kind: "token", value: "pkeyr_abcdefgh" },
      }),
    );
    const proxy = go.find((s) => s.id === "goproxy")!;
    expect(proxy.code).toContain(
      "go env -w GOPROXY=https://pkg.plrs.im/go/acme,https://proxy.golang.org,direct",
    );
    expect(proxy.code).toContain("go env -w GONOSUMDB=go.acme.dev");
    expect(proxy.code).not.toContain("GOPRIVATE");
    expect(proxy.warning).toMatch(/GOPRIVATE/);
    const netrc = go.find((s) => s.id === "netrc")!;
    expect(netrc.filename).toBe("~/.netrc");
    expect(netrc.code).toBe(
      "machine pkg.plrs.im\nlogin __token__\npassword pkeyr_abcdefgh",
    );
    expect(go.find((s) => s.id === "go-get")!.code).toBe(
      "go get go.acme.dev/<module>@latest",
    );
  });

  it("warns pip users off --extra-index-url", () => {
    const pip = renderFeedSetup("pypi", ctx()).find((s) => s.id === "pip")!;
    expect(pip.warning).toMatch(/--extra-index-url/);
    expect(pip.code).toContain("--index-url");
    expect(pip.code).toContain("--no-deps");
  });

  it("keeps credentials to the kinds each feed takes", () => {
    const godotEnv = renderFeedSetup(
      "godot",
      ctx({ credential: { kind: "env", name: "TOKEN" } }),
    );
    expect(godotEnv).toEqual(renderFeedSetup("godot", ctx()));
    const npmUrl = renderFeedSetup(
      "npm",
      ctx({
        namespace: { scope: "@acme" },
        credential: { kind: "godot-url", value: "pkeyr_abcdefgh" },
      }),
    );
    expect(npmUrl).toEqual(
      renderFeedSetup("npm", ctx({ namespace: { scope: "@acme" } })),
    );
  });

  it("refuses inputs a snippet could not carry safely", () => {
    expect(feedSetupProblem("cargo", ctx())).toMatch(/unknown ecosystem/);
    expect(feedSetupProblem("npm", ctx({ owner: "Acme Corp" }))).toMatch(
      /not a slug/,
    );
    expect(
      feedSetupProblem("npm", ctx({ origin: "https://pkg.plrs.im/x" })),
    ).toMatch(/origin only/);
    expect(
      feedSetupProblem("npm", ctx({ namespace: { scope: "acme;rm" } })),
    ).toMatch(/malformed/);
    expect(
      feedSetupProblem("npm", ctx({ namespace: { groupPrefixes: [] } })),
    ).toMatch(/no namespace key/);
    expect(
      feedSetupProblem("maven", ctx({ namespace: { groupPrefixes: "gg" } })),
    ).toMatch(/is a list/);
    expect(
      feedSetupProblem("npm", ctx({ package: { name: "left-pad" } })),
    ).toMatch(/not a npm package name/);
    expect(
      feedSetupProblem(
        "npm",
        ctx({ credential: { kind: "env", name: "BAD-NAME" } }),
      ),
    ).toMatch(/environment variable/);
    expect(
      feedSetupProblem(
        "npm",
        ctx({ credential: { kind: "token", value: "a b'c$(x)" } }),
      ),
    ).toMatch(/cannot carry/);
    expect(() => renderFeedSetup("npm", ctx({ owner: "Acme Corp" }))).toThrow(
      /not a slug/,
    );
    expect(feedSetupProblem("npm", ctx({ namespace: { scope: "" } }))).toBe(
      null,
    );
  });
});
