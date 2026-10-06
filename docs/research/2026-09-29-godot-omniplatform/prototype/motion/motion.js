// S-23 motion utility layer: the prototype of packages/admin/src/ui/motion/ (MO-02).
//
// Framework-free so the HTML prototypes can run it; MO-02 wraps the same functions in React
// (useViewTransition, <Presence>, useCountUp) and wires viewTransition() into both routers.
// Everything it writes is a data attribute, a class, or a CSSOM property (el.style.setProperty),
// all of which the Worker's `style-src 'self'` allows (tools/csp-probe.mjs). No dependencies.

const html = document.documentElement;
const media = matchMedia("(prefers-reduced-motion: reduce)");

/** True when motion should be an instant swap: the OS setting or the in-app preference. */
export function reducedMotion() {
  return media.matches || html.dataset.motion === "reduce";
}

const vtSupported = typeof document.startViewTransition === "function";
if (vtSupported) html.dataset.vtSupported = "";

let current = null;

/** Rows a list transition names before it switches to naming only the rows on screen. */
export const LIST_BUDGET = 30;

/**
 * Run `update` (a synchronous DOM/state change) inside a same-document View Transition.
 *
 * - reduced motion or no API: runs `update` directly (instant swap), and the fallback CSS fades
 *   the new route in;
 * - a transition already running is skipped to its end first: the page does not take input during
 *   a view transition (measured, notes/S-23 §3.3), so a fast second click must never wait;
 * - `type` sets html[data-vt] for the CSS (forward, back, tab, list, theme);
 * - `shared` pairs elements with a view-transition-name for this one transition only.
 *
 * Returns `{ updateCallbackDone, finished }`: the first resolves when the new state is in the DOM
 * (move focus then; do not wait for the animation), the second when the animation has ended.
 */
export function viewTransition(
  update,
  { type = "fade", shared = [], list = null } = {},
) {
  if (!vtSupported || reducedMotion()) {
    update();
    const done = Promise.resolve();
    return { updateCallbackDone: done, finished: done };
  }
  current?.skipTransition();
  for (const [el, name] of shared)
    el?.style.setProperty("view-transition-name", name);
  html.dataset.vt = type;
  // Each named row costs a snapshot. Up to LIST_BUDGET rows the whole list takes part; a longer
  // list names only the rows on screen (off-screen rows swap unseen), so the cost is bounded by
  // the viewport, not the data (measured: S-23 §3.5).
  let named = [];
  const nameVisible = () => {
    const vh = innerHeight;
    named = [...list.children].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    });
    for (const el of named) {
      el.style.setProperty("view-transition-name", "match-element");
      el.style.setProperty("view-transition-class", "pk-row");
    }
  };
  const small = list && list.children.length <= LIST_BUDGET;
  if (small) list.classList.add("pk-vt-list");
  else if (list) nameVisible();
  const t = document.startViewTransition(() => {
    for (const [el] of shared) el?.style.removeProperty("view-transition-name");
    update();
    if (small) list.classList.add("pk-vt-list");
    else if (list) nameVisible();
  });
  current = t;
  t.finished.finally(() => {
    if (current === t) {
      current = null;
      delete html.dataset.vt;
    }
    list?.classList.remove("pk-vt-list");
    for (const el of list?.children ?? []) {
      el.style.removeProperty("view-transition-name");
      el.style.removeProperty("view-transition-class");
    }
  });
  return {
    updateCallbackDone: t.updateCallbackDone.catch(() => {}),
    finished: t.finished.catch(() => {}),
  };
}

/**
 * Presence: open or close a transient element with its enter/exit animation, keeping it mounted
 * until the exit animation ends (what Radix does for its own primitives).
 */
export async function presence(el, open) {
  if (open) {
    el.hidden = false;
    el.dataset.state = "open";
    return;
  }
  el.dataset.state = "closed";
  await settle(el);
  if (el.dataset.state === "closed") el.hidden = true;
}

/** Resolves when every animation on the element (not its children) has finished. */
export function settle(el) {
  const running = el.getAnimations().map((a) => a.finished.catch(() => {}));
  return Promise.all(running);
}

/**
 * Count from the number on screen to `to`. The visible text is aria-hidden while it counts and
 * a visually hidden twin carries the final value, so a screen reader hears one number, once.
 */
export function countTo(el, to, { duration = 480, from: start0 } = {}) {
  const from = start0 ?? (Number(el.dataset.value ?? el.textContent) || 0);
  el.dataset.value = String(to);
  const label = el.nextElementSibling?.classList.contains("sr-only")
    ? el.nextElementSibling
    : null;
  if (label) label.textContent = String(to);
  if (reducedMotion() || from === to) {
    el.textContent = String(to);
    return;
  }
  // Time comes from the frame timestamps (the document timeline), so DevTools' slowed playback
  // and a backgrounded tab slow the count with the rest of the motion.
  let start = null;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    start ??= now;
    const t = Math.min(1, (now - start) / duration);
    el.textContent = String(Math.round(from + (to - from) * ease(t)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Set a meter's fill (0–1) through a custom property; the CSS transition does the rest. */
export function setMeter(el, value) {
  el.style.setProperty("--pk-meter", String(Math.max(0, Math.min(1, value))));
}

/** Tint a row, then let the tint fade (pk-row-highlight). */
export function highlight(el) {
  el.classList.add("pk-row", "pk-row-highlight");
  const ms =
    parseFloat(
      getComputedStyle(html).getPropertyValue("--pk-delay-highlight"),
    ) || 1600;
  setTimeout(() => el.classList.remove("pk-row-highlight"), ms);
}

/**
 * A success moment, once per key: the check draws and the sparks burst (or a static check under
 * reduced motion, which motion.css handles). Returns false if this moment was already shown.
 */
export function celebrateOnce(key, host) {
  try {
    if (localStorage.getItem(`pk-moment:${key}`)) return false;
    localStorage.setItem(`pk-moment:${key}`, "1");
  } catch {
    /* storage may be unavailable: celebrate anyway */
  }
  const burst = document.createElement("span");
  burst.className = "pk-burst";
  burst.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 6; i++) burst.append(document.createElement("i"));
  host.append(burst);
  // Remove it when its animations end (not on a timer, so a slowed or paused timeline is safe).
  requestAnimationFrame(() =>
    Promise.all(
      burst
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => {})),
    ).then(() => burst.remove()),
  );
  return true;
}

/** Start a countdown ring of `ms` milliseconds. */
export function startCountdown(el, ms) {
  el.style.setProperty("--pk-countdown", `${ms}ms`);
  el.classList.remove("pk-countdown");
  void el.getBoundingClientRect();
  el.classList.add("pk-countdown");
}
