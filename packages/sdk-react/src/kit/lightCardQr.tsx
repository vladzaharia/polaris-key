"use client";
// The Light Card (UK-67.1): the pairing QR as a card of paper that a cloud of light condenses into
// (docs/design/UI-KITS.md "Light Card"). The choreography, the timeline, the QR geometry and the
// particle physics are ui-core's `lightCard`; this file is the canvas 2D renderer: glow sprites and
// short trails, the paper, the ink dots, the finders and the Polaris star. It loads on demand with
// the Pair with a Code screen (localPairing.tsx), so the gate's entry carries none of it.
//
// The code never moves while it is readable, and the card is a real QR code (level Q, a 2-module
// quiet zone): it decodes in every frame once the card has formed. Reduce Motion (the OS setting or
// the kit's own `motion`) draws the finished card once, with no trails, swirl or orbit. A canvas
// that cannot draw, or an encoder that has not loaded, leaves the plain QR in its place.

import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import {
  LIGHT_CARD,
  advance,
  cardGeometry,
  connect,
  createLightCardSim,
  expire,
  glowAlpha,
  newCode,
  reducedEnvelope,
  resume,
  rgbaOf,
  shownGeometry,
  simEnvelope,
  type CardGeometry,
  type Envelope,
  type LightCardSim,
  type QrMatrix,
} from "@polaris-key/ui-core/lightCard";

import { encodeQrLevelQ } from "./lazy.js";
import { plain, qrCode, type KitCtx } from "./parts.js";

const TAU = Math.PI * 2;
const COLORS = LIGHT_CARD.colors;

/** What the renderer reports after each paint. */
interface PaintProbe {
  /** The frame rate the envelope asked for (60, or 30 after 10 s of waiting). */
  rate: number;
  /** The injected clock's reading, in seconds. */
  now: number;
  phase: string;
}

/**
 * A test seam, found on `globalThis` under `Symbol.for("polaris-key.lightCard.seam")` so a test
 * shares it across module copies: a clock in seconds (the browser's frame clock when absent), a
 * seed, and a callback after each paint. Nothing in the kit sets it.
 */
interface Seam {
  clock?: () => number;
  seed?: number;
  onPaint?: (p: PaintProbe) => void;
}
const seam = (): Seam =>
  ((globalThis as Record<symbol, unknown>)[
    Symbol.for("polaris-key.lightCard.seam")
  ] as Seam | undefined) ?? {};
const clockOf = (): number => (seam().clock ?? nowOfFrames)();

