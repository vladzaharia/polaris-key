// The Light Card (UK-67): how a pairing QR is presented. A nebula of light particles condenses into
// the paper of a real, scannable QR code; the dark modules left on the paper are the code. This
// module is the one source of the choreography every kit ports (docs/design/UI-KITS.md "Light Card"):
//
//   LIGHT_CARD            the spec constants (durations, spring, counts, colours, margin, idle drop)
//   createRng             mulberry32, written out so a port reproduces it bit for bit
//   createTimeline,       the state machine: forming, ready, refreshing, connected, expired, driven
//   dispatchTimeline,     by an injected time, yielding the envelope each frame is drawn from
//   envelopeAt
//   cardGeometry          the QR of `encodeQr` as targets (paper cells), round dots, finders, star
//   stepParticles         one fixed-dt step of the particle physics over typed arrays
//   createLightCardSim    the whole run: particles + timeline + geometry, advanced by `advance(now)`
//
// Pure: no DOM, no wall clock (the caller passes `now` in seconds), no Math.random. The envelope and
// the geometry are exact for every kit and are pinned by test/fixtures/lightCard.golden.json;
// particle positions are decorative (they depend on the platform's sin/exp) and are pinned in the
// JS test only.
//
// Everything is in the study's 440-unit stage space with the card centred; a renderer scales by
// side / LIGHT_CARD.stage.

// ── The spec ────────────────────────────────────────────────────────────────────────────────────

export const LIGHT_CARD = {
  /** The reference stage, in units; a renderer scales by side / stage. */
  stage: 440,
  /** The card's side as a share of the stage. */
  cardShare: 0.5,
  /** The QR: error-correction level Q, a 2-module quiet zone, a star over the centre. */
  ecLevel: "Q",
  quietModules: 2,
  /** Modules (from the centre) cleared for the Polaris star. */
  clearRadius: 3.2,
  /** Springs into the paper cells: underdamped. */
  spring: { k: 82, c: 10.4 },
  /** The fixed step of the particle physics, in seconds. */
  dt: 1 / 60,
  /** The most steps one `advance` takes; a longer gap is skipped, not replayed. */
  maxSteps: 8,
  /** Particles: one per paper cell (and 10 % over) as the card's, and the ambient light, 650 on
   *  the 440-unit stage, scaled by the stage's area within the bounds; the connect check and
   *  halo take their points from the same pool. */
  particles: {
    ambientAtReference: 650,
    ambientMin: 300,
    ambientMax: 900,
    cardSlack: 1.1,
    check: 150,
    halo: 320,
  },
  /** Seconds. */
  durations: {
    /** Condensing starts after this; the first cells land at `landStart`. */
    formDelay: 0.5,
    landStart: 0.65,
    landEnd: 2.35,
    /** The card is readable from here (about 2.5 s after the first frame). */
    formEnd: 2.4,
    /** A new code: the card breaks into light, then re-condenses (skipping the first `refreshSkip` of the forming curve). */
    break: 0.45,
    refreshSkip: 0.6,
    /** Connected: the vortex collapses for `vortex`, the check forms over `check`, the screen is done after `connectedEnd`. */
    vortex: 0.85,
    check: 0.9,
    connectedEnd: 1.75,
    cardDissolve: 0.4,
    /** Expired: the orbit slows and the card dims. */
    expireOrbit: 1.2,
    expireDim: 1,
  },
  /** Orbit (swirl) multipliers. */
  orbit: { normal: 1, vortex: 2.2, settled: 0.6, expired: 0.25 },
  dim: { expired: 0.35 },
  /** An expired code fades its dark modules toward the paper so the dead code does not scan. */
  inkExpired: 0.15,
  /** The glow multiplier of the ambient light after a connect. */
  ambientConnected: 0.55,
  /** The card is never smaller than this many px on screen (12 rem at the root size), however small
   *  the stage: a share of the stage above `cardShare` where the stage is narrow. */
  cardFloorPx: 192,
  /** After the idle drop the ambient light thins to this share of its particles. */
  idleDensity: 0.5,
  /** After this long waiting the orbit drops to `idleFps`. */
  idleDropSeconds: 10,
  fullFps: 60,
  idleFps: 30,
  /** Wisps fade out over this many units outside the card margin; none cross the margin. */
  margin: { cells: 1.5, fade: 12 },
  /** Colour roles: the stage is a night stage in both themes; the glow tints are violet (the brand's
   *  violet on dark), lavender, ice and white. */
  colors: {
    night: "#05060d",
    ink: "#160c30",
    paperTop: "#ffffff",
    paperBottom: "#f3eeff",
    finderGap: "#fbf9ff",
    cardGlow: "rgba(160, 110, 255, 0.55)",
    tints: ["#9a5cff", "#c4aaff", "#b0ccff", "#fff6ff"],
    /** The glow's white core and the connect flare's. */
    core: "#ffffff",
    flareCore: "#fffaff",
  },
  /** The ink dot as a share of a cell, the paper corner as a share of the card. */
  dotRadius: 0.43,
  cornerShare: 0.08,
  /** The check of light, in card-half units, and its size. */
  check: {
    path: [
      [-0.42, 0.02],
      [-0.12, 0.32],
      [0.46, -0.3],
    ],
    radius: 0.2,
    haloRadius: 0.27,
  },
} as const;

