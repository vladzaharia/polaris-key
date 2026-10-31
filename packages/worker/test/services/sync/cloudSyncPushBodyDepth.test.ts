/**
 * F7-R1: a push body that nests past `MAX_JSON_DEPTH` is a request-level `400 bad_request`, never an
 * exception out of the Worker. The check is iterative, so it holds at any depth.
 */
import { describe, expect, it } from "vitest";
import { MAX_JSON_DEPTH } from "@polaris-key/protocol/core";
import { dispatch } from "../../../src/dispatch.js";
import {
  CLIENT,
  SLUG,
  authed,
  hlc,
  nextId,
  pull,
  world,
} from "./cloudSyncAbuseWorld.js";

const catalog = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [
      { name: "saves", template: "saves" },
      { name: "tags", template: "tags" },
    ],
  },
};
const deep = (n: number) => "[".repeat(n) + "1" + "]".repeat(n);

describe("push body nesting is bounded at MAX_JSON_DEPTH", () => {
  const body = (mutation: string) =>
    `{"clientId":"${CLIENT}","cursor":0,"mutations":[{"mutationId":${nextId()},"editedHlc":"${hlc}",${mutation}}]}`;
  const post = async (w: Awaited<ReturnType<typeof world>>, raw: string) =>
    dispatch(
      new Request(`https://key.plrs.im/${SLUG}/sync/ops`, {
        method: "POST",
        headers: authed(w),
        body: raw,
      }) as never,
      w.env,
      w.db,
    );

  const placements: [string, (n: number) => string][] = [
    [
      "value",
      (n) => `"target":{"record":["saves","a"]},"op":"set","value":${deep(n)}`,
    ],
    [
      "element",
      (n) => `"target":{"record":["tags","a"]},"op":"add","element":${deep(n)}`,
    ],
    [
      "baseVersion",
      (n) =>
        `"target":{"record":["saves","a"]},"op":"set","value":1,"baseVersion":${deep(n)}`,
    ],
    [
      "settings value",
      (n) =>
        `"target":{"setting":"theme","scope":"user"},"op":"set","value":${deep(n)}`,
    ],
  ];

  for (const depth of [MAX_JSON_DEPTH + 1, 5_000, 120_000])
    for (const [where, make] of placements)
      it(`${depth} levels in ${where} answers 400 and writes nothing`, async () => {
        const w = await world({ catalog });
        const res = await post(w, body(make(depth)));
        expect(res.status).toBe(400);
        expect(
          ((await res.json()) as { error: { code: string } }).error.code,
        ).toBe("bad_request");
        const got = (await (await pull(w)).json()) as { records?: unknown[] };
        expect(got.records ?? []).toHaveLength(0);
      });

  it("a 40-level value still answers 200 with value_invalid", async () => {
    const w = await world({ catalog });
    const res = await post(w, body(placements[0]![1](40)));
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      results: { status: string; code?: string }[];
    };
    expect(j.results[0]).toMatchObject({
      status: "rejected",
      code: "value_invalid",
    });
  });
});