interface LightCardQrProps {
  c: KitCtx;
  /** The text the QR encodes. */
  data: string;
  /** The copy key of the canvas's accessible name (what the plain QR had). */
  labelKey: "a11y.qrPairing";
  /** The window ran out: the orbit slows and the card dims. */
  expired?: boolean;
  /** The other device connected: a vortex collapses into a check of light. */
  connected?: boolean;
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────

let sprites: HTMLCanvasElement[] | null = null;
/** One soft glow per tint: white core, the tint, then nothing. */
function spritesOf(): HTMLCanvasElement[] {
  sprites ??= COLORS.tints.map((hex) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 48;
    const g2 = cv.getContext("2d")!;
    const gr = g2.createRadialGradient(24, 24, 0, 24, 24, 24);
    gr.addColorStop(0, rgbaOf(COLORS.core));
    gr.addColorStop(0.16, rgbaOf(hex, 0.95));
    gr.addColorStop(0.48, rgbaOf(hex, 0.26));
    gr.addColorStop(1, rgbaOf(hex, 0));
    g2.fillStyle = gr;
    g2.fillRect(0, 0, 48, 48);
    return cv;
  });
  return sprites;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The paper, the ink dots, the finders and the star, at `alpha`. */
function drawCard(
  ctx: CanvasRenderingContext2D,
  g: CardGeometry,
  alpha: number,
): void {
  if (alpha <= 0.01) return;
  const { x0, y0, side, cell } = g;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = COLORS.cardGlow;
  ctx.shadowBlur = side * 0.22;
  const paper = ctx.createLinearGradient(0, y0, 0, y0 + side);
  paper.addColorStop(0, COLORS.paperTop);
  paper.addColorStop(1, COLORS.paperBottom);
  ctx.fillStyle = paper;
  roundRect(ctx, x0, y0, side, side, g.radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = COLORS.ink;
  for (let i = 0; i < g.darks.length; i += 2) {
    ctx.beginPath();
    ctx.arc(g.darks[i]!, g.darks[i + 1]!, g.dotRadius, 0, TAU);
    ctx.fill();
  }
  for (const [fx, fy] of g.finders) {
    ctx.fillStyle = COLORS.ink;
    roundRect(ctx, fx, fy, 7 * cell, 7 * cell, cell * 2.1);
    ctx.fill();
    ctx.fillStyle = COLORS.finderGap;
    roundRect(ctx, fx + cell, fy + cell, 5 * cell, 5 * cell, cell * 1.4);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    roundRect(ctx, fx + 2 * cell, fy + 2 * cell, 3 * cell, 3 * cell, cell);
    ctx.fill();
  }
  ctx.fillStyle = COLORS.ink;
  ctx.beginPath();
  g.star.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The check of light, once, for the still frame of a connection. */
function drawCheck(ctx: CanvasRenderingContext2D): void {
  const [a, b, d] = LIGHT_CARD.check.path;
  const R = LIGHT_CARD.stage * LIGHT_CARD.check.radius;
  const mid = LIGHT_CARD.stage / 2;
  ctx.save();
  ctx.strokeStyle = COLORS.tints[3]!;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(mid + R * a[0], mid + R * a[1]);
  ctx.lineTo(mid + R * b[0], mid + R * b[1]);
  ctx.lineTo(mid + R * d[0], mid + R * d[1]);
  ctx.stroke();
  ctx.restore();
}

function drawFlare(ctx: CanvasRenderingContext2D, a: number): void {
  if (a <= 0.01) return;
  const mid = LIGHT_CARD.stage / 2;
  const r = LIGHT_CARD.stage * 0.32 * (1.4 - a * 0.4);
  ctx.globalCompositeOperation = "lighter";
  const gr = ctx.createRadialGradient(mid, mid, 0, mid, mid, r);
  gr.addColorStop(0, rgbaOf(COLORS.flareCore, a * 0.9));
  gr.addColorStop(0.25, rgbaOf(COLORS.tints[1]!, a * 0.54));
  gr.addColorStop(1, rgbaOf(COLORS.tints[0]!, 0));
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(mid, mid, r, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

/** One frame of the run: the trail fade, the card, then the glow of every particle. */
function paint(
  ctx: CanvasRenderingContext2D,
  sim: LightCardSim,
  env: Envelope,
): void {
  const S = LIGHT_CARD.stage;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = rgbaOf(COLORS.night, 0.24);
  ctx.fillRect(0, 0, S, S);
  const geometry = shownGeometry(sim, env);
  drawCard(ctx, geometry, env.cardOpacity * env.dim);
  const sp = spritesOf();
  const p = sim.particles;
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < p.count; i++) {
    const a = glowAlpha(sim, env, i, geometry);
    if (a < 0.01) continue;
    ctx.globalAlpha = a;
    const s = p.size[i]!;
    ctx.drawImage(sp[p.tint[i]!]!, p.x[i]! - s, p.y[i]! - s, s * 2, s * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  drawFlare(ctx, env.flare);
}

/** The finished card, once: no trails, no swirl, no orbit. */
function paintStill(
  ctx: CanvasRenderingContext2D,
  g: CardGeometry,
  env: Envelope,
): void {
  const S = LIGHT_CARD.stage;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = rgbaOf(COLORS.night);
  ctx.fillRect(0, 0, S, S);
  drawCard(ctx, g, env.cardOpacity * env.dim);
  if (env.check > 0) drawCheck(ctx);
}

// ── Reading the motion setting ──────────────────────────────────────────────────────────────────

/** True when motion is reduced: the OS setting or the kit's own `motion` (`data-motion` on the root). */
function motionReduced(host: Element | null): boolean {
  return (
    (typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches) ||
    (host?.closest("[data-motion]")?.getAttribute("data-motion") ?? "full") !==
      "full"
  );
}

function useReducedMotion(host: React.RefObject<HTMLElement | null>): boolean {
  const read = (): boolean => motionReduced(host.current);
  const [reduced, setReduced] = useState<boolean>(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const update = (): void => setReduced(read());
    update();
    const mq =
      typeof matchMedia === "function"
        ? matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    mq?.addEventListener?.("change", update);
    const root = host.current?.closest("[data-motion]") ?? null;
    const mo = root ? new MutationObserver(update) : null;
    if (root)
      mo!.observe(root, { attributes: true, attributeFilter: ["data-motion"] });
    return () => {
      mq?.removeEventListener?.("change", update);
      mo?.disconnect();
    };
  }, []);
  return reduced;
}

// ── The component ───────────────────────────────────────────────────────────────────────────────

const nowOfFrames = (): number => performance.now() / 1000;

function Canvas(props: {
  c: KitCtx;
  qr: QrMatrix;
  data: string;
  labelKey: LightCardQrProps["labelKey"];
  expired: boolean;
  connected: boolean;
  onFail: () => void;
}): ReactNode {
  const { c, qr, labelKey } = props;
  const cv = useRef<HTMLCanvasElement | null>(null);
  const live = useRef<{
    sim: LightCardSim;
    data: string;
    draw: () => void;
  } | null>(null);
  const reduced = useReducedMotion(cv);
  const latest = useRef(props);
  latest.current = props;

  // The run: one sim per mount (and per change of motion setting), a frame loop that pauses while
  // the page is hidden or the stage is off-screen, and one paint when motion is reduced.
  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    // jsdom has no canvas: its getContext logs "not implemented" instead of answering null.
    const ctx = /jsdom/i.test(navigator.userAgent)
      ? null
      : canvas.getContext("2d");
    if (!ctx) return props.onFail();
    // Read now, not from the state: the root's setting is known before the state catches up.
    const still = reduced || motionReduced(canvas);
    let side = 0;
    const fit = (): void => {
      const w = Math.max(1, Math.round(canvas.clientWidth || LIGHT_CARD.stage));
      if (w === side) return;
      side = w;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = canvas.height = Math.round(w * dpr);
      const k = (w * dpr) / LIGHT_CARD.stage;
      ctx.setTransform(k, 0, 0, k, 0, 0);
    };
    fit();
    try {
      if (still) {
        const draw = (): void => {
          const p = latest.current;
          fit();
          const env = reducedEnvelope(
            p.connected ? "connected" : p.expired ? "expired" : "ready",
          );
          paintStill(ctx, cardGeometry(p.qr), env);
        };
        draw();
        const ro = new ResizeObserver(() => {
          side = 0;
          draw();
        });
        ro.observe(canvas);
        return () => ro.disconnect();
      }

      const sim = createLightCardSim({
        qr,
        seed: seam().seed ?? 7,
        now: clockOf(),
        side: canvas.clientWidth || LIGHT_CARD.stage,
      });
      const state = { sim, data: props.data, draw: () => undefined };
      live.current = state;
      ctx.fillStyle = rgbaOf(COLORS.night);
      ctx.fillRect(0, 0, LIGHT_CARD.stage, LIGHT_CARD.stage);
      let raf = 0;
      let lastPaint = -Infinity;
      let running = false;
      let visible = true;
      let onScreen = true;
      const frame = (): void => {
        raf = requestAnimationFrame(frame);
        const now = clockOf();
        const env0 = simEnvelope(sim);
        if (now - lastPaint < (0.9 * 1) / env0.frameRate) return;
        lastPaint = now;
        advance(sim, now);
        const env = simEnvelope(sim);
        paint(ctx, sim, env);
        seam().onPaint?.({
          rate: env0.frameRate,
          now,
          phase: env.phase,
        });
      };
      const sync = (): void => {
        const want = visible && onScreen;
        if (want && !running) {
          running = true;
          resume(sim, clockOf());
          lastPaint = -Infinity;
          raf = requestAnimationFrame(frame);
        } else if (!want && running) {
          running = false;
          cancelAnimationFrame(raf);
        }
      };
      const onVisibility = (): void => {
        visible = document.visibilityState !== "hidden";
        sync();
      };
      document.addEventListener("visibilitychange", onVisibility);
      onVisibility();
      const io =
        typeof IntersectionObserver === "function"
          ? new IntersectionObserver(
              (es) => {
                onScreen = es[es.length - 1]!.isIntersecting;
                sync();
              },
              { rootMargin: "120px" },
            )
          : null;
      io?.observe(canvas);
      const ro = new ResizeObserver(fit);
      ro.observe(canvas);
      sync();
      return () => {
        running = false;
        cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVisibility);
        io?.disconnect();
        ro.disconnect();
        live.current = null;
      };
    } catch {
      props.onFail();
    }
  }, [reduced]);

  // A new code, a connection, an expiry: the run takes each as an event.
  useEffect(() => {
    const s = live.current;
    if (!s || s.data === props.data) return;
    s.data = props.data;
    if (!newCode(s.sim, qr)) {
      // Still forming: start the new code's run over.
      s.sim.codes = [cardGeometry(qr), cardGeometry(qr)];
    }
  }, [props.data]);
  useEffect(() => {
    const s = live.current;
    if (s && props.expired) expire(s.sim);
  }, [props.expired]);
  useEffect(() => {
    const s = live.current;
    if (s && props.connected) connect(s.sim);
  }, [props.connected]);

  return (
    <figure className="qr" data-part="qr" data-key={labelKey} data-lightcard="">
      <canvas ref={cv} role="img" aria-label={plain(c, labelKey)} />
    </figure>
  );
}

/** Falls back to the plain QR when the canvas, or the chunk that holds it, fails. */
class Guard extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** True in a window too short for the stage beside the code (under 480 tall): the plain QR. */
function useShortWindow(): boolean {
  const query = "(max-height: 480px)";
  const [short, setShort] = useState<boolean>(
    () => typeof matchMedia === "function" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const update = (): void => setShort(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return short;
}

/** The Light Card in place of the plain QR. */
export default function LightCardQr(props: LightCardQrProps): ReactNode {
  const { c, data, labelKey } = props;
  const [failed, setFailed] = useState(false);
  const cache = useRef<{ data: string; qr: QrMatrix | null } | null>(null);
  if (cache.current?.data !== data || cache.current.qr === null)
    cache.current = { data, qr: encodeQrLevelQ(data) };
  const qr = cache.current.qr;
  const plainQr = qrCode(c, data, labelKey);
  const short = useShortWindow();
  if (short || failed || !qr || !c.view.copy.includes(labelKey)) return plainQr;
  return (
    <Guard fallback={plainQr}>
      <Canvas
        c={c}
        qr={qr}
        data={data}
        labelKey={labelKey}
        expired={props.expired ?? false}
        connected={props.connected ?? false}
        onFail={() => setFailed(true)}
      />
    </Guard>
  );
}
