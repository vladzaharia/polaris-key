// @pkey-feature connect.local
// `localLinks.open` (WIRE-CONTRACT-V5 §15.12): one dial per link at a time, a cooldown with a
// backoff after a dial that reached the network and failed, and a session that is adopted only once
// its link is known to be held. The LAN service and the store are fakes; the clock and the jitter
// are injected, so nothing here waits.
import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../src/constants.generated.js";
import type { LanService } from "../../src/connect/lan.js";
import { LocalLinks } from "../../src/connect/localLinks.js";
import { localTag, type LocalLinkRow } from "../../src/connect/localState.js";
import { ConnectSession, LanError } from "../../src/connect/session.js";

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const bytes = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const ID = "AAAAAAAAAAAAAAAA";

function row(id = ID, secretByte = 1): LocalLinkRow {
  return {
    id,
    ownKey: b64(bytes(2)),
    ownPublic: b64(bytes(3)),
    peerKey: b64(bytes(4)),
    secret: b64(bytes(secretByte)),
    cats: [],
    createdAt: 0,
    reachable: true,
  };
}

function setup(rows: LocalLinkRow[] = [row()]) {
  const clock = { t: 100, jitter: 0 };
  const adopted: ConnectSession[] = [];
  const state = { rows, allowed: true };
  const connectLocal = vi.fn<(id: string) => Promise<ConnectSession>>();
  const src = {
    slug: "djdl",
    now: () => 0,
    allowed: () => state.allowed,
    store: { rows: async () => state.rows },
    notify: () => undefined,
    onChange: () => () => undefined,
  };
  const links = new LocalLinks(src as never, {
    adopt: (s) => adopted.push(s),
    mono: () => clock.t,
    random: () => clock.jitter,
  });
  const lan = {
    onLocalSession: () => () => undefined,
    connectLocal,
  } as unknown as LanService;
  return { clock, adopted, state, links, lan, connectLocal };
}

/** A session that stands for one opened under link `id` with the secret of byte `secretByte`. */
function fakeSession(id = ID, secretByte = 1) {
  const close = vi.fn(async () => undefined);
  const s = {
    local: { id, tag: localTag(bytes(secretByte)) },
    close,
    onClose: () => () => undefined,
  };
  return { s: s as unknown as ConnectSession, close };
}

const refused = new LanError("handshake_failed", "refused");

describe("open: one dial per link, a cooldown and a backoff", () => {
  it("callers that come while a dial runs share it", async () => {
    const t = setup();
    await t.links.attach(t.lan);
    let done!: (s: ConnectSession) => void;
    t.connectLocal.mockReturnValue(new Promise((r) => (done = r)));
    const a = t.links.open(ID);
    const b = t.links.open(ID);
    await vi.waitFor(() => expect(t.connectLocal).toHaveBeenCalledTimes(1));
    const { s } = fakeSession();
    done(s);
    expect(await a).toBe(s);
    expect(await b).toBe(s);
    expect(t.adopted).toEqual([s]);
  });

  it("a dial that failed is held off for 3 to 5 s, then doubled for each failure in a row, and a success clears it", async () => {
    const t = setup();
    await t.links.attach(t.lan);
    t.connectLocal.mockRejectedValue(refused);
    t.clock.jitter = 0;
    await expect(t.links.open(ID)).rejects.toBe(refused);
    // Inside the cooldown nothing is dialled, and the error says to wait.
    t.clock.t += 2.9;
    await expect(t.links.open(ID)).rejects.toMatchObject({
      reason: "busy",
      code: ErrorCode.peerBusy,
    });
    expect(t.connectLocal).toHaveBeenCalledTimes(1);
    // Past it: one more dial, which fails, and the wait doubles to 6 s.
    t.clock.t += 0.2;
    await expect(t.links.open(ID)).rejects.toBe(refused);
    expect(t.connectLocal).toHaveBeenCalledTimes(2);
    t.clock.t += 5.9;
    await expect(t.links.open(ID)).rejects.toMatchObject({ reason: "busy" });
    t.clock.t += 0.2;
    // A success resets the count: the next failure waits the base again.
    const { s } = fakeSession();
    t.connectLocal.mockResolvedValueOnce(s);
    expect(await t.links.open(ID)).toBe(s);
    t.connectLocal.mockRejectedValue(refused);
    await expect(t.links.open(ID)).rejects.toBe(refused);
    t.clock.t += 3.1;
    await expect(t.links.open(ID)).rejects.toBe(refused);
    expect(t.connectLocal).toHaveBeenCalledTimes(5);
  });

  it("the jitter stretches the base from 3 s towards 5 s, and the backoff is capped", async () => {
    const t = setup();
    await t.links.attach(t.lan);
    t.connectLocal.mockRejectedValue(refused);
    t.clock.jitter = 0.99;
    await expect(t.links.open(ID)).rejects.toBe(refused);
    t.clock.t += 4.9;
    await expect(t.links.open(ID)).rejects.toMatchObject({ reason: "busy" });
    t.clock.t += 0.2;
    t.clock.jitter = 0;
    for (let i = 0; i < 10; i++) {
      await expect(t.links.open(ID)).rejects.toBe(refused);
      t.clock.t += 61;
    }
    // After many failures the wait is still at most a minute.
    await expect(t.links.open(ID)).rejects.toBe(refused);
    t.clock.t += 60.5;
    await expect(t.links.open(ID)).rejects.toBe(refused);
  });

  it("a link that is not seen on the network yet is no attempt: it is tried again at once", async () => {
    const t = setup();
    await t.links.attach(t.lan);
    t.connectLocal.mockRejectedValue(
      new LanError("unknown_peer", "not seen yet"),
    );
    for (let i = 0; i < 3; i++)
      await expect(t.links.open(ID)).rejects.toMatchObject({
        reason: "unknown_peer",
      });
    expect(t.connectLocal).toHaveBeenCalledTimes(3);
  });

  it("each link has its own cooldown", async () => {
    const other = "BBBBBBBBBBBBBBBB";
    const t = setup([row(), row(other, 9)]);
    await t.links.attach(t.lan);
    t.connectLocal.mockRejectedValueOnce(refused);
    await expect(t.links.open(ID)).rejects.toBe(refused);
    const { s } = fakeSession(other, 9);
    t.connectLocal.mockResolvedValueOnce(s);
    expect(await t.links.open(other)).toBe(s);
  });
});

describe("open: a session is adopted only once its link is known to be held", () => {
  it.each([
    {
      what: "a link forgotten while the dial ran",
      move: (t: ReturnType<typeof setup>) => (t.state.rows = []),
      error: { reason: "unknown_peer" },
      closes: "peer_revoked",
    },
    {
      what: "a gate cleared while the dial ran",
      move: (t: ReturnType<typeof setup>) => (t.state.allowed = false),
      error: { code: "local-pairing-off" },
      closes: "peer_bye",
    },
  ])("$what is closed and never handed to Direct Transfer", async (c) => {
    const t = setup();
    await t.links.attach(t.lan);
    const { s, close } = fakeSession();
    t.connectLocal.mockImplementation(async () => {
      c.move(t);
      return s;
    });
    await expect(t.links.open(ID)).rejects.toMatchObject(c.error);
    expect(close).toHaveBeenCalledWith(c.closes);
    expect(t.adopted).toEqual([]);
  });
});
