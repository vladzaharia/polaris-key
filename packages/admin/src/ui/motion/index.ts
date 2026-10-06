/**
 * The motion layer (notes/S-23 §6; MO-02): the JavaScript half of the one motion system. The
 * patterns themselves are classes and data attributes in src/motion.css; this adds what CSS cannot
 * do alone. Everything here writes data attributes, classes and CSSOM properties only (no
 * `style=""`, no `<style>`, S-23 D8), and does nothing under reduced motion.
 *
 * These names are the contract MO-03 to MO-12 build on.
 */
export { reducedMotion, useReducedMotion, tokenMs } from "./reducedMotion.js";
export {
  viewTransition,
  viewTransitionsSupported,
  markViewTransitionSupport,
  LIST_BUDGET,
  type ViewTransitionType,
  type ViewTransitionOptions,
  type ViewTransitionHandle,
} from "./viewTransition.js";
export { Presence, settle, type PresenceProps } from "./Presence.js";
export {
  CountUp,
  useCountUp,
  type CountUpProps,
  type CountUpOptions,
} from "./CountUp.js";
export { setMeter } from "./meter.js";
export { highlight } from "./highlight.js";
export {
  Celebration,
  SuccessCheck,
  celebrateOnce,
  momentSeen,
  markMomentSeen,
  type CelebrationProps,
  type SuccessCheckProps,
} from "./Celebration.js";
export { Expand, type ExpandProps } from "./Expand.js";
