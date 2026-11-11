// @pkey-feature connect.local
//
// The Light Card choreography (UK-67.1): the PRNG, the timeline against the golden envelope, the QR
// geometry, the fixed-step particles and the margin rule. The golden file
// (fixtures/lightCard.golden.json) is the contract every kit checks its port against; the particle
// positions are decorative (they depend on the platform's sin and exp), so they are pinned here
// only, at a few early steps. No wall clock: every time is passed in.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  LIGHT_CARD,
  advance,
  cardGeometry,
  checkPoints,
  connect,
  createLightCardSim,
  createRng,
  createTimeline,
  dispatchTimeline,
  envelopeAt,
  expire,
  glowAlpha,
  newCode,
  particleCount,
  reducedEnvelope,
  resume,
  shownGeometry,
  simEnvelope,
  type Envelope,
  type LightCardEvent,
  type QrMatrix,
  type Timeline,
} from "../src/lightCard.js";

const GOLDEN_URL = new URL("./fixtures/lightCard.golden.json", import.meta.url);
const PAYLOAD = "PKP1:DJDL:K7MZ2X4G:6WPA3TFQ9H";
const ENVELOPE_KEYS = [
  "phase",
  "landed",
  "cardOpacity",
  "orbit",
  "dim",
  "check",
  "flare",
  "ambient",
  "swapped",
  "frameRate",
] as const;

interface Scenario {
  name: string;
  events: { at: number; event: LightCardEvent }[];
  times: number[];
}
// Each scenario is replayed from a timeline created at 0; the times follow each transition.
const SCENARIOS: Scenario[] = [
  {
    name: "forming",
    events: [],
    times: [0, 0.5, 0.65, 1, 1.5, 2, 2.35, 2.4, 3, 12.39, 12.4, 20],
  },
  {
    name: "new code from ready",
    events: [{ at: 5, event: "newCode" }],
    times: [5, 5.1, 5.2, 5.3, 5.45, 5.6, 6, 6.5, 7, 7.25, 7.5, 9],
  },
  {
    name: "connected from ready",
    events: [{ at: 5, event: "connected" }],
    times: [5, 5.2, 5.4, 5.6, 5.85, 6, 6.3, 6.75, 7, 8],
  },
  {
    name: "expired from ready",
    events: [{ at: 5, event: "expired" }],
    times: [5, 5.5, 6, 6.2, 7, 10],
  },
  {
    name: "new code from expired",
    events: [
      { at: 5, event: "expired" },
      { at: 9, event: "newCode" },
    ],
    times: [9, 9.45, 10, 11.5, 12],
  },
  {
    name: "events that do not apply",
    events: [
      { at: 1, event: "connected" },
      { at: 1.2, event: "expired" },
      { at: 1.4, event: "newCode" },
    ],
    times: [1.5, 2.4, 3],
  },
];

const round = (v: number): number => Number(v.toFixed(9));

function replay(events: Scenario["events"], t: number): Envelope {
  let tl: Timeline = createTimeline(0);
  for (const e of events)
    if (e.at <= t) tl = dispatchTimeline(tl, e.event, e.at);
  return envelopeAt(tl, t);
}
function pick(e: Envelope): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const k of ENVELOPE_KEYS)
    out[k] = typeof e[k] === "number" ? round(e[k] as number) : e[k];
  return out;
}

function qrOf(rows: readonly string[]): QrMatrix {
  const size = rows.length;
  const modules = new Uint8Array(size * size);
  rows.forEach((row, y) => {
    for (let x = 0; x < size; x++)
      modules[y * size + x] = row[x] === "#" ? 1 : 0;
  });
  return { size, modules };
}
const sum = (a: ArrayLike<number>, from: number, step: number): number => {
  let s = 0;
  for (let i = from; i < a.length; i += step) s += a[i]!;
  return round(s);
};

function geometrySummary(rows: readonly string[]) {
  const g = cardGeometry(qrOf(rows));
  return {
    n: g.n,
    cell: round(g.cell),
    x0: round(g.x0),
    y0: round(g.y0),
    side: round(g.side),
    radius: round(g.radius),
    dotRadius: round(g.dotRadius),
    half: round(g.half),
    finderSide: round(g.finderSide),
    finders: g.finders.map(([x, y]) => [round(x), round(y)]),
    star: g.star.map(([x, y]) => [round(x), round(y)]),
    lightCount: g.lights.length / 3,
    darkCount: g.darks.length / 2,
    firstLights: Array.from(g.lights.slice(0, 18), round),
    lastLights: Array.from(g.lights.slice(-9), round),
    lightSums: [sum(g.lights, 0, 3), sum(g.lights, 1, 3), sum(g.lights, 2, 3)],
    darkSums: [sum(g.darks, 0, 2), sum(g.darks, 1, 2)],
  };
}

