// The `local` section of `peer-matrix.json` (WIRE-CONTRACT-V5 §15.12, account-free local pairing),
// as suites over `peer/local.ts` and the codecs it builds on in `@polaris-key/client-core`. Called
// by `peerMatrixSuites.ts`, so the Node and the browser runner run the same rows. Nothing here
// imports a Node builtin.

import { describe, expect, it } from "vitest";
import {
  DialBudget,
  GATED_CALLS,
  JoinPlan,
  LocalPairingGate,
  LocalExchange,
  HandshakeLimiter,
  type LocalAdmission,
  LOCAL_GROUP_PER_MINUTE,
  MAX_LINK_SECRETS,
  MAX_LIVE_LOCAL_ADVERTS,
  MAX_LOCAL_LINKS,
  LOCAL_JOIN_BROWSE_SECONDS,
  LOCAL_JOIN_CANDIDATES,
  LOCAL_PAIR_FAILURES,
  LOCAL_PAIR_SECONDS,
  LOCAL_QR_SECRET_BYTES,
  PairingWindow,
  RECORD_TYPES,
  RecordAssembler,
  type RecordMode,
  base32Lower,
  browseLocalInstance,
  buildLocalLink,
  capsIntersection,
  displayCode,
  drawNameplate,
  drawPassword,
  localInstance,
  listenerTrialOrder,
  localLinkSecret,
  localPin,
  makeQr,
  trialPadding,
  negotiateLocalCaps,
  pairingInstance,
  pairingRemoteOk,
  parseCode,
  parseHandshakePayload,
  parseLocalLink,
  parseLocalTxt,
  parseQr,
  parseTxt,
  type DrawSource,
  type DialOutcome,
  type GateEffect,
  type PeerMode,
} from "@polaris-key/client-core";