export type Phase =
  | "forming"
  | "ready"
  | "refreshing"
  | "connected"
  | "expired";
export type LightCardEvent = "newCode" | "connected" | "expired";

/** `#rrggbb` as a CSS `rgba()` at `alpha`: the colour roles stay hex here and in the docs. */
export function rgbaOf(hex: string, alpha = 1): string {
  const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
  return `rgba(${n(1)},${n(3)},${n(5)},${alpha})`;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smoothstep. */
export const smooth = (v: number): number => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const mix = (a: number, b: number, k: number): number => a + (b - a) * k;

// ── The PRNG ────────────────────────────────────────────────────────────────────────────────────

/** mulberry32: 32-bit state, `next()` in [0, 1). The seed is taken as an unsigned 32-bit integer. */
export interface Rng {
  next(): number;
}
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

// ── The timeline ────────────────────────────────────────────────────────────────────────────────

/** What a frame is drawn from. All values are 0..1 unless noted. */
export interface Envelope {
  phase: Phase;
  /** Seconds in this phase. */
  age: number;
  /** The share of card particles that have landed in their cells. */
  landed: number;
  /** The paper and ink's opacity (before `dim`). */
  cardOpacity: number;
  /** The orbit (swirl) multiplier, 0..2.2. */
  orbit: number;
  /** The dim level of the card and the light: 1 normally, 0.35 expired. */
  dim: number;
  /** The opacity of the dark modules on the paper: 1, fading to `inkExpired` when expired. */
  ink: number;
  /** The share of the check of light formed. */
  check: number;
  /** The centre flare. */
  flare: number;
  /** The glow multiplier of the ambient light. */
  ambient: number;
  /** The share of the ambient particles drawn: 1, thinning to `idleDensity` after the idle drop. */
  density: number;
  /** After a new code's break the paper shows the new code. */
  swapped: boolean;
  /** 60, or 30 once the orbit has been waiting 10 s (and while expired). */
  frameRate: number;
}

type Base = Pick<
  Envelope,
  "landed" | "cardOpacity" | "orbit" | "dim" | "ambient" | "ink"
>;

export interface Timeline {
  readonly phase: Phase;
  /** When the phase began, in the injected clock's seconds. */
  readonly since: number;
  /** The values the phase started from, for a continuous change. */
  readonly from: Base;
  /** The code the paper shows: 0 or 1, flipped by a new code at its break. */
  readonly code: number;
  /** When the orbit began waiting (the idle drop counts from here); null when it is not waiting. */
  readonly waitingSince: number | null;
}

const REST: Base = {
  landed: 1,
  cardOpacity: 1,
  orbit: 1,
  dim: 1,
  ambient: 1,
  ink: 1,
};
const NONE: Base = {
  landed: 0,
  cardOpacity: 0,
  orbit: 1,
  dim: 1,
  ambient: 1,
  ink: 1,
};

export function createTimeline(now: number): Timeline {
  return {
    phase: "forming",
    since: now,
    from: NONE,
    code: 0,
    waitingSince: null,
  };
}

/** The forming curve at `tau` seconds. */
function forming(tau: number): { landed: number; cardOpacity: number } {
  const d = LIGHT_CARD.durations;
  const landed = smooth((tau - d.landStart) / (d.landEnd - d.landStart));
  return { landed, cardOpacity: smooth((landed - 0.8) / 0.2) };
}

/** The phase the timeline is in at `now` once its automatic steps are taken (forming and
 *  refreshing end in ready). */
export function settleTimeline(tl: Timeline, now: number): Timeline {
  const d = LIGHT_CARD.durations;
  const tau = now - tl.since;
  if (tl.phase === "forming" && tau >= d.formEnd)
    return {
      ...tl,
      phase: "ready",
      since: tl.since + d.formEnd,
      from: REST,
      waitingSince: tl.since + d.formEnd,
    };
  if (tl.phase === "refreshing") {
    const end = d.break + (d.formEnd - d.refreshSkip);
    if (tau >= end)
      return {
        ...tl,
        phase: "ready",
        since: tl.since + end,
        from: REST,
        code: tl.code,
        waitingSince: tl.since + end,
      };
  }
  return tl;
}

/** The envelope at `now` (settles first, so `phase` is the phase in force). */
export function envelopeAt(timeline: Timeline, now: number): Envelope {
  const tl = settleTimeline(timeline, now);
  const d = LIGHT_CARD.durations;
  const o = LIGHT_CARD.orbit;
  const tau = Math.max(0, now - tl.since);
  const f = tl.from;
  const e: Envelope = {
    phase: tl.phase,
    age: tau,
    landed: 1,
    cardOpacity: 1,
    orbit: 1,
    dim: 1,
    ink: 1,
    check: 0,
    flare: 0,
    ambient: 1,
    density: 1,
    swapped: false,
    frameRate: LIGHT_CARD.fullFps,
  };
  switch (tl.phase) {
    case "forming": {
      Object.assign(e, forming(tau));
      break;
    }
    case "ready": {
      // Settled; coming from a break or an expiry the orbit and dim finish their return.
      break;
    }
    case "refreshing": {
      e.swapped = tau >= d.break;
      if (!e.swapped) {
        const k = smooth(tau / d.break);
        e.landed = f.landed * (1 - k);
        e.cardOpacity = f.cardOpacity * (1 - smooth(tau / (d.break * 0.67)));
      } else {
        Object.assign(e, forming(tau - d.break + d.refreshSkip));
      }
      e.dim = mix(f.dim, 1, smooth(tau / d.break));
      e.ink = mix(f.ink, 1, smooth(tau / d.break));
      e.orbit = mix(f.orbit, o.normal, smooth(tau / 0.8));
      break;
    }
    case "connected": {
      const k = smooth(tau / d.cardDissolve);
      e.landed = f.landed * (1 - k);
      e.cardOpacity = f.cardOpacity * (1 - k);
      e.check = smooth((tau - d.vortex) / d.check);
      e.flare = tau >= d.vortex ? Math.exp(-2.120264 * (tau - d.vortex)) : 0;
      e.orbit =
        tau < d.vortex
          ? mix(f.orbit, o.vortex, smooth(tau / 0.5))
          : mix(o.vortex, o.settled, smooth((tau - d.vortex) / 0.4));
      e.ambient = tau >= d.connectedEnd ? LIGHT_CARD.ambientConnected : 1;
      break;
    }
    case "expired": {
      e.dim = mix(f.dim, LIGHT_CARD.dim.expired, smooth(tau / d.expireDim));
      e.ink = mix(f.ink, LIGHT_CARD.inkExpired, smooth(tau / d.expireDim));
      e.orbit = mix(f.orbit, o.expired, smooth(tau / d.expireOrbit));
      e.frameRate = LIGHT_CARD.idleFps;
      break;
    }
  }
  if (tl.phase === "ready") {
    const idle =
      tl.waitingSince !== null &&
      now - tl.waitingSince >= LIGHT_CARD.idleDropSeconds;
    e.dim = mix(f.dim, 1, smooth(tau / d.break));
    e.orbit = mix(f.orbit, o.normal, smooth(tau / 0.8));
    if (idle) e.frameRate = LIGHT_CARD.idleFps;
    if (tl.waitingSince !== null)
      e.density = mix(
        1,
        LIGHT_CARD.idleDensity,
        smooth((now - tl.waitingSince - LIGHT_CARD.idleDropSeconds) / 1.5),
      );
  }
  return e;
}

/** An event at `now`. New code is taken from ready or expired, connected and expired from ready;
 *  anything else leaves the timeline as it was. */
export function dispatchTimeline(
  timeline: Timeline,
  event: LightCardEvent,
  now: number,
): Timeline {
  const tl = settleTimeline(timeline, now);
  const e = envelopeAt(tl, now);
  const from: Base = {
    landed: e.landed,
    cardOpacity: e.cardOpacity,
    orbit: e.orbit,
    dim: e.dim,
    ambient: e.ambient,
    ink: e.ink,
  };
  if (event === "newCode" && (tl.phase === "ready" || tl.phase === "expired"))
    return {
      phase: "refreshing",
      since: now,
      from,
      code: tl.code ^ 1,
      waitingSince: null,
    };
  if (event === "connected" && tl.phase === "ready")
    return {
      phase: "connected",
      since: now,
      from,
      code: tl.code,
      waitingSince: null,
    };
  if (event === "expired" && tl.phase === "ready")
    return {
      phase: "expired",
      since: now,
      from,
      code: tl.code,
      waitingSince: null,
    };
  return tl;
}

/** The finished card a Reduce Motion renderer draws: no trails, no swirl, no orbit. */
export function reducedEnvelope(phase: Phase): Envelope {
  const e = envelopeAt(
    { phase: "ready", since: 0, from: REST, code: 0, waitingSince: null },
    0,
  );
  e.phase = phase;
  if (phase === "expired") {
    e.dim = LIGHT_CARD.dim.expired;
    e.ink = LIGHT_CARD.inkExpired;
  }
  if (phase === "connected") {
    e.landed = 0;
    e.cardOpacity = 0;
    e.check = 1;
    e.ambient = LIGHT_CARD.ambientConnected;
  }
  e.orbit = 0;
  return e;
}

// ── The QR geometry ─────────────────────────────────────────────────────────────────────────────

/** A QR symbol as `encodeQr` returns it: `size` x `size` modules, row-major, 1 = dark. */
export interface QrMatrix {
  readonly size: number;
  readonly modules: ArrayLike<number>;
}

export interface CardGeometry {
  /** Modules per side. */
  n: number;
  /** One cell, in stage units (the card is (n + 2 * quiet) cells wide). */
  cell: number;
  /** The card's top-left and side. */
  x0: number;
  y0: number;
  side: number;
  /** The paper's corner radius. */
  radius: number;
  /** The light cells (the targets), nearest the centre first: x, y, distance (0..1) per cell. */
  lights: Float64Array;
  /** The dark modules drawn as round dots: x, y per dot. */
  darks: Float64Array;
  /** The ink dot's radius. */
  dotRadius: number;
  /** The three finder squares' top-left corners (x, y) and their side (7 cells). */
  finders: readonly [number, number][];
  finderSide: number;
  /** The Polaris star: 8 points (x, y) around the centre. */
  star: readonly [number, number][];
  /** The keep-out: half the width of the box no visible wisp enters (card + 1.5 cells). */
  half: number;
}

const finderCell = (n: number, r: number, c: number): boolean =>
  (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

/** The card for `qr`, centred on the stage. The same input always gives the same geometry. */
export function cardGeometry(
  qr: QrMatrix,
  share: number = LIGHT_CARD.cardShare,
): CardGeometry {
  const n = qr.size;
  const stage = LIGHT_CARD.stage;
  const quiet = LIGHT_CARD.quietModules;
  const side = stage * share;
  const cell = side / (n + quiet * 2);
  const cx = stage / 2;
  const x0 = cx - side / 2;
  const y0 = cx - side / 2;
  const mid = (n - 1) / 2;
  const lights: number[][] = [];
  const darks: number[] = [];
  for (let r = -quiet; r < n + quiet; r++)
    for (let c = -quiet; c < n + quiet; c++) {
      const inside = r >= 0 && c >= 0 && r < n && c < n;
      const x = x0 + cell * (c + quiet + 0.5);
      const y = y0 + cell * (r + quiet + 0.5);
      const cleared =
        inside && Math.hypot(r - mid, c - mid) < LIGHT_CARD.clearRadius;
      const dark = inside && qr.modules[r * n + c] === 1 && !cleared;
      if (dark) {
        if (!finderCell(n, r, c)) darks.push(x, y);
      } else if (!(inside && finderCell(n, r, c)))
        lights.push([x, y, Math.hypot(x - cx, y - cx) / (side * 0.71)]);
    }
  // A stable order: nearest first, ties in scan order.
  const order = lights
    .map((l, i) => i)
    .sort((a, b) => lights[a]![2]! - lights[b]![2]! || a - b);
  const sorted = new Float64Array(lights.length * 3);
  order.forEach((i, k) => sorted.set(lights[i]!, k * 3));
  const R = cell * 2.6;
  const star: [number, number][] = (
    [
      [0, -R],
      [R * 0.22, -R * 0.22],
      [R * 0.72, 0],
      [R * 0.22, R * 0.22],
      [0, R],
      [-R * 0.22, R * 0.22],
      [-R * 0.72, 0],
      [-R * 0.22, -R * 0.22],
    ] as const
  ).map(([dx, dy]) => [cx + dx, cx + dy]);
  const fx = (q: number): number => x0 + cell * (q + quiet);
  return {
    n,
    cell,
    x0,
    y0,
    side,
    radius: side * LIGHT_CARD.cornerShare,
    lights: sorted,
    darks: Float64Array.from(darks),
    dotRadius: cell * LIGHT_CARD.dotRadius,
    finders: [
      [fx(0), fx(0)],
      [fx(n - 7), fx(0)],
      [fx(0), fx(n - 7)],
    ],
    finderSide: cell * 7,
    star,
    half: side / 2 + cell * LIGHT_CARD.margin.cells,
  };
}

/** The card's share of the stage for a stage `stagePx` wide: half, or more where half would be
 *  under `cardFloorPx` (never over 0.8, so the light keeps room to orbit). */
export function cardShareFor(
  stagePx: number,
  floorPx: number = LIGHT_CARD.cardFloorPx,
): number {
  if (!(stagePx > 0)) return LIGHT_CARD.cardShare;
  return Math.min(0.8, Math.max(LIGHT_CARD.cardShare, floorPx / stagePx));
}

/** The glow colours: Polaris violet by default, the product's accent (`#rrggbb`) when the theme has
 *  one. The ink and the paper never change, so the code stays dark on light whatever the accent. */
export function lightCardColors(accent?: string | null): {
  tints: readonly string[];
  cardGlow: string;
} {
  if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent))
    return {
      tints: LIGHT_CARD.colors.tints,
      cardGlow: LIGHT_CARD.colors.cardGlow,
    };
  const a = accent.toLowerCase();
  return {
    tints: [
      a,
      mixHex(a, "#ffffff", 0.45),
      mixHex(a, LIGHT_CARD.colors.tints[2]!, 0.5),
      LIGHT_CARD.colors.tints[3]!,
    ],
    cardGlow: rgbaOf(a, 0.55),
  };
}