// Written by `PKEY_WRITE_LIGHT_CARD_GOLDEN=1 pnpm --filter @polaris-key/ui-core test lightCard`;
// the encoder is the SDK's, at level Q; then run prettier on the fixture.
if (process.env.PKEY_WRITE_LIGHT_CARD_GOLDEN) {
  const { encodeQr } = await import("../../sdk-node/src/qr/encoder.js");
  const q = encodeQr(PAYLOAD, 1, -1, "Q")!;
  const rows = Array.from({ length: q.size }, (_, y) =>
    Array.from({ length: q.size }, (_, x) =>
      q.modules[y * q.size + x] ? "#" : ".",
    ).join(""),
  );
  const written = {
    comment:
      "Light Card golden frames. Every kit checks its port of the timeline and the QR geometry against this file. Replay `events` from a timeline created at 0 and sample at each time; compare with a tolerance of 1e-6. Particle positions are not goldens.",
    payload: PAYLOAD,
    ecLevel: "Q",
    rows,
    geometry: geometrySummary(rows),
    envelope: {
      keys: ENVELOPE_KEYS,
      scenarios: SCENARIOS.map((s) => ({
        name: s.name,
        events: s.events,
        samples: s.times.map((t) => ({ t, ...pick(replay(s.events, t)) })),
      })),
    },
    check: checkPoints(5).map(([x, y]) => [round(x), round(y)]),
  };
  writeFileSync(GOLDEN_URL, `${JSON.stringify(written, null, 2)}\n`);
}

const golden = JSON.parse(readFileSync(GOLDEN_URL, "utf8")) as {
  payload: string;
  rows: string[];
  geometry: ReturnType<typeof geometrySummary>;
  envelope: {
    scenarios: {
      name: string;
      events: Scenario["events"];
      samples: ({ t: number } & Record<string, number | string | boolean>)[];
    }[];
  };
  check: number[][];
};

function near(a: unknown, b: unknown, path: string): void {
  if (typeof a === "number" && typeof b === "number")
    expect(Math.abs(a - b), path).toBeLessThan(1e-6);
  else if (Array.isArray(a) && Array.isArray(b)) {
    expect(a.length, path).toBe(b.length);
    a.forEach((v, i) => near(v, b[i], `${path}[${i}]`));
  } else expect(a, path).toEqual(b);
}

describe("mulberry32", () => {
  const u32 = (seed: number, n: number): number[] => {
    const r = createRng(seed);
    return Array.from({ length: n }, () => r.next() * 4294967296);
  };
  it("gives the pinned 32-bit words", () => {
    expect(u32(0, 4)).toEqual([1144304738, 1416247, 958946056, 627933444]);
    expect(u32(1, 4)).toEqual([2693262067, 11749833, 2265367787, 4213581821]);
    expect(u32(0xdeadbeef, 3)).toEqual([4043151706, 1147597007, 3315858022]);
  });
  it("is in [0, 1), repeats for a seed and takes it as unsigned", () => {
    const a = createRng(7);
    const b = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = a.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(b.next());
    }
    expect(createRng(-1).next()).toBe(createRng(0xffffffff).next());
  });
});

describe("timeline against the golden envelope", () => {
  for (const [i, s] of golden.envelope.scenarios.entries())
    it(s.name, () => {
      expect(s.name).toBe(SCENARIOS[i]!.name);
      for (const sample of s.samples) {
        const { t, ...want } = sample;
        near(pick(replay(s.events, t)), want, `${s.name} @${t}`);
      }
    });

  it("walks the phases", () => {
    let tl = createTimeline(0);
    expect(envelopeAt(tl, 0.1).phase).toBe("forming");
    expect(envelopeAt(tl, 2.5).phase).toBe("ready");
    tl = dispatchTimeline(tl, "newCode", 5);
    expect(envelopeAt(tl, 5.2).phase).toBe("refreshing");
    expect(envelopeAt(tl, 8).phase).toBe("ready");
    tl = dispatchTimeline(tl, "expired", 10);
    expect(envelopeAt(tl, 10.1).phase).toBe("expired");
    tl = dispatchTimeline(tl, "newCode", 12);
    expect(envelopeAt(tl, 12.1).phase).toBe("refreshing");
    tl = dispatchTimeline(tl, "connected", 20);
    expect(envelopeAt(tl, 20.1).phase).toBe("connected");
  });

  it("is ready about 2.5 s in and drops to 30 fps after 10 s of waiting", () => {
    const tl = createTimeline(100);
    expect(envelopeAt(tl, 102.4).cardOpacity).toBeGreaterThan(0.99);
    expect(envelopeAt(tl, 112.3).frameRate).toBe(LIGHT_CARD.fullFps);
    expect(envelopeAt(tl, 112.4).frameRate).toBe(LIGHT_CARD.idleFps);
    // A new code starts the wait again.
    const again = dispatchTimeline(tl, "newCode", 120);
    expect(envelopeAt(again, 125).frameRate).toBe(LIGHT_CARD.fullFps);
    expect(envelopeAt(again, 140).frameRate).toBe(LIGHT_CARD.idleFps);
  });

  it("draws the finished card, still, for Reduce Motion", () => {
    for (const phase of ["forming", "ready", "refreshing"] as const) {
      const e = reducedEnvelope(phase);
      expect([e.cardOpacity, e.landed, e.dim, e.orbit]).toEqual([1, 1, 1, 0]);
    }
    expect(reducedEnvelope("expired").dim).toBe(LIGHT_CARD.dim.expired);
    expect(reducedEnvelope("connected")).toMatchObject({
      cardOpacity: 0,
      check: 1,
    });
  });
});