const bytes = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The rows this module runs, typed by what it reads. */
export interface LocalSection {
  constants: Record<string, number>;
  codes: {
    digits: number;
    nameplate: {
      id: string;
      stream: string;
      inUse: string[];
      want: { nameplate: string | null; consumed: number };
    }[];
    password: {
      id: string;
      stream: string;
      want: { password: string | null; consumed: number };
    }[];
    display: {
      id: string;
      nameplate: string;
      password: string;
      want: string;
    }[];
    parse: {
      id: string;
      text: string;
      want: { ok: boolean; nameplate?: string; password?: string };
    }[];
  };
  qr: {
    secretBytes: number;
    make: {
      id: string;
      slug: string;
      sid: string;
      instance: string;
      secret: string;
      want: string;
    }[];
    parse: {
      id: string;
      text: string;
      own: string;
      want: {
        result: string;
        slug?: string;
        instance?: string;
        secret?: string;
      };
    }[];
  };
  adverts: {
    epochSeconds: number;
    maxLinks: number;
    maxLive: number;
    pairing: { id: string; sid: string; instance: string }[];
    names: {
      id: string;
      secret: string;
      ownLinkKey: string;
      epoch: number;
      instance: string;
    }[];
    browse: {
      id: string;
      links: { secret: string; peerKey: string }[];
      now: number;
      instance: string;
      want: { link: number; epochBack: number } | null;
    }[];
  };
  txt: {
    id: string;
    parser: "txt" | "local";
    entries: string[];
    want: Record<string, unknown>;
  }[];
  body: {
    id: string;
    body?: string;
    bodyHex?: string;
    bodyPad?: { prefix: string; fill: string; count: number; suffix: string };
    length: number;
    want: { ok: boolean; label?: string; cats?: string[] };
  }[];
  secrets: {
    id: string;
    h: string;
    isk: string;
    keyA: string;
    keyB: string;
    secret: string;
  }[];
  handshakePayloads: {
    maxPayload: number;
    payloads: {
      id: string;
      mode: PeerMode;
      message: 1 | 2 | 3;
      payload?: string;
      payloadHex?: string;
      length: number;
      want: { ok: boolean; caps?: string[] };
    }[];
    negotiate: {
      id: string;
      mode: "q" | "l";
      local: string[];
      remote: string[];
      want: { caps: string[]; close?: string };
    }[];
  };
  joinBudget: {
    id: string;
    joins: {
      t: number;
      input: { kind: "code"; nameplate: string } | { kind: "qr" };
      dials: number;
    }[];
    want: { allowed: boolean; used: number }[];
  }[];
  window: {
    id: string;
    steps: {
      event: string;
      t?: number;
      valid?: boolean;
      opens?: boolean;
      stored?: boolean;
      id?: number;
    }[];
    want: Record<string, unknown>[];
  }[];
  join: {
    id: string;
    input:
      | { kind: "code"; nameplate: string }
      | { kind: "qr"; instance: string }
      | { kind: "invalid" };
    adverts: { instance: string; h: string; n: string }[];
    dials: DialOutcome[];
    want: {
      browsed: boolean;
      kept: string[];
      dialled: string[];
      result: string;
    };
  }[];
  exchange: {
    id: string;
    held: number;
    cats: string[];
    steps: { event: string; body?: string }[];
    want: Record<string, unknown>[];
  }[];
  pin: {
    id: string;
    mode: "l" | "q";
    role: "initiator" | "responder";
    held?: string[];
    matched?: number;
    own?: string;
    remoteStatic: string;
    checkedAfter: number;
    want: { ok: boolean; close?: string; sends?: number };
  }[];
  /** A listener with no account key (§15.10, "Admission"). */
  admission: {
    id: string;
    events: (
      | { t: number; group: string; opens: boolean; later?: true }
      | { t: number; settle: number }
      | {
          t: number;
          release: number;
        }
    )[];
    want: {
      result: "tried" | "refused" | "released" | "settled";
      hit?: boolean;
      by?: "group" | "shared";
      group?: number;
      failed: number;
      waiting: number;
    }[];
  }[];
  /** Direct Transfer rows of mode `l`, run as the `xfer` section's. */
  xfer: unknown[];
  trialOrder: {
    id: string;
    account: (string | null)[] | null;
    contacts: string[];
    locals: string[];
    opens: {
      mode: "a" | "c" | "l";
      key?: number;
      contact?: number;
      link?: number;
    } | null;
    limiter: "admit" | "refuse";
    want: {
      tried: string[];
      hit: string | null;
      slot: boolean;
      close: string | null;
      dummy: number;
    };
  }[];
  records: {
    id: string;
    mode: RecordMode;
    type: string;
    want: {
      allowed?: boolean;
      ignored?: boolean;
      name?: string;
      needs?: string;
      close?: string;
    };
  }[];
  gate: {
    id: string;
    start: "on" | "off" | "none";
    steps: { call?: string; read?: string; body?: unknown }[];
    want: { cached: string; call?: string; effects?: GateEffect[] }[];
  }[];
}

/** A stream of fixed bytes: `source(n)` answers null, consuming nothing, when fewer than `n` are left. */
function stream(hexBytes: string): {
  source: DrawSource;
  consumed: () => number;
} {
  const all = bytes(hexBytes);
  let at = 0;
  return {
    source: (n) => {
      if (at + n > all.length) return null;
      const out = all.slice(at, at + n);
      at += n;
      return out;
    },
    consumed: () => at,
  };
}

function bodyBytes(r: LocalSection["body"][number]): Uint8Array {
  if (r.bodyHex !== undefined) return bytes(r.bodyHex);
  if (r.bodyPad !== undefined) {
    const p = r.bodyPad;
    return utf8(p.prefix + p.fill.repeat(p.count) + p.suffix);
  }
  return utf8(r.body!);
}

