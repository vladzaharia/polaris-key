// The landing page builds its lockups on the first request to `/`, never at module load: a brand
// template the page cannot theme must fail that request, not take the Worker (both hosts) down.

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@polaris-key/brand/svg");
  vi.resetModules();
});

describe("landing page artwork is lazy", () => {
  it("a lockup the page cannot theme fails the render, not the module load", async () => {
    vi.resetModules();
    vi.doMock("@polaris-key/brand/svg", async (importOriginal) => {
      const real =
        await importOriginal<typeof import("@polaris-key/brand/svg")>();
      return {
        ...real,
        lockupMetrics: (opts: Parameters<typeof real.lockupMetrics>[0]) => {
          const m = real.lockupMetrics(opts);
          // A template with a role the page has no class for (a gold bit, a plate).
          return {
            ...m,
            template: {
              ...m.template,
              body: `${m.template.body}<path fill="{gold}" d="M0 0Z"/>`,
            },
          };
        },
      };
    });
    const mod = await import("../src/core/bytesLanding.js");
    const env = { BLOB_ORIGIN: "https://dl.plrs.im" } as Parameters<
      typeof mod.renderLandingPage
    >[0];
    expect(() => mod.renderLandingPage(env)).toThrow(
      /unexpected lockup role gold/,
    );
    // The module's other exports still work.
    expect(mod.isLandingPath("/")).toBe(true);
  });
});
