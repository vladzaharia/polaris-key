// The bridge verb that ends a sign-in flow from its window, for the device-code flow and the
// choice ref a flow can hold. The redirect flow's cases are in electronNativeRedirect.test.ts.
import { describe, expect, it, vi } from "vitest";
import { GRANT, signInHost } from "./electronSignInHarness.js";

function setup(wait: () => Promise<unknown>) {
  return signInHost(
    {
      cancel: vi.fn(async () => ({ kind: "ok" })),
      complete: vi.fn(async () => ({ kind: "ok" })),
      licenses: vi.fn(async () => ({ kind: "ok", view: {} })),
    },
    wait,
  );
}

const pendingWait = async () => ({ kind: "pending", interval: 2 });

const chooseWait = async () => ({
  kind: "choose",
  grant: GRANT,
  expiresIn: 300,
  choices: { state: "choose", choices: [] },
});

const begin = async (h: ReturnType<typeof setup>, options?: object) =>
  (await h.bridge.beginSignIn(options as never)) as { flowId: string };

/** A flow that polled to `choose`, its choice ref held. */
async function held(h: ReturnType<typeof setup>) {
  const b = await begin(h, { licenseChoice: "app" });
  const r = (await h.bridge.pollSignIn(b.flowId)) as {
    kind: string;
    grant: string;
  };
  return { b, r };
}

const end = (h: ReturnType<typeof setup>, flowId: string) =>
  h.bridge.invoke!("identity", "signIn.cancel", { flowId });

/** The flow is gone: its poll is expired, ending it again is a no-op. Closes the host. */
async function expectGone(h: ReturnType<typeof setup>, flowId: string) {
  expect(await h.bridge.pollSignIn(flowId)).toEqual({ kind: "expired" });
  expect(await end(h, flowId)).toEqual({ ended: false });
  h.handle.close();
}

describe("ending a device-code flow from its window", () => {
  it("cancels the session; the next poll is expired", async () => {
    const h = setup(pendingWait);
    const b = await begin(h);
    expect(await end(h, b.flowId)).toEqual({ ended: true });
    expect(h.session.cancel).toHaveBeenCalledTimes(1);
    await expectGone(h, b.flowId);
  });

  it("a poll in flight when the flow is ended answers expired and signs nothing out", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Like the real session: a cancel during the poll wins over the answer.
    let cancelled = false;
    const h = setup(async () => {
      await gate;
      return cancelled
        ? { kind: "cancelled" }
        : { kind: "signedIn", subject: null, activation: {} };
    });
    h.session.cancel.mockImplementation(() => {
      cancelled = true;
    });
    const b = await begin(h);
    const polling = h.bridge.pollSignIn(b.flowId);
    await new Promise((r) => setTimeout(r, 0));
    expect(await end(h, b.flowId)).toEqual({ ended: true });
    release();
    expect(await polling).toEqual({ kind: "expired" });
    expect(h.identity.signOut).not.toHaveBeenCalled();
    h.handle.close();
  });

  it("sign-out ends the flow's choice and the flow", async () => {
    const h = setup(pendingWait);
    const b = await begin(h);
    await h.bridge.signOut();
    await expectGone(h, b.flowId);
  });

  it("releases a held choice ref", async () => {
    const h = setup(chooseWait);
    const { b, r } = await held(h);
    if (r.kind !== "choose") throw new Error("expected choose");
    expect(await end(h, b.flowId)).toEqual({ ended: true });
    expect(
      await h.bridge.invoke!("identity", "choice.licenses", { grant: r.grant }),
    ).toMatchObject({ kind: "refused", code: "invalid_grant" });
    expect(h.choice.licenses).not.toHaveBeenCalled();
    h.handle.close();
  });

  it("a cancel while the held ref is idle ends the flow and stores nothing", async () => {
    const h = setup(chooseWait);
    const { b } = await held(h);
    expect(await end(h, b.flowId)).toEqual({ ended: true });
    expect(h.choice.complete).not.toHaveBeenCalled();
    expect(h.identity.signOut).not.toHaveBeenCalled();
    h.handle.close();
  });

  it("a cancel while the completion is in flight is too late: the sign-in finishes and stays", async () => {
    const h = setup(chooseWait);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.choice.complete.mockImplementation(async () => {
      await gate;
      return { kind: "ok" };
    });
    const { b, r } = await held(h);
    const completing = h.bridge.invoke!("identity", "choice.complete", {
      grant: r.grant,
      choice: { kind: "keep" },
    });
    await new Promise((x) => setTimeout(x, 0));
    expect(await end(h, b.flowId)).toEqual({ ended: false });
    release();
    expect(await completing).toMatchObject({ kind: "ok" });
    expect(h.identity.signOut).not.toHaveBeenCalled();
    h.handle.close();
  });
});