export function registerLocalSuites(
  l: LocalSection,
  runXfer: (row: unknown) => void,
): void {
  describe("peer-matrix local: admission", () => {
    it("the group's budget, then the shared limiter that only a failed trial spends", () => {
      expect(l.constants.admissionGroupPerMinute).toBe(LOCAL_GROUP_PER_MINUTE);
      for (const r of l.admission) {
        const clock = { t: 0 };
        const lim = new HandshakeLimiter(
          l.constants.admissionSharedPerMinute,
          l.constants.admissionWaiting,
          () => clock.t,
          l.constants.admissionGroupPerMinute,
        );
        const holds = new Map<number, () => void>();
        const verdicts = new Map<
          number,
          Extract<LocalAdmission, { ok: true }>
        >();
        const got = r.events.map((e, i) => {
          clock.t = e.t;
          if ("settle" in e) {
            const a = verdicts.get(e.settle);
            verdicts.delete(e.settle);
            const opens = (r.events[e.settle] as { opens: boolean }).opens;
            if (opens) holds.set(e.settle, a!.hit());
            else a!.miss();
            return { result: "settled", hit: opens };
          }
          if ("release" in e) {
            holds.get(e.release)?.();
            holds.delete(e.release);
            return { result: "released" };
          }
          const a = lim.beginLocal(e.group);
          if (!a.ok) return { result: "refused", by: a.by };
          if (e.later) {
            verdicts.set(i, a);
            return { result: "tried" };
          }
          if (e.opens) holds.set(i, a.hit());
          else a.miss();
          return { result: "tried", hit: e.opens };
        });
        // The state columns are the corpus's own bookkeeping; the limiter's answers are the rows'.
        expect(got, r.id).toEqual(
          r.want.map((w) => {
            const { group, failed, waiting, ...rest } = w; // eslint-disable-line @typescript-eslint/no-unused-vars
            return rest;
          }),
        );
      }
    });
  });

  describe("peer-matrix local: xfer", () => {
    it("Direct Transfer in mode l: allowed, and mode c's category rule", () => {
      expect(l.xfer.length).toBeGreaterThan(0);
      for (const row of l.xfer) runXfer(row);
    });
  });

  describe("peer-matrix local: constants", () => {
    it("match client-core", () => {
      expect(l.constants.pairSeconds).toBe(LOCAL_PAIR_SECONDS);
      expect(l.constants.codeDigits).toBe(l.codes.digits);
      expect(l.constants.pairFailures).toBe(LOCAL_PAIR_FAILURES);
      expect(l.constants.qrSecretBytes).toBe(LOCAL_QR_SECRET_BYTES);
      expect(l.constants.qrSecretBytes).toBe(l.qr.secretBytes);
      expect(l.constants.joinCandidates).toBe(LOCAL_JOIN_CANDIDATES);
      expect(l.constants.joinBrowseSeconds).toBe(LOCAL_JOIN_BROWSE_SECONDS);
      expect(l.constants.maxLinks).toBe(MAX_LOCAL_LINKS);
      expect(l.constants.maxLinks).toBe(l.adverts.maxLinks);
      expect(l.constants.maxLiveAdverts).toBe(MAX_LIVE_LOCAL_ADVERTS);
      expect(l.constants.maxLiveAdverts).toBe(l.adverts.maxLive);
      expect(l.constants.maxLinkSecrets).toBe(MAX_LINK_SECRETS);
      expect(l.constants.maxLinkSecrets).toBe(
        l.constants.maxContactSecrets! + l.constants.maxLinks!,
      );
    });
  });

  describe("peer-matrix local: codes", () => {
    it("nameplate: rejection sampling, in-use names, running out", () => {
      for (const r of l.codes.nameplate) {
        const s = stream(r.stream);
        expect(drawNameplate(s.source, r.inUse), r.id).toBe(r.want.nameplate);
        expect(s.consumed(), r.id).toBe(r.want.consumed);
      }
    });
    it("password: a u32be, drawn again at 4 294 000 000 or more", () => {
      for (const r of l.codes.password) {
        const s = stream(r.stream);
        expect(drawPassword(s.source), r.id).toBe(r.want.password);
        expect(s.consumed(), r.id).toBe(r.want.consumed);
      }
    });
    it("display: two groups of four", () => {
      for (const r of l.codes.display)
        expect(displayCode(r.nameplate, r.password), r.id).toBe(r.want);
    });
    it("parse: spaces and hyphens, then exactly 8 ASCII digits", () => {
      for (const r of l.codes.parse) {
        const got = parseCode(r.text);
        expect(got.ok, r.id).toBe(r.want.ok);
        if (got.ok) {
          expect(got.nameplate, r.id).toBe(r.want.nameplate);
          expect(got.password, r.id).toBe(r.want.password);
        }
      }
    });
  });

  describe("peer-matrix local: qr", () => {
    it("make: PKP1, the slug, 16 and 26 base32 characters, upper case", () => {
      for (const r of l.qr.make) {
        expect(pairingInstance(bytes(r.sid)), r.id).toBe(r.instance);
        expect(makeQr(r.slug, r.instance, bytes(r.secret)), r.id).toBe(r.want);
      }
    });
    it("parse: ok, other-app or invalid", () => {
      for (const r of l.qr.parse) {
        const got = parseQr(r.text, r.own);
        expect(got.result, r.id).toBe(r.want.result);
        if (got.result === "ok") {
          expect(got.slug, r.id).toBe(r.want.slug);
          expect(got.instance, r.id).toBe(r.want.instance);
          expect(base32Lower(got.secret), r.id).toBe(r.want.secret);
        }
      }
    });
  });

  describe("peer-matrix local: adverts", () => {
    it("the pairing instance is the 10 random bytes in base32", () => {
      for (const r of l.adverts.pairing)
        expect(pairingInstance(bytes(r.sid)), r.id).toBe(r.instance);
    });
    it("the local-link instance name", async () => {
      expect(l.adverts.epochSeconds).toBe(900);
      for (const r of l.adverts.names)
        expect(
          await localInstance(bytes(r.secret), bytes(r.ownLinkKey), r.epoch),
          r.id,
        ).toBe(r.instance);
    });
    it("browse: held order, the current and the previous epoch, at most 32 links", async () => {
      for (const r of l.adverts.browse) {
        const got = await browseLocalInstance(
          r.instance,
          r.links.map((k) => ({
            secret: bytes(k.secret),
            peerKey: bytes(k.peerKey),
          })),
          r.now,
        );
        expect(got, r.id).toEqual(r.want);
      }
    });
  });

  describe("peer-matrix local: txt", () => {
    it("parseTxt reads n for q only; parseLocalTxt needs v=1 and m=l", () => {
      for (const r of l.txt) {
        if (r.parser === "txt")
          expect(parseTxt(r.entries), r.id).toEqual(r.want);
        else expect(parseLocalTxt(r.entries), r.id).toEqual(r.want);
      }
    });
  });

  describe("peer-matrix local: body", () => {
    it("the LOCAL_LINK body", () => {
      for (const r of l.body) {
        const b = bodyBytes(r);
        expect(b.length, r.id).toBe(r.length);
        const got = parseLocalLink(b);
        expect(got.ok, r.id).toBe(r.want.ok);
        if (got.ok) {
          expect(got.label, r.id).toBe(r.want.label);
          expect(got.cats, r.id).toEqual(r.want.cats);
          // What a side builds, the peer reads back.
          const again = parseLocalLink(
            buildLocalLink({
              ...(got.label !== undefined ? { label: got.label } : {}),
              cats: got.cats,
            }),
          );
          expect(again, r.id).toEqual(got);
        }
      }
    });
  });

  describe("peer-matrix local: secrets", () => {
    it("the link secret: HKDF over h and the ISK, the keys by byte order", async () => {
      for (const r of l.secrets)
        expect(
          hex(
            await localLinkSecret(
              bytes(r.h),
              bytes(r.isk),
              bytes(r.keyA),
              bytes(r.keyB),
            ),
          ),
          r.id,
        ).toBe(r.secret);
    });
  });

  describe("peer-matrix local: handshake payloads", () => {
    it("modes q and l: strict JSON, no cert, caps of the shape", () => {
      for (const r of l.handshakePayloads.payloads) {
        const b =
          r.payloadHex !== undefined ? bytes(r.payloadHex) : utf8(r.payload!);
        expect(b.length, r.id).toBe(r.length);
        const got = parseHandshakePayload(r.mode, r.message, b);
        expect(got.ok, r.id).toBe(r.want.ok);
        if (got.ok && r.want.caps !== undefined)
          expect(got.caps, r.id).toEqual(r.want.caps);
      }
    });
    it("negotiation: the capabilities both hold; mode q needs local/1", () => {
      for (const r of l.handshakePayloads.negotiate) {
        const got = negotiateLocalCaps(r.mode, r.local, r.remote);
        expect(got.caps, r.id).toEqual(r.want.caps);
        expect(got.close, r.id).toBe(r.want.close);
        expect(capsIntersection(r.local, r.remote), r.id).toEqual(got.caps);
      }
    });
  });

  describe("peer-matrix local: window", () => {
    for (const r of l.window)
      it(r.id, () => {
        const w = new PairingWindow();
        // An event without an `id` names the latest attempt handed out.
        let last = 0;
        const got = r.steps.map((s) => {
          const t = s.t ?? 0;
          const id = s.id ?? last;
          let out: { result?: string; id?: number; host?: string } = {};
          switch (s.event) {
            case "open":
              out = w.open(t);
              break;
            case "c1":
              out = w.c1(t, s.valid!);
              if (out.id !== undefined) last = out.id;
              break;
            case "begin-guess":
              out = { result: w.beginGuess(id, t) ? "permit" : "denied" };
              break;
            case "msg1":
              out = w.msg1(id, t, s.opens!) ?? { result: "denied" };
              break;
            case "guess-opened":
              out = w.guessOpened(id, t);
              break;
            case "guess-failed":
              out = w.guessFailed(id, t);
              break;
            case "abandon":
              out = w.abandon(id, t);
              break;
            case "rotated":
              w.rotated(t);
              break;
            case "session-end":
              out = w.sessionEnd(t, s.stored!);
              break;
            case "tick":
              w.tick(t);
              break;
            case "close":
              out = w.close(t);
              break;
            default:
              throw new Error(`${r.id}: event ${s.event}`);
          }
          return {
            ...(out.result !== undefined ? { result: out.result } : {}),
            ...(out.id !== undefined ? { id: out.id } : {}),
            ...w.state,
            ...(out.host !== undefined ? { host: out.host } : {}),
          };
        });
        expect(got).toEqual(r.want);
      });
  });

  describe("peer-matrix local: joinBudget", () => {
    for (const r of l.joinBudget)
      it(r.id, () => {
        const budget = new DialBudget();
        const got = r.joins.map((j) => {
          if (j.input.kind === "qr") return { allowed: true, used: 0 };
          const verdict = budget.check(j.input.nameplate, j.t);
          if (verdict.allowed) budget.spend(j.input.nameplate, j.t, j.dials);
          return verdict;
        });
        expect(got).toEqual(r.want);
      });
  });

  describe("peer-matrix local: join", () => {
    for (const r of l.join)
      it(r.id, () => {
        const plan = new JoinPlan(r.input);
        for (const a of r.adverts)
          plan.see(a.instance, a.h === "current" || a.h === "previous", a.n);
        const dialled: string[] = [];
        for (const outcome of r.dials) {
          const next = plan.next();
          if (next === null) break;
          dialled.push(next);
          plan.ended(outcome);
        }
        expect({
          browsed: plan.browses,
          kept: [...plan.kept],
          dialled,
          result: plan.result(),
        }).toEqual(r.want);
      });
  });

  describe("peer-matrix local: exchange", () => {
    for (const r of l.exchange)
      it(r.id, () => {
        const x = new LocalExchange(r.held, r.cats);
        const got = r.steps.map((s) => {
          if (s.event === "peer-link")
            return x.step({ event: "peer-link", body: utf8(s.body!) });
          return x.step({
            event: s.event as
              | "own-confirm"
              | "own-decline"
              | "peer-confirm"
              | "timeout-confirm"
              | "timeout-exchange",
          });
        });
        expect(got).toEqual(r.want);
      });
  });

  describe("peer-matrix local: pin", () => {
    it("mode l pins the peer link key; mode q refuses its own key", () => {
      for (const r of l.pin) {
        if (r.mode === "l") {
          const ok = localPin(
            bytes(r.held![r.matched!]!),
            bytes(r.remoteStatic),
          );
          expect(
            ok ? { ok } : { ok, close: "peer_revoked", sends: 0 },
            r.id,
          ).toEqual(r.want);
        } else {
          const ok = pairingRemoteOk(bytes(r.own!), bytes(r.remoteStatic));
          expect(ok ? { ok } : { ok, close: "silent", sends: 0 }, r.id).toEqual(
            r.want,
          );
        }
        // The initiator asks after message 2, the responder after message 3.
        expect(r.checkedAfter, r.id).toBe(r.role === "initiator" ? 2 : 3);
      }
    });
  });

  describe("peer-matrix local: trial order", () => {
    it("account keys, then contacts (72), then local links (32): at most 104", () => {
      for (const r of l.trialOrder) {
        const plan = listenerTrialOrder(
          r.account,
          r.contacts.length,
          r.locals.length,
        );
        const tried: string[] = [];
        let hit: string | null = null;
        let close: string | null = null;
        let limiterAsked = false;
        for (const e of plan) {
          if (e.kind !== "a" && !limiterAsked) {
            // The contact limiter admits the secret trial once; a refusal tries no secret.
            limiterAsked = true;
            if (r.limiter === "refuse") {
              close = "peer_busy";
              break;
            }
          }
          const name = `${e.kind}:${e.index}`;
          tried.push(name);
          const o = r.opens;
          if (
            o !== null &&
            o.mode === e.kind &&
            (o.mode === "a" ? o.key : o.mode === "c" ? o.contact : o.link) ===
              e.index
          ) {
            hit = name;
            break;
          }
        }
        if (hit === null && close === null) close = "handshake_failed";
        const behindLimiter = r.contacts.length + r.locals.length > 0;
        expect(
          {
            tried,
            hit,
            slot: hit !== null && hit[0] !== "a",
            close,
            dummy:
              close === "handshake_failed" && behindLimiter
                ? trialPadding(tried.length)
                : 0,
          },
          r.id,
        ).toEqual(r.want);
      }
      expect(l.constants.maxLinkSecrets).toBe(MAX_LINK_SECRETS);
    });
  });

  describe("peer-matrix local: records", () => {
    it("the mode rules of §15.6 for q and l, and the new rows in the other modes", () => {
      for (const r of l.records) {
        const type = parseInt(r.type, 16);
        const body = new Uint8Array(type === 0x0004 || type === 0x0005 ? 8 : 0);
        const got = new RecordAssembler(r.mode).push({ type, flags: 0, body });
        if (r.want.ignored === true) {
          expect(got.kind, r.id).toBe("ignored");
        } else if (r.want.allowed === true) {
          expect(got.kind, r.id).toBe("message");
          const row = RECORD_TYPES.find((t) => type >= t.from && type <= t.to)!;
          expect(row.name, r.id).toBe(r.want.name);
          expect(row.needs, r.id).toBe(r.want.needs);
        } else {
          expect(got, r.id).toEqual({ kind: "close", code: r.want.close });
        }
      }
    });
  });

  describe("peer-matrix local: gate", () => {
    const gated = new Set<string>(GATED_CALLS);
    for (const r of l.gate)
      it(r.id, () => {
        const g = new LocalPairingGate(r.start);
        const got = r.steps.map((s) => {
          if (s.call !== undefined)
            return {
              cached: g.state,
              call: gated.has(s.call) ? g.check() : "ok",
            };
          const effects =
            s.read === "ok"
              ? g.readOk(s.body)
              : s.read === "not-found"
                ? g.readNotFound()
                : g.readError();
          return {
            cached: g.state,
            ...(effects.length > 0 ? { effects } : {}),
          };
        });
        expect(got).toEqual(r.want);
      });
  });
}
