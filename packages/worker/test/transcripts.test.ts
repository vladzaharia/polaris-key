// The HTTP transcripts (P1b-03, PARITY §4.2): record every scenario through the real router and
// hold `conformance/transcripts/*.json` (and its Swift and Godot mirrors) to what the Worker
// answers today.
//
//   pnpm --filter @polaris-key/worker test            # CHECK: fails when a file is stale
//   pnpm gen:transcripts                              # WRITE: regenerates every location
//   pnpm gen:transcripts -- --check                   # CHECK, on its own
//
// A Worker change that alters a recorded response fails this file until the transcripts are
// regenerated in the same change; the SDK replayers then show which SDKs must follow.
//
// Each scenario is also an ordinary test of the SERVER: its steps assert statuses and bodies as
// they record. And each is recorded twice, because a transcript that differs between two runs
// would make every regeneration a diff.

import { describe, expect, it, vi } from "vitest";
import { SCENARIOS } from "./transcripts/scenarios/index.js";
import { reconcile, serialize, WRITE_FLAG } from "./transcripts/io.js";

const write = process.env[WRITE_FLAG] === "1";

// The device-code scenarios sign in through a mocked IdP (`./transcripts/idp.ts`). jose's remote
// JWKS getter does not go through `globalThis.fetch`, so — exactly as `oidcEdge.test.ts` does —
// only that getter is swapped; the real `jwtVerify` still checks issuer, audience, signature,
// freshness and nonce.
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  const { idpKeyResolver } = await import("./transcripts/idp.js");
  return { ...actual, createRemoteJWKSet: () => idpKeyResolver };
});

describe("HTTP transcripts", () => {
  const rendered = new Map<string, string>();

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: records deterministically`, async () => {
      const first = await serialize(await scenario.record());
      const second = await serialize(await scenario.record());
      expect(second).toBe(first);
      rendered.set(scenario.id, first);
    });
  }

  it("scenario ids are unique", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(
    write
      ? "writes conformance/transcripts and the Swift and Godot mirrors"
      : "conformance/transcripts and the Swift and Godot mirrors are fresh",
    () => {
      expect(rendered.size).toBe(SCENARIOS.length);
      const drift = reconcile(rendered, write);
      const hint = "run `pnpm gen:transcripts` and commit the result";
      expect(
        drift.map((d) => `${d.problem}: ${d.file}`),
        hint,
      ).toEqual([]);
    },
  );
});