describe("QR geometry", () => {
  const g = cardGeometry(qrOf(golden.rows));
  it("matches the golden summary", () => {
    near(geometrySummary(golden.rows), golden.geometry, "geometry");
    near(
      checkPoints(5).map(([x, y]) => [round(x), round(y)]),
      golden.check,
      "check",
    );
  });
  it("is the same for the same input", () => {
    expect(cardGeometry(qrOf(golden.rows))).toEqual(g);
  });
  it("has a 2-module quiet zone, three finders and a cleared centre", () => {
    expect(g.side).toBe(220);
    expect(g.cell * (g.n + 4)).toBeCloseTo(220, 9);
    expect(g.finders).toHaveLength(3);
    const mid = LIGHT_CARD.stage / 2;
    // No dark dot inside the star's clearing.
    for (let i = 0; i < g.darks.length; i += 2)
      expect(
        Math.hypot(g.darks[i]! - mid, g.darks[i + 1]! - mid),
      ).toBeGreaterThan(g.cell * 3.1);
    // Nearest first.
    for (let i = 5; i < g.lights.length; i += 3)
      expect(g.lights[i]!).toBeGreaterThanOrEqual(g.lights[i - 3]!);
    // Every cell is a dot, a light cell, or one of the three finders' 49 cells.
    expect(g.lights.length / 3 + g.darks.length / 2).toBe(
      (g.n + 4) ** 2 - 3 * 49,
    );
  });
  it("is cleared at level Q's tolerance", () => {
    // The clearing removes at most 7% of the symbol's modules.
    const cleared = Math.PI * LIGHT_CARD.clearRadius ** 2;
    expect(cleared / (g.n * g.n)).toBeLessThan(0.07);
  });
  it("gives each paper cell a mote and scales the ambient light by area within bounds", () => {
    const p = LIGHT_CARD.particles;
    expect(particleCount(440, 800)).toBe(Math.ceil(800 * p.cardSlack) + 650);
    expect(particleCount(100, 800) - Math.ceil(800 * p.cardSlack)).toBe(
      p.ambientMin,
    );
    expect(particleCount(4000, 800) - Math.ceil(800 * p.cardSlack)).toBe(
      p.ambientMax,
    );
  });
});

function sim(seed = 7, count = 900) {
  return createLightCardSim({ qr: qrOf(golden.rows), seed, now: 1000, count });
}

/** Advance the run to `seconds` after its start, a frame at a time. */
function runTo(s: ReturnType<typeof sim>, seconds: number): void {
  const frame = LIGHT_CARD.dt * 2;
  for (let t = s.t + frame; t < seconds; t += frame) advance(s, 1000 + t);
  advance(s, 1000 + seconds);
}

