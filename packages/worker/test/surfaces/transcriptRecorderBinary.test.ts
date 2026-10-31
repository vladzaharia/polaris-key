// The transcript recorder takes binary bodies (U-10.3): `bodyBase64` on the request and the
// response, additive to format version 1. The router is replaced by an echo so the recorder's own
// handling is what is under test; the committed transcripts (which never set `bytes` or
// `binaryResponse`) are held byte-identical by `test/transcripts.test.ts`.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/dispatch.js", () => ({
  // Echo the request body as raw bytes, with the request's method and path in headers.
  dispatchWith: async (req: Request) =>
    new Response(await req.arrayBuffer(), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-seen-type": req.headers.get("content-type") ?? "",
      },
    }),
}));

import { TranscriptRecorder } from "../transcripts/recorder.js";
import { emptyWorld } from "../transcripts/world.js";
import { T0 } from "../transcripts/client.js";

const BYTES = Uint8Array.from([0, 1, 2, 250, 251, 255, 128, 10, 13]);
const B64 = Buffer.from(BYTES).toString("base64");

function recorder(): TranscriptRecorder {
  return new TranscriptRecorder({
    id: "binary-probe",
    description: "x",
    features: [],
    requires: [],
    product: "djdl",
    now: T0,
    world: emptyWorld(),
    pinned: { setNow: () => undefined } as never,
    initial: { deviceId: "d", version: "1.0.0" } as never,
  });
}

describe("transcript recorder: binary bodies", () => {
  it("records raw request bytes and a raw response as bodyBase64", async () => {
    const r = recorder();
    let echoed: Uint8Array | undefined;
    await r.step(
      { action: "exchange" as never },
      async (s) => {
        const res = await s.send({
          method: "PUT",
          path: "/djdl/sync/files/uploads/u1",
          bytes: BYTES,
          binaryResponse: true,
        });
        echoed = new Uint8Array(await res.arrayBuffer());
      },
      {},
    );
    // The scenario still reads the response it recorded.
    expect(echoed).toEqual(BYTES);
    const ex = r.transcript().steps[0]!.exchanges.items[0]!;
    expect(ex.request.body).toBeNull();
    expect(ex.request.bodyBase64).toBe(B64);
    expect(ex.request.headers["content-type"]).toBe("application/octet-stream");
    expect(ex.request.requiredHeaders).toContain("content-type");
    expect(ex.response.body).toBe("");
    expect(ex.response.bodyBase64).toBe(B64);
  });

  it("leaves a text exchange exactly as before: no bodyBase64 member at all", async () => {
    const r = recorder();
    await r.step(
      { action: "exchange" as never },
      async (s) => {
        await s.send({
          method: "POST",
          path: "/djdl/x",
          body: { a: 1 },
          expectBody: { json: { a: 1 }, match: "exact" },
        });
      },
      {},
    );
    const ex = r.transcript().steps[0]!.exchanges.items[0]!;
    expect(Object.keys(ex.request)).toEqual([
      "method",
      "path",
      "headers",
      "requiredHeaders",
      "body",
    ]);
    expect(Object.keys(ex.response)).toEqual(["status", "headers", "body"]);
  });

  it("refuses bytes together with a JSON body", async () => {
    const r = recorder();
    await expect(
      r.step(
        { action: "exchange" as never },
        async (s) => {
          await s.send({
            method: "PUT",
            path: "/x",
            bytes: BYTES,
            body: {},
            expectBody: { json: {}, match: "exact" },
          });
        },
        {},
      ),
    ).rejects.toThrow(/bytes excludes body and form/);
  });
});