/** `a` toward `b` by `k`, per channel, as `#rrggbb`. */
export function mixHex(a: string, b: string, k: number): string {
  const ch = (h: string, i: number): number => parseInt(h.slice(i, i + 2), 16);
  const out = [1, 3, 5].map((i) =>
    Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${out.join("")}`;
}

/** The check of light: `count` points along the tick, centred on the stage. */
export function checkPoints(count: number): [number, number][] {
  const c = LIGHT_CARD.check;
  const R = LIGHT_CARD.stage * c.radius;
  const mid = LIGHT_CARD.stage / 2;
  const [a, b, d] = c.path;
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const l2 = Math.hypot(d[0] - b[0], d[1] - b[1]);
  const out: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const at = (k / (count - 1)) * (l1 + l2);
    const [p, q, len, off] = at <= l1 ? [a, b, l1, 0] : [b, d, l2, l1];
    const f = (at - off) / len;
    out.push([
      mid + R * (p[0] + (q[0] - p[0]) * f),
      mid + R * (p[1] + (q[1] - p[1]) * f),
    ]);
  }
  return out;
}

/** The particle count for a stage `side` units wide and a card of `cells` paper cells. */
export function particleCount(side: number, cells: number): number {
  const p = LIGHT_CARD.particles;
  const k = (side / LIGHT_CARD.stage) ** 2;
  const ambient = Math.max(
    p.ambientMin,
    Math.min(p.ambientMax, Math.round(p.ambientAtReference * k)),
  );
  return Math.ceil(cells * p.cardSlack) + ambient;
}

/** How visible a wisp at (x, y) is once the card has formed: 0 at and inside the margin box,
 *  rising to 1 over `fade` units outside it. */
export function wispVisibility(
  x: number,
  y: number,
  geometry: CardGeometry,
  cardOpacity: number,
): number {
  if (cardOpacity <= 0.01) return 1;
  const mid = LIGHT_CARD.stage / 2;
  const ox = Math.max(Math.abs(x - mid) - geometry.half, 0);
  const oy = Math.max(Math.abs(y - mid) - geometry.half, 0);
  const v = clamp01(Math.hypot(ox, oy) / LIGHT_CARD.margin.fade);
  return 1 - cardOpacity * (1 - v);
}

// ── The particles ───────────────────────────────────────────────────────────────────────────────

export const ROLE = { ambient: 0, card: 1, check: 2, halo: 3 } as const;

/** Struct of arrays; one index is one particle. */
export interface Particles {
  readonly count: number;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  /** The target (a paper cell or a point of the check). */
  tx: Float64Array;
  ty: Float64Array;
  /** 1 = free (flow and swirl), 0 = on its spring; it eases to `free_to` from `at` on, at `rate`. */
  free: Float64Array;
  freeTo: Float64Array;
  at: Float64Array;
  rate: Float64Array;
  /** The radius of its orbit when free. */
  orbit: Float64Array;
  size: Float64Array;
  alpha: Float64Array;
  phase: Float64Array;
  tint: Uint8Array;
  role: Uint8Array;
}

export function spawnParticles(count: number, rng: Rng): Particles {
  const S = LIGHT_CARD.stage;
  const mk = () => new Float64Array(count);
  const p: Particles = {
    count,
    x: mk(),
    y: mk(),
    vx: mk(),
    vy: mk(),
    tx: mk(),
    ty: mk(),
    free: mk(),
    freeTo: mk(),
    at: mk(),
    rate: mk(),
    orbit: mk(),
    size: mk(),
    alpha: mk(),
    phase: mk(),
    tint: new Uint8Array(count),
    role: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const a = rng.next() * 6.283;
    const r = (0.08 + 0.36 * Math.sqrt(rng.next())) * S;
    p.x[i] = S / 2 + Math.cos(a) * r;
    p.y[i] = S / 2 + Math.sin(a) * r;
    p.tx[i] = S / 2;
    p.ty[i] = S / 2;
    p.free[i] = 1;
    p.freeTo[i] = 1;
    p.rate[i] = 2.6;
    p.orbit[i] = r;
    p.tint[i] = (rng.next() * 4) | 0;
    p.size[i] = 2.2 + rng.next() * 3.2;
    p.alpha[i] = 0.55 + rng.next() * 0.45;
    p.phase[i] = rng.next() * 6.283;
  }
  return p;
}

/** A cheap divergence-free flow: the curl of a sum of waves. */
function flow(x: number, y: number, t: number, out: Float64Array): void {
  const n = (X: number, Y: number): number =>
    Math.sin(X * 1.7 + t * 0.55) * Math.cos(Y * 1.3 - t * 0.4) +
    0.6 * Math.sin(X * 0.8 - Y * 1.1 + t * 0.9);
  const e = 0.35;
  out[0] = (n(x, y + e) - n(x, y - e)) / (2 * e);
  out[1] = -(n(x + e, y) - n(x - e, y)) / (2 * e);
}

const FLOW = new Float64Array(2);

/** One fixed step (`dt`) of every particle at sim time `t` with swirl `sw`. */
export function stepParticles(
  p: Particles,
  t: number,
  dt: number,
  sw: number,
): void {
  const S = LIGHT_CARD.stage;
  const cx = S / 2;
  const { k, c } = LIGHT_CARD.spring;
  const vmax = 900;
  for (let i = 0; i < p.count; i++) {
    if (t >= p.at[i]!) {
      const d = p.freeTo[i]! - p.free[i]!;
      p.free[i] =
        p.free[i]! + Math.sign(d) * Math.min(Math.abs(d), dt * p.rate[i]!);
    }
    const f = p.free[i]!;
    let ax = 0;
    let ay = 0;
    if (f > 0) {
      const dx = p.x[i]! - cx;
      const dy = p.y[i]! - cx;
      const r = Math.hypot(dx, dy) + 1e-3;
      const tang = (sw * 120) / (1 + r / (S * 0.3));
      ax += (-dy / r) * tang * 1.6;
      ay += (dx / r) * tang * 1.6;
      ax += (p.orbit[i]! - r) * (dx / r) * 2.4;
      ay += (p.orbit[i]! - r) * (dy / r) * 2.4;
      flow(p.x[i]! / 70, p.y[i]! / 70, t, FLOW);
      ax += FLOW[0]! * 70 * sw;
      ay += FLOW[1]! * 70 * sw;
      ax *= f;
      ay *= f;
    }
    if (f < 1) {
      const g = 1 - f;
      ax += g * (k * (p.tx[i]! - p.x[i]!) - c * p.vx[i]!);
      ay += g * (k * (p.ty[i]! - p.y[i]!) - c * p.vy[i]!);
    }
    const damp = Math.exp(-(f * 0.9) * dt);
    let vx = (p.vx[i]! + ax * dt) * damp;
    let vy = (p.vy[i]! + ay * dt) * damp;
    const sp = Math.hypot(vx, vy);
    if (sp > vmax) {
      vx *= vmax / sp;
      vy *= vmax / sp;
    }
    p.vx[i] = vx;
    p.vy[i] = vy;
    p.x[i] = p.x[i]! + vx * dt;
    p.y[i] = p.y[i]! + vy * dt;
  }
}

/** Push every light that is not the card's out of the margin box, with its velocity turned
 *  outward: no wisp ever crosses the card's margin. */
export function keepOut(p: Particles, geometry: CardGeometry): void {
  const mid = LIGHT_CARD.stage / 2;
  const h = geometry.half;
  for (let i = 0; i < p.count; i++) {
    if (p.role[i] === ROLE.card) continue;
    const dx = p.x[i]! - mid;
    const dy = p.y[i]! - mid;
    if (Math.abs(dx) >= h || Math.abs(dy) >= h) continue;
    // Out through the nearest side.
    const rx = h - Math.abs(dx);
    const ry = h - Math.abs(dy);
    if (rx <= ry) {
      const s = dx < 0 ? -1 : 1;
      p.x[i] = mid + s * h;
      p.vx[i] = s * Math.abs(p.vx[i]!);
    } else {
      const s = dy < 0 ? -1 : 1;
      p.y[i] = mid + s * h;
      p.vy[i] = s * Math.abs(p.vy[i]!);
    }
  }
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

type Pending = { at: number; kind: "swap" | "check"; qr?: QrMatrix } | null;

export interface LightCardSim {
  readonly particles: Particles;
  readonly rng: Rng;
  /** The injected clock's reading at sim time 0. */
  origin: number;
  /** Sim seconds: a whole number of `dt` steps. */
  t: number;
  timeline: Timeline;
  codes: [CardGeometry, CardGeometry];
  /** The card's share of the stage, for every code this run shows. */
  share: number;
  pending: Pending;
}

/** Condense the first `lights.length` particles onto the paper cells (centre first). */
function condense(
  sim: LightCardSim,
  geometry: CardGeometry,
  start: number,
  base: number,
): void {
  const p = sim.particles;
  const L = geometry.lights;
  const cells = L.length / 3;
  for (let i = 0; i < p.count; i++) {
    if (i < cells) {
      p.role[i] = ROLE.card;
      p.tx[i] = L[i * 3]!;
      p.ty[i] = L[i * 3 + 1]!;
      p.freeTo[i] = 0;
      p.at[i] = start + base + L[i * 3 + 2]! * 0.55 + sim.rng.next() * 0.1;
      p.rate[i] = 3;
      p.tint[i] = 3;
    } else {
      p.role[i] = ROLE.ambient;
      p.freeTo[i] = 1;
      p.orbit[i] = (0.4 + 0.09 * sim.rng.next()) * LIGHT_CARD.stage;
      const r = sim.rng.next();
      p.tint[i] = r < 0.6 ? 0 : r < 0.8 ? 1 : 2;
    }
  }
}

/** A run that starts forming at `now`; `qr` is the code the paper shows first. */
export function createLightCardSim(o: {
  qr: QrMatrix;
  seed: number;
  now: number;
  /** The stage's side in pixels (for the particle count); the reference stage when absent. */
  side?: number;
  /** The particle count, when a test fixes it. */
  count?: number;
  /** The card's share of the stage (`cardShareFor`); half when absent. */
  share?: number;
  /** Start ready: the card is formed and the light already orbits (a view the person comes back
   *  to in the same window shows its card at once). */
  settled?: boolean;
}): LightCardSim {
  const rng = createRng(o.seed);
  const share = o.share ?? LIGHT_CARD.cardShare;
  const g = cardGeometry(o.qr, share);
  const sim: LightCardSim = {
    particles: spawnParticles(
      o.count ?? particleCount(o.side ?? LIGHT_CARD.stage, g.lights.length / 3),
      rng,
    ),
    rng,
    origin: o.now,
    t: 0,
    timeline: createTimeline(0),
    codes: [g, g],
    share,
    pending: null,
  };
  condense(sim, g, LIGHT_CARD.durations.formDelay, 0.15);
  if (o.settled) {
    // Land every mote on its cell and begin in ready.
    const p = sim.particles;
    for (let i = 0; i < p.count; i++)
      if (p.role[i] === ROLE.card) {
        p.x[i] = p.tx[i]!;
        p.y[i] = p.ty[i]!;
        p.free[i] = 0;
        p.freeTo[i] = 0;
        p.at[i] = 0;
      }
    sim.timeline = {
      phase: "ready",
      since: 0,
      from: REST,
      code: 0,
      waitingSince: 0,
    };
  }
  return sim;
}

/** The geometry of the code the paper shows now. */
export function shownGeometry(
  sim: LightCardSim,
  env: Envelope = envelopeAt(sim.timeline, sim.t),
): CardGeometry {
  const tl = settleTimeline(sim.timeline, sim.t);
  const code =
    tl.phase === "refreshing" && !env.swapped ? tl.code ^ 1 : tl.code;
  return sim.codes[code]!;
}

/** The envelope now. */
export function simEnvelope(sim: LightCardSim): Envelope {
  return envelopeAt(sim.timeline, sim.t);
}

function stepOnce(sim: LightCardSim): void {
  const t = sim.t + LIGHT_CARD.dt;
  sim.t = t;
  const tl = (sim.timeline = settleTimeline(sim.timeline, t));
  const pend = sim.pending;
  if (pend && t >= pend.at) {
    sim.pending = null;
    if (pend.kind === "swap") condense(sim, sim.codes[tl.code]!, t, 0.05);
    else connectCheck(sim, t);
  }
  const env = envelopeAt(tl, t);
  stepParticles(sim.particles, t, LIGHT_CARD.dt, env.orbit);
  if (env.cardOpacity > 0.01) keepOut(sim.particles, shownGeometry(sim, env));
}

/** Advance to `now` (the injected clock) in whole fixed steps; a gap longer than `maxSteps` is
 *  skipped, not replayed. Returns the steps taken. */
export function advance(sim: LightCardSim, now: number): number {
  const target = now - sim.origin;
  let steps = 0;
  while (sim.t + LIGHT_CARD.dt <= target + 1e-9) {
    if (steps >= LIGHT_CARD.maxSteps) {
      sim.t = Math.floor(target / LIGHT_CARD.dt) * LIGHT_CARD.dt;
      break;
    }
    stepOnce(sim);
    steps++;
  }
  return steps;
}

/** After a pause (the page hidden, the stage off-screen) carry on from where the run stopped. */
export function resume(sim: LightCardSim, now: number): void {
  sim.origin = now - sim.t;
}

/** Show a new code: the card breaks back into light and re-condenses. */
export function newCode(sim: LightCardSim, qr: QrMatrix): boolean {
  const tl = dispatchTimeline(sim.timeline, "newCode", sim.t);
  if (tl === sim.timeline) return false;
  sim.timeline = tl;
  sim.codes[tl.code] = cardGeometry(qr, sim.share);
  const p = sim.particles;
  const mid = LIGHT_CARD.stage / 2;
  for (let i = 0; i < p.count; i++)
    if (p.role[i] === ROLE.card) {
      p.free[i] = 0.85;
      p.freeTo[i] = 1;
      p.at[i] = sim.t;
      p.vx[i] = p.vx[i]! + (sim.rng.next() - 0.5) * 160;
      p.vy[i] = p.vy[i]! + (sim.rng.next() - 0.5) * 160;
      p.orbit[i] = Math.hypot(p.x[i]! - mid, p.y[i]! - mid);
    }
  sim.pending = { at: sim.t + LIGHT_CARD.durations.break, kind: "swap" };
  return true;
}

/** The other device connected: a vortex collapses into a check of light. */
export function connect(sim: LightCardSim): boolean {
  const tl = dispatchTimeline(sim.timeline, "connected", sim.t);
  if (tl === sim.timeline) return false;
  sim.timeline = tl;
  const p = sim.particles;
  for (let i = 0; i < p.count; i++) {
    p.freeTo[i] = 1;
    p.free[i] = Math.max(p.free[i]!, 0.7);
    p.at[i] = sim.t;
    p.orbit[i] = (0.02 + 0.05 * sim.rng.next()) * LIGHT_CARD.stage;
    p.rate[i] = 3;
    if (p.role[i] === ROLE.card) p.role[i] = ROLE.ambient;
  }
  sim.pending = { at: sim.t + LIGHT_CARD.durations.vortex, kind: "check" };
  return true;
}

function connectCheck(sim: LightCardSim, t: number): void {
  const p = sim.particles;
  const S = LIGHT_CARD.stage;
  const c = LIGHT_CARD.particles;
  const pts = checkPoints(c.check);
  const R = S * LIGHT_CARD.check.haloRadius;
  for (let i = 0; i < p.count; i++) {
    if (i < c.check) {
      p.role[i] = ROLE.check;
      p.tx[i] = pts[i]![0];
      p.ty[i] = pts[i]![1];
      p.freeTo[i] = 0;
      p.at[i] = t + (i / c.check) * 0.35;
      p.tint[i] = 3;
    } else if (i < c.check + c.halo) {
      const a = ((i - c.check) / c.halo) * 6.283;
      p.role[i] = ROLE.halo;
      p.tx[i] = S / 2 + Math.cos(a) * R;
      p.ty[i] = S / 2 + Math.sin(a) * R;
      p.freeTo[i] = 0;
      p.at[i] = t + 0.15 + ((i - c.check) / c.halo) * 0.4;
      p.tint[i] = i % 3;
    } else {
      p.role[i] = ROLE.ambient;
      p.freeTo[i] = 1;
      p.orbit[i] = (0.38 + 0.1 * sim.rng.next()) * S;
    }
  }
}

/** The code ran out: the orbit slows and the card dims. */
export function expire(sim: LightCardSim): boolean {
  const tl = dispatchTimeline(sim.timeline, "expired", sim.t);
  if (tl === sim.timeline) return false;
  sim.timeline = tl;
  return true;
}

/** One ambient particle's share of the thinning: each has a fixed rank in [0, 0.85) and drops out
 *  as the density falls below it. */
export function rankFade(i: number, density: number): number {
  const rank = ((i * 0.6180339887498949) % 1) * 0.85;
  return clamp01((density - rank) / 0.15);
}

/** How bright particle `i` is drawn now (0 when it is not drawn): its own alpha, the phase's glow
 *  multiplier and, for the light outside the card, the margin fade. */
export function glowAlpha(
  sim: LightCardSim,
  env: Envelope,
  i: number,
  geometry: CardGeometry = shownGeometry(sim, env),
): number {
  const p = sim.particles;
  const base = p.alpha[i]!;
  switch (p.role[i]) {
    case ROLE.card:
      return Math.min(1, base * (1 - env.cardOpacity) * env.dim);
    case ROLE.ambient:
      return Math.min(
        1,
        base *
          env.dim *
          env.ambient *
          rankFade(i, env.density) *
          wispVisibility(p.x[i]!, p.y[i]!, geometry, env.cardOpacity),
      );
    default:
      return Math.min(1, base);
  }
}