describe("particles", () => {
  it("are deterministic for a seed", () => {
    const a = sim();
    const b = sim();
    runTo(a, 3);
    runTo(b, 3);
    expect(a.particles.x).toEqual(b.particles.x);
    expect(a.particles.vy).toEqual(b.particles.vy);
    const c = sim(8);
    runTo(c, 3);
    expect(c.particles.x).not.toEqual(a.particles.x);
  });

  it("pins the first steps", () => {
    const s = sim();
    advance(s, 1000 + 3 * LIGHT_CARD.dt + 1e-6);
    expect(s.t).toBeCloseTo(3 * LIGHT_CARD.dt, 12);
    const at = (i: number) => [
      round(s.particles.x[i]!),
      round(s.particles.y[i]!),
    ];
    expect([at(0), at(1), at(2)]).toMatchInlineSnapshot(`
      [
        [
          294.434055675,
          225.687894325,
        ],
        [
          109.831004676,
          243.608485314,
        ],
        [
          233.39886377,
          71.309094695,
        ],
      ]
    `);
  });

  it("lands the centre first and sits still on the cells once formed", () => {
    const s = sim();
    runTo(s, 0.9);
    // Early in the landing the nearest cells are closer to their targets than the farthest.
    const p = s.particles;
    const err = (i: number) =>
      Math.hypot(p.x[i]! - p.tx[i]!, p.y[i]! - p.ty[i]!);
    const cells = shownGeometry(s).lights.length / 3;
    let near = 0;
    let far = 0;
    const k = Math.floor(cells / 5);
    for (let i = 0; i < k; i++) near += err(i);
    for (let i = cells - k; i < cells; i++) far += err(i);
    expect(near / k).toBeLessThan(far / k);
    // Formed: every card particle is on its cell, so the modules do not move.
    runTo(s, 5);
    const x = Float64Array.from(p.x);
    runTo(s, 6);
    for (let i = 0; i < cells; i++) {
      expect(Math.abs(p.x[i]! - p.tx[i]!)).toBeLessThan(0.5);
      expect(Math.abs(p.x[i]! - x[i]!)).toBeLessThan(0.5);
    }
  });

  it("keeps every drawn light outside the card margin once it has formed", () => {
    for (const seed of [1, 7, 99]) {
      const s = sim(seed, 1350);
      const g = cardGeometry(qrOf(golden.rows));
      const mid = LIGHT_CARD.stage / 2;
      let t = 1000;
      let checked = 0;
      for (let n = 0; n < 900; n++) {
        t += LIGHT_CARD.dt;
        advance(s, t);
        const env = simEnvelope(s);
        if (env.phase !== "ready") continue;
        for (let i = 0; i < s.particles.count; i++) {
          if (glowAlpha(s, env, i) <= 0) continue;
          const inside =
            Math.abs(s.particles.x[i]! - mid) < g.half &&
            Math.abs(s.particles.y[i]! - mid) < g.half;
          expect(inside).toBe(false);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(1000);
    }
  });

  it("breaks into light for a new code and condenses into it", () => {
    const s = sim();
    runTo(s, 6);
    const other = qrOf(golden.rows.map((r) => [...r].reverse().join("")));
    expect(newCode(s, other)).toBe(true);
    expect(newCode(s, other)).toBe(false);
    runTo(s, 6.2);
    expect(simEnvelope(s).phase).toBe("refreshing");
    runTo(s, 11);
    const env = simEnvelope(s);
    expect(env.phase).toBe("ready");
    const g = shownGeometry(s, env);
    expect(g).toEqual(cardGeometry(other));
    const p = s.particles;
    for (let i = 0; i < g.lights.length / 3; i++)
      expect(
        Math.hypot(p.x[i]! - g.lights[i * 3]!, p.y[i]! - g.lights[i * 3 + 1]!),
      ).toBeLessThan(0.5);
  });

  it("collapses into a check when the other device connects", () => {
    const s = sim(7, 1350);
    expect(connect(s)).toBe(false); // still forming
    runTo(s, 6);
    expect(connect(s)).toBe(true);
    runTo(s, 10);
    const env = simEnvelope(s);
    expect(env).toMatchObject({ phase: "connected", check: 1, cardOpacity: 0 });
    const pts = checkPoints(LIGHT_CARD.particles.check);
    const p = s.particles;
    for (let i = 0; i < pts.length; i++)
      expect(
        Math.hypot(p.x[i]! - pts[i]![0], p.y[i]! - pts[i]![1]),
      ).toBeLessThan(1);
  });

  it("slows and dims when the code runs out", () => {
    const s = sim();
    runTo(s, 6);
    expect(expire(s)).toBe(true);
    runTo(s, 9);
    expect(simEnvelope(s)).toMatchObject({
      phase: "expired",
      orbit: LIGHT_CARD.orbit.expired,
      dim: LIGHT_CARD.dim.expired,
      frameRate: LIGHT_CARD.idleFps,
    });
  });

  it("skips a long gap and carries on after a pause", () => {
    const s = sim();
    expect(advance(s, 1000 + 60)).toBe(LIGHT_CARD.maxSteps);
    expect(s.t).toBeCloseTo(60, 6);
    const t = s.t;
    resume(s, 5000);
    expect(advance(s, 5000 + LIGHT_CARD.dt * 2.01)).toBe(2);
    expect(s.t).toBeCloseTo(t + LIGHT_CARD.dt * 2, 9);
  });
});
